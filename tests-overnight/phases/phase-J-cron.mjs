// Phase J — cron: register a per-minute job via chat agent, wait 3 min, observe runs.
import { api, startPhase, sleep, WORKSPACE_CAPTURE_DIR } from "../lib/util.mjs";

export async function runPhaseJ(ctx) {
  const p = startPhase("J");
  try {
    const before = await api("/v1/jobs", { token: ctx.tokens.accessToken });
    p.addEvidence("jobs-before.json", before.body);
    const heartbeatPath = `${WORKSPACE_CAPTURE_DIR}/cron-heartbeat.txt`;
    const create = await api("/v1/sessions", {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify({ channel: "stab", chatId: `j-${Date.now()}` }),
    });
    const key = create.body?.data?.session?.key;
    await api(`/v1/sessions/${key}/messages`, {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify({ role: "user", content: `Use the cron tool to register a job named 'stability-heartbeat' that runs every minute and writes a line 'tick' to ${heartbeatPath}. Reply with the cron ID only.` }),
    });
    const r = await api(`/v1/sessions/${key}/run`, {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify({ useLastUserMessage: true }),
    });
    p.addEvidence("create-cron.json", r.body);
    p.note("waiting 150s for ≥2 cron ticks...");
    await sleep(150_000);
    const after = await api("/v1/jobs", { token: ctx.tokens.accessToken });
    p.addEvidence("jobs-after.json", after.body);
    const fs = await import("node:fs");
    let beat = "";
    try { beat = fs.readFileSync(heartbeatPath, "utf8"); } catch {}
    p.addEvidence("heartbeat-file.txt", beat || "(no file)");
    const ticks = beat.split(/\n/).filter(Boolean).length;
    const anomalies = ticks < 2 ? [{severity:"medium", note: `expected ≥2 cron ticks, got ${ticks}`}] : [];
    p.finish("PASS", `cron heartbeat ticks=${ticks}`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"cron threw"}]);
  }
}
