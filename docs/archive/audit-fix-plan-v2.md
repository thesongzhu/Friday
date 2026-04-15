> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

**Batch A — HIGH fixes (1-4)**

1. **Shell injection in archiver**
File refs: `src/skills/converter/services/friday-skill-package-archive.ts:48`, `src/skills/converter/services/friday-skill-package-archive.ts:72`  
What’s wrong: `execSync()` executes a shell command string; user-controlled paths can still become shell-injection risk.  
Fix: replace both calls with `execFileSync("tar", [...args])` (no shell), pass each arg separately, preserve `stdio: "pipe"`.  
Files to change: `src/skills/converter/services/friday-skill-package-archive.ts`

2. **Path traversal / arbitrary write (12 locations)**
File refs:  
`src/skills/converter/services/friday-skill-import-installer.ts:142`, `src/skills/converter/services/friday-skill-import-installer.ts:145`, `src/skills/converter/services/friday-skill-import-installer.ts:188`, `src/skills/converter/services/friday-skill-import-installer.ts:196`  
`src/skills/converter/services/friday-skill-converter-service.ts:261`, `src/skills/converter/services/friday-skill-converter-service.ts:264`  
`src/skills/generator/services/friday-skill-generator-service.ts:779`, `src/skills/generator/services/friday-skill-generator-service.ts:780`, `src/skills/generator/services/friday-skill-generator-service.ts:832`, `src/skills/generator/services/friday-skill-generator-service.ts:834`  
`src/cli/friday-cli.ts:453`, `src/cli/friday-cli.ts:456`  
What’s wrong: untrusted relative paths are joined and written directly; `../` or absolute paths can escape intended base dirs.  
Fix: add a shared helper (`resolve(base, rel)` + boundary check) and enforce:
- reject absolute paths and traversal (`..`)
- resolve final path
- verify resolved path starts with resolved base dir
- use validated path for mkdir/write/chmod  
Files to change:
- `src/skills/converter/services/friday-skill-import-installer.ts`
- `src/skills/converter/services/friday-skill-converter-service.ts`
- `src/skills/generator/services/friday-skill-generator-service.ts`
- `src/cli/friday-cli.ts`
- plus shared helper file (new), e.g. `src/skills/converter/services/friday-path-safety.ts` or `src/utilities/friday-path-safety.ts`

3. **Hub bootstrap TODO stubs**
File refs: `src/hub/friday-hub-bootstrap.ts:211`, `src/hub/friday-hub-bootstrap.ts:212`, `src/hub/friday-hub-bootstrap.ts:213`, `src/hub/friday-hub-bootstrap.ts:214`  
What’s wrong: runtime TODOs are in production bootstrap path with no explicit product decision.  
Fix: for v1, remove TODOs and replace with explicit non-goal comment block (why not wired, what triggers enabling), or wire actual runtime constructors if dependencies are ready.  
Files to change: `src/hub/friday-hub-bootstrap.ts` (optionally `docs/` if decision is documented)

4. **Generator nested file directory creation**
File refs: `src/skills/generator/services/friday-skill-generator-service.ts:779`, `src/skills/generator/services/friday-skill-generator-service.ts:833`  
What’s wrong: nested paths are written without ensuring parent dirs exist.  
Fix: before each `writeFileSync`, run `mkdirSync(dirname(path), { recursive: true })`.  
Files to change: `src/skills/generator/services/friday-skill-generator-service.ts`

---

**Batch B — MEDIUM fixes (5-7)**

5. **23 cross-module deep imports → `#module` imports**
File refs (all 23):
- `src/hub/friday-hub-bootstrap.ts:13`
- `src/hub/friday-hub-bootstrap.ts:32`
- `src/hub/friday-hub-bootstrap.ts:34`
- `src/skills/generator/services/friday-skill-generator-service.types.ts:4`
- `src/skills/generator/services/friday-skill-generator-service.types.ts:5`
- `src/api/model/friday-api-skill-converter.types.ts:11`
- `src/api/model/friday-api-skill-generator.types.ts:9`
- `src/api/http/routes/friday-skill-converter-routes.ts:11`
- `src/api/http/routes/friday-provider-routes.ts:18`
- `src/api/http/routes/friday-skill-generator-routes.ts:5`
- `src/api/http/routes/friday-skill-generator-routes.ts:9`
- `src/api/http/friday-http-error-mapper.ts:2`
- `src/api/http/friday-http-route-registry.ts:2`
- `src/api/conflicts/friday-workflow-conflict-service.ts:15`
- `src/api/runtime/friday-api-runtime.ts:2`
- `src/api/auth/friday-token-validator.ts:2`
- `src/api/auth/friday-auth-service.ts:2`
- `src/workflows/services/friday-workflow-crud-service.ts:2`
- `src/workflows/services/friday-workflow-execution-service.ts:2`
- `src/workflows/builder/services/friday-workflow-builder-compositor-service.ts:2`
- `src/workflows/builder/services/friday-workflow-builder-collaboration-service.ts:3`
- `src/workflows/builder/services/friday-workflow-builder-draft-service.ts:2`
- `src/providers/services/friday-provider-service.ts:25`  
What’s wrong: cross-module relative imports bypass package import boundaries and reduce maintainability.  
Fix: replace with `#skills`, `#skills/generator`, `#hub`, `#errors` imports (based on `package.json#imports`).  
Files to change: the 19 files listed above that contain those 23 refs.

6. **`throw new Error(...)` → `FridayDomainError` in scoped new modules**
File refs (scoped modules found now = 48):
- `src/providers/routing/friday-provider-fallback.ts:135`
- `src/providers/security/friday-secret-crypto.ts:25,47,90`
- `src/skills/converter/services/friday-skill-package-archive.ts:31,65`
- `src/skills/converter/services/friday-skill-converter-service.ts:85,91,133,139,208,221`
- `src/skills/converter/converters/friday-openai-gpt-action-converter.ts:156,161,165,172`
- `src/skills/converter/converters/friday-clawdbot-skill-md-converter.ts:90,95,101`
- `src/skills/converter/converters/friday-n8n-node-converter.ts:109,116,120`
- `src/skills/converter/converters/friday-native-skill-package-converter.ts:78,83,94,101,115`
- `src/skills/generator/llm/friday-provider-inference-client.ts:224,266,275`
- `src/skills/generator/persistence/friday-skill-generation-session-repository.ts:173`
- `src/skills/generator/services/friday-skill-generator-service.ts:208,219,238,245,252,273,288,410,542,671,681,725,733,739,797,814,898`  
What’s wrong: unstructured errors lose code/status/details and weaken API/CLI consistency.  
Fix: replace with `new FridayDomainError(code, message, { httpStatus, details, cause })`; standardize codes by category (validation=400/422, not-found=404, state-conflict=409, upstream-provider=502/503, internal=500).  
Files to change: the 11 files above (CLI/hub currently have no `throw new Error` in this scan).

7. **CLI `status` command placeholder**
File refs: `src/cli/friday-cli.ts:530`  
What’s wrong: always prints “unknown”; does not check running state or version.  
Fix:
- persist runtime metadata on `start` (PID + startedAt + version) to a small status file
- in `status`, read file, verify PID alive (`process.kill(pid, 0)`), print `running/stopped`, PID, uptime
- print CLI version from `package.json` consistently  
Files to change: `src/cli/friday-cli.ts` (optional small helper file for status persistence/check logic)