#!/usr/bin/env python3
"""
Accio CLI de teste (visível).

Abre o Chrome no Windows em https://www.accio.com/,
deixa você digitar no terminal e tenta:
  1) colar o texto no chat
  2) clicar em enviar
  3) esperar o log maybeNotifyTaskComplete kind=success
  4) extrair a resposta e imprimir no CLI

Uso:
  cd "/home/aldair/accio proxy"
  source .venv/bin/activate
  python accio_cli.py

Comandos no prompt:
  /quit   sair
  /help   ajuda
  /extract  puxa texto atual
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

from playwright.sync_api import Browser, ConsoleMessage, Page, Playwright, sync_playwright

ACCIO_URL = "https://www.accio.com/"
CDP_PORT = 9333          # Chrome no Windows (só 127.0.0.1)
RELAY_PORT = 9334        # Relay no Windows escutando 0.0.0.0 (WSL conecta aqui)
PROFILE_DIR_WIN = r"C:\temp\accio-cli-profile"
CHROME_EXE_WIN = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
NODE_EXE_WIN = r"C:\Program Files\nodejs\node.exe"
SCRIPT_DIR = Path(__file__).resolve().parent
# Cópia no Windows (sem espaço no path) — o Node do Windows lê daqui.
RELAY_JS_WIN = r"C:\temp\accio-proxy\cdp-relay.js"
RELAY_JS_WSL = Path("/mnt/c/temp/accio-proxy/cdp-relay.js")
DEFAULT_TIMEOUT_S = 180

INSERT_JS = r"""
(text) => {
  const editor = document.querySelector('.chat-input-scrollable');
  if (!editor) throw new Error('Editor .chat-input-scrollable não encontrado');
  editor.focus();
  const target = editor.querySelector('p') || editor;
  target.textContent = text;
  editor.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text,
  }));
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(target);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}
"""

SEND_JS = r"""
() => {
  const sendButton = document.querySelector('button.bg-primary.text-primary-foreground.cursor-pointer');
  if (!sendButton) throw new Error('Botão de enviar não encontrado');
  if (sendButton.disabled) throw new Error('Botão de enviar está disabled (campo vazio?)');
  sendButton.click();
  return true;
}
"""

EXTRACT_JS = r"""
() => {
  function clean(text) {
    return (text || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if (window.__ACCIO_LAST_REPLY) return clean(window.__ACCIO_LAST_REPLY);
  const candidates = [
    ...document.querySelectorAll('[data-role="assistant"]'),
    ...document.querySelectorAll('[data-message-role="assistant"]'),
    ...document.querySelectorAll('[class*="assistant"]'),
    ...document.querySelectorAll('article'),
    ...document.querySelectorAll('main [class*="message"]'),
    ...document.querySelectorAll('main .prose'),
    ...document.querySelectorAll('main [class*="markdown"]'),
  ];
  const unique = [...new Set(candidates)].filter((el) => clean(el.innerText).length > 20);
  if (unique.length) return clean(unique[unique.length - 1].innerText);
  const mainContent = document.querySelector('main') || document.body;
  return clean(mainContent.innerText);
}
"""

WATCHER_JS = r"""
() => {
  if (window.__ACCIO_WATCHER_INSTALLED__) return 'already';
  window.__ACCIO_WATCHER_INSTALLED__ = true;
  window.__ACCIO_DONE__ = false;
  window.__ACCIO_LAST_REPLY = null;

  function clean(text) {
    return (text || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  function pickLastAssistantText() {
    const candidates = [
      ...document.querySelectorAll('[data-role="assistant"]'),
      ...document.querySelectorAll('[data-message-role="assistant"]'),
      ...document.querySelectorAll('[class*="assistant"]'),
      ...document.querySelectorAll('article'),
      ...document.querySelectorAll('main [class*="message"]'),
      ...document.querySelectorAll('main .prose'),
      ...document.querySelectorAll('main [class*="markdown"]'),
    ];
    const unique = [...new Set(candidates)].filter((el) => clean(el.innerText).length > 20);
    if (!unique.length) return null;
    return clean(unique[unique.length - 1].innerText);
  }
  function extractNow() {
    const text = pickLastAssistantText() || clean((document.querySelector('main') || document.body).innerText);
    window.__ACCIO_LAST_REPLY = text;
    window.__ACCIO_DONE__ = true;
    window.__ACCIO_LAST_AT = new Date().toISOString();
    return text;
  }
  window.__ACCIO_EXTRACT_NOW__ = extractNow;

  function isHit(args) {
    const msg = args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
    return msg.includes('maybeNotifyTaskComplete') && msg.includes('kind=success');
  }

  const wrap = (method) => {
    const original = console[method].bind(console);
    console[method] = function (...args) {
      original(...args);
      if (!isHit(args)) return;
      setTimeout(() => {
        try { extractNow(); } catch (e) { console.error('extract failed', e); }
      }, 400);
    };
  };
  for (const m of ['log', 'info', 'debug', 'warn']) wrap(m);
  return 'installed';
}
"""


def windows_host_ip() -> str:
    """IP do host Windows visto pelo WSL (gateway da interface eth0)."""
    try:
        out = subprocess.check_output(["ip", "route", "show"], text=True)
        for line in out.splitlines():
            if line.startswith("default "):
                parts = line.split()
                if "via" in parts:
                    return parts[parts.index("via") + 1]
    except Exception:  # noqa: BLE001
        pass
    return "172.22.0.1"


def wsl_path_to_win(path: Path) -> str:
    s = str(path.resolve())
    if s.startswith("/mnt/") and len(s) > 6 and s[6] == "/":
        drive = s[5].upper()
        rest = s[7:].replace("/", "\\")
        return f"{drive}:\\{rest}"
    # fallback: \\wsl$\...
    return s


def launch_chrome_windows() -> None:
    """Lança Chrome no Windows com CDP (via binário acessível pelo WSL).

    Observação: `Start-Process` no PowerShell neste ambiente às vezes sobe o
    Chrome SEM a porta de debug. Chamar o chrome.exe pelo path /mnt/c/...
    funciona de forma confiável.
    """
    chrome_wsl = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
    profile_wsl = Path("/mnt/c/temp/accio-cli-profile")
    profile_wsl.mkdir(parents=True, exist_ok=True)

    # Encerra só processos desse profile (via PowerShell)
    ps_kill = f"""
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | ForEach-Object {{
  if ($_.CommandLine -and $_.CommandLine -like '*accio-cli-profile*') {{
    try {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }} catch {{}}
  }}
}}
Get-NetTCPConnection -LocalPort {CDP_PORT} -ErrorAction SilentlyContinue |
  ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }}
"""
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", ps_kill],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    time.sleep(1)

    cmd = [
        chrome_wsl,
        f"--remote-debugging-port={CDP_PORT}",
        "--remote-allow-origins=*",
        f"--user-data-dir={PROFILE_DIR_WIN}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
        "--new-window",
        ACCIO_URL,
    ]
    print(f"[accio] abrindo Chrome (WSL→Windows) profile={PROFILE_DIR_WIN}")
    subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def wait_windows_cdp_local(timeout_s: float = 40.0) -> None:
    """Espera o CDP do Chrome responder em 127.0.0.1 no Windows (via PowerShell)."""
    ps = f"""
$deadline = (Get-Date).AddSeconds({int(timeout_s)})
$last = $null
while ((Get-Date) -lt $deadline) {{
  try {{
    $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:{CDP_PORT}/json/version -TimeoutSec 2
    Write-Output $r.Content
    exit 0
  }} catch {{
    $last = $_.Exception.Message
    Start-Sleep -Milliseconds 400
  }}
}}
Write-Output "CDP local timeout: $last"
exit 1
"""
    print(f"[accio] aguardando CDP local Windows :{CDP_PORT}…")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", ps],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Chrome não abriu CDP em 127.0.0.1:{CDP_PORT}. "
            f"stdout={result.stdout.strip()!r} stderr={result.stderr.strip()!r}"
        )
    print("[accio] CDP local ok")


def launch_relay_windows() -> None:
    """Relay Node no Windows: 0.0.0.0:RELAY_PORT -> 127.0.0.1:CDP_PORT."""
    # Garante a cópia no FS do Windows (Node host não gosta de path com espaço no WSL)
    RELAY_JS_WSL.parent.mkdir(parents=True, exist_ok=True)
    src = SCRIPT_DIR / "cdp-relay.js"
    RELAY_JS_WSL.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")

    ps = f"""
Get-NetTCPConnection -LocalPort {RELAY_PORT} -ErrorAction SilentlyContinue |
  ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }}
