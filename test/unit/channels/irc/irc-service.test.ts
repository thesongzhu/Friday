import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { tlsConnectMock } = vi.hoisted(() => ({
  tlsConnectMock: vi.fn(),
}));

vi.mock("node:tls", () => ({
  connect: tlsConnectMock,
}));

import { createIrcConnectionService } from "../../../../src/channels/irc/irc-service.js";

class FakeTlsSocket extends EventEmitter {
  destroyed = false;

  setEncoding(_encoding: string): this {
    return this;
  }

  write(_chunk: string): boolean {
    if (this.destroyed) {
      throw new Error("socket destroyed");
    }
    return true;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.emit("close");
  }
}

describe("irc-service", () => {
  afterEach(() => {
    tlsConnectMock.mockReset();
  });

  it("rejects cleanly when registration runs after the TLS socket is already closed", async () => {
    tlsConnectMock.mockImplementation(
      (
        _options: { host: string; port: number; rejectUnauthorized: boolean },
        onSecureConnect?: () => void,
      ) => {
        const socket = new FakeTlsSocket();
        socket.destroyed = true;
        process.nextTick(() => {
          onSecureConnect?.();
        });
        return socket;
      },
    );

    const service = createIrcConnectionService();

    await expect(
      service.connect(
        {
          host: "irc.example.com",
          port: 6697,
          tls: true,
          nick: "friday-bot",
          channels: [],
        },
        () => {},
      ),
    ).rejects.toThrow("Failed to send IRC nickname");
  });
});
