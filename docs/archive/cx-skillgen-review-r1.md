> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Skill Generator Review R1 — NOT APPROVED

## 8 Findings

### 1. openai-responses implemented as chat-completions
Files: `src/skills/generator/llm/friday-provider-inference-client.ts:31,84,134`
The `openai-responses` API format is different from chat-completions. Currently both use the same code path.

### 2. Missing package validation + temp staging
Files: `src/skills/generator/services/friday-skill-generator-service.ts:197,644`
Design requires: validate in temp dir first (Stage C: validateFridaySkillPackage), then move to final dir on approval. Currently writes directly to final skill directory.

### 3. Drafts only in memory, not persisted
Files: `src/skills/generator/services/friday-skill-generator-service.ts:65,547,622`
Drafts stored in module-level Map, lost on restart. Must persist to memory_items.

### 4. Safety checks trust model-supplied file.language
Files: `src/skills/generator/validation/friday-generated-skill-safety-validator.ts:129,148`
Dangerous content can evade checks by mislabeling language. Must detect language from file extension/content, not trust model.

### 5. Shell safety is blacklist-only, no allowlist
Files: `src/skills/generator/validation/friday-generated-skill-safety-validator.ts:89,43`
Design requires: strict shebang enforcement, command allowlist policy, entrypoint file must exist.

### 6. Model output not schema-validated before use
Files: `src/skills/generator/services/friday-skill-generator-service.ts:167,179`
Malformed model output throws during validation instead of triggering structured repair.

### 7. Shell files not marked executable
Files: `src/skills/generator/services/friday-skill-generator-service.ts:667`
`executable: true` metadata exists but chmod is never called. Shell executor expects executable entrypoint.

### 8. Node AI helper only handles 2 provider formats
Files: `src/skills/executor/friday-skill-executor.ts:244,252`
Only anthropic + chat-completions handled. Missing google, ollama, openai-responses.
