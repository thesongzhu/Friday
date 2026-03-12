# Task E — Universal Integration Layer (CX81 Design)

> **Goal:** Make Friday able to integrate with ANYTHING — any code, any app, any website, any API.
> This is Friday's core differentiator: "吃进任何东西，吐出可用的按钮"

---

## GAP ANALYSIS

### E1: Code Analyzer Converter
- **Has:** Clean converter abstraction (detect/convert) with registry + service. 4 converters (native, ClawdBot, n8n, OpenAPI). API + CLI paths for detect/convert/import/pack.
- **Missing:** No repo/codebase format. No multi-language scanner. No API/function/CLI extraction from arbitrary code. Archive extraction unused.

### E2: Desktop App Control
- **Has:** exec tool, shell/node skill execution, OS targeting in manifest, permission model.
- **Missing:** No desktop-control tool/service/adapters (AppleScript/COM/xdotool/DBus). No desktop helper in skill runtime context.

### E3: Undocumented API Analyzer
- **Has:** Strong OpenAPI converter. LLM inference stack supports JSON extraction.
- **Missing:** No crawler for docs/examples. No synthesizer to generate OpenAPI from unstructured docs. No `undocumented-api` source format.

### E4: Website-to-Skill Automation
- **Has:** Browser tool with 16 actions + rich act sub-actions. Browser manager with safety/limits.
- **Missing:** No recording model. No replay compiler. No "browser flow → skill package" pipeline. No browser helper in skill runtime.

### E5: Local Program Discovery
- **Has:** Skill directory scanning. Exec tool workspace-constrained.
- **Missing:** No machine-level scanner. No local program catalog. No recommendation engine.

---

## TASK E PLAN

### E1: CODE ANALYZER CONVERTER
**Purpose:** User drops a repo/folder/zip → Friday analyzes → identifies APIs/functions/commands → generates skills automatically.

**New files:**
- `src/skills/converter/converters/friday-code-repo-converter.ts`
- `src/skills/converter/code-repo/friday-code-repo.types.ts`
- `src/skills/converter/code-repo/friday-source-materializer.ts` (handles folder/repo/zip extraction)
- `src/skills/converter/code-repo/friday-language-detector.ts`
- `src/skills/converter/code-repo/friday-capability-extractor.ts` (finds APIs/functions/CLIs)
- `src/skills/converter/code-repo/friday-capability-to-draft-compiler.ts`

**Extend:**
- `friday-skill-converter.types.ts` — add `code-repo` source format
- `friday-skill-converter-service.ts` — format map
- `friday-skill-converter-routes.ts` — accept repo/zip
- `friday-cli.ts` — `--from code-repo`
- `friday-hub-bootstrap.ts` — register converter

**Key types:** `FridayCodeRepoAnalysisInput`, `FridayCodeRepoCapability` (http-endpoint | cli-command | script-task | library-function), `FridayCodeRepoAnalysisResult`, `FridayCapabilityDraftPlan`

**How it works:**
1. Source materializer extracts files from folder/repo/zip
2. Language detector identifies languages/frameworks
3. Capability extractor (LLM-powered) scans for APIs, CLI commands, scripts, functions
4. Draft compiler turns each capability into a FridayConvertedSkillDraft
5. Skills default to `invocation.modes: ["intent","workflow"]`, runtime `node` or `shell`

**Complexity:** ~18-24 files, ~35-45 tests

---

### E2: DESKTOP APP CONTROL
**Purpose:** Control desktop apps without APIs — Photoshop, Excel, etc.

**New files:**
- `src/desktop/model/friday-desktop-control.types.ts`
- `src/desktop/services/friday-desktop-control-service.ts`
- `src/desktop/adapters/friday-desktop-darwin-adapter.ts` (AppleScript/osascript)
- `src/desktop/adapters/friday-desktop-win32-adapter.ts` (COM/PowerShell)
- `src/desktop/adapters/friday-desktop-linux-adapter.ts` (xdotool/DBus)
- `src/agent/tools/friday-agent-desktop-tool.ts`
- `src/desktop/index.ts`

**Extend:**
- Tool registry — register `desktop` tool
- Skill executor types + node executor — inject `ctx.desktop` helper
- Hub bootstrap — wire service

**Key types:** `FridayDesktopActionRequest`, `FridayDesktopActionResult`, `FridayDesktopAdapter`, `FridayDesktopControlService`

**How it works:**
1. Agent calls `desktop` tool directly for ad-hoc operations
2. Generated skills can call `ctx.desktop` for reusable automations
3. Platform adapter handles OS-specific scripting (AppleScript on macOS, PowerShell on Windows, etc.)
4. Desktop automations are normal skills, invokable via workflows

**Complexity:** ~20-28 files, ~45-60 tests

---

### E3: UNDOCUMENTED API ANALYZER
**Purpose:** Given an API without OpenAPI spec, analyze docs/pages/examples → auto-generate spec → feed to existing converter.

**New files:**
- `src/skills/converter/converters/friday-undocumented-api-converter.ts`
- `src/skills/converter/undocumented-api/friday-api-doc-crawler.ts`
- `src/skills/converter/undocumented-api/friday-api-example-parser.ts`
- `src/skills/converter/undocumented-api/friday-openapi-synthesizer.ts` (LLM-powered)
- `src/skills/converter/undocumented-api/friday-openapi-validator.ts`
- `src/skills/converter/undocumented-api/friday-undocumented-api.types.ts`

