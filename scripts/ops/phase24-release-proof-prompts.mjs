#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PHASES = Object.freeze([
  {
    id: "phase24b",
    label: "Phase24B Discord trusted inbound",
    channel: "discord",
    marker: "PHASE24B_DISCORD_LISTENER_READY",
    kind: "single",
  },
  {
    id: "phase24c",
    label: "Phase24C Telegram trusted inbound",
    channel: "telegram",
    marker: "PHASE24C_TELEGRAM_LISTENER_READY",
    kind: "single",
  },
  {
    id: "phase24d",
    label: "Phase24D Lark/Feishu trusted inbound",
    channel: "lark-feishu",
    marker: "PHASE24D_LARK_FEISHU_LISTENER_READY",
    kind: "single",
  },
  {
    id: "phase24e",
    label: "Phase24E Telegram workflow candidate",
    channel: "telegram",
    marker: "PHASE24E_TELEGRAM_LISTENER_READY",
    kind: "reject-approve",
  },
  {
    id: "phase24f",
    label: "Phase24F Discord workflow candidate",
    channel: "discord",
    marker: "PHASE24F_DISCORD_LISTENER_READY",
    kind: "reject-approve",
  },
  {
    id: "phase24g",
    label: "Phase24G Lark/Feishu workflow candidate",
    channel: "lark-feishu",
    marker: "PHASE24G_LARK_FEISHU_LISTENER_READY",
    kind: "reject-approve",
  },
]);

function usage() {
  return `Usage:
  node scripts/ops/phase24-release-proof-prompts.mjs --run-id <id> [--repo owner/name] [--json] [--require-all]
  node scripts/ops/phase24-release-proof-prompts.mjs --logs-dir <dir> [--json] [--require-all]

Optional:
  --discord-bot-user-id <id>   Replaces GitHub-masked <@***> Discord mentions.

Reads Real Green Gate logs and extracts the exact trusted-user Phase24 B-G
messages printed by the listener jobs. This helper is read-only: it does not
send channel messages, mint proof artifacts, or relax release gates.`;
}

function parseArgs(argv) {
  const args = {
    runId: null,
    repo: null,
    logsDir: null,
    json: false,
    requireAll: false,
    discordBotUserId: process.env.FRIDAY_DISCORD_BOT_USER_ID?.trim() || null,
    help: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--run-id":
        args.runId = argv[++index] ?? null;
        break;
      case "--repo":
        args.repo = argv[++index] ?? null;
        break;
      case "--logs-dir":
        args.logsDir = argv[++index] ?? null;
        break;
      case "--json":
        args.json = true;
        break;
      case "--require-all":
        args.requireAll = true;
        break;
      case "--discord-bot-user-id":
        args.discordBotUserId = argv[++index] ?? null;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function normalizeLogLine(line) {
  const noAnsi = stripAnsi(line).replace(/^\uFEFF/, "").trimEnd();
  const parts = noAnsi.split("\t");
  const text = parts.length > 1 ? parts.at(-1) : noAnsi;
  return text
    .replace(/^\uFEFF/, "")
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+/, "")
    .trim();
}

function readLogsDir(logsDir) {
  const root = path.resolve(logsDir);
  const chunks = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        chunks.push(`\n### ${path.relative(root, fullPath)}\n`);
        chunks.push(fs.readFileSync(fullPath, "utf8"));
      }
    }
  }

  walk(root);
  return chunks.join("\n");
}

function readGhRunLog(runId, repo) {
  const args = ["run", "view", runId, "--log"];
  if (repo) {
    args.push("--repo", repo);
  }

  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }

  return result.stdout;
}

function isSkippablePromptInstruction(line) {
  return line.length === 0
    || line.startsWith("Send this in ")
    || line.startsWith("Step 1 ")
    || line.startsWith("After the reject ack arrives");
}

function unmaskDiscordMention(message, args) {
  const discordBotUserId = typeof args.discordBotUserId === "string" ? args.discordBotUserId.trim() : "";
  if (!discordBotUserId) return message;
  return message.replaceAll("<@***>", `<@${discordBotUserId}>`);
}

function normalizePromptMessage(message, phase, args) {
  if (phase.channel === "discord") {
    return unmaskDiscordMention(message, args);
  }
  return message;
}

function extractSingle(lines, markerIndex, phase, args) {
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("PHASE24") && line.endsWith("LISTENER_READY")) break;
    if (!isSkippablePromptInstruction(line)) {
      return { message: normalizePromptMessage(line, phase, args) };
    }
  }
  return { message: null };
}

function extractRejectApprove(lines, markerIndex, phase, args) {
  let reject = null;
  let approve = null;
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("PHASE24") && line.endsWith("LISTENER_READY")) break;
    if (!reject && line.startsWith("reject reflex ")) {
      reject = normalizePromptMessage(line, phase, args);
      continue;
    }
    if (!approve && line.startsWith("approve reflex ")) {
      approve = normalizePromptMessage(line, phase, args);
    }
    if (reject && approve) break;
  }
  return { reject, approve };
}

function extractPrompts(logText, args) {
  const lines = logText.split(/\r?\n/).map(normalizeLogLine);
  const results = [];

  for (const phase of PHASES) {
    const markerIndex = lines.findIndex((line) => line === phase.marker);
    const base = {
      id: phase.id,
      label: phase.label,
      channel: phase.channel,
      marker: phase.marker,
      found: markerIndex >= 0,
      messages: {},
    };

    if (markerIndex < 0) {
      results.push({ ...base, status: "missing-listener-ready" });
      continue;
    }

    const messages = phase.kind === "single"
      ? extractSingle(lines, markerIndex, phase, args)
      : extractRejectApprove(lines, markerIndex, phase, args);
    const complete = phase.kind === "single"
      ? Boolean(messages.message)
      : Boolean(messages.reject && messages.approve);

    results.push({
      ...base,
      messages,
      status: complete ? "ready" : "missing-message",
    });
  }

  return results;
}

function buildReport(args, prompts) {
  return {
    truth_label: "phase24_release_proof_prompt_extraction_read_only_no_channel_send_no_proof_mint",
    generated_at_utc: new Date().toISOString(),
    source: args.logsDir
      ? { kind: "logs-dir", path: path.resolve(args.logsDir) }
      : { kind: "gh-run-log", run_id: args.runId, repo: args.repo },
    phases: prompts,
    complete: prompts.every((phase) => phase.status === "ready"),
    caveat: "Messages are only valid for the exact Real Green Gate run that printed them. Fresh runs generate fresh nonces/candidate ids.",
  };
}

function printText(report) {
  console.log("Phase24 release-proof prompt extraction");
  console.log(`truth_label=${report.truth_label}`);
  console.log(`source=${report.source.kind}${report.source.run_id ? `:${report.source.run_id}` : `:${report.source.path}`}`);
  console.log("");

  for (const phase of report.phases) {
    console.log(`${phase.id.toUpperCase()} - ${phase.label} [${phase.status}]`);
    if (phase.messages.message) {
      console.log(`  send: ${phase.messages.message}`);
    }
    if (phase.messages.reject) {
      console.log(`  step1: ${phase.messages.reject}`);
    }
    if (phase.messages.approve) {
      console.log(`  step2: ${phase.messages.approve}`);
    }
    if (phase.status !== "ready") {
      console.log(`  missing: ${phase.marker}`);
    }
  }

  console.log("");
  console.log(`complete=${report.complete}`);
  console.log(report.caveat);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.logsDir && args.runId) {
    throw new Error("Use either --logs-dir or --run-id, not both");
  }
  if (!args.logsDir && !args.runId) {
    throw new Error("Missing required --logs-dir or --run-id");
  }

  const logText = args.logsDir ? readLogsDir(args.logsDir) : readGhRunLog(args.runId, args.repo);
  const report = buildReport(args, extractPrompts(logText, args));

  if (args.json) {
    console.log(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printText(report);
  }

  if (args.requireAll && !report.complete) {
    process.exitCode = 2;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 1;
}
