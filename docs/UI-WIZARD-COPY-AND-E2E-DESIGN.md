# Setup Wizard Copy Update + E2E Test Design
> CX (gpt-5.3-codex) design output — 2026-02-19

## 1) COPY UPDATE

### `ui/src/components/setup/step-welcome.tsx`
- `title`: `"Build AI Skills Into Reusable Visual Workflows"`
- `subtitle`: `"Create or import skills for any domain, chain them visually, and let Friday self-diagnose compatibility before you run."`
- `primaryButton`: `"Start Setup"`

### `ui/src/components/setup/step-security.tsx`
- `title`: `"Security Comes First"`
- `subtitle`: `"Your keys stay local, encrypted, and under your control."`
- `description`: `"Friday only uses providers you approve, and you can change access at any time."`
- `primaryButton`: `"Continue"`

### `ui/src/components/setup/step-provider.tsx`
- `title`: `"Choose Your AI Provider"`
- `subtitle`: `"This powers skill generation, workflow automation, and Friday's self-diagnosis checks."`
- `description`: `"Use Ollama for free local models, or connect a cloud provider for additional models."`
- `helperText`: `"Friday uses this provider to create skills, run tasks, and validate end-to-end workflow usability."`
- `primaryButton`: `"Save Provider"`
- `secondaryButton`: `"Skip for Now"`

### `ui/src/components/setup/step-network.tsx`
- `title`: `"Choose Access Mode"`
- `subtitle`: `"Run locally, or enable network access to use Friday from phone, tablet, or another computer on your Wi-Fi."`
- `localOptionTitle`: `"Local Only"`
- `localOptionDescription`: `"Only this device can access Friday."`
- `networkOptionTitle`: `"Local Network"`
- `networkOptionDescription`: `"Devices on the same network can access Friday."`
- `note`: `"You can switch modes any time in Settings."`
- `primaryButton`: `"Save Network Mode"`

### `ui/src/components/setup/step-channels.tsx`
- `title`: `"Connect Your Channels"`
- `subtitle`: `"Connect messaging platforms so Friday can work where you already are."`
- `description`: `"Run workflows, receive results, and trigger actions directly inside your existing chat tools."`
- `primaryButton`: `"Save Channels"`
- `secondaryButton`: `"Skip for Now"`

### `ui/src/components/setup/step-skills.tsx`
- `title`: `"Create Skills for Any Domain"`
- `subtitle`: `"Import from OpenClaw, n8n, or GPT Actions, or describe what you need and let Friday generate it for you."`
- `description`: `"Convert tools into Friday skills, chain them into visual workflows, save once, and reuse with one click."`
- `supportingText`: `"Beginner-friendly by design: no deep technical setup required."`
- `primaryButton`: `"Create My First Skill"`
- `secondaryButton`: `"Import Existing Skills"`

### `ui/src/components/setup/step-done.tsx`
- `title`: `"Friday Is Ready"`
- `subtitle`: `"You can now create skills, build visual workflows, and let Friday diagnose issues before they break real runs."`
- `description`: `"Start by creating a skill, publishing a workflow, and running your first one-click automation."`
- `primaryButton`: `"Open Friday"`
- `secondaryButton`: `"Build First Workflow"`

---

## 2) E2E TEST (`test/e2e/setup-wizard.e2e.test.ts`)

### Structure
```ts
import { beforeAll, describe, expect, it } from "vitest";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3141";
const itNetwork = process.env.E2E_NETWORK === "1" ? it : it.skip;
const itOllama = process.env.E2E_OLLAMA === "1" ? it : it.skip;
const itReal = process.env.E2E_REAL === "1" ? it : it.skip;

// Auth helper: POST /v1/auth/login { local: true } -> Bearer token
// Fetch helper: fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } ... })
```

### A. Setup Wizard API tests (tag: api-no-llm)

1. **A1: fresh setup status should require setup**
   - `GET /v1/setup/status` → `needsSetup === true`

2. **A2: detect ollama with explicit kind should return models payload**
   - `POST /v1/providers/detect` `{ kind: "ollama" }` → `200`, models array

3. **A3: detect provider with fake OpenAI key should return 401**
   - `POST /v1/providers/detect` `{ apiKey: "sk-test-invalid" }` → `401`

4. **A4: detect provider with fake Anthropic key should return 401**
   - `POST /v1/providers/detect` `{ apiKey: "sk-ant-test-invalid" }` → `401`

5. **A5: get network config should return defaults**
   - `GET /v1/setup/network` → `200`, default fields present

6. **A6: set network mode to network should return LAN URLs**
   - `POST /v1/setup/network` `{ mode: "network" }` → `200`, `lanUrls` exists

7. **A7: set network mode back to local should switch config**
   - `POST /v1/setup/network` `{ mode: "local" }` → `200`, mode is local

8. **A8: save channels config should persist**
   - `POST /v1/setup/channels` with valid payload → `200`

9. **A9: save channels with invalid kind should be rejected**
   - `POST /v1/setup/channels` `{ kind: "invalid-kind" }` → `400/422`

10. **A10: complete setup with valid steps should mark setup complete**
    - `POST /v1/setup/complete` → `200`, completion flag true

11. **A11: complete setup with invalid step ID should be rejected**
    - `POST /v1/setup/complete` with invalid step → `400`

12. **A12: setup status after completion should not require setup**
    - `GET /v1/setup/status` → `needsSetup === false`

13. **A13: full wizard API flow should pass end-to-end**
    - status → detect → network → channels → complete → status

### B. Provider detection + model fetch (tag: network-no-llm)

14. **B14: ollama detect should return real installed local models**
    - Gate: `itOllama` → models.length > 0

15. **B15: explicit kind should override key-pattern inference**
    - Gate: `itOllama` → kind ollama even with mismatched key

16. **B16: openai-compatible detect should require baseUrl**
    - `POST /v1/providers/detect` `{ kind: "openai-compatible" }` → `400/422`

### C. Real scenario tests (tag: real-llm, use Ollama)

17. **C17: full E2E setup → create ollama provider → run agent task**
    - Gate: `itReal` + `itOllama` → output contains `FRIDAY_E2E_OK`

18. **C18: import OpenClaw SKILL.md → install → execute**
    - Gate: `itReal` + `itOllama` → skill in list, execution success

19. **C19: create 2-node workflow → publish → trigger**
    - Gate: `itReal` + `itOllama` → both nodes succeed, output returned

20. **C20: self-diagnosis should detect incompatible workflow nodes**
    - Gate: `itReal` + `itOllama` → diagnostics reports incompatibility

### Implementation Notes for CC
- Reuse server bootstrap/auth helpers from `crud-*.e2e.test.ts`
- Reuse real-run helpers from `real-scenarios-*.e2e.test.ts`
- Keep A/B/C in separate `describe` blocks
- Gate B/C by env flags so default CI runs A without Ollama
