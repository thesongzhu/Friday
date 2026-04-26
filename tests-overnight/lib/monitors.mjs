// Layer-1 continuous monitors: process RSS, DB/WAL sizes, realtime WS events.
import { appendFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { ROOT, BASE, log, dbSizes, pidRssKb, api, sleep as sleepU } from "./util.mjs";

let WebSocketLib = globalThis.WebSocket;
let webSocketSupportsHeaders = false;
try {
  const wsModule = await import("ws");
  WebSocketLib = wsModule.default ?? wsModule.WebSocket ?? WebSocketLib;
  webSocketSupportsHeaders = true;
} catch {
  // Node 22 provides a standards-compatible WebSocket globally. It cannot set
  // upgrade headers, so the monitor authenticates in the hello frame instead.
}

export function startProcessMonitor({ pid, intervalMs = 30_000, signal }) {
  const csv = `${ROOT}/monitor-process.csv`;
  writeFileSync(csv, "ts,rss_kb,vsz_kb,etime,pcpu_pct\n");
  let stopped = false;
  signal?.addEventListener("abort", () => { stopped = true; });
  (async () => {
    while (!stopped) {
      const m = await pidRssKb(pid);
      const ts = new Date().toISOString();
      if (m) appendFileSync(csv, `${ts},${m.rssKb},${m.vszKb},${m.etime},${m.pcpuPct}\n`);
      else appendFileSync(csv, `${ts},,,,\n`);
      await sleep(intervalMs);
    }
  })();
  return { csv };
}

export function startDbMonitor({ token, intervalMs = 30_000, signal }) {
  const csv = `${ROOT}/monitor-db.csv`;
  writeFileSync(csv, "ts,db_bytes,wal_bytes,shm_bytes,heap_used_bytes\n");
  let stopped = false;
  signal?.addEventListener("abort", () => { stopped = true; });
  (async () => {
    while (!stopped) {
      const sizes = dbSizes();
      let heap = "";
      try {
        const currentToken = typeof token === "function" ? token() : token;
        const r = await api("/v1/observability/time-series?metric=process_heap", { token: currentToken });
        if (r.body?.ok) {
          const points = r.body.data?.points || r.body.data?.series?.[0]?.points || [];
          const last = points[points.length - 1];
          if (last) heap = String(last.value ?? last[1] ?? "");
        }
      } catch {}
      const ts = new Date().toISOString();
      appendFileSync(csv, `${ts},${sizes["friday.db"]},${sizes["friday.db-wal"]},${sizes["friday.db-shm"]},${heap}\n`);
      await sleep(intervalMs);
    }
  })();
  return { csv };
}

export function startWsEventMonitor({ token, signal }) {
  const out = `${ROOT}/realtime-ws-events.jsonl`;
  writeFileSync(out, "");
  let ws;
  let stopped = false;
  let connectAttempts = 0;
  let totalEvents = 0;
  const stats = { totalEvents: 0, lastConnectIso: null, lastEventIso: null, errors: [] };
  function safeAppend(line) {
    try { appendFileSync(out, line + "\n"); } catch (e) { stats.errors.push(String(e)); }
  }
  function connect() {
    if (stopped) return;
    connectAttempts++;
    stats.lastConnectIso = new Date().toISOString();
    log(`[ws-monitor] connect attempt=${connectAttempts}`);
    try {
      const currentToken = typeof token === "function" ? token() : token;
      ws = webSocketSupportsHeaders
        ? new WebSocketLib(`ws://127.0.0.1:3144/v1/realtime/ws`, { headers: { Authorization: `Bearer ${currentToken}` } })
        : new WebSocketLib(`ws://127.0.0.1:3144/v1/realtime/ws`);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
          type: "hello",
          token: currentToken,
          subscriptions: [
            { subscriptionId: "all-agent", filter: { kind: "agent.*" } },
            { subscriptionId: "all-workflow", filter: { kind: "workflow.*" } },
            { subscriptionId: "all-learning", filter: { kind: "learning.*" } },
          ],
        }));
      });
      ws.addEventListener("message", (e) => {
        const ts = new Date().toISOString();
        stats.lastEventIso = ts;
        stats.totalEvents++;
        totalEvents++;
        safeAppend(JSON.stringify({ ts, raw: String(e.data).slice(0, 8000) }));
      });
      ws.addEventListener("close", () => {
        if (stopped) return;
        // Back off if the monitor cannot establish a subscription. Phase L owns the
        // raw upgrade assertion, so monitor failures should not flood the run.
        if (connectAttempts >= 3 && stats.totalEvents === 0) {
          log("[ws-monitor] giving up after 3 failed connects");
          stopped = true;
          stats.errors.push("WS monitor did not establish a subscription; see Phase L evidence");
          return;
        }
        log(`[ws-monitor] closed (attempt=${connectAttempts}), reconnecting in 5s`);
        sleepU(5000).then(connect);
      });
      ws.addEventListener("error", (e) => {
        stats.errors.push(String(e.message || e.error?.message || "?"));
      });
    } catch (e) {
      stats.errors.push(String(e));
      sleepU(5000).then(connect);
    }
  }
  signal?.addEventListener("abort", () => {
    stopped = true;
    try { ws?.close(); } catch {}
  });
  connect();
  return {
    out,
    getStats: () => ({ ...stats, totalEvents, connectAttempts }),
  };
}
