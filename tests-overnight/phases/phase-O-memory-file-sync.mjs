// Phase O — memory file sync: write items, expect file export, edit file, expect re-import.
import { api, startPhase, sleep, REPO_ROOT } from "../lib/util.mjs";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

export async function runPhaseO(ctx) {
  const p = startPhase("O");
  try {
    const ns = `stab-sync-${Date.now()}`;
    // Write 5 items
    for (let i = 0; i < 5; i++) {
      const r = await api("/v1/memory/items", {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ namespace: ns, content: `sync-item-${i} unique-marker-Q5K`, tags: ["sync", `i${i}`] }),
      });
      if (!r.body?.ok) p.note(`write ${i}: ${r.status}`);
    }
    // Look for exported file — Friday writes to <cwd>/.friday/exports/memory/<ns>_<hash>.json
    // The cwd is the repo root because we boot Friday with cwd=REPO. Filename has a hash suffix
    // so we glob.
    const exportDir = `${REPO_ROOT}/.friday/exports/memory`;
    p.note("waiting for file-sync export");
    const exportSearch = await waitForExport(p, ns, exportDir);
    const found = exportSearch.found;
    p.addEvidence("export-search.json", { ns, exportDir, ...exportSearch });
    let reimported = false;
    if (found) {
      const content = readFileSync(found, "utf8");
      p.addEvidence("exported-file.txt", content.slice(0, 4000));
      // External edit and verify Friday picks it up. Keep the export valid JSON;
      // otherwise this phase is testing parser leniency instead of file sync.
      const parsed = JSON.parse(content);
      parsed.items[0].contentText = `${parsed.items[0].contentText ?? ""} external-edit-marker-K7`.trim();
      parsed.items[0].updatedAt = new Date().toISOString();
      writeFileSync(found, `${JSON.stringify(parsed, null, 2)}\n`);
      const reimportSearch = await waitForReimport(ctx, ns);
      reimported = reimportSearch.reimported;
      p.addEvidence("post-edit-search.json", reimportSearch);
    }
    const ok = Boolean(found) && reimported;
    const anomalies = [];
    if (!found) anomalies.push({severity:"medium", note:"no export file appeared within the polling window"});
    if (found && !reimported) anomalies.push({severity:"medium", note:"external edit marker was not re-imported within the polling window"});
    p.finish(ok ? "PASS" : "FAIL", `memory file export ${found ? "found at " + found : "not found"}; reimported=${reimported}`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"memory-file-sync threw"}]);
  }
}

async function waitForExport(p, ns, exportDir) {
  const maxMs = process.env.FAST_MODE === "1" ? 45_000 : 90_000;
  const attempts = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    try {
      const dir = readdirSync(exportDir);
      const matches = dir.filter(f => f.startsWith(`tenant.admin-001.user.admin-001.${ns}_`) || f.startsWith(`${ns}_`));
      attempts.push({ atMs: Date.now() - startedAt, count: dir.length, matches });
      if (matches.length > 0) return { found: `${exportDir}/${matches[0]}`, attempts, maxMs };
    } catch (e) {
      attempts.push({ atMs: Date.now() - startedAt, error: e.message });
      p.note(`could not read export dir ${exportDir}: ${e.message}`);
    }
    await sleep(2000);
  }
  return { found: null, attempts, maxMs };
}

async function waitForReimport(ctx, ns) {
  const maxMs = process.env.FAST_MODE === "1" ? 30_000 : 60_000;
  const attempts = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    const search = await api("/v1/memory/search", {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify({ query: "external-edit-marker-K7", namespace: ns, limit: 5 }),
    });
    const text = JSON.stringify(search.body ?? "");
    const reimported = /external-edit-marker-K7/.test(text);
    attempts.push({ atMs: Date.now() - startedAt, status: search.status, reimported, body: search.body });
    if (reimported) return { reimported: true, attempts, maxMs };
    await sleep(2000);
  }
  return { reimported: false, attempts, maxMs };
}
