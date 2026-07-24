// src/browser.js
// Playwright browser manager for Accio.
// Windows-native: launchPersistentContext with local Chrome.
// WSL: same, with CDP relay fallback if needed.

const { chromium } = require('playwright');
const accounts = require('./accounts');
const relay = require('./relay');
const platform = require('./platform');
const {
  INSERT_TEXT_FN,
  CLICK_SEND_FN,
  EXTRACT_REPLY_FN,
  POLL_REPLY_FN,
  CONSOLE_WATCHER_FN,
  RESET_DONE_FN,
  REDISPATCH_INPUT_FN,
} = require('./inject');

const ACCIO_URL = process.env.ACCIO_URL || 'https://www.accio.com/';
const ACCIO_APP_URL = process.env.ACCIO_APP_URL || 'https://www.accio.com/work/app';
const DEFAULT_TIMEOUT_S = Number(process.env.ACCIO_TIMEOUT_S || 180);
const POLL_INTERVAL_MS = 200;

/** @type {import('playwright').Browser|null} */
let browser = null;
/** @type {import('playwright').BrowserContext|null} */
let context = null;
/** @type {import('playwright').Page|null} */
let page = null;
/** @type {string|null} */
let currentAccountName = null;
/** Whether we used connectOverCDP (true) or launchPersistentContext (false) */
let usedCdp = false;
/** Busy lock for serializing chat requests */
let busy = false;

function resolveProfile(account) {
  const name = account.name;
  // If user set a custom chrome_profile, use that as --user-data-dir
  if (account.chrome_profile) {
    const cp = account.chrome_profile;
    platform.ensureProfileDir(name); // fallback dir just in case
    console.log(`[browser] usando chrome_profile personalizado: ${cp}`);
    return cp;
  }
  const winDir = account.win_data_dir || platform.winProfileDir(name);
  platform.ensureProfileDir(name);
  return winDir;
}

/**
 * @param {object} account
 * @param {object} opts
 * @param {boolean} [opts.headless=false]
 * @param {boolean} [opts.forLogin=false]
 */
async function launchForAccount(account, opts = {}) {
  const { headless = false, forLogin = false } = opts;
  const isHeadless = forLogin ? false : headless;

  await closeBrowser();

  const profileDir = resolveProfile(account);
  const chromePath = platform.chromeExe();

  // Strategy 1: launchPersistentContext (works natively on Windows)
  try {
    console.log(
      `[browser] launchPersistentContext… chrome=${chromePath} profile=${profileDir} headless=${isHeadless}`,
    );
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: chromePath,
      headless: isHeadless,
      channel: undefined,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
      ],
      viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ['--enable-automation'],
    });
    usedCdp = false;
    page = context.pages()[0] || (await context.newPage());
    currentAccountName = account.name;
    accounts.touchAccount(account.name);
    console.log('[browser] launchPersistentContext OK');
    return { page, context, usedCdp: false };
  } catch (err) {
    console.warn(
      `[browser] launchPersistentContext falhou: ${err.message}`,
    );
    // On pure Windows we do NOT fall back to WSL relay
    if (platform.IS_WIN) {
      throw new Error(
        `Não consegui abrir o Chrome em ${chromePath}. ` +
          `Confira se o Chrome está instalado. Detalhe: ${err.message}`,
      );
    }
    console.warn('[browser] Tentando CDP relay (WSL)…');
  }

  // Strategy 2: CDP relay (WSL only)
  const { host, port } = await relay.bootstrapCdp(profileDir, {
    headless: isHeadless,
    url: ACCIO_URL,
  });

  browser = await chromium.connectOverCDP(`http://${host}:${port}`);
  usedCdp = true;

  if (browser.contexts().length > 0) {
    context = browser.contexts()[0];
    page =
      context.pages().find((p) => (p.url() || '').includes('accio.com')) ||
      context.pages()[0] ||
      (await context.newPage());
  } else {
    context = await browser.newContext();
    page = await context.newPage();
  }

  currentAccountName = account.name;
  accounts.touchAccount(account.name);
  console.log(`[browser] CDP connect OK (${host}:${port})`);
  return { page, context, usedCdp: true };
}

