// src/platform.js
// Detect OS and resolve Chrome / profile paths for Windows-native and WSL.

const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const IS_WSL =
  !IS_WIN &&
  (() => {
    try {
      return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
    } catch (_) {
      return false;
    }
  })();

function chromeExe() {
  if (process.env.ACCIO_CHROME_EXE) return process.env.ACCIO_CHROME_EXE;
  if (IS_WIN) {
    const candidates = [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return candidates[0];
  }
  // WSL / Linux: Windows Chrome via /mnt/c
  return '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';
}

/** Default Windows Chrome "User Data" dir for the current user. */
function defaultChromeUserDataDir() {
  if (IS_WIN) {
    return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  }
  // WSL view of Windows user — best-effort
  return '/mnt/c/Users/Adoro/AppData/Local/Google/Chrome/User Data';
}

/**
 * Parse a user-provided Chrome profile path into:
 *   { userDataDir, profileDirectory }
 *
 * Accepts either:
 *   - ...\User Data                  → profileDirectory = Default
 *   - ...\User Data\Default
 *   - ...\User Data\Profile 1
 *   - any other dir used as full user-data-dir (profileDirectory = null)
 */
function parseChromeProfilePath(input) {
  if (!input || typeof input !== 'string') {
    return { userDataDir: null, profileDirectory: null };
  }
  let p = input.trim().replace(/^["']|["']$/g, '');
  // Normalize trailing separators
  p = p.replace(/[\\/]+$/, '');

  const base = path.basename(p);
  const parent = path.dirname(p);

  // If ends with Default / Profile N / Profile N (pt) → treat parent as User Data
  if (/^(Default|Profile \d+|Guest Profile|System Profile)$/i.test(base)) {
    return { userDataDir: parent, profileDirectory: base };
  }

  // If path itself looks like "User Data", use Default inside it
  if (/User Data$/i.test(p) || /Chrome$/i.test(base)) {
    return { userDataDir: p, profileDirectory: 'Default' };
  }

  // Dedicated automation profile (our C:\temp\accio-profiles\x): use as full user-data-dir
  return { userDataDir: p, profileDirectory: null };
}

/** Windows-style profile dir (always backslash path for Chrome --user-data-dir). */
function winProfileDir(accountName) {
  const safe = String(accountName).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `C:\\temp\\accio-profiles\\${safe}`;
}

/**
 * Local filesystem path where we can mkdir the profile from the current OS.
 * On Windows: C:\temp\accio-profiles\<name>
 * On WSL: /mnt/c/temp/accio-profiles/<name>
 */
function profileFsPath(accountName) {
  const safe = String(accountName).replace(/[^a-zA-Z0-9_-]/g, '_');
  if (IS_WIN) return path.join('C:\\temp', 'accio-profiles', safe);
  return path.posix.join('/mnt/c/temp/accio-profiles', safe);
}

function ensureProfileDir(accountName) {
  const dir = profileFsPath(accountName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Args that make Chrome look less like automation (helps Google login).
 * Never use these alone if Google still blocks — prefer real profile + CDP.
 */
function stealthChromeArgs(extra = []) {
  return [
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--disable-features=IsolateOrigins,site-per-process',
    '--password-store=basic',
    '--use-mock-keychain',
    ...extra,
  ];
}

module.exports = {
  IS_WIN,
  IS_WSL,
  chromeExe,
  defaultChromeUserDataDir,
  parseChromeProfilePath,
  winProfileDir,
  profileFsPath,
  ensureProfileDir,
  stealthChromeArgs,
};
