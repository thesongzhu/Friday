/**
 * B1-compose interop RUNNER — drives the REAL composition seam end-to-end as a subprocess of the
 * Rust interop test: the REAL X25519 SECRET resolver (`resolveRustAgentRunWsClientX25519Secret`,
 * reading FRIDAY_MASTER_KEY via the real `getMasterKey`) → the REAL service adapter
 * (`createFridayRustHubAgentRunSealedClientService`, DEFAULT `createClient` = the real sealed
 * client) → the REAL sealed client → the REAL Rust server. This is the ONE path the B1 client
 * interop did NOT cover (it drove the raw client; the adapter's own tests inject a MOCK client).
 *
 * The Rust test sets FRIDAY_MASTER_KEY to a fixture, re-derives the SAME pubkey via
 * `sha256(purpose ‖ key)` and enrolls it in the server peer-allowlist — so a passing dispatch
 * also LIVE-CHECKS that the resolver's derivation matches what the operator enrolls at 6b.
 *
 * Output contract (stdout, exactly one JSON line):
 *   success:     {"ok":true,"status":"finished","runId":"…","answerSha256":"…","answerLen":…}
 *   fail-closed: {"ok":false,"code":"…","httpStatus":503}
 *   no-secret:   {"ok":false,"code":"RESOLVER_NULL","httpStatus":0}
 *
 * NOTE: the adapter returns REFS-ONLY (no body — compose's body source is the slice-3 DB readback,
 * proven separately). So this runner asserts the refs (status/sha256/len), not a body.
 */
import { resolveRustAgentRunWsClientX25519Secret } from "../../src/api/mission-spine/friday-rust-hub-agent-run-ws-client-x25519-secret.js";
import { createFridayRustHubAgentRunSealedClientService } from "../../src/api/mission-spine/friday-rust-hub-agent-run-sealed-client-service.js";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const port = Number.parseInt(arg("port") ?? "", 10);
  const principal = arg("principal") ?? "";
  const runId = arg("run-id") ?? "run-compose-interop";
  const task = arg("task") ?? "ping";
  const timeoutMs = Number.parseInt(arg("timeout-ms") ?? "15000", 10);

  if (!Number.isFinite(port) || port <= 0) {
    process.stdout.write(JSON.stringify({ ok: false, code: "BAD_ARGS", httpStatus: 0 }) + "\n");
    process.exit(1);
    return;
  }

  // (1) REAL resolver — derives the X25519 secret from FRIDAY_MASTER_KEY via the real getMasterKey.
  const secret = resolveRustAgentRunWsClientX25519Secret();
  if (!secret || secret.length === 0) {
    process.stdout.write(JSON.stringify({ ok: false, code: "RESOLVER_NULL", httpStatus: 0 }) + "\n");
    process.exit(2);
    return;
  }

  // (2) REAL service adapter (default createClient = the real sealed client) → REAL server.
  const service = createFridayRustHubAgentRunSealedClientService({ host: "127.0.0.1", port, timeoutMs });

  try {
    const result = await service.dispatchRun({ runId, task, forwardedPrincipal: principal, clientSecret: secret });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        status: result.status,
        runId: result.runId,
        answerSha256: result.answerSha256 ?? null,
        answerLen: result.answerLen ?? null,
      }) + "\n",
    );
    process.exit(0);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN";
    const httpStatus =
      error && typeof error === "object" && "httpStatus" in error ? Number((error as { httpStatus: unknown }).httpStatus) : 0;
    process.stdout.write(JSON.stringify({ ok: false, code, httpStatus }) + "\n");
    process.exit(3);
  }
}

void main();
