// src/browser.js
// Playwright browser manager for Accio.
// Windows-native: prefer launching real Chrome + CDP (Google login friendly),
// fall back to launchPersistentContext with stealth flags.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
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
const CDP_PORT = Number(process.env.ACCIO_CDP_PORT || 9333);

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
/** Child process when we spawn Chrome ourselves for CDP */
let chromeChild = null;

/**
 * Resolve user-data-dir + optional profile directory for an account.
 * @returns {{ userDataDir: string, profileDirectory: string|null }}
 */
function resolveProfile(account) {
  const name = account.name;

  // Explicit user-data-dir + profile-directory (preferred after setCustomProfile)
  if (account.chrome_user_data_dir) {
    return {
      userDataDir: account.chrome_user_data_dir,
      profileDirectory: account.chrome_profile_directory || 'Default',
    };
  }

  // Legacy field: chrome_profile may be User Data or User Data\Default
  if (account.chrome_profile) {
    const parsed = platform.parseChromeProfilePath(account.chrome_profile);
    console.log(
      `[browser] chrome_profile → userDataDir=${parsed.userDataDir} profile=${parsed.profileDirectory || '(root)'}`,
    );
    return {
      userDataDir: parsed.userDataDir,
      profileDirectory: parsed.profileDirectory,
    };
  }

  // Dedicated automation profile (empty until user logs in once)
  const winDir = account.win_data_dir || platform.winProfileDir(name);
  platform.ensureProfileDir(name);
  return { userDataDir: winDir, profileDirectory: null };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitCdpHttp(host, port, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const url = `http://${host}:${port}/json/version`;
    let lastErr = null;

    function attempt() {
      if (Date.now() > deadline) {
        reject(new Error(`CDP HTTP não respondeu em ${timeoutMs}ms (${url}): ${lastErr}`));
        return;
      }
      const req = http.get(url, { timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            console.log(`[browser] CDP ok: ${data.Browser || 'connected'}`);
            resolve(data);
          } catch (err) {
            lastErr = err.message;
            setTimeout(attempt, 400);
          }
        });
      });
      req.on('error', (err) => {
        lastErr = err.message;
        setTimeout(attempt, 400);
      });
      req.on('timeout', () => {
        req.destroy();
        lastErr = 'timeout';
        setTimeout(attempt, 400);
      });
    }
    attempt();
  });
}

/**
 * Spawn real Chrome (not Playwright-managed) with remote debugging.
 * Looks like a normal browser → Google login works much better.
 */
function spawnChromeCdp({ userDataDir, profileDirectory, headless, url }) {
  const chromePath = platform.chromeExe();
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    ...platform.stealthChromeArgs(),
    '--new-window',
  ];
  if (profileDirectory) {
    args.push(`--profile-directory=${profileDirectory}`);
  }
  if (headless) {
    args.push('--headless=new');
  }
  args.push(url || ACCIO_URL);

  console.log(
    `[browser] spawn Chrome (CDP) exe=${chromePath} userDataDir=${userDataDir}` +
      (profileDirectory ? ` profile=${profileDirectory}` : ''),
  );

  const child = spawn(chromePath, args, {
    stdio: 'ignore',
    detached: true,
    windowsHide: false,
  });
  child.on('error', (err) => {
    console.error(`[browser] falha ao spawn Chrome: ${err.message}`);
  });
  child.unref();
  chromeChild = child;
  return child;
}

/**
 * Hide webdriver flag + common automation traces in every new document.
 * @param {import('playwright').BrowserContext} ctx
 */
async function applyStealth(ctx) {
  try {
    await ctx.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
      } catch (_) {
        /* ignore */
      }
      try {
        // Chrome automation extension leftover
        // eslint-disable-next-line no-undef
        window.chrome = window.chrome || { runtime: {} };
      } catch (_) {
        /* ignore */
      }
      try {
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
          parameters && parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
      } catch (_) {
        /* ignore */
      }
    });
  } catch (err) {
    console.warn(`[browser] stealth initScript: ${err.message}`);
  }
}

/**
 * Connect Playwright to an already-running Chrome via CDP.
 */
