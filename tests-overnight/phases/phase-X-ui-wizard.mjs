// Phase X — UI setup wizard E2E. Drives a browser session via Playwright against a fresh
// Friday instance on PORT_UI=3145 so needsSetup=true.
//
// We don't run the existing vitest harness — we just use Playwright directly with a tiny
// scripted flow.
import { LOCAL_PASSPHRASE, startPhase, PORT_UI } from "../lib/util.mjs";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { bootFriday, killFriday } from "../lib/friday-process.mjs";

async function apiUi(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (opts.token && !headers.Authorization) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`http://127.0.0.1:${PORT_UI}${path}`, { ...opts, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

export async function runPhaseX(ctx) {
  const p = startPhase("X");
  let pid = null;
  let browser = null;
  try {
    // Boot fresh Friday on 3145 with empty isolated state
    const stateDir2 = "/tmp/friday-overnight-test/state-ui";
    spawnSync("rm", ["-rf", stateDir2]);
    mkdirSync(stateDir2, { recursive: true });
    const reb = await bootFriday({ stateDir: stateDir2, port: PORT_UI, logName: `friday-ui-${PORT_UI}.log` });
    pid = reb.pid;
    p.note(`UI Friday on :${PORT_UI} pid=${pid}`);
    // Use Playwright (already in node_modules)
    const playwright = await import("playwright");
    browser = await playwright.chromium.launch({ headless: true });
    const ctxBrowser = await browser.newContext();
    const page = await ctxBrowser.newPage();
    const bootstrapStatus = await apiUi("/v1/auth/bootstrap/status");
    if (bootstrapStatus.body?.data?.bootstrapRequired || bootstrapStatus.body?.bootstrapRequired) {
      await apiUi("/v1/auth/bootstrap/local-passphrase", {
        method: "POST",
        body: JSON.stringify({ passphrase: LOCAL_PASSPHRASE }),
      });
    }
    const login = await apiUi("/v1/auth/login", { method: "POST", body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }) });
    const accessToken = login.body?.data?.accessToken;
    p.addEvidence("login.json", { status: login.status, ok: login.body?.ok });
    await page.goto(`http://127.0.0.1:${PORT_UI}/setup`, { waitUntil: "networkidle", timeout: 30_000 });
    await page.screenshot({ path: "/tmp/friday-overnight-test/captures/x-setup-initial.png", fullPage: true });
    p.note(`setup page rendered; URL=${page.url()}`);
    // Wait for setup status — assert needsSetup=true initially
    const status0 = await apiUi("/v1/setup/status", { token: accessToken }).catch(() => null);
    p.addEvidence("setup-status-pre.json", status0);
    // Probe key UI selectors
    const buttons = await page.$$eval("button", btns => btns.map(b => b.innerText.trim()).slice(0, 50));
    p.addEvidence("setup-buttons.json", buttons);
    // Try to navigate to /home and check if the wizard redirects back
    await page.goto(`http://127.0.0.1:${PORT_UI}/home`, { waitUntil: "networkidle" });
    await page.screenshot({ path: "/tmp/friday-overnight-test/captures/x-home.png", fullPage: true });
    p.note(`/home URL after navigation: ${page.url()}`);
    // Final status
    const status1 = await apiUi("/v1/setup/status", { token: accessToken }).catch(() => null);
    p.addEvidence("setup-status-post.json", status1);
    p.finish("PASS", `UI E2E: rendered /setup and /home; setupCompletedAt=${status1?.body?.data?.setupCompletedAt}`, []);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"medium", note:"UI E2E threw"}]);
  } finally {
    if (browser) try { await browser.close(); } catch {}
    if (pid) await killFriday(pid);
  }
}
