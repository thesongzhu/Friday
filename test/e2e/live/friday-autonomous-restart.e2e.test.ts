import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LIVE_ANTHROPIC_MODEL, liveAnthropicCredentialMessage } from "../_helpers/live-anthropic.js";
import { createAnthropicProvider, setModelRouting } from "./_helpers/api.js";
import {
  listAutonomousSteps,
  readAutonomousGoal,
  waitForAutonomousGoalByDescriptionMarker,
  waitForAutonomousSnapshot,
} from "./_helpers/autonomous.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  createFridayDeepProofHubEnvFromStateDir,
  FRIDAY_DEEP_PROOF_ANTHROPIC_API_KEY_ENV_REF,
  FRIDAY_DEEP_PROOF_GATED,
  shutdownFridayDeepProofHubEnv,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

const ANTHROPIC_BASE_URL = process.env.E2E_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";

function buildWorkspaceProofPath(stateDir: string, name: string): string {
  const proofDir = path.join(stateDir, ".tmp", "autonomous-live-proofs");
  fs.mkdirSync(proofDir, { recursive: true });
  return path.join(proofDir, name);
}

async function startStaticProofServer(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Static proof server failed to bind");
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}/login`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function ensureAnthropicProvider(env: RealHubEnv): Promise<string> {
  const apiKeyEnvRef = FRIDAY_DEEP_PROOF_ANTHROPIC_API_KEY_ENV_REF
    ?? (() => { throw new Error(liveAnthropicCredentialMessage()); })();
  const providerId = await createAnthropicProvider(env.baseUrl, env.accessToken, {
    name: "Anthropic Autonomous Restart Proof",
    anthropicBaseUrl: ANTHROPIC_BASE_URL,
    models: [LIVE_ANTHROPIC_MODEL],
    defaultModel: LIVE_ANTHROPIC_MODEL,
    apiKeyEnvRef,
  });
  await setModelRouting(env.baseUrl, env.accessToken, providerId, []);
  return providerId;
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)("Friday Autonomous Restart Matrix (Anthropic API key)", () => {
  let envsToCleanup: RealHubEnv[] = [];

  afterEach(async () => {
    while (envsToCleanup.length > 0) {
      const env = envsToCleanup.pop();
      if (env) {
        await cleanupFridayDeepProofHubEnv(env);
      }
    }
  });

  it(
    "marks planning interruption as recoverable and resumes to verified completion",
    { timeout: 240_000, retry: 1 },
    async () => {
      let env = await createFridayDeepProofHubEnv();
      envsToCleanup.push(env);
      const providerId = await ensureAnthropicProvider(env);
      const marker = `planning-${Date.now()}`;
      const outputPath = buildWorkspaceProofPath(env.stateDir!, `${marker}-planning-proof.txt`);
      const expected = `planning-restart-${marker}`;
      fs.rmSync(outputPath, { force: true });
      const goalDescription = `Marker ${marker}. Use only the write tool to create the file '${outputPath}' with the exact text '${expected}'. After that, verify the file '${outputPath}' exists and contains the exact text '${expected}'.`;
      const executePromise = env.hub!.autonomousEngine.executeGoal({
        description: goalDescription,
        providerId,
        model: LIVE_ANTHROPIC_MODEL,
      });

      const goal = await waitForAutonomousGoalByDescriptionMarker(env.stateDir!, marker, { intervalMs: 100, maxMs: 20_000 });
      const goalId = goal.id;
      await waitForAutonomousSnapshot(
        env.stateDir!,
        goalId,
        ({ goal: currentGoal }) => currentGoal?.status === "planning",
        { intervalMs: 100, maxMs: 20_000 },
      );

      await shutdownFridayDeepProofHubEnv(env, { removeStateDir: false });
      envsToCleanup = envsToCleanup.filter((candidate) => candidate !== env);
      await executePromise.catch(() => null);

      env = await createFridayDeepProofHubEnvFromStateDir(env.stateDir!);
      envsToCleanup.push(env);

      const interruptedGoal = readAutonomousGoal(env.stateDir!, goalId);
      expect(interruptedGoal?.status).toBe("interrupted_recoverable");
      expect(interruptedGoal?.failureReason).toContain("plan can be rebuilt safely");

      const resumeResult = await env.hub!.autonomousEngine.resumeGoal({
        goalId,
        providerId,
        model: LIVE_ANTHROPIC_MODEL,
      });
      if (resumeResult.status !== "completed") {
        const failureGoal = readAutonomousGoal(env.stateDir!, goalId);
        const failureSteps = listAutonomousSteps(env.stateDir!, goalId);
        throw new Error(
          `Planning resume failed: ${JSON.stringify({
            stateDir: env.stateDir,
            resumeResult,
            failureGoal,
            failureSteps,
          })}`,
        );
      }

      const finalGoal = await waitForAutonomousSnapshot(
        env.stateDir!,
        goalId,
        ({ goal: currentGoal }) => currentGoal?.status === "completed",
        { intervalMs: 200, maxMs: 30_000 },
      );
      expect(finalGoal.goal.status).toBe("completed");
      expect(fs.readFileSync(outputPath, "utf8")).toBe(expected);
    },
  );

  it(
    "marks active execution interruption as nonrecoverable and rejects resume",
    { timeout: 240_000, retry: 1 },
    async () => {
      let env = await createFridayDeepProofHubEnv();
      envsToCleanup.push(env);
      const providerId = await ensureAnthropicProvider(env);
      const marker = `executing-${Date.now()}`;
      const outputPath = path.join(env.stateDir!, "autonomous-executing-proof.txt");
      const expected = `executing-restart-${marker}`;
      const goalDescription = `Marker ${marker}. Use the exec tool to run the exact shell command /bin/sh -lc "sleep 12; printf '${expected}' > '${outputPath}'". After that, verify the file '${outputPath}' exists and contains the exact text '${expected}'.`;
      const executePromise = env.hub!.autonomousEngine.executeGoal({
        description: goalDescription,
        providerId,
        model: LIVE_ANTHROPIC_MODEL,
      });

      const goal = await waitForAutonomousGoalByDescriptionMarker(env.stateDir!, marker, { intervalMs: 100, maxMs: 20_000 });
      const goalId = goal.id;
      const executingSnapshot = await waitForAutonomousSnapshot(
        env.stateDir!,
        goalId,
        ({ goal: currentGoal, steps }) =>
          currentGoal?.status === "executing"
          && steps.some((step) => step.status === "executing" && typeof step.plannedAction?.toolName === "string"),
        { intervalMs: 100, maxMs: 45_000 },
      );
      expect(executingSnapshot.steps.some((step) => step.plannedAction?.toolName === "exec")).toBe(true);

      await shutdownFridayDeepProofHubEnv(env, { removeStateDir: false });
      envsToCleanup = envsToCleanup.filter((candidate) => candidate !== env);
      await executePromise.catch(() => null);

      env = await createFridayDeepProofHubEnvFromStateDir(env.stateDir!);
      envsToCleanup.push(env);

      const interruptedGoal = readAutonomousGoal(env.stateDir!, goalId);
      expect(interruptedGoal?.status).toBe("interrupted_nonrecoverable");
      expect(interruptedGoal?.failureReason).toContain("safe resume checkpoint unavailable");

      await expect(
        env.hub!.autonomousEngine.resumeGoal({
          goalId,
          providerId,
          model: LIVE_ANTHROPIC_MODEL,
        }),
      ).rejects.toThrow("cannot be resumed safely");
      expect(fs.existsSync(outputPath)).toBe(false);
    },
  );

  it(
    "marks verifying interruption as recoverable, resumes same step, and avoids duplicate step rows",
    { timeout: 240_000, retry: 1 },
    async () => {
      const staticPage = await startStaticProofServer(`
        <!doctype html>
        <html lang="en">
          <head><meta charset="utf-8" /><title>Friday Login</title></head>
          <body>
            <main>
              <h1>Friday Login</h1>
              <p>Use your local sign-in option to continue.</p>
              <button type="button">Sign in locally</button>
            </main>
          </body>
        </html>
      `);
      let env = await createFridayDeepProofHubEnv();
      envsToCleanup.push(env);
      try {
        const providerId = await ensureAnthropicProvider(env);
        const marker = `verifying-${Date.now()}`;
        const goalDescription = `Marker ${marker}. Use only the browser tool, not any desktop tool. Open '${staticPage.url}?autonomous_marker=${encodeURIComponent(marker)}' in the browser, stay on that page, and then verify visually that the Friday login page is shown and that a local sign-in option is visible to the user.`;
        const executePromise = env.hub!.autonomousEngine.executeGoal({
          description: goalDescription,
          providerId,
          model: LIVE_ANTHROPIC_MODEL,
        });

        const goal = await waitForAutonomousGoalByDescriptionMarker(env.stateDir!, marker, { intervalMs: 100, maxMs: 20_000 });
        const goalId = goal.id;
        const verifyingSnapshot = await waitForAutonomousSnapshot(
          env.stateDir!,
          goalId,
          ({ goal: currentGoal, steps }) =>
            currentGoal?.status === "verifying"
            && steps.some((step) => step.status === "verifying"),
          { intervalMs: 100, maxMs: 45_000 },
        );
        const stepIdsBeforeRestart = verifyingSnapshot.steps.map((step) => step.id);
        expect(stepIdsBeforeRestart.length).toBeGreaterThan(0);

        await shutdownFridayDeepProofHubEnv(env, { removeStateDir: false });
        envsToCleanup = envsToCleanup.filter((candidate) => candidate !== env);
        await executePromise.catch(() => null);

        env = await createFridayDeepProofHubEnvFromStateDir(env.stateDir!);
        envsToCleanup.push(env);

        const interruptedGoal = readAutonomousGoal(env.stateDir!, goalId);
        expect(interruptedGoal?.status).toBe("interrupted_recoverable");
        expect(interruptedGoal?.failureReason).toContain("verification or planning can be replayed");

        const stepsAfterRestart = listAutonomousSteps(env.stateDir!, goalId);
        expect(stepsAfterRestart.map((step) => step.id)).toEqual(stepIdsBeforeRestart);
        expect(
          stepsAfterRestart.every((step) => step.status === "interrupted_recoverable" || step.status === "completed"),
        ).toBe(true);

        const resumeResult = await env.hub!.autonomousEngine.resumeGoal({
          goalId,
          providerId,
          model: LIVE_ANTHROPIC_MODEL,
        });
        if (resumeResult.status !== "completed") {
          const failureGoal = readAutonomousGoal(env.stateDir!, goalId);
          const failureSteps = listAutonomousSteps(env.stateDir!, goalId);
          throw new Error(
            `Verifying resume failed: ${JSON.stringify({
              stateDir: env.stateDir,
              resumeResult,
              failureGoal,
              failureSteps,
            })}`,
          );
        }

        const finalGoal = await waitForAutonomousSnapshot(
          env.stateDir!,
          goalId,
          ({ goal: currentGoal }) => currentGoal?.status === "completed",
          { intervalMs: 200, maxMs: 30_000 },
        );
        expect(finalGoal.goal.status).toBe("completed");
        expect(listAutonomousSteps(env.stateDir!, goalId).map((step) => step.id)).toEqual(stepIdsBeforeRestart);
        expect(listAutonomousSteps(env.stateDir!, goalId).some((step) => step.domain === "browser" || step.domain === "composite")).toBe(true);
      } finally {
        await staticPage.close();
      }
    },
  );
});
