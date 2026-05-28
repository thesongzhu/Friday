import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Scripted answers for the mocked readline prompts. The setup wizard asks:
//   1) provider choice  2) api key (or ollama url)  3) "Start Friday now?"
// Answering "n" to (3) avoids spawning the real server (cmdStart).
const hoisted = vi.hoisted(() => ({ answers: [] as string[] }));

vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_question: string, cb: (answer: string) => void) => {
      cb(hoisted.answers.shift() ?? "");
    },
    close: () => {},
  }),
}));

// Deep import: cmdSetup is intentionally NOT on the public #cli barrel.
const { cmdSetup } = await import("../../../src/cli/friday-cli.js");

const PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "FRIDAY_ANTHROPIC_API_KEY",
  "OLLAMA_BASE_URL",
  "FRIDAY_SETUP_DEFAULT_PROVIDER",
];

describe("cmdSetup (CLI provider setup wizard)", () => {
  let tempDir: string;
  let envSnapshot: Map<string, string | undefined>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-setup-"));
    envSnapshot = new Map([
      ["FRIDAY_STATE_DIR", process.env.FRIDAY_STATE_DIR],
      ...PROVIDER_KEYS.map((k) => [k, process.env[k]] as [string, string | undefined]),
    ]);
    process.env.FRIDAY_STATE_DIR = tempDir;
    for (const key of PROVIDER_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of envSnapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    hoisted.answers = [];
  });

  function readEnvFile(): string {
    return fs.readFileSync(path.join(tempDir, ".env"), "utf8");
  }

  it("offers DeepSeek as a first-class option and writes DEEPSEEK_API_KEY (no OpenAI)", async () => {
    hoisted.answers = ["2", "sk-deepseek-test-key", "n"];
    await cmdSetup();

    const env = readEnvFile();
    expect(env).toContain("DEEPSEEK_API_KEY=sk-deepseek-test-key");
    expect(env).toContain("FRIDAY_SETUP_DEFAULT_PROVIDER=deepseek");
    // Choosing DeepSeek must never write an OpenAI key.
    expect(env).not.toContain("OPENAI_API_KEY");
  });

  it("writes OPENAI_API_KEY only when the user explicitly chooses OpenAI", async () => {
    hoisted.answers = ["3", "sk-openai-test-key", "n"];
    await cmdSetup();

    const env = readEnvFile();
    expect(env).toContain("OPENAI_API_KEY=sk-openai-test-key");
    expect(env).toContain("FRIDAY_SETUP_DEFAULT_PROVIDER=openai");
  });

  it("does not write OpenAI by default (Anthropic) and records explicit intent", async () => {
    hoisted.answers = ["1", "sk-ant-test-key", "n"];
    await cmdSetup();

    const env = readEnvFile();
    expect(env).toContain("FRIDAY_ANTHROPIC_API_KEY=sk-ant-test-key");
    expect(env).toContain("FRIDAY_SETUP_DEFAULT_PROVIDER=anthropic");
    expect(env).not.toContain("OPENAI_API_KEY");
  });
});
