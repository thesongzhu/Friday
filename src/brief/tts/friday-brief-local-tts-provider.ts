import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { FridayBriefTtsConfig } from "../friday-brief-config.types.js";
import type {
  FridayBriefTtsInput,
  FridayBriefTtsOutput,
  FridayBriefTtsProvider,
} from "./friday-brief-tts.types.js";

export interface FridayBriefLocalTtsProviderDeps {
  getConfig: () => FridayBriefTtsConfig;
  /** Injected for tests — spawns `say` / `afconvert` by default. */
  runCommand?: (cmd: string, args: readonly string[], signal: AbortSignal) => Promise<void>;
  /** Working directory for intermediate AIFF files. */
  workDir?: string;
}

function probeDurationSec(filePath: string): number | undefined {
  try {
    const result = spawnSync("/usr/bin/afinfo", [filePath], { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    const match = /estimated duration:\s*([0-9]+\.[0-9]+)/.exec(result.stdout);
    if (!match) return undefined;
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function pickVoice(config: FridayBriefTtsConfig, language: string, override?: string): string {
  if (override && override.length > 0) return override;
  if (language.toLowerCase().startsWith("en")) return config.local.voiceEn;
  return config.local.voice;
}

function defaultRunCommand(cmd: string, args: readonly string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = "";
    const abortHandler = (): void => {
      proc.kill("SIGTERM");
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("error", (err) => {
      signal.removeEventListener("abort", abortHandler);
      reject(err);
    });
    proc.on("close", (code) => {
      signal.removeEventListener("abort", abortHandler);
      if (code !== 0) {
        reject(new Error(`${cmd}_exit_${String(code)}:${stderr.slice(0, 240)}`));
        return;
      }
      resolve();
    });
  });
}

export function createFridayBriefLocalTtsProvider(
  deps: FridayBriefLocalTtsProviderDeps,
): FridayBriefTtsProvider {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const workDir = deps.workDir ?? os.tmpdir();

  return {
    kind: "local",
    isConfigured(): boolean {
      return process.platform === "darwin" && fs.existsSync("/usr/bin/say");
    },
    async synthesize(input: FridayBriefTtsInput, signal: AbortSignal): Promise<FridayBriefTtsOutput> {
      if (process.platform !== "darwin") {
        throw new Error("local_tts_requires_macos");
      }
      const cfg = deps.getConfig();
      const voice = pickVoice(cfg, input.language, input.voice);
      const unique = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const aiffPath = path.join(workDir, `friday-brief-${unique}.aiff`);
      const m4aPath = path.join(workDir, `friday-brief-${unique}.m4a`);

      fs.mkdirSync(workDir, { recursive: true });

      try {
        await runCommand("/usr/bin/say", ["-v", voice, "-o", aiffPath, input.text], signal);
        await runCommand(
          "/usr/bin/afconvert",
          ["-f", "m4af", "-d", "aac@44100", "-b", "96000", aiffPath, m4aPath],
          signal,
        );
        const data = fs.readFileSync(m4aPath);
        const durationSec = probeDurationSec(m4aPath);
        return {
          data,
          format: "m4a",
          mimeType: "audio/mp4",
          provider: "local",
          voice,
          durationSec,
        };
      } finally {
        fs.rmSync(aiffPath, { force: true });
        fs.rmSync(m4aPath, { force: true });
      }
    },
  };
}
