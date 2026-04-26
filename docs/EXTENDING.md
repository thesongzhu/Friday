# Extending Friday

Friday can be extended with skills, workflows, providers, channels, MCP servers, and setup recipes. Extension work should make Friday more capable without making it less inspectable or less safe.

## Extension Principles

1. A new capability is not available until it is verified.
2. Permissions must be explicit and understandable.
3. Untrusted code must pass review, sandbox checks, and policy gates.
4. Setup must explain missing credentials, accounts, or permissions.
5. Failures must leave evidence and a recovery path.
6. High-risk actions must stop for approval.

## Directory Layout

Recommended workspace structure:

```text
.
├─ skills/
│  └─ <skill-id>/
│     ├─ skill.manifest.json
│     └─ run.sh | index.js | main.py
├─ plugins/
│  └─ <plugin-id>/
│     ├─ friday.plugin.json
│     └─ index.js
├─ workflows/
│  └─ *.workflow.json
└─ examples/templates/
   ├─ skills/hello-skill/
   ├─ plugins/sample-channel-plugin/
   └─ workflows/
```

## Skills

Skills are reusable execution capabilities. A skill should include:

- stable ID and version
- clear description
- structured inputs and outputs
- runtime requirements
- permission declaration
- dry-run or test path
- docs or examples
- trust and review guidance

Skill IDs should be stable, lowercase, and kebab-case.

## Workflows

Workflows connect capabilities into repeatable multi-step tasks. A workflow should define:

- trigger
- inputs
- steps
- approvals
- retries
- verification
- failure behavior
- evidence output

Production-impacting workflow steps should include rollback or a clear operator handoff.

## Providers

Provider integrations must support setup truth:

- provider kind
- supported capabilities
- auth mode
- credential shape
- base URL
- default and supported models
- doctor verification
- representative task
- failure classification

Do not mark a provider lane healthy because a form field exists. Health must come from route checks or representative tasks.

## Channels

Channel integrations can let users talk to and control Friday from outside the web UI.

Channel extensions should define:

- inbound message shape
- outbound delivery
- credential storage
- allowlist or identity model
- wake/control semantics
- audit behavior
- confirmation path for high-risk actions

Channels may control Friday, but they must not bypass the same approval gates used in the web UI.

## MCP Servers

MCP server integration should expose:

- server name
- connection state
- authenticated state
- tools/resources available
- required credentials or setup blockers
- risk class for tools
- verification result

If an MCP requirement is not connected or authenticated, Friday should fail closed with a structured blocker.

## Capability Acquisition

Generated or discovered capability should follow:

```text
candidate -> plan -> sandbox/test -> approval if required -> install/register -> doctor verify -> available
```

Trusted installed sources should rank above open internet sources. Open internet discovery can be useful, but installation and execution remain governed by policy, sandboxing, budget, and approval.

## Local Dev Loop

```bash
npm run build
friday start --skills-dir skills --port 3141
```

In another terminal:

```bash
friday list --skills-dir skills
friday run <skill-id> --input key=value --skills-dir skills
```

Quality gates:

```bash
npm run typecheck
npm run lint
npm run build
npm test
```

Security-sensitive extensions should also run:

```bash
npm run check:security-doctor
npm run check:audit-integrity
```

## Documentation Requirement

Any extension that changes setup, capabilities, provider behavior, channel behavior, permissions, or user-facing errors must update relevant docs:

- [Getting Started](getting-started.md)
- [Capability Matrix](ops/friday-capability-matrix.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Security](../.github/SECURITY.md)
