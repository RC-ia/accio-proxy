// src/inject.js
// JS snippets injected into the Accio page via page.evaluate().
// Exported as function-body strings (or full functions) for Playwright.

/**
 * INSERT_TEXT_FN — set text into .chat-input-scrollable and fire InputEvent.
 * Called as: page.evaluate(INSERT_TEXT_FN, text)
 */
const INSERT_TEXT_FN = (text) => {
  const editor = document.querySelector('.chat-input-scrollable');
  if (!editor) throw new Error('Editor .chat-input-scrollable não encontrado');
  editor.focus();
  const target = editor.querySelector('p') || editor;
  target.textContent = text;
  editor.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }),
  );
  // Also fire beforeinput / change for stubborn React controlled inputs
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(target);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
};

/**
 * CLICK_SEND_FN — click the Accio send button.
 * Returns { ok, disabled, found }.
 * Called as: page.evaluate(CLICK_SEND_FN)
 */
const CLICK_SEND_FN = () => {
  const sendButton = document.querySelector(
    'button.bg-primary.text-primary-foreground.cursor-pointer',
  );
  if (!sendButton) return { ok: false, found: false, disabled: false };
  if (sendButton.disabled) return { ok: false, found: true, disabled: true };
  sendButton.click();
  return { ok: true, found: true, disabled: false };
};

/**
 * EXTRACT_REPLY_FN — extract last assistant message text from the DOM.
 * Called as: page.evaluate(EXTRACT_REPLY_FN)
 */
const EXTRACT_REPLY_FN = () => {
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

  const unique = [...new Set(candidates)].filter(
    (el) => clean(el.innerText).length > 0,
  );
  if (unique.length) return clean(unique[unique.length - 1].innerText);

  const mainContent = document.querySelector('main') || document.body;
  return clean(mainContent.innerText);
};

/**
 * POLL_REPLY_FN — lightweight poll for streaming deltas.
 * Returns { text, length } of the last assistant message.
 * Called as: page.evaluate(POLL_REPLY_FN)
 */
const POLL_REPLY_FN = () => {
  function clean(text) {
    return (text || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  if (window.__ACCIO_LAST_REPLY && window.__ACCIO_DONE__) {
    return {
      text: clean(window.__ACCIO_LAST_REPLY),
      length: clean(window.__ACCIO_LAST_REPLY).length,
      done: true,
    };
  }

  const candidates = [
    ...document.querySelectorAll('[data-role="assistant"]'),
    ...document.querySelectorAll('[data-message-role="assistant"]'),
    ...document.querySelectorAll('[class*="assistant"]'),
    ...document.querySelectorAll('article'),
    ...document.querySelectorAll('main [class*="message"]'),
    ...document.querySelectorAll('main .prose'),
    ...document.querySelectorAll('main [class*="markdown"]'),
  ];

  const unique = [...new Set(candidates)].filter(
    (el) => clean(el.innerText).length > 0,
  );
  if (unique.length) {
    const text = clean(unique[unique.length - 1].innerText);
    return {
      text,
      length: text.length,
      done: !!(window.__ACCIO_DONE__),
    };
  }
  return { text: '', length: 0, done: !!(window.__ACCIO_DONE__) };
};

/**
 * CONSOLE_WATCHER_FN — install console.log hook for completion detection.
 * Sets window.__ACCIO_DONE__ = true and window.__ACCIO_LAST_REPLY when
 * "maybeNotifyTaskComplete" + "kind=success" is logged.
 * Called as: page.evaluate(CONSOLE_WATCHER_FN)
 */
const CONSOLE_WATCHER_FN = () => {
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
    const unique = [...new Set(candidates)].filter(
      (el) => clean(el.innerText).length > 0,
    );
    if (!unique.length) return null;
    return clean(unique[unique.length - 1].innerText);
  }

  function extractNow() {
    const text =
      pickLastAssistantText() ||
      clean((document.querySelector('main') || document.body).innerText);
    window.__ACCIO_LAST_REPLY = text;
    window.__ACCIO_DONE__ = true;
    window.__ACCIO_LAST_AT = new Date().toISOString();
    return text;
  }
  window.__ACCIO_EXTRACT_NOW__ = extractNow;

  function isHit(args) {
    const msg = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch (_) {
          return String(a);
        }
      })
      .join(' ');
    return (
      msg.includes('maybeNotifyTaskComplete') && msg.includes('kind=success')
    );
  }

  const wrap = (method) => {
    const original = console[method].bind(console);
    console[method] = function (...args) {
      original(...args);
      if (!isHit(args)) return;
      // Small delay so DOM finishes rendering the last chunk
      setTimeout(() => {
        try {
          extractNow();
        } catch (e) {
          console.error('extract failed', e);
        }
      }, 400);
    };
  };
  for (const m of ['log', 'info', 'debug', 'warn']) wrap(m);
  return 'installed';
};

/**
 * RESET_DONE_FN — reset completion flags before sending a new message.
 */
const RESET_DONE_FN = () => {
  window.__ACCIO_DONE__ = false;
  window.__ACCIO_LAST_REPLY = null;
  return true;
};

/**
 * REDISPATCH_INPUT_FN — re-dispatch input event (first-message fix).
 * The first message often fails because React hasn't picked up the text.
 */
const REDISPATCH_INPUT_FN = (text) => {
  const editor = document.querySelector('.chat-input-scrollable');
  if (!editor) return false;
  editor.focus();
  const target = editor.querySelector('p') || editor;
  // Ensure text is still there
  if (!target.textContent || target.textContent.trim().length === 0) {
    target.textContent = text;
  }
  editor.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text || target.textContent,
    }),
  );
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
};

module.exports = {
  INSERT_TEXT_FN,
  CLICK_SEND_FN,
  EXTRACT_REPLY_FN,
  POLL_REPLY_FN,
  CONSOLE_WATCHER_FN,
  RESET_DONE_FN,
  REDISPATCH_INPUT_FN,
};
