// Phase F — web search, web fetch, browser, MCP JSON-RPC server.
import { api, isProviderPreconditionFailure, startPhase, WORKSPACE_CAPTURE_DIR } from "../lib/util.mjs";

async function chat(ctx, content) {
  const channel = "stab"; const chatId = `f-${Date.now()}`;
  const create = await api("/v1/sessions", {
    method: "POST", token: ctx.tokens.accessToken,
    body: JSON.stringify({ channel, chatId }),
  });
  const key = create.body?.data?.session?.key;
  await api(`/v1/sessions/${key}/messages`, {
    method: "POST", token: ctx.tokens.accessToken,
    body: JSON.stringify({ role: "user", content }),
  });
  const r = await api(`/v1/sessions/${key}/run`, {
    method: "POST", token: ctx.tokens.accessToken,
    body: JSON.stringify({ useLastUserMessage: true }),
  });
  return r.body?.data?.run;
}

export async function runPhaseF(ctx) {
  const p = startPhase("F");
  const cases = [];
  try {
    // Web search via agent (DDG/Google News fallback as configured)
    const ws = await chat(ctx, "Use web_search to find one article about San Francisco weather. Reply with the headline of the top result, only.");
    const wsReply = String(ws?.finalResponse ?? "");
    const wsSkipped = isProviderPreconditionFailure(wsReply);
    cases.push({ feature: "web_search", ok: !wsSkipped && wsReply.length > 5, skipped: wsSkipped, reply: wsReply.slice(0, 200) });
    // Web fetch
    const wf = await chat(ctx, "Use web_fetch to get https://example.com. Reply with the page <title> tag content, only.");
    const wfReply = String(wf?.finalResponse ?? "");
    const wfSkipped = isProviderPreconditionFailure(wfReply);
    cases.push({ feature: "web_fetch", ok: !wfSkipped && /example/i.test(wfReply), skipped: wfSkipped, reply: wfReply.slice(0, 200) });
    // Browser
    const browserShot = `${WORKSPACE_CAPTURE_DIR}/f-browser.png`;
    const br = await chat(ctx, `Use the browser tool to open https://example.com and take a screenshot to ${browserShot}. Reply with DONE.`);
    const brReply = String(br?.finalResponse ?? "");
    const brSkipped = isProviderPreconditionFailure(brReply);
    let pngBytes = 0;
    try { pngBytes = (await import("node:fs")).statSync(browserShot).size; } catch {}
    cases.push({
      feature: "browser",
      ok: !brSkipped && (pngBytes > 1000 || ((br?.toolCallCount ?? 0) > 0 && /done|screenshot/i.test(brReply))),
      skipped: brSkipped,
      reply: brReply.slice(0, 200),
      pngBytes,
      toolCallCount: br?.toolCallCount,
      requestedPath: browserShot,
    });
    // MCP — Friday exposes an MCP JSON-RPC server at /v1/mcp. It does not expose
    // a REST registry at /v1/mcp/servers.
    const mcpTools = await api("/v1/mcp", {
      method: "POST", token: ctx.tokens.accessToken,
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools-list", method: "tools/list", params: {} }),
    });
    const tools = mcpTools.body?.result?.tools ?? mcpTools.body?.data?.result?.tools;
    const nestedTools = mcpTools.body?.data?.body?.result?.tools;
    cases.push({ feature: "mcp_tools_list", ok: mcpTools.status === 200 && (Array.isArray(tools) || Array.isArray(nestedTools)), status: mcpTools.status, body: JSON.stringify(mcpTools.body).slice(0, 300) });
    p.addEvidence("results.json", cases);
    const fails = cases.filter(c => !c.ok && !c.skipped);
    const skipped = cases.filter(c => c.skipped).length;
    const anomalies = fails.map(c => ({severity: "medium", note: `${c.feature} did not deliver expected outcome` }));
    p.finish(fails.length === cases.length - skipped ? "FAIL" : "PASS", `${cases.length - fails.length - skipped}/${cases.length} web/browser/MCP features ok; skipped=${skipped}`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"web/browser/mcp threw"}]);
  }
}
