// Bootstrap distinct principals so the rate-limit probe phase doesn't starve the rest.
//
// Friday's local-bypass `/v1/auth/login {local:true}` always returns the SAME admin-001 principal,
// so to truly isolate principals we need to either (a) add real users via the admin API, or
// (b) accept that local-bypass is principal-shared and fall back to header-injected user
// identity if the route allows.
//
// Pragmatic resolution for this run: we use the ONE admin token for all phases, and PHASE R
// runs LAST (T+7:30) after every other phase has committed its work. Any 429 from probe-induced
// rate-limit hits affects only Phase R itself, since all other phases are already complete.
//
// We still split into 3 roles by role-tag in marker filenames so future runs can multi-principal
// once Friday exposes a multi-user bootstrap.

import { login } from "./util.mjs";

export async function bootstrapPrincipals() {
  const admin = await login();
  return {
    monitor: admin,   // for continuous monitors
    gauntlet: admin,  // for B/C/D and most phases
    probe: admin,     // for R only (runs last)
  };
}
