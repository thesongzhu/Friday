# Friday Anthropic HTTP Live Proof (2026-04-15)

- Runtime: `http://127.0.0.1:33141`
- State dir: isolated copy of local Friday state
- Auth mode: local bypass login on localhost
- Provider type: temporary Anthropic HTTP env-ref provider
- Secret handling: API key injected via runtime environment only; not written to repo, report body, or source

## Proof

- Provider created: `b47b2e82-5aae-4561-ab9f-f1ec6ac42b60`
- Validation:
  - `status=ok`
  - `checkedAt=2026-04-16T03:33:30.365Z`
- Doctor:
  - `backendHealth=healthy`
  - `authHealth=healthy`
  - `routingEligible=true`
  - `reasons=[]`
- Agent run:
  - `runId=ffebe5fe-6f9f-4bb7-9b39-160cc10204d0`
  - `status=completed`
  - `providerId=b47b2e82-5aae-4561-ab9f-f1ec6ac42b60`
  - `model=claude-sonnet-4-20250514`
  - `responseText=OK`

## Interpretation

- Friday current Anthropic HTTP path is capable of real provider validation and real agent execution when a valid credential is available.
- The earlier failing Anthropic HTTP provider in the local state was a credential/config truth problem, not a blanket Anthropic HTTP runtime outage.
