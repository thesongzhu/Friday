import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createFridayApiTestEnv,
  loginTestUser,
  authHeaders,
  type FridayApiTestEnv,
} from "./_helpers/friday-api-test-server.helper.js";

describe("API — Session & Memory routes", () => {
  let env: FridayApiTestEnv;
  let token: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv({ enableDefaultMemoryService: true });
    const login = await loginTestUser(env.baseUrl);
    token = login.accessToken;
  });

  afterAll(async () => {
    await env.close();
  });

  // ── create_session ─────────────────────────────────────────────────────

  it("create_session", async () => {
    const res = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        channel: "test-channel",
        chatId: "create-chat-001",
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { session: { key: string; channel: string; status: string } };
      requestId: string;
    };
    expect(json.ok).toBe(true);
    expect(json.data.session.channel).toBe("test-channel");
    expect(json.data.session.status).toBe("active");
    expect(typeof json.requestId).toBe("string");
  });

  it("create_session_duplicate_returns_409", async () => {
    const channel = `dup-channel-${Date.now()}`;
    const chatId = "dup-chat-001";

    const first = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ channel, chatId }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ channel, chatId }),
    });
    expect(second.status).toBe(409);
    const json = (await second.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("SESSION_ALREADY_EXISTS");
  });

  // ── get_session ────────────────────────────────────────────────────────

  it("get_session", async () => {
    const createRes = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        channel: "test-channel",
        chatId: "get-chat-001",
      }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { session: { key: string } };
    };
    const sessionKey = createJson.data.session.key;

    const res = await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}`,
      { headers: authHeaders(token) },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { session: { key: string } };
    };
    expect(json.ok).toBe(true);
    expect(json.data.session.key).toBe(sessionKey);
  });

  // ── list_sessions ──────────────────────────────────────────────────────

  it("list_sessions", async () => {
    // Use a unique channel so we're isolated from other tests
    const channel = `list-channel-${Date.now()}`;

    // Create exactly 2 sessions in this channel
    await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ channel, chatId: "list-chat-001" }),
    });
    await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ channel, chatId: "list-chat-002" }),
    });

    const res = await fetch(
      `${env.baseUrl}/v1/sessions?channel=${encodeURIComponent(channel)}`,
      { headers: authHeaders(token) },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { items: Array<{ key: string; channel: string }> };
    };
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data.items)).toBe(true);
    // Assert exact count for sessions created in this test
    const channelItems = json.data.items.filter((s) => s.channel === channel);
    expect(channelItems.length).toBe(2);
  });

  // ── append_message ─────────────────────────────────────────────────────

  it("append_message", async () => {
    const createRes = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        channel: "test-channel",
        chatId: "msg-chat-001",
      }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { session: { key: string } };
    };
    const sessionKey = createJson.data.session.key;

    const res = await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          role: "user",
          content: "Hello, world!",
        }),
      },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { message: { id: string; role: string } };
    };
    expect(json.ok).toBe(true);
    expect(json.data.message.role).toBe("user");
    expect(json.data.message.id).toBeTruthy();
  });

  // ── list_messages ──────────────────────────────────────────────────────

  it("list_messages", async () => {
    // Create session + append messages
    const createRes = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        channel: "test-channel",
        chatId: "listmsg-chat-001",
      }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { session: { key: string } };
    };
    const sessionKey = createJson.data.session.key;

    await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ role: "user", content: "Message A" }),
      },
    );

    await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ role: "assistant", content: "Reply A" }),
      },
    );

    const res = await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/messages`,
      { headers: authHeaders(token) },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { items: Array<{ role: string; content: string }> };
    };
    expect(json.ok).toBe(true);
    expect(json.data.items.length).toBe(2);
    expect(json.data.items[0]!.role).toBe("user");
  });

  // ── archive_session ────────────────────────────────────────────────────

  it("archive_session", async () => {
    const createRes = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        channel: "test-channel",
        chatId: "archive-chat-001",
      }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { session: { key: string } };
    };
    const sessionKey = createJson.data.session.key;

    const res = await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/archive`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({}),
      },
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { session: { status: string } };
    };
    expect(json.ok).toBe(true);
    expect(json.data.session.status).toBe("archived");
  });

  // ── fork_session ───────────────────────────────────────────────────────

  it("fork_session", async () => {
    // Create parent session + add messages
    const createRes = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        channel: "test-channel",
        chatId: "fork-chat-001",
      }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { session: { key: string } };
    };
    const parentKey = createJson.data.session.key;

    // Add a message to the parent
    await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(parentKey)}/messages`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ role: "user", content: "Parent message" }),
      },
    );

    // Fork
    const forkRes = await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(parentKey)}/fork`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          taskId: "task-001",
          inheritMessageCount: 1,
        }),
      },
    );
    expect(forkRes.status).toBe(200);
    const forkJson = (await forkRes.json()) as {
      ok: boolean;
      data: {
        result: {
          forkSession: { key: string; status: string };
          inheritedMessageCount: number;
        };
      };
    };
    expect(forkJson.ok).toBe(true);
    expect(forkJson.data.result.forkSession.status).toBe("active");
    expect(forkJson.data.result.inheritedMessageCount).toBe(1);

    // List forks from parent
    const listForksRes = await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(parentKey)}/forks`,
      { headers: authHeaders(token) },
    );
    expect(listForksRes.status).toBe(200);
    const listForksJson = (await listForksRes.json()) as {
      ok: boolean;
      data: { items: Array<{ key: string }> };
    };
    expect(listForksJson.ok).toBe(true);
    expect(listForksJson.data.items.length).toBe(1);
  });

  // ── merge_fork ─────────────────────────────────────────────────────────

  it("merge_fork", async () => {
    // Create parent + fork
    const createRes = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        channel: "test-channel",
        chatId: "merge-chat-001",
      }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { session: { key: string } };
    };
    const parentKey = createJson.data.session.key;

    await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(parentKey)}/messages`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ role: "user", content: "Parent message" }),
      },
    );

    const forkRes = await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(parentKey)}/fork`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ taskId: "merge-task" }),
      },
    );
    const forkJson = (await forkRes.json()) as {
      ok: boolean;
      data: { result: { forkSession: { key: string } } };
    };
    const forkKey = forkJson.data.result.forkSession.key;

    // Add messages to fork
    await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(forkKey)}/messages`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ role: "assistant", content: "Fork work done" }),
      },
    );

    // Merge fork back to parent
    const mergeRes = await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(parentKey)}/merge`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          forkSessionKey: forkKey,
          summary: "Completed the sub-task successfully",
          archiveFork: true,
        }),
      },
    );
    expect(mergeRes.status).toBe(200);
    const mergeJson = (await mergeRes.json()) as {
      ok: boolean;
      data: {
        result: {
          parentMessage: { id: string; role: string; content: string };
          forkSession: { key: string; status: string };
        };
      };
    };
    expect(mergeJson.ok).toBe(true);
    // The merge creates a summary message in the parent session
    expect(mergeJson.data.result.parentMessage.id).toBeTruthy();
    expect(mergeJson.data.result.parentMessage.content).toContain("Completed the sub-task");
    // The fork should be archived since archiveFork=true
    expect(mergeJson.data.result.forkSession.status).toBe("archived");
  });

  // ── archive_and_list_excludes_archived ─────────────────────────────────

  it("archive_and_list_excludes_archived", async () => {
    // Create two sessions with a unique channel
    const channel = `archive-filter-${Date.now()}`;

    const createRes1 = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ channel, chatId: "active-chat" }),
    });
    const createJson1 = (await createRes1.json()) as {
      ok: boolean;
      data: { session: { key: string } };
    };
    const activeKey = createJson1.data.session.key;

    const createRes2 = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ channel, chatId: "to-archive-chat" }),
    });
    const createJson2 = (await createRes2.json()) as {
      ok: boolean;
      data: { session: { key: string } };
    };
    const archiveKey = createJson2.data.session.key;

    // Archive the second session
    await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(archiveKey)}/archive`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({}),
      },
    );

    // List active sessions only
    const listRes = await fetch(
      `${env.baseUrl}/v1/sessions?channel=${encodeURIComponent(channel)}&status=active`,
      { headers: authHeaders(token) },
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      ok: boolean;
      data: { items: Array<{ key: string; status: string }> };
    };
    expect(listJson.ok).toBe(true);
    // Only the active session should be returned
    expect(listJson.data.items.length).toBe(1);
    expect(listJson.data.items[0]!.key).toBe(activeKey);
    expect(listJson.data.items.every((s) => s.status === "active")).toBe(true);
  });

  // ── prune_sessions ──────────────────────────────────────────────────────

  it("prune_sessions", async () => {
    // Prune operates on *archived* sessions — create one, archive it, then prune.
    const channel = `prune-channel-${Date.now()}`;

    // 1. Create a session
    const createRes = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ channel, chatId: "prune-chat-001" }),
    });
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { session: { key: string } };
    };
    expect(createJson.ok).toBe(true);
    const sessionKey = createJson.data.session.key;

    // 2. Archive it so it becomes a prune candidate
    const archiveRes = await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}/archive`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({}),
      },
    );
    expect(archiveRes.status).toBe(200);
    const archiveJson = (await archiveRes.json()) as {
      ok: boolean;
      data: { session: { status: string } };
    };
    expect(archiveJson.data.session.status).toBe("archived");

    // 3. Prune with olderThan far in the future so our archived session qualifies
    const res = await fetch(`${env.baseUrl}/v1/sessions/prune`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ olderThan: "2099-01-01T00:00:00.000Z" }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        result: {
          archivedToPrunedCount: number;
          hardDeletedCount: number;
          sessionKeys: string[];
        };
      };
    };
    expect(json.ok).toBe(true);
    // The archived session should have been pruned
    expect(json.data.result.archivedToPrunedCount).toBeGreaterThanOrEqual(1);
    expect(json.data.result.sessionKeys).toContain(sessionKey);

    // 4. Verify the session is no longer retrievable as active/archived
    const getRes = await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent(sessionKey)}`,
      { headers: authHeaders(token) },
    );
    // Session still exists but status should be "pruned"
    if (getRes.status === 200) {
      const getJson = (await getRes.json()) as {
        ok: boolean;
        data: { session: { key: string; status: string } };
      };
      expect(getJson.data.session.status).toBe("pruned");
    } else {
      // If the endpoint returns 404 for pruned sessions, that's also valid
      expect(getRes.status).toBe(404);
    }
  });

  // ── session_error_paths ────────────────────────────────────────────────

  it("session_error_paths", async () => {
    // 404 for nonexistent session
    const res = await fetch(
      `${env.baseUrl}/v1/sessions/${encodeURIComponent("nonexistent:session:key")}`,
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
      requestId: string;
    };
    expect(json.ok).toBe(false);
    expect(typeof json.error.code).toBe("string");
    expect(typeof json.error.message).toBe("string");
    expect(typeof json.requestId).toBe("string");
  });

  // ── memory routes ──────────────────────────────────────────────────────

  it("memory_store_item", async () => {
    const namespace = `e2e-memory-${Date.now()}`;
    const res = await fetch(`${env.baseUrl}/v1/memory/store`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        namespace,
        content: "Friday memory e2e item",
        source: "e2e",
        tags: ["e2e", "memory"],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { item: { id: string; namespace: string; content: string } };
    };
    expect(json.ok).toBe(true);
    expect(json.data.item.id).toBeTruthy();
    expect(json.data.item.namespace.endsWith(`.${namespace}`)).toBe(true);
    expect(json.data.item.content).toContain("Friday memory e2e item");
  });

  it("memory_list_items", async () => {
    const namespace = `e2e-memory-list-${Date.now()}`;
    await fetch(`${env.baseUrl}/v1/memory/store`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        namespace,
        content: "first memory row",
        source: "e2e",
      }),
    });
    await fetch(`${env.baseUrl}/v1/memory/store`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        namespace,
        content: "second memory row",
        source: "e2e",
      }),
    });

    const res = await fetch(
      `${env.baseUrl}/v1/memory/items?namespace=${encodeURIComponent(namespace)}&limit=20`,
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        items: Array<{ namespace: string; content: string }>;
      };
    };
    expect(json.ok).toBe(true);
    const scopedItems = json.data.items.filter((item) =>
      item.namespace.endsWith(`.${namespace}`),
    );
    expect(scopedItems.length).toBeGreaterThanOrEqual(2);
  });
});
