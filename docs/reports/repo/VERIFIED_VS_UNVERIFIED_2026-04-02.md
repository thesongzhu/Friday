# Verified vs Unverified Friday Scope

- Generated at: 2026-04-02T03:30:31.733Z
- Passed tier1 targets: 4
- Blocked tier1 targets: 14

## Verified live targets

- openai-http: openai / global / http
- codex-cli: openai-codex / global / cli
- claude-cli: anthropic / global / cli
- ollama-local: ollama / local / http

## Blocked live targets

- anthropic-http: Anthropic live credentials are not configured in this environment.
- google-gemini: Neither Gemini CLI nor Google live credentials are available in this environment.
- openrouter: OPENROUTER_API_KEY is not configured in this environment.
- xai: XAI_API_KEY is not configured in this environment.
- mistral: MISTRAL_API_KEY is not configured in this environment.
- groq: GROQ_API_KEY is not configured in this environment.
- together: TOGETHER_API_KEY is not configured in this environment.
- qwen: QWEN_API_KEY is not configured in this environment.
- moonshot-kimi: MOONSHOT_API_KEY is not configured in this environment.
- glm: ZHIPU_API_KEY is not configured in this environment.
- volcengine-byteplus: VOLCENGINE_API_KEY is not configured in this environment.
- vllm: VLLM endpoint is not configured in this environment.
- litellm: LiteLLM endpoint is not configured in this environment.
- openai-compatible: OpenAI-compatible endpoint is not configured in this environment.

## Product layers not yet fully live-dogfooded

- Realtime / Channels / UIX / Observability: closure local plus targeted live audit and existing suite coverage; gap: not every operator surface and transport has been fully live-dogfooded with the same rigor as provider tier1 routes
- Marketplace / Skills / Plugins: closure local and existing suite coverage; gap: not every marketplace and plugin path is yet covered by a dedicated live matrix family harness
