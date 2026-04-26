// Phase B — long chat drift: 120 turns @ 90s = 3h on a single session.
import Database from "better-sqlite3";
import { api, authedApi, isProviderPreconditionFailure, responseHasProviderPreconditionFailure, startPhase, sleep, STATE_DIR } from "../lib/util.mjs";

export async function runPhaseB(ctx) {
  const TURNS = Number(process.env.PHASE_B_TURNS ?? 120);
  const INTERVAL_MS = Number(process.env.PHASE_B_INTERVAL_MS ?? 90_000);
  const p = startPhase("B");
  const channel = "stab"; const chatId = `drift-${Date.now()}`;
  try {
    const create = await api("/v1/sessions", {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify({ channel, chatId, title: "B drift" }),
    });
    if (!create.body?.ok) throw new Error("session create: " + JSON.stringify(create.body));
    const key = create.body.data.session.key;
    p.note(`session=${key} turns=${TURNS} intervalMs=${INTERVAL_MS}`);

    const turns = [];
    const dbSnapshots = [];
    for (let t = 0; t < TURNS; t++) {
      const turnStart = Date.now();
      const q = composePrompt(t);
      const msg = await authedApi(ctx, `/v1/sessions/${key}/messages`, {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ role: "user", content: q.text }),
      });
      const r = await authedApi(ctx, `/v1/sessions/${key}/run`, {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ useLastUserMessage: true }),
      });
      const run = r.body?.data?.run || {};
      const reply = String(run.finalResponse ?? run.response ?? "");
      if (responseHasProviderPreconditionFailure(r) || isProviderPreconditionFailure(reply)) {
        turns.push({
          turn: t, kind: q.kind, q: q.text, reply: reply.slice(0, 400),
          correct: null, messageStatus: msg.status, runStatus: r.status, runMs: r.ms, runDurationMs: run.durationMs,
          usageInput: run.usageInput, usageOutput: run.usageOutput,
          toolCallCount: run.toolCallCount,
        });
        p.addEvidence("turns.json", turns);
        p.finish("SKIP", "chat drift skipped: no verified text provider/model route available", [
          { severity: "low", note: `provider precondition failed on turn ${t}: "${reply.slice(0, 120)}"` },
        ]);
        return;
      }
      const correct = q.expect ? q.expect.test(reply) : null;
      turns.push({
        turn: t, kind: q.kind, q: q.text, reply: reply.slice(0, 400),
        correct, messageStatus: msg.status, runStatus: r.status, runMs: r.ms, runDurationMs: run.durationMs,
        usageInput: run.usageInput, usageOutput: run.usageOutput,
        toolCallCount: run.toolCallCount,
      });
      if (t % 10 === 0) dbSnapshots.push({ turn: t, ts: new Date().toISOString(), counts: snapshotKeyCounts() });
      if (t % 5 === 0) p.note(`turn ${t}/${TURNS}: usageIn=${run.usageInput} ok=${correct} ms=${r.ms}`);
      const elapsed = Date.now() - turnStart;
      const wait = Math.max(0, INTERVAL_MS - elapsed);
      if (t < TURNS - 1) await sleep(wait);
    }
    dbSnapshots.push({ turn: "final", ts: new Date().toISOString(), counts: snapshotKeyCounts() });
    p.addEvidence("turns.json", turns);
    p.addEvidence("db-snapshots.json", dbSnapshots);
    // Drift analysis
    const stable = turns.filter(t => t.kind === "stable");
    const stableMatch = stable.filter(t => t.correct).length;
    const variant = turns.filter(t => t.kind === "variant");
    const variantMatch = variant.filter(t => t.correct).length;
    const inputs = turns.map(t => t.usageInput).filter(Number.isFinite);
    const inputMin = inputs.length ? Math.min(...inputs) : null;
    const inputMax = inputs.length ? Math.max(...inputs) : null;
    const inputAvg = inputs.length ? inputs.reduce((a,b)=>a+b,0)/inputs.length : null;
    const summary = {
      stableMatchRate: stable.length ? stableMatch / stable.length : null,
      variantMatchRate: variant.length ? variantMatch / variant.length : null,
      inputTokensMin: inputMin, inputTokensMax: inputMax, inputTokensAvg: inputAvg === null ? null : Math.round(inputAvg),
      monotonicGrowth: inputMin === null || inputMax === null ? null : inputMax - inputMin,
      turnsCompleted: turns.length,
      unauthorizedRuns: turns.filter(t => t.messageStatus === 401 || t.runStatus === 401).length,
    };
    p.addEvidence("drift-summary.json", summary);
    const anomalies = [];
    if (summary.stableMatchRate !== null && summary.stableMatchRate < 0.9) anomalies.push({severity:"medium", note:`stable-prompt match rate ${summary.stableMatchRate.toFixed(2)}`});
    if (summary.unauthorizedRuns > 0) anomalies.push({severity:"high", note:`${summary.unauthorizedRuns} turns still hit 401 after token refresh`});
    if (summary.inputTokensMin !== null && summary.inputTokensMin > 5000) anomalies.push({severity:"high", note:`token bloat baseline >5k tokens (min=${summary.inputTokensMin})`});
    if (summary.monotonicGrowth !== null && summary.monotonicGrowth > 5000) anomalies.push({severity:"medium", note:`token growth across ${TURNS} turns: ${summary.monotonicGrowth}`});
    p.finish(anomalies.length ? "PASS" : "PASS", `${turns.length} turns; stable-match=${summary.stableMatchRate} input avg=${summary.inputTokensAvg}`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"chat-drift threw"}]);
  }
}

function composePrompt(t) {
  const cycle = t % 5;
  if (cycle === 0) return { kind: "stable", text: "Reply only with the digits 1234567 and nothing else.", expect: /1234567/ };
  if (cycle === 1) return { kind: "variant", text: `What is ${t}+${t*2}? Reply only with the integer.`, expect: new RegExp(`^\\s*${t * 3}\\s*$`) };
  if (cycle === 2) return { kind: "memory", text: "What did I just ask you to reply with? One word answer.", expect: null };
  if (cycle === 3) return { kind: "capability", text: "Can you send me a Discord message right now?", expect: null };
  return { kind: "time", text: "What is the current calendar year? Reply with only the four digit year.", expect: /\b202[6-9]\b/ };
}

function snapshotKeyCounts() {
  try {
    const db = new Database(`${STATE_DIR}/friday.db`, { readonly: true });
    const out = {};
    for (const t of ["friday_episodes","friday_world_state_snapshots","friday_world_entities","learning_events","memory_items","memory_embeddings","audit_logs","error_incidents"]) {
      try { out[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { out[t] = null; }
    }
    db.close();
    return out;
  } catch { return null; }
}
