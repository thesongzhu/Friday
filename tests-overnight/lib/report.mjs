// Aggregate marker JSONs into the final Markdown report; compute completion gate.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { ROOT, MARKER_DIR, REPORT } from "./util.mjs";

const REQUIRED_TOP_SECTIONS = [
  "Run metadata",
  "Aggregated anomalies",
  "Memory leak",
  "WAL growth",
  "Output drift",
  "Concurrent-load",
  "Cross-restart",
  "Infrastructure-failure",
];

const HISTORICAL_WATCHLIST = [
  "H1 — embedding capability not declared: product/setup decision; current Phase Q uses the supported doctor API before asserting.",
  "H2 — memory.write 60/min/principal: threshold decision, not a route-contract failure.",
  "H3 — token bloat: current Phase B refreshes auth tokens so drift is not confused with 401s.",
  "H4 — capability acquisition: current Phase S uses create/cancel routes; end-to-end acquisition remains a product roadmap item.",
  "H5 — self-heal: current Phase T only flags missing incidents for unhandled failures, not for handled refusals.",
  "H6 — skill generator marker extractor: historical watch item.",
  "H7 — audit_logs empty: current Phase U checks both audit_logs and obs_audit_entries and only flags unaudited side effects.",
  "H8 — episode steps_json empty: expected for LLM-only turns; tool-backed episodes should still have steps.",
  "M1 — FTS punctuation search: product search-quality decision.",
  "M2 — setup status: current Phase X authenticates before querying setup status.",
  "M3 — skills catalog vs installed skills: semantics/API documentation issue, not a stability failure.",
  "M4 — skill generator userId+channel: API DX decision.",
  "M5 — diagnosis overview table disconnect: confirmed product bug, not a gauntlet route issue.",
  "M6 — canned setup response usageInput=0: confirmed product classifier bug, tracked by Phase J.",
  "L1 — boot no-routing warning: confirmed product logging-order bug.",
  "L2 — invalid JSON in skill generator response: not reproduced by this gauntlet.",
  "L3 — session key vs sessionKey: API DX decision.",
  "L4 — POST /run requires explicit useLastUserMessage:true: API DX decision.",
];

