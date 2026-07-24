/**
 * Extrai a resposta do modelo no chat Accio.
 *
 * Problemas do clipboard no console:
 * - navigator.clipboard exige gesto do usuário + contexto seguro
 * - DevTools aberto / site anti-debug costuma bloquear
 * - focus fora da página falha o writeText
 *
 * Esta versão:
 * 1. tenta pegar a ÚLTIMA mensagem do assistente (não a página inteira)
 * 2. tenta clipboard
 * 3. se falhar: baixa um .txt, e ainda deixa o texto em window.__ACCIO_LAST_REPLY
 * 4. imprime no console para copiar manualmente
 */
(async function extractAccioReply(options = {}) {
  const {
    preferLastAssistant = true,
    tryClipboard = true,
    downloadFallback = true,
    fileName = `accio-reply-${Date.now()}.txt`,
  } = options;

  function clean(text) {
    return (text || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function pickLastAssistantText() {
    // Heurísticas comuns em UIs de chat (Accio / shadcn-like).
    // Ajuste os seletores se o DOM do site mudar.
    const candidates = [
      ...document.querySelectorAll('[data-role="assistant"]'),
      ...document.querySelectorAll('[data-message-role="assistant"]'),
      ...document.querySelectorAll('[class*="assistant"]'),
      ...document.querySelectorAll('article'),
      ...document.querySelectorAll('main [class*="message"]'),
      ...document.querySelectorAll('main .prose'),
      ...document.querySelectorAll('main [class*="markdown"]'),
    ];

    const unique = [...new Set(candidates)].filter((el) => {
      const t = clean(el.innerText);
      return t.length > 20;
    });

    if (!unique.length) return null;
    const last = unique[unique.length - 1];
    return clean(last.innerText);
  }

  function pickFullMainText() {
    const mainContent = document.querySelector('main') || document.body;
    return clean(mainContent.innerText);
  }

  let text = preferLastAssistant ? pickLastAssistantText() : null;
  if (!text) text = pickFullMainText();
  if (!text) {
    console.error('❌ Nenhum texto encontrado na página.');
    return { ok: false, error: 'empty' };
  }

  // Sempre disponível no console: window.__ACCIO_LAST_REPLY
  window.__ACCIO_LAST_REPLY = text;

  async function tryWriteClipboard(value) {
    // 1) API moderna
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) { /* fall through */ }

    // 2) Fallback antigo com textarea + execCommand (às vezes passa sem permissão explícita)
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.width = '1px';
      ta.style.height = '1px';
      ta.style.opacity = '0';
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

  let copied = false;
  if (tryClipboard) {
    // Um clique na página antes ajuda o clipboard; não bloqueamos se o usuário não clicar.
    console.log('Se o clipboard falhar, use window.__ACCIO_LAST_REPLY ou o .txt baixado.');
    copied = await tryWriteClipboard(text);
  }

  if (!copied && downloadFallback) {
    try {
      downloadText(text, fileName);
      console.log(`⬇️ Clipboard falhou/bloqueado — baixei: ${fileName}`);
    } catch (err) {
      console.warn('Download fallback falhou:', err);
    }
  }

  console.log(copied ? '✅ Copiado para a área de transferência.' : '⚠️ Não copiou para o clipboard (bloqueio do site/DevTools/permissão).');
  console.log('📦 Texto também em: window.__ACCIO_LAST_REPLY');
  console.log('--- Prévia ---');
  console.log(text.slice(0, 400) + (text.length > 400 ? '...' : ''));
  console.log(`--- tamanho: ${text.length} chars ---`);

  return { ok: true, copied, text, length: text.length };
})();
