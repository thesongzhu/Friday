/**
 * B1 interop RUNNER — the REAL sealed client, invoked as a subprocess by the Rust interop
 * test (`hub_agent_run_server.rs`, the `#[ignore]` interop test). It is esbuild-bundled to a
 * single `.mjs` (so `node` can run it without the repo's `#errors` import map / a build), then
 * the Rust test spawns `node <bundle> --port=… --secret-hex=… --principal=… --run-id=… --task=…`
 * and reads ONE JSON line from stdout describing the dispatch outcome.
 *
 * This drives `createFridayRustHubAgentRunSealedClient` UNCHANGED — the e2e proof is that the
 * REAL client speaks the REAL Rust server's sealed protocol (TS-seal → Rust-open, auth_proof
 * accepted, refs-only result settled). (leg-A decouple, #655 Part 4) The client now SETTLES on
 * the refs envelope ALONE and no longer surfaces the owner-sealed body frame, so this runner
 * reports the REFS (status/sha256/len) — NOT a body. The answer body is sourced by compose from
 * the owner-gated DB readback, proven separately.
 *
 * Output contract (stdout, exactly one JSON line):
 *   success: {"ok":true,"status":"…","runId":"…","answerSha256":"…","answerLen":…}
 *   fail-closed: {"ok":false,"code":"…","httpStatus":503}
 */
import { createFridayRustHubAgentRunSealedClient } from "../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const port = Number.parseInt(arg("port") ?? "", 10);
  const secretHex = arg("secret-hex") ?? "";
  const principal = arg("principal") ?? "";
  const runId = arg("run-id") ?? "run-interop";
  const task = arg("task") ?? "ping";
  const timeoutMs = Number.parseInt(arg("timeout-ms") ?? "15000", 10);

  if (!Number.isFinite(port) || port <= 0 || secretHex.length !== 64) {
    process.stdout.write(JSON.stringify({ ok: false, code: "BAD_ARGS", httpStatus: 0 }) + "\n");
    process.exit(1);
    return;
  }

  const client = createFridayRustHubAgentRunSealedClient({
    host: "127.0.0.1",
    port,
    clientSecret: new Uint8Array(Buffer.from(secretHex, "hex")),
    timeoutMs,
  });

  try {
    const result = await client.dispatchRun({ runId, task, forwardedPrincipal: principal });
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
