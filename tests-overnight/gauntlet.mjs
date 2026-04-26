// Top-level orchestrator. Boots Friday, starts monitors, runs phases per timetable, finalises report.
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { ROOT, log, login, api, MARKER_DIR } from "./lib/util.mjs";
import { bootFriday, killFriday } from "./lib/friday-process.mjs";
import { startProcessMonitor, startDbMonitor, startWsEventMonitor } from "./lib/monitors.mjs";
import { ensureAllFixtures } from "./lib/fixtures.mjs";
import { buildReport } from "./lib/report.mjs";

import { runPhaseA } from "./phases/phase-A-boot.mjs";
import { runPhaseB } from "./phases/phase-B-chat-drift.mjs";
import { runPhaseC } from "./phases/phase-C-concurrent.mjs";
import { runPhaseD } from "./phases/phase-D-restart.mjs";
import { runPhaseE } from "./phases/phase-E-multimodal.mjs";
import { runPhaseF } from "./phases/phase-F-web-browser-mcp.mjs";
import { runPhaseG } from "./phases/phase-G-workflows.mjs";
import { runPhaseH } from "./phases/phase-H-agent-loop.mjs";
import { runPhaseI } from "./phases/phase-I-subagents.mjs";
import { runPhaseJ } from "./phases/phase-J-cron.mjs";
import { runPhaseK } from "./phases/phase-K-standing-goals.mjs";
import { runPhaseL } from "./phases/phase-L-realtime-ws.mjs";
import { runPhaseM } from "./phases/phase-M-skill-import-rollback.mjs";
import { runPhaseN } from "./phases/phase-N-skill-gen-failed.mjs";
import { runPhaseO } from "./phases/phase-O-memory-file-sync.mjs";
import { runPhaseP } from "./phases/phase-P-provider-fallback.mjs";
import { runPhaseQ } from "./phases/phase-Q-doctor.mjs";
import { runPhaseR } from "./phases/phase-R-rate-limit.mjs";
import { runPhaseS } from "./phases/phase-S-capability-acquisition.mjs";
import { runPhaseT } from "./phases/phase-T-self-heal.mjs";
import { runPhaseU } from "./phases/phase-U-grant-audit.mjs";
import { runPhaseV } from "./phases/phase-V-ssrf.mjs";
import { runPhaseW } from "./phases/phase-W-token-expiry.mjs";
import { runPhaseX } from "./phases/phase-X-ui-wizard.mjs";

function expectedPhases() {
  const all = ["A","B","C1","C2","D1","D2","D3","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X"];
  if (process.env.FAST_MODE === "1") return all.filter(x => x !== "J");
  return all;
}

async function safe(label, fn) {
  try { await fn(); }
  catch (e) { log(`[orch] PHASE ${label} threw: ${e?.stack || e}`); }
}

