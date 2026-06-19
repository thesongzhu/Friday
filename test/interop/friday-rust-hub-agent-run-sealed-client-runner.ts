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
import { createFridayMissionSpineDispatchAdapter } from "../../src/api/mission-spine/friday-mission-spine-dispatch-adapter.js";
import { createFridayMemorySpineDispatchAdapter } from "../../src/api/mission-spine/friday-memory-spine-dispatch-adapter.js";
import { createFridayMissionAutoDispatchDriver } from "../../src/api/mission-spine/friday-mission-auto-dispatch-driver.js";
import { createFridayMissionSpineRoutes } from "../../src/api/http/routes/friday-mission-spine-routes.js";
import { createFridayMemorySpineRoutes } from "../../src/api/http/routes/friday-memory-spine-routes.js";
import {
  RUST_ROUTE_CLAUDE_MODEL,
  RUST_ROUTE_CLAUDE_PROVIDER_ID,
  RUST_ROUTE_CODEX_MODEL,
  RUST_ROUTE_CODEX_PROVIDER_ID,
  RUST_ROUTE_DEEPSEEK_FLASH_MODEL,
  RUST_ROUTE_DEEPSEEK_PROVIDER_ID,
} from "../../src/api/runtime/friday-rust-route-constants.js";
import type { MissionAutoDispatchStartRun } from "../../src/api/mission-spine/friday-mission-auto-dispatch-driver.js";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const mode = arg("mode") ?? "dispatch-run";
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
    if (mode === "auto-dispatch") {
      const intakeRequest = {
        fridayConversationId: arg("friday-conversation-id") ?? "fconv_interop_auto",
        ownerPrincipal: principal,
        surfaceThreadId: arg("surface-thread-id") ?? "surface-interop-auto",
        surfaceKind: "mobile",
        deliveryRoute: "interop://sealed-client/auto-dispatch",
        visibilityPolicy: "compact",
        missionId: arg("mission-id") ?? "mission-interop-auto",
        workItemId: arg("work-item-id") ?? "work-interop-auto",
        title: "Interop auto-dispatch mission",
        intent: "Drive the real TS auto-dispatch driver into the real Rust mission-bound seam",
        lane: "deepseek",
        targetProviderOrAgent: "deepseek",
        capabilityId: "ask_friday.deepseek",
        bodyRef: "friday://body/interop/auto-dispatch",
        includesSensitiveContext: false,
      };
      const intake = await client.intakeMission(intakeRequest);
      let dispatchedInput: Parameters<MissionAutoDispatchStartRun>[0] | undefined;
      let dispatchPromise: Promise<unknown> | undefined;
      let dispatchError: unknown;
      const driver = createFridayMissionAutoDispatchDriver({
        startRun: () => (input) => {
          dispatchedInput = input;
          dispatchPromise = client.dispatchRun({
            runId,
            task: input.task,
            forwardedPrincipal: input.principalId ?? principal,
            ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
            ...(input.missionContext !== undefined ? { missionContext: input.missionContext } : {}),
          });
          return dispatchPromise;
        },
        deepseekProviderId: RUST_ROUTE_DEEPSEEK_PROVIDER_ID,
        deepseekFlashModel: RUST_ROUTE_DEEPSEEK_FLASH_MODEL,
        codexProviderId: RUST_ROUTE_CODEX_PROVIDER_ID,
        codexModel: RUST_ROUTE_CODEX_MODEL,
        claudeProviderId: RUST_ROUTE_CLAUDE_PROVIDER_ID,
        claudeModel: RUST_ROUTE_CLAUDE_MODEL,
        onDispatchError: (error) => {
          dispatchError = error;
        },
      });
      driver.onIntakeReady(intakeRequest, intake);
      if (!dispatchPromise || !dispatchedInput) {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            code: "AUTO_DISPATCH_DID_NOT_START",
            httpStatus: 0,
            intakeStatus: intake.status,
          }) + "\n",
        );
        process.exit(5);
        return;
      }
      const result = await dispatchPromise;
      if (dispatchError) {
        throw dispatchError;
      }
      if (typeof result === "object" && result !== null && "outcome" in result && result.outcome === "paused") {
        process.stdout.write(JSON.stringify({ ok: false, code: "UNEXPECTED_PAUSE", httpStatus: 0 }) + "\n");
        process.exit(4);
        return;
      }
      const refs = result as {
        status?: string;
        runId?: string;
        answerSha256?: string;
        answerLen?: number;
      };
      process.stdout.write(
        JSON.stringify({
          ok: true,
          mode,
          intakeStatus: intake.status,
          intakeCreatedOrReady: intake.createdOrReady,
          runStatus: refs.status,
          runId: refs.runId,
          answerSha256: refs.answerSha256 ?? null,
          answerLen: refs.answerLen ?? null,
          task: dispatchedInput.task,
          providerId: dispatchedInput.providerId,
          model: dispatchedInput.model,
          constraints: dispatchedInput.constraints ?? null,
          allowedRustRouteTools: dispatchedInput.allowedRustRouteTools ?? [],
          missionContext: dispatchedInput.missionContext ?? null,
        }) + "\n",
      );
      process.exit(0);
      return;
    }

    if (mode === "mission-route-auto-dispatch") {
      const clientSecret = new Uint8Array(Buffer.from(secretHex, "hex"));
      const intakeRequest = {
        fridayConversationId: arg("friday-conversation-id") ?? "fconv_interop_route_auto",
        ownerPrincipal: principal,
        surfaceThreadId: arg("surface-thread-id") ?? "surface-interop-route-auto",
        surfaceKind: "mobile",
        deliveryRoute: "interop://mission-route/auto-dispatch",
        visibilityPolicy: "compact",
        missionId: arg("mission-id") ?? "mission-interop-route-auto",
        workItemId: arg("work-item-id") ?? "work-interop-route-auto",
        title: "Interop mission-route auto-dispatch mission",
        intent: "Drive the real HTTP mission-spine route into the real Rust mission-bound seam",
        lane: "deepseek",
        targetProviderOrAgent: "deepseek",
        capabilityId: "ask_friday.deepseek",
        bodyRef: "friday://body/interop/mission-route-auto-dispatch",
        includesSensitiveContext: false,
      };
      let dispatchedInput: Parameters<MissionAutoDispatchStartRun>[0] | undefined;
      let dispatchPromise: Promise<unknown> | undefined;
      let dispatchError: unknown;
      const driver = createFridayMissionAutoDispatchDriver({
        startRun: () => (input) => {
          dispatchedInput = input;
          dispatchPromise = client.dispatchRun({
            runId,
            task: input.task,
            forwardedPrincipal: input.principalId ?? principal,
            ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
            ...(input.missionContext !== undefined ? { missionContext: input.missionContext } : {}),
          });
          return dispatchPromise;
        },
        deepseekProviderId: RUST_ROUTE_DEEPSEEK_PROVIDER_ID,
        deepseekFlashModel: RUST_ROUTE_DEEPSEEK_FLASH_MODEL,
        codexProviderId: RUST_ROUTE_CODEX_PROVIDER_ID,
        codexModel: RUST_ROUTE_CODEX_MODEL,
        claudeProviderId: RUST_ROUTE_CLAUDE_PROVIDER_ID,
        claudeModel: RUST_ROUTE_CLAUDE_MODEL,
        onDispatchError: (error) => {
          dispatchError = error;
        },
      });
      const dispatch = createFridayMissionSpineDispatchAdapter({
        host: "127.0.0.1",
        port,
        timeoutMs,
        secretResolver: () => clientSecret,
        autoDispatchDriver: driver,
      });
      const route = createFridayMissionSpineRoutes({
        workbench: null,
        disabledReason: null,
        dispatch,
      }).find((candidate) => candidate.operationId === "mission.spine.intake.create");
      if (!route) {
        process.stdout.write(JSON.stringify({ ok: false, code: "MISSION_ROUTE_MISSING", httpStatus: 0 }) + "\n");
        process.exit(6);
        return;
      }
      const routeResponse = await route.handler({
        requestId: "req-interop-mission-route-auto-dispatch",
        receivedAt: new Date(0).toISOString(),
        params: {},
        query: {},
        body: intakeRequest,
        headers: {},
        principal: {
          principalType: "user",
          principalId: principal,
          userId: principal,
          role: "admin",
          scopes: ["hub.admin"],
        },
      } as never);
      const intake = (routeResponse as { result?: { status?: string; createdOrReady?: boolean } }).result;
      if (!dispatchPromise || !dispatchedInput) {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            code: "MISSION_ROUTE_AUTO_DISPATCH_DID_NOT_START",
            httpStatus: 0,
            intakeStatus: intake?.status ?? null,
          }) + "\n",
        );
        process.exit(5);
        return;
      }
      const result = await dispatchPromise;
      if (dispatchError) {
        throw dispatchError;
      }
      if (typeof result === "object" && result !== null && "outcome" in result && result.outcome === "paused") {
        process.stdout.write(JSON.stringify({ ok: false, code: "UNEXPECTED_PAUSE", httpStatus: 0 }) + "\n");
        process.exit(4);
        return;
      }
      const refs = result as {
        status?: string;
        runId?: string;
        answerSha256?: string;
        answerLen?: number;
      };
      process.stdout.write(
        JSON.stringify({
          ok: true,
          mode,
          intakeStatus: intake?.status ?? null,
          intakeCreatedOrReady: intake?.createdOrReady ?? null,
          runStatus: refs.status,
          runId: refs.runId,
          answerSha256: refs.answerSha256 ?? null,
          answerLen: refs.answerLen ?? null,
          task: dispatchedInput.task,
          providerId: dispatchedInput.providerId,
          model: dispatchedInput.model,
          constraints: dispatchedInput.constraints ?? null,
          allowedRustRouteTools: dispatchedInput.allowedRustRouteTools ?? [],
          missionContext: dispatchedInput.missionContext ?? null,
        }) + "\n",
      );
      process.exit(0);
      return;
    }

    if (mode === "memory-route-decision") {
      const clientSecret = new Uint8Array(Buffer.from(secretHex, "hex"));
      const memoryId = arg("memory-id") ?? "mem-interop-route";
      const decision = arg("decision") ?? "confirm";
      const dispatch = createFridayMemorySpineDispatchAdapter({
        host: "127.0.0.1",
        port,
        timeoutMs,
        secretResolver: () => clientSecret,
      });
      const route = createFridayMemorySpineRoutes({ dispatch }).find(
        (candidate) => candidate.operationId === "memory.spine.decide.apply",
      );
      if (!route) {
        process.stdout.write(JSON.stringify({ ok: false, code: "MEMORY_ROUTE_MISSING", httpStatus: 0 }) + "\n");
        process.exit(6);
        return;
      }
      const routeResponse = await route.handler({
        requestId: "req-interop-memory-route-decision",
        receivedAt: new Date(0).toISOString(),
        params: {},
        query: {},
        body: {
          memoryId,
          ownerPrincipal: principal,
          decision,
        },
        headers: {},
        principal: {
          principalType: "user",
          principalId: principal,
          userId: principal,
          role: "admin",
          scopes: ["hub.admin"],
        },
      } as never);
      const result = (routeResponse as { result?: unknown }).result as
        | {
            memoryId?: string;
            state?: string;
            status?: string;
            blocker?: string;
            recallable?: boolean;
          }
        | undefined;
      process.stdout.write(
        JSON.stringify({
          ok: true,
          mode,
          result: result ?? null,
        }) + "\n",
      );
      process.exit(0);
      return;
    }

    if (mode === "mission-route-lifecycle-workitem") {
      const clientSecret = new Uint8Array(Buffer.from(secretHex, "hex"));
      const missionId = arg("mission-id") ?? "mission-ns5";
      const workItemId = arg("work-item-id") ?? "work-ns5";
      const dispatch = createFridayMissionSpineDispatchAdapter({
        host: "127.0.0.1",
        port,
        timeoutMs,
        secretResolver: () => clientSecret,
      });
      const routes = createFridayMissionSpineRoutes({
        workbench: null,
        disabledReason: null,
        dispatch,
      });
      const lifecycleRoute = routes.find(
        (candidate) => candidate.operationId === "mission.spine.lifecycle.transition",
      );
      const workItemRoute = routes.find(
        (candidate) => candidate.operationId === "mission.spine.workitem.status.transition",
      );
      if (!lifecycleRoute || !workItemRoute) {
        process.stdout.write(JSON.stringify({ ok: false, code: "MISSION_ROUTE_MISSING", httpStatus: 0 }) + "\n");
        process.exit(6);
        return;
      }
      const principalContext = {
        principalType: "user",
        principalId: principal,
        userId: principal,
        role: "admin",
        scopes: ["hub.admin"],
      };
      const workItemResponse = await workItemRoute.handler({
        requestId: "req-interop-mission-route-workitem",
        receivedAt: new Date(0).toISOString(),
        params: { workItemId },
        query: {},
        body: {
          targetStatus: "dispatched",
          actorRef: principal,
          reason: "interop route work-item transition",
        },
        headers: {},
        principal: principalContext,
      } as never);
      const lifecycleResponse = await lifecycleRoute.handler({
        requestId: "req-interop-mission-route-lifecycle",
        receivedAt: new Date(0).toISOString(),
        params: { missionId },
        query: {},
        body: {
          fridayConversationId: arg("friday-conversation-id") ?? "fconv_ns5_intake",
          targetStatus: "paused",
          actorRef: principal,
          reason: "interop route lifecycle transition",
        },
        headers: {},
        principal: principalContext,
      } as never);
      process.stdout.write(
        JSON.stringify({
          ok: true,
          mode,
          lifecycle: (lifecycleResponse as { result?: unknown }).result ?? null,
          workItem: (workItemResponse as { result?: unknown }).result ?? null,
        }) + "\n",
      );
      process.exit(0);
      return;
    }

    const result = await client.dispatchRun({ runId, task, forwardedPrincipal: principal });
    // (A3 courier) dispatch returns a discriminated union (result | paused). This runner drives the
    // read-only path with the run-control flag OFF, so a paused outcome is unreachable here — narrow
    // on the `outcome` discriminant so the answer refs are read only on the result member.
    if ("outcome" in result && result.outcome === "paused") {
      process.stdout.write(JSON.stringify({ ok: false, code: "UNEXPECTED_PAUSE", httpStatus: 0 }) + "\n");
      process.exit(4);
    }
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
    const message = error instanceof Error ? error.message : undefined;
    process.stdout.write(JSON.stringify({ ok: false, code, httpStatus, ...(message ? { message } : {}) }) + "\n");
    process.exit(3);
  }
}

void main();
