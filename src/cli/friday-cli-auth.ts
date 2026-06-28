/**
 * CLI auth commands for provider credential setup.
 *
 * Supported flows:
 * - `friday auth login anthropic`
 * - `friday auth setup-token anthropic`
 * - `friday auth paste-token anthropic`
 * - `friday auth attach-cli codex|claude`
 * - `friday auth status [--provider-id <id>]`
 */

import { execFile as cpExecFile } from "node:child_process";
import {
  probeFridayCliSession,
} from "#providers";
import type {
  FridayProviderCliBackendId,
  FridayProviderKind,
  FridayProviderService,
} from "#providers";
import { FridayDomainError } from "#errors";
import { buildOpenBrowserUrlCommand } from "./friday-cli-open-url.js";

export {
  buildOpenBrowserUrlCommand,
  buildOpenBrowserUrlCommand as buildOpenAuthorizationUrlCommand,
} from "./friday-cli-open-url.js";

// ─── Types ───

export interface FridayCliAuthCommandInput {
  providerId?: string;
  code?: string;
  token?: string;
  binaryPath?: string;
  authTarget?: string;
  noBrowser?: boolean;
}

export interface FridayCliAuthCommandDeps {
  providerService: FridayProviderService;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

const DEFAULT_ANTHROPIC_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-8",
];

const CLI_AUTH_TARGETS = {
  codex: {
    kind: "openai-codex" as FridayProviderKind,
    backendId: "codex-cli" as FridayProviderCliBackendId,
    name: "Codex CLI",
    supportedModels: ["gpt-5.4"],
    defaultModel: "gpt-5.4",
  },
  claude: {
    kind: "anthropic" as FridayProviderKind,
    backendId: "claude-cli" as FridayProviderCliBackendId,
    name: "Claude CLI",
    supportedModels: DEFAULT_ANTHROPIC_MODELS,
    defaultModel: DEFAULT_ANTHROPIC_MODELS[0]!,
  },
} as const;

async function readCliInput(prompt: string, stdout: (message: string) => void): Promise<string> {
  stdout(prompt);
  return new Promise<string>((resolve) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      chunks.push(chunk);
      const text = chunks.join("").trim();
      if (text.length > 0) {
        process.stdin.pause();
        resolve(text);
      }
    });
    process.stdin.resume();
  });
}

async function resolveAnthropicProviderForTokenAuth(
  input: FridayCliAuthCommandInput,
  deps: FridayCliAuthCommandDeps,
): Promise<{ providerId: string; created: boolean }> {
  const { providerService, stderr } = deps;

  if (input.providerId) {
    const provider = await providerService.getProvider(input.providerId);
    if (!provider) {
      throw new FridayDomainError("PROVIDER_NOT_FOUND", `Provider "${input.providerId}" not found`, {
        httpStatus: 404,
      });
    }
    if (provider.kind !== "anthropic") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `Provider "${provider.id}" is kind "${provider.kind}", not anthropic`,
        { httpStatus: 400 },
      );
    }
    return { providerId: provider.id, created: false };
  }

  const providers = await providerService.listProviders();
  const anthropicProviders = providers.filter((provider) => provider.kind === "anthropic");

  if (anthropicProviders.length === 0) {
    const created = await providerService.createProvider({
      kind: "anthropic",
      name: "Claude Setup Token",
      baseUrl: "https://api.anthropic.com",
      authMode: "token",
      api: "anthropic-messages",
      supportedModels: DEFAULT_ANTHROPIC_MODELS,
      defaultModel: DEFAULT_ANTHROPIC_MODELS[0],
      validateOnSave: false,
    });
    return { providerId: created.id, created: true };
  }

  const enabledProviders = anthropicProviders.filter((provider) => provider.enabled);
  const candidates = enabledProviders.length > 0 ? enabledProviders : anthropicProviders;
  if (candidates.length === 1) {
    return { providerId: candidates[0]!.id, created: false };
  }

  stderr("Multiple Anthropic providers found. Please specify one with --provider-id:");
  for (const provider of candidates) {
    stderr(`  ${provider.id}  ${provider.name}  auth=${provider.config.authMode}`);
  }
  throw new FridayDomainError(
    "VALIDATION_ERROR",
    "Multiple Anthropic providers are configured. Re-run with --provider-id.",
    { httpStatus: 400 },
  );
}

/** Runs `friday auth login anthropic` CLI flow end-to-end. */
export async function runFridayCliAuthLoginAnthropic(
  input: FridayCliAuthCommandInput,
  deps: FridayCliAuthCommandDeps,
): Promise<void> {
  const { providerService, stdout, stderr } = deps;

  // ─── Resolve provider profile ───

  let providerId = input.providerId;

  if (!providerId) {
    const providers = await providerService.listProviders();
    const oauthProviders = providers.filter(
      (p) => p.enabled && p.kind === "anthropic" && p.config.authMode === "oauth",
    );

    if (oauthProviders.length === 0) {
      stderr("No enabled Anthropic providers with authMode 'oauth' found.");
      stderr("Create one first with: friday provider create --kind anthropic --auth-mode oauth");
      return;
    }
    if (oauthProviders.length > 1) {
      stderr("Multiple OAuth Anthropic providers found. Please specify one with --provider-id:");
      for (const p of oauthProviders) {
        stderr(`  ${p.id}  ${p.name}`);
      }
      return;
    }
    providerId = oauthProviders[0]!.id;
  }

  // ─── Initiate OAuth login ───

  stdout(`\n🔐 Initiating Anthropic OAuth login for provider ${providerId}…\n`);

  const initiation = await providerService.initiateOAuthLogin({ providerId });

  // Open browser automatically unless --no-browser was passed
  if (!input.noBrowser) {
    const { command, args } = buildOpenBrowserUrlCommand(initiation.authorizationUrl);
    cpExecFile(command, args, { windowsHide: true }, (err) => {
      if (err) {
        stderr("Could not open browser automatically.");
      }
    });
  }

  stdout("Open this URL in your browser to authorize:\n");
  stdout(`  ${initiation.authorizationUrl}\n`);

  // ─── Get authorization code ───

  let authCode = input.code;

  if (!authCode) {
    authCode = await readCliInput("\nAfter authorizing, paste the code (format: code#state) here:\n", stdout);
  }

  if (!authCode || authCode.trim() === "") {
    stderr("No authorization code provided. Aborting.");
    return;
  }

  // ─── Complete OAuth login ───

  const result = await providerService.completeOAuthLogin({
    providerId,
    authorizationCode: authCode.trim(),
  });

  stdout(`\n✅ Connected! Provider: ${result.providerId}`);
  stdout(`   OAuth provider: ${result.oauthProvider}`);
  stdout(`   Token expires: ${result.expiresAt}`);
  stdout(`   Scope: ${result.scope}\n`);
}

