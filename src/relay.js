// src/relay.js
// CDP relay helper for WSL → Windows Chrome communication.
//
// Chrome on Windows listens on 127.0.0.1:9333 (Windows localhost).
// WSL cannot reach that. We run cdp-relay.js on Windows Node which
// listens on 0.0.0.0:9334 and forwards to 127.0.0.1:9333.
// WSL then connects to the Windows host IP on port 9334.

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');

const PROJECT_DIR = path.resolve(__dirname, '..');
const CDP_PORT = Number(process.env.ACCIO_CDP_PORT || 9333);
const RELAY_PORT = Number(process.env.ACCIO_RELAY_PORT || 9334);
const platform = require('./platform');
const CHROME_EXE =
  process.env.ACCIO_CHROME_EXE || platform.chromeExe();
const NODE_EXE_WIN =
  process.env.ACCIO_NODE_EXE || 'C:\\Program Files\\nodejs\\node.exe';
const RELAY_JS_WIN = 'C:\\temp\\accio-proxy\\cdp-relay.js';
const RELAY_JS_WSL = '/mnt/c/temp/accio-proxy/cdp-relay.js';
const ACCIO_URL = process.env.ACCIO_URL || 'https://www.accio.com/';

/**
 * Get the Windows host IP as seen from WSL (default gateway).
 * On native Windows, always 127.0.0.1 (no relay needed for local CDP).
 * @returns {string}
 */
function windowsHostIp() {
  if (process.env.ACCIO_CDP_HOST) return process.env.ACCIO_CDP_HOST;
  if (platform.IS_WIN) return '127.0.0.1';
  try {
    const out = execSync('ip route show', { encoding: 'utf-8' });
    for (const line of out.split('\n')) {
      if (line.startsWith('default ')) {
        const parts = line.split(/\s+/);
        const viaIdx = parts.indexOf('via');
        if (viaIdx !== -1 && parts[viaIdx + 1]) return parts[viaIdx + 1];
      }
    }
  } catch (_) {
    /* fall through */
  }
  return '172.22.0.1';
}

/**
 * Wait until a TCP port is accepting connections.
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<void>}
 */
function waitTcp(host, port, timeoutMs = 40000, label = 'tcp') {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;

    function attempt() {
      if (Date.now() > deadline) {
        reject(
          new Error(
            `${label} não ficou pronto em ${timeoutMs}ms (${host}:${port}): ${lastErr}`,
          ),
        );
        return;
      }
      const sock = net.createConnection({ host, port }, () => {
        sock.destroy();
        console.log(`[relay] ${label} ok: ${host}:${port}`);
        resolve();
      });
      sock.on('error', (err) => {
        lastErr = err.message;
        sock.destroy();
        setTimeout(attempt, 400);
      });
    }
    attempt();
  });
}

/**
 * Wait for CDP HTTP /json/version to respond.
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
function waitCdpHttp(host, port, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const url = `http://${host}:${port}/json/version`;
    let lastErr = null;

    function attempt() {
      if (Date.now() > deadline) {
        reject(
          new Error(
            `CDP HTTP não respondeu em ${timeoutMs}ms (${url}): ${lastErr}`,
          ),
        );
        return;
      }
      const req = http.get(url, { timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            console.log(`[relay] CDP ok: ${data.Browser || JSON.stringify(data)}`);
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
 * Wait for Windows-local CDP via PowerShell (127.0.0.1:CDP_PORT).
 * @param {number} timeoutS
 * @returns {Promise<void>}
 */