async function ensureBrowser(opts = {}) {
  const accountName = opts.accountName || accounts.getActiveName();
  if (!accountName) {
    throw new Error(
      'Nenhuma conta ativa. Use o menu CLI opção 1 para entrar numa conta.',
    );
  }
  const account = accounts.find(accountName);
  if (!account) {
    throw new Error(`Conta "${accountName}" não encontrada.`);
  }

  if (page && currentAccountName === accountName && !page.isClosed()) {
    return page;
  }

  await launchForAccount(account, opts);
  return page;
}

async function ensureOnAccio(p) {
  const url = p.url() || '';
  if (url.includes('accio.com')) {
    if (!url.includes('/work') && !url.includes('/app')) {
      try {
        await p.goto(ACCIO_APP_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 120000,
        });
      } catch (_) {
        /* stay */
      }
    }
    return;
  }
  await p.goto(ACCIO_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
}

async function installWatcher(p) {
  const status = await p.evaluate(CONSOLE_WATCHER_FN);
  console.log(`[browser] watcher: ${status}`);
}

/**
 * @param {string} text
 * @param {object} opts
 * @param {boolean} [opts.stream=true]
 * @param {(delta: string, fullText: string) => void} [opts.onDelta]
 * @param {number} [opts.timeoutS]
 * @returns {Promise<string>}
 */
async function sendMessage(text, opts = {}) {
  const {
    stream = true,
    onDelta = null,
    timeoutS = DEFAULT_TIMEOUT_S,
  } = opts;

  if (busy) {
    throw new Error('Já existe uma requisição em andamento. Aguarde.');
  }
  busy = true;

  try {
    const p = await ensureBrowser({
      headless: process.env.ACCIO_HEADLESS === '1',
    });
    await ensureOnAccio(p);
    await installWatcher(p);
    await p.evaluate(RESET_DONE_FN);

    let baseline = '';
    try {
      const base = await p.evaluate(POLL_REPLY_FN);
      baseline = base.text || '';
    } catch (_) {
      baseline = '';
    }

    await p.evaluate(INSERT_TEXT_FN, text);

    // First-message fix: wait, re-dispatch, retry click
    await p.waitForTimeout(500);

    let sent = false;
    let lastErr = null;
    for (let i = 0; i < 10; i++) {
      try {
        if (i > 0) {
          await p.evaluate(REDISPATCH_INPUT_FN, text);
          await p.waitForTimeout(200);
        }
        const result = await p.evaluate(CLICK_SEND_FN);
        if (result.ok) {
          sent = true;
          break;
        }
        lastErr = result.disabled ? 'Botão disabled' : 'Botão não encontrado';
        await p.waitForTimeout(200);
      } catch (err) {
        lastErr = err.message;
        await p.waitForTimeout(200);
      }
    }
    if (!sent) {
      throw new Error(`Não consegui clicar em enviar: ${lastErr}`);
    }

    console.log('[browser] mensagem enviada, aguardando resposta…');

    let consoleDone = false;
    const onConsole = (msg) => {
      const t = msg.text() || '';
      if (t.includes('maybeNotifyTaskComplete') && t.includes('kind=success')) {
        consoleDone = true;
      }
    };
    p.on('console', onConsole);

    try {
      const deadline = Date.now() + timeoutS * 1000;
      let previousText = '';
      let fullText = '';
      let stableCount = 0;

      while (Date.now() < deadline) {
        let poll;
        try {
          poll = await p.evaluate(POLL_REPLY_FN);
        } catch (_) {
          await p.waitForTimeout(POLL_INTERVAL_MS);
          continue;
        }

        let current = poll.text || '';

        if (baseline && current === baseline) {
          if (poll.done || consoleDone) {
            try {
              await p.evaluate(
                '() => window.__ACCIO_EXTRACT_NOW__ && window.__ACCIO_EXTRACT_NOW__()',
              );
              await p.waitForTimeout(300);
              poll = await p.evaluate(POLL_REPLY_FN);
              current = poll.text || '';
            } catch (_) {
              /* ignore */
            }
          } else {
            await p.waitForTimeout(POLL_INTERVAL_MS);
            continue;
          }
        }

        const effective = current;

        if (
          effective.length > previousText.length &&
          effective.startsWith(previousText)
        ) {
          const delta = effective.slice(previousText.length);
          previousText = effective;
          fullText = effective;
          stableCount = 0;
          if (onDelta && delta) onDelta(delta, fullText);
        } else if (effective !== previousText && effective.length > 0) {
          const delta =
            previousText && effective.startsWith(previousText)
              ? effective.slice(previousText.length)
              : effective;
          previousText = effective;
          fullText = effective;
          stableCount = 0;
          if (onDelta && delta) onDelta(delta, fullText);
        } else if (effective === previousText && effective.length > 0) {
          stableCount++;
        }

        if (poll.done || consoleDone) {
          await p.waitForTimeout(500);
          try {
            if (consoleDone && !poll.done) {
              await p.evaluate(
                '() => window.__ACCIO_EXTRACT_NOW__ && window.__ACCIO_EXTRACT_NOW__()',
              );
              await p.waitForTimeout(300);
            }
            const final = await p.evaluate(EXTRACT_REPLY_FN);
            if (final && final.length > 0) {
              if (final.length > fullText.length && onDelta) {
                const delta = final.startsWith(fullText)
                  ? final.slice(fullText.length)
                  : final;
                if (delta && final !== fullText) onDelta(delta, final);
              }
              fullText = final || fullText;
            }
          } catch (_) {
            /* use what we have */
          }
          try {
            await p.evaluate(RESET_DONE_FN);
          } catch (_) {
            /* ignore */
          }
          if (!fullText) {
            throw new Error('Modelo finalizou mas nenhum texto foi extraído.');
          }
          return fullText;
        }

        if (stableCount > 150 && fullText.length > 20) {
          console.log(
            '[browser] texto estável por ~30s — aceitando como completo',
          );
          try {
            await p.evaluate(RESET_DONE_FN);
          } catch (_) {
            /* ignore */
          }
          return fullText;
        }

        await p.waitForTimeout(POLL_INTERVAL_MS);
      }

      if (fullText) {
        console.warn(
          `[browser] timeout ${timeoutS}s — retornando texto parcial`,
        );
        return fullText;
      }
      throw new Error(`Modelo não finalizou em ${timeoutS}s`);
    } finally {
      try {
        p.removeListener('console', onConsole);
      } catch (_) {
        /* ignore */
      }
    }
  } finally {
    busy = false;
  }
}

