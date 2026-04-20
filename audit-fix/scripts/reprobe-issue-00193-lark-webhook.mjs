import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

import { createFridayChannelWebhookRoutes } from "../../dist/api/http/routes/friday-channel-webhook-routes.js";
import { createLarkWebhookRelayService } from "../../dist/channels/lark/lark-webhook-relay.js";

const outDir = resolve(process.argv[2] ?? "audit-fix/post-fix-evidence/issue-00193-rerun-current");
mkdirSync(outDir, { recursive: true });

const verificationToken = "lark-verify-token-reprobe";
const encryptKey = "lark-encrypt-key-reprobe";
const timestamp = "1700000000";
const nonce = "nonce-reprobe-001";

const dispatched = [];
const relay = createLarkWebhookRelayService();
relay.setVerificationToken(verificationToken);
relay.setEncryptKey(encryptKey);
await relay.start((payload) => {
  dispatched.push(payload);
});

const routes = createFridayChannelWebhookRoutes({ larkWebhookRelay: relay });
const route = routes.find((entry) => entry.operationId === "channels.webhooks.lark");
if (!route) {
  throw new Error("channels.webhooks.lark route not found");
}

function normalizeHeaders(rawHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === "string") {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && typeof value[0] === "string") {
      headers[key.toLowerCase()] = value[0];
    }
  }
  return headers;
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/channel-webhooks/lark") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }));
    return;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString("utf-8");

  try {
    const result = await route.handler({
      requestId: randomUUID(),
      receivedAt: new Date().toISOString(),
      params: {},
      query: {},
      body: {},
      headers: normalizeHeaders(req.headers),
      principal: null,
      rawBody,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (error) {
    const statusCode = Number.isInteger(error?.httpStatus) ? error.httpStatus : 500;
    res.writeHead(statusCode, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      error: {
        code: error?.code ?? "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
        details: error?.details ?? null,
      },
    }));
  }
});

const listening = await new Promise((resolvePromise) => {
  server.listen(0, "127.0.0.1", () => {
    resolvePromise(server.address());
  });
});

if (!listening || typeof listening !== "object") {
  throw new Error("failed to bind probe server");
}

const baseUrl = `http://127.0.0.1:${listening.port}`;

async function postJson(body, headers = {}) {
  const response = await fetch(`${baseUrl}/v1/channel-webhooks/lark`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return {
    status: response.status,
    json,
  };
}

const challengeAcceptedBody = JSON.stringify({
  type: "url_verification",
  token: verificationToken,
  challenge: "challenge-ok",
});
const challengeRejectedBody = JSON.stringify({
  type: "url_verification",
  token: "wrong-token",
  challenge: "challenge-no",
});
const invalidTokenBody = JSON.stringify({
  schema: "2.0",
  header: { event_type: "im.message.receive_v1", token: "wrong-token" },
  event: { message: { message_id: "om_invalid" } },
});
const validEventBody = JSON.stringify({
  schema: "2.0",
  header: { event_type: "im.message.receive_v1", token: verificationToken },
  event: {
    message: {
      message_id: "om_valid",
      chat_id: "oc_probe",
      chat_type: "group",
      content: "{\"text\":\"probe live\"}",
      create_time: "1708416000000",
    },
    sender: {
      sender_id: {
        open_id: "ou_probe",
      },
    },
  },
});

const validSignature = createHash("sha256")
  .update(`${timestamp}${nonce}${encryptKey}${validEventBody}`, "utf-8")
  .digest("hex");
const brokenLegacySignature = createHash("sha256")
  .update(`${timestamp}${nonce}${encryptKey}`, "utf-8")
  .digest("hex");

const summary = {
  verificationToken,
  encryptKeyConfigured: true,
  baseUrl,
  challengeAccepted: await postJson(challengeAcceptedBody),
  challengeRejected: await postJson(challengeRejectedBody),
  invalidToken: await postJson(invalidTokenBody),
  missingSignature: await postJson(validEventBody),
  invalidSignature: await postJson(validEventBody, {
    "x-lark-signature": brokenLegacySignature,
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
  }),
  validEvent: await postJson(validEventBody, {
    "x-lark-signature": validSignature,
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
  }),
  dispatchedCount: dispatched.length,
  dispatchedEventType:
    typeof dispatched[0]?.header?.event_type === "string"
      ? dispatched[0].header.event_type
      : null,
  dispatchedMessageId:
    typeof dispatched[0]?.event?.message?.message_id === "string"
      ? dispatched[0].event.message.message_id
      : null,
};

writeFileSync(
  resolve(outDir, "issue-00193-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);

server.close();
