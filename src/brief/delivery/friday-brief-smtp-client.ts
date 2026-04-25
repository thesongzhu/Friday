import * as net from "node:net";
import * as tls from "node:tls";

/**
 * Minimal RFC-5321/5322 SMTP client — text-only helpers for daily brief email delivery.
 *
 * This is deliberately small. It supports:
 *   - Implicit TLS (port 465) and STARTTLS upgrade (port 587).
 *   - AUTH LOGIN with base64-encoded username/password.
 *   - Single recipient MAIL FROM / RCPT TO / DATA flow.
 *
 * It does NOT support: multiple recipients, CC/BCC, pipelining, SMTPUTF8 tricks.
 * For richer mail we'd bring in nodemailer; for a daily brief this suffices.
 */

export interface FridayBriefSmtpEnvelope {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  to: string;
  /** Raw RFC-5322 message body including headers. */
  message: string;
}

interface SmtpSocket {
  write: (data: string) => void;
  end: () => void;
  destroy: () => void;
  onData: (listener: (chunk: string) => void) => void;
  onError: (listener: (err: Error) => void) => void;
  onClose: (listener: () => void) => void;
}

function wrapSocket(sock: net.Socket | tls.TLSSocket): SmtpSocket {
  const dataListeners: Array<(chunk: string) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const closeListeners: Array<() => void> = [];
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    for (const l of dataListeners) l(chunk);
  });
  sock.on("error", (err) => {
    for (const l of errorListeners) l(err);
  });
  sock.on("close", () => {
    for (const l of closeListeners) l();
  });
  return {
    write: (data) => {
      sock.write(data);
    },
    end: () => {
      sock.end();
    },
    destroy: () => {
      sock.destroy();
    },
    onData: (listener) => {
      dataListeners.push(listener);
    },
    onError: (listener) => {
      errorListeners.push(listener);
    },
    onClose: (listener) => {
      closeListeners.push(listener);
    },
  };
}

async function readReply(
  sock: SmtpSocket,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("smtp_reply_timeout"));
    }, timeoutMs);
    const abortHandler = () => {
      cleanup();
      reject(new Error("smtp_aborted"));
    };
    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortHandler);
    }
    signal.addEventListener("abort", abortHandler, { once: true });
    sock.onData((chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r\n/);
      if (lines.length < 2) return;
      const last = lines[lines.length - 2];
      if (!/^\d{3}[ -]/.test(last)) return;
      if (last[3] === "-") return;
      const code = Number(last.slice(0, 3));
      cleanup();
      resolve({ code, text: buffer.trim() });
    });
    sock.onError((err) => {
      cleanup();
      reject(err);
    });
  });
}

async function expect(
  sock: SmtpSocket,
  signal: AbortSignal,
  expected: number,
): Promise<string> {
  const reply = await readReply(sock, signal);
  if (reply.code !== expected) {
    throw new Error(`smtp_unexpected_${reply.code}:${reply.text}`);
  }
  return reply.text;
}

async function sendCommand(
  sock: SmtpSocket,
  signal: AbortSignal,
  command: string,
  expected: number,
): Promise<string> {
  sock.write(`${command}\r\n`);
  return expect(sock, signal, expected);
}

export async function sendFridayBriefEmail(
  envelope: FridayBriefSmtpEnvelope,
  signal: AbortSignal,
): Promise<void> {
  const { host, port, secure, username, password, from, to, message } = envelope;

  const raw = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  const sock = wrapSocket(raw);
  try {
    await new Promise<void>((resolve, reject) => {
      const abortHandler = (): void => {
        raw.destroy();
        reject(new Error("smtp_aborted"));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
      raw.once("error", (err) => {
        signal.removeEventListener("abort", abortHandler);
        reject(err);
      });
      const readyEvent = secure ? "secureConnect" : "connect";
      raw.once(readyEvent, () => {
        signal.removeEventListener("abort", abortHandler);
        resolve();
      });
    });

    await expect(sock, signal, 220);
    const ehloHost = "friday.local";
    const ehloText = await sendCommand(sock, signal, `EHLO ${ehloHost}`, 250);

    let authenticatedSocket = sock;
    let authenticatedRaw: net.Socket | tls.TLSSocket = raw;

    if (!secure && /STARTTLS/i.test(ehloText)) {
      await sendCommand(sock, signal, "STARTTLS", 220);
      const upgraded = tls.connect({
        socket: raw,
        host,
        servername: host,
      });
      await new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", () => resolve());
        upgraded.once("error", reject);
      });
      authenticatedRaw = upgraded;
      authenticatedSocket = wrapSocket(upgraded);
      await sendCommand(authenticatedSocket, signal, `EHLO ${ehloHost}`, 250);
    }

    const authUser = Buffer.from(username, "utf8").toString("base64");
    const authPass = Buffer.from(password, "utf8").toString("base64");
    await sendCommand(authenticatedSocket, signal, "AUTH LOGIN", 334);
    await sendCommand(authenticatedSocket, signal, authUser, 334);
    await sendCommand(authenticatedSocket, signal, authPass, 235);

    await sendCommand(authenticatedSocket, signal, `MAIL FROM:<${from}>`, 250);
    await sendCommand(authenticatedSocket, signal, `RCPT TO:<${to}>`, 250);
    await sendCommand(authenticatedSocket, signal, "DATA", 354);

    const dotStuffed = message.replace(/\r?\n\./g, "\r\n..");
    authenticatedSocket.write(`${dotStuffed}\r\n.\r\n`);
    await expect(authenticatedSocket, signal, 250);

    authenticatedSocket.write("QUIT\r\n");
    authenticatedRaw.end();
  } finally {
    if (!raw.destroyed) raw.destroy();
  }
}