export function buildReport({ runStartIso, runEndIso, expectedPhases, openaiTurns = 0 }) {
  const markers = readdirSync(MARKER_DIR).filter(f => f.endsWith(".complete.json"));
  const phases = markers.map(f => JSON.parse(readFileSync(`${MARKER_DIR}/${f}`, "utf8")))
    .sort((a, b) => a.phaseId.localeCompare(b.phaseId));

  const phaseIds = new Set(phases.map(p => p.phaseId));
  const missingPhases = expectedPhases.filter(x => !phaseIds.has(x));

  const anomalies = phases.flatMap(p => (p.anomalies || []).map(a => ({ ...a, phase: p.phaseId })));
  anomalies.sort((a, b) => sevRank(b.severity) - sevRank(a.severity));

  // Compute evidence sha256 over sorted concat of all phase evidence hashes
  const allHashes = phases.flatMap(p => p.evidenceHashes || []).sort();
  const evidenceSha256 = createHash("sha256").update(allHashes.join("\n")).digest("hex");

  const monitorsOk = (() => {
    if (!existsSync(`${ROOT}/monitor-process.csv`)) return { processOk: false, dbOk: false };
    const proc = readFileSync(`${ROOT}/monitor-process.csv`, "utf8").split(/\n/).filter(Boolean);
    const db = existsSync(`${ROOT}/monitor-db.csv`) ? readFileSync(`${ROOT}/monitor-db.csv`, "utf8").split(/\n/).filter(Boolean) : [];
    return { processOk: proc.length > 1, dbOk: db.length > 1, processSamples: proc.length - 1, dbSamples: db.length - 1 };
  })();

  // Memory leak detection
  let memLeak = "no data";
  let walGrowth = "no data";
  try {
    const proc = readFileSync(`${ROOT}/monitor-process.csv`, "utf8").trim().split(/\n/).slice(1);
    if (proc.length > 5) {
      const rss = proc.map(l => Number(l.split(",")[1])).filter(Number.isFinite);
      if (rss.length) {
        const max = Math.max(...rss); const min = Math.min(...rss); const last = rss[rss.length - 1];
        memLeak = `min=${min}KB max=${max}KB last=${last}KB delta=${max - min}KB`;
      }
    }
  } catch {}
  try {
    const dbCsv = readFileSync(`${ROOT}/monitor-db.csv`, "utf8").trim().split(/\n/).slice(1);
    if (dbCsv.length > 5) {
      const wal = dbCsv.map(l => Number(l.split(",")[2])).filter(Number.isFinite);
      if (wal.length) {
        const max = Math.max(...wal); const min = Math.min(...wal); const last = wal[wal.length - 1];
        walGrowth = `min=${min}B max=${max}B last=${last}B`;
      }
    }
  } catch {}

  // Concurrent and drift summaries
  const concurrent = phases.filter(p => p.phaseId === "C1" || p.phaseId === "C2").map(p => p.summary);
  const driftPhase = phases.find(p => p.phaseId === "B");

  const lines = [];
  // Banner
  if (missingPhases.length > 0) {
    lines.push("# INCOMPLETE — see infrastructure-failure list");
  } else {
    lines.push("# Friday Overnight Stability Gauntlet — Final Report");
  }
  lines.push("");
  lines.push("## Run metadata");
  lines.push(`- runStartIso: \`${runStartIso}\``);
  lines.push(`- runEndIso: \`${runEndIso}\``);
  const dur = Date.parse(runEndIso) - Date.parse(runStartIso);
  lines.push(`- duration: \`${(dur / 1000 / 60).toFixed(1)} min\``);
  lines.push(`- expected phases: \`${expectedPhases.length}\` (${expectedPhases.join(", ")})`);
  lines.push(`- completed phases: \`${phases.length}\` (${phases.map(p => p.phaseId).join(", ")})`);
  lines.push(`- missing phases: \`${missingPhases.length === 0 ? "none" : missingPhases.join(", ")}\``);
  lines.push(`- approx OpenAI chat turns: \`${openaiTurns}\``);
  lines.push("");
  lines.push("## Per-phase results");
  for (const ph of phases) {
    lines.push(`### Phase ${ph.phaseId} — ${ph.status}`);
    lines.push(`- started: ${ph.startedAt}`);
    lines.push(`- finished: ${ph.finishedAt}`);
    lines.push(`- summary: ${ph.summary}`);
    if (ph.notes?.length) {
      lines.push(`- notes:`);
      for (const n of ph.notes.slice(0, 12)) lines.push(`  - ${n}`);
    }
    if (ph.anomalies?.length) {
      lines.push(`- anomalies:`);
      for (const a of ph.anomalies) lines.push(`  - **${a.severity}**: ${a.note}`);
    }
    if (ph.evidenceHashes?.length) {
      lines.push(`- evidence: ${ph.evidenceHashes.length} files (under \`${ROOT}/evidence/${ph.phaseId}/\`)`);
    }
    lines.push("");
  }
  lines.push("## Aggregated anomalies");
  if (anomalies.length === 0) lines.push("- (none)");
  else {
    lines.push("| severity | phase | note |");
    lines.push("| --- | --- | --- |");
    for (const a of anomalies) lines.push(`| ${a.severity} | ${a.phase} | ${a.note.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push("### Historical watchlist, not counted as current anomalies");
  for (const prior of HISTORICAL_WATCHLIST) lines.push(`- ${prior}`);
  lines.push("");
  lines.push("## Memory leak chart-data");
  lines.push(`- CSV: \`${ROOT}/monitor-process.csv\``);
  lines.push(`- summary: ${memLeak}`);
  lines.push("");
  lines.push("## WAL growth chart-data");
  lines.push(`- CSV: \`${ROOT}/monitor-db.csv\``);
  lines.push(`- summary: ${walGrowth}`);
  lines.push("");
  lines.push("## Output drift summary");
  if (driftPhase) lines.push(`- See evidence dir \`${ROOT}/evidence/B/\` (turns.json, drift-summary.json)`);
  else lines.push(`- (Phase B did not complete)`);
  lines.push("");
  lines.push("## Concurrent-load summary");
  for (const c of concurrent) lines.push(`- ${JSON.stringify(c)}`);
  if (concurrent.length === 0) lines.push(`- (Phase C did not complete)`);
  lines.push("");
  lines.push("## Cross-restart durability");
  const restarts = phases.filter(p => p.phaseId.startsWith("D"));
  if (restarts.length === 0) lines.push("- (no restart phases completed)");
  else for (const r of restarts) lines.push(`- ${r.phaseId}: ${r.summary}`);
  lines.push("");
  lines.push("## Infrastructure-failure list");
  if (missingPhases.length === 0) lines.push("- (no phase missing — all expected phase markers present)");
  else for (const m of missingPhases) lines.push(`- missing phase: ${m}`);
  if (!monitorsOk.processOk) lines.push(`- process monitor produced no samples`);
  if (!monitorsOk.dbOk) lines.push(`- DB monitor produced no samples`);
  lines.push("");
  // Evidence hash trailer
  lines.push(`<!-- gauntlet-evidence-sha256: ${evidenceSha256} -->`);
  writeFileSync(REPORT, lines.join("\n"));
  return { reportPath: REPORT, missingPhases, evidenceSha256, monitorsOk, anomalyCount: anomalies.length };
}

function sevRank(s) { return ({ high: 3, medium: 2, low: 1 })[s] ?? 0; }

if (import.meta.url === `file://${process.argv[1]}`) {
  // Direct call: regenerate report from existing markers
  const out = buildReport({
    runStartIso: process.env.RUN_START_ISO ?? new Date().toISOString(),
    runEndIso: new Date().toISOString(),
    expectedPhases: (process.env.EXPECTED_PHASES ?? "A,B,C1,C2,D1,D2,D3,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X").split(","),
  });
  console.log(JSON.stringify(out, null, 2));
}
