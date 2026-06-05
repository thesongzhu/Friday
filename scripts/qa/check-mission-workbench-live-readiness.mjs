#!/usr/bin/env node

import { chromium } from "playwright";

const args = process.argv.slice(2);
const expectNotReady = args.includes("--expect-not-ready");
const allowIsolatedSetup =
  args.includes("--allow-isolated-setup") || process.env.FRIDAY_MISSION_WORKBENCH_ALLOW_ISOLATED_SETUP === "1";
const urlArg = args.find((arg) => arg.startsWith("--url="));
const missionIdArg = args.find((arg) => arg.startsWith("--mission-id="));
const expectedMissionId = missionIdArg?.slice("--mission-id=".length) || process.env.MISSION_ID || "";
const baseTargetUrl = urlArg?.slice("--url=".length) || process.env.FRIDAY_MISSION_WORKBENCH_URL || "http://127.0.0.1:5173/mission-workbench";
const localPassphrase =
  process.env.FRIDAY_TEST_LOCAL_PASSPHRASE
  ?? process.env.FRIDAY_LOCAL_PASSPHRASE
  ?? "friday-mission-workbench-passphrase-123";

function withMissionId(url, missionId) {
  if (!missionId || url.includes("missionId=")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}missionId=${encodeURIComponent(missionId)}`;
}

const targetUrl = withMissionId(baseTargetUrl, expectedMissionId);
const apiProbeUrl = new URL("/v1/mission-spine/workbench", targetUrl);
if (expectedMissionId) apiProbeUrl.searchParams.set("missionId", expectedMissionId);

async function probeWorkbenchApi(url) {
  try {
    const response = await fetch(url);
    const text = await response.text();
    let errorCode = null;
    try {
      const payload = JSON.parse(text);
      errorCode = payload?.error?.code ?? null;
    } catch {
      errorCode = null;
    }
    return {
      attempted: true,
      url: url.toString(),
      status: response.status,
      ok: response.ok,
      errorCode,
    };
  } catch {
    return {
      attempted: true,
      url: url.toString(),
      status: 0,
      ok: false,
      errorCode: "FETCH_FAILED",
    };
  }
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return { response, payload };
}

async function establishLocalSession(targetUrl) {
  const baseUrl = new URL(targetUrl);
  baseUrl.pathname = "";
  baseUrl.search = "";
  baseUrl.hash = "";
  const origin = baseUrl.toString().replace(/\/$/, "");

  const bootstrap = {
    attempted: false,
    required: false,
    ok: false,
    status: 0,
  };
  const login = {
    attempted: false,
    ok: false,
    status: 0,
  };
  const setup = {
    attempted: false,
    required: false,
    ok: false,
    status: 0,
  };
  const mutations = {
    allowed: allowIsolatedSetup,
    blocked: false,
    reason: allowIsolatedSetup ? null : "setup_mutations_require_explicit_isolated_runtime",
  };

  try {
    const status = await requestJson(`${origin}/v1/auth/bootstrap/status`);
    bootstrap.status = status.response.status;
    bootstrap.ok = status.response.ok && status.payload?.ok !== false;
    bootstrap.required = Boolean(status.payload?.data?.bootstrapRequired ?? status.payload?.bootstrapRequired ?? false);

    if (bootstrap.required) {
      if (!allowIsolatedSetup) {
        mutations.blocked = true;
        return { bootstrap, login, setup, mutations, tokenPair: null, user: null };
      }
      bootstrap.attempted = true;
      const initialized = await requestJson(`${origin}/v1/auth/bootstrap/local-passphrase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPassphrase }),
      });
      bootstrap.status = initialized.response.status;
      bootstrap.ok = initialized.response.ok && initialized.payload?.ok !== false;
      if (!bootstrap.ok) {
        return { bootstrap, login, setup, mutations, tokenPair: null, user: null };
      }
    }

    login.attempted = true;
    const loggedIn = await requestJson(`${origin}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase }),
    });
    login.status = loggedIn.response.status;
    login.ok = loggedIn.response.ok && loggedIn.payload?.ok !== false && typeof loggedIn.payload?.data?.accessToken === "string";
    if (!login.ok) {
      return { bootstrap, login, setup, mutations, tokenPair: null, user: null };
    }

    const tokenPair = {
      accessToken: loggedIn.payload.data.accessToken,
      refreshToken: typeof loggedIn.payload.data.refreshToken === "string" ? loggedIn.payload.data.refreshToken : null,
      expiresInSec: typeof loggedIn.payload.data.expiresInSec === "number" ? loggedIn.payload.data.expiresInSec : null,
    };
    const user = loggedIn.payload.data.user ?? null;

    const setupStatus = await requestJson(`${origin}/v1/setup/status`, {
      headers: { Authorization: `Bearer ${tokenPair.accessToken}` },
    });
    setup.status = setupStatus.response.status;
    setup.ok = setupStatus.response.ok && setupStatus.payload?.ok !== false;
    setup.required = Boolean(setupStatus.payload?.data?.needsSetup ?? false);
    if (setup.required) {
      if (!allowIsolatedSetup) {
        mutations.blocked = true;
        return { bootstrap, login, setup, mutations, tokenPair: null, user: null };
      }
      setup.attempted = true;
      const completed = await requestJson(`${origin}/v1/setup/complete`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPair.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          completedSteps: ["welcome"],
          skippedSteps: ["provider", "channels", "skills"],
        }),
      });
      setup.status = completed.response.status;
      setup.ok = completed.response.ok && completed.payload?.ok !== false;
      if (!setup.ok) {
        return { bootstrap, login, setup, mutations, tokenPair: null, user: null };
      }
    }

    return {
      bootstrap,
      login,
      setup,
      mutations,
      tokenPair,
      user,
    };
  } catch {
    return { bootstrap, login, setup, mutations, tokenPair: null, user: null };
  }
}

const apiProbe = await probeWorkbenchApi(apiProbeUrl);
const localSession = await establishLocalSession(targetUrl);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

if (localSession.tokenPair?.accessToken && localSession.user) {
  await page.addInitScript(({ tokenPair, user }) => {
    localStorage.setItem("friday.auth.user", JSON.stringify(user));
    sessionStorage.setItem("friday.auth.sessionAccessToken", tokenPair.accessToken);
    const ttlSec = typeof tokenPair.expiresInSec === "number" ? tokenPair.expiresInSec : 300;
    sessionStorage.setItem("friday.auth.sessionAccessTokenExpiresAt", String(Date.now() + Math.max(1, Math.floor(ttlSec - 5)) * 1000));
  }, {
    tokenPair: {
      accessToken: localSession.tokenPair.accessToken,
      expiresInSec: localSession.tokenPair.expiresInSec,
    },
    user: localSession.user,
  });
}

const consoleErrors = [];
page.on("pageerror", (error) => {
  consoleErrors.push(error.message);
});
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
    consoleErrors.push(message.text());
  }
});

let bodyText = "";
let navigationError = null;

try {
  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 15_000 });
  bodyText = await page.locator("body").innerText({ timeout: 10_000 });
} catch (error) {
  navigationError = error instanceof Error ? error.message : String(error);
} finally {
  await browser.close();
}

const lowerText = bodyText.toLowerCase();
const checks = {
  routeLoaded: navigationError === null,
  localSessionGate: lowerText.includes("connecting to local friday") || lowerText.includes("friday backend is not connected yet"),
  missionWorkbenchVisible: bodyText.includes("Mission Workbench") || bodyText.includes("任务工作台"),
  transcriptBrowserVisible: bodyText.includes("TRANSCRIPT BROWSER") || bodyText.includes("Transcript Browser") || bodyText.includes("证据浏览器"),
  transcriptGroupFiltersVisible: bodyText.includes("Mission groups") && bodyText.includes("Provider sessions") && bodyText.includes("Skill runs") && bodyText.includes("Channel tasks"),
  transcriptEvidenceFacetFiltersVisible: bodyText.includes("Provider refs") && bodyText.includes("Skill refs") && bodyText.includes("Channel refs") && bodyText.includes("Proof receipts") && bodyText.includes("Capture time"),
  prepFallbackVisible: bodyText.includes("PREP FALLBACK ONLY") || lowerText.includes("prep fallback only"),
  pendingProjectionVisible: bodyText.includes("PENDING RUST HUB PROJECTION") || lowerText.includes("pending rust hub projection"),
  pendingCaptureMarkerVisible: lowerText.includes("pending-real-capture"),
  liveRustHubVisible: lowerText.includes("live rust hub") || lowerText.includes("live_rust_hub_projection"),
  expectedMissionVisible: expectedMissionId ? bodyText.includes(expectedMissionId) : true,
  pageErrorsAbsent: consoleErrors.length === 0,
};

let classification = "route_rendered_without_live_rust_hub";
if (navigationError) {
  classification = "ui_unreachable";
} else if (localSession.mutations?.blocked) {
  classification = "isolated_setup_permission_required";
} else if (checks.localSessionGate) {
  classification = "local_session_gate";
} else if (apiProbe.status === 404) {
  classification = "workbench_api_route_missing";
} else if (apiProbe.status === 401 || apiProbe.status === 403) {
  classification = "workbench_api_auth_gate";
} else if (!apiProbe.ok) {
  classification = "workbench_api_not_ready";
} else if (checks.prepFallbackVisible || checks.pendingProjectionVisible || checks.pendingCaptureMarkerVisible) {
  classification = "prep_fallback_not_final_proof";
} else if (
  checks.missionWorkbenchVisible &&
  checks.transcriptBrowserVisible &&
  checks.transcriptGroupFiltersVisible &&
  checks.transcriptEvidenceFacetFiltersVisible &&
  checks.liveRustHubVisible &&
  checks.expectedMissionVisible &&
  checks.pageErrorsAbsent
) {
  classification = "live_rust_hub_ready_for_operator_capture";
}

const readyForFinalCapture = classification === "live_rust_hub_ready_for_operator_capture";
const result = {
  proof: "mission_workbench_live_readiness",
  proof_source: "readiness_check_only_not_ui_device_proof",
  targetUrl,
  classification,
  readyForFinalCapture,
  apiProbe,
  localSession: {
    bootstrap: localSession.bootstrap,
    login: localSession.login,
    setup: localSession.setup,
    mutations: localSession.mutations,
    authenticated: Boolean(localSession.tokenPair?.accessToken && localSession.user),
  },
  checks,
  consoleErrorCount: consoleErrors.length,
  navigationError: navigationError ? "navigation_failed" : null,
};

console.log(JSON.stringify(result, null, 2));

if (expectNotReady) {
  process.exit(readyForFinalCapture ? 1 : 0);
}

process.exit(readyForFinalCapture ? 0 : 1);
