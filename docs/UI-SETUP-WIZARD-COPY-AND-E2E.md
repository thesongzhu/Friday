# Setup Wizard: Copy Update + E2E Tests

> Designed by CX (gpt-5.3-codex), 2026-02-19

## 1) COPY UPDATE

### step-welcome.tsx
- title: "Build AI Skills Into Reusable Visual Workflows"
- subtitle: "Create or import skills for any domain, chain them visually, and let Friday self-diagnose compatibility before you run."
- primaryButton: "Start Setup"

### step-security.tsx
- title: "Security Comes First"
- subtitle: "Your keys stay local, encrypted, and under your control."
- description: "Friday only uses providers you approve, and you can change access at any time."

### step-provider.tsx
- title: "Choose Your AI Provider"
- subtitle: "This powers skill generation, workflow automation, and Friday's self-diagnosis checks."
- description: "Use Ollama for free local models, or connect a cloud provider for additional models."
- helperText: "Friday uses this provider to create skills, run tasks, and validate end-to-end workflow usability."

### step-network.tsx
- title: "Choose Access Mode"
- subtitle: "Run locally, or enable network access to use Friday from phone, tablet, or another computer on your Wi-Fi."
- note: "You can switch modes any time in Settings."

### step-channels.tsx
- title: "Connect Your Channels"
- subtitle: "Connect messaging platforms so Friday can work where you already are."
- description: "Run workflows, receive results, and trigger actions directly inside your existing chat tools."

### step-skills.tsx
- title: "Create Skills for Any Domain"
- subtitle: "Import from OpenClaw, n8n, or GPT Actions, or describe what you need and let Friday generate it for you."
- description: "Convert tools into Friday skills, chain them into visual workflows, save once, and reuse with one click."
- supportingText: "Beginner-friendly by design: no deep technical setup required."

### step-done.tsx
- title: "Friday Is Ready"
- subtitle: "You can now create skills, build visual workflows, and let Friday diagnose issues before they break real runs."
- description: "Start by creating a skill, publishing a workflow, and running your first one-click automation."
- primaryButton: "Open Friday"

## 2) E2E TESTS

### File: test/e2e/setup-wizard.e2e.test.ts

### A. Setup Wizard API Tests (no LLM needed)

1. A1: fresh setup status should require setup
2. A2: detect ollama with explicit kind should return models payload
3. A3: detect provider with fake OpenAI key should return 401
4. A4: detect provider with fake Anthropic key should return 401
5. A5: get network config should return defaults
6. A6: set network mode to network should return LAN URLs
7. A7: set network mode back to local should switch config
8. A8: save channels config should persist
9. A9: save channels with invalid kind should be rejected
10. A10: complete setup with valid steps should mark setup complete
11. A11: complete setup with invalid step ID should be rejected
12. A12: setup status after completion should not require setup
13. A13: full wizard API flow should pass end-to-end

### B. Provider Detection + Model Fetch (needs Ollama)

14. B14: ollama detect should return real installed local models
15. B15: explicit kind should override key-pattern inference
16. B16: openai-compatible detect should require baseUrl

### C. Real Scenario Tests (needs Ollama + LLM)

17. C17: full E2E setup → create ollama provider → run agent task
18. C18: import OpenClaw SKILL.md → install → execute
19. C19: create 2-node workflow → publish → trigger
20. C20: self-diagnosis should detect incompatible workflow nodes

### Environment Flags
- `E2E_OLLAMA=1` gates tests B14, B15
- `E2E_REAL=1` gates tests C17-C20
- Default CI runs only category A (13 tests, no external deps)
