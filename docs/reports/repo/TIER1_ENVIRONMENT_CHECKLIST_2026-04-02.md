# Tier1 Environment Checklist

- Generated at: 2026-04-02T03:30:31.733Z

## anthropic-http

- Reason: Anthropic live credentials are not configured in this environment.
- blockerTypes: missing_credentials
- Action: set ANTHROPIC_API_KEY, FRIDAY_E2E_LIVE_ANTHROPIC
- Action: run on global-runner

## google-gemini

- Reason: Neither Gemini CLI nor Google live credentials are available in this environment.
- blockerTypes: missing_runner, missing_credentials
- Action: set GOOGLE_API_KEY
- Action: install binary gemini
- Action: run on global-runner

## openrouter

- Reason: OPENROUTER_API_KEY is not configured in this environment.
- blockerTypes: missing_credentials
- Action: set OPENROUTER_API_KEY
- Action: run on global-runner

## xai

- Reason: XAI_API_KEY is not configured in this environment.
- blockerTypes: missing_credentials
- Action: set XAI_API_KEY
- Action: run on global-runner

## mistral

- Reason: MISTRAL_API_KEY is not configured in this environment.
- blockerTypes: missing_credentials
- Action: set MISTRAL_API_KEY
- Action: run on global-runner

## groq

- Reason: GROQ_API_KEY is not configured in this environment.
- blockerTypes: missing_credentials
- Action: set GROQ_API_KEY
- Action: run on global-runner

## together

- Reason: TOGETHER_API_KEY is not configured in this environment.
- blockerTypes: missing_credentials
- Action: set TOGETHER_API_KEY
- Action: run on global-runner

## qwen

- Reason: QWEN_API_KEY is not configured in this environment.
- blockerTypes: missing_runner, missing_credentials
- Action: set QWEN_API_KEY
- Action: run on china-egress-runner

## moonshot-kimi

- Reason: MOONSHOT_API_KEY is not configured in this environment.
- blockerTypes: missing_runner, missing_credentials
- Action: set MOONSHOT_API_KEY
- Action: run on china-egress-runner

## glm

- Reason: ZHIPU_API_KEY is not configured in this environment.
- blockerTypes: missing_runner, missing_credentials
- Action: set ZHIPU_API_KEY
- Action: run on china-egress-runner

## volcengine-byteplus

- Reason: VOLCENGINE_API_KEY is not configured in this environment.
- blockerTypes: missing_runner, missing_credentials
- Action: set VOLCENGINE_API_KEY
- Action: run on china-egress-runner

## vllm

- Reason: VLLM endpoint is not configured in this environment.
- blockerTypes: missing_endpoint
- Action: set VLLM_BASE_URL
- Action: run on local-runner

## litellm

- Reason: LiteLLM endpoint is not configured in this environment.
- blockerTypes: missing_endpoint
- Action: set LITELLM_BASE_URL
- Action: run on local-runner

## openai-compatible

- Reason: OpenAI-compatible endpoint is not configured in this environment.
- blockerTypes: missing_endpoint
- Action: set OPENAI_COMPATIBLE_BASE_URL
- Action: run on local-runner
