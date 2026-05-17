import { mintLocalAdminAccessToken } from "./local-auth.mjs";
import { safeJsonParse } from "./defs.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FridayClient {
  constructor(input) {
    this.baseUrl = String(input.baseUrl).replace(/\/$/, "");
    this.authMode = input.authMode ?? "local";
    this.accessToken = input.accessToken ?? null;
    this.refreshToken = input.refreshToken ?? null;
    this.user = input.user ?? null;
    this.localPassphrase = input.localPassphrase ?? null;
    this.email = input.email ?? null;
    this.password = input.password ?? null;
    this.mintLocalAdminToken = input.mintLocalAdminToken === true;
    this.mintStateDbPath = input.mintStateDbPath ?? null;
    this.mintTokenSecret = input.mintTokenSecret ?? null;
    this.mintTokenSecretFile = input.mintTokenSecretFile ?? null;
    this.mintUserId = input.mintUserId ?? null;
    this.mintUserEmail = input.mintUserEmail ?? null;
    this.mintTenantId = input.mintTenantId ?? null;
    this.mintAccessTokenTtlSec = input.mintAccessTokenTtlSec ?? null;
    this.authSource = input.authSource ?? null;
    this.authDetails = input.authDetails ?? null;
  }

  async initialize() {
    if (this.accessToken) {
      this.authSource ??= "provided_access_token";
      await this.hydrateUser().catch(() => undefined);
      return this.session();
    }
    const hasExplicitCredentials = Boolean(this.localPassphrase || this.email || this.password);
    if (this.authMode === "mint_local_admin" || (this.mintLocalAdminToken && !hasExplicitCredentials)) {
      await this.loginMintedLocalAdmin();
      return this.session();
    }
    if (this.authMode === "local") {
      await this.loginLocal();
      return this.session();
    }
    throw new Error(`No access token provided for auth mode "${this.authMode}".`);
  }

  session() {
    return {
      baseUrl: this.baseUrl,
      authMode: this.authMode,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      user: this.user,
      authSource: this.authSource,
      authDetails: this.authDetails,
    };
  }

  async loginLocal() {
    if (!this.localPassphrase && !(this.email && this.password)) {
      throw new Error("Local validation login requires localPassphrase or email/password credentials.");
    }
    const body = this.localPassphrase
      ? { localPassphrase: this.localPassphrase }
      : { email: this.email, password: this.password };
    const response = await this.request("POST", "/v1/auth/login", {
      body,
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok || response.json?.ok !== true) {
      throw new Error(`Local login failed: ${response.text}`);
    }
    this.accessToken = response.json.data.accessToken;
    this.refreshToken = response.json.data.refreshToken;
    this.user = response.json.data.user ?? null;
    this.authSource = this.localPassphrase
      ? "local_passphrase_login"
      : "email_password_login";
    this.authDetails = null;
    return response.json.data;
  }

  async loginMintedLocalAdmin() {
    const minted = mintLocalAdminAccessToken({
      stateDbPath: this.mintStateDbPath,
      tokenSecret: this.mintTokenSecret,
      tokenSecretFile: this.mintTokenSecretFile,
      userId: this.mintUserId,
      userEmail: this.mintUserEmail,
      tenantId: this.mintTenantId,
      accessTokenTtlSec: this.mintAccessTokenTtlSec,
    });
    this.accessToken = minted.accessToken;
    this.refreshToken = null;
    this.user = minted.user;
    this.authMode = "mint_local_admin";
    this.authSource = minted.metadata.source;
    this.authDetails = minted.metadata;
    await this.hydrateUser();
    return minted;
  }

  async hydrateUser() {
    const response = await this.request("GET", "/v1/auth/me");
    if (!response.ok || response.json?.ok !== true) {
      throw new Error(`GET /v1/auth/me failed: ${response.text}`);
    }
    this.user = response.json.data.user ?? null;
    return response.json.data;
  }

  async request(method, routePath, options = {}) {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 120_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(options.headers ?? {});
    // Phase 14.5B module_28b: `skipAuth: true` lets a probe deliberately omit
    // the Authorization header so the server resolves to the synthetic public
    // principal. The bound-principal gate proof needs this; do not weaken
    // existing callers (they default to sending the bearer token).
    if (this.accessToken && options.skipAuth !== true) {
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    }
    if (options.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const startedAt = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}${routePath}`, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      const json = safeJsonParse(text);
      return {
        method,
        routePath,
        status: response.status,
        ok: response.ok,
        text,
        json,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async api(method, routePath, body, options = {}) {
    const response = await this.request(method, routePath, {
      ...options,
      ...(body !== undefined ? { body } : {}),
    });
    if (!response.ok || response.json?.ok !== true) {
      throw new Error(`${method} ${routePath} failed: ${response.text}`);
    }
    return {
      data: response.json.data,
      response,
    };
  }

  async waitFor(pathBuilder, predicate, options = {}) {
    const intervalMs = options.intervalMs ?? 1_500;
    const maxMs = options.maxMs ?? 120_000;
    const deadline = Date.now() + maxMs;
    let lastData;
    while (Date.now() < deadline) {
      lastData = await pathBuilder();
      if (predicate(lastData)) {
        return lastData;
      }
      await sleep(intervalMs);
    }
    throw new Error(`waitFor timed out after ${String(maxMs)}ms (last=${JSON.stringify(lastData)?.slice(0, 1200)})`);
  }

  async startAgentRun(body) {
    return await this.api("POST", "/v1/agent/runs", body, { timeoutMs: body.timeoutMs ?? 240_000 });
  }

  async getAgentRun(runId) {
    return await this.api("GET", `/v1/agent/runs/${encodeURIComponent(runId)}`);
  }

  async waitForAgentRunTerminal(runId, maxMs = 240_000) {
    return await this.waitFor(
      async () => (await this.getAgentRun(runId)).data.run,
      (run) => [
        "completed",
        "failed",
        "cancelled",
        "awaiting_clarification",
        "awaiting_plan_approval",
      ].includes(run.status),
      { intervalMs: 1_500, maxMs },
    );
  }
}