export async function runFridayCliAuthConnectAnthropicToken(
  input: FridayCliAuthCommandInput,
  deps: FridayCliAuthCommandDeps,
  mode: "setup-token" | "paste-token",
): Promise<void> {
  const { providerService, stdout, stderr } = deps;
  const resolved = await resolveAnthropicProviderForTokenAuth(input, deps);

  if (resolved.created) {
    stdout(`\nCreated Anthropic provider ${resolved.providerId} for token auth.\n`);
  }

  let token = input.token?.trim();
  if (!token) {
    token = await readCliInput(
      mode === "setup-token"
        ? "\nRun `claude setup-token`, then paste the token here:\n"
        : "\nPaste the Anthropic setup-token here:\n",
      stdout,
    );
  }

  if (!token || token.trim() === "") {
    stderr("No token provided. Aborting.");
    return;
  }

  stdout(`\nConnecting Anthropic token auth for provider ${resolved.providerId}…\n`);

  const profile = await providerService.updateProvider(resolved.providerId, {
    authMode: "token",
    apiKey: token.trim(),
    validateOnSave: true,
  });

  stdout(`\nConnected! Provider: ${profile.id}`);
  stdout(`   Auth mode: ${profile.config.authMode}`);
  stdout(`   Validation: ${profile.config.validation?.status ?? "unknown"}`);
  if (profile.config.validation?.errorMessage) {
    stdout(`   Details: ${profile.config.validation.errorMessage}`);
  }
  stdout("");
}

export async function runFridayCliAuthAttachCli(
  input: FridayCliAuthCommandInput,
  deps: FridayCliAuthCommandDeps,
): Promise<void> {
  const { providerService, stdout } = deps;
  const target = input.authTarget ?? "";
  const spec = CLI_AUTH_TARGETS[target as keyof typeof CLI_AUTH_TARGETS];
  if (!spec) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "attach-cli currently supports: codex, claude",
      { httpStatus: 400 },
    );
  }

  if (!input.providerId?.trim()) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "attach-cli requires --provider-id so Friday can bind the CLI session to an explicit provider.",
      { httpStatus: 400 },
    );
  }

  const existing = await providerService.getProvider(input.providerId);
  if (!existing) {
    throw new FridayDomainError(
      "PROVIDER_NOT_FOUND",
      `Provider "${input.providerId}" not found`,
      { httpStatus: 404 },
    );
  }
  if (existing.kind !== spec.kind) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Provider "${existing.id}" is kind "${existing.kind}", not ${spec.kind}`,
      { httpStatus: 400 },
    );
  }
  if (existing.config.backendKind !== "cli") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Provider "${existing.id}" is backend "${existing.config.backendKind ?? "http"}", not cli`,
      { httpStatus: 400 },
    );
  }

  const payload = {
    name: spec.name,
    baseUrl: "",
    backendKind: "cli" as const,
    authMode: "external-session" as const,
    api: spec.kind === "anthropic"
      ? "anthropic-messages" as const
      : spec.kind.startsWith("google")
        ? "google-generative-ai" as const
        : "openai-responses" as const,
    supportedModels: [...spec.supportedModels],
    defaultModel: spec.defaultModel,
    cliConfig: {
      backendId: spec.backendId,
      ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
    },
    validateOnSave: true,
  };

  const provider = await providerService.updateProvider(existing.id, payload);

  const doctor = await providerService.doctorProvider(provider.id);
  stdout(`\nAttached ${spec.name} to provider ${provider.id}`);
  stdout(`   backend=${doctor.backendKind} auth=${doctor.authMode}`);
  stdout(`   backendHealth=${doctor.backendHealth} authHealth=${doctor.authHealth}`);
  if (doctor.cliSession?.version) {
    stdout(`   version=${doctor.cliSession.version}`);
  }
  if (doctor.cliSession?.account?.email) {
    stdout(`   account=${doctor.cliSession.account.email}`);
  }
  if (doctor.reasons.length > 0) {
    stdout(`   reasons=${doctor.reasons.join(", ")}`);
  }
  stdout("");
}

export async function runFridayCliAuthStatus(
  input: FridayCliAuthCommandInput,
  deps: FridayCliAuthCommandDeps,
): Promise<void> {
  const { providerService, stdout } = deps;
  if (input.providerId) {
    const doctor = await providerService.doctorProvider(input.providerId);
    stdout(JSON.stringify(doctor, null, 2));
    return;
  }

  const providers = await providerService.listProviders();
  const reports = await Promise.all(providers.map((provider) => providerService.doctorProvider(provider.id)));
  stdout(JSON.stringify({ items: reports }, null, 2));
}
