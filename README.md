# Accio Proxy

Proxy de API compatível com OpenAI para o chat [Accio](https://www.accio.com/).

Ele abre o Chrome (Windows, via WSL) com um profile persistente por conta, digita no chat do Accio, espera a resposta e devolve no formato OpenAI — com **streaming SSE** token a token.

## Requisitos

- WSL2 (Ubuntu ou similar)
- Node.js ≥ 18
- Google Chrome instalado no Windows  
  (`C:\Program Files\Google\Chrome\Application\chrome.exe`)
- Node.js no Windows (só se o modo CDP relay for necessário)  
  (`C:\Program Files\nodejs\node.exe`)

## Instalação

```bash
cd "/home/aldair/accio proxy"
npm install
```

> Não é necessário `npx playwright install` — usamos o Chrome do Windows.

## Uso rápido (CLI)

```bash
cd "/home/aldair/accio proxy"
npm run cli
# ou: node src/cli.js
```

Menu:

```
Accio Proxy
1) Entrar na conta (login no Chrome)
2) Trocar conta ativa
3) Listar contas
4) Remover conta
5) Iniciar servidor API
6) Sair
```

### 1. Entrar na conta

1. Escolha a opção **1** e digite um nome (ex: `pessoal`).
2. O Chrome abre em `https://www.accio.com/`.
3. Faça o login manualmente no navegador.
4. Volte ao terminal e pressione Enter.

O profile fica salvo em:

- Windows: `C:\temp\accio-profiles\<nome>`
- WSL (espelho): `/home/aldair/accio proxy/.profiles/<nome>`

Na próxima vez a sessão de login já estará ativa.

### 2. Iniciar o servidor API

Opção **5** no menu, ou:

```bash
npm start
# ou: node src/server.js
```

Servidor em `http://127.0.0.1:3000`.

## API (compatível OpenAI)

### `POST /v1/chat/completions`

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "accio",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Olá! Resuma o que você é em uma frase."}
    ]
  }'
```

- `stream: true` → SSE no estilo OpenAI (`data: {...}` + `data: [DONE]`)
- `stream: false` → JSON único `chat.completion`

### `GET /v1/models`

```json
{
  "object": "list",
  "data": [{ "id": "accio", "object": "model", "owned_by": "accio-proxy" }]
}
```

### `GET /v1/accounts`

Lista contas e a conta ativa.

### `POST /v1/accounts`

```bash
# Trocar conta ativa
curl -X POST http://127.0.0.1:3000/v1/accounts \
  -H "Content-Type: application/json" \
  -d '{"name":"pessoal"}'

# Criar conta
curl -X POST http://127.0.0.1:3000/v1/accounts \
  -H "Content-Type: application/json" \
  -d '{"name":"trabalho","action":"add"}'
```

### `GET /health`

Status do browser e conta ativa.

## Integração com clientes OpenAI

Aponte qualquer cliente OpenAI-compatible para:

```
base_url = http://127.0.0.1:3000/v1
api_key  = qualquer-coisa   # não é validada
model    = accio
```

Exemplo Python:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:3000/v1", api_key="x")
stream = client.chat.completions.create(
    model="accio",
    messages=[{"role": "user", "content": "Oi"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

## Como funciona

1. **Browser (Playwright)**  
   - Tenta `launchPersistentContext` com o Chrome do Windows (`executablePath`).  
   - Se falhar, usa o **CDP relay**: Chrome sobe com `--remote-debugging-port=9333`, um `cdp-relay.js` no Node do Windows escuta em `0.0.0.0:9334` e o WSL conecta no IP do host (`172.x.x.1:9334`).

2. **Envio da mensagem**  
   - Insere texto em `.chat-input-scrollable` (textContent + `InputEvent`).  
   - Aguarda 500 ms e tenta clicar no botão enviar até 10 vezes (re-dispara o input a cada tentativa — corrige o bug da “primeira mensagem”).

3. **Streaming**  
   - Faz poll do DOM a cada 200 ms nos seletores de mensagem do assistente.  
   - Emite deltas SSE.  
   - Detecta fim via `maybeNotifyTaskComplete` + `kind=success` no console (hook na página + `page.on("console")`).  
   - Timeout máximo: 180 s.

## Estrutura

```
accio proxy/
  package.json
  upgrade.sh
  accounts.json          # criado na 1ª execução
  cdp-relay.js           # relay TCP (Windows)
  src/
    cli.js               # menu interativo
    server.js            # Express API
    browser.js           # Playwright + envio/streaming
    accounts.js          # CRUD de contas
    relay.js             # bootstrap CDP / Chrome Windows
    inject.js            # snippets injetados no Accio
```

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT` / `ACCIO_PORT` | `3000` | Porta do servidor |
| `HOST` | `127.0.0.1` | Bind do servidor |
| `ACCIO_HEADLESS` | (off) | `1` = Chrome headless no servidor |
| `ACCIO_TIMEOUT_S` | `180` | Timeout por mensagem |
| `ACCIO_CDP_HOST` | gateway WSL | IP do host Windows |
| `ACCIO_CDP_PORT` | `9333` | Porta CDP do Chrome |
| `ACCIO_RELAY_PORT` | `9334` | Porta do relay |
| `ACCIO_URL` | `https://www.accio.com/` | URL inicial |

## Upgrade

```bash
npm run upgrade
# ou: bash upgrade.sh
```

Faz `git pull` (se for repo git) + `npm install` e mostra a versão antiga/nova.

## Scripts legados (referência)

Os arquivos na raiz (`accio_cli.py`, `insert-chat-text.js`, etc.) são o protótipo Python/JS. A implementação oficial é o projeto Node em `src/`.

## Licença

MIT