async function openForLogin(accountName) {
  let account = accounts.find(accountName);
  if (!account) {
    account = accounts.add(accountName);
  }
  accounts.setActive(accountName);
  await launchForAccount(account, { headless: false, forLogin: true });
  await ensureOnAccio(page);
  console.log(`[browser] Chrome aberto para login da conta "${accountName}".`);
  console.log(
    '[browser] Faça o login no Chrome e feche esta opção quando terminar.',
  );
  return page;
}

async function closeBrowser() {
  try {
    if (context && !usedCdp) {
      await context.close();
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (browser && usedCdp) {
      await browser.close();
    }
  } catch (_) {
    /* ignore */
  }
  browser = null;
  context = null;
  page = null;
  currentAccountName = null;
  usedCdp = false;
}

function isBusy() {
  return busy;
}

function getStatus() {
  return {
    account: currentAccountName,
    hasPage: !!(page && !page.isClosed()),
    usedCdp,
    busy,
    platform: platform.IS_WIN ? 'win32' : platform.IS_WSL ? 'wsl' : process.platform,
    url: page && !page.isClosed() ? page.url() : null,
  };
}

module.exports = {
  launchForAccount,
  ensureBrowser,
  ensureOnAccio,
  installWatcher,
  sendMessage,
  openForLogin,
  closeBrowser,
  isBusy,
  getStatus,
  ACCIO_URL,
  DEFAULT_TIMEOUT_S,
};
