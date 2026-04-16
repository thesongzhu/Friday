# Friday Provider Shape Runtime Proof (2026-04-15)

## Goal

Verify that the new provider/routing normalization survives a **real Friday process** with legacy-shaped persisted data.

## Method

1. Built the current branch with `npm run build`.
2. Copied the real Friday state directory into an isolated temp state dir.
3. Mutated the copied SQLite state to simulate the crashy legacy shapes:
   - removed `fallbackProviderIds` from `hub_settings.llm.routing.v1`
   - removed `supportedModels` from the current default provider's `provider_profiles.config_json`
4. Started a fresh Friday runtime from the new build on `http://127.0.0.1:32141`.
5. Logged in through explicit local bypass on the isolated runtime.
6. Exercised live HTTP routes and a minimal agent run.

## Observed Results

- `GET /v1/model-routing` returned `200`.
- The runtime returned normalized fallback data instead of crashing:
  - `fallbackProviderIds` came back as a real array.
- `GET /v1/providers` returned `200`.
- The mutated provider came back with `supportedModels: []` instead of crashing route/UI code.
- `POST /v1/agent/runs` returned `200`.
- The run reached a terminal state without a crash:
  - `runFinalStatus: failed`
  - user-visible fallback response was returned instead of an uncaught exception

## Interpretation

This does **not** prove every live provider path is healthy in the isolated runtime.

It **does** prove the specific legacy-shape failure mode now degrades safely inside a real Friday process:

- no `.length` crash on missing `fallbackProviderIds`
- no `.includes` / `[0]` crash on missing `supportedModels`
- API routes and agent entry path stay alive under the mutated persisted state

## Remaining Gap

- The isolated live run failed gracefully rather than completing successfully, so provider-path success still needs additional live verification after rebuild on the main runtime.
