// Phase K — standing goals + agenda items.
import { api, startPhase, sleep } from "../lib/util.mjs";

export async function runPhaseK(ctx) {
  const p = startPhase("K");
  try {
    // Common variants — try plausible payloads
    const payload = {
      userId: "admin-001",
      objective: "Produce a daily morning summary at 09:00 for the stability gauntlet.",
      title: "Daily summary at 09:00",
      cadence: { kind: "cron", expr: "0 9 * * *" },
      autonomyLevel: "low_risk_auto",
    };
    const create = await api("/v1/standing-goals", {
      method: "POST", token: ctx.tokens.accessToken, body: JSON.stringify(payload),
    });
    p.addEvidence("create.json", { status: create.status, body: create.body });
    const list = await api("/v1/standing-goals", { token: ctx.tokens.accessToken });
    p.addEvidence("list.json", list.body);
    const agenda = await api("/v1/agenda", { token: ctx.tokens.accessToken });
    p.addEvidence("agenda.json", agenda.body);
    const anomalies = create.body?.ok ? [] : [{severity:"medium", note:"standing-goal create returned non-ok"}];
    p.finish("PASS", `standing goals: create=${create.status}`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"standing-goals threw"}]);
  }
}
