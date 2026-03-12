# Extending Friday: Skills, Plugins, and Workflows

This guide defines directory conventions, templates, and a minimal contributor flow.

## 1) Recommended Directory Layout

Use this structure in your repo/workspace:

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

## 2) Naming Conventions

- Skill directory: kebab-case (`hello-skill`)
- Skill ID: stable, lowercase, no spaces (`hello-skill` or team prefix)
- Plugin ID: reverse-domain style (`com.example.channel.demo`)
- Workflow slug: lowercase + hyphen (`daily-sync`)

## 3) Templates You Can Copy

Available templates in this repository:

- `examples/templates/skills/hello-skill/`
- `examples/templates/plugins/sample-channel-plugin/`
- `examples/templates/workflows/minimal-template.workflow.json`

Copy and customize:

```bash
cp -R examples/templates/skills/hello-skill skills/my-skill
cp -R examples/templates/plugins/sample-channel-plugin plugins/com.example.channel.demo
cp examples/templates/workflows/minimal-template.workflow.json workflows/my-flow.workflow.json
```

## 4) Minimal Local Dev Loop

```bash
npm run build
friday start --skills-dir skills --port 3141
```

In another terminal:

```bash
friday list --skills-dir skills
friday run <skill-id> --input key=value --skills-dir skills
```

For workflow extension validation, you can use the one-command local run:

```bash
npm run demo
```

## 5) Plugin Manifest Baseline

A plugin must include:

- `schemaVersion: "1.0"`
- valid `id`, `version`, `name`, `description`
- `kinds` and matching `entrypoints`
- `permissions` (`grants` + `promptOn`)
- `compatibility` (`minHubVersion`, `apiVersion`)

Reference implementation in this repo:

- `src/plugins/manifest/friday-plugin-manifest.schema.ts`

## 6) Contribution Rules for Extensibility Changes

When adding or changing extension points:

1. Keep manifest compatibility explicit (no silent behavior changes).
2. Add or update tests in related `test/unit/*` suites.
3. Update docs and templates in the same PR.
4. Run local quality gates before opening PR:

```bash
npm run typecheck
npm run lint
npm run build
npm test
```
