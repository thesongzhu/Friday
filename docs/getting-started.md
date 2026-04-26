# Getting Started With Friday

This guide gets Friday running locally, completes setup, and explains what to do when a capability is missing.

Friday is local-first and BYOK. You can start it without every provider configured, but real tasks that need models, search, OCR, TTS, channels, or third-party accounts require valid credentials and verification.

## Prerequisites

- Node.js 22+
- npm 10+
- Git
- A modern browser
- Optional: model/search provider keys, such as OpenAI, Doubao/Volcengine, Tavily, Serper, or other supported providers

Check your local runtime:

```bash
node --version
npm --version
```

## Install And Start

### Option A - npm package

```bash
npm install -g @thesongzhu/friday
friday start
```

Open:

```text
http://localhost:3141
```

### Option B - source checkout

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday
npm install
npm run build
npm start
```

Open:

```text
http://localhost:3141
```

### Option C - Docker from source

```bash
docker compose -f docker/docker-compose.yml up --build
```

Open:

```text
http://localhost:3141
```

## First-Run Setup

Setup should guide you through:

1. **Local session:** Friday establishes a local browser session for this machine.
2. **Provider:** choose or auto-detect a model provider, enter credentials, and verify the lane.
3. **Capabilities:** review text, vision, OCR, embedding, web search, PDF, browser, files, skills, workflows, memory, TTS, and channel support.
4. **Channels:** connect optional chat/control channels such as Discord, Telegram, Feishu/Lark, Signal, WhatsApp, QQ, or webhooks.
5. **Home:** after setup completes, opening Friday should go directly to Home.

If setup cannot verify a capability, it should say what is missing, where to configure it, and how to test it after configuration.

## Provider Keys

Friday does not include model or paid search credentials. Bring your own keys.

Common setup paths:

| Need | Typical provider path | What Friday should show if missing |
| --- | --- | --- |
| Text model | OpenAI, Doubao/Volcengine, Moonshot, Anthropic, Google, OpenRouter | missing provider key or invalid route |
| Vision / multimodal | provider with image input support | missing vision-capable model or API key |
| OCR | provider OCR API or installed OCR skill | missing OCR provider, account, or skill |
| Web search | Tavily, Serper, or custom search skill | missing search key or disabled provider |
| Embedding / memory search | embedding-capable provider or local embedding lane | missing embedding provider |
| TTS | provider TTS lane or local speech skill | missing TTS provider |

Missing external accounts, OAuth, payment, CAPTCHA, API keys, and sensitive permissions are human blockers. Friday should not mark those tasks as complete until real verification passes.

## Your First Goal

After setup, try a small task that exercises the closure loop:

```text
Summarize what capabilities are configured, list what is missing, and tell me the next setup step.
```

Friday should answer with:

- available capabilities
- missing capabilities
- exact human blockers
- configuration path
- verification step

## Auto-Start On macOS

To keep Friday available after login:

```bash
bash scripts/ops/install-friday-launchagent.sh
```

Check status:

```bash
bash scripts/ops/friday-launchagent-status.sh
```

See [macOS Auto-Start](ops/friday-autostart-macos.md) for logs, uninstall steps, and channel wake behavior.

## Development Workflow

From source:

```bash
npm run typecheck
npm run lint
npm run build
npm test
```

Useful targeted checks:

```bash
npm run ops:doctor:runtime
npm run check:security-doctor
npm run check:audit-integrity
npm run check:provider-reliability
```

## Skills And Workflows

Friday can turn repeated work into reusable skills and workflows, but executable capability must stay reviewable.

Common commands:

```bash
friday list
friday import ./my-skill.friday.tgz
friday import ./path/to/SKILL.md
friday import https://github.com/example/skill-repo.git
```

Every generated or imported capability should move through:

```text
candidate -> plan -> sandbox/test -> approval if required -> install/register -> doctor verify -> available
```

See [Extending Friday](EXTENDING.md) for authoring guidance.

## API Health Check

```bash
curl http://localhost:3141/v1/health
```

Expected shape:

```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "version": "1.0.0"
  }
}
```

## Troubleshooting

Use [Troubleshooting](TROUBLESHOOTING.md) when:

- Friday opens a recovery/auth page instead of Home.
- setup status is unavailable.
- a provider shows the wrong name or route.
- a capability says it is available but the representative task fails.
- a channel receives messages but cannot control Friday.
- a generated skill installs but cannot pass verification.

For security-sensitive problems, follow [SECURITY.md](../.github/SECURITY.md).
