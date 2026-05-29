// Phase24 trusted-inbound listeners boot a DISPOSABLE in-process Friday hub and read
// its session API to verify the inbound user-message mirror. The session read endpoints
// (`sessions.list` / `sessions.messages.list`) require a bound owner/session/channel
// principal (error `OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED`) — a security boundary we
// MUST NOT weaken or bypass. This helper authenticates as a legitimate local principal
// via the standard bootstrap-local-passphrase + login flow and returns a short-lived
// Bearer token for the disposable instance.
//
// SECURITY: the returned token must NEVER be logged or written into a proof artifact.
// Callers keep it in a local variable and pass it only as the Authorization header.

const DEFAULT_LOCAL_PASSPHRASE = "phase24-trusted-inbound-proof-local-passphrase";

async function readJsonBody(response) {
  if (!response) return null;
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unwrapEnvelope(body) {
  if (body && typeof body === "object" && body.ok === true && Object.hasOwn(body, "data")) {
    return body.data;
  }
  return body;
}

/**
 * Acquire a Bearer access token for the disposable listener hub via the standard
 * bootstrap-local-passphrase + login flow. Throws a descriptive error if no token is
 * issued, so the listener records an honest blocker instead of silently falling back to
 * an (now-rejected) authless read. NEVER logs the token.
 *
 * @param {string} baseUrl - e.g. http://127.0.0.1:<port>
 * @param {{ passphrase?: string }} [options]
 * @returns {Promise<string>} the Bearer access token
 */
export async function acquireLocalBearerToken(baseUrl, options = {}) {
  const passphrase = options.passphrase
    ?? (process.env.FRIDAY_PHASE24_LOCAL_PASSPHRASE?.trim() || DEFAULT_LOCAL_PASSPHRASE);

  const statusBody = unwrapEnvelope(
    await readJsonBody(await fetch(`${baseUrl}/v1/auth/bootstrap/status`).catch(() => null)),
  );
  const bootstrapRequired = Boolean(
    statusBody && typeof statusBody === "object" && statusBody.bootstrapRequired,
  );
  if (bootstrapRequired) {
    await fetch(`${baseUrl}/v1/auth/bootstrap/local-passphrase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase }),
    }).catch(() => undefined);
  }

  const loginBody = unwrapEnvelope(
    await readJsonBody(await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ localPassphrase: passphrase }),
    }).catch(() => null)),
  );

  const token = loginBody && typeof loginBody === "object" && typeof loginBody.accessToken === "string"
    ? loginBody.accessToken
    : null;
  if (!token) {
    throw new Error(
      "phase24 local auth failed: /v1/auth/login did not issue an accessToken via the bootstrap-local-passphrase + login flow.",
    );
  }
  return token;
}
