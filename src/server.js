// src/server.js
// OpenAI-compatible Express API proxy for Accio.
//
// Endpoints:
//   POST /v1/chat/completions  — streaming or non-streaming chat
//   GET  /v1/models            — fake model list (model: "accio")
//   GET  /v1/accounts          — list accounts
//   POST /v1/accounts          — switch active account {name}
//   GET  /health               — health check

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const accounts = require('./accounts');
const browser = require('./browser');

const PORT = Number(process.env.PORT || process.env.ACCIO_PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

function makeId(prefix = 'chatcmpl') {
  return `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
}

function openaiChunk(id, model, content, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'accio',
    choices: [
      {
        index: 0,
        delta: content !== null ? { content } : {},
        finish_reason: finishReason,
      },
    ],
  };
}

function openaiCompletion(id, model, content) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'accio',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

/**
 * Extract the last user message text from OpenAI-style messages array.
 * Also joins multi-part content arrays.
 */
function lastUserText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages deve ser um array não-vazio');
  }
  let msg =
    [...messages].reverse().find((m) => m.role === 'user') ||
    messages[messages.length - 1];
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && part.type === 'text') return part.text || '';
        return '';
      })
      .join('');
  }
  if (msg.content == null) return '';
  return String(msg.content);
}

// ── GET /v1/models ──────────────────────────────────────────────
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'accio',
        object: 'model',
        created: 1700000000,
        owned_by: 'accio-proxy',
      },
    ],
  });
});

// ── GET /v1/accounts ────────────────────────────────────────────
app.get('/v1/accounts', (_req, res) => {
  const data = accounts.load();
  res.json({
    accounts: data.accounts.map((a) => ({
      name: a.name,
      created_at: a.created_at,
      last_used: a.last_used,
      active: a.name === data.active,
    })),
    active: data.active,
  });
});

// ── POST /v1/accounts ───────────────────────────────────────────
app.post('/v1/accounts', async (req, res) => {
  try {
    const { name, action = 'switch' } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: { message: 'Campo "name" é obrigatório' },
      });
    }

    if (action === 'add') {
      accounts.add(name);
      accounts.setActive(name);
      await browser.closeBrowser();
      return res.json({ ok: true, action: 'add', active: name });
    }

    if (action === 'remove') {
      const ok = accounts.remove(name);
      if (!ok) {
        return res
          .status(404)
          .json({
            error: { message: `Conta "${name}" não encontrada` },
          });
      }
      await browser.closeBrowser();
      return res.json({
        ok: true,
        action: 'remove',
        name,
        active: accounts.getActiveName(),
      });
    }

    // default: switch
    const ok = accounts.setActive(name);
    if (!ok) {
      return res
        .status(404)
        .json({ error: { message: `Conta "${name}" não encontrada` } });
    }
    await browser.closeBrowser();
    return res.json({ ok: true, action: 'switch', active: name });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
});

// ── POST /v1/chat/completions ───────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
  const body = req.body || {};
  const model = body.model || 'accio';
  const stream = !!body.stream;
  const id = makeId();

  let userText;
  try {
    userText = lastUserText(body.messages);
  } catch (err) {
    return res
      .status(400)
      .json({
        error: { message: err.message, type: 'invalid_request_error' },
      });
  }

  if (!userText || !userText.trim()) {
    return res
      .status(400)
      .json({
        error: {
          message: 'Mensagem do usuário vazia',
          type: 'invalid_request_error',
        },
      });
  }

  if (!accounts.getActiveName()) {
    return res.status(400).json({
      error: {
        message:
          'Nenhuma conta ativa. Use o CLI (opção 1) ou POST /v1/accounts para configurar.',
        type: 'account_error',
      },
    });
  }

  if (browser.isBusy()) {
    return res.status(429).json({
      error: {
        message: 'Já existe uma requisição em andamento. Aguarde.',
        type: 'rate_limit_error',
      },
    });
  }

  console.log(
    `[server] chat/completions stream=${stream} model=${model} chars=${userText.length}`,
  );

  if (stream) {
    handleStream(req, res, id, model, userText);
  } else {
    try {
      const full = await browser.sendMessage(userText, { stream: false });
      res.json(openaiCompletion(id, model, full));
      console.log(
        `[server] completion concluída (${(full || '').length} chars)`,
      );
    } catch (err) {
      console.error('[server] completion error:', err.message);
      res
        .status(500)
        .json({ error: { message: err.message, type: 'server_error' } });
    }
  }
});

async function handleStream(req, res, id, model, text) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Role chunk
  res.write(
    `data: ${JSON.stringify(openaiChunk(id, model, null)).replace(
      '"delta":{}',
      '"delta":{"role":"assistant"}',
    )}\n\n`,
  );

  // Heartbeat every 15s to keep client from timing out while Accio generates
  let aborted = false;
  const heartbeat = setInterval(() => {
    if (aborted || res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    aborted = true;
    clearInterval(heartbeat);
  });

  try {
    const full = await browser.sendMessage(text, {
      stream: true,
      onDelta: (delta) => {
        if (aborted || res.writableEnded) return;
        res.write(
          `data: ${JSON.stringify(openaiChunk(id, model, delta))}\n\n`,
        );
      },
    });

    clearInterval(heartbeat);

    if (!aborted && !res.writableEnded) {
      res.write(
        `data: ${JSON.stringify(openaiChunk(id, model, null, 'stop'))}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    }
    console.log(`[server] stream concluído (${(full || '').length} chars)`);
  } catch (err) {
    clearInterval(heartbeat);
    console.error('[server] stream error:', err.message);
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          error: { message: err.message, type: 'server_error' },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}

// ── GET /health ─────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    active: accounts.getActiveName(),
    browser: browser.getStatus(),
  });
});

// ── GET / ───────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'accio-proxy',
    version: require('../package.json').version,
    endpoints: [
      'POST /v1/chat/completions',
      'GET  /v1/models',
      'GET  /v1/accounts',
      'POST /v1/accounts',
      'GET  /health',
    ],
  });
});

function startServer(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      console.log(`\n🚀 Accio Proxy rodando em http://${host}:${port}`);
      console.log(`   POST /v1/chat/completions`);
      console.log(`   GET  /v1/models`);
      console.log(`   GET  /v1/accounts`);
      console.log(`   POST /v1/accounts  { "name": "..." }`);
      const active = accounts.getActiveName();
      console.log(`   Conta ativa: ${active || '(nenhuma)'}\n`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('[server] fatal:', err);
    process.exit(1);
  });
}

module.exports = { app, startServer };