async function connectCdp(host = '127.0.0.1', port = CDP_PORT) {
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
  await applyStealth(context);
  return { browser, context, page };
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

  const { userDataDir, profileDirectory } = resolveProfile(account);
  const chromePath = platform.chromeExe();

  // ── Strategy A (preferred): real Chrome + CDP ─────────────────
  // Playwright-managed browsers set automation flags that Google blocks.
  // Spawning chrome.exe ourselves + connectOverCDP looks like normal Chrome.
  try {
    console.log(
      `[browser] tentando Chrome real + CDP… userDataDir=${userDataDir}` +
        (profileDirectory ? ` profile=${profileDirectory}` : '') +
        ` headless=${isHeadless}`,
    );
    // Best-effort: free the CDP port if a previous chrome is stuck
    try {
      relay.killChromeProfile(
        require('path').basename(String(userDataDir).replace(/\\/g, '/')),
      );
    } catch (_) {
      /* ignore */
    }
    await sleep(800);

    spawnChromeCdp({
      userDataDir,
      profileDirectory,
      headless: isHeadless,
      url: ACCIO_URL,
    });
    await sleep(1500);
    await waitCdpHttp('127.0.0.1', CDP_PORT, 45000);
    await connectCdp('127.0.0.1', CDP_PORT);

    currentAccountName = account.name;
    accounts.touchAccount(account.name);
    console.log('[browser] Chrome real + CDP OK (melhor para login Google)');
    return { page, context, usedCdp: true };
  } catch (err) {
    console.warn(`[browser] Chrome+CDP falhou: ${err.message}`);
    if (forLogin) {
      // Login MUST work with Google — try harder / clearer error
      console.warn('[browser] fallback launchPersistentContext (login Google pode falhar)…');
    }
  }

  // ── Strategy B: launchPersistentContext with stealth ──────────
  try {
    const args = platform.stealthChromeArgs();
    if (profileDirectory) {
      args.push(`--profile-directory=${profileDirectory}`);
    }

    console.log(
      `[browser] launchPersistentContext… chrome=${chromePath} userDataDir=${userDataDir}`,
    );
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: chromePath,
      headless: isHeadless,
      args,
      // Don't force a viewport — another automation signal
      viewport: null,
      ignoreDefaultArgs: [
        '--enable-automation',
        '--enable-blink-features=IdleDetection',
      ],
      // Avoid Playwright's default "Chromium" branding when possible
      channel: undefined,
    });
    usedCdp = false;
    await applyStealth(context);
    page = context.pages()[0] || (await context.newPage());
    currentAccountName = account.name;
    accounts.touchAccount(account.name);
    console.log('[browser] launchPersistentContext OK');
    return { page, context, usedCdp: false };
  } catch (err) {
    console.warn(`[browser] launchPersistentContext falhou: ${err.message}`);
    if (platform.IS_WIN) {
      throw new Error(
        `Não consegui abrir o Chrome em ${chromePath}. ` +
          `Feche todas as janelas do Chrome que usam esse profile e tente de novo. ` +
          `Detalhe: ${err.message}`,
      );
    }
    console.warn('[browser] Tentando CDP relay (WSL)…');
  }

  // ── Strategy C: WSL CDP relay (legacy) ────────────────────────
  const { host, port } = await relay.bootstrapCdp(userDataDir, {
    headless: isHeadless,
    url: ACCIO_URL,
  });
  await connectCdp(host, port);
  currentAccountName = account.name;
  accounts.touchAccount(account.name);
  console.log(`[browser] CDP relay OK (${host}:${port})`);
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
      // Landing page or login — navigate to the app
      await navigateToApp(p);
    }
    // Wait up to 2 min for the chat editor to appear (may need login)
    return waitForEditor(p);
  }
  // Start from scratch
  await p.goto(ACCIO_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  return navigateToApp(p);
}

async function navigateToApp(p) {
  try {
    await p.goto(ACCIO_APP_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
  } catch (_) {
    /* timeout is OK — page may redirect for login */
  }
  return waitForEditor(p);
}

async function waitForEditor(p) {
  try {
    await p.waitForSelector('.chat-input-scrollable', {
      state: 'attached',
      timeout: 120000,
    });
    console.log('[browser] editor .chat-input-scrollable encontrado');
  } catch (_) {
    console.warn(
      '[browser] editor .chat-input-scrollable não apareceu em 120s.',
    );
    // Don't throw — user might be on login page; sendMessage will fail with
    // a clear error and the user can log in first.
  }
}

async function installWatcher(p) {
  const status = await p.evaluate(CONSOLE_WATCHER_FN);
  console.log(`[browser] watcher: ${status}`);
}

/**
 * @param {string} text - full conversation text (all messages joined)
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

    // ── Recarrega a página para começar um novo chat ──────────
    console.log('[browser] recarregando página para novo chat…');
    await p.goto(ACCIO_APP_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    // Aguarda o editor ficar pronto
    try {
      await p.waitForSelector('.chat-input-scrollable', {
        state: 'attached',
        timeout: 120000,
      });
      console.log('[browser] editor .chat-input-scrollable encontrado');
    } catch (_) {
      const currentUrl = p.url();
      throw new Error(
        `Editor de chat não encontrado em ${currentUrl}. ` +
          'É necessário fazer login primeiro (opção 1 do menu), ' +
          'ou o Accio pode estar fora do ar/mudou de URL.',
      );
    }

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
    '[browser] Faça o login no Chrome (Google deve funcionar neste modo CDP).',
  );
  console.log(
    '[browser] Dica: se o Google ainda bloquear, feche o Chrome normal e use um profile dedicado (C:\\temp\\accio-profiles\\...).',
  );
  return page;
}

async function closeBrowser() {
  try {
    if (browser && usedCdp) {
      // Disconnect Playwright only — leave Chrome open so session stays warm
      await browser.close();
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (context && !usedCdp) {
      await context.close();
    }
  } catch (_) {
    /* ignore */
  }
  browser = null;
  context = null;
  page = null;
  currentAccountName = null;
  usedCdp = false;
  chromeChild = null;
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
    platform: platform.IS_WIN
      ? 'win32'
      : platform.IS_WSL
        ? 'wsl'
        : process.platform,
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
