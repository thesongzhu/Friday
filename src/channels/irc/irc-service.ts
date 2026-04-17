/**
 * IRC service — stubbed interfaces for TCP socket connection.
 */

import { FridayDomainError } from "#errors";
import * as net from "node:net";
import * as tls from "node:tls";

// ─── Types ───

export interface IrcPrivmsgEvent {
  prefix: string;
  nick: string;
  user?: string;
  host?: string;
  command: "PRIVMSG";
  target: string; // Channel or nick for DM
  message: string;
  timestamp: number;
}

export interface IrcConnectionOptions {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username?: string;
  password?: string;
  channels: string[];
}

// ─── Service Interface ───

export interface IrcConnectionService {
  /** Connect to the IRC server and join channels. */
  connect(
    options: IrcConnectionOptions,
    onMessage: (event: IrcPrivmsgEvent) => void,
  ): Promise<void>;
  /** Disconnect from the server. */
  disconnect(): Promise<void>;
  /** Send a PRIVMSG to a target (channel or nick). */
  sendMessage(target: string, message: string): Promise<void>;
  /** Check connection state. */
  isConnected(): boolean;
  /** Get list of currently joined channels. */
  joinedChannels(): string[];
}

// ─── Stub Implementation ───

export function createIrcConnectionServiceStub(): IrcConnectionService {
  let connected = false;
  let channels: string[] = [];

  return {
    async connect(options, _onMessage) {
      connected = true;
      channels = [...options.channels];
      // Stub: in production, opens TCP socket, sends NICK/USER/JOIN
    },
    async disconnect() {
      connected = false;
      channels = [];
    },
    async sendMessage(_target, _message) {
      // Stub: PRIVMSG target :message
    },
    isConnected() {
      return connected;
    },
    joinedChannels() {
      return [...channels];
    },
  };
}

// ─── Real Implementation ───

/**
 * Parse an IRC message prefix into nick / user / host components.
 *
 * Prefix format: `nick!user@host`
 */
function parsePrefix(prefix: string): {
  nick: string;
  user?: string;
  host?: string;
} {
  const bangIdx = prefix.indexOf("!");
  const atIdx = prefix.indexOf("@");

  if (bangIdx === -1) {
    return { nick: prefix };
  }

  const nick = prefix.slice(0, bangIdx);
  const user = atIdx !== -1 ? prefix.slice(bangIdx + 1, atIdx) : prefix.slice(bangIdx + 1);
  const host = atIdx !== -1 ? prefix.slice(atIdx + 1) : undefined;

  return { nick, user, host };
}

/**
 * Create a real IRC connection service using raw TCP (or TLS) sockets.
 *
 * Handles the IRC registration handshake (PASS/NICK/USER), channel JOIN,
 * PING/PONG keepalive, and PRIVMSG parsing.
 */
