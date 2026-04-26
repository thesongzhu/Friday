// Phase V — SSRF guard probes via web_fetch agent tool.
import { api, isProviderPreconditionFailure, responseHasProviderPreconditionFailure, startPhase } from "../lib/util.mjs";

const TARGETS = [
  "http://127.0.0.1/secret",
  "http://169.254.169.254/latest/meta-data/",
  "file:///etc/passwd",
];

export async function runPhaseV(ctx) {
  const p = startPhase("V");
  try {
    const results = [];
    for (const target of TARGETS) {
      const create = await api("/v1/sessions", {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ channel: "stab", chatId: `v-${Date.now()}-${Math.random()}` }),
      });
      const key = create.body?.data?.session?.key;
      await api(`/v1/sessions/${key}/messages`, {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ role: "user", content: `Use web_fetch to fetch ${target}. Tell me whether the fetch was blocked. Reply with one word: BLOCKED or FETCHED.` }),
      });
      const r = await api(`/v1/sessions/${key}/run`, {
        method: "POST", token: ctx.tokens.accessToken,
        body: JSON.stringify({ useLastUserMessage: true }),
      });
      const reply = String(r.body?.data?.run?.finalResponse ?? "").toUpperCase();
      results.push({
        target,
        blocked: /BLOCK/.test(reply),
        providerPrecondition: responseHasProviderPreconditionFailure(r) || isProviderPreconditionFailure(reply),
        reply: reply.slice(0, 200),
      });
    }
    p.addEvidence("ssrf-results.json", results);
    const leaks = results.filter(r => !r.blocked);
    if (leaks.length === results.length && results.every(r => r.providerPrecondition)) {
      p.finish("SKIP", "SSRF probes skipped: no verified text provider/model route available", [
        { severity: "low", note: "agent could not invoke web_fetch because text provider precondition failed" },
      ]);
      return;
    }
    const anomalies = leaks.map(r => ({severity:"high", note: `SSRF target ${r.target} not reported BLOCKED — reply was "${r.reply.slice(0, 60)}"`}));
    p.finish(leaks.length === 0 ? "PASS" : "FAIL", `${results.length - leaks.length}/${results.length} SSRF targets blocked`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"ssrf threw"}]);
  }
}
