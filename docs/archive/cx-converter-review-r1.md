> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Converter Review R1 — NOT APPROVED (9 findings)

### 1. CLI commands are TODO stubs
`src/cli/friday-cli.ts:332,353,392`
import/convert/pack never invoke hub.converterService.

### 2. options (splitOperations, skillIdPrefix, dryRun) ignored
`src/skills/converter/services/friday-skill-converter-service.ts:75,93,100`
`src/api/http/routes/friday-skill-converter-routes.ts:239`

### 3. OpenAPI combined mode executor broken
`src/skills/converter/converters/friday-openai-gpt-action-converter.ts:881,903`
splitOperations:false generates executor without path/query/header/body mappings.

### 4. API key auth only for header, not query/cookie
`src/skills/converter/converters/friday-openai-gpt-action-converter.ts:360,996`

### 5. OpenAPI YAML unsupported (JSON only)
`src/skills/converter/converters/friday-openai-gpt-action-converter.ts:113,162`

### 6. n8n adapter is explicit stub
`src/skills/converter/converters/friday-n8n-node-converter.ts:546,548`

### 7. Clawdbot multi-command placeholder not substituted
`src/skills/converter/converters/friday-clawdbot-skill-md-converter.ts:407,420`

### 8. Shell case labels not escaped (injection risk)
`src/skills/converter/converters/friday-clawdbot-skill-md-converter.ts:418,430`

### 9. CLI missing converter flags
`src/cli/friday-cli.ts:25,114`
Missing --split-operations, --skill-id-prefix, --no-refresh.
