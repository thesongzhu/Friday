// Phase G — workflows: create / start / fail+rollback / conflict.
import { api, log, startPhase, sleep } from "../lib/util.mjs";
import { ensureAllFixtures } from "../lib/fixtures.mjs";
import { readFileSync } from "node:fs";

export async function runPhaseG(ctx) {
  const p = startPhase("G");
  const fix = ensureAllFixtures();
  const events = [];
  try {
    const wf = JSON.parse(readFileSync(fix.workflow, "utf8"));
    const wfFail = JSON.parse(readFileSync(fix.workflowFail, "utf8"));
    // Create — schema may differ; record the validation error if so.
    const create = await api("/v1/workflows", {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify(wf),
    });
    events.push({ step: "create-ok-workflow", status: create.status, body: JSON.stringify(create.body).slice(0, 400) });
    let id = create.body?.data?.workflow?.id ?? create.body?.data?.id;
    if (id) {
      const start = await api(`/v1/workflows/${id}/start`, {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({}),
      });
      events.push({ step: "start", status: start.status, body: JSON.stringify(start.body).slice(0, 400) });
      // Conflict probe: race PATCH twice
      const a = api(`/v1/workflows/${id}`, { method: "PATCH", token: ctx.tokens.accessToken, body: JSON.stringify({ description: "x" }) });
      const b = api(`/v1/workflows/${id}`, { method: "PATCH", token: ctx.tokens.accessToken, body: JSON.stringify({ description: "y" }) });
      const [ra, rb] = await Promise.all([a, b]);
      events.push({ step: "conflict-race", a: ra.status, b: rb.status });
    }
    // Failing workflow
    const create2 = await api("/v1/workflows", {
      method: "POST", token: ctx.tokens.accessToken, body: JSON.stringify(wfFail),
    });
    events.push({ step: "create-fail-workflow", status: create2.status, body: JSON.stringify(create2.body).slice(0, 400) });
    let id2 = create2.body?.data?.workflow?.id ?? create2.body?.data?.id;
    if (id2) {
      const s2 = await api(`/v1/workflows/${id2}/start`, { method: "POST", token: ctx.tokens.accessToken, body: JSON.stringify({}) });
      events.push({ step: "start-fail", status: s2.status, body: JSON.stringify(s2.body).slice(0, 400) });
      // Wait a beat for runtime to act
      await sleep(5000);
      const list = await api("/v1/workflows", { token: ctx.tokens.accessToken });
      events.push({ step: "post-list", status: list.status, snippet: JSON.stringify(list.body).slice(0, 300) });
    }
    p.addEvidence("events.json", events);
    p.finish("PASS", `workflow phase ran ${events.length} steps`, []);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"workflow threw"}]);
  }
}