(async () => {
  const runStartIso = new Date().toISOString();
  log(`[orch] start ${runStartIso}`);
  // Reset markers from any prior run
  rmSync(MARKER_DIR, { recursive: true, force: true });
  mkdirSync(MARKER_DIR, { recursive: true });
  // Generate fixtures
  ensureAllFixtures();
  // Boot Friday
  const fr = await bootFriday();
  const ctx = { fridayPid: fr.pid };
  const tokens = await login();
  ctx.tokens = tokens;
  // Start monitors
  const ac = new AbortController();
  startProcessMonitor({ pid: fr.pid, signal: ac.signal });
  startDbMonitor({ token: () => ctx.tokens?.accessToken, signal: ac.signal });
  startWsEventMonitor({ token: () => ctx.tokens?.accessToken, signal: ac.signal });
  log(`[orch] monitors armed; running phases...`);

  // Schedule phases by elapsed time. The orchestrator coordinates concurrency itself
  // by using async tasks; long-running parallel work happens during B's wait windows.
  const t0 = Date.now();
  const elapsed = () => (Date.now() - t0) / 1000;

  // Background long-running jobs (B and the parallel cluster) run in parallel with serial phases.
  const FAST_MODE = process.env.FAST_MODE === "1";
  if (FAST_MODE) {
    process.env.PHASE_B_TURNS = process.env.PHASE_B_TURNS ?? "8";
    process.env.PHASE_B_INTERVAL_MS = process.env.PHASE_B_INTERVAL_MS ?? "5000";
    process.env.PHASE_C_SESSIONS = process.env.PHASE_C_SESSIONS ?? "3";
    process.env.PHASE_C_TURNS = process.env.PHASE_C_TURNS ?? "3";
    process.env.PHASE_W_WAIT_S = process.env.PHASE_W_WAIT_S ?? "20";
    log(`[orch] FAST_MODE active: B turns=${process.env.PHASE_B_TURNS} intervalMs=${process.env.PHASE_B_INTERVAL_MS} W wait=${process.env.PHASE_W_WAIT_S}s`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Timing redesign (resolves smoke-discovered ordering bug):
  //
  //   D phases must NOT run while B/cluster have in-flight requests, because killing
  //   Friday mid-fetch makes those phases register false FAILures. So D fires in QUIET
  //   windows only:
  //     - D1: between A and B-start (after A's snapshot, before B turns begin)
  //     - D2: between B+cluster end and the serial post-monitor block
  //     - D3: between W and X (after W's long wait, X reboots Friday on a different port)
  //   C1 still runs once D1 has settled; C2 runs immediately before W in the serial block.
  // ────────────────────────────────────────────────────────────────────────

  // A — boot baseline
  await safe("A", () => runPhaseA(ctx));

  // D1 — quiet-window restart (no other work in flight)
  await safe("D1", () => runPhaseD(ctx, "D1"));

  // C1 — concurrent right after D1 (both serial; small load demonstrates restart kept us alive)
  await safe("C1", () => runPhaseC(ctx, "C1"));

  // Now kick off B (long) and the parallel cluster together. Both run while monitors observe.
  const bPromise = safe("B", () => runPhaseB(ctx));
  const parallelClusterPromise = (async () => {
    // Let B start first
    await sleep(FAST_MODE ? 1500 : 60_000);
    log(`[orch] elapsed=${elapsed().toFixed(0)}s — starting parallel cluster`);
    await safe("E", () => runPhaseE(ctx));
    await safe("F", () => runPhaseF(ctx));
    await safe("G", () => runPhaseG(ctx));
    await safe("H", () => runPhaseH(ctx));
    await safe("I", () => runPhaseI(ctx));
    if (!FAST_MODE) await safe("J", () => runPhaseJ(ctx)); else log("[orch] J skipped in FAST_MODE");
    await safe("K", () => runPhaseK(ctx));
    await safe("L", () => runPhaseL(ctx));
    await safe("M", () => runPhaseM(ctx));
    await safe("N", () => runPhaseN(ctx));
    await safe("O", () => runPhaseO(ctx));
  })();

  // Wait for B + parallel cluster to finish before next quiet-window restart
  await Promise.all([bPromise, parallelClusterPromise]);
  log(`[orch] elapsed=${elapsed().toFixed(0)}s — B + parallel cluster done`);

  // D2 — quiet-window restart between cluster end and serial block
  await safe("D2", () => runPhaseD(ctx, "D2"));

  // P provider fallback
  await safe("P", () => runPhaseP(ctx));
  // Q doctor
  await safe("Q", () => runPhaseQ(ctx));
  // S capability acquisition
  await safe("S", () => runPhaseS(ctx));
  // T self-heal full loop
  await safe("T", () => runPhaseT(ctx));
  // U capability grant audit
  await safe("U", () => runPhaseU(ctx));
  // V SSRF
  await safe("V", () => runPhaseV(ctx));

  // C2 (second concurrent burst)
  await safe("C2", () => runPhaseC(ctx, "C2"));

  // W token expiry — long real wait (~65 min in full mode)
  await safe("W", () => runPhaseW(ctx));

  // D3 — quiet-window restart after W
  await safe("D3", () => runPhaseD(ctx, "D3"));

  // R rate-limit at T+7:30, after everything else
  await safe("R", () => runPhaseR(ctx));

  // X UI wizard at T+7:30 — runs against a separate Friday on PORT_UI
  await safe("X", () => runPhaseX(ctx));

  // Stop monitors
  ac.abort();
  log(`[orch] monitors aborted; killing Friday`);
  await killFriday(ctx.fridayPid);

  // Build the report and run the completion gate
  const runEndIso = new Date().toISOString();
  const report = buildReport({ runStartIso, runEndIso, expectedPhases: expectedPhases() });
  log(`[orch] report=${report.reportPath}`);
  log(`[orch] missingPhases=${report.missingPhases.join(",") || "(none)"}`);
  log(`[orch] evidenceSha256=${report.evidenceSha256}`);
  log(`[orch] monitorsOk=${JSON.stringify(report.monitorsOk)}`);

  // Completion gate
  const ok = report.missingPhases.length === 0 &&
             report.monitorsOk.processOk && report.monitorsOk.dbOk &&
             /^[a-f0-9]{64}$/.test(report.evidenceSha256);
  if (ok) log("STABILITY GAUNTLET: COMPLETE");
  else { log("STABILITY GAUNTLET: INCOMPLETE"); process.exit(2); }
})().catch((e) => {
  log(`[orch] FATAL ${e?.stack || e}`);
  process.exit(3);
});
