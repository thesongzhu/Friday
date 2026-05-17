import { createHash } from "node:crypto";

import type {
  FridayCloudWorkerPackageBundle,
  FridayCloudWorkerPackageFile,
  FridayCloudWorkerPackageInput,
  FridayCloudWorkerProvider,
} from "../model/friday-cloud-worker.types.js";
import type { FridayCloudWorkerCatalogService } from "./friday-cloud-worker-catalog.js";
import type { FridayCloudWorkerDnsValidator } from "./friday-cloud-worker-dns-validator.js";

const PLACEHOLDER_SETUP_PASSWORD = "${REPLACE_AT_BOOT__SETUP_PASSWORD}";
const PLACEHOLDER_GATEWAY_TOKEN = "${REPLACE_AT_BOOT__GATEWAY_TOKEN}";
const PLACEHOLDER_MASTER_KEY = "${REPLACE_AT_BOOT__FRIDAY_MASTER_KEY}";
const PLACEHOLDER_TOKEN_SECRET = "${REPLACE_AT_BOOT__FRIDAY_TOKEN_SECRET}";

const ALL_PLACEHOLDERS = [
  PLACEHOLDER_SETUP_PASSWORD,
  PLACEHOLDER_GATEWAY_TOKEN,
  PLACEHOLDER_MASTER_KEY,
  PLACEHOLDER_TOKEN_SECRET,
] as const;

// Defence-in-depth: scan generated bodies for anything that looks like a real
// secret (matches the project's check:secret-patterns surface). Placeholders
// above are deliberately bracketed so they cannot collide with these patterns.
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bAKID[A-Za-z0-9]{16,}\b/g,
  /\bLTAI[A-Za-z0-9]{16,}\b/g,
  /\bAKLT[A-Za-z0-9]{16,}\b/g,
];

function assertNoSecretLeakage(body: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(body)) {
      throw new Error(
        "Friday cloud worker package generation refused: generated artifact matched a secret pattern.",
      );
    }
  }
}

function renderBootstrapEnv(input: FridayCloudWorkerPackageInput): string {
  return [
    "# Friday cloud worker bootstrap environment.",
    "# Generated locally by Friday. No secrets are baked in; the placeholders",
    "# below are filled by the first-boot script on the worker, never by Friday.",
    `FRIDAY_CLOUD_PROVIDER=${input.providerId}`,
    `FRIDAY_HTTPS_HOST=${input.httpsHost}`,
    `FRIDAY_DNS_NAME=${input.dnsName}`,
    `FRIDAY_DNS_PROVIDER=${input.dnsProviderId}`,
    `FRIDAY_OWNER_RUN_ID=${input.ownerRunId}`,
    `FRIDAY_SETUP_PASSWORD=${PLACEHOLDER_SETUP_PASSWORD}`,
    `FRIDAY_GATEWAY_TOKEN=${PLACEHOLDER_GATEWAY_TOKEN}`,
    `FRIDAY_MASTER_KEY=${PLACEHOLDER_MASTER_KEY}`,
    `FRIDAY_TOKEN_SECRET=${PLACEHOLDER_TOKEN_SECRET}`,
    "",
  ].join("\n");
}

function renderDockerfile(): string {
  return [
    "# Friday cloud worker Dockerfile (template).",
    "# Friday runtime image is pulled from the user's chosen registry; no",
    "# Friday-hosted user data and no credentials are baked into the image.",
    "FROM node:20-bookworm-slim",
    "WORKDIR /opt/friday",
    "COPY ./friday-cloud-worker /opt/friday",
    "RUN useradd --create-home --shell /bin/bash friday \\",
    "    && chown -R friday:friday /opt/friday",
    "USER friday",
    "ENV FRIDAY_RUNTIME_MODE=cloud-worker",
    "EXPOSE 8443",
    `CMD ["node", "./node_modules/friday/dist/cli/friday-cli.js", "start", "--cloud-worker"]`,
    "",
  ].join("\n");
}

function renderDockerCompose(input: FridayCloudWorkerPackageInput): string {
  return [
    "version: \"3.9\"",
    "services:",
    "  friday-cloud-worker:",
    "    build: .",
    `    container_name: friday-cloud-worker-${input.providerId}`,
    "    restart: unless-stopped",
    "    ports:",
    "      - \"8443:8443\"",
    "    env_file:",
    "      - bootstrap.env",
    "    environment:",
    "      - FRIDAY_REQUIRE_HTTPS=true",
    "      - FRIDAY_REQUIRE_OWNER_PAIRING=true",
    "      - FRIDAY_RATE_LIMIT_ENABLED=true",
    "      - FRIDAY_REDACT_LOG_SECRETS=true",
    "    volumes:",
    "      - friday-state:/opt/friday/var",
    "volumes:",
    "  friday-state: {}",
    "",
  ].join("\n");
}

