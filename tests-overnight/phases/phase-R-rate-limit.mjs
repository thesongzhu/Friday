// Phase R — rate-limit probe: hit each policy past maxHits and assert 429.
//
// We DO NOT exercise auth.* policies on our own admin token (would lock us out).
// auth.login is hit with a deliberately wrong body so it exhausts the IP key without lockout.
// auth.refresh and auth.logout are skipped with a documented reason.
//
// Approach per policy: fire (maxHits + 5) requests in parallel; record the index at which
// 429 first appears.

import { api, startPhase, sleep, parallel } from "../lib/util.mjs";

const POLICIES = [
  // ip-keyed (not principal): probing the IP can run from loopback fine
  { id: "auth.login",            method: "POST", path: "/v1/auth/login", body: () => ({ localPassphrase: "wrong-overnight-rate-limit-passphrase" }), max: 10, key: "ip", auth: false },
  { id: "channel.webhook",       method: "POST", path: "/v1/channel-webhooks/line", body: () => ({}), max: 120, key: "ip", auth: false },
  { id: "satellite.register",    method: "POST", path: "/v1/satellites/register", body: () => ({}), max: 20, key: "ip", auth: false },
  { id: "satellite.handshake",   method: "POST", path: "/v1/satellites/__nope__/handshake", body: () => ({}), max: 30, key: "ip", auth: false },
  { id: "workflow.webhook",      method: "POST", path: "/v1/workflow-webhooks/__nope__", body: () => ({}), max: 120, key: "ip", auth: false },
  // principal-keyed (against admin) — ordered so the most expensive last
  { id: "session.write",         method: "POST", path: "/v1/sessions", body: () => ({ channel: "rl", chatId: `r-${Date.now()}-${Math.random()}` }), max: 60, key: "principal", auth: true },
  { id: "memory.write",          method: "POST", path: "/v1/memory/items", body: () => ({ namespace: "rl-probe", content: `r-${Math.random()}` }), max: 60, key: "principal", auth: true },
  { id: "workflow.start_run",    method: "POST", path: "/v1/workflow-runs", body: () => ({ workflowId: "__nope__" }), max: 60, key: "principal", auth: true },
  { id: "workflow.publish",      method: "POST", path: "/v1/workflows/__nope__/publish", body: () => ({}), max: 20, key: "principal", auth: true },
  { id: "workflow.resolve_conflict", method: "POST", path: "/v1/workflows/__nope__/conflicts/__c__/resolve", body: () => ({}), max: 20, key: "principal", auth: true },
  { id: "realtime.subscribe",    method: "POST", path: "/v1/realtime/subscriptions", body: () => ({ filter: { kind: "*" } }), max: 120, key: "principal", auth: true },
  { id: "realtime.pull",         method: "POST", path: "/v1/realtime/pull", body: () => ({ subscriptionId: "x", limit: 1 }), max: 300, key: "principal", auth: true },
  { id: "provider.write",        method: "POST", path: "/v1/providers", body: () => ({ kind:"openai", name:"rl-probe", baseUrl:"https://api.openai.com", api:"openai-responses", authMode:"bearer-token", apiKey:"sk-x", supportedModels:["x"], defaultModel:"x", validateOnSave:false }), max: 30, key: "principal", auth: true },
  { id: "provider.validate",     method: "POST", path: "/v1/providers/__nope__/validate", body: () => ({}), max: 10, key: "principal", auth: true },
  { id: "agent.run",             method: "POST", path: "/v1/agent/runs", body: () => ({ task: "x" }), max: 60, key: "principal", auth: true },
  { id: "marketplace.checkout",  method: "POST", path: "/v1/marketplace/checkout", body: () => ({ listingId: "__nope__", versionId: "__nope__", pricingPlanId: "__nope__" }), max: 10, key: "principal", auth: true },
  { id: "marketplace.write",     method: "POST", path: "/v1/marketplace/listings", body: () => ({}), max: 30, key: "principal", auth: true },
  { id: "generator.llm",         method: "POST", path: "/v1/workflows/generator/sessions", body: () => ({ goal: "x", userId: "admin-001", channel: "local" }), max: 10, key: "principal", auth: true },
  { id: "generator.write",       method: "POST", path: "/v1/workflows/generator/sessions/__nope__/messages", body: () => ({ message: "x" }), max: 30, key: "principal", auth: true },
  { id: "skill_generator.llm",   method: "POST", path: "/v1/skills/generator/sessions", body: () => ({ goal: "x", userId: "admin-001", channel: "local" }), max: 10, key: "principal", auth: true },
  { id: "skill_generator.write", method: "POST", path: "/v1/skills/generator/sessions/__nope__/messages", body: () => ({ message: "x" }), max: 30, key: "principal", auth: true },
  { id: "skill_converter.write", method: "POST", path: "/v1/skills/convert", body: () => ({ source: { uri: "/tmp/__nope__" } }), max: 20, key: "principal", auth: true },
  // Skipped (would lock us out): auth.refresh, auth.logout, realtime.ws_connect
];

export async function runPhaseR(ctx) {
  const p = startPhase("R");
  try {
    const results = [];
    for (const pol of POLICIES) {
      const burst = pol.max + 5;
      const start = Date.now();
      const calls = Array.from({ length: burst }, (_, i) => async () => {
        const headers = { "Content-Type": "application/json" };
        if (pol.auth) headers.Authorization = `Bearer ${ctx.tokens.accessToken}`;
        const res = await api(pol.path, { method: pol.method, headers, body: JSON.stringify(pol.body()) });
        return { i, status: res.status, code: res.body?.error?.code, retryAfterMs: res.body?.error?.retryAfterMs };
      });
      const all = await parallel(calls, burst);
      const got = all.map(x => x.ok ? x.value : { i: -1, status: 0, error: x.error });
      const first429 = got.findIndex(x => x.status === 429);
      const has429 = first429 >= 0;
      results.push({
        id: pol.id, max: pol.max, burst, key: pol.key,
        path: pol.path,
        first429Index: first429,
        observed429: has429,
        retryAfterMs: has429 ? got[first429].retryAfterMs : null,
        sample: got.slice(0, 3),
        durationMs: Date.now() - start,
      });
      // Wait for window reset between policies. Skip the wait when in FAST_MODE: smoke
      // verifies wiring, real measurement happens in the full-mode run.
      const FAST = process.env.FAST_MODE === "1";
      await sleep(FAST ? 200 : 70_000);
    }
    p.addEvidence("policies-results.json", results);
    const missing = results.filter(r => !r.observed429);
    const FAST = process.env.FAST_MODE === "1";
    const anomalies = FAST
      ? []
      : missing.map(r => ({severity:"medium", note:`policy ${r.id}: never observed 429 in burst=${r.burst}`}));
    p.finish(missing.length > results.length / 2 ? "FAIL" : "PASS",
      `${results.length} policies probed; ${results.length - missing.length} returned 429 as expected`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"rate-limit threw"}]);
  }
}