**Extend:**
- Converter source format/type + route validation + format map + bootstrap registration

**Key types:** `FridayApiDocsSource`, `FridayApiDocsCorpus`, `FridaySynthesizedOpenApi`, `FridayApiSynthesisReport`

**How it works:**
1. Crawler fetches API docs pages / README / examples
2. Parser extracts endpoint signatures, auth patterns, request/response examples
3. Synthesizer (LLM) generates OpenAPI spec from extracted data
4. Validator checks spec quality
5. **Delegates to existing OpenAPI converter** for final skill generation
6. Output is identical to current OpenAPI conversion — existing install/workflow paths unchanged

**Complexity:** ~12-16 files, ~25-35 tests

---

### E4: WEBSITE-TO-SKILL AUTOMATION
**Purpose:** Analyze a website with no API → generate browser automation skill → user can replay.

**New files:**
- `src/browser/automation/friday-browser-flow.types.ts`
- `src/browser/automation/friday-browser-flow-recorder.ts`
- `src/browser/automation/friday-browser-flow-replayer.ts`
- `src/browser/automation/friday-selector-strategy.ts`
- `src/skills/converter/converters/friday-website-automation-converter.ts`
- `src/skills/converter/website-automation/friday-flow-to-skill-compiler.ts`

**Extend:**
- Browser tool — add record/replay actions or flow export hooks
- Browser manager — flow event hooks
- Skill executor — optional `ctx.browser` helper
- Hub bootstrap — wire flow services

**Key types:** `FridayBrowserAutomationFlow`, `FridayBrowserAutomationStep`, `FridayFlowVariable`, `FridayWebsiteAutomationCompileOptions`

**How it works:**
1. User says "automate this website" → browser opens
2. Flow recorder captures every action (click, type, navigate, etc.) as deterministic steps
3. Recorder uses smart selector strategy (aria > data-testid > CSS) for robustness
4. Converter compiles steps into standard skill package (manifest + UI + code)
5. User can replay the skill or include it in workflows
6. Skills installed through normal converter service

**Complexity:** ~16-22 files, ~35-50 tests

---

### E5: LOCAL PROGRAM DISCOVERY
**Purpose:** Scan user's machine → find installed apps/CLIs/services → suggest integrations.

**New files:**
- `src/integrations/discovery/model/friday-local-program.types.ts`
- `src/integrations/discovery/services/friday-local-program-discovery-service.ts`
- `src/integrations/discovery/services/friday-integration-suggestion-service.ts`
- `src/integrations/discovery/adapters/friday-local-program-darwin.ts` (macOS: /Applications, brew, mdfind)
- `src/integrations/discovery/adapters/friday-local-program-win32.ts` (Registry, Program Files, winget)
- `src/integrations/discovery/adapters/friday-local-program-linux.ts` (dpkg, snap, flatpak, PATH)
- `src/integrations/discovery/index.ts`

**Extend:**
- Hub bootstrap — wire service
- API runtime/routes — new discovery endpoints
- Optional CLI command
- Optional scheduler for periodic scans

**Key types:** `FridayLocalProgram`, `FridayLocalProgramScanResult`, `FridayIntegrationSuggestion`, `FridayIntegrationRecommendation`

**How it works:**
1. Scanner discovers installed apps, CLIs, running services per platform
2. Suggestion service maps each program to best integration strategy:
   - Has API docs? → E3 (Undocumented API Analyzer)
   - Has code/repo? → E1 (Code Analyzer)
   - Web-based? → E4 (Website Automation)
   - Desktop app? → E2 (Desktop Control)
3. "Integrate this program" triggers the appropriate converter
4. Result: runnable skills in Friday

**Complexity:** ~14-20 files, ~30-40 tests

---

## EXECUTION ORDER

| Order | Module | Rationale |
|-------|--------|-----------|
| 1 | **E3 Undocumented API Analyzer** | Fastest high-impact win — reuses existing OpenAPI converter end-to-end |
| 2 | **E1 Code Analyzer Converter** | Core foundation for "integrate anything" from repos/scripts/CLIs |
| 3 | **E4 Website-to-Skill Automation** | Leverages mature browser tooling; delivers no-API web integration |
| 4 | **E2 Desktop App Control** | Highest platform complexity; implement after runtime helper patterns proven |
| 5 | **E5 Local Program Discovery** | Most valuable once E1-E4 exist, so recommendations are immediately actionable |

**Total estimated:** ~80-110 new files, ~170-230 tests

---

## DIFFERENTIATION

When all 5 are done, Friday can integrate with:
- ✅ Any service with OpenAPI spec (existing)
- ✅ Any service with docs but no spec (E3)
- ✅ Any codebase/repo/script (E1)
- ✅ Any website without API (E4)
- ✅ Any desktop application (E2)
- ✅ Auto-discover what's available (E5)

**No other product does all of this.** Zapier needs official connectors. n8n needs community nodes. Make/Tray need pre-built integrations. Friday just needs the thing to exist on your machine or the internet.
