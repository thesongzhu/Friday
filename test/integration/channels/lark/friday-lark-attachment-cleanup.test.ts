/**
 * Disk-leak sentinel for inbound Lark/Feishu media attachments.
 *
 * Defect under test: `saveAttachmentBytes` writes inbound attachment bytes
 * (audio/image/file) to a temp file under
 * `os.tmpdir()/friday-channel-attachments/{lark,feishu}` and NOTHING in the
 * channel ever removes them, so raw bytes (including raw AUDIO) linger on disk
 * indefinitely (until OS tmp reap), surviving even a clean channel shutdown.
 *
 * This drives the REAL download → `saveAttachmentBytes` → normalization path
 * (mocking ONLY the external Lark HTTP: token refresh + resource download so it
 * returns bytes carrying a unique marker), proves the downstream consumer can
 * still read those exact bytes (no-degrade), then asserts that after the channel
 * lifecycle completes (`stop()`), no file carrying the marker survives on disk.
 *
 * Scope of this PARTIAL (lifecycle-scoped) fix — the six fail-closed properties
 * proven below:
 *   (a) raw audio is NOT retained indefinitely (cleaned at disconnect/stop);
 *   (b) after a restart/reconnect cycle, no residual temp audio remains AND a
 *       freshly restarted channel finds nothing to re-associate to a run;
 *   (c) bounded cleanup actually executes — every tracked file is unlinked and
 *       the channel attachment dir is emptied;
 *   (d) fail-closed on downstream throw AND on crash/restart residue (a tracked
 *       file already removed externally): cleanup still runs / safely no-ops,
 *       no throw strands the remaining files;
 *   (e) cleanup deletes ONLY this channel's owned audio temp paths — never
 *       another run's file or a non-owned file sharing the same directory.
 *
 * Lifecycle note (why cleanup lands at `disconnect()`/`stop()` and not right
 * after save): the saved `localPath` escapes the channel — `normalizeAsync`
 * returns a message carrying `localPath`, the registry hands it to a
 * fire-and-forget `(msg) => void` handler, and the hub launches an UNBOUNDED
 * async engine run that reads the file later (image → base64 at LLM-request
 * time; audio/file → agent tool mid-run). The channel gets no run-completion
 * signal, so unlinking right after save/handoff would be a use-after-unlink.
 * The safe, contained cleanup point is the channel lifecycle boundary. Per-run
 * unlink on the run-completion lifecycle is the FULL closure tracked as
 * PRIV-RAW-AUDIO-PER-RUN-CLEANUP (out of scope for this partial fix).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFridayLarkChannel } from "#channels";
import type { FridayChannelPlugin } from "#channels";

// Non-secret test credentials for the mocked Lark app (no live auth occurs —
// token refresh + resource download are stubbed by createMockFetch below).
const TEST_LARK_CONFIG = {
  appId: "cli-test",
  appSecret: "secret-test", // pragma: allowlist secret
  useFeishu: true,
};

// ─── Mock fetch (external Lark HTTP only) ───

function createMockFetch() {
  const responses: Array<{
    url: string;
    body: unknown;
    status?: number;
    headers?: Record<string, string>;
  }> = [];

  const mockFetch = vi.fn(async (url: string | URL) => {
    const urlStr = String(url);
    const match = responses.find((r) => urlStr.includes(r.url));
    if (!match) {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: { get: () => "text/plain" },
        json: async () => ({}),
        text: async () => "Not Found",
        arrayBuffer: async () => new TextEncoder().encode("Not Found").buffer,
      };
    }
    const bodyToArrayBuffer = (): ArrayBuffer => {
      if (match.body instanceof ArrayBuffer) return match.body;
      if (ArrayBuffer.isView(match.body)) {
        return match.body.buffer.slice(
          match.body.byteOffset,
          match.body.byteOffset + match.body.byteLength,
        );
      }
      if (typeof match.body === "string") {
        return new TextEncoder().encode(match.body).buffer;
      }
      return new TextEncoder().encode(JSON.stringify(match.body)).buffer;
    };
    return {
      ok: (match.status ?? 200) < 400,
      status: match.status ?? 200,
      statusText: "OK",
      headers: {
        get: (name: string) => {
          const normalized = name.toLowerCase();
          const entry = Object.entries(match.headers ?? {}).find(
            ([key]) => key.toLowerCase() === normalized,
          );
          return entry?.[1] ?? null;
        },
      },
      json: async () => match.body,
      text: async () =>
        typeof match.body === "string" ? match.body : JSON.stringify(match.body),
      arrayBuffer: async () => bodyToArrayBuffer(),
    };
  });

  return { mockFetch, responses };
}

type MockResponses = ReturnType<typeof createMockFetch>["responses"];

/** Stub the Lark tenant-access-token refresh (mocked external HTTP). */
function pushToken(responses: MockResponses, token = "t-token"): void {
  responses.push({
    url: "tenant_access_token",
    body: { code: 0, msg: "ok", tenant_access_token: token, expire: 7200 },
  });
}

