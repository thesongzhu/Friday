/**
 * Cloud-target live E2E scenarios.
 *
 * Gated by:
 *   FRIDAY_E2E_TARGET=cloud
 *   and (FRIDAY_E2E_LIVE_OPENAI=1 or FRIDAY_E2E_LIVE_OLLAMA=1)
 *
 * Designed for shared environments:
 * - All created resources are prefixed with an isolated run namespace
 * - Cleanup is best-effort and prefix-scoped by default
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CODE_MODEL,
  E2E_GATED,
  FAST_MODEL,
  LIVE_PROVIDER_KIND,
  LIVE_TARGET,
  OLLAMA_BASE_URL,
  OPENAI_API_KEY_ENV,
  OPENAI_BASE_URL,
  cleanupRealHubEnv,
  createRealHubEnv,
  type RealHubEnv,
} from "./_helpers/real-env.js";
import {
  apiFetch,
  ensureOllamaProviders,
  ensureOpenAiProviders,
  setModelRouting,
} from "./_helpers/api.js";
import { getCloudE2eConfig } from "./_helpers/cloud-env.js";
import type { WorkflowGraph } from "./_helpers/workflow.js";
import { createPublishRunWorkflow } from "./_helpers/workflow.js";

const CLOUD_GATED = E2E_GATED && LIVE_TARGET === "cloud";

function normalizeNamespaceSegment(input: string, maxLength = 32): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = normalized.slice(0, maxLength).replace(/-+$/g, "");
  return trimmed.length > 0 ? trimmed : "cloud";
}

describe.skipIf(!CLOUD_GATED)(
  `Friday Cloud Journeys E2E (${LIVE_PROVIDER_KIND === "openai" ? "OpenAI" : "Ollama"})`,
  () => {
    let env: RealHubEnv;
    let runPrefix = "cloud-e2e";
    let memoryNamespace = "cloud-e2e-memory";
    let originalRouting:
      | {
          defaultProviderId: string;
          fallbackProviderIds: string[];
        }
      | undefined;

    async function listProviders(): Promise<Array<{ id: string; name: string }>> {
      const response = await apiFetch<{
        ok: boolean;
        data: {
          items: Array<{ id: string; name: string }>;
        };
      }>(env.baseUrl, env.accessToken, "GET", "/v1/providers");

      if (response.status !== 200 || !response.json.ok) {
        throw new Error(`Failed to list providers: ${JSON.stringify(response.json)}`);
      }

      return response.json.data.items;
    }

    async function deleteProvider(providerId: string): Promise<void> {
      const response = await apiFetch<{ ok: boolean }>(
        env.baseUrl,
        env.accessToken,
        "DELETE",
        `/v1/providers/${providerId}`,
      );

      if (response.status === 404) {
        return;
      }
      if (response.status !== 200 || !response.json.ok) {
        throw new Error(`Failed to delete provider ${providerId}: ${JSON.stringify(response.json)}`);
      }
    }

    async function listWorkflowsByPrefix(prefix: string): Promise<Array<{ id: string; slug: string }>> {
      const response = await apiFetch<{
        ok: boolean;
        data: {
          items: Array<{ id: string; slug: string }>;
        };
      }>(env.baseUrl, env.accessToken, "GET", "/v1/workflows?limit=100");

      if (response.status !== 200 || !response.json.ok) {
        throw new Error(`Failed to list workflows: ${JSON.stringify(response.json)}`);
      }

      return response.json.data.items.filter((workflow) => workflow.slug.startsWith(prefix));
    }

    async function archiveWorkflow(workflowId: string): Promise<void> {
      const response = await apiFetch<{ ok: boolean }>(
        env.baseUrl,
        env.accessToken,
        "DELETE",
        `/v1/workflows/${workflowId}`,
      );

      if (response.status === 404) {
        return;
      }
      if (response.status !== 200 || !response.json.ok) {
        throw new Error(`Failed to archive workflow ${workflowId}: ${JSON.stringify(response.json)}`);
      }
    }

    async function cleanupCloudArtifacts(prefix: string): Promise<void> {
      // 1) Restore original routing before removing prefix providers.
      if (originalRouting) {
        try {
          await setModelRouting(
            env.baseUrl,
            env.accessToken,
            originalRouting.defaultProviderId,
            originalRouting.fallbackProviderIds,
          );
        } catch {
          // Keep cleanup best-effort; deletion still continues.
        }
      }

      // 2) Archive all workflows created by this run.
      const workflows = await listWorkflowsByPrefix(prefix);
      for (const workflow of workflows) {
        try {
          await archiveWorkflow(workflow.id);
        } catch {
          // best-effort
        }
      }

      // 3) Delete all providers created by this run.
      const providers = await listProviders();
      const scopedProviders = providers.filter((provider) => provider.name.startsWith(prefix));
      for (const provider of scopedProviders) {
        try {
          await deleteProvider(provider.id);
        } catch {
          // best-effort
        }
      }

      // 4) Prune namespace-scoped memory.
      try {
        await apiFetch<{
          ok: boolean;
        }>(
          env.baseUrl,
          env.accessToken,
          "POST",
          "/v1/memory/prune",
          { namespace: memoryNamespace, dryRun: false },
        );
      } catch {
        // best-effort
      }
    }

    beforeAll(async () => {
      const cloudConfig = getCloudE2eConfig();
      if (!cloudConfig) {
        throw new Error("Cloud E2E requires FRIDAY_E2E_TARGET=cloud and cloud env contract");
      }

      const namespaceSeed = normalizeNamespaceSegment(cloudConfig.namespace, 16);
      const runSuffix = normalizeNamespaceSegment(Date.now().toString(36), 10);
      runPrefix = `${namespaceSeed}-${runSuffix}`;

      // Memory namespace uses dot-separated short segments so each segment
      // stays within memory guard constraints.
      memoryNamespace = `cloud.${namespaceSeed}.${runSuffix}`;

      env = await createRealHubEnv();
      if (env.target !== "cloud") {
        throw new Error("Cloud suite expected env.target=cloud");
      }

      const routingRes = await apiFetch<{
        ok: boolean;
        data: {
          routing: {
            defaultProviderId: string;
            fallbackProviderIds: string[];
          };
        };
      }>(env.baseUrl, env.accessToken, "GET", "/v1/model-routing");

      if (routingRes.status === 200 && routingRes.json.ok) {
        originalRouting = {
          defaultProviderId: routingRes.json.data.routing.defaultProviderId,
          fallbackProviderIds: routingRes.json.data.routing.fallbackProviderIds,
        };
      }

      if (LIVE_PROVIDER_KIND === "openai") {
        await ensureOpenAiProviders(
          env.baseUrl,
          env.accessToken,
          OPENAI_BASE_URL,
          FAST_MODEL,
          CODE_MODEL,
          `$${OPENAI_API_KEY_ENV}`,
          { namePrefix: runPrefix },
        );
      } else {
        await ensureOllamaProviders(
          env.baseUrl,
          env.accessToken,
          OLLAMA_BASE_URL,
          FAST_MODEL,
          CODE_MODEL,
          { namePrefix: runPrefix },
        );
      }
    }, 120_000);

    afterAll(async () => {
      if (!env) {
        return;
      }

      const cloudConfig = getCloudE2eConfig();
      const allowDestructive = cloudConfig?.allowDestructive ?? false;

      // Current cleanup remains prefix-scoped even in destructive mode.
      // Keep this guard to make future broad cleanup explicit in code review.
      if (allowDestructive) {
        await cleanupCloudArtifacts(runPrefix);
      } else {
        await cleanupCloudArtifacts(runPrefix);
      }

      await cleanupRealHubEnv(env);
    }, 180_000);

    it("Scenario C1: cloud target is reachable and authenticated", async () => {
      const healthRes = await fetch(`${env.baseUrl}/v1/health`);
      expect(healthRes.status).toBe(200);
      const healthJson = (await healthRes.json()) as {
        ok?: boolean;
      };
      expect(healthJson.ok).toBe(true);

      const meRes = await apiFetch<{
        ok: boolean;
        data: {
          user: {
            id: string;
            role: string;
          };
          scopes: string[];
        };
      }>(env.baseUrl, env.accessToken, "GET", "/v1/auth/me");

      expect(meRes.status).toBe(200);
      expect(meRes.json.ok).toBe(true);
      expect(typeof meRes.json.data.user.id).toBe("string");
      expect(meRes.json.data.scopes.length).toBeGreaterThan(0);
    });

    it("Scenario C2: run cloud workflow with AI node and verify node output", async () => {
      const slug = `${runPrefix}-ai-ping`;
      const graph: WorkflowGraph = {
        nodes: [
          {
            id: "trigger1",
            type: "trigger",
            label: "Manual Trigger",
            config: { triggerType: "manual" },
          },
          {
            id: "ai1",
            type: "ai",
            label: "AI Node",
            config: {
              prompt: "Return a compact JSON object with key status and value ok.",
              model: FAST_MODEL,
            },
          },
          {
            id: "data1",
            type: "data",
            label: "Collector",
            config: {
              mapping: {
                aiResponse: "$steps.ai1.output",
              },
            },
          },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger1", targetNodeId: "ai1" },
          { id: "e2", sourceNodeId: "ai1", targetNodeId: "data1" },
        ],
      };

      const runResult = await createPublishRunWorkflow(env.baseUrl, env.accessToken, {
        slug,
        name: `Cloud AI Ping ${slug}`,
        graph,
        pollMaxMs: 120_000,
      });

      expect(runResult.run.status).toBe("completed");

      const nodesRes = await apiFetch<{
        ok: boolean;
        data: {
          items: Array<{
            nodeId: string;
            status: string;
            output: unknown;
          }>;
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/workflow-runs/${runResult.run.id}/nodes?limit=20`,
      );

      expect(nodesRes.status).toBe(200);
      expect(nodesRes.json.ok).toBe(true);
      const aiNode = nodesRes.json.data.items.find((item) => item.nodeId === "ai1");
      expect(aiNode).toBeDefined();
      expect(aiNode?.status).toBe("completed");
      expect(aiNode?.output).toBeTruthy();
    }, 180_000);

    it("Scenario C3: evidence export/download works and unauthenticated access is denied", async () => {
      const slug = `${runPrefix}-evidence`;
      const graph: WorkflowGraph = {
        nodes: [
          {
            id: "trigger1",
            type: "trigger",
            label: "Manual Trigger",
            config: { triggerType: "manual" },
          },
          {
            id: "ai1",
            type: "ai",
            label: "AI Node",
            config: {
              prompt: "Return plain text: evidence-ready",
              model: FAST_MODEL,
            },
          },
        ],
        edges: [{ id: "e1", sourceNodeId: "trigger1", targetNodeId: "ai1" }],
      };

      const runResult = await createPublishRunWorkflow(env.baseUrl, env.accessToken, {
        slug,
        name: `Cloud Evidence ${slug}`,
        graph,
        pollMaxMs: 120_000,
      });
      expect(runResult.run.status).toBe("completed");

      const evidenceRes = await apiFetch<{
        ok: boolean;
        data: {
          summary: {
            totalEvents: number;
          };
        };
      }>(env.baseUrl, env.accessToken, "GET", `/v1/workflow-runs/${runResult.run.id}/evidence`);
      expect(evidenceRes.status).toBe(200);
      expect(evidenceRes.json.ok).toBe(true);
      expect(evidenceRes.json.data.summary.totalEvents).toBeGreaterThan(0);

      const exportRes = await apiFetch<{
        ok: boolean;
        data: {
          export: {
            exportId: string;
          };
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/workflow-runs/${runResult.run.id}/evidence/exports`,
        {},
      );
      expect(exportRes.status).toBe(200);
      expect(exportRes.json.ok).toBe(true);
      const exportId = exportRes.json.data.export.exportId;
      expect(typeof exportId).toBe("string");

      const downloadRes = await apiFetch<{
        ok: boolean;
        data: {
          file: {
            exists: boolean;
          };
          content: string;
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/workflow-runs/${runResult.run.id}/evidence/exports/${exportId}/download`,
      );
      expect(downloadRes.status).toBe(200);
      expect(downloadRes.json.ok).toBe(true);
      expect(downloadRes.json.data.file.exists).toBe(true);
      expect(downloadRes.json.data.content.length).toBeGreaterThan(2);

      const unauthenticated = await fetch(
        `${env.baseUrl}/v1/workflow-runs/${runResult.run.id}/evidence/exports/${exportId}/download`,
        {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        },
      );
      expect([401, 403]).toContain(unauthenticated.status);
    }, 180_000);

    it("Scenario C4: namespace-scoped memory CRUD works", async () => {
      const storeRes = await apiFetch<{
        ok: boolean;
        data: {
          item: {
            id: string;
            namespace: string;
          };
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/memory/store",
        {
          namespace: memoryNamespace,
          content: `Cloud E2E memory marker ${runPrefix}`,
          source: "cloud-e2e",
          tags: ["cloud-e2e", runPrefix],
        },
      );

      expect(storeRes.status).toBe(200);
      expect(storeRes.json.ok).toBe(true);
      const persistedNamespace = storeRes.json.data.item.namespace;
      expect(
        persistedNamespace === memoryNamespace ||
          persistedNamespace.endsWith(`.${memoryNamespace}`),
      ).toBe(true);

      const searchRes = await apiFetch<{
        ok: boolean;
        data: {
          items: Array<{
            item: {
              id: string;
              namespace: string;
              content: string;
            };
            score: number;
          }>;
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/memory/search",
        {
          query: runPrefix,
          namespace: memoryNamespace,
          limit: 10,
        },
      );

      expect(searchRes.status).toBe(200);
      expect(searchRes.json.ok).toBe(true);
      expect(searchRes.json.data.items.length).toBeGreaterThan(0);
      expect(
        searchRes.json.data.items.some(
          (item) =>
            item.item.namespace === memoryNamespace ||
            item.item.namespace.endsWith(`.${memoryNamespace}`),
        ),
      ).toBe(true);

      const pruneRes = await apiFetch<{
        ok: boolean;
        data: {
          result: {
            deletedCount: number;
            dryRun: boolean;
          };
        };
      }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        "/v1/memory/prune",
        {
          namespace: memoryNamespace,
          dryRun: false,
        },
      );

      expect(pruneRes.status).toBe(200);
      expect(pruneRes.json.ok).toBe(true);
      expect(pruneRes.json.data.result.dryRun).toBe(false);
      expect(pruneRes.json.data.result.deletedCount).toBeGreaterThanOrEqual(1);
    }, 120_000);

  },
);
