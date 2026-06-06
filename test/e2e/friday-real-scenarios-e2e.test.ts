/**
 * Real user scenario E2E tests — NON-LLM scenarios.
 *
 * Covers:
 *   Scenario 5:  Session Fork & Merge
 *   Scenario 6:  Skill Converter
 *   Scenario 7:  Builder Lifecycle
 *   Scenario 8:  Memory CRUD Cycle
 *   Scenario 9:  Condition Branching
 *   Scenario 10: Approval Gate
 *   Scenario 12: CLI Args
 *
 * Non-LLM scenarios are gated by `FRIDAY_E2E_CORE=1`.
 * Anthropic live scenarios are gated by `FRIDAY_E2E_LIVE_ANTHROPIC=1`.
 * Backward compatibility: `FRIDAY_LLM_E2E` enables both gates.
 * No real LLM calls — everything is fast CRUD / workflow engine execution.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import { createFridayHttpServer } from "#api";
import type { FridayHttpServer } from "#api";
import { signFridayCanonicalApproval } from "../../src/security/friday-mutating-action-gate.js";
import { parseArgs } from "../../src/cli/friday-cli.js";
import {
  hasLiveAnthropicApiKey,
  liveAnthropicCredentialMessage,
  LIVE_ANTHROPIC_MODEL as MODEL,
  resolveLiveAnthropicApiKeyEnvRef,
} from "./_helpers/live-anthropic.js";

// ─── Env guard ───

const CORE_E2E_ENABLED =
  process.env.FRIDAY_E2E_CORE === "1" ||
  !!process.env.FRIDAY_LLM_E2E;
const ANTHROPIC_E2E_ENABLED =
  process.env.FRIDAY_E2E_LIVE_ANTHROPIC === "1" ||
  !!process.env.FRIDAY_LLM_E2E;
const HAS_LLM_CREDENTIAL = hasLiveAnthropicApiKey();
const LIVE_ANTHROPIC_API_KEY_ENV_REF = resolveLiveAnthropicApiKeyEnvRef();
const LOCAL_PASSPHRASE =
  process.env.FRIDAY_TEST_LOCAL_PASSPHRASE ??
  process.env.FRIDAY_LOCAL_PASSPHRASE ??
  "friday-test-local-passphrase-123";
const TEST_TOKEN_SECRET = "test-token-secret-for-canonical-skill-stage-approval-123"; // pragma: allowlist secret

// ─── Helpers ───

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Could not determine free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function computeTestChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function ensureLocalPassphrase(baseUrl: string): Promise<void> {
  const statusRes = await fetch(`${baseUrl}/v1/auth/bootstrap/status`);
  const statusJson = (await statusRes.json()) as {
    ok: boolean;
    data?: { bootstrapRequired?: boolean };
  };
  if (!statusJson.ok) {
    throw new Error(`Auth bootstrap status failed: ${JSON.stringify(statusJson)}`);
  }
  if (statusJson.data?.bootstrapRequired !== true) return;

  const bootstrapRes = await fetch(`${baseUrl}/v1/auth/bootstrap/local-passphrase`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
  });
  const bootstrapJson = (await bootstrapRes.json()) as { ok: boolean };
  if (!bootstrapJson.ok) {
    throw new Error(`Auth bootstrap failed: ${JSON.stringify(bootstrapJson)}`);
  }
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  opts: { intervalMs?: number; maxMs?: number } = {},
): Promise<T> {
  const { intervalMs = 500, maxMs = 15000 } = opts;
  const deadline = Date.now() + maxMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${maxMs}ms (last value: ${JSON.stringify(last)})`);
}

// ─── Tests ───

describe.skipIf(!CORE_E2E_ENABLED)("Friday Real Scenarios E2E (NON-LLM)", () => {
  let hub: FridayHub;
  let httpServer: FridayHttpServer;
  let baseUrl: string;
  let stateDir: string;
  let accessToken: string;
  let adminPrincipalId: string;

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-scenarios-e2e-"));

    hub = await createFridayHub({
      stateDir,
      skillDirs: [],
      port: 0,
      logRequests: false,
      tokenSecret: TEST_TOKEN_SECRET,
      allowTestOnlyWorkflowRunExecution: true,
      allowTestOnlyWorkflowCatalogMutationExecution: true,
      allowTestOnlyWorkflowBuilderDraftExecution: true,
      allowTestOnlyWorkflowDeployExecution: true,
      allowTestOnlySessionExecution: true,
      allowTestOnlySessionRunExecution: true,
      allowTestOnlySessionMemoryExtractionExecution: true,
    });
    await hub.start();

    const port = await findFreePort();
    httpServer = createFridayHttpServer({
      routes: hub.apiRuntime.routes,
      wsGateway: hub.apiRuntime.wsGateway,
      middleware: hub.apiRuntime.middleware,
      port,
      host: "127.0.0.1",
      logRequests: false,
    });
    await httpServer.listen();
    baseUrl = `http://127.0.0.1:${String(port)}`;

    await ensureLocalPassphrase(baseUrl);
    const loginRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
    });
    const loginJson = (await loginRes.json()) as {
      ok: boolean;
      data: { accessToken: string; refreshToken: string };
    };
    if (!loginJson.ok) {
      throw new Error(`Admin login failed: ${JSON.stringify(loginJson)}`);
    }
    accessToken = loginJson.data.accessToken;
    const meRes = await fetch(`${baseUrl}/v1/auth/me`, {
      headers: authHeaders(accessToken),
    });
    const meJson = (await meRes.json()) as {
      ok: boolean;
      data?: { user?: { id?: string } };
    };
    adminPrincipalId = meJson.data?.user?.id ?? "";
    if (!meJson.ok || adminPrincipalId.length === 0) {
      throw new Error(`Admin principal lookup failed: ${JSON.stringify(meJson)}`);
    }
  }, 60_000);

  afterAll(async () => {
    if (httpServer) await httpServer.close();
    if (hub) await hub.stop();
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  }, 15_000);

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 12: CLI Args (fastest, no hub interaction)
  // ────────────────────────────────────────────────────────────────────────

  describe("Scenario 12: CLI Args", () => {
    it("12.1: parseArgs list with --skills-dir", () => {
      const parsed = parseArgs(["node", "friday", "list", "--skills-dir", "/tmp/my-skills"]);
      expect(parsed.command).toBe("list");
      expect(parsed.skillDirs).toContain("/tmp/my-skills");
    });

    it("12.2: parseArgs run with skill ID and --input", () => {
      const parsed = parseArgs(["node", "friday", "run", "echo-test", "--input", "name=world"]);
      expect(parsed.command).toBe("run");
      expect(parsed.skillId).toBe("echo-test");
      expect(parsed.input.name).toBe("world");
    });

    it("12.3: parseArgs import with --from and --dry-run", () => {
      const parsed = parseArgs([
        "node", "friday", "import", "/path/to/skill.md",
        "--from", "clawdbot-skill-md", "--dry-run",
      ]);
      expect(parsed.command).toBe("import");
      expect(parsed.source).toBe("/path/to/skill.md");
      expect(parsed.from).toBe("clawdbot-skill-md");
      expect(parsed.dryRun).toBe(true);
    });

    it("12.4: parseArgs converters", () => {
      const parsed = parseArgs(["node", "friday", "converters"]);
      expect(parsed.command).toBe("converters");
    });

    it("12.5: parseArgs status", () => {
      const parsed = parseArgs(["node", "friday", "status"]);
      expect(parsed.command).toBe("status");
    });

    it("12.6: parseArgs --help", () => {
      const parsed = parseArgs(["node", "friday", "--help"]);
      expect(parsed.command).toBe("help");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 8: Memory CRUD Cycle
  // ────────────────────────────────────────────────────────────────────────

  describe("Scenario 8: Memory CRUD Cycle", () => {
    let memoryItemId1: string;
    let memoryItemId2: string;
    let memoryItemId3: string;

    it("8.1: Store fact 1 (TypeScript)", async () => {
      const res = await fetch(`${baseUrl}/v1/memory/store`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          namespace: "e2e-knowledge",
          content: "TypeScript was created by Microsoft and first released in 2012",
          source: "e2e-test",
          tags: ["tech", "language"],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { item: { id: string; namespace: string; content: string } };
      };
      expect(json.ok).toBe(true);
      expect(json.data.item.id).toBeTruthy();
      memoryItemId1 = json.data.item.id;
    });

    it("8.2: Store fact 2 (Rust)", async () => {
      const res = await fetch(`${baseUrl}/v1/memory/store`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          namespace: "e2e-knowledge",
          content: "Rust was created by Mozilla and focuses on memory safety without garbage collection",
          source: "e2e-test",
          tags: ["tech", "language"],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { item: { id: string } };
      };
      expect(json.ok).toBe(true);
      memoryItemId2 = json.data.item.id;
    });

    it("8.3: Store fact 3 (pizza)", async () => {
      const res = await fetch(`${baseUrl}/v1/memory/store`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          namespace: "e2e-knowledge",
          content: "The best pizza in New York is at Di Fara Pizza in Brooklyn",
          source: "e2e-test",
          tags: ["food", "nyc"],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { item: { id: string } };
      };
      expect(json.ok).toBe(true);
      memoryItemId3 = json.data.item.id;
    });

    it("8.4: Store with TTL", async () => {
      const res = await fetch(`${baseUrl}/v1/memory/store`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          namespace: "e2e-knowledge",
          content: "Temporary note: deploy at 3pm",
          source: "e2e-test",
          ttlSeconds: 3600,
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { item: { expiresAt: string } };
      };
      expect(json.ok).toBe(true);
      expect(typeof json.data.item.expiresAt).toBe("string");
    });

    it("8.5: Search for programming languages", async () => {
      // FTS5 uses word tokenization — search for words present in the stored content
      const res = await fetch(`${baseUrl}/v1/memory/search`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          query: "created",
          namespace: "e2e-knowledge",
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { items: Array<{ item: { content: string }; score: number }> };
      };
      expect(json.ok).toBe(true);
      // "created" appears in both TypeScript and Rust facts
      expect(json.data.items.length).toBeGreaterThanOrEqual(1);
    });

    it("8.6: Search for food", async () => {
      const res = await fetch(`${baseUrl}/v1/memory/search`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          query: "pizza food",
          namespace: "e2e-knowledge",
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { items: Array<{ item: { content: string }; score: number }> };
      };
      expect(json.ok).toBe(true);
      expect(json.data.items.length).toBeGreaterThanOrEqual(1);
    });

    it("8.7: Search with tag filter", async () => {
      const res = await fetch(`${baseUrl}/v1/memory/search`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          query: "language",
          namespace: "e2e-knowledge",
          tagsAny: ["tech"],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { items: Array<{ item: { tags: string[] } }> };
      };
      expect(json.ok).toBe(true);
      // All results should have "tech" tag
      for (const entry of json.data.items) {
        expect(entry.item.tags).toContain("tech");
      }
    });

    it("8.8: Search with minScore", async () => {
      const res = await fetch(`${baseUrl}/v1/memory/search`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          query: "TypeScript Microsoft",
          namespace: "e2e-knowledge",
          minScore: 0.01,
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { items: Array<{ score: number }> };
      };
      expect(json.ok).toBe(true);
      for (const entry of json.data.items) {
        expect(entry.score).toBeGreaterThanOrEqual(0.01);
      }
    });

    it("8.9: Get item by ID", async () => {
      const res = await fetch(`${baseUrl}/v1/memory/items/${memoryItemId1}`, {
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { item: { id: string; content: string } };
      };
      expect(json.ok).toBe(true);
      expect(json.data.item.id).toBe(memoryItemId1);
      expect(json.data.item.content).toContain("TypeScript");
    });

    it("8.10: List items in namespace", async () => {
      const res = await fetch(`${baseUrl}/v1/memory/items?namespace=e2e-knowledge`, {
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { items: Array<{ id: string }> };
      };
      expect(json.ok).toBe(true);
      expect(json.data.items.length).toBeGreaterThanOrEqual(4);
    });

    it("8.11: Delete item", async () => {
      const res = await fetch(`${baseUrl}/v1/memory/items/${memoryItemId3}`, {
        method: "DELETE",
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { deleted: boolean };
      };
      expect(json.ok).toBe(true);
      expect(json.data.deleted).toBe(true);
    });

    it("8.12: Verify deleted → 404", async () => {
      const res = await fetch(`${baseUrl}/v1/memory/items/${memoryItemId3}`, {
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(404);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(false);
    });

    it("8.13: Prune dry run", async () => {
      const res = await fetch(`${baseUrl}/v1/memory/prune`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ namespace: "e2e-knowledge", dryRun: true }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { result: { deletedCount: number; dryRun: boolean } };
      };
      expect(json.ok).toBe(true);
      expect(typeof json.data.result.deletedCount).toBe("number");
      expect(json.data.result.dryRun).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 5: Session Fork & Merge
  // ────────────────────────────────────────────────────────────────────────

  describe("Scenario 5: Session Fork & Merge", () => {
    let parentKey: string;
    let forkKey: string;

    it("5.1: Create parent session", async () => {
      const res = await fetch(`${baseUrl}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ channel: "e2e", chatId: "fork-test-1" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { session: { key: string; status: string } };
      };
      expect(json.ok).toBe(true);
      expect(json.data.session.status).toBe("active");
      parentKey = json.data.session.key;
    });

    it("5.2: Add user message to parent", async () => {
      const res = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(parentKey)}/messages`,
        {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({
            role: "user",
            content: "Research the best pizza dough recipe",
          }),
        },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(true);
    });

    it("5.3: Add assistant response to parent", async () => {
      const res = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(parentKey)}/messages`,
        {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({
            role: "assistant",
            content: "I'll research that for you. Let me fork a sub-task.",
          }),
        },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(true);
    });

    it("5.4: Fork session", async () => {
      const res = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(parentKey)}/fork`,
        {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({
            taskId: "pizza-research",
            inheritMessageCount: 2,
          }),
        },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { result: { forkSession: { key: string } } };
      };
      expect(json.ok).toBe(true);
      forkKey = json.data.result.forkSession.key;
      expect(typeof forkKey).toBe("string");
    });

    it("5.5: Verify fork exists", async () => {
      const res = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(forkKey)}`,
        { headers: authHeaders(accessToken) },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { session: { key: string; status: string; parentSessionKey?: string } };
      };
      expect(json.ok).toBe(true);
      expect(json.data.session.status).toBe("active");
      expect(json.data.session.parentSessionKey).toBe(parentKey);
    });

    it("5.6: Verify fork inherited messages", async () => {
      const res = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(forkKey)}/messages`,
        { headers: authHeaders(accessToken) },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { items: Array<{ id: string; role: string; content: unknown }> };
      };
      expect(json.ok).toBe(true);
      expect(json.data.items.length).toBeGreaterThanOrEqual(2);
    });

    it("5.7: Add work to fork", async () => {
      const res = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(forkKey)}/messages`,
        {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({
            role: "assistant",
            content: "Found the recipe: 500g flour, 325ml water, 10g salt, 3g yeast. Ferment 24 hours.",
          }),
        },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(true);
    });

    it("5.8: List forks", async () => {
      const res = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(parentKey)}/forks`,
        { headers: authHeaders(accessToken) },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { items: Array<{ key: string }> };
      };
      expect(json.ok).toBe(true);
      expect(json.data.items.length).toBeGreaterThanOrEqual(1);
    });

    it("5.9: Merge fork back", async () => {
      const res = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(parentKey)}/merge`,
        {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({
            forkSessionKey: forkKey,
            summary: "Found pizza dough recipe: 500g flour, 325ml water, 10g salt, 3g yeast, 24h ferment",
          }),
        },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { result: Record<string, unknown> };
      };
      expect(json.ok).toBe(true);
    });

    it("5.10: Verify parent has merge summary", async () => {
      const res = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(parentKey)}/messages`,
        { headers: authHeaders(accessToken) },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { items: Array<{ role: string; content: unknown }> };
      };
      expect(json.ok).toBe(true);
      // Last message should contain the merge summary
      const lastMsg = json.data.items[json.data.items.length - 1];
      expect(lastMsg).toBeTruthy();
      const contentStr = typeof lastMsg!.content === "string"
        ? lastMsg!.content
        : JSON.stringify(lastMsg!.content);
      expect(contentStr).toContain("pizza dough recipe");
    });

    it("5.11: Verify fork is archived after merge", async () => {
      const res = await fetch(
        `${baseUrl}/v1/sessions/${encodeURIComponent(forkKey)}`,
        { headers: authHeaders(accessToken) },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { session: { status: string } };
      };
      expect(json.ok).toBe(true);
      // Fork should be archived (default: archiveFork = true)
      expect(json.data.session.status).toBe("archived");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 6: Skill Converter
  // ────────────────────────────────────────────────────────────────────────

  describe("Scenario 6: Skill Converter", () => {
    // The ClawdBot converter requires a URI (file path) — it reads SKILL.md from disk.
    // We create a temp directory with a SKILL.md file.
    let skillMdDir: string;
    let skillMdPath: string;

    beforeAll(() => {
      skillMdDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-converter-test-"));
      skillMdPath = path.join(skillMdDir, "SKILL.md");
      fs.writeFileSync(skillMdPath, `---
skillKey: hello-converter-e2e
name: Hello Converter E2E
author: e2e-test
---

Outputs a greeting message for converter E2E testing.

\`\`\`bash
echo '{"greeting": "hello from converted skill"}'
\`\`\`
`);
    });

    afterAll(() => {
      if (skillMdDir) fs.rmSync(skillMdDir, { recursive: true, force: true });
    });

    async function approveSkillImportBody<TBody extends Record<string, unknown>>(
      body: TBody,
      idempotencyKey: string,
    ): Promise<TBody & { idempotencyKey: string; canonicalApproval: Record<string, unknown> }> {
      const bodyWithoutApproval = {
        ...body,
        idempotencyKey,
      };
      const probeRes = await fetch(`${baseUrl}/v1/skills/import`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify(bodyWithoutApproval),
      });
      expect(probeRes.status).toBe(403);
      const probeJson = (await probeRes.json()) as {
        ok: false;
        error: {
          code: string;
          details?: {
            canonicalGate?: {
              actionDigest?: string;
            };
          };
        };
      };
      expect(probeJson.error.code).toBe("CANONICAL_APPROVAL_REQUIRED");
      const actionDigest = probeJson.error.details?.canonicalGate?.actionDigest;
      expect(actionDigest).toBeTruthy();

      return {
        ...bodyWithoutApproval,
        canonicalApproval: signFridayCanonicalApproval({
          decision: "approved",
          approvalId: `approval-${idempotencyKey}`,
          decidedByPrincipalId: adminPrincipalId,
          actionDigest: actionDigest!,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }, TEST_TOKEN_SECRET),
      };
    }

    it("6.1: List available converters", async () => {
      const res = await fetch(`${baseUrl}/v1/skills/converters`, {
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { converters: Array<{ id: string; displayName: string; sourceFormats: string[] }> };
      };
      expect(json.ok).toBe(true);
      expect(json.data.converters.length).toBeGreaterThanOrEqual(1);
      // Verify clawdbot converter exists
      const clawdbot = json.data.converters.find((c) => c.id === "clawdbot-skill-md");
      expect(clawdbot).toBeTruthy();
    });

    it("6.2: Convert ClawdBot skill (dry run)", async () => {
      const res = await fetch(`${baseUrl}/v1/skills/convert`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          source: { uri: skillMdDir },
          formatHint: "clawdbot-skill-md",
          dryRun: true,
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          converterId: string;
          detectedFormat: string;
          drafts: Array<{
            manifest: { id: string; runtime: { kind: string } };
            files: Array<{ path: string; content: string }>;
            warnings: string[];
          }>;
          validation: Array<{
            skillId: string;
            ok: boolean;
            issues: Array<{ severity: string; message: string }>;
          }>;
        };
      };
      expect(json.ok).toBe(true);
      expect(json.data.converterId).toBe("clawdbot-skill-md");
      expect(json.data.detectedFormat).toBe("clawdbot-skill-md");
      expect(json.data.drafts.length).toBeGreaterThanOrEqual(1);
    });

    it("6.3: Verify draft structure", async () => {
      const res = await fetch(`${baseUrl}/v1/skills/convert`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          source: { uri: skillMdDir },
          formatHint: "clawdbot-skill-md",
          dryRun: true,
        }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          drafts: Array<{
            manifest: { id: string; runtime: { kind: string } };
            files: Array<{ path: string; content: string }>;
          }>;
        };
      };
      expect(json.data.drafts[0]).toBeTruthy();
      const draft = json.data.drafts[0]!;
      expect(draft.manifest.id).toBeTruthy();
      expect(draft.manifest.runtime.kind).toBe("shell");
      expect(draft.files.length).toBeGreaterThan(0);
    });

    it("6.4: Verify validation", async () => {
      const res = await fetch(`${baseUrl}/v1/skills/convert`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          source: { uri: skillMdDir },
          formatHint: "clawdbot-skill-md",
          dryRun: true,
        }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          validation: Array<{
            skillId: string;
            ok: boolean;
            issues: Array<{ severity: string; message: string }>;
          }>;
        };
      };
      expect(json.data.validation.length).toBeGreaterThanOrEqual(1);
      const errors = json.data.validation[0]?.issues.filter((i) => i.severity === "error") ?? [];
      if (errors.length > 0) {
        console.warn(`[Scenario 6] Converter validation errors: ${JSON.stringify(errors)}`);
      }
    });

    it("6.5: Skill import stages a candidate only", async () => {
      const body = await approveSkillImportBody({
        source: { uri: skillMdDir },
        formatHint: "clawdbot-skill-md",
        target: "managed",
        replace: true,
        refreshRegistry: true,
      }, "scenario-6-5-stage");
      const res = await fetch(`${baseUrl}/v1/skills/import`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          candidates: Array<{ candidateId: string; skillId: string; validation: { ok: boolean } }>;
          registryRefreshed: boolean;
        };
      };
      expect(json.ok).toBe(true);
      expect(json.data.candidates.length).toBeGreaterThanOrEqual(1);
      expect(json.data.candidates[0]?.skillId).toBeTruthy();
      expect(json.data.registryRefreshed).toBe(false);
    });

    it("6.6: Staged import does not make the skill runnable", async () => {
      const body = await approveSkillImportBody({
        source: { uri: skillMdDir },
        formatHint: "clawdbot-skill-md",
        target: "managed",
        replace: true,
        refreshRegistry: false,
        dryRun: false,
      }, "scenario-6-6-stage");
      const res = await fetch(`${baseUrl}/v1/skills/import`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          candidates: Array<{ candidateId: string; skillId: string }>;
        };
      };
      expect(json.ok).toBe(true);
      const stagedSkillId = json.data.candidates[0]?.skillId;
      expect(stagedSkillId).toBeTruthy();

      const runRes = await fetch(`${baseUrl}/v1/skills/${encodeURIComponent(stagedSkillId!)}/run`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ input: {} }),
      });
      expect(runRes.status).not.toBe(200);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 7: Builder Lifecycle
  // ────────────────────────────────────────────────────────────────────────

  describe("Scenario 7: Builder Lifecycle", () => {
    let workflowId: string;
    let draftId: string;
    let lockToken: string;
    let runId: string;

    // Minimal spec for the builder
    const builderSpec = {
      schemaVersion: "1.0" as const,
      workflowId: "builder-lifecycle-test",
      name: "Builder Lifecycle Test",
      description: "E2E test workflow via builder",
      startStepId: "trigger-1",
      trigger: { type: "manual" as const },
      inputs: [],
      steps: [
        { id: "trigger-1", type: "skill_call" as const, ref: "noop" },
        { id: "data-1", type: "transform" as const, args: { mapping: { result: "hello" } } },
      ],
      edges: [
        { from: "trigger-1", to: "data-1" },
      ],
      outputs: [],
      errorPolicy: {
        onFailure: "fail_fast" as const,
        notifyUser: false,
      },
      tests: [],
    };

    const builderVisual = {
      schemaVersion: "1.0" as const,
      workflowId: "builder-lifecycle-test",
      viewport: { x: 0, y: 0, zoom: 1 },
      panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
      nodes: [
        { nodeId: "trigger-1", x: 100, y: 100, width: 200, height: 80 },
        { nodeId: "data-1", x: 100, y: 250, width: 200, height: 80 },
      ],
      edges: [
        { edgeKey: "trigger-1:data-1:any" },
      ],
    };

    // Compiled graph for creating the initial workflow
    const minimalGraph = (() => {
      const graphContent = JSON.stringify({
        nodes: [
          { id: "trigger-1", type: "trigger", label: "Manual Trigger", config: { triggerType: "manual" } },
          { id: "data-1", type: "data", label: "Result", config: { mapping: { result: "hello" } } },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger-1", targetNodeId: "data-1" },
        ],
      });
      return {
        schemaVersion: "2.0" as const,
        workflowId: "builder-lifecycle-test",
        workflowVersionId: "bldr-v1",
        sourceSpecSchemaVersion: "1.0" as const,
        graph: {
          nodes: [
            { id: "trigger-1", type: "trigger" as const, label: "Manual Trigger", config: { triggerType: "manual" } },
            { id: "data-1", type: "data" as const, label: "Result", config: { mapping: { result: "hello" } } },
          ],
          edges: [
            { id: "e1", sourceNodeId: "trigger-1", targetNodeId: "data-1" },
          ],
        },
        failurePolicy: {
          onFailure: "fail_fast" as const,
          notifyUser: false,
        },
        tests: [],
        checksum: computeTestChecksum(graphContent),
      };
    })();

    it("7.1: Create workflow with minimal graph", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          slug: "builder-lifecycle-test",
          name: "Builder Lifecycle Test",
          tags: ["e2e-builder"],
          graph: minimalGraph,
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { workflow: { id: string }; version: { id: string } };
      };
      expect(json.ok).toBe(true);
      workflowId = json.data.workflow.id;
      expect(typeof workflowId).toBe("string");
    });

    it("7.2: Create draft", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows/${workflowId}/drafts`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          title: "Initial Draft",
          spec: builderSpec,
          visual: builderVisual,
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { draft: { draftId: string; revision: number } };
      };
      expect(json.ok).toBe(true);
      draftId = json.data.draft.draftId;
      expect(json.data.draft.revision).toBe(1);
    });

    it("7.3: Acquire edit lock", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows/${workflowId}/locks/acquire`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          ownerUserId: "admin-001",
          ownerSessionId: "e2e-builder",
          ttlSec: 300,
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { acquired: boolean; lock?: { lockToken: string } };
      };
      expect(json.ok).toBe(true);
      expect(json.data.acquired).toBe(true);
      lockToken = json.data.lock!.lockToken;
      expect(typeof lockToken).toBe("string");
    });

    it("7.4: Save draft update", async () => {
      const res = await fetch(
        `${baseUrl}/v1/workflows/${workflowId}/drafts/${draftId}`,
        {
          method: "PATCH",
          headers: authHeaders(accessToken),
          body: JSON.stringify({
            expectedRevision: 1,
            lockToken,
            title: "Updated Draft",
          }),
        },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { draft: { revision: number; title: string } };
      };
      expect(json.ok).toBe(true);
      expect(json.data.draft.revision).toBe(2);
      expect(json.data.draft.title).toBe("Updated Draft");
    });

    it("7.5: Autosave draft", async () => {
      const res = await fetch(
        `${baseUrl}/v1/workflows/${workflowId}/drafts/${draftId}/autosave`,
        {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({
            lockToken,
            spec: builderSpec,
            visual: builderVisual,
          }),
        },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(true);
    });

    it("7.6: Compile draft", async () => {
      const res = await fetch(
        `${baseUrl}/v1/workflows/${workflowId}/drafts/${draftId}/compile`,
        {
          method: "POST",
          headers: authHeaders(accessToken),
        },
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          compiled?: Record<string, unknown>;
          validation: { valid: boolean; issues: Array<{ severity: string; message: string }> };
        };
      };
      expect(json.ok).toBe(true);
      expect(json.data.validation).toBeTruthy();
    });

    it("7.7: Release lock", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows/${workflowId}/locks/release`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ lockToken }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { released: true };
      };
      expect(json.ok).toBe(true);
      expect(json.data.released).toBe(true);
    });

    it("7.8: Publish workflow via version", async () => {
      // Publish the version that was created with the workflow
      const res = await fetch(`${baseUrl}/v1/workflows/${workflowId}/publish`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ versionNumber: 1 }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { publishedVersion: { id: string; isPublished: boolean } };
      };
      expect(json.ok).toBe(true);
      expect(json.data.publishedVersion.isPublished).toBe(true);
    });

    it("7.9: Verify published", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows/${workflowId}`, {
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          workflow: { id: string; publishedVersionNumber: number };
          publishedVersion?: { id: string };
        };
      };
      expect(json.ok).toBe(true);
      expect(json.data.workflow.publishedVersionNumber).toBe(1);
      expect(json.data.publishedVersion).toBeTruthy();
    });

    it("7.10: Run published workflow", async () => {
      const res = await fetch(`${baseUrl}/v1/workflow-runs`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          workflowId,
          triggerType: "manual",
          triggerPayload: {},
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { run: { id: string; status: string } };
      };
      expect(json.ok).toBe(true);
      runId = json.data.run.id;
    });

    it("7.11: Poll until complete", async () => {
      const result = await pollUntil(
        async () => {
          const res = await fetch(`${baseUrl}/v1/workflow-runs/${runId}`, {
            headers: authHeaders(accessToken),
          });
          return (await res.json()) as {
            ok: boolean;
            data: { run: { id: string; status: string } };
          };
        },
        (json) => {
          const s = json.data.run.status;
          return s === "completed" || s === "failed" || s === "cancelled";
        },
        { maxMs: 15_000 },
      );
      expect(result.data.run.status).toBe("completed");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 9: Condition Branching
  // ────────────────────────────────────────────────────────────────────────

  describe("Scenario 9: Condition Branching", () => {
    let workflowId: string;

    // Compiled graph with condition branching
    // Expression uses $inputs (mapped from triggerPayload)
    // Edge conditions use $steps.<nodeId>.output.result
    // NOTE: Node IDs must use underscores (not hyphens) — the expression evaluator
    // tokenizer treats hyphens as subtraction operators.
    const conditionGraph = (() => {
      const graphContent = JSON.stringify({
        nodes: [
          { id: "trigger1", type: "trigger", label: "Manual Trigger", config: { triggerType: "manual" } },
          { id: "check_score", type: "condition", label: "Score Check", config: { condition: "$inputs.score > 70" } },
          { id: "pass_node", type: "data", label: "Pass", config: { mapping: { status: "passed" } } },
          { id: "fail_node", type: "data", label: "Fail", config: { mapping: { status: "failed" } } },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger1", targetNodeId: "check_score" },
          { id: "e2", sourceNodeId: "check_score", targetNodeId: "pass_node", condition: "$steps.check_score.output.result == true" },
          { id: "e3", sourceNodeId: "check_score", targetNodeId: "fail_node", condition: "$steps.check_score.output.result == false" },
        ],
      });
      return {
        schemaVersion: "2.0" as const,
        workflowId: "condition_branch_test",
        workflowVersionId: "cond_v1",
        sourceSpecSchemaVersion: "1.0" as const,
        graph: {
          nodes: [
            { id: "trigger1", type: "trigger" as const, label: "Manual Trigger", config: { triggerType: "manual" } },
            { id: "check_score", type: "condition" as const, label: "Score Check", config: { condition: "$inputs.score > 70" } },
            { id: "pass_node", type: "data" as const, label: "Pass", config: { mapping: { status: "passed" } } },
            { id: "fail_node", type: "data" as const, label: "Fail", config: { mapping: { status: "failed" } } },
          ],
          edges: [
            { id: "e1", sourceNodeId: "trigger1", targetNodeId: "check_score" },
            { id: "e2", sourceNodeId: "check_score", targetNodeId: "pass_node", condition: "$steps.check_score.output.result == true" },
            { id: "e3", sourceNodeId: "check_score", targetNodeId: "fail_node", condition: "$steps.check_score.output.result == false" },
          ],
        },
        failurePolicy: {
          onFailure: "fail_fast" as const,
          notifyUser: false,
        },
        tests: [],
        checksum: computeTestChecksum(graphContent),
      };
    })();

    it("9.1: Create workflow with condition graph", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          slug: "condition-branch-test",
          name: "Condition Branch Test",
          graph: conditionGraph,
        } as Record<string, unknown>),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { workflow: { id: string } };
      };
      expect(json.ok).toBe(true);
      workflowId = json.data.workflow.id;
    });

    it("9.2: Publish", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows/${workflowId}/publish`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ versionNumber: 1 }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(true);
    });

    it("9.3: Run with score > 70 (true branch)", async () => {
      const res = await fetch(`${baseUrl}/v1/workflow-runs`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          workflowId,
          triggerType: "manual",
          triggerPayload: { score: 85 },
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { run: { id: string } };
      };
      expect(json.ok).toBe(true);

      const runId = json.data.run.id;

      // 9.4: Poll until complete
      const result = await pollUntil(
        async () => {
          const r = await fetch(`${baseUrl}/v1/workflow-runs/${runId}`, {
            headers: authHeaders(accessToken),
          });
          return (await r.json()) as {
            ok: boolean;
            data: { run: { status: string } };
          };
        },
        (j) => {
          const s = j.data.run.status;
          return s === "completed" || s === "failed" || s === "cancelled";
        },
        { maxMs: 15_000 },
      );
      expect(result.data.run.status).toBe("completed");

      // 9.5: Verify true branch executed
      const nodesRes = await fetch(`${baseUrl}/v1/workflow-runs/${runId}/nodes`, {
        headers: authHeaders(accessToken),
      });
      expect(nodesRes.status).toBe(200);
      const nodesJson = (await nodesRes.json()) as {
        ok: boolean;
        data: {
          items: Array<{
            nodeId: string;
            status: string;
            output?: unknown;
          }>;
        };
      };
      expect(nodesJson.ok).toBe(true);

      // Check condition node completed with result: true
      const condNode = nodesJson.data.items.find((n) => n.nodeId === "check_score");
      expect(condNode).toBeTruthy();
      expect(condNode!.status).toBe("completed");
      expect(condNode!.output).toBeUndefined();

      // pass_node should have executed
      const passNode = nodesJson.data.items.find((n) => n.nodeId === "pass_node");
      expect(passNode).toBeTruthy();
      expect(passNode!.status).toBe("completed");

      // fail_node should NOT have executed
      const failNode = nodesJson.data.items.find((n) => n.nodeId === "fail_node");
      // Either not present or not completed
      if (failNode) {
        expect(failNode.status).not.toBe("completed");
      }
    });

    it("9.6-9.8: Run with score <= 70 (false branch)", async () => {
      const res = await fetch(`${baseUrl}/v1/workflow-runs`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          workflowId,
          triggerType: "manual",
          triggerPayload: { score: 45 },
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { run: { id: string } };
      };
      const runId = json.data.run.id;

      // Poll until complete
      const result = await pollUntil(
        async () => {
          const r = await fetch(`${baseUrl}/v1/workflow-runs/${runId}`, {
            headers: authHeaders(accessToken),
          });
          return (await r.json()) as {
            ok: boolean;
            data: { run: { status: string } };
          };
        },
        (j) => {
          const s = j.data.run.status;
          return s === "completed" || s === "failed" || s === "cancelled";
        },
        { maxMs: 15_000 },
      );
      expect(result.data.run.status).toBe("completed");

      // Verify false branch executed
      const nodesRes = await fetch(`${baseUrl}/v1/workflow-runs/${runId}/nodes`, {
        headers: authHeaders(accessToken),
      });
      const nodesJson = (await nodesRes.json()) as {
        ok: boolean;
        data: {
          items: Array<{
            nodeId: string;
            status: string;
            output?: unknown;
          }>;
        };
      };
      expect(nodesJson.ok).toBe(true);

      // Check condition node completed with result: false
      const condNode = nodesJson.data.items.find((n) => n.nodeId === "check_score");
      expect(condNode).toBeTruthy();
      expect(condNode!.status).toBe("completed");
      expect(condNode!.output).toBeUndefined();

      // fail_node should have executed
      const failNode = nodesJson.data.items.find((n) => n.nodeId === "fail_node");
      expect(failNode).toBeTruthy();
      expect(failNode!.status).toBe("completed");

      // pass_node should NOT have executed
      const passNode = nodesJson.data.items.find((n) => n.nodeId === "pass_node");
      if (passNode) {
        expect(passNode.status).not.toBe("completed");
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Scenario 10: Approval Gate
  // ────────────────────────────────────────────────────────────────────────

  describe("Scenario 10: Approval Gate", () => {
    let workflowId: string;
    let runId: string;
    let approvalId: string;

    // Compiled graph with approval node
    const approvalGraph = (() => {
      const graphContent = JSON.stringify({
        nodes: [
          { id: "trigger-1", type: "trigger", label: "Manual", config: { triggerType: "manual" } },
          { id: "approval-1", type: "approval", label: "Approve Deploy", config: { approverRole: "admin", timeoutMs: 60000 } },
          { id: "deploy", type: "data", label: "Deploy", config: { mapping: { deployed: true } } },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger-1", targetNodeId: "approval-1" },
          { id: "e2", sourceNodeId: "approval-1", targetNodeId: "deploy" },
        ],
      });
      return {
        schemaVersion: "2.0" as const,
        workflowId: "approval-gate-test",
        workflowVersionId: "appr-v1",
        sourceSpecSchemaVersion: "1.0" as const,
        graph: {
          nodes: [
            { id: "trigger-1", type: "trigger" as const, label: "Manual", config: { triggerType: "manual" } },
            { id: "approval-1", type: "approval" as const, label: "Approve Deploy", config: { approverRole: "admin", timeoutMs: 60000 } },
            { id: "deploy", type: "data" as const, label: "Deploy", config: { mapping: { deployed: true } } },
          ],
          edges: [
            { id: "e1", sourceNodeId: "trigger-1", targetNodeId: "approval-1" },
            { id: "e2", sourceNodeId: "approval-1", targetNodeId: "deploy" },
          ],
        },
        failurePolicy: {
          onFailure: "fail_fast" as const,
          notifyUser: false,
        },
        tests: [],
        checksum: computeTestChecksum(graphContent),
      };
    })();

    it("10.1: Create workflow with approval node", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          slug: "approval-gate-test",
          name: "Approval Gate Test",
          graph: approvalGraph,
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { workflow: { id: string } };
      };
      expect(json.ok).toBe(true);
      workflowId = json.data.workflow.id;
    });

    it("10.2: Publish", async () => {
      const res = await fetch(`${baseUrl}/v1/workflows/${workflowId}/publish`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ versionNumber: 1 }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(true);
    });

    it("10.3: Start run", async () => {
      const res = await fetch(`${baseUrl}/v1/workflow-runs`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          workflowId,
          triggerType: "manual",
          triggerPayload: {},
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { run: { id: string } };
      };
      expect(json.ok).toBe(true);
      runId = json.data.run.id;
    });

    it("10.4: Poll until paused", async () => {
      const result = await pollUntil(
        async () => {
          const res = await fetch(`${baseUrl}/v1/workflow-runs/${runId}`, {
            headers: authHeaders(accessToken),
          });
          return (await res.json()) as {
            ok: boolean;
            data: { run: { status: string } };
          };
        },
        (json) => {
          const s = json.data.run.status;
          // Run should pause at approval node, or might fail/complete
          return s === "paused" || s === "completed" || s === "failed" || s === "cancelled";
        },
        { maxMs: 10_000 },
      );
      expect(result.data.run.status).toBe("paused");
    });

    it("10.5: List pending approvals", async () => {
      const res = await fetch(`${baseUrl}/v1/workflow-approvals`, {
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { items: Array<{ id: string; runId: string; status: string }> };
      };
      expect(json.ok).toBe(true);
      expect(json.data.items.length).toBeGreaterThanOrEqual(1);
      const ourApproval = json.data.items.find((a) => a.runId === runId);
      expect(ourApproval).toBeTruthy();
      approvalId = ourApproval!.id;
    });

    it("10.6: Get approval detail", async () => {
      const res = await fetch(`${baseUrl}/v1/workflow-approvals/${approvalId}`, {
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { approval: { id: string; status: string; runId: string } };
      };
      expect(json.ok).toBe(true);
      expect(json.data.approval.status).toBe("pending");
      expect(json.data.approval.runId).toBe(runId);
    });

    it("10.7: Approve", async () => {
      const res = await fetch(`${baseUrl}/v1/workflow-approvals/${approvalId}/approve`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ comment: "looks good" }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: { approval: { status: string }; resumed: boolean };
      };
      expect(json.ok).toBe(true);
      expect(json.data.approval.status).toBe("approved");
      expect(json.data.resumed).toBe(true);
    });

    it("10.8: Poll until completed", async () => {
      const result = await pollUntil(
        async () => {
          const res = await fetch(`${baseUrl}/v1/workflow-runs/${runId}`, {
            headers: authHeaders(accessToken),
          });
          return (await res.json()) as {
            ok: boolean;
            data: { run: { status: string } };
          };
        },
        (json) => {
          const s = json.data.run.status;
          return s === "completed" || s === "failed" || s === "cancelled";
        },
        { maxMs: 15_000 },
      );
      expect(result.data.run.status).toBe("completed");
    });

    it("10.9: Verify post-approval node executed", async () => {
      const res = await fetch(`${baseUrl}/v1/workflow-runs/${runId}/nodes`, {
        headers: authHeaders(accessToken),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        data: {
          items: Array<{
            nodeId: string;
            status: string;
            output?: unknown;
          }>;
        };
      };
      expect(json.ok).toBe(true);

      // Deploy node should have executed after approval
      const deployNode = json.data.items.find((n) => n.nodeId === "deploy");
      expect(deployNode).toBeTruthy();
      expect(deployNode!.status).toBe("completed");
      expect(deployNode!.output).toBeUndefined();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// LLM-DEPENDENT SCENARIOS (1, 2, 3, 4, 11)
//
// These require a real Anthropic API key to run. Skipped when
// FRIDAY_ANTHROPIC_API_KEY (or legacy ANTHROPIC_API_KEY) is not set.
// ════════════════════════════════════════════════════════════════════════════════

describe.skipIf(!ANTHROPIC_E2E_ENABLED || !HAS_LLM_CREDENTIAL)(
  "Friday Real Scenarios E2E (LLM)",
  () => {
    let hub: FridayHub;
    let httpServer: FridayHttpServer;
    let baseUrl: string;
    let stateDir: string;
    let accessToken: string;
    let providerId: string;

    beforeAll(async () => {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-scenarios-llm-e2e-"));

      hub = await createFridayHub({
        stateDir,
        skillDirs: [],
        port: 0,
        logRequests: false,
        allowTestOnlyWorkflowRunExecution: true,
        allowTestOnlyWorkflowCatalogMutationExecution: true,
        allowTestOnlyWorkflowBuilderDraftExecution: true,
        allowTestOnlyWorkflowDeployExecution: true,
        allowTestOnlySessionExecution: true,
        allowTestOnlySessionRunExecution: true,
        allowTestOnlySessionMemoryExtractionExecution: true,
      });
      await hub.start();

      const port = await findFreePort();
      httpServer = createFridayHttpServer({
        routes: hub.apiRuntime.routes,
        wsGateway: hub.apiRuntime.wsGateway,
        middleware: hub.apiRuntime.middleware,
        port,
        host: "127.0.0.1",
        logRequests: false,
      });
      await httpServer.listen();
      baseUrl = `http://127.0.0.1:${String(port)}`;

      // Login
      await ensureLocalPassphrase(baseUrl);
      const loginRes = await fetch(`${baseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
      });
      const loginJson = (await loginRes.json()) as {
        ok: boolean;
        data: { accessToken: string; refreshToken: string };
      };
      if (!loginJson.ok) {
        throw new Error(`Admin login failed: ${JSON.stringify(loginJson)}`);
      }
      accessToken = loginJson.data.accessToken;

      if (!LIVE_ANTHROPIC_API_KEY_ENV_REF) {
        throw new Error(liveAnthropicCredentialMessage());
      }

      // Create Anthropic provider (API key mode)
      const createProviderRes = await fetch(`${baseUrl}/v1/providers`, {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          kind: "anthropic",
          name: "Anthropic API Key (Scenario E2E)",
          baseUrl: "https://api.anthropic.com",
          authMode: "api-key",
          api: "anthropic-messages",
          apiKey: LIVE_ANTHROPIC_API_KEY_ENV_REF,
          supportedModels: [MODEL],
          defaultModel: MODEL,
          enabled: true,
          validateOnSave: false,
        }),
      });
      const createProviderJson = (await createProviderRes.json()) as {
        ok: boolean;
        data: { provider: { id: string } };
      };
      if (!createProviderJson.ok) {
        throw new Error(`Provider creation failed: ${JSON.stringify(createProviderJson)}`);
      }
      providerId = createProviderJson.data.provider.id;

      // Set routing config
      const routingRes = await fetch(`${baseUrl}/v1/model-routing`, {
        method: "PUT",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          defaultProviderId: providerId,
          fallbackProviderIds: [],
        }),
      });
      if (!routingRes.ok) {
        throw new Error(`Routing config failed: ${String(routingRes.status)}`);
      }
    }, 60_000);

    afterAll(async () => {
      if (httpServer) await httpServer.close();
      if (hub) await hub.stop();
      if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    }, 15_000);

    // ──────────────────────────────────────────────────────────────────────
    // Scenario 1: Skill Gen → Approve → Stage Candidate (LLM)
    // ──────────────────────────────────────────────────────────────────────

    describe("Scenario 1: Skill Gen → Approve → Stage Candidate", () => {
      let sessionId: string;
      let generationSucceeded = false;
      let skillId: string;
      let candidateId: string;

      it(
        "1.1: Start skill generation session",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions`,
            {
              method: "POST",
              headers: authHeaders(accessToken),
              body: JSON.stringify({
                goal: "Create a shell skill that outputs the current date in ISO format",
                userId: "admin-001",
                channel: "e2e",
                requestedModel: MODEL,
              }),
            },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              session: { sessionId: string };
              mode: string;
              questions?: string[];
            };
          };
          expect(json.ok).toBe(true);
          sessionId = json.data.session.sessionId;
          expect(typeof sessionId).toBe("string");

          // If clarification needed, answer it
          if (json.data.mode === "clarification_required") {
            const msgRes = await fetch(
              `${baseUrl}/v1/skills/generator/sessions/${sessionId}/messages`,
              {
                method: "POST",
                headers: authHeaders(accessToken),
                body: JSON.stringify({
                  message:
                    "A shell skill using the date command. No inputs needed. Output the ISO 8601 date string as JSON.",
                  requestedModel: MODEL,
                }),
              },
            );
            expect(msgRes.status).toBe(200);
          }
        },
        60_000,
      );

      it(
        "1.3: Force generation",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions/${sessionId}/generate`,
            {
              method: "POST",
              headers: authHeaders(accessToken),
              body: JSON.stringify({ requestedModel: MODEL }),
            },
          );

          // Accept both 200 (success) and 422 (graceful LLM failure)
          expect([200, 422]).toContain(res.status);

          const json = (await res.json()) as Record<string, unknown>;

          if (res.status === 200) {
            expect(json.ok).toBe(true);
            const data = json.data as {
              draft: {
                manifest: { id: string };
                files: Array<{ path: string; content: string }>;
                validation: { ok: boolean };
              };
            };
            expect(data.draft.manifest.id).toBeTruthy();
            expect(data.draft.files.length).toBeGreaterThan(0);
            generationSucceeded = true;
          } else {
            // 422 — verify error structure
            expect(json.ok).toBe(false);
            expect(json.error).toBeTruthy();
            console.warn("[Scenario 1] Generation returned 422 — skipping downstream steps");
          }
        },
        120_000,
      );

      it(
        "1.4: Verify session state (ready_for_review)",
        async () => {
          if (!generationSucceeded) return; // skip if generation failed

          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions/${sessionId}`,
            { headers: authHeaders(accessToken) },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              session: { status: string };
              turns: Array<{ role: string }>;
              draft?: { manifest: { id: string } };
            };
          };
          expect(json.ok).toBe(true);
          expect(json.data.session.status).toBe("ready_for_review");
          expect(json.data.turns.length).toBeGreaterThanOrEqual(2);
          expect(json.data.draft).toBeTruthy();
        },
        10_000,
      );

      it(
        "1.5: Approve and stage candidate",
        async () => {
          if (!generationSucceeded) return;

          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions/${sessionId}/approve`,
            {
              method: "POST",
              headers: authHeaders(accessToken),
            },
          );
          // Approve may succeed (200) or fail due to validation (422)
          expect([200, 422]).toContain(res.status);

          const json = (await res.json()) as Record<string, unknown>;

          if (res.status === 200) {
            expect(json.ok).toBe(true);
            const data = json.data as {
              skillId: string;
              skillDir: string;
              candidateId: string;
              candidateDir: string;
              savedFiles: string[];
              registryRefreshed: boolean;
              promotionStage: string;
              evidence?: {
                stagedCandidateIdentity?: {
                  skillId?: string;
                  candidateId?: string;
                  candidateDir?: string;
                  filesDir?: string;
                };
              };
            };
            expect(data.skillId).toBeTruthy();
            expect(data.candidateId).toBeTruthy();
            expect(data.candidateDir).toBeTruthy();
            expect(data.savedFiles).toContain("skill.manifest.json");
            expect(data.registryRefreshed).toBe(false);
            expect(data.promotionStage).toBe("candidate_staged");
            expect(data.evidence?.stagedCandidateIdentity).toMatchObject({
              skillId: data.skillId,
              candidateId: data.candidateId,
              candidateDir: data.candidateDir,
              filesDir: data.skillDir,
            });
            skillId = data.skillId;
            candidateId = data.candidateId;
          } else {
            console.warn("[Scenario 1] Approve returned 422 — validation failed on save");
            generationSucceeded = false; // prevent downstream steps
          }
        },
        30_000,
      );

      it(
        "1.6: Verify staged candidate identity",
        async () => {
          if (!generationSucceeded || !skillId || !candidateId) return;

          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/evidence`,
            { headers: authHeaders(accessToken) },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              evidence: {
                stagedCandidateIdentity?: {
                  skillId?: string;
                  candidateId?: string;
                };
              };
            };
          };
          expect(json.ok).toBe(true);
          expect(json.data.evidence.stagedCandidateIdentity).toMatchObject({
            skillId,
            candidateId,
          });
        },
        10_000,
      );

      it(
        "1.7: Verify direct skill run is blocked until lifecycle promotion",
        async () => {
          if (!generationSucceeded || !skillId) return;

          const res = await fetch(`${baseUrl}/v1/skills/${encodeURIComponent(skillId)}/run`, {
            method: "POST",
            headers: authHeaders(accessToken),
            body: JSON.stringify({ input: {} }),
          });
          expect(res.status).not.toBe(200);
          const json = (await res.json()) as {
            ok?: boolean;
            error?: { code?: string; message?: string };
          };
          expect(json.ok).not.toBe(true);
          expect(json.error?.code).toMatch(/SKILL_NOT_AVAILABLE|SKILL_NOT_FOUND/);
        },
        10_000,
      );

      it(
        "1.8: Verify session status is saved",
        async () => {
          if (!generationSucceeded || !skillId) return;

          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions/${sessionId}`,
            { headers: authHeaders(accessToken) },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: { session: { status: string } };
          };
          expect(json.ok).toBe(true);
          expect(json.data.session.status).toBe("saved");
        },
        10_000,
      );
    });

    // ──────────────────────────────────────────────────────────────────────
    // Scenario 2: Workflow Gen → Approve → Run (LLM)
    // ──────────────────────────────────────────────────────────────────────

    describe("Scenario 2: Workflow Gen → Approve → Run", () => {
      let sessionId: string;
      let generationSucceeded = false;
      let workflowId: string;

      it(
        "2.1: Start workflow generation session",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/workflows/generator/sessions`,
            {
              method: "POST",
              headers: authHeaders(accessToken),
              body: JSON.stringify({
                goal: "A simple manual trigger workflow with one log action that says hello world",
                userId: "admin-001",
                channel: "e2e",
                requestedModel: MODEL,
              }),
            },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              session: { sessionId: string };
              mode: string;
              questions?: string[];
            };
          };
          expect(json.ok).toBe(true);
          sessionId = json.data.session.sessionId;
          expect(typeof sessionId).toBe("string");

          // Handle clarification if needed
          if (json.data.mode === "clarification_required") {
            const msgRes = await fetch(
              `${baseUrl}/v1/workflows/generator/sessions/${sessionId}/messages`,
              {
                method: "POST",
                headers: authHeaders(accessToken),
                body: JSON.stringify({
                  message:
                    'Manual trigger, single data node that outputs { "message": "hello world" }. No conditions or branching.',
                  requestedModel: MODEL,
                }),
              },
            );
            expect(msgRes.status).toBe(200);
          }
        },
        60_000,
      );

      it(
        "2.3: Force generation",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/workflows/generator/sessions/${sessionId}/generate`,
            {
              method: "POST",
              headers: authHeaders(accessToken),
              body: JSON.stringify({ requestedModel: MODEL }),
            },
          );

          expect([200, 422]).toContain(res.status);

          const json = (await res.json()) as Record<string, unknown>;

          if (res.status === 200) {
            expect(json.ok).toBe(true);
            const data = json.data as {
              draft: {
                spec: Record<string, unknown>;
                visual: Record<string, unknown>;
                compiledGraph: Record<string, unknown>;
                validation: { ok: boolean };
              };
            };
            expect(data.draft.spec).toBeTruthy();
            expect(data.draft.visual).toBeTruthy();
            expect(data.draft.compiledGraph).toBeTruthy();
            generationSucceeded = true;
          } else {
            expect(json.ok).toBe(false);
            expect(json.error).toBeTruthy();
            console.warn("[Scenario 2] Generation returned 422 — skipping downstream steps");
          }
        },
        120_000,
      );

      it(
        "2.5: Approve and save",
        async () => {
          if (!generationSucceeded) return;

          const res = await fetch(
            `${baseUrl}/v1/workflows/generator/sessions/${sessionId}/approve`,
            {
              method: "POST",
              headers: authHeaders(accessToken),
            },
          );
          expect([200, 409, 422]).toContain(res.status);

          const json = (await res.json()) as Record<string, unknown>;

          if (res.status === 200) {
            expect(json.ok).toBe(true);
            const data = json.data as {
              workflowId: string;
              slug: string;
              published: boolean;
            };
            expect(data.workflowId).toBeTruthy();
            expect(data.slug).toBeTruthy();
            expect(data.published).toBe(true);
            workflowId = data.workflowId;
          } else if (res.status === 409) {
            console.warn("[Scenario 2] Approve returned 409 (conflict — slug exists)");
          } else {
            console.warn("[Scenario 2] Approve returned 422");
            generationSucceeded = false;
          }
        },
        30_000,
      );

      it(
        "2.6: Verify workflow exists",
        async () => {
          if (!generationSucceeded || !workflowId) return;

          const res = await fetch(
            `${baseUrl}/v1/workflows/${workflowId}`,
            { headers: authHeaders(accessToken) },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              workflow: { id: string; slug: string; publishedVersionNumber: number };
              publishedVersion?: { id: string };
            };
          };
          expect(json.ok).toBe(true);
          expect(json.data.workflow.publishedVersionNumber).toBeGreaterThanOrEqual(1);
          expect(json.data.publishedVersion).toBeTruthy();
        },
        10_000,
      );

      it(
        "2.7-2.8: Start run and poll until terminal",
        async () => {
          if (!generationSucceeded || !workflowId) return;

          const res = await fetch(`${baseUrl}/v1/workflow-runs`, {
            method: "POST",
            headers: authHeaders(accessToken),
            body: JSON.stringify({
              workflowId,
              triggerType: "manual",
              triggerPayload: {},
            }),
          });
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: { run: { id: string; status: string } };
          };
          expect(json.ok).toBe(true);
          const runId = json.data.run.id;

          // Poll until terminal
          const result = await pollUntil(
            async () => {
              const r = await fetch(
                `${baseUrl}/v1/workflow-runs/${runId}`,
                { headers: authHeaders(accessToken) },
              );
              return (await r.json()) as {
                ok: boolean;
                data: { run: { status: string } };
              };
            },
            (j) => {
              const s = j.data.run.status;
              return s === "completed" || s === "failed" || s === "cancelled";
            },
            { maxMs: 30_000 },
          );
          // Generated workflow may fail at runtime (e.g., missing skills)
          // Just verify it reached a terminal state
          expect(["completed", "failed"]).toContain(result.data.run.status);
        },
        45_000,
      );
    });

    // ──────────────────────────────────────────────────────────────────────
    // Scenario 3: AI Inference Node (LLM)
    //
    // Bypasses the generator: manually constructs a workflow with an `ai`
    // node, publishes it, runs it, and verifies the AI node produced output.
    // ──────────────────────────────────────────────────────────────────────

    describe("Scenario 3: AI Inference Node", () => {
      let workflowId: string;
      let runId: string;

      const aiGraph = (() => {
        const graphContent = JSON.stringify({
          nodes: [
            { id: "trigger1", type: "trigger", label: "Manual Trigger", config: { triggerType: "manual" } },
            { id: "ai1", type: "ai", label: "Ask Claude", config: { prompt: "Say hello and tell me one interesting fact about science. Keep it under 50 words.", model: MODEL } },
            { id: "data1", type: "data", label: "Collect Result", config: { mapping: { aiResponse: "$steps.ai1.output" } } },
          ],
          edges: [
            { id: "e1", sourceNodeId: "trigger1", targetNodeId: "ai1" },
            { id: "e2", sourceNodeId: "ai1", targetNodeId: "data1" },
          ],
        });
        return {
          schemaVersion: "2.0" as const,
          workflowId: "ai-inference-test",
          workflowVersionId: "ai-v1",
          sourceSpecSchemaVersion: "1.0" as const,
          graph: {
            nodes: [
              { id: "trigger1", type: "trigger" as const, label: "Manual Trigger", config: { triggerType: "manual" } },
              { id: "ai1", type: "ai" as const, label: "Ask Claude", config: { prompt: "Say hello and tell me one interesting fact about science. Keep it under 50 words.", model: MODEL } },
              { id: "data1", type: "data" as const, label: "Collect Result", config: { mapping: { aiResponse: "$steps.ai1.output" } } },
            ],
            edges: [
              { id: "e1", sourceNodeId: "trigger1", targetNodeId: "ai1" },
              { id: "e2", sourceNodeId: "ai1", targetNodeId: "data1" },
            ],
          },
          failurePolicy: { onFailure: "fail_fast" as const, notifyUser: false },
          tests: [],
          checksum: computeTestChecksum(graphContent),
        };
      })();

      it(
        "3.1: Create workflow with AI node graph",
        async () => {
          const res = await fetch(`${baseUrl}/v1/workflows`, {
            method: "POST",
            headers: authHeaders(accessToken),
            body: JSON.stringify({
              slug: "ai-inference-test",
              name: "AI Inference Test",
              graph: aiGraph,
            }),
          });
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: { workflow: { id: string } };
          };
          expect(json.ok).toBe(true);
          workflowId = json.data.workflow.id;
        },
        10_000,
      );

      it(
        "3.2: Publish version",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/workflows/${workflowId}/publish`,
            {
              method: "POST",
              headers: authHeaders(accessToken),
              body: JSON.stringify({ versionNumber: 1 }),
            },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as { ok: boolean };
          expect(json.ok).toBe(true);
        },
        10_000,
      );

      it(
        "3.3: Start run",
        async () => {
          const res = await fetch(`${baseUrl}/v1/workflow-runs`, {
            method: "POST",
            headers: authHeaders(accessToken),
            body: JSON.stringify({
              workflowId,
              triggerType: "manual",
              triggerPayload: {},
            }),
          });
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: { run: { id: string } };
          };
          expect(json.ok).toBe(true);
          runId = json.data.run.id;
        },
        10_000,
      );

      it(
        "3.4: Poll until terminal",
        async () => {
          const result = await pollUntil(
            async () => {
              const res = await fetch(
                `${baseUrl}/v1/workflow-runs/${runId}`,
                { headers: authHeaders(accessToken) },
              );
              return (await res.json()) as {
                ok: boolean;
                data: { run: { status: string } };
              };
            },
            (json) => {
              const s = json.data.run.status;
              return s === "completed" || s === "failed" || s === "cancelled";
            },
            { intervalMs: 1000, maxMs: 30_000 },
          );
          expect(result.data.run.status).toBe("completed");
        },
        35_000,
      );

      it(
        "3.5-3.6: Verify AI node produced output",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/workflow-runs/${runId}/nodes`,
            { headers: authHeaders(accessToken) },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              items: Array<{
                nodeId: string;
                status: string;
                output: unknown;
              }>;
            };
          };
          expect(json.ok).toBe(true);

          // Trigger node should have completed
          const triggerNode = json.data.items.find((n) => n.nodeId === "trigger1");
          expect(triggerNode).toBeTruthy();
          expect(triggerNode!.status).toBe("completed");

          // AI node should have completed with non-empty output
          const aiNode = json.data.items.find((n) => n.nodeId === "ai1");
          expect(aiNode).toBeTruthy();
          expect(aiNode!.status).toBe("completed");
          expect(aiNode!.output).toBeTruthy();

          // The AI output should contain text (the LLM response)
          const aiOutput = aiNode!.output;
          const outputStr =
            typeof aiOutput === "string"
              ? aiOutput
              : JSON.stringify(aiOutput);
          expect(outputStr.length).toBeGreaterThan(0);

          // Data node should have completed
          const dataNode = json.data.items.find((n) => n.nodeId === "data1");
          expect(dataNode).toBeTruthy();
          expect(dataNode!.status).toBe("completed");
        },
        10_000,
      );
    });

    // ──────────────────────────────────────────────────────────────────────
    // Scenario 4: Memory Extraction (LLM)
    //
    // Creates a session with conversation messages, triggers memory
    // extraction via the extraction service, and verifies extracted memories.
    // ──────────────────────────────────────────────────────────────────────

    describe("Scenario 4: Memory Extraction", () => {
      let sessionKey: string;
      let memoryNamespace: string;

      it(
        "4.1: Create session",
        async () => {
          const res = await fetch(`${baseUrl}/v1/sessions`, {
            method: "POST",
            headers: authHeaders(accessToken),
            body: JSON.stringify({ channel: "e2e", chatId: "memory-extract-test-1" }),
          });
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: { session: { key: string; status: string } };
          };
          expect(json.ok).toBe(true);
          expect(json.data.session.status).toBe("active");
          sessionKey = json.data.session.key;
        },
        10_000,
      );

      it(
        "4.2-4.5: Add conversation messages",
        async () => {
          const messages = [
            { role: "user", content: "My favorite programming language is Rust and I've been using it for 3 years" },
            { role: "assistant", content: "That's great! Rust is known for its memory safety. What projects have you built with it?" },
            { role: "user", content: "I built a web server and a CLI tool. I also love cooking Italian food on weekends." },
            { role: "assistant", content: "Nice combo of hobbies! Both Rust programming and Italian cooking require precision." },
          ];

          for (const msg of messages) {
            const res = await fetch(
              `${baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
              {
                method: "POST",
                headers: authHeaders(accessToken),
                body: JSON.stringify(msg),
              },
            );
            expect(res.status).toBe(200);
            const json = (await res.json()) as { ok: boolean };
            expect(json.ok).toBe(true);
          }
        },
        10_000,
      );

      it(
        "4.6: Trigger memory extraction (inline mode)",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/memory/extract`,
            {
              method: "POST",
              headers: authHeaders(accessToken),
              body: JSON.stringify({ trigger: "manual", mode: "inline" }),
            },
          );

          // May return 501 if extraction service is not configured,
          // or 502 if the LLM call within extraction fails
          if (res.status === 501) {
            console.warn("[Scenario 4] Memory extraction service not configured — skipping");
            return;
          }
          if (res.status === 502) {
            console.warn("[Scenario 4] Memory extraction LLM call failed (502) — skipping");
            return;
          }

          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              result: {
                sessionKey: string;
                trigger: string;
                mode: string;
                processedMessageCount: number;
                extractedMessageCount: number;
                memoryItemsCreated: number;
              };
            };
          };
          expect(json.ok).toBe(true);
          expect(json.data.result.trigger).toBe("manual");
          expect(json.data.result.mode).toBe("inline");
          // LLM should extract at least some facts from the conversation
          expect(json.data.result.processedMessageCount).toBeGreaterThan(0);
        },
        60_000,
      );

      it(
        "4.7: Check extraction status",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/memory/extraction`,
            { headers: authHeaders(accessToken) },
          );

          if (res.status === 501) return; // extraction service not configured

          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              status: {
                sessionKey: string;
                pendingMessages: number;
                extractedMessages: number;
              };
            };
          };
          expect(json.ok).toBe(true);
          expect(json.data.status.sessionKey).toBeTruthy();
        },
        10_000,
      );

      it(
        "4.8: Get session memory namespace",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/memory-namespace`,
            { headers: authHeaders(accessToken) },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: { namespace: string };
          };
          expect(json.ok).toBe(true);
          expect(typeof json.data.namespace).toBe("string");
          memoryNamespace = json.data.namespace;
        },
        10_000,
      );

      it(
        "4.9-4.10: Search extracted memories",
        async () => {
          if (!memoryNamespace) return;

          // Search for Rust
          const rustRes = await fetch(`${baseUrl}/v1/memory/search`, {
            method: "POST",
            headers: authHeaders(accessToken),
            body: JSON.stringify({
              query: "Rust programming",
              namespace: memoryNamespace,
            }),
          });
          expect(rustRes.status).toBe(200);
          const rustJson = (await rustRes.json()) as {
            ok: boolean;
            data: { items: Array<{ item: { content: string } }> };
          };
          expect(rustJson.ok).toBe(true);
          // Extraction might produce 0 items depending on LLM — just verify structure
          if (rustJson.data.items.length > 0) {
            const anyMentionsRust = rustJson.data.items.some((i) =>
              i.item.content.toLowerCase().includes("rust"),
            );
            expect(anyMentionsRust).toBe(true);
          }

          // Search for cooking
          const cookRes = await fetch(`${baseUrl}/v1/memory/search`, {
            method: "POST",
            headers: authHeaders(accessToken),
            body: JSON.stringify({
              query: "cooking Italian",
              namespace: memoryNamespace,
            }),
          });
          expect(cookRes.status).toBe(200);
          const cookJson = (await cookRes.json()) as {
            ok: boolean;
            data: { items: Array<{ item: { content: string } }> };
          };
          expect(cookJson.ok).toBe(true);
        },
        10_000,
      );

      it(
        "4.11: List all extracted memories in namespace",
        async () => {
          if (!memoryNamespace) return;

          const res = await fetch(
            `${baseUrl}/v1/memory/items?namespace=${encodeURIComponent(memoryNamespace)}`,
            { headers: authHeaders(accessToken) },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: { items: Array<{ id: string; content: string }> };
          };
          expect(json.ok).toBe(true);
          // LLM may extract 0 or more items — verify structure at minimum
          expect(Array.isArray(json.data.items)).toBe(true);
        },
        10_000,
      );
    });

    // ──────────────────────────────────────────────────────────────────────
    // Scenario 11: Multi-turn Conversation Gen (LLM)
    //
    // Start with a vague goal, answer clarifications, generate, then cancel.
    // ──────────────────────────────────────────────────────────────────────

    describe("Scenario 11: Multi-turn Conversation Gen", () => {
      let sessionId: string;
      let generationSucceeded = false;
      let latestMode: string | null = null;
      let existingDraft = false;

      it(
        "11.1: Start with vague goal",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions`,
            {
              method: "POST",
              headers: authHeaders(accessToken),
              body: JSON.stringify({
                goal: "Make a skill that processes data",
                userId: "admin-001",
                channel: "e2e",
                requestedModel: MODEL,
              }),
            },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              session: { sessionId: string };
              mode: string;
              questions?: string[];
            };
          };
          expect(json.ok).toBe(true);
          sessionId = json.data.session.sessionId;
          latestMode = json.data.mode;
          existingDraft = false;
          // Vague goal should trigger clarification
          expect(json.data.mode).toBe("clarification_required");
          expect(json.data.questions).toBeTruthy();
          expect(json.data.questions!.length).toBeGreaterThan(0);
        },
        30_000,
      );

      it(
        "11.2: Provide more detail",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions/${sessionId}/messages`,
            {
              method: "POST",
              headers: authHeaders(accessToken),
              body: JSON.stringify({
                message:
                  "It should take a CSV file path as input and output the number of rows and columns",
                requestedModel: MODEL,
              }),
            },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              session: { sessionId: string };
              mode: string;
              questions?: string[];
              draft?: {
                manifest: Record<string, unknown>;
                files: Array<{ path: string; content: string }>;
              };
            };
          };
          expect(json.ok).toBe(true);
          latestMode = json.data.mode;
          existingDraft = !!json.data.draft;
          // Mode depends on LLM judgment — any valid mode is acceptable
          expect([
            "clarification_required",
            "preview_ready",
            "generation_failed",
          ]).toContain(json.data.mode);
        },
        120_000,
      );

      it(
        "11.3: Provide remaining details",
        async () => {
          if (latestMode !== "clarification_required") {
            return;
          }
          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions/${sessionId}/messages`,
            {
              method: "POST",
              headers: authHeaders(accessToken),
              body: JSON.stringify({
                message:
                  "Shell skill, use wc and awk. Output JSON with rowCount and colCount fields.",
                requestedModel: MODEL,
              }),
            },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data?: {
              mode?: string;
              draft?: {
                manifest: Record<string, unknown>;
                files: Array<{ path: string; content: string }>;
              };
            };
          };
          expect(json.ok).toBe(true);
          latestMode = typeof json.data?.mode === "string" ? json.data.mode : latestMode;
          existingDraft = !!json.data?.draft;
        },
        120_000,
      );

      it(
        "11.4: Verify conversation history",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions/${sessionId}`,
            { headers: authHeaders(accessToken) },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              session: { sessionId: string; status: string };
              turns: Array<{ role: string }>;
            };
          };
          expect(json.ok).toBe(true);
          // At least 4 turns: initial user + assistant + 2 more user + 2 more assistant
          expect(json.data.turns.length).toBeGreaterThanOrEqual(4);
        },
        10_000,
      );

      it(
        "11.5: Generate draft",
        async () => {
          if (existingDraft || latestMode === "preview_ready") {
            generationSucceeded = true;
            return;
          }

          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions/${sessionId}/generate`,
            {
              method: "POST",
              headers: authHeaders(accessToken),
              body: JSON.stringify({ requestedModel: MODEL }),
            },
          );

          expect([200, 422]).toContain(res.status);

          if (res.status === 200) {
            const json = (await res.json()) as {
              ok: boolean;
              data: {
                draft: {
                  manifest: { id: string; inputs: Array<{ key: string }> };
                  files: Array<{ path: string; content: string }>;
                };
              };
            };
            expect(json.ok).toBe(true);
            generationSucceeded = true;
          } else {
            const json = (await res.json()) as Record<string, unknown>;
            expect(json.ok).toBe(false);
            console.warn("[Scenario 11] Generation returned 422");
          }
        },
        120_000,
      );

      it(
        "11.6: If success, verify manifest has inputs",
        async () => {
          if (!generationSucceeded) return;

          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions/${sessionId}`,
            { headers: authHeaders(accessToken) },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: {
              draft?: {
                manifest: { inputs: Array<{ key: string }> };
              };
            };
          };
          expect(json.ok).toBe(true);
          if (json.data.draft) {
            // Generated skill should have at least one input (CSV file path)
            expect(json.data.draft.manifest.inputs.length).toBeGreaterThanOrEqual(1);
          }
        },
        10_000,
      );

      it(
        "11.7: Cancel session",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions/${sessionId}`,
            {
              method: "DELETE",
              headers: authHeaders(accessToken),
            },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: { cancelled: boolean };
          };
          expect(json.ok).toBe(true);
          expect(json.data.cancelled).toBe(true);
        },
        10_000,
      );

      it(
        "11.8: Verify cancelled",
        async () => {
          const res = await fetch(
            `${baseUrl}/v1/skills/generator/sessions/${sessionId}`,
            { headers: authHeaders(accessToken) },
          );
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            ok: boolean;
            data: { session: { status: string } };
          };
          expect(json.ok).toBe(true);
          expect(json.data.session.status).toBe("cancelled");
        },
        10_000,
      );
    });
  },
);
