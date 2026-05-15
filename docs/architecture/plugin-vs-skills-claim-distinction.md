# Plugin distribution vs. skills lifecycle vs. commerce vs. public assets

Phase 11 Module 17 closure artifact. This file is the canonical claim
distinction for user-facing copy, release notes, README excerpts, marketing
material, and any docs that touch `/v1/plugins*`, `/v1/skills*`, `packs`,
or "marketplace"-shaped language.

The goal is to keep four product concepts from blurring into one paragraph
once docs are auto-generated, summarised, or pulled into release notes.

## Four concepts — what they are and are not

| Concept | Route family | Persistence | User-visible surface | Approval semantics | Distribution semantics |
| --- | --- | --- | --- | --- | --- |
| **Plugin distribution** | `/v1/plugins*` | SQLite (`plugins`, `plugin_versions`, `plugin_dependencies`, v008 migration) | Operator/admin plugin tab (`/plugins` UI when surfaced), `plugins.install` / `plugins.versions.list` API | Bounded install with manifest validation, signature verify, dependency resolve; mutating actions sit inside the plugin upgrade lifecycle (`shadow → canary → promote / rollback`) | Active and test-backed (19+ tests). **Not** a public commerce surface. **Not** the same as skills lifecycle. |
| **Skills lifecycle** | `/v1/skills*` | SQLite skills tables | `/skills` operator UI, `/assistant` for generation, generator-to-candidate handoff | Canonical mutating-action gate on update/delete; doctor verify required; rollback pointer mandatory | Active product loop with end-to-end install → verify → first run → rollback. **Not** a plugin install path. **Not** a public commerce surface. |
| **Public commerce / marketplace** | (none) | (none) | (none) | (none — retired) | **Not implemented.** Old marketplace code was removed (F-001). Friday does not have a paid/public commerce story today. |
| **Public assets / packs** | `/v1/packs*` (operator pack surface) | SQLite pack repository | `/packs` operator UI for cross-border configuration packs | Manual import + approval flow | Operator-shared configuration bundles, not signed, not a commerce listing. **Not** a plugin and **not** a skill. |

## Why this matters

Friday already ships real plugin lifecycle code (canary, promote, rollback,
shadow versions). It is tempting to compress copy and say "plugins are how
you install third-party features in Friday." That compressed sentence
silently re-conflates three different boundaries:

1. **Skill lifecycle** owns generation-to-runtime for first-party skills,
   including the agent-side generator handoff. Skills are agent-callable,
   and their approval gate is the canonical mutating-action gate.
2. **Plugin distribution** ships **bounded** extensions (channels, skills,
   workflow nodes packaged as plugin units). Plugins are loaded by the hub,
   not by the agent at run-time. The approval gate is the upgrade lifecycle
   (shadow → canary → promote), not the canonical mutating-action gate.
3. **Public commerce** does not exist. Any marketing or copy that suggests
   "browse Friday plugins" or "purchase add-ons" is overclaim.

If the four concepts ever start to blur, fall back to this table.

## Concrete copy guidance

### Acceptable phrasings

- "Friday loads plugins from a local, operator-controlled trust store."
- "Skill lifecycle covers install, update, verify, and rollback for first-party skills."
- "Packs are operator-shared configuration bundles."
- "Plugin distribution is active and test-backed. There is no public marketplace."

### Phrasings that must not appear in user-facing copy

- "Browse the Friday plugin marketplace" — implies commerce.
- "Install plugins from the Friday store" — implies a public store.
- "Skills and plugins share the same install flow" — they don't.
- "Public assets are commerce-grade" — they aren't.

## API/route truth (HEAD-relative)

- `/v1/plugins*` is **plugin distribution**, persisted in SQLite via v008.
  Manifest validation in `src/plugins/manifest/friday-plugin-manifest.schema.ts`.
  Lifecycle in `src/autonomy/services/friday-plugin-upgrade-lifecycle-service.ts`.
- `/v1/skills*` is **skills lifecycle**, persisted via the skill lifecycle
  service. Generator-to-candidate bridge in `src/skills/converter/`.
- `/v1/packages*` is **agent packaging distribution** (Phase 11 Module 16);
  it is a **separate surface** from `/v1/plugins*` and **not** a marketplace.
- `/v1/packs*` is **operator pack distribution** (configuration bundles).

## Approval boundaries

- Plugin distribution mutating routes route through the plugin upgrade
  lifecycle service. Promote/rollback emit canary stats + plan digest
  evidence per `FridayPluginLifecycleEvidenceSummary`.
- Skill lifecycle mutating routes route through the canonical mutating
  action gate. Install/update/delete require gate approval.
- Packaging mutating routes route through `FridayPackagingRoutesDeps` and
  use real manifest parsing + signature verification (Phase 11 Module 16).

## What changes if/when commerce is added

Adding a public commerce or marketplace story is a separate, governance-
scoped change. It must:

- Define new routes (do not reuse `/v1/plugins*` or `/v1/skills*`).
- Define a separate manifest/contract for listings.
- Define a separate trust/payment story.
- Update this file, `docs/current-source-of-truth.md`, and add a new
  RGG scenario family before any user-facing copy.

Until that change lands, no copy may imply commerce.

## Cross-references

- `docs/current-source-of-truth.md` §Plugin Distribution (lines 149-157)
- `src/plugins/services/friday-plugin-service.ts`
- `src/autonomy/services/friday-plugin-upgrade-lifecycle-service.ts`
- `src/state/sqlite/migrations/v008-plugin-system-foundation.ts`
- `test/e2e/plugins/friday-plugin-local-lifecycle.test.ts`
