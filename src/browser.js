// src/browser.js
// Playwright browser manager for Accio.
// Launches Chrome via CDP relay (WSL → Windows), sends messages, streams replies.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const accounts = require('./accounts');
const relay = require('./relay');
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
const CHROME_EXE_WSL =
  process.env.ACCIO_CHROME_EXE ||
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';

/** @type {import('playwright').Browser|null} */
let browser = null;
/** @type {import('playwright').BrowserContext|null} */
let context = null;
/** @type {import('playwright').Page|null} */
let page = null;
/** @type {import('playwright').Playwright|null} */
let pw = null;
/** @type {string|null} */
let currentAccountName = null;
/** Whether we used connectOverCDP (true) or launchPersistentContext (false) */
let usedCdp = false;
/** Busy lock for serializing chat requests */
let busy = false;

/**
 * Resolve Windows profile dir for an account.
 * Prefer win_data_dir from account; fall back to C:\temp\accio-profiles\<name>
 */
function winProfileDir(account) {
  if (account.win_data_dir) return account.win_data_dir;
  const safe = account.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `C:\\temp\\accio-profiles\\${safe}`;
}

/**
 * Try launch_persistent_context with Windows Chrome executablePath first.
 * Falls back to CDP relay pattern if that fails.
 * @param {object} account
 * @param {object} opts
 * @param {boolean} [opts.headless=false]
 * @param {boolean} [opts.forLogin=false] - visible browser for manual login
 */
async function launchForAccount(account, opts = {}) {
  const { headless = false, forLogin = false } = opts;
  const isHeadless = forLogin ? false : headless;

  // Close any existing session first
  await closeBrowser();

  const winDir = winProfileDir(account);
  // Ensure Windows profile dir exists
  const wslProfile = winDir
    .replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`)
    .replace(/\\/g, '/');
  fs.mkdirSync(wslProfile, { recursive: true });

  pw = await chromium.launch ? null : null; // placeholder; we use chromium methods

  // Strategy 1: launchPersistentContext with executablePath
  try {
    console.log(
      `[browser] tentando launchPersistentContext… profile=${winDir} headless=${isHeadless}`,
    );
    const { chromium: cr } = require('playwright');
    const playwright = require('playwright');
    // We need a Playwright instance — launchPersistentContext is on chromium
    context = await cr.launchPersistentContext(winDir, {
      executablePath: CHROME_EXE_WSL,
      headless: isHeadless,
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
      `[browser] launchPersistentContext falhou: ${err.message}. Tentando CDP relay…`,
    );
  }

  // Strategy 2: CDP relay (proven path from accio_cli.py)
  const { host, port } = await relay.bootstrapCdp(winDir, {
    headless: isHeadless,
    url: ACCIO_URL,
  });

  const playwright = require('playwright');
  pw = await playwright.chromium.connectOverCDP
    ? null
    : null;

  browser = await chromium.connectOverCDP(`http://${host}:${port}`);
  usedCdp = true;

  // Grab existing context/page or create
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

/**
 * Ensure we have a live page for the active (or given) account.
 * @param {object} [opts]
 * @param {string} [opts.accountName]
 * @param {boolean} [opts.headless]
 * @param {boolean} [opts.forLogin]
 */
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

  // Reuse if same account and page is alive
  if (
    page &&
    currentAccountName === accountName &&
    !page.isClosed()
  ) {
    return page;
  }

  await launchForAccount(account, opts);
  return page;
}

/**
 * Navigate to Accio if not already there.
 * @param {import('playwright').Page} p
 */
async function ensureOnAccio(p) {
  const url = p.url() || '';
  if (url.includes('accio.com')) {
    // Prefer app route if we're on landing
    if (!url.includes('/work') && !url.includes('/app')) {
      try {
        await p.goto(ACCIO_APP_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 120000,
        });
      } catch (_) {
        // stay on current page
      }
    }
    return;
  }
  await p.goto(ACCIO_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
}

/**
 * Install the console completion watcher on the page.
 * @param {import('playwright').Page} p
 */
async function installWatcher(p) {
  const status = await p.evaluate(CONSOLE_WATCHER_FN);
  console.log(`[browser] watcher: ${status}`);
}

