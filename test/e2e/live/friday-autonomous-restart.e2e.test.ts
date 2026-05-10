import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { setModelRouting } from "./_helpers/api.js";
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
  createFridayDeepProofProvider,
  FRIDAY_DEEP_PROOF_GATED,
  FRIDAY_DEEP_PROOF_PROVIDER_LABEL,
  shutdownFridayDeepProofHubEnv,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

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

interface DeepProofProviderHandle {
  providerId: string;
  model: string;
}

async function ensureDeepProofProvider(env: RealHubEnv): Promise<DeepProofProviderHandle> {
  const result = await createFridayDeepProofProvider(env, {
    name: `${FRIDAY_DEEP_PROOF_PROVIDER_LABEL} Autonomous Restart Proof`,
  });
  await setModelRouting(env.baseUrl, env.accessToken, result.providerId, []);
  return { providerId: result.providerId, model: result.model };
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)(`Friday Autonomous Restart Matrix (${FRIDAY_DEEP_PROOF_PROVIDER_LABEL})`, () => {
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
    "proves planning interruption resume can keep exact content wording and deterministic file verification",
    { timeout: 240_000, retry: 1 },
    async () => {
      let env = await createFridayDeepProofHubEnv();
      envsToCleanup.push(env);
      const { providerId, model } = await ensureDeepProofProvider(env);
      const marker = `planning-content-${Date.now()}`;
      const outputPath = buildWorkspaceProofPath(env.stateDir!, `${marker}-planning-content-proof.txt`);
      const expected = `planning-content-restart-${marker}`;
      fs.rmSync(outputPath, { force: true });
      const goalDescription = `Marker ${marker}. Use only the write tool to create the file '${outputPath}' with the exact content '${expected}'. After that, verify the file '${outputPath}' exists and contains the exact content '${expected}'.`;
      const executePromise = env.hub!.autonomousEngine.executeGoal({
        description: goalDescription,
        providerId,
        model: model,
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
        model: model,
      });
      if (resumeResult.status !== "completed") {
        const failureGoal = readAutonomousGoal(env.stateDir!, goalId);
        const failureSteps = listAutonomousSteps(env.stateDir!, goalId);
        const failureIterations = env.hub!.autonomousEngine.getIterations(goalId);
        throw new Error(
          `Planning exact-content resume failed: ${JSON.stringify({
            stateDir: env.stateDir,
            resumeResult,
            failureGoal,
            failureSteps,
            failureIterations,
          })}`,
        );
      }

      const finalGoal = await waitForAutonomousSnapshot(
        env.stateDir!,
        goalId,
        ({ goal: currentGoal, steps }) =>
          currentGoal?.status === "completed"
          && steps.some((step) => step.status === "completed" && step.verificationMethod === "deterministic_file"),
        { intervalMs: 200, maxMs: 30_000 },
      );
      expect(finalGoal.goal.status).toBe("completed");
      expect(fs.readFileSync(outputPath, "utf8")).toBe(expected);
      const deterministicFileStep = finalGoal.steps.find((step) => step.verificationMethod === "deterministic_file");
      expect(deterministicFileStep).toEqual(expect.objectContaining({
        verificationMethod: "deterministic_file",
      }));
      expect([
        "with_content",
        "contains_content",
        "exact_content",
        "content_is",
        "contents_are",
        "content_colon",
        "contents_colon",
      ]).toContain(deterministicFileStep?.verificationPatternFamily);
      const wording = [
        deterministicFileStep?.instruction ?? "",
        deterministicFileStep?.verification?.description ?? "",
        deterministicFileStep?.verification?.expected ?? "",
      ].join(" ").toLowerCase();
      expect(wording).toContain("content");
      expect(wording).not.toContain("exact text");
    },
  );

  it(
    "marks planning interruption with exact text phrasing as recoverable and resumes to verified completion",
    { timeout: 240_000, retry: 1 },
    async () => {
      let env = await createFridayDeepProofHubEnv();
      envsToCleanup.push(env);
      const { providerId, model } = await ensureDeepProofProvider(env);
      const marker = `planning-${Date.now()}`;
      const outputPath = buildWorkspaceProofPath(env.stateDir!, `${marker}-planning-proof.txt`);
      const expected = `planning-restart-${marker}`;
      fs.rmSync(outputPath, { force: true });
      const goalDescription = `Marker ${marker}. Use only the write tool to create the file '${outputPath}' with the exact text '${expected}'. After that, verify the file '${outputPath}' exists and contains the exact text '${expected}'.`;
      const executePromise = env.hub!.autonomousEngine.executeGoal({
        description: goalDescription,
        providerId,
        model: model,
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
        model: model,
      });
      if (resumeResult.status !== "completed") {
        const failureGoal = readAutonomousGoal(env.stateDir!, goalId);
        const failureSteps = listAutonomousSteps(env.stateDir!, goalId);
        const failureIterations = env.hub!.autonomousEngine.getIterations(goalId);
        throw new Error(
          `Planning resume failed: ${JSON.stringify({
            stateDir: env.stateDir,
            resumeResult,
            failureGoal,
            failureSteps,
            failureIterations,
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
      const { providerId, model } = await ensureDeepProofProvider(env);
      const marker = `executing-${Date.now()}`;
      const outputPath = path.join(env.stateDir!, "autonomous-executing-proof.txt");
      const expected = `executing-restart-${marker}`;
      const goalDescription = `Marker ${marker}. Use the exec tool to run the exact shell command /bin/sh -lc "sleep 12; printf '${expected}' > '${outputPath}'". After that, verify the file '${outputPath}' exists and contains the exact text '${expected}'.`;
      const executePromise = env.hub!.autonomousEngine.executeGoal({
        description: goalDescription,
        providerId,
        model: model,
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
          model: model,
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
        const { providerId, model } = await ensureDeepProofProvider(env);
        const marker = `verifying-${Date.now()}`;
        const goalDescription = `Marker ${marker}. Use only the browser tool, not any desktop tool. Open '${staticPage.url}?autonomous_marker=${encodeURIComponent(marker)}' in the browser, stay on that page, and then verify visually that the Friday login page is shown and that a local sign-in option is visible to the user.`;
        const executePromise = env.hub!.autonomousEngine.executeGoal({
          description: goalDescription,
          providerId,
          model: model,
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
        expect(interruptedGoal?.failureReason).toContain("verification can be rerun and planning can be rebuilt safely");

        const stepsAfterRestart = listAutonomousSteps(env.stateDir!, goalId);
        expect(stepsAfterRestart.map((step) => step.id)).toEqual(stepIdsBeforeRestart);
        expect(
          stepsAfterRestart.every((step) => step.status === "interrupted_recoverable" || step.status === "completed"),
        ).toBe(true);

        const resumeResult = await env.hub!.autonomousEngine.resumeGoal({
          goalId,
          providerId,
          model: model,
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
