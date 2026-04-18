# Friday Deep Truth Debt (2026-04-17)

This file tracks deep-chain truth claims that must be re-proven or downgraded during the clean rebuild.

## Claims To Retire Or Re-Prove

| Area | Current debt | Required closure |
| --- | --- | --- |
| Manual resolve lesson matching | Older proof text says manual resolve returned a learned lesson id in `summary.matchedLessonIds` and `diagnosis.diagnosis.matchedLessonIds`. | Keep `matchedLessonIds` diagnosis-only. Prove manual resolve via lesson row writeback, incident summary, and next-run behavior change. |
| Autonomous verified claim | Older proof packs describe autonomous restart continuity as already verified. | Re-run restart matrix on `bac8ef2` rebuild branch and either reproduce the claim with new evidence or downgrade it. |
| Self-evolution wording | Older proof docs treat some learning writes as growth proofs. | Only keep claims that show `write -> readback -> behavior changed`. |
| Executed versus verified | Some reports still imply `completionDepth=executed` is enough. | Audit and docs must reserve `verified` for independently checked end-to-end success. |
| Legacy provider lanes | Some helper/docs still mention OpenAI/Ollama as interchangeable live proof lanes. | Deep-chain proof must be Anthropic API-key only; supplemental lanes stay outside this tranche. |
| Mock contamination risk | Old browser and proof narratives can be read as if mock bootstrap counted as release proof. | All deep proof and blind-user wording must point only to real runtime/browser helpers. |

## Final Audit Rule

- If a claim cannot be re-proven during Phases 1-6, mark it `blocked` or `not-proven`.
- Do not keep a higher-confidence historical claim alongside a downgraded new result.