/** Stub a single message-resource download returning audio bytes carrying `marker`. */
function pushAudioResource(
  responses: MockResponses,
  messageId: string,
  key: string,
  marker: string,
): void {
  responses.push({
    url: `/open-apis/im/v1/messages/${messageId}/resources/${key}`,
    body: Buffer.from(marker, "utf8"),
    headers: { "content-type": "audio/mpeg" },
  });
}

// ─── Disk scan helper ───

/** Recursively collect every file whose contents contain `marker`. */
function filesContainingMarker(dir: string, marker: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          if (fs.readFileSync(full).includes(marker)) found.push(full);
        } catch {
          /* ignore unreadable file */
        }
      }
    }
  };
  walk(dir);
  return found;
}

/** Files currently present in the Feishu channel's attachment subdir. */
function feishuFiles(attachmentDir: string): string[] {
  const dir = path.join(attachmentDir, "feishu");
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function audioEvent(messageId: string, fileKey: string) {
  return {
    header: { event_type: "im.message.receive_v1" },
    event: {
      message: {
        message_id: messageId,
        chat_id: "oc_audio",
        chat_type: "p2p",
        message_type: "audio",
        content: JSON.stringify({ file_key: fileKey, file_name: "voice.mp3" }),
        create_time: "1708416000000",
      },
      sender: {
        sender_id: { open_id: "ou_audio_user" },
      },
    },
  };
}

/** Drive the live inbound path: REAL download → saveAttachmentBytes → normalize. */
async function ingestAudio(
  plugin: FridayChannelPlugin,
  messageId: string,
  key: string,
): Promise<string> {
  const msg = await plugin.adapters!.inbound!.normalizeAsync!(
    audioEvent(messageId, key),
  );
  expect(msg).not.toBeNull();
  const attachment = msg!.attachments?.[0];
  expect(attachment).toEqual(
    expect.objectContaining({ kind: "audio", status: "resolved" }),
  );
  const localPath = attachment!.localPath;
  expect(typeof localPath).toBe("string");
  expect(fs.existsSync(localPath!)).toBe(true);
  return localPath!;
}

describe("Lark/Feishu inbound attachment disk cleanup", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalAttachmentDir: string | undefined;
  let plugin: FridayChannelPlugin;
  let fetchMock: ReturnType<typeof createMockFetch>;
  let attachmentDir: string;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalAttachmentDir = process.env.FRIDAY_CHANNEL_ATTACHMENT_DIR;
    attachmentDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-lark-leak-"));
    process.env.FRIDAY_CHANNEL_ATTACHMENT_DIR = attachmentDir;

    fetchMock = createMockFetch();
    globalThis.fetch = fetchMock.mockFetch as unknown as typeof globalThis.fetch;

    plugin = createFridayLarkChannel();
    await plugin.init(TEST_LARK_CONFIG);
  });

  afterEach(async () => {
    try {
      await plugin.stop();
    } catch {
      /* ignore */
    }
    globalThis.fetch = originalFetch;
    if (originalAttachmentDir === undefined) {
      delete process.env.FRIDAY_CHANNEL_ATTACHMENT_DIR;
    } else {
      process.env.FRIDAY_CHANNEL_ATTACHMENT_DIR = originalAttachmentDir;
    }
    fs.rmSync(attachmentDir, { recursive: true, force: true });
  });

  // ── (a) raw audio is NOT retained indefinitely ──
  it("removes the inbound audio temp file once the channel lifecycle completes", async () => {
    const marker = "FRIDAY_LARK_LEAK_SENTINEL_AUDIO_9f3a2b7c";
    pushToken(fetchMock.responses, "t-token-leak");
    pushAudioResource(fetchMock.responses, "om_audio_leak", "audio_key_leak", marker);

    const localPath = await ingestAudio(plugin, "om_audio_leak", "audio_key_leak");

    // NO-DEGRADE: the downstream consumer (engine reads this exact path) still
    // sees the correct bytes while the channel is live.
    expect(fs.readFileSync(localPath).toString("utf8")).toContain(marker);

    // Cleanup runs at the channel lifecycle boundary.
    await plugin.stop();

    // After the lifecycle completes, NO file carrying the raw bytes may survive.
    expect(filesContainingMarker(attachmentDir, marker)).toEqual([]);
    expect(fs.existsSync(localPath)).toBe(false);
  });

  // ── (d) fail-closed on downstream throw ──
  it("still cleans up the temp file when the downstream consumer throws", async () => {
    const marker = "FRIDAY_LARK_LEAK_SENTINEL_AUDIO_ERRORPATH_5d1e";
    pushToken(fetchMock.responses, "t-token-leak-err");
    pushAudioResource(fetchMock.responses, "om_audio_err", "audio_key_err", marker);

    const localPath = await ingestAudio(plugin, "om_audio_err", "audio_key_err");

    // Simulate a downstream consumer that reads the bytes and then fails.
    let consumerThrew = false;
    try {
      const bytes = fs.readFileSync(localPath);
      expect(bytes.toString("utf8")).toContain(marker);
      throw new Error("simulated downstream consumer failure");
    } catch {
      consumerThrew = true;
    }
    expect(consumerThrew).toBe(true);

    // Cleanup must still run on the error/cancel path (finally).
    await plugin.stop();

    expect(filesContainingMarker(attachmentDir, marker)).toEqual([]);
    expect(fs.existsSync(localPath)).toBe(false);
  });

  // ── (b) restart/reconnect: no residual audio + no re-association ──
  it("leaves no residual audio and nothing to re-associate after a restart/reconnect cycle", async () => {
    const marker = "FRIDAY_LARK_LEAK_SENTINEL_RESTART_7b2c";
    pushToken(fetchMock.responses, "t-token-restart");
    pushAudioResource(fetchMock.responses, "om_restart", "audio_key_restart", marker);

    const localPath = await ingestAudio(plugin, "om_restart", "audio_key_restart");

    // Shutdown boundary (as on a restart) must reap the raw audio.
    await plugin.stop();
    expect(filesContainingMarker(attachmentDir, marker)).toEqual([]);
    expect(fs.existsSync(localPath)).toBe(false);

    // A freshly restarted channel over the SAME attachment dir must find NO
    // stale audio it could re-associate to a new run.
    const restarted = createFridayLarkChannel();
    await restarted.init(TEST_LARK_CONFIG);
    try {
      expect(filesContainingMarker(attachmentDir, marker)).toEqual([]);
      expect(feishuFiles(attachmentDir)).toEqual([]);
    } finally {
      await restarted.stop();
    }
  });

  // ── (c) bounded cleanup executes: every file unlinked, dir emptied ──
  it("unlinks every tracked temp file and empties the channel attachment dir", async () => {
    const markers = [
      "FRIDAY_LARK_LEAK_SENTINEL_BULK_a1",
      "FRIDAY_LARK_LEAK_SENTINEL_BULK_b2",
      "FRIDAY_LARK_LEAK_SENTINEL_BULK_c3",
    ];
    pushToken(fetchMock.responses, "t-token-bulk");
    const paths: string[] = [];
    for (let i = 0; i < markers.length; i++) {
      pushAudioResource(
        fetchMock.responses,
        `om_bulk_${String(i)}`,
        `audio_key_bulk_${String(i)}`,
        markers[i]!,
      );
    }
    for (let i = 0; i < markers.length; i++) {
      paths.push(await ingestAudio(plugin, `om_bulk_${String(i)}`, `audio_key_bulk_${String(i)}`));
    }

    // All three raw-audio temp files are present before cleanup.
    expect(feishuFiles(attachmentDir)).toHaveLength(3);

    await plugin.stop();

    // Bounded cleanup unlinked every tracked file and emptied the dir.
    for (const p of paths) expect(fs.existsSync(p)).toBe(false);
    expect(feishuFiles(attachmentDir)).toEqual([]);
    for (const marker of markers) {
      expect(filesContainingMarker(attachmentDir, marker)).toEqual([]);
    }
  });

  // ── (d) fail-closed on crash/restart residue (tracked file already gone) ──
  it("stays fail-closed when a tracked temp file was already removed — no throw strands the rest", async () => {
    const markerA = "FRIDAY_LARK_LEAK_SENTINEL_ENOENT_A";
    const markerB = "FRIDAY_LARK_LEAK_SENTINEL_ENOENT_B";
    pushToken(fetchMock.responses, "t-token-enoent");
    pushAudioResource(fetchMock.responses, "om_enoent_a", "audio_key_enoent_a", markerA);
    pushAudioResource(fetchMock.responses, "om_enoent_b", "audio_key_enoent_b", markerB);

    const pathA = await ingestAudio(plugin, "om_enoent_a", "audio_key_enoent_a");
    const pathB = await ingestAudio(plugin, "om_enoent_b", "audio_key_enoent_b");

    // Simulate crash/restart residue: one tracked temp file already reaped
    // externally, leaving the channel's tracking state partially stale.
    fs.rmSync(pathA);

    // stop() must NOT throw on the missing file AND must still remove the rest.
    await expect(plugin.stop()).resolves.toBeUndefined();

    expect(filesContainingMarker(attachmentDir, markerA)).toEqual([]);
    expect(filesContainingMarker(attachmentDir, markerB)).toEqual([]);
    expect(fs.existsSync(pathB)).toBe(false);
  });

  // ── (e) deletes ONLY this channel's owned audio paths ──
  it("deletes only this channel's owned audio temp paths — never foreign or non-owned files", async () => {
    const feishuDir = path.join(attachmentDir, "feishu");
    fs.mkdirSync(feishuDir, { recursive: true });

    // A foreign file the channel did NOT save (another run's artifact or a
    // non-audio-owned file) sitting in the SAME directory.
    const foreignMarker = "FRIDAY_FOREIGN_NOT_OWNED_BY_CHANNEL_e4";
    const foreignPath = path.join(feishuDir, "not-owned-by-this-channel.bin");
    fs.writeFileSync(foreignPath, foreignMarker);

    const ownedMarker = "FRIDAY_LARK_LEAK_SENTINEL_OWNED_d9";
    pushToken(fetchMock.responses, "t-token-owned");
    pushAudioResource(fetchMock.responses, "om_owned", "audio_key_owned", ownedMarker);

    const ownedPath = await ingestAudio(plugin, "om_owned", "audio_key_owned");

    await plugin.stop();

    // Owned audio was removed …
    expect(fs.existsSync(ownedPath)).toBe(false);
    expect(filesContainingMarker(feishuDir, ownedMarker)).toEqual([]);

    // … but the foreign / non-owned file is untouched (no dir-wipe).
    expect(fs.existsSync(foreignPath)).toBe(true);
    expect(fs.readFileSync(foreignPath, "utf8")).toBe(foreignMarker);
  });
});
