/**
 * Accio: monitora o console do site.
 * Quando o modelo termina (maybeNotifyTaskComplete + kind=success),
 * extrai a resposta e tenta copiar / baixar / expor em window.__ACCIO_LAST_REPLY.
 *
 * Como usar: cole este script no console da aba do Accio (uma vez por reload).
 * Depois envie a mensagem normalmente; ao terminar, o texto é capturado.
 */
(function installAccioCompletionWatcher() {
  if (window.__ACCIO_WATCHER_INSTALLED__) {
    console.warn('Monitor Accio já estava ativo.');
    return;
  }
  window.__ACCIO_WATCHER_INSTALLED__ = true;

  const logOriginal = console.log.bind(console);
  const warnOriginal = console.warn.bind(console);
  let busy = false;
  let lastTriggerAt = 0;

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

  function pickFullMainText() {
    const mainContent = document.querySelector('main') || document.body;
    return clean(mainContent.innerText);
  }

  async function tryWriteClipboard(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) { /* fall through */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  function downloadText(value, name) {
    const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function extractAndCopy(reasonPreview) {
    // Pequeno atraso para o DOM terminar de renderizar o último chunk.
    await new Promise((r) => setTimeout(r, 400));

    let text = pickLastAssistantText() || pickFullMainText();
    if (!text) {
      console.error('❌ Gatilho disparou, mas nenhum texto foi encontrado na página.');
      return { ok: false, error: 'empty' };
    }

    window.__ACCIO_LAST_REPLY = text;
    window.__ACCIO_LAST_PREVIEW = reasonPreview || null;
    window.__ACCIO_LAST_AT = new Date().toISOString();

    const copied = await tryWriteClipboard(text);
    if (!copied) {
      const fileName = `accio-reply-${Date.now()}.txt`;
      try {
        downloadText(text, fileName);
        warnOriginal(`⬇️ Clipboard bloqueado — baixei ${fileName}`);
      } catch (err) {
        console.error('Download fallback falhou:', err);
      }
    }

    logOriginal(
      copied
        ? '✅ Resposta copiada para a área de transferência.'
        : '⚠️ Clipboard bloqueado. Texto em window.__ACCIO_LAST_REPLY (e .txt se o download passou).',
    );
    logOriginal('📦 window.__ACCIO_LAST_REPLY');
    logOriginal('--- Prévia ---');
    logOriginal(text.slice(0, 400) + (text.length > 400 ? '...' : ''));
    logOriginal(`--- ${text.length} chars | ${window.__ACCIO_LAST_AT} ---`);

    return { ok: true, copied, text, length: text.length };
  }

  function isCompletionLog(args) {
    const mensagemCompleta = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (_) { return String(a); }
      })
      .join(' ');

    return {
      hit: mensagemCompleta.includes('maybeNotifyTaskComplete') && mensagemCompleta.includes('kind=success'),
      mensagemCompleta,
      preview: (mensagemCompleta.match(/preview="([\s\S]+?)"/) || [])[1] || null,
    };
  }

  console.log = function (...args) {
    logOriginal(...args);

    const { hit, preview } = isCompletionLog(args);
    if (!hit) return;

    const now = Date.now();
    // Evita disparo duplo se o site logar o mesmo evento 2x em sequência.
    if (busy || now - lastTriggerAt < 1500) return;
    lastTriggerAt = now;
    busy = true;

    warnOriginal('%c🎯 GATILHO: modelo terminou — extraindo resposta…', 'background:#222;color:#bada55;font-size:14px;');
    if (preview) logOriginal('📖 preview do site:', preview);

    extractAndCopy(preview)
      .catch((err) => console.error('❌ Falha ao extrair resposta:', err))
      .finally(() => { busy = false; });
  };

  // Também monitora console.info/debug se o site usar outro canal no futuro.
  for (const method of ['info', 'debug']) {
    const original = console[method].bind(console);
    console[method] = function (...args) {
      original(...args);
      const { hit, preview } = isCompletionLog(args);
      if (!hit || busy) return;
      const now = Date.now();
      if (now - lastTriggerAt < 1500) return;
      lastTriggerAt = now;
      busy = true;
      warnOriginal('%c🎯 GATILHO (' + method + '): extraindo resposta…', 'background:#222;color:#bada55;font-size:14px;');
      extractAndCopy(preview)
        .catch((err) => console.error('❌ Falha ao extrair resposta:', err))
        .finally(() => { busy = false; });
    };
  }

  window.__ACCIO_EXTRACT_NOW__ = () => extractAndCopy('manual');
  logOriginal('✅ Monitor Accio ativo. Aguardando maybeNotifyTaskComplete kind=success…');
  logOriginal('Dica: para forçar agora → __ACCIO_EXTRACT_NOW__()');
})();