Start-Process -FilePath '{NODE_EXE_WIN}' -ArgumentList @('{RELAY_JS_WIN}','{RELAY_PORT}','{CDP_PORT}') -WindowStyle Hidden
"""
    print(f"[accio] subindo CDP relay Windows :{RELAY_PORT} -> :{CDP_PORT}")
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", ps],
        check=False,
        capture_output=True,
        text=True,
    )


def wait_tcp(host: str, port: int, timeout_s: float = 40.0, label: str = "tcp") -> None:
    deadline = time.time() + timeout_s
    last_err: Optional[Exception] = None
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=2):
                print(f"[accio] {label} ok: {host}:{port}")
                return
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(0.4)
    raise RuntimeError(f"{label} não ficou pronto em {timeout_s}s ({host}:{port}): {last_err}")


def wait_cdp_http(host: str, port: int, timeout_s: float = 40.0) -> dict:
    import urllib.request

    deadline = time.time() + timeout_s
    url = f"http://{host}:{port}/json/version"
    last_err: Optional[Exception] = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                data = json.loads(resp.read().decode())
                print(f"[accio] CDP ok: {data.get('Browser', data)}")
                return data
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(0.4)
    raise RuntimeError(f"CDP HTTP não respondeu em {timeout_s}s ({url}): {last_err}")


def connect_browser(p: Playwright, host: str, port: int) -> Browser:
    return p.chromium.connect_over_cdp(f"http://{host}:{port}")


def get_accio_page(browser: Browser) -> Page:
    for ctx in browser.contexts:
        for page in ctx.pages:
            if "accio.com" in (page.url or ""):
                page.bring_to_front()
                return page
    if browser.contexts and browser.contexts[0].pages:
        page = browser.contexts[0].pages[0]
    else:
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()
        page = ctx.new_page()
    page.goto(ACCIO_URL, wait_until="domcontentloaded", timeout=120_000)
    return page


def install_watcher(page: Page) -> None:
    status = page.evaluate(WATCHER_JS)
    print(f"[accio] watcher: {status}")


def wait_for_completion(page: Page, timeout_s: float = DEFAULT_TIMEOUT_S) -> str:
    done = {"flag": False}

    def on_console(msg: ConsoleMessage) -> None:
        text = msg.text or ""
        if "maybeNotifyTaskComplete" in text and "kind=success" in text:
            done["flag"] = True

    page.on("console", on_console)
    try:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            try:
                ready = page.evaluate("() => !!(window.__ACCIO_DONE__ && window.__ACCIO_LAST_REPLY)")
            except Exception:  # noqa: BLE001
                ready = False
            if ready or done["flag"]:
                page.wait_for_timeout(500)
                if done["flag"] and not ready:
                    page.evaluate("() => window.__ACCIO_EXTRACT_NOW__ && window.__ACCIO_EXTRACT_NOW__()")
                    page.wait_for_timeout(300)
                text = page.evaluate(EXTRACT_JS)
                if text and len(text.strip()) > 0:
                    page.evaluate("() => { window.__ACCIO_DONE__ = false; }")
                    return text
            page.wait_for_timeout(300)
        raise TimeoutError(f"Modelo não finalizou em {timeout_s}s")
    finally:
        try:
            page.remove_listener("console", on_console)
        except Exception:  # noqa: BLE001
            pass


def send_prompt(page: Page, text: str) -> None:
    page.evaluate("() => { window.__ACCIO_DONE__ = false; window.__ACCIO_LAST_REPLY = null; }")
    page.evaluate(INSERT_JS, text)
    page.wait_for_timeout(250)
    last: Optional[Exception] = None
    for _ in range(10):
        try:
            page.evaluate(SEND_JS)
            return
        except Exception as exc:  # noqa: BLE001
            last = exc
            page.wait_for_timeout(200)
    raise RuntimeError(f"Não consegui clicar em enviar: {last}")


def chat_loop(page: Page) -> None:
    print()
    print("=" * 60)
    print("Accio CLI de teste")
    print("Digite a mensagem e Enter. Comandos: /quit  /help  /extract")
    print("Se o site pedir login, faça no Chrome aberto e volte aqui.")
    print("=" * 60)

    while True:
        try:
            user = input("\nVocê> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n[accio] saindo.")
            break

        if not user:
            continue
        if user in {"/quit", "/exit", ":q"}:
            print("[accio] saindo.")
            break
        if user == "/help":
            print("  /quit     sair")
            print("  /extract  puxa o texto atual da página sem enviar")
            print("  resto     envia pro Accio e espera a resposta")
            continue
        if user == "/extract":
            try:
                install_watcher(page)
                text = page.evaluate(
                    "() => window.__ACCIO_EXTRACT_NOW__ ? window.__ACCIO_EXTRACT_NOW__() : null"
                ) or page.evaluate(EXTRACT_JS)
                print("\n--- extract ---\n")
                print(text)
                print("\n---------------\n")
            except Exception as exc:  # noqa: BLE001
                print(f"[erro] extract: {exc}")
            continue

        try:
            install_watcher(page)
            print("[accio] enviando…")
            send_prompt(page, user)
            print("[accio] aguardando o modelo terminar…")
            reply = wait_for_completion(page, timeout_s=DEFAULT_TIMEOUT_S)
            print("\n--- Accio ---\n")
            print(reply)
            print("\n-------------\n")
        except Exception as exc:  # noqa: BLE001
            print(f"[erro] {exc}")
            print("Dicas: confira se o chat está aberto, se está logado, e se o seletor do input ainda vale.")


def main() -> int:
    host = os.environ.get("ACCIO_CDP_HOST") or windows_host_ip()
    port = int(os.environ.get("ACCIO_CDP_PORT") or RELAY_PORT)

    try:
        launch_chrome_windows()
        wait_windows_cdp_local(45)
        launch_relay_windows()
        wait_tcp(host, port, timeout_s=40, label="relay")
        wait_cdp_http(host, port, timeout_s=40)

        with sync_playwright() as p:
            browser = connect_browser(p, host, port)
            page = get_accio_page(browser)
            print(f"[accio] página: {page.url}")
            install_watcher(page)
            chat_loop(page)
            print("[accio] CLI encerrado. O Chrome continua aberto.")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"[fatal] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