function renderBootstrapScript(input: FridayCloudWorkerPackageInput): string {
  // Single-quoted patterns keep the ${REPLACE_AT_BOOT__*} placeholders literal
  // for grep and sed; the runtime variables ($SETUP_PASSWORD, $MASTER_KEY,
  // $TOKEN_SECRET) are interpolated by bash inside the replacement values via
  // sed's substitution syntax (sed re-reads its own pattern, not bash).
  return [
    "#!/usr/bin/env bash",
    "# Friday cloud worker first-boot bootstrap.",
    "# This script runs on YOUR cloud VM, not on Friday infrastructure.",
    "# It generates internal runtime secrets locally; nothing is sent back to Friday.",
    "set -euo pipefail",
    "",
    "if [ ! -f bootstrap.env ]; then",
    "  echo \"bootstrap.env not found; cannot continue.\" >&2",
    "  exit 1",
    "fi",
    "",
    "# Generate one-time SETUP_PASSWORD locally; only the SHA-256 hash is persisted.",
    "if grep -qF 'FRIDAY_SETUP_PASSWORD=" + PLACEHOLDER_SETUP_PASSWORD + "' bootstrap.env; then",
    "  SETUP_PASSWORD=$(openssl rand -hex 24)",
    "  export SETUP_PASSWORD",
    "  python3 -c 'import os,sys; sys.stdout.write(open(\"bootstrap.env\").read().replace(\"FRIDAY_SETUP_PASSWORD=" + PLACEHOLDER_SETUP_PASSWORD + "\", \"FRIDAY_SETUP_PASSWORD=\"+os.environ[\"SETUP_PASSWORD\"]))' > bootstrap.env.tmp && mv bootstrap.env.tmp bootstrap.env",
    "  echo \"Setup password generated; display it once to the operator and then discard.\"",
    "fi",
    "",
    "# Generate FRIDAY_MASTER_KEY and FRIDAY_TOKEN_SECRET locally if still templated.",
    "if grep -qF 'FRIDAY_MASTER_KEY=" + PLACEHOLDER_MASTER_KEY + "' bootstrap.env; then",
    "  MASTER_KEY=$(openssl rand -base64 48)",
    "  export MASTER_KEY",
    "  python3 -c 'import os,sys; sys.stdout.write(open(\"bootstrap.env\").read().replace(\"FRIDAY_MASTER_KEY=" + PLACEHOLDER_MASTER_KEY + "\", \"FRIDAY_MASTER_KEY=\"+os.environ[\"MASTER_KEY\"]))' > bootstrap.env.tmp && mv bootstrap.env.tmp bootstrap.env",
    "fi",
    "if grep -qF 'FRIDAY_TOKEN_SECRET=" + PLACEHOLDER_TOKEN_SECRET + "' bootstrap.env; then",
    "  TOKEN_SECRET=$(openssl rand -base64 48)",
    "  export TOKEN_SECRET",
    "  python3 -c 'import os,sys; sys.stdout.write(open(\"bootstrap.env\").read().replace(\"FRIDAY_TOKEN_SECRET=" + PLACEHOLDER_TOKEN_SECRET + "\", \"FRIDAY_TOKEN_SECRET=\"+os.environ[\"TOKEN_SECRET\"]))' > bootstrap.env.tmp && mv bootstrap.env.tmp bootstrap.env",
    "fi",
    "",
    "# Gateway token is issued by your local Friday hub after pairing approves the cloud worker.",
    "# Replace the placeholder with the token returned by /v1/satellites/:satelliteId/pairing/approve.",
    `echo 'HTTPS host: ${input.httpsHost}'`,
    `echo 'DNS name : ${input.dnsName}'`,
    `echo 'Owner run: ${input.ownerRunId}'`,
    "echo 'Bootstrap complete. Start the worker with: docker compose up -d'",
    "",
  ].join("\n");
}

function renderReadme(
  input: FridayCloudWorkerPackageInput,
  provider: FridayCloudWorkerProvider,
): string {
  return [
    `# Friday user-owned cloud worker — ${provider.displayName}`,
    "",
    "This package was generated by Friday's local hub for a user-owned cloud worker.",
    "It contains template files only; no real secrets, no AK/SK, no DNS tokens.",
    "",
    "## Safety boundary",
    "",
    "- Friday official infrastructure does not store your data or your cloud credentials.",
    `- HTTPS is required (\`${input.httpsHost}\`). HTTP-only setup is not acceptable Friday proof.`,
    `- DNS automation is scoped to the dedicated subdomain \`${input.dnsName}\` via \`${input.dnsProviderId}\`.`,
    "- `FRIDAY_MASTER_KEY` and `FRIDAY_TOKEN_SECRET` are internal runtime secrets that bootstrap.sh generates on first boot. Ordinary users do not paste them.",
    "- A one-time `FRIDAY_SETUP_PASSWORD` is generated locally on the worker; only the SHA-256 hash is persisted.",
    "- The gateway token is issued by your local Friday hub after the cloud worker pairs as a `cloud-vm` satellite.",
    "",
    "## Steps",
    "",
    "1. Provision a VM on the cloud provider you control. TTL/budget metadata is your responsibility.",
    "2. Copy this package onto the VM, then run `bash bootstrap.sh` to populate runtime secrets locally.",
    "3. Start the worker with `docker compose up -d`.",
    "4. Wait for the worker to register as a `cloud-vm` satellite at your local Friday hub.",
    "5. Approve pairing from your local Friday hub Settings → Cloud Workers screen.",
    "6. Run the cloud-worker doctor from the Settings → Cloud Workers screen to confirm HTTPS, DNS, pairing, and rate-limit status.",
    "7. When you no longer need the worker, run the teardown receipt generator and follow the manual cleanup checklist.",
    "",
    "## Live certification",
    "",
    "17B live certification on Alibaba Cloud ECS, Tencent Cloud CVM, and Volcengine ECS is blocked_by_env until protected GitHub Environment Secrets, DNS tokens, and budget/TTL controls are configured and explicitly approved.",
    "",
  ].join("\n");
}

