// Phase S — capability self-acquisition: 5 distinct goals.
import { api, startPhase, sleep } from "../lib/util.mjs";

const GOALS = [
  "Export the Snowflake table SALES.ORDERS to CSV",
  "Sync new pages from a Notion database into a local file every morning",
  "List the most recent 10 Stripe charges and their amounts",
  "Triage Linear tickets in project ENG and assign by area",
  "Send a Slack DM to a teammate when a workflow fails",
];

export async function runPhaseS(ctx) {
  const p = startPhase("S");
  try {
    const results = [];
    for (const goal of GOALS) {
      const run = await api("/v1/capabilities/acquisition/runs", {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ goal }),
      });
      const id = run.body?.data?.run?.id;
      const summary = {
        goal,
        runId: id,
        status: run.body?.data?.run?.status,
        requiredCapabilities: run.body?.data?.run?.requiredCapabilities,
        missingCapabilities: run.body?.data?.run?.missingCapabilities,
        candidateCount: (run.body?.data?.run?.candidates ?? []).length,
        matrixSummary: run.body?.data?.run?.matrixSummary,
      };
      results.push(summary);
      // Probe approve route (we don't actually approve installs in this run — just verify route exists)
      if (id) {
        const cancel = await api(`/v1/capabilities/acquisition/runs/${id}/cancel`, {
          method: "POST", token: ctx.tokens.accessToken, body: JSON.stringify({}),
        });
        results[results.length - 1].cancelStatus = cancel.status;
      }
      await sleep(1500);
    }
    p.addEvidence("acquisition-runs.json", results);
    const noCandidates = results.filter(r => (r.candidateCount ?? 0) === 0).length;
    const anomalies = noCandidates > 0 ? [{severity:"medium", note:`${noCandidates}/5 acquisition runs returned 0 candidates`}] : [];
    p.finish("PASS", `${results.length} acquisition runs created`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"capability acquisition threw"}]);
  }
}
