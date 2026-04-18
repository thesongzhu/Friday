# Friday Deep Truth Debt (2026-04-17)

This file tracks deep-chain truth claims that had to be re-proven or downgraded during the clean rebuild.

## Resolved In This Rebuild

| Area | Previous debt | Resolution in this branch |
| --- | --- | --- |
| Manual resolve lesson matching | Older proof text said manual resolve returned a learned lesson id in `summary.matchedLessonIds` and `diagnosis.diagnosis.matchedLessonIds`. | Closed. `matchedLessonIds` stays diagnosis-only; manual resolve and next-run learning are now proved through lesson writeback plus behavior change in the self-healing live matrix and reflected in `FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-17.md`. |
| Autonomous verified claim | Older proof packs described autonomous restart continuity as already verified without current rebuild evidence. | Closed. The restart matrix was re-run on the clean rebuild and now has real `planning / executing / verifying` interruption evidence plus SQLite and API readback in `FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-17.md`. |
| Self-evolution wording | Older proof docs treated some learning writes as growth proofs. | Closed. Current learning truth only keeps claims that show `write -> readback -> behavior changed`, and the live learning suite re-proved session, compaction, and world-model behavior deltas. |
| Executed versus verified | Some reports implied `completionDepth=executed` was enough. | Closed for this tranche. The proof pack and deep-chain docs now reserve `verified` for independently checked end-to-end success and treat `executed` as an intermediate depth. |
| Legacy provider lanes | Some helper/docs mentioned OpenAI/Ollama as interchangeable live proof lanes. | Closed for canonical deep proof. This branch re-ran deep-chain and self-upgrade proof on Anthropic API-key only; supplemental lanes remain outside the canonical proof path. |
| Mock contamination risk | Old browser and proof narratives could be read as if mock bootstrap counted as release proof. | Closed for release-proof and deep-proof paths. Current proof inputs pass `check:proof:no-mock-leaks`, and the proof pack only points to real-runtime / real-browser / Anthropic live evidence. |
| Background self-upgrade | Earlier docs explicitly said background autonomous self-upgrade was not proven. | Closed for the six in-scope subjects in this tranche: workflow, skill, plugin, provider_profile, mcp_server, and channel_adapter all now have real `detect -> adapt -> replay -> shadow -> canary -> promote/rollback` proof with SQLite + API readback. |
| Subagent continuity | Older docs did not have restart-safe parent/child artifact truth as a live-verified claim. | Closed. The subagent live suite now proves parent/child/subagent/session evidence continuity, failed-child recovery, artifact completeness, and restart-safe traceability. |

## Remaining Explicit Boundaries

- Discord / desktop / external-channel closure are still out of scope for this tranche and must not be implied by these proofs.
- Env-gated surfaces such as packaging, multi-tenant, and media-understanding remain bounded by runtime enablement and are not promoted to verified by this file.

## Final Audit Rule

- If a claim cannot be re-proven during Phases 1-6, mark it `blocked` or `not-proven`.
- Do not keep a higher-confidence historical claim alongside a downgraded new result.