export function createIrcConnectionService(): IrcConnectionService {
  let socket: net.Socket | tls.TLSSocket | null = null;
  let connected = false;
  let stopped = false; // P2-CH: Track explicit stop
  let channels: string[] = [];
  let lineBuffer = "";

  /** Write a raw IRC command followed by CRLF. */
  function sendRaw(command: string): void {
    if (!socket || socket.destroyed) {
      throw new FridayDomainError("NOT_INITIALIZED", "IRC socket is not connected", { httpStatus: 503 });
    }
    socket.write(`${command}\r\n`);
  }

  return {
    connect(
      options: IrcConnectionOptions,
      onMessage: (event: IrcPrivmsgEvent) => void,
    ): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (connected) {
          reject(new Error("IRC service is already connected"));
          return;
        }

        stopped = false;
        // Track whether we have resolved the initial connect promise
        let settled = false;
        const pendingChannels = new Set(options.channels.map((c) => c.toLowerCase()));
        channels = [];

        const settleTransportFailure = (message: string): void => {
          connected = false;
          if (socket && !socket.destroyed) {
            socket.destroy();
          }
          if (!settled) {
            settled = true;
            reject(new Error(message));
            return;
          }
          console.warn("[friday][irc-service] operation failed:", message);
        };

        const sendRawSafely = (
          command: string,
          failureMessage: string,
        ): boolean => {
          try {
            sendRaw(command);
            return true;
          } catch (err) {
            settleTransportFailure(
              `${failureMessage}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          }
        };

        // Create socket
        if (options.tls) {
          socket = tls.connect(
            { host: options.host, port: options.port, rejectUnauthorized: true },
            () => {
              // TLS handshake complete — send IRC registration
              sendRegistration();
            },
          );
        } else {
          socket = net.createConnection({ host: options.host, port: options.port }, () => {
            sendRegistration();
          });
        }

        function sendRegistration(): void {
          if (options.password) {
            if (!sendRawSafely(`PASS ${options.password}`, "Failed to send IRC password")) {
              return;
            }
          }
          if (!sendRawSafely(`NICK ${options.nick}`, "Failed to send IRC nickname")) {
            return;
          }
          sendRawSafely(
            `USER ${options.username ?? options.nick} 0 * :${options.nick}`,
            "Failed to send IRC user registration",
          );
        }

        socket.setEncoding("utf-8");

        socket.on("data", (chunk: string) => {
          lineBuffer += chunk;
          const lines = lineBuffer.split("\r\n");
          // Last element is either empty or an incomplete line
          lineBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line) continue;
            handleLine(line);
          }
        });

        socket.on("error", (err: Error) => {
          if (!settled) {
            settled = true;
            connected = false;
            reject(
              new Error(`IRC connection error: ${err.message}`),
            );
          }
        });

        socket.on("close", () => {
          connected = false;
          channels = [];
          socket = null;
          if (!stopped) {
            // P2-CH: Log disconnection — the channel registry health monitor will auto-restart
            console.warn("[friday] IRC socket closed unexpectedly");
          }
        });

        function handleLine(line: string): void {
          // PING/PONG keepalive — must respond immediately
          if (line.startsWith("PING")) {
            const token = line.slice(5); // after "PING "
            sendRawSafely(`PONG ${token}`, "Failed to respond to IRC ping");
            return;
          }

          // Parse the IRC message
          let prefix = "";
          let rest = line;

          if (rest.startsWith(":")) {
            const spaceIdx = rest.indexOf(" ");
            if (spaceIdx === -1) return;
            prefix = rest.slice(1, spaceIdx);
            rest = rest.slice(spaceIdx + 1);
          }

          const parts = rest.split(" ");
          const command = parts[0];

          // Numeric 001 (RPL_WELCOME) — registration succeeded, join channels
          if (command === "001") {
            connected = true;
            for (const chan of options.channels) {
              if (!sendRawSafely(`JOIN ${chan}`, `Failed to join IRC channel ${chan}`)) {
                return;
              }
            }
            // If there are no channels to join, resolve immediately
            if (pendingChannels.size === 0 && !settled) {
              settled = true;
              resolve();
            }
            return;
          }

          // JOIN confirmation — the server echoes our JOIN back
          if (command === "JOIN") {
            const joinedChan = (parts[1] ?? "").replace(/^:/, "").toLowerCase();
            if (pendingChannels.has(joinedChan)) {
              channels.push(joinedChan);
              pendingChannels.delete(joinedChan);
            } else if (!channels.includes(joinedChan)) {
              channels.push(joinedChan);
            }
            // Resolve the connect promise once all requested channels are joined
            if (pendingChannels.size === 0 && !settled) {
              settled = true;
              resolve();
            }
            return;
          }

          // PRIVMSG — the main event we care about
          if (command === "PRIVMSG" && parts.length >= 3) {
            const target = parts[1]!;
            // Message body is everything after the second " :" (or after target + space + colon)
            const msgIdx = rest.indexOf(" :", command.length);
            const message = msgIdx !== -1 ? rest.slice(msgIdx + 2) : "";
            const parsed = parsePrefix(prefix);

            onMessage({
              prefix,
              nick: parsed.nick,
              user: parsed.user,
              host: parsed.host,
              command: "PRIVMSG",
              target,
              message,
              timestamp: Date.now(),
            });
            return;
          }

          // Numeric 433 — nickname in use
          if (command === "433" && !settled) {
            settled = true;
            connected = false;
            reject(new Error("IRC nickname is already in use"));
            return;
          }

          // Numeric errors (400-599) before we settle
          if (
            command &&
            /^\d{3}$/.test(command) &&
            Number(command) >= 400 &&
            !settled
          ) {
            settled = true;
            connected = false;
            reject(new Error(`IRC registration error ${command}: ${rest}`));
          }
        }
      });
    },

    async disconnect(): Promise<void> {
      stopped = true;
      if (socket && !socket.destroyed) {
        try {
          sendRaw("QUIT :Goodbye");
        } catch (err) {
          console.warn("[friday][irc-service] operation failed:", err instanceof Error ? err.message : String(err));
          // Socket may already be broken
        }
        socket.destroy();
      }
      connected = false;
      channels = [];
      socket = null;
      lineBuffer = "";
    },

    async sendMessage(target: string, message: string): Promise<void> {
      if (!connected || !socket || socket.destroyed) {
        throw new FridayDomainError("NOT_INITIALIZED", "IRC: cannot send message — not connected", { httpStatus: 503 });
      }
      sendRaw(`PRIVMSG ${target} :${message}`);
    },

    isConnected(): boolean {
      return connected;
    },

    joinedChannels(): string[] {
      return [...channels];
    },
  };
}
