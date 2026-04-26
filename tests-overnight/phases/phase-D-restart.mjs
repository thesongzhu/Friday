// Phase D — restart durability: kill, wait, restart, diff row counts.
import { startPhase, api, log, sleep, login } from "../lib/util.mjs";
import { snapshotRowCounts } from "./phase-A-boot.mjs";
import { bootFriday, killFriday } from "../lib/friday-process.mjs";

export async function runPhaseD(ctx, label = "D1") {
  const p = startPhase(label);
  try {
    const before = snapshotRowCounts();
    p.note(`pre-restart memory_items=${before.memory_items} sessions=${before.sessions}`);
    await killFriday(ctx.fridayPid);
    await sleep(2000);
    const reb = await bootFriday();
    ctx.fridayPid = reb.pid;
    const newToken = await login();
    ctx.tokens = newToken;
    const after = snapshotRowCounts();
    const diff = {};
    for (const k of Object.keys(before)) diff[k] = (after[k] ?? null) - (before[k] ?? null);
    p.addEvidence("row-diff.json", { before, after, diff });
    const losses = Object.entries(diff).filter(([_, v]) => Number.isFinite(v) && v < 0);
    const anomalies = losses.map(([k, v]) => ({severity: "high", note: `restart dropped rows from ${k}: delta=${v}`}));
    p.finish(losses.length ? "FAIL" : "PASS", `restart ${label}; tables checked=${Object.keys(diff).length}; losses=${losses.length}`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"restart threw"}]);
  }
}
