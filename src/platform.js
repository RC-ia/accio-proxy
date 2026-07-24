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

module.exports = {
  IS_WIN,
  IS_WSL,
  chromeExe,
  winProfileDir,
  profileFsPath,
  ensureProfileDir,
};