function waitWindowsCdpLocal(timeoutS = 40) {
  return new Promise((resolve, reject) => {
    const ps = `
$deadline = (Get-Date).AddSeconds(${timeoutS})
$last = $null
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:${CDP_PORT}/json/version -TimeoutSec 2
    Write-Output $r.Content
    exit 0
  } catch {
    $last = $_.Exception.Message
    Start-Sleep -Milliseconds 400
  }
}
Write-Output "CDP local timeout: $last"
exit 1
`;
    console.log(`[relay] aguardando CDP local Windows :${CDP_PORT}…`);
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      if (code === 0) {
        console.log('[relay] CDP local ok');
        resolve();
      } else {
        reject(
          new Error(
            `Chrome não abriu CDP em 127.0.0.1:${CDP_PORT}. stdout=${stdout.trim()} stderr=${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

/**
 * Kill Chrome processes using a specific profile dir (Windows).
 * @param {string} profileNameFragment - substring of the user-data-dir path
 */
function killChromeProfile(profileNameFragment) {
  const ps = `
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | ForEach-Object {
  if ($_.CommandLine -and $_.CommandLine -like '*${profileNameFragment}*') {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
}
Get-NetTCPConnection -LocalPort ${CDP_PORT} -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
`;
  try {
    execSync(`powershell.exe -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
      stdio: 'ignore',
      timeout: 15000,
    });
  } catch (_) {
    /* best-effort */
  }
}

/**
 * Launch Chrome on Windows with remote debugging.
 * @param {string} winDataDir - Windows path for --user-data-dir
 * @param {object} opts
 * @param {boolean} [opts.headless=false]
 * @param {string} [opts.url]
 * @returns {import('child_process').ChildProcess}
 */
function launchChromeWindows(winDataDir, opts = {}) {
  const { headless = false, url = ACCIO_URL } = opts;

  // Ensure profile dir exists from current OS
  const fsProfile = platform.IS_WIN
    ? winDataDir
    : winDataDir
        .replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`)
        .replace(/\\/g, '/');
  try {
    fs.mkdirSync(fsProfile, { recursive: true });
  } catch (_) {
    /* may already exist */
  }

  const fragment = path.basename(winDataDir.replace(/\\/g, '/'));
  killChromeProfile(fragment);

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${winDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--new-window',
  ];
  if (headless) {
    args.push('--headless=new');
  }
  args.push(url);

  console.log(
    `[relay] abrindo Chrome profile=${winDataDir} exe=${CHROME_EXE} headless=${headless}`,
  );
  const child = spawn(CHROME_EXE, args, {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', (err) => {
    console.error(`[relay] falha ao spawn Chrome: ${err.message}`);
  });
  child.unref();
  return child;
}

/**
 * Launch the CDP TCP relay on Windows Node.
 * Copies cdp-relay.js to C:\temp\accio-proxy\ first.
 */
function launchRelayWindows() {
  // Copy relay script to Windows FS (no space in path)
  const src = path.join(PROJECT_DIR, 'cdp-relay.js');
  const destDir = path.dirname(RELAY_JS_WSL);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, RELAY_JS_WSL);

  const ps = `
Get-NetTCPConnection -LocalPort ${RELAY_PORT} -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Process -FilePath '${NODE_EXE_WIN}' -ArgumentList @('${RELAY_JS_WIN}','${RELAY_PORT}','${CDP_PORT}') -WindowStyle Hidden
`;
  console.log(`[relay] subindo CDP relay Windows :${RELAY_PORT} -> :${CDP_PORT}`);
  try {
    execSync(`powershell.exe -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
      stdio: 'ignore',
      timeout: 15000,
    });
  } catch (err) {
    // Fallback: spawn via powershell differently
    spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', ps],
      { stdio: 'ignore', detached: true },
    ).unref();
  }
}

/**
 * Full bootstrap: launch Chrome + relay + wait for CDP ready.
 * @param {string} winDataDir
 * @param {object} [opts]
 * @returns {Promise<{host: string, port: number}>}
 */
async function bootstrapCdp(winDataDir, opts = {}) {
  // On native Windows: Chrome CDP is already on 127.0.0.1 — no WSL relay.
  if (platform.IS_WIN) {
    const host = '127.0.0.1';
    const port = CDP_PORT;
    launchChromeWindows(winDataDir, opts);
    await sleep(1500);
    await waitCdpHttp(host, port, 45000);
    return { host, port };
  }

  const host = windowsHostIp();
  const port = RELAY_PORT;

  launchChromeWindows(winDataDir, opts);
  await sleep(1500);
  await waitWindowsCdpLocal(45);
  launchRelayWindows();
  await waitTcp(host, port, 40000, 'relay');
  await waitCdpHttp(host, port, 40000);
  return { host, port };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  CDP_PORT,
  RELAY_PORT,
  ACCIO_URL,
  CHROME_EXE,
  windowsHostIp,
  waitTcp,
  waitCdpHttp,
  waitWindowsCdpLocal,
  killChromeProfile,
  launchChromeWindows,
  launchRelayWindows,
  bootstrapCdp,
  sleep,
};