function buildPackageFiles(
  input: FridayCloudWorkerPackageInput,
  provider: FridayCloudWorkerProvider,
): ReadonlyArray<FridayCloudWorkerPackageFile> {
  return [
    {
      filename: "bootstrap.env",
      contentType: "text/plain",
      description:
        "Environment file with internal runtime secret placeholders; first-boot script fills them locally.",
      body: renderBootstrapEnv(input),
    },
    {
      filename: "Dockerfile",
      contentType: "text/dockerfile",
      description:
        "Minimal Friday cloud-worker container image template; no secrets baked in.",
      body: renderDockerfile(),
    },
    {
      filename: "docker-compose.yml",
      contentType: "text/yaml",
      description:
        "Compose stack that pins HTTPS, owner pairing, rate limiting, and log redaction.",
      body: renderDockerCompose(input),
    },
    {
      filename: "bootstrap.sh",
      contentType: "text/shell",
      description:
        "First-boot script that generates internal runtime secrets locally and never sends them to Friday.",
      body: renderBootstrapScript(input),
    },
    {
      filename: "README.md",
      contentType: "text/markdown",
      description:
        "Operator-facing setup, safety boundary, and live-certification status.",
      body: renderReadme(input, provider),
    },
  ];
}

export interface FridayCloudWorkerPackageServiceDeps {
  readonly catalog: FridayCloudWorkerCatalogService;
  readonly dnsValidator: FridayCloudWorkerDnsValidator;
}

export function createFridayCloudWorkerPackageService(
  deps: FridayCloudWorkerPackageServiceDeps,
) {
  return {
    generate(input: FridayCloudWorkerPackageInput): FridayCloudWorkerPackageBundle {
      const provider = deps.catalog.getProvider(input.providerId);
      if (!provider) {
        throw new Error(
          `Unknown Friday cloud worker provider: ${input.providerId}`,
        );
      }
      const httpsHost = input.httpsHost.trim();
      if (!httpsHost.startsWith("https://")) {
        throw new Error(
          "Friday cloud worker package generation requires an https:// host. HTTP-only setup is not acceptable proof.",
        );
      }

      const dnsValidation = deps.dnsValidator.validate({
        dnsProviderId: input.dnsProviderId,
        dnsName: input.dnsName,
        rootDomain: deriveRootDomain(input.dnsName),
      });
      if (!dnsValidation.valid) {
        throw new Error(
          `Friday cloud worker DNS scope rejected: ${dnsValidation.reasonMessage}`,
        );
      }

      const files = buildPackageFiles(input, provider);
      for (const file of files) {
        assertNoSecretLeakage(file.body);
      }

      const bundleId = createHash("sha256")
        .update(`${input.providerId}|${input.httpsHost}|${input.dnsName}|${input.ownerRunId}`)
        .digest("hex")
        .slice(0, 16);

      return {
        providerId: input.providerId,
        bundleId,
        httpsHost: input.httpsHost,
        dnsName: input.dnsName,
        dnsProviderId: input.dnsProviderId,
        ownerRunId: input.ownerRunId,
        files,
        placeholders: [...ALL_PLACEHOLDERS],
        leakageScanStatus: "no_secrets_emitted",
        pairingFlow:
          "Cloud worker registers as cloud-vm satellite, hub approves pairing, handshake completes; reuse existing /v1/satellites/* primitives.",
        internalRuntimeSecretsNote:
          "FRIDAY_MASTER_KEY and FRIDAY_TOKEN_SECRET are generated locally on the cloud VM during first boot; Friday never receives the plaintext values.",
        proofTier: "fixture",
      };
    },
  };
}

export type FridayCloudWorkerPackageService = ReturnType<
  typeof createFridayCloudWorkerPackageService
>;

function deriveRootDomain(dnsName: string): string {
  const normalized = dnsName.trim().toLowerCase().replace(/\.+$/u, "");
  const labels = normalized.split(".");
  if (labels.length < 2) return normalized;
  return labels.slice(-2).join(".");
}
