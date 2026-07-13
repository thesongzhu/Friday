# Getting Started With Friday

This guide gets Friday running locally, completes setup, and explains what to do when a capability is missing.

Friday is local-first and BYOK. You can start it without every provider configured, but real tasks that need models, search, OCR, TTS, optional channels, or third-party accounts require valid credentials and verification.

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

> **npm is a developer / build / tooling surface, not a consumer install path.**
> The npm package is a developer/build/tooling surface for running Friday from
> source, in CI, and for internal tooling; it is not a consumer install path.
> `npm install` does **not** install the full Friday product: it does not ship a
> signed/notarized native macOS app, the managed native-app Hub lifecycle,
> native mobile apps, formal auto-updates, or Endbar release guarantees.
> The native Friday.app is the consumer release vehicle, and it is
> not yet publicly released — so there is no "download the official app" step
> yet. Until then, developers and maintainers run Friday from source (below).

### Option A - source checkout (developer path)

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

### Option B - Docker from source (developer path)

```bash
docker compose -f docker/docker-compose.yml up --build
```

Open:

```text
http://localhost:3141
```

### Option C - npm package (developer / tooling only, not a consumer install)

The published `@thesongzhu/friday` npm package is a developer/tooling runtime.
Installing it globally gives you the `friday` CLI for local development, CI, and
internal tooling — **not** the consumer Friday product.

```bash
npm install -g @thesongzhu/friday
friday start
```

Open:

```text
http://localhost:3141
```

**What the npm package can do today:** run a local hub for development via
`friday start` / `friday daemon`, exercise skills (`friday list`, `friday run`),
and drive the source build/test pipeline (`npm run build`, `npm test`,
`npm run lint`, `npm run typecheck`) from a source checkout — aimed at
developers, maintainers, and CI.

**What it cannot do:** it is not a signed/notarized native app, provides no
managed native-app Hub lifecycle, no native mobile apps, no formal
auto-updates, and no Endbar release guarantee. For the consumer experience,
wait for the native Friday.app release.

## First-Run Setup

Setup should guide you through:

1. **Local session:** Friday establishes a local browser session for this machine.
2. **Provider:** choose or auto-detect a model provider, enter credentials, and verify the lane.
3. **Capabilities:** review text, vision, OCR, embedding, web search, PDF, browser, files, skills, workflows, memory, TTS, and optional channel support.
4. **Channels:** connect optional chat/control channels such as Discord, Telegram, Feishu/Lark, Signal, WhatsApp, or webhooks only when you want that surface and can verify it. QQ and Slack HTTP Events-API inbound are explicitly unsupported in the public `1.0.x` local-candidate line.
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

`npm run typecheck` covers source, operator-client, UI, and type-level contracts. It does not replace the normal `.test.ts` Vitest suite; use `npm test` for that.

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
    "version": "1.0.2"
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
