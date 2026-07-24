// src/accounts.js
// Account CRUD — manages accounts.json
// Each account: { name, user_data_dir, win_data_dir, created_at, last_used, chrome_profile }

const fs = require('fs');
const path = require('path');
const platform = require('./platform');

const PROJECT_DIR = path.resolve(__dirname, '..');
const ACCOUNTS_FILE = path.join(PROJECT_DIR, 'accounts.json');
const PROFILES_DIR = path.join(PROJECT_DIR, '.profiles');
const WIN_PROFILES_BASE = 'C:\\temp\\accio-profiles';

/**
 * Read accounts.json. If it doesn't exist, create with defaults.
 * @returns {{accounts: Array, active: string|null}}
 */
function load() {
  if (!fs.existsSync(PROFILES_DIR)) {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
  }
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    save({ accounts: [], active: null });
  }
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[accounts] Erro ao ler accounts.json:', err.message);
    return { accounts: [], active: null };
  }
}

/**
 * Save accounts data to accounts.json.
 * @param {{accounts: Array, active: string|null}} data
 */
function save(data) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * List all accounts.
 * @returns {Array}
 */
function list() {
  return load().accounts;
}

/**
 * Get the active account object (or null).
 * @returns {object|null}
 */
function getActive() {
  const data = load();
  if (!data.active) return null;
  return data.accounts.find((a) => a.name === data.active) || null;
}

/**
 * Get the active account name (or null).
 * @returns {string|null}
 */
function getActiveName() {
  return load().active;
}

/**
 * Set the active account by name.
 * @param {string} name
 * @returns {boolean} success
 */
function setActive(name) {
  const data = load();
  const acct = data.accounts.find((a) => a.name === name);
  if (!acct) return false;
  data.active = name;
  acct.last_used = new Date().toISOString();
  save(data);
  return true;
}

/**
 * Find an account by name.
 * @param {string} name
 * @returns {object|null}
 */
function find(name) {
  return load().accounts.find((a) => a.name === name) || null;
}

/**
 * Add a new account.
 * Auto-creates profile directories (WSL + Windows path).
 * @param {string} name
 * @returns {object} the created account
 */
function add(name) {
  const data = load();
  if (data.accounts.find((a) => a.name === name)) {
    throw new Error(`Conta "${name}" já existe.`);
  }

  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const user_data_dir = path.join(PROFILES_DIR, safeName);
  const win_data_dir = `${WIN_PROFILES_BASE}\\${safeName}`;

  // Create local + Windows-facing profile dirs
  fs.mkdirSync(user_data_dir, { recursive: true });
  try {
    platform.ensureProfileDir(name);
  } catch (_) {
    /* best-effort */
  }

  const account = {
    name,
    user_data_dir,
    win_data_dir,
    chrome_profile: null, // user can set this later
    created_at: new Date().toISOString(),
    last_used: null,
  };

  data.accounts.push(account);
  if (!data.active) data.active = name;
  save(data);
  return account;
}

/**
 * Remove an account by name.
 * Does NOT delete the profile directories (user may want to keep login).
 * @param {string} name
 * @returns {boolean} success
 */
function remove(name) {
  const data = load();
  const idx = data.accounts.findIndex((a) => a.name === name);
  if (idx === -1) return false;
  data.accounts.splice(idx, 1);
  if (data.active === name) {
    data.active = data.accounts[0] ? data.accounts[0].name : null;
  }
  save(data);
  return true;
}

/**
 * Set a custom Chrome profile path for an account.
 * Accepts User Data, User Data\Default, or a dedicated user-data-dir.
 * @param {string} name
 * @param {string} profilePath
 */
function setCustomProfile(name, profilePath) {
  const data = load();
  const acct = data.accounts.find((a) => a.name === name);
  if (!acct) throw new Error(`Conta "${name}" não encontrada.`);

  const parsed = platform.parseChromeProfilePath(profilePath);
  // Keep legacy field for display / older code
  acct.chrome_profile = profilePath;
  acct.chrome_user_data_dir = parsed.userDataDir;
  acct.chrome_profile_directory = parsed.profileDirectory;
  save(data);
  return {
    userDataDir: parsed.userDataDir,
    profileDirectory: parsed.profileDirectory,
  };
}

/**
 * Update last_used timestamp for an account.
 * @param {string} name
 */
function touchAccount(name) {
  const data = load();
  const acct = data.accounts.find((a) => a.name === name);
  if (acct) {
    acct.last_used = new Date().toISOString();
    save(data);
  }
}

module.exports = {
  load,
  save,
  list,
  find,
  add,
  remove,
  getActive,
  getActiveName,
  setActive,
  touchAccount,
  setCustomProfile,
  PROFILES_DIR,
  ACCOUNTS_FILE,
};