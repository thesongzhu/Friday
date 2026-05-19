import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFridayStudioService } from "../../../src/studio/friday-studio-service.js";

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-studio-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeFetch(routes: Record<string, { body: string; status?: number; contentType?: string }>): typeof fetch {
  return async (input) => {
    const url = String(input);
    const route = routes[url];
    if (!route) {
      return new Response("not found", { status: 404 });
    }
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { "content-type": route.contentType ?? "text/html" },
    });
  };
}

describe("createFridayStudioService", () => {
  it("lists first-party local products that never mutate the user's computer", () => {
    const service = createFridayStudioService({ workspaceRoot: makeTempDir() });
    const products = service.listProducts();

    expect(products.map((product) => product.id)).toEqual([
      "seo_audit",
      "research_report",
      "html_slide_deck",
      "wechat_miniprogram",
      "guided_browser_automation",
      "integration_builder",
    ]);
    expect(products.every((product) => product.firstParty && product.localOnly && !product.mutatesUserComputer)).toBe(true);
  });

  it("generates an SEO audit with evidence artifacts for a public page", async () => {
    const service = createFridayStudioService({
      workspaceRoot: makeTempDir(),
      nowIso: () => "2026-04-28T00:00:00.000Z",
      fetchFn: makeFetch({
        "https://example.com/product": {
          body: `<!doctype html><html><head>
            <title>Example Product Landing Page for Cross-border Store</title>
            <meta name="description" content="A complete product landing page with strong content depth and structured details for shoppers.">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <link rel="canonical" href="https://example.com/product">
            <script type="application/ld+json">{"@type":"Product"}</script>
          </head><body><h1>Example Product</h1>
            <p>${"Detailed product content. ".repeat(40)}</p>
            <a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>
            <img src="/image.jpg" alt="Product image">
          </body></html>`,
        },
        "https://example.com/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
        "https://example.com/sitemap.xml": { body: "<urlset></urlset>", contentType: "application/xml" },
      }),
    });

    const run = await service.runProduct({
      productId: "seo_audit",
      inputs: { url: "https://example.com/product", focus: "Shopify Amazon TikTok" },
      locale: "en",
    });

    expect(run.status).toBe("completed");
    expect(run.artifacts.map((artifact) => artifact.relativePath)).toEqual(["report.html", "evidence.json"]);
    expect(run.checks.find((check) => check.id === "h1")?.status).toBe("passed");
    expect(fs.existsSync(path.join(run.artifactRoot, "report.html"))).toBe(true);
  });

  it("generates runnable source and artifact bundles for the productized lanes", async () => {
    const service = createFridayStudioService({ workspaceRoot: makeTempDir() });

    const slides = await service.runProduct({
      productId: "html_slide_deck",
      inputs: { topic: "Cross-border launch", template: "cross_border", notes: "Audience\nChannel\nRisk" },
    });
    const miniapp = await service.runProduct({
      productId: "wechat_miniprogram",
      inputs: { name: "Friday Demo", template: "catalog", notes: "Show product cards" },
    });
    const guide = await service.runProduct({
      productId: "guided_browser_automation",
      inputs: { goal: "Audit a public landing page", site: "https://example.com", constraints: "No login pages" },
    });
    const integration = await service.runProduct({
      productId: "integration_builder",
      inputs: {
        sourceType: "curl",
        source: "curl -X POST https://api.example.com/items -H 'Authorization: Bearer token' -d '{\"name\":\"demo\"}'",
        name: "Example API",
      },
    });

    expect(slides.artifacts.some((artifact) => artifact.relativePath === "slides.html")).toBe(true);
    expect(fs.readFileSync(path.join(miniapp.artifactRoot, "miniapp/project.config.json"), "utf8")).toContain("touristappid");
    expect(guide.checks.find((check) => check.id === "read_only")?.status).toBe("passed");
    expect(integration.checks.find((check) => check.id === "permissions")?.status).toBe("warning");

    const exported = service.exportRun(guide.id);
    expect(exported.mimeType).toBe("application/zip");
    expect(exported.sizeBytes).toBeGreaterThan(100);
  });

  it("redacts pasted Integration Builder credentials from persisted runs and artifacts", async () => {
    const service = createFridayStudioService({ workspaceRoot: makeTempDir() });
    const rawBearer = ["bearer", "fixture", "123456"].join("-");
    const rawQueryToken = "query-secret-123456";
    const rawUsername = "apiuser";
    const rawUrlCredential = ["api", "pass", "123456"].join("-");
    const rawHeaderValue = ["api", "key", "fixture", "123456"].join("-");

    const run = await service.runProduct({
      productId: "integration_builder",
      inputs: {
        sourceType: "curl",
        source: `curl -X POST 'https://${rawUsername}:${rawUrlCredential}@api.example.com/items?token=${rawQueryToken}' -H 'Authorization: Bearer ${rawBearer}' -H 'X-API-Key: ${rawHeaderValue}' -d '{"name":"demo"}'`,
        name: "Secret API",
      },
    });

    const runJson = fs.readFileSync(path.join(run.artifactRoot, "run.json"), "utf8");
    const packJson = fs.readFileSync(path.join(run.artifactRoot, "pack.json"), "utf8");
    const readme = fs.readFileSync(path.join(run.artifactRoot, "README.md"), "utf8");
    const request = fs.readFileSync(path.join(run.artifactRoot, "test-request.http"), "utf8");
    const combined = [JSON.stringify(run), runJson, packJson, readme, request].join("\n");

    expect(combined).not.toContain(rawBearer);
    expect(combined).not.toContain(rawQueryToken);
    expect(combined).not.toContain(rawUsername);
    expect(combined).not.toContain(rawUrlCredential);
    expect(combined).not.toContain(rawHeaderValue);
    expect(combined).toContain("[redacted]");
    expect(JSON.parse(packJson).permissions).toContain("secret.read:api_key");
  });

  it("keeps query-token-only Integration Builder candidates human-gated", async () => {
    const service = createFridayStudioService({ workspaceRoot: makeTempDir() });
    const rawQueryToken = "query-only-secret-123456";

    const run = await service.runProduct({
      productId: "integration_builder",
      inputs: {
        sourceType: "curl",
        source: `curl -X GET 'https://api.example.com/items?token=${rawQueryToken}'`,
        name: "Query Token API",
      },
    });

    const result = service.validateArtifactCandidate(run.id);
    const packJson = fs.readFileSync(path.join(run.artifactRoot, "pack.json"), "utf8");

    expect(JSON.stringify(run)).not.toContain(rawQueryToken);
    expect(packJson).not.toContain(rawQueryToken);
    expect(JSON.parse(packJson).permissions).toContain("secret.read:api_key");
    expect(result.validation.risks).toContain("api_key");
    expect(result.candidates.every((candidate) => candidate.requiresHuman)).toBe(true);
  });

  it("redacts non-Bearer Authorization headers from Integration Builder artifacts", async () => {
    const service = createFridayStudioService({ workspaceRoot: makeTempDir() });
    const rawBasicCredential = ["Basic", "fixture-basic-value-123456"].join(" ");

    const run = await service.runProduct({
      productId: "integration_builder",
      inputs: {
        sourceType: "curl",
        source: `curl -X GET 'https://api.example.com/items' -H 'Authorization: ${rawBasicCredential}'`,
        name: "Basic Auth API",
      },
    });

    const runJson = fs.readFileSync(path.join(run.artifactRoot, "run.json"), "utf8");
    const packJson = fs.readFileSync(path.join(run.artifactRoot, "pack.json"), "utf8");
    const readme = fs.readFileSync(path.join(run.artifactRoot, "README.md"), "utf8");
    const request = fs.readFileSync(path.join(run.artifactRoot, "test-request.http"), "utf8");
    const combined = [JSON.stringify(run), runJson, packJson, readme, request].join("\n");

    expect(combined).not.toContain(rawBasicCredential);
    expect(combined).not.toContain("fixture-basic-value-123456");
    expect(combined).toContain("Authorization: [redacted]");
    expect(JSON.parse(packJson).permissions).toContain("secret.read:api_key");
  });

  it("redacts Integration Builder OpenAPI fetch errors before persisting failed runs", async () => {
    const rawUsername = "openapi-user";
    const rawUrlCredential = ["openapi", "pass", "123456"].join("-");
    const service = createFridayStudioService({
      workspaceRoot: makeTempDir(),
      fetchFn: async () => {
        throw new Error(`Request cannot be constructed from a URL that includes credentials: https://${rawUsername}:${rawUrlCredential}@api.example.com/openapi.json`);
      },
    });

    const run = await service.runProduct({
      productId: "integration_builder",
      inputs: {
        sourceType: "openapi",
        source: `https://${rawUsername}:${rawUrlCredential}@api.example.com/openapi.json`,
        name: "Credentialed OpenAPI",
      },
    });

    const runJson = fs.readFileSync(path.join(run.artifactRoot, "run.json"), "utf8");
    const combined = [JSON.stringify(run), runJson].join("\n");

    expect(run.status).toBe("failed");
    expect(combined).not.toContain(rawUsername);
    expect(combined).not.toContain(rawUrlCredential);
    expect(combined).toContain("redacted:redacted@api.example.com");
  });

  it("imports local packs from a directory file list and a zip export", async () => {
    const service = createFridayStudioService({
      workspaceRoot: makeTempDir(),
      nowIso: () => "2026-04-28T00:00:00.000Z",
    });

    const directoryImport = service.importLocalPack({
      kind: "directory",
      name: "Directory Pack",
      files: [
        {
          relativePath: "pack/pack.json",
          content: JSON.stringify({
            schemaVersion: "friday.studio.guided_browser.v1",
            name: "Directory Pack",
            goal: "Guide public research",
            entryPrompts: ["Guide me through public research"],
          }),
        },
      ],
    });
    expect(directoryImport.pack.name).toBe("Directory Pack");
    expect(directoryImport.pack.productIds).toEqual(["guided_browser_automation"]);

    const guide = await service.runProduct({
      productId: "guided_browser_automation",
      inputs: { goal: "Build reusable SOP" },
    });
    const exported = service.exportRun(guide.id);
    const zipImport = service.importLocalPack({
      kind: "zip",
      fileName: exported.fileName,
      zipBase64: exported.base64,
    });
    expect(zipImport.pack.packJsonPath).toBe("pack.json");
    expect(zipImport.pack.productIds).toEqual(["guided_browser_automation"]);
  });

  it("validates an integration builder run as a capability candidate", async () => {
    const service = createFridayStudioService({ workspaceRoot: makeTempDir() });

    const run = await service.runProduct({
      productId: "integration_builder",
      inputs: {
        sourceType: "curl",
        source: "curl -X GET https://api.example.com/items -H 'Content-Type: application/json'",
        name: "Example API",
      },
    });

    const result = service.validateArtifactCandidate(run.id);

    expect(result.validation.valid).toBe(true);
    expect(result.validation.sourceType).toBe("studio_artifact");
    expect(result.validation.inferredCapabilities).toContain("custom");
    expect(result.validation.inferredCapabilities).toContain("skills");
    expect(result.run.id).toBe(run.id);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.sourceType).toBe("studio_artifact");
    expect(result.candidates[0]?.capability).toBe("custom");
    expect(result.candidates[0]?.requiresApproval).toBe(true);
    expect(result.candidates[1]?.capability).toBe("skills");
    expect(result.candidates[0]?.id).toMatch(/^studio_artifact:/);
  });

  it("rejects private URLs in public audit and integration lanes", async () => {
    const service = createFridayStudioService({ workspaceRoot: makeTempDir() });

    const audit = await service.runProduct({
      productId: "seo_audit",
      inputs: { url: "http://localhost:3000" },
    });
    const integration = await service.runProduct({
      productId: "integration_builder",
      inputs: { sourceType: "curl", source: "curl http://127.0.0.1:3000/api" },
    });

    expect(audit.status).toBe("failed");
    expect(integration.status).toBe("failed");
  });
});
