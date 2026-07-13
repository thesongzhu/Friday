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
 * Lifecycle note (why cleanup lands at `disconnect()`/`stop()` and not right
 * after save): the saved `localPath` escapes the channel — `normalizeAsync`
 * returns a message carrying `localPath`, the registry hands it to a
 * fire-and-forget `(msg) => void` handler, and the hub launches an UNBOUNDED
 * async engine run that reads the file later (image → base64 at LLM-request
 * time; audio/file → agent tool mid-run). The channel gets no run-completion
 * signal, so unlinking right after save/handoff would be a use-after-unlink.
 * The safe, contained cleanup point is the channel lifecycle boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFridayLarkChannel } from "#channels";
import type { FridayChannelPlugin } from "#channels";

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
    await plugin.init({
      appId: "cli-test",
      appSecret: "secret-test",
      useFeishu: true,
    });
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

  it("removes the inbound audio temp file once the channel lifecycle completes", async () => {
    const marker = "FRIDAY_LARK_LEAK_SENTINEL_AUDIO_9f3a2b7c";
    fetchMock.responses.push(
      {
        url: "tenant_access_token",
        body: { code: 0, msg: "ok", tenant_access_token: "t-token-leak", expire: 7200 },
      },
      {
        url: "/open-apis/im/v1/messages/om_audio_leak/resources/audio_key_leak",
        body: Buffer.from(marker, "utf8"),
        headers: { "content-type": "audio/mpeg" },
      },
    );

    // REAL download → saveAttachmentBytes → normalization (the exact method the
    // channel registry invokes live for inbound events).
    const msg = await plugin.adapters!.inbound!.normalizeAsync!(
      audioEvent("om_audio_leak", "audio_key_leak"),
    );

    // The raw audio bytes were written to a real temp file.
    expect(msg).not.toBeNull();
    const attachment = msg!.attachments?.[0];
    expect(attachment).toEqual(
      expect.objectContaining({ kind: "audio", status: "resolved" }),
    );
    const localPath = attachment!.localPath;
    expect(typeof localPath).toBe("string");
    expect(fs.existsSync(localPath!)).toBe(true);

    // NO-DEGRADE: the downstream consumer (engine reads this exact path) still
    // sees the correct bytes while the channel is live.
    expect(fs.readFileSync(localPath!).toString("utf8")).toContain(marker);

    // Cleanup runs at the channel lifecycle boundary.
    await plugin.stop();

    // After the lifecycle completes, NO file carrying the raw bytes may survive.
    const leaked = filesContainingMarker(attachmentDir, marker);
    expect(leaked).toEqual([]);
  });

  it("still cleans up the temp file when the downstream consumer throws", async () => {
    const marker = "FRIDAY_LARK_LEAK_SENTINEL_AUDIO_ERRORPATH_5d1e";
    fetchMock.responses.push(
      {
        url: "tenant_access_token",
        body: { code: 0, msg: "ok", tenant_access_token: "t-token-leak-err", expire: 7200 },
      },
      {
        url: "/open-apis/im/v1/messages/om_audio_err/resources/audio_key_err",
        body: Buffer.from(marker, "utf8"),
        headers: { "content-type": "audio/mpeg" },
      },
    );

    const msg = await plugin.adapters!.inbound!.normalizeAsync!(
      audioEvent("om_audio_err", "audio_key_err"),
    );
    const localPath = msg!.attachments?.[0]?.localPath;
    expect(typeof localPath).toBe("string");
    expect(fs.existsSync(localPath!)).toBe(true);

    // Simulate a downstream consumer that reads the bytes and then fails.
    let consumerThrew = false;
    try {
      const bytes = fs.readFileSync(localPath!);
      expect(bytes.toString("utf8")).toContain(marker);
      throw new Error("simulated downstream consumer failure");
    } catch {
      consumerThrew = true;
    }
    expect(consumerThrew).toBe(true);

    // Cleanup must still run on the error/cancel path (finally).
    await plugin.stop();

    const leaked = filesContainingMarker(attachmentDir, marker);
    expect(leaked).toEqual([]);
  });
});