/**
 * Send a message to Accio chat and stream the response.
 *
 * @param {string} text - user message
 * @param {object} opts
 * @param {boolean} [opts.stream=true]
 * @param {(delta: string, fullText: string) => void} [opts.onDelta]
 * @param {number} [opts.timeoutS]
 * @returns {Promise<string>} full assistant reply
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
    const p = await ensureBrowser({ headless: process.env.ACCIO_HEADLESS === '1' });
    await ensureOnAccio(p);
    await installWatcher(p);

    // Reset completion flags
    await p.evaluate(RESET_DONE_FN);

    // Capture baseline assistant text so we can detect the NEW reply
    let baseline = '';
    try {
      const base = await p.evaluate(POLL_REPLY_FN);
      baseline = base.text || '';
    } catch (_) {
      baseline = '';
    }

    // Insert text
    await p.evaluate(INSERT_TEXT_FN, text);

    // First-message fix: wait 500ms, then retry click up to 10 times with re-dispatch
    await p.waitForTimeout(500);

    let sent = false;
    let lastErr = null;
    for (let i = 0; i < 10; i++) {
      try {
        // Re-dispatch input event every attempt (React may not have picked it up)
        if (i > 0) {
          await p.evaluate(REDISPATCH_INPUT_FN, text);
          await p.waitForTimeout(200);
        }
        const result = await p.evaluate(CLICK_SEND_FN);
        if (result.ok) {
          sent = true;
          break;
        }
        lastErr = result.disabled
          ? 'Botão disabled'
          : 'Botão não encontrado';
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

    // Listen for completion via Playwright console events as backup
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

        // Skip if we still see only the baseline (no new reply yet)
        // Once current grows beyond baseline or differs, track deltas.
        if (baseline && current === baseline) {
          // Still the old message
          if (poll.done || consoleDone) {
            // Completion fired but text same as baseline — extract forcefully
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

        // If current starts with baseline (appended?), take the suffix;
        // otherwise treat current as the full new reply.
        let effective = current;
        if (baseline && current.startsWith(baseline) && current.length > baseline.length) {
          // Unusual: same element grew — use full current
          effective = current;
        }

        if (effective.length > previousText.length && effective.startsWith(previousText)) {
          // Streaming growth
          const delta = effective.slice(previousText.length);
          previousText = effective;
          fullText = effective;
          stableCount = 0;
          if (onDelta && delta) onDelta(delta, fullText);
        } else if (effective !== previousText && effective.length > 0) {
          // Text replaced (new message appeared)
          // Emit the whole new text as delta if previous was empty/baseline
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

        // Completion?
        if (poll.done || consoleDone) {
          // Final extract after short settle
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
          // Reset done flag for next message
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

        // Heuristic: if text has been stable for a long time (30s) and non-empty, accept it
        // (in case console hook misses). 30s / 200ms = 150 polls
        if (stableCount > 150 && fullText.length > 20) {
          console.log('[browser] texto estável por ~30s — aceitando como completo');
          try {
            await p.evaluate(RESET_DONE_FN);
          } catch (_) {
            /* ignore */
          }
          return fullText;
        }

        await p.waitForTimeout(POLL_INTERVAL_MS);
      }

      // Timeout — return whatever we have
      if (fullText) {
        console.warn(`[browser] timeout ${timeoutS}s — retornando texto parcial`);
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

/**
 * Open browser for manual login (visible).
 * @param {string} accountName
 */
async function openForLogin(accountName) {
  let account = accounts.find(accountName);
  if (!account) {
    account = accounts.add(accountName);
  }
  accounts.setActive(accountName);
  await launchForAccount(account, { headless: false, forLogin: true });
  await ensureOnAccio(page);
  console.log(`[browser] Chrome aberto para login da conta "${accountName}".`);
  console.log('[browser] Faça o login no Chrome e feche esta opção quando terminar.');
  return page;
}

/**
 * Close browser / context.
 */
async function closeBrowser() {
  try {
    if (page && !page.isClosed()) {
      // don't close page if CDP — leave Chrome open
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
  try {
    if (browser && usedCdp) {
      // Disconnect without killing Chrome
      await browser.close();
    }
  } catch (_) {
    /* ignore */
  }
  browser = null;
  context = null;
  page = null;
  pw = null;
  currentAccountName = null;
  usedCdp = false;
}

/**
 * Is the browser currently busy with a request?
 */
function isBusy() {
  return busy;
}

/**
 * Get current page URL (if any).
 */
function getStatus() {
  return {
    account: currentAccountName,
    hasPage: !!(page && !page.isClosed()),
    usedCdp,
    busy,
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
