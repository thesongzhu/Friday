// Phase L — realtime WS upgrade validation. Uses raw HTTP upgrade so we can capture
// Friday's exact Sec-WebSocket-Accept header and compare it with RFC 6455.
import { startPhase, sleep, api } from "../lib/util.mjs";
import { createConnection } from "node:net";
import { createHash, randomBytes } from "node:crypto";

const RFC6455_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function expectedAccept(key) {
  return createHash("sha1").update(key + RFC6455_GUID).digest("base64");
}

export async function runPhaseL(ctx) {
  const p = startPhase("L");
  try {
    const key = randomBytes(16).toString("base64");
    const expected = expectedAccept(key);
    p.note(`upgrade key=${key} expected accept=${expected}`);
    const result = await new Promise((resolve, reject) => {
      const sock = createConnection({ host: "127.0.0.1", port: 3144 });
      let buf = "";
      const lines = [
        "GET /v1/realtime/ws HTTP/1.1",
        "Host: 127.0.0.1:3144",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Authorization: Bearer ${ctx.tokens.accessToken}`,
        "", "",
      ].join("\r\n");
      sock.on("error", reject);
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const idx = buf.indexOf("\r\n\r\n");
        if (idx >= 0) {
          const headPart = buf.slice(0, idx);
          const headers = Object.fromEntries(
            headPart.split(/\r\n/).slice(1).map(l => {
              const colonIdx = l.indexOf(":");
              return colonIdx > 0 ? [l.slice(0, colonIdx).trim().toLowerCase(), l.slice(colonIdx + 1).trim()] : null;
            }).filter(Boolean),
          );
          sock.destroy();
          resolve({
            status: headPart.split(/\r\n/)[0],
            headers,
            actualAccept: headers["sec-websocket-accept"],
            upgrade: headers["upgrade"],
            connection: headers["connection"],
          });
        }
      });
      sock.write(lines);
    });
    p.addEvidence("upgrade-response.json", { ...result, expectedAccept: expected, key });
    const accepted = result.actualAccept;
    const matches = accepted === expected;
    p.note(`actualAccept=${accepted} expectedAccept=${expected} matches=${matches}`);
    const anomalies = [];
    if (!matches) anomalies.push({severity:"high", note:`Friday's Sec-WebSocket-Accept "${accepted}" does NOT match RFC 6455 canonical "${expected}". Standard WS clients (browsers, ws lib, Node native WebSocket) will reject the upgrade.`});
    p.finish("PASS", `WS upgrade response captured; accept matches RFC=${matches}`, anomalies);
  } catch (e) {
    p.finish("FAIL", String(e?.stack || e), [{severity:"high", note:"realtime ws threw"}]);
  }
}
