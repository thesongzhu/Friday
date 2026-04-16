# Friday CLI Fallback Runtime Proof

Collected on 2026-04-15 against a fresh isolated runtime at `http://127.0.0.1:32141`.

## Real runs

### 1. Text-only summary on `Claude CLI`

- Provider: `df917f7f-9109-4cd0-8040-299e0a34765a`
- Model: `claude-sonnet-4-20250514`
- Prompt: `Summarize this note in 3 bullet points only... must not enter workflow generation or approval planning mode.`
- Run id: `c3dec6e3-30d1-4e6e-a7f2-6234c25f3aee`
- Result: `completed`
- Real evidence:
  - `actualExecution.backendKind=cli`
  - `actualExecution.actualProviderApi=anthropic-messages`
  - `actualExecution.routeDecisionTrace.requiresNativeTools=false`
  - The response returned a direct 3-bullet summary instead of degrading or misrouting.

### 2. Validation judge prompt on `Claude CLI`

- Provider: `df917f7f-9109-4cd0-8040-299e0a34765a`
- Model: `claude-sonnet-4-20250514`
- Prompt class: real-world validation judge (`You are validating a Friday real-world scenario run...`)
- Run id: `a2fc66ef-3177-49ce-8509-c19aa60a2bac`
- Result: `completed`
- Real evidence:
  - `actualExecution.backendKind=cli`
  - `actualExecution.routeDecisionTrace.requiresNativeTools=false`
  - The response returned parseable JSON instead of the previous degraded connection message.

### 3. File-tool roundtrip on `Claude CLI`

- Provider: `df917f7f-9109-4cd0-8040-299e0a34765a`
- Model: `claude-sonnet-4-20250514`
- Prompt: `Use the filesystem to read README.md from the current workspace root and answer with its top H1 heading only.`
- Run id: `0537d955-12a7-44ae-9e30-1ce16b5dca32`
- Result: `failed`
- Real evidence:
  - Runtime degraded with `No model providers can satisfy this task because the remaining candidates are text-only CLI backends or policy-gated for this run.`
  - This is a real capability boundary, not a mock artifact.

## Conclusion

- `Claude CLI` is now a **real text-only fallback** for summary/judge-style read-only tasks.
- `Claude CLI` is **not** a tool-capable fallback lane for filesystem/native-tool scenarios.
- Release notes and proof summaries must keep that distinction explicit.
