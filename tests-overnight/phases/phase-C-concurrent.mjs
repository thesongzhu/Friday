// Phase C — concurrent load: 10 sessions × 20 turns. Run twice.
import { api, log, startPhase, sleep, parallel, dbSizes } from "../lib/util.mjs";
import { randomUUID } from "node:crypto";

export async function runPhaseC(ctx, label = "C1") {
  const SESSIONS = Number(process.env.PHASE_C_SESSIONS ?? 10);
  const TURNS = Number(process.env.PHASE_C_TURNS ?? 20);
  const p = startPhase(label);
  try {
    const dbBefore = dbSizes();
    const start = Date.now();
    const all = await parallel(
      Array.from({ length: SESSIONS }, (_, s) => async () => {
        const channel = "stab"; const chatId = `c-${label}-${s}-${Date.now()}`;
        const create = await api("/v1/sessions", {
          method: "POST", token: ctx.tokens.accessToken,
          body: JSON.stringify({ channel, chatId, title: `C ${label} s${s}` }),
        });
        if (!create.body?.ok) throw new Error("session create: " + create.status + " " + JSON.stringify(create.body).slice(0,200));
        const key = create.body.data.session.key;
        const turnTimes = [];
        let errors = 0;
        let idemConflicts = 0;
        for (let t = 0; t < TURNS; t++) {
          const userBody = JSON.stringify({ role: "user", content: `s=${s} t=${t} reply only with the integer ${s * 13 + t}` });
          const idempotencyKey = randomUUID();
          await api(`/v1/sessions/${key}/messages`, {
            method: "POST", token: ctx.tokens.accessToken,
            headers: { "Idempotency-Key": idempotencyKey, "Content-Type": "application/json" },
            body: userBody,
          });
          const runStart = Date.now();
          const r = await api(`/v1/sessions/${key}/run`, {
            method: "POST", token: ctx.tokens.accessToken,
            headers: { "Idempotency-Key": randomUUID(), "Content-Type": "application/json" },
            body: JSON.stringify({ useLastUserMessage: true }),
          });
          turnTimes.push(Date.now() - runStart);
          if (r.status === 409) idemConflicts++;
          else if (!r.body?.ok) errors++;
        }
        return { sessionKey: key, turnTimes, errors, idemConflicts };
      }),
      SESSIONS, // run all in parallel
    );
    const dbAfter = dbSizes();
    const all2 = all.map(x => x.ok ? x.value : { error: x.error, turnTimes: [], errors: 1, idemConflicts: 0 });
    const allTimes = all2.flatMap(s => s.turnTimes ?? []);
    allTimes.sort((a, b) => a - b);
    const pct = (x) => allTimes[Math.floor(allTimes.length * x)] ?? null;
    const totalTurns = SESSIONS * TURNS;
    const totalErrors = all2.reduce((a, s) => a + (s.errors ?? 0), 0);
    const totalConflicts = all2.reduce((a, s) => a + (s.idemConflicts ?? 0), 0);
    const summary = {
      label,
      durationMs: Date.now() - start,
      sessions: SESSIONS, turnsPerSession: TURNS, totalTurns,
      p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
      errorRate: totalErrors / totalTurns,
      idempotencyConflicts: totalConflicts,
      dbBefore, dbAfter,
      walDeltaBytes: dbAfter["friday.db-wal"] - dbBefore["friday.db-wal"],
    };
    p.addEvidence("results.json", { summary, sessions: all2 });
    p.note(`p50=${summary.p50}ms p95=${summary.p95}ms err=${summary.errorRate}`);
    const anomalies = [];
    if (summary.errorRate > 0.05) anomalies.push({severity:"high", note:`error rate ${summary.errorRate.toFixed(3)} > 5%`});
    if (summary.walDeltaBytes > 50 * 1024 * 1024) anomalies.push({severity:"medium", note:`WAL grew ${summary.walDeltaBytes} bytes during ${label}`});
    p.finish(summary.errorRate < 0.1 ? "PASS" : "FAIL", `concurrent ${label}: ${totalTurns} turns, p95=${summary.p95}ms`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"concurrent threw"}]);
  }
}
