/**
 * CLI auth command — `friday auth login anthropic`.
 *
 * Handles OAuth login flow: generate authorization URL, prompt user
 * for code, exchange, and confirm connection.
 */

import { exec as cpExec } from "node:child_process";
import { platform } from "node:os";
import type { FridayProviderService } from "#providers";

// ─── Types ───

export interface FridayCliAuthCommandInput {
  providerId?: string;
  code?: string;
  noBrowser?: boolean;
}

export interface FridayCliAuthCommandDeps {
  providerService: FridayProviderService;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
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
    const os = platform();
    const openCmd =
      os === "darwin" ? "open"
        : os === "win32" ? "start"
        : "xdg-open";
    cpExec(`${openCmd} ${JSON.stringify(initiation.authorizationUrl)}`, (err) => {
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
    stdout("\nAfter authorizing, paste the code (format: code#state) here:");

    // Read from stdin
    authCode = await new Promise<string>((resolve) => {
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
