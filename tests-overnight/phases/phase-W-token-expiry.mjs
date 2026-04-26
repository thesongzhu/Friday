// Phase W — token expiry / refresh: real wait for 3601s.
import { api, login, startPhase, sleep } from "../lib/util.mjs";

export async function runPhaseW(ctx) {
  const p = startPhase("W");
  try {
    const WAIT_S = Number(process.env.PHASE_W_WAIT_S ?? 3650);
    if (WAIT_S < 3601) {
      p.note(`PHASE_W_WAIT_S=${WAIT_S} < 3601s; full TTL cannot be observed under that budget. Marking SKIP.`);
      p.finish("SKIP", `PHASE_W_WAIT_S=${WAIT_S}; TTL is hardcoded 3600s and not env-overridable. Real wait skipped under fast budget.`, [{severity:"low", note:"phase W skipped because wait window < 3601s"}]);
      return;
    }
    // Acquire fresh tokens
    const fresh = await login();
    const accessToken = fresh.accessToken;
    const refreshToken = fresh.refreshToken;
    p.note(`fresh token acquired; access prefix=${accessToken.slice(0, 20)}...`);
    // Spot-check while still valid
    const before = await api("/v1/auth/me", { token: accessToken });
    p.addEvidence("before-wait.json", { status: before.status, ok: before.body?.ok });
    if (before.status !== 200) {
      p.finish("FAIL", "fresh token unexpectedly invalid", []);
      return;
    }
    // Wait 3650s = 60m50s for full TTL to expire (TTL=3600s, +50s buffer)
    p.note(`waiting ${WAIT_S}s for token to expire (real wait)`);
    // Sleep in 30s chunks so we can write progress notes
    for (let s = 0; s < WAIT_S; s += 30) {
      await sleep(30_000);
      if ((s + 30) % 600 === 0) p.note(`wait progress: ${s + 30}/${WAIT_S}s`);
    }
    const after = await api("/v1/auth/me", { token: accessToken });
    p.addEvidence("after-wait.json", { status: after.status, body: after.body });
    const expired = after.status === 401;
    if (!expired) {
      p.finish("FAIL", `expected 401 after wait but got ${after.status}`, [{severity:"high", note:"token did not expire as expected"}]);
      return;
    }
    // Refresh
    const refr = await api("/v1/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken }) });
    p.addEvidence("refresh-result.json", { status: refr.status, ok: refr.body?.ok });
    if (!refr.body?.ok) {
      p.finish("FAIL", `refresh failed: ${refr.status}`, [{severity:"high", note:"refresh path broken"}]);
      return;
    }
    const newToken = refr.body.data.accessToken;
    const post = await api("/v1/auth/me", { token: newToken });
    const ok = post.status === 200;
    const anomalies = ok ? [] : [{severity:"high", note:"new token from refresh did not authenticate /me"}];
    p.finish(ok ? "PASS" : "FAIL", `expired-401, refresh-${refr.status}, postRefresh-${post.status}`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"token-expiry threw"}]);
  }
}
