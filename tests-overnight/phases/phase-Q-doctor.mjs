// Phase Q — doctor probe (provider health + capabilities/doctor).
import { api, startPhase } from "../lib/util.mjs";

export async function runPhaseQ(ctx) {
  const p = startPhase("Q");
  try {
    const list = await api("/v1/providers", { token: ctx.tokens.accessToken });
    const items = list.body?.data?.items ?? [];
    const probes = [];
    const health = await api("/v1/providers/health", { token: ctx.tokens.accessToken });
    probes.push({ kind: "all", id: "providers.health", status: health.status, body: health.body });
    for (const prov of items) {
      const h = await api(`/v1/providers/${prov.id}/doctor`, { token: ctx.tokens.accessToken });
      probes.push({ kind: prov.kind, id: prov.id, status: h.status, body: h.body });
    }
    const cap = await api("/v1/capabilities/doctor", { method: "POST", token: ctx.tokens.accessToken, body: JSON.stringify({}) });
    const matrix = await api("/v1/health/capabilities", { token: ctx.tokens.accessToken });
    p.addEvidence("provider-probes.json", probes);
    p.addEvidence("capabilities-doctor.json", { status: cap.status, body: cap.body });
    p.addEvidence("capability-matrix.json", { status: matrix.status, body: matrix.body });
    const anomalies = [];
    if (cap.status >= 400) anomalies.push({severity:"high", note:`capabilities doctor returned HTTP ${cap.status}`});
    if (matrix.status >= 400) anomalies.push({severity:"high", note:`health capabilities returned HTTP ${matrix.status}`});
    const embedding = matrix.body?.data?.capabilities?.runtime?.items?.find?.((item) => item.capability === "embedding")
      ?? matrix.body?.capabilities?.runtime?.items?.find?.((item) => item.capability === "embedding");
    if (!embedding) {
      anomalies.push({severity:"high", note:"embedding capability missing from runtime capability matrix"});
    } else if (!Array.isArray(embedding.repairOptions) || embedding.repairOptions.length === 0) {
      anomalies.push({severity:"medium", note:"embedding unavailable but no setup/repair option was exposed"});
    }
    p.finish("PASS", `probed ${probes.length} providers; capability matrix captured`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"doctor threw"}]);
  }
}
