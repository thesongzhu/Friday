// Phase KK — stub from Wave 1 foundation. Real implementation arrives in
// Wave 2-5 per .friday/health/new-phases-spec.md. The stub keeps gauntlet's
// expectedPhases() satisfied without claiming false coverage: it always
// SKIPs with a clear marker so the orchestrator gate still requires a marker
// per phase id.
import { startPhase } from "../lib/util.mjs";

export async function runPhaseKK(ctx) {
  const p = startPhase("KK");
  p.note("phase KK stub — implementation pending (see .friday/health/new-phases-spec.md)");
  p.finish("SKIP", "phase KK not yet implemented (Wave 1 stub)", [
    { severity: "low", note: "expected SKIP: stub pending real impl in next wave" },
  ]);
}
