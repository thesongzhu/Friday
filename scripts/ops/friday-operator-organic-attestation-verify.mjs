#!/usr/bin/env node
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA = "friday.operator_organic_attestation.v1";
const SOURCE = "operator_signature";

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(4);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(`invalid arguments near ${key ?? "<end>"}`);
    }
    out[key.slice(2)] = value;
  }
  return out;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function requireString(record, field) {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`attestation field ${field} must be a non-empty string`);
  }
  return value.trim();
}

const args = parseArgs(process.argv.slice(2));
const attestationPath = args.attestation;
const publicKeyPath = args["public-key"];
const route = args.route;
const taskSha256 = args["task-sha256"];

if (!attestationPath || !publicKeyPath || !route || !taskSha256) {
  fail("requires --attestation, --public-key, --route, and --task-sha256");
}
if (!/^[a-f0-9]{64}$/i.test(taskSha256)) {
  fail("task sha256 must be a 64-character hex digest");
}

let attestation;
try {
  attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
} catch {
  fail(`could not read attestation JSON at ${attestationPath}`);
}
if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
  fail("attestation must be a JSON object");
}

const signedPayload = {
  issuedAt: requireString(attestation, "issuedAt"),
  principal: requireString(attestation, "principal"),
  publicKeyId: requireString(attestation, "publicKeyId"),
  route: requireString(attestation, "route"),
  schema: requireString(attestation, "schema"),
  source: requireString(attestation, "source"),
  taskSha256: requireString(attestation, "taskSha256").toLowerCase(),
};

if (signedPayload.schema !== SCHEMA) fail(`attestation schema must be ${SCHEMA}`);
if (signedPayload.source !== SOURCE) fail(`attestation source must be ${SOURCE}`);
if (signedPayload.route !== route.trim()) fail("attestation route does not match requested route");
if (signedPayload.taskSha256 !== taskSha256.toLowerCase()) {
  fail("attestation task sha256 does not match requested task");
}

const signature = requireString(attestation, "signature");
let publicKey;
try {
  publicKey = createPublicKey(readFileSync(publicKeyPath, "utf8"));
} catch {
  fail(`could not read Ed25519 public key at ${publicKeyPath}`);
}
if (publicKey.asymmetricKeyType !== "ed25519") {
  fail("operator attestation verify key must be Ed25519");
}

const ok = verify(
  null,
  Buffer.from(stableStringify(signedPayload), "utf8"),
  publicKey,
  Buffer.from(signature, "base64"),
);
if (!ok) fail("operator signature attestation verification failed");

const resolvedAttestationPath = resolve(attestationPath);
process.stdout.write(JSON.stringify({
  organic: true,
  principal: signedPayload.principal,
  source: SOURCE,
  attestationRef: pathToFileURL(resolvedAttestationPath).href,
  publicKeyId: signedPayload.publicKeyId,
  taskSha256: signedPayload.taskSha256,
  issuedAt: signedPayload.issuedAt,
  route: signedPayload.route,
}));
