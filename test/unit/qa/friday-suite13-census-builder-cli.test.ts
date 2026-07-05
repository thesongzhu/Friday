import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/build-friday-suite13-census.mjs";

function writeFile(path: string, content: string) {
  mkdirSync(path.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(path, content);
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "friday-suite13-census-repo-"));
  writeFile(join(root, "ui/src/router.tsx"), `
    export const router = createBrowserRouter([
      { path: "home", element: <HomePage /> },
      { path: "chat", element: <ChatPage /> },
    ]);
  `);
  writeFile(join(root, "ui/src/lib/api/agent.ts"), `
    apiClient.post("/v1/agent/runs", payload);
    apiClient.get(\`/v1/agent/runs/\${encodeURIComponent(runId)}\`);
  `);
  writeFile(join(root, "apps/friday-ios/Sources/FridayChatScreen.swift"), "struct FridayChatScreen {}\n");
  writeFile(join(root, "src/api/http/routes/friday-agent-routes.ts"), `
    return [
      { operationId: "agent.runs.create", method: "POST", path: "/v1/agent/runs", auth: { public: true }, async handler() {} },
      { operationId: "agent.runs.get", method: "GET", path: "/v1/agent/runs/:runId", auth: { public: true }, async handler() {} },
    ];
  `);
  writeFile(join(root, "packages/friday-operator-client/src/system-client.ts"), `
    transport.post("/v1/system/intents", input);
  `);
  writeFile(join(root, "rust-core/crates/friday-protocol/src/lib.rs"), `
    pub enum Message {
      AskFridayRequest { prompt: String },
      AgentRunResult { run_id: String },
    }
  `);
  return root;
}

function run(args: string[], expectFailure = false) {
  const outArg = args.find((item) => item.startsWith("--out="));
  const outPath = outArg?.slice("--out=".length);
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (outPath) return JSON.parse(readFileSync(outPath, "utf8"));
    return JSON.parse(stdout);
  } catch (error) {
    if (!expectFailure) throw error;
    const stdout = (error as { stdout?: Buffer | string }).stdout?.toString() || "";
    return JSON.parse(stdout);
  }
}

describe("Friday Suite-13 census builder", () => {
  it("derives the three census sources and keeps Smart Queue/Watch in the 19 mechanism families", () => {
    const repoRoot = makeRepo();
    const out = join(repoRoot, "out/census.json");

    const census = run([
      `--repo-root=${repoRoot}`,
      `--out=${out}`,
      "--require-nonempty",
    ]);

    expect(census.truth).toBe("suite13_census");
    expect(census.sources.A.uiRoutes).toEqual(expect.arrayContaining(["/home", "/chat"]));
    expect(census.sources.A.uiApiCalls).toEqual(expect.arrayContaining(["/v1/agent/runs", "/v1/agent/runs/:param"]));
    expect(census.sources.A.swiftScreens).toEqual(["FridayChatScreen.swift"]);
    expect(census.sources.B.httpRoutes).toEqual(expect.arrayContaining(["POST /v1/agent/runs", "GET /v1/agent/runs/:runId"]));
    expect(census.sources.B.sealedWsMessages).toEqual(expect.arrayContaining(["AskFridayRequest", "AgentRunResult"]));
    expect(census.sources.B.operatorClientEndpoints).toEqual(["POST /v1/system/intents"]);
    expect(census.sources.C.mechanisms).toHaveLength(19);
    expect(census.sources.C.mechanisms).toEqual(expect.arrayContaining(["smart_queue", "smart_watch"]));
    expect(census.cells.length).toBeGreaterThan(0);
    expect(census.orphans).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "orphan-backend", reason: "operator-gated", owningIssue: "S13-1-COVERAGE-ORACLE" }),
    ]));

    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(written.truth).toBe("suite13_census");
  });

  it("fails closed when a source is missing instead of emitting a partial census", () => {
    const repoRoot = makeRepo();
    writeFileSync(join(repoRoot, "rust-core/crates/friday-protocol/src/lib.rs"), "");

    const census = run([
      `--repo-root=${repoRoot}`,
      "--require-nonempty",
    ], true);

    expect(census.status).toBe("blocked");
    expect(census.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "sealed_ws_messages_missing" }),
    ]));
  });

  it("parses multiline sealed-WS Message variants without truncating at the first struct variant", () => {
    const repoRoot = makeRepo();
    writeFile(join(repoRoot, "rust-core/crates/friday-protocol/src/lib.rs"), `
      pub enum Message {
        AskFridayRequest {
          prompt: String,
        },
        AgentRunResult {
          run_id: String,
        },
        HubStatus,
      }
    `);

    const out = join(repoRoot, "out/multiline-census.json");
    const census = run([
      `--repo-root=${repoRoot}`,
      `--out=${out}`,
      "--require-nonempty",
    ]);

    expect(census.sources.B.sealedWsMessages).toEqual(expect.arrayContaining([
      "AskFridayRequest",
      "AgentRunResult",
      "HubStatus",
    ]));
  });
});
