import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  FRIDAY_AGENT_EXEC_MAX_OUTPUT_BYTES,
  FRIDAY_AGENT_EXEC_TIMEOUT_MS,
} from "../friday-agent.constants.js";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import { isWithinBase } from "../../utilities/friday-path-safety.js";
import {
  errorResult,
  readBooleanParam,
  readNumberParam,
  readRecordParam,
  readStringParam,
  textResult,
  truncateOutput,
} from "./friday-agent-tool-helpers.js";
import { getApprovalRequiredReasonForExecCommand } from "../runtime/friday-agent-tool-risk.js";

// ─── Options ───

export interface CreateFridayAgentExecToolOptions {
  defaultWorkdir?: string;
  /** Root directory for workspace sandboxing. Commands accessing outside this path are rejected. */
  workspaceRoot?: string;
  /** When false (default), reject commands containing shell metacharacters (;|&`$). */
  allowShell?: boolean;
  /** Injectable spawn implementation for testing. Defaults to Node's `child_process.spawn`. */
  spawnImpl?: typeof spawn;
  /** Injectable realpathSync implementation for testing. Defaults to `fs.realpathSync`. */
  realpathSyncImpl?: typeof fs.realpathSync;
}

// ─── Shell metacharacter pattern ───
// Blocks shell metacharacters plus Unicode whitespace and control characters
// that could be used to bypass argument splitting or inject hidden separators.

const SHELL_META_RE = /[;|&`$(){}\n\r<>#!~]/;
const UNICODE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u00A0\u1680\u2000-\u200F\u2028\u2029\u202A-\u202F\u205F\u2060\u3000\uFEFF\uFFF0-\uFFFF]/;

function stripSimpleQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function realpathString(realpathSyncFn: typeof fs.realpathSync, targetPath: string): string {
  return String(realpathSyncFn(targetPath));
}

function commandBaseName(program: string | undefined): string {
  const normalized = stripSimpleQuotes(program ?? "").replace(/\\/g, "/");
  return normalized.split("/").at(-1)?.toLowerCase() ?? "";
}

function isInlineEnvAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function pathRoot(value: string): string {
  return path.parse(path.resolve(value)).root;
}

function containsFileUrl(value: string): boolean {
  return /(^|[^A-Za-z0-9+.-])file:(?!:)/iu.test(value);
}

function resolveCommandOperandPath(
  operand: string,
  resolvedWorkdir: string,
  realpathSyncFn: typeof fs.realpathSync,
): string {
  const absolute = path.isAbsolute(operand)
    ? path.resolve(operand)
    : path.resolve(resolvedWorkdir, operand);
  try {
    return realpathString(realpathSyncFn, absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      console.warn("[friday][agent-exec-tool] command operand resolve failed:", err instanceof Error ? err.message : String(err));
    }
    let ancestor = path.dirname(absolute);
    let tail = path.basename(absolute);
    while (true) {
      try {
        const resolvedAncestor = realpathString(realpathSyncFn, ancestor);
        return path.join(resolvedAncestor, tail);
      } catch (ancestorErr) {
        if ((ancestorErr as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          console.warn("[friday][agent-exec-tool] command operand ancestor resolve failed:", ancestorErr instanceof Error ? ancestorErr.message : String(ancestorErr));
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          return absolute;
        }
        tail = path.join(path.basename(ancestor), tail);
        ancestor = parent;
      }
    }
  }
}

function validateCommandOperandPath(params: {
  operand: string;
  resolvedRoot: string;
  workspaceRoot: string;
  resolvedWorkdir: string;
  realpathSyncFn: typeof fs.realpathSync;
}): string | null {
  const operand = stripSimpleQuotes(params.operand.trim());
  if (!operand) {
    return null;
  }
  if (containsFileUrl(operand)) {
    return `Command path "${params.operand}" uses or embeds a file URL, which is not allowed in exec commands.`;
  }
  if (/^data:/i.test(operand)) {
    return `Command path "${params.operand}" uses a data URL, which is not allowed in exec commands.`;
  }
  const resolvedOperand = resolveCommandOperandPath(
    operand,
    params.resolvedWorkdir,
    params.realpathSyncFn,
  );
  if (!isWithinBase(params.resolvedRoot, resolvedOperand)) {
    return `Command path "${params.operand}" is outside the allowed workspace root "${params.workspaceRoot}".`;
  }
  return null;
}

const ALL_ARG_PATH_PROGRAMS = new Set([
  "cat",
  "cmp",
  "comm",
  "diff",
  "du",
  "file",
  "head",
  "less",
  "ls",
  "more",
  "nl",
  "readlink",
  "realpath",
  "sort",
  "stat",
  "tail",
  "tac",
  "tree",
  "uniq",
  "wc",
]);

const FIND_PATH_PROGRAMS = new Set(["find"]);
const GREP_LIKE_PROGRAMS = new Set(["ag", "egrep", "fgrep", "grep", "rg"]);
const SCRIPT_THEN_PATH_PROGRAMS = new Set(["awk", "sed"]);
const SED_PATH_PROGRAMS = new Set(["sed"]);
const SCRIPT_FILE_PROGRAMS = new Set(["node", "perl", "python", "python3", "ruby"]);
const GIT_PATH_PROGRAMS = new Set(["git"]);
const TAR_PATH_PROGRAMS = new Set(["bsdtar", "gnutar", "tar"]);
const URL_FETCH_PATH_PROGRAMS = new Set(["curl", "wget"]);

const SEARCH_OPTION_VALUE_FLAGS = new Set([
  "-A",
  "-B",
  "-C",
  "-M",
  "-g",
  "-j",
  "-m",
  "-t",
  "-T",
  "--after-context",
  "--before-context",
  "--color",
  "--colors",
  "--context",
  "--context-separator",
  "--encoding",
  "--engine",
  "--field-context-separator",
  "--field-match-separator",
  "--format",
  "--glob",
  "--group-separator",
  "--heading",
  "--iglob",
  "--ignore-file",
  "--lines",
  "--max-count",
  "--max-depth",
  "--max-filesize",
  "--path-separator",
  "--pre",
  "--pre-glob",
  "--sort",
  "--sortr",
  "--type",
  "--type-not",
]);

const SEARCH_OPTION_PATH_VALUE_FLAGS = new Set([
  "--ignore-file",
  "--pre",
]);

const SEARCH_OPTION_PATH_VALUE_PREFIXES = [
  "--ignore-file=",
  "--pre=",
];

const SCRIPT_FILE_SKIP_VALUE_FLAGS = new Set([
  "-W",
  "-X",
  "-m",
  "--check-hash-based-pycs",
  "--eval",
]);

const SCRIPT_FILE_PATH_VALUE_FLAGS = new Set([
  "-r",
  "--experimental-loader",
  "--import",
  "--loader",
  "--require",
]);

const URL_FETCH_PATH_VALUE_FLAGS = new Set([
  "-b",
  "-c",
  "-D",
  "-d",
  "-E",
  "-F",
  "-H",
  "-i",
  "-K",
  "-o",
  "-O",
  "-T",
  "-w",
  "--abstract-unix-socket",
  "--cacert",
  "--capath",
  "--cert",
  "--config",
  "--cookie",
  "--cookie-jar",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "--dump-header",
  "--form",
  "--form-string",
  "--header",
  "--input-file",
  "--key",
  "--load-cookies",
  "--netrc-file",
  "--output",
  "--output-dir",
  "--output-document",
  "--post-file",
  "--private-key",
  "--proxy-cacert",
  "--proxy-capath",
  "--proxy-cert",
  "--proxy-key",
  "--save-cookies",
  "--trace",
  "--trace-ascii",
  "--unix-socket",
  "--upload-file",
  "--url-query",
  "--variable",
  "--write-out",
]);

const URL_FETCH_PATH_VALUE_PREFIXES = [
  "--abstract-unix-socket=",
  "--cacert=",
  "--capath=",
  "--cert=",
  "--config=",
  "--cookie=",
  "--cookie-jar=",
  "--data=",
  "--data-ascii=",
  "--data-binary=",
  "--data-raw=",
  "--data-urlencode=",
  "--dump-header=",
  "--form=",
  "--form-string=",
  "--header=",
  "--input-file=",
  "--key=",
  "--load-cookies=",
  "--netrc-file=",
  "--output=",
  "--output-dir=",
  "--output-document=",
  "--post-file=",
  "--private-key=",
  "--proxy-cacert=",
  "--proxy-capath=",
  "--proxy-cert=",
  "--proxy-key=",
  "--save-cookies=",
  "--trace=",
  "--trace-ascii=",
  "--unix-socket=",
  "--upload-file=",
  "--url-query=",
  "--variable=",
  "--write-out=",
];

const FIND_LEADING_FLAG_OPTIONS = new Set([
  "-d",
  "-E",
  "-H",
  "-L",
  "-P",
  "-s",
  "-x",
  "-X",
]);

function optionTakesSeparateValue(arg: string, options: Set<string>): boolean {
  if (arg.includes("=")) {
    return false;
  }
  return options.has(arg);
}

function isFindLeadingFlagCluster(arg: string): boolean {
  return /^-[EHLPdsxX]{2,}$/u.test(arg);
}

function collectAllPathArgs(args: string[]): string[] {
  const operands: string[] = [];
  let endOfOptions = false;
  for (const arg of args) {
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-")) {
      continue;
    }
    operands.push(arg);
  }
  return operands;
}

function collectFindStartPaths(args: string[]): string[] {
  const operands: string[] = [];
  let index = 0;
  while (index < args.length) {
    const arg = args.at(index);
    if (arg === undefined) {
      break;
    }
    if (arg === "--") {
      index += 1;
      continue;
    }
    if (FIND_LEADING_FLAG_OPTIONS.has(arg) || isFindLeadingFlagCluster(arg)) {
      index += 1;
      continue;
    }
    if (arg === "-D") {
      index += 2;
      continue;
    }
    if (arg === "-f") {
      const value = args.at(index + 1);
      if (value) {
        operands.push(value);
      }
      index += 2;
      continue;
    }
    if (arg.startsWith("-f") && arg.length > 2) {
      const attachedPath = arg.slice(2);
      operands.push(attachedPath);
      index += 1;
      continue;
    }
    if (arg === "-O" || /^-O\d+/u.test(arg)) {
      index += arg === "-O" ? 2 : 1;
      continue;
    }
    if (arg.startsWith("-") || arg === "(" || arg === "!" || arg === ",") {
      break;
    }
    operands.push(arg);
    index += 1;
  }
  return operands;
}

function collectSearchPathArgs(args: string[]): string[] {
  const operands: string[] = [];
  let endOfOptions = false;
  let patternSeen = false;
  let pathOnlyMode = false;
  let pending: "skip" | "patternPath" | "pathOption" | null = null;
  for (const arg of args) {
    if (pending === "patternPath") {
      operands.push(arg);
      patternSeen = true;
      pending = null;
      continue;
    }
    if (pending === "pathOption") {
      operands.push(arg);
      pending = null;
      continue;
    }
    if (pending === "skip") {
      pending = null;
      continue;
    }
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-")) {
      if (arg === "--files") {
        pathOnlyMode = true;
        patternSeen = true;
        continue;
      }
      if (arg === "-e" || arg === "--regexp") {
        pending = "skip";
        patternSeen = true;
        continue;
      }
      if (arg.startsWith("-e") && arg.length > 2) {
        patternSeen = true;
        continue;
      }
      if (arg.startsWith("--regexp=")) {
        patternSeen = true;
        continue;
      }
      if (arg === "-f" || arg === "--file") {
        pending = "patternPath";
        continue;
      }
      if (arg.startsWith("-f") && arg.length > 2) {
        operands.push(arg.slice(2));
        patternSeen = true;
        continue;
      }
      if (arg.startsWith("--file=")) {
        operands.push(arg.slice("--file=".length));
        patternSeen = true;
        continue;
      }
      if (SEARCH_OPTION_PATH_VALUE_FLAGS.has(arg)) {
        pending = "pathOption";
        continue;
      }
      const pathOptionValue = readValueAfterPrefix(arg, SEARCH_OPTION_PATH_VALUE_PREFIXES);
      if (pathOptionValue !== null) {
        operands.push(pathOptionValue);
        continue;
      }
      pending = optionTakesSeparateValue(arg, SEARCH_OPTION_VALUE_FLAGS) ? "skip" : null;
      continue;
    }
    if (pathOnlyMode) {
      operands.push(arg);
      continue;
    }
    if (!patternSeen) {
      patternSeen = true;
      continue;
    }
    operands.push(arg);
  }
  return operands;
}

function isAwkValuePathCandidate(
  value: string,
  resolvedWorkdir: string,
  realpathSyncFn: typeof fs.realpathSync,
): boolean {
  const candidate = stripSimpleQuotes(value.trim());
  if (!candidate) {
    return false;
  }
  if (containsFileUrl(candidate) || /^data:/i.test(candidate)) {
    return true;
  }
  if (path.isAbsolute(candidate) && path.resolve(candidate) === pathRoot(candidate)) {
    return false;
  }
  return isGenericPathLikeOperand(candidate, resolvedWorkdir, realpathSyncFn);
}

function collectAwkPathArgs(
  args: string[],
  resolvedWorkdir: string,
  realpathSyncFn: typeof fs.realpathSync,
): string[] {
  const operands = collectSearchPathArgs(args);
  let pendingAssignment = false;
  let pendingFieldSeparator = false;
  for (const arg of args) {
    if (pendingFieldSeparator) {
      if (isAwkValuePathCandidate(arg, resolvedWorkdir, realpathSyncFn)) {
        operands.push(arg);
      }
      pendingFieldSeparator = false;
      continue;
    }
    if (pendingAssignment) {
      const equalsIndex = arg.indexOf("=");
      if (equalsIndex > 0) {
        const assignmentValue = arg.slice(equalsIndex + 1);
        if (isAwkValuePathCandidate(assignmentValue, resolvedWorkdir, realpathSyncFn)) {
          operands.push(assignmentValue);
        }
      }
      pendingAssignment = false;
      continue;
    }
    if (arg === "-v" || arg === "--assign") {
      pendingAssignment = true;
      continue;
    }
    if (arg === "-F" || arg === "--field-separator") {
      pendingFieldSeparator = true;
      continue;
    }
    const fieldSeparator = readValueAfterPrefix(arg, ["-F", "--field-separator="]);
    if (fieldSeparator !== null) {
      if (isAwkValuePathCandidate(fieldSeparator, resolvedWorkdir, realpathSyncFn)) {
        operands.push(fieldSeparator);
      }
      continue;
    }
    const attachedAssignment = readValueAfterPrefix(arg, ["-v", "--assign="]);
    if (attachedAssignment !== null) {
      const equalsIndex = attachedAssignment.indexOf("=");
      if (equalsIndex > 0) {
        const assignmentValue = attachedAssignment.slice(equalsIndex + 1);
        if (isAwkValuePathCandidate(assignmentValue, resolvedWorkdir, realpathSyncFn)) {
          operands.push(assignmentValue);
        }
      }
      continue;
    }
    if (!arg.startsWith("-") && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(arg)) {
      const equalsIndex = arg.indexOf("=");
      const assignmentValue = arg.slice(equalsIndex + 1);
      if (isAwkValuePathCandidate(assignmentValue, resolvedWorkdir, realpathSyncFn)) {
        operands.push(assignmentValue);
      }
    }
  }
  return operands;
}

function collectSedScriptPathArgs(script: string): string[] {
  const operands: string[] = [];
  const commandRe = /(?:^|[;\n])\s*(?:(?:\/(?:\\.|[^/])+\/|[0-9,$!{}\s]+)\s*)*[rwe]\s*([^;\n]+)/gu;
  for (const match of script.matchAll(commandRe)) {
    const value = match[1]?.trim();
    if (value) {
      operands.push(value);
    }
  }
  const alternateAddressRe = /\\([A-Za-z0-9])(?:\\.|(?!\1)[^;\n])*?\1[rwe]\s*([^;\n]+)/gu;
  for (const match of script.matchAll(alternateAddressRe)) {
    const value = match[2]?.trim();
    if (value) {
      operands.push(value);
    }
  }
  const commandHeuristicRe = /(?:^|[^A-Za-z0-9])[rwe]\s*((?:\/|\.{1,2}\/|[A-Za-z0-9._-])[^;\n\s]*)/gu;
  for (const match of script.matchAll(commandHeuristicRe)) {
    const value = match[1]?.trim();
    if (value) {
      operands.push(value);
    }
  }
  return [...new Set(operands)];
}

function collectSedPathArgs(args: string[]): string[] {
  const operands: string[] = [];
  let endOfOptions = false;
  let scriptSeen = false;
  let pending: "maybeScript" | "scriptFile" | "script" | "skip" | null = null;
  for (const arg of args) {
    if (pending === "maybeScript") {
      const scriptPaths = collectSedScriptPathArgs(arg);
      operands.push(...scriptPaths);
      scriptSeen = scriptPaths.length > 0;
      pending = null;
      continue;
    }
    if (pending === "scriptFile") {
      operands.push(arg);
      scriptSeen = true;
      pending = null;
      continue;
    }
    if (pending === "script") {
      operands.push(...collectSedScriptPathArgs(arg));
      scriptSeen = true;
      pending = null;
      continue;
    }
    if (pending === "skip") {
      pending = null;
      continue;
    }
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-")) {
      if (arg === "-f" || arg === "--file") {
        pending = "scriptFile";
        continue;
      }
      if (arg.startsWith("--file=")) {
        operands.push(arg.slice("--file=".length));
        scriptSeen = true;
        continue;
      }
      if (arg === "-e" || arg === "--expression") {
        pending = "script";
        continue;
      }
      if (arg === "-i" || arg === "--in-place") {
        pending = "maybeScript";
        continue;
      }
      if (arg.startsWith("-i") && arg.length > 2) {
        continue;
      }
      if (arg.startsWith("--in-place=")) {
        continue;
      }
      if (arg.startsWith("--expression=")) {
        operands.push(...collectSedScriptPathArgs(arg.slice("--expression=".length)));
        scriptSeen = true;
        continue;
      }
      if (arg === "-l" || arg === "--line-length") {
        pending = "skip";
        continue;
      }
      const shortFileIndex = arg.indexOf("f", 1);
      if (shortFileIndex !== -1) {
        if (shortFileIndex === arg.length - 1) {
          pending = "scriptFile";
        } else {
          operands.push(arg.slice(shortFileIndex + 1));
          scriptSeen = true;
        }
        continue;
      }
      const shortExpressionIndex = arg.indexOf("e", 1);
      if (shortExpressionIndex !== -1) {
        if (shortExpressionIndex === arg.length - 1) {
          pending = "script";
        } else {
          operands.push(...collectSedScriptPathArgs(arg.slice(shortExpressionIndex + 1)));
          scriptSeen = true;
        }
      }
      continue;
    }
    if (!scriptSeen) {
      operands.push(...collectSedScriptPathArgs(arg));
      scriptSeen = true;
      continue;
    }
    operands.push(arg);
  }
  return operands;
}

function readValueAfterPrefix(arg: string, prefixes: string[]): string | null {
  for (const prefix of prefixes) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
}

function isScriptEvalPathLiteral(value: string): boolean {
  return /^(?:\/|\.{1,2}\/|file:|data:)/iu.test(value.trim());
}

function collectScriptEvalPathArgs(script: string): string[] {
  const operands: string[] = [];
  if (containsFileUrl(script)) {
    operands.push(script);
  }
  const quotedPathLiteralRe = /["']((?:\/|\.{1,2}\/|file:|data:)[^"'\r\n]*)["']/giu;
  for (const match of script.matchAll(quotedPathLiteralRe)) {
    const value = match[1]?.trim();
    if (value) {
      operands.push(value);
    }
  }
  const qDelimitedPathLiteralRe = /(?:q{1,2}|qw)(?:\[([^\]]+)\]|\{([^}]+)\}|\(([^)]+)\)|<([^>]+)>|([^\w\s])([^;\n]*?)\5)/giu;
  for (const match of script.matchAll(qDelimitedPathLiteralRe)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[6])?.trim();
    if (value && isScriptEvalPathLiteral(value)) {
      operands.push(value);
    }
  }
  const importRe = /(?:import|require|load|do|\bopen|(?:File|IO|Kernel)(?:\.|::)(?:binread|foreach|new|open|readlines|read))\s*["']?((?:\/|\.{1,2}\/|file:|data:|[A-Za-z0-9._-])[^"')\s;]*)/giu;
  for (const match of script.matchAll(importRe)) {
    const value = match[1]?.trim();
    if (value) {
      operands.push(value);
    }
  }
  const rubyCopyStreamRe = /(?:File|IO)(?:\.|::)copy_stream\s*\(?\s*["']?((?:\/|\.{1,2}\/|file:|data:|[A-Za-z0-9._-])[^"',)\s;]*)["']?\s*,\s*["']?((?:\/|\.{1,2}\/|file:|data:|[A-Za-z0-9._-])[^"',)\s;]*)/giu;
  for (const match of script.matchAll(rubyCopyStreamRe)) {
    const source = match[1]?.trim();
    const target = match[2]?.trim();
    if (source) {
      operands.push(source);
    }
    if (target) {
      operands.push(target);
    }
  }
  const rubySendRe = /(?:File|IO|Kernel)(?:\.|::)(?:send|public_send|__send__):(?:binread|copy_stream|foreach|new|open|readlines|read),\s*["']?((?:\/|\.{1,2}\/|file:|data:|[A-Za-z0-9._-])[^"',)\s;]*)/giu;
  for (const match of script.matchAll(rubySendRe)) {
    const value = match[1]?.trim();
    if (value) {
      operands.push(value);
    }
  }
  const rubySendCopyStreamRe = /(?:File|IO)(?:\.|::)(?:send|public_send|__send__):copy_stream,\s*["']?((?:\/|\.{1,2}\/|file:|data:|[A-Za-z0-9._-])[^"',)\s;]*)["']?\s*,\s*["']?((?:\/|\.{1,2}\/|file:|data:|[A-Za-z0-9._-])[^"',)\s;]*)/giu;
  for (const match of script.matchAll(rubySendCopyStreamRe)) {
    const source = match[1]?.trim();
    const target = match[2]?.trim();
    if (source) {
      operands.push(source);
    }
    if (target) {
      operands.push(target);
    }
  }
  const perlQuotedRe = /(?:do|require)\+?(?:q{1,2}|qw)(?:\[([^\]]+)\]|\{([^}]+)\}|\(([^)]+)\)|<([^>]+)>|([^\w\s])([^;\n]*?)\5)/giu;
  for (const match of script.matchAll(perlQuotedRe)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[6])?.trim();
    if (value) {
      operands.push(value);
    }
  }
  const perlOpenLiteralRe = /open\+?[A-Za-z_][A-Za-z0-9_]*,\s*["']?((?:\/|\.{1,2}\/|file:|data:|[A-Za-z0-9._-])[^"',)\s;]*)/giu;
  for (const match of script.matchAll(perlOpenLiteralRe)) {
    const value = match[1]?.trim();
    if (value) {
      operands.push(value);
    }
  }
  const perlOpenQuotedRe = /open\+?[A-Za-z_][A-Za-z0-9_]*,\s*(?:q{1,2}|qw)(?:\[([^\]]+)\]|\{([^}]+)\}|\(([^)]+)\)|<([^>]+)>|([^\w\s])([^;\n]*?)\5)/giu;
  for (const match of script.matchAll(perlOpenQuotedRe)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[6])?.trim();
    if (value) {
      operands.push(value);
    }
  }
  const perlArgvLiteralRe = /@ARGV(?:\[[+-]?\d+\])?\s*=\s*["']?((?:\/|\.{1,2}\/|file:|data:|[A-Za-z0-9._-])[^"',)\s;]*)/giu;
  for (const match of script.matchAll(perlArgvLiteralRe)) {
    const value = match[1]?.trim();
    if (value) {
      operands.push(value);
    }
  }
  const perlArgvQuotedRe = /@ARGV(?:\[[+-]?\d+\])?\s*=\s*(?:q{1,2}|qw)(?:\[([^\]]+)\]|\{([^}]+)\}|\(([^)]+)\)|<([^>]+)>|([^\w\s])([^;\n]*?)\5)/giu;
  for (const match of script.matchAll(perlArgvQuotedRe)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[6])?.trim();
    if (value) {
      operands.push(value);
    }
  }
  return [...new Set(operands)];
}

function skipZeroFlagAttachedValue(arg: string, flagIndex: number): number {
  let valueIndex = flagIndex + 1;
  if (arg[valueIndex] === "x" || arg[valueIndex] === "X") {
    valueIndex += 1;
    while (valueIndex < arg.length && /[0-9A-Fa-f]/u.test(arg[valueIndex]!)) {
      valueIndex += 1;
    }
    return valueIndex - 1;
  }
  while (valueIndex < arg.length && /[0-7]/u.test(arg[valueIndex]!)) {
    valueIndex += 1;
  }
  return valueIndex - 1;
}

function usesScriptEvalArg(programBase: string, args: string[]): boolean {
  let endOfOptions = false;
  let pendingEval = false;
  const separateEvalFlags = (() => {
    if (programBase === "node") {
      return ["-e", "-p", "--eval", "--print"];
    }
    if (programBase === "perl") {
      return ["-e", "-E"];
    }
    if (programBase === "python" || programBase === "python3") {
      return ["-c"];
    }
    if (programBase === "ruby") {
      return ["-e"];
    }
    return [];
  })();
  const attachedEvalPrefixes = (() => {
    if (programBase === "node") {
      return ["-e", "-p", "--eval=", "--print="];
    }
    if (programBase === "perl") {
      return ["-e", "-E"];
    }
    if (programBase === "python" || programBase === "python3") {
      return ["-c"];
    }
    if (programBase === "ruby") {
      return ["-e"];
    }
    return [];
  })();
  const clusteredEvalFlags = (() => {
    if (programBase === "node") {
      return ["e", "p"];
    }
    if (programBase === "perl") {
      return ["e", "E"];
    }
    if (programBase === "python" || programBase === "python3") {
      return ["c"];
    }
    if (programBase === "ruby") {
      return ["e"];
    }
    return [];
  })();
  const clusteredValueFlags = (() => {
    if (programBase === "node") {
      return ["r"];
    }
    if (programBase === "perl") {
      return ["0", "C", "D", "F", "I", "M", "i", "m", "x"];
    }
    if (programBase === "ruby") {
      return ["0", "C", "E", "F", "I", "K", "i", "r", "x"];
    }
    if (programBase === "python" || programBase === "python3") {
      return ["W", "X", "m"];
    }
    return [];
  })();
  for (const arg of args) {
    if (pendingEval) {
      return true;
    }
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (endOfOptions || !arg.startsWith("-")) {
      continue;
    }
    if (separateEvalFlags.includes(arg)) {
      pendingEval = true;
      continue;
    }
    if (clusteredEvalFlags.length > 0 && !arg.startsWith("--")) {
      for (let index = 1; index < arg.length; index += 1) {
        const flag = arg[index];
        if (flag && clusteredEvalFlags.includes(flag)) {
          if (index === arg.length - 1) {
            pendingEval = true;
            break;
          }
          return true;
        }
        if (flag && clusteredValueFlags.includes(flag)) {
          if ((programBase === "perl" || programBase === "ruby") && flag === "0") {
            index = skipZeroFlagAttachedValue(arg, index);
            continue;
          }
          if (programBase === "ruby" && flag === "K") {
            index = Math.min(index + 1, arg.length - 1);
            continue;
          }
          break;
        }
      }
      if (pendingEval) {
        continue;
      }
    }
    if (readValueAfterPrefix(arg, attachedEvalPrefixes) !== null) {
      return true;
    }
  }
  return false;
}

function collectScriptFileArgs(args: string[]): string[] {
  const operands: string[] = [];
  let endOfOptions = false;
  let index = 0;
  let pendingEval = false;
  while (index < args.length) {
    const arg = args.at(index);
    if (arg === undefined) {
      break;
    }
    if (pendingEval) {
      operands.push(...collectScriptEvalPathArgs(arg));
      pendingEval = false;
      index += 1;
      continue;
    }
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      index += 1;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-")) {
      if (SCRIPT_FILE_PATH_VALUE_FLAGS.has(arg)) {
        const value = args.at(index + 1);
        if (value) {
          operands.push(value);
        }
        index += 2;
        continue;
      }
      if (arg.startsWith("-r") && arg.length > 2) {
        operands.push(arg.slice(2));
        index += 1;
        continue;
      }
      const pathValue = readValueAfterPrefix(arg, ["--experimental-loader=", "--import=", "--loader=", "--require="]);
      if (pathValue !== null) {
        operands.push(pathValue);
        index += 1;
        continue;
      }
      if (arg === "-e" || arg === "-c" || arg === "-p" || arg === "--eval") {
        pendingEval = true;
        index += 1;
        continue;
      }
      const evalValue = readValueAfterPrefix(arg, ["-e", "-c", "-p", "--eval="]);
      if (evalValue !== null && evalValue.length > 0) {
        operands.push(...collectScriptEvalPathArgs(evalValue));
        index += 1;
        continue;
      }
      if (optionTakesSeparateValue(arg, SCRIPT_FILE_SKIP_VALUE_FLAGS)) {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    operands.push(arg);
    break;
  }
  return operands;
}

function collectRubyLoadPathArgs(args: string[]): string[] {
  const operands: string[] = [];
  let pendingLoadPath = false;
  for (const arg of args) {
    if (pendingLoadPath) {
      operands.push(...arg.split(path.delimiter).filter((entry) => entry.length > 0));
      pendingLoadPath = false;
      continue;
    }
    if (arg === "-I") {
      pendingLoadPath = true;
      continue;
    }
    if (arg.startsWith("-I") && arg.length > 2) {
      operands.push(...arg.slice(2).split(path.delimiter).filter((entry) => entry.length > 0));
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 2) {
      for (let index = 1; index < arg.length; index += 1) {
        const flag = arg[index];
        if (flag === "I") {
          const loadPath = arg.slice(index + 1);
          if (loadPath) {
            operands.push(...loadPath.split(path.delimiter).filter((entry) => entry.length > 0));
          } else {
            pendingLoadPath = true;
          }
          break;
        }
        if (flag === "0") {
          index = skipZeroFlagAttachedValue(arg, index);
          continue;
        }
        if (flag === "K") {
          index = Math.min(index + 1, arg.length - 1);
          continue;
        }
        if (flag && ["C", "E", "F", "i", "r", "x"].includes(flag)) {
          break;
        }
      }
    }
  }
  return operands;
}

function collectGitPathArgs(args: string[]): string[] {
  const operands: string[] = [];
  let pendingPath = false;
  let sawDiff = false;
  let sawNoIndex = false;
  for (const arg of args) {
    if (pendingPath) {
      operands.push(arg);
      pendingPath = false;
      continue;
    }
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
      pendingPath = true;
      continue;
    }
    if (arg.startsWith("--git-dir=")) {
      operands.push(arg.slice("--git-dir=".length));
      continue;
    }
    if (arg.startsWith("--work-tree=")) {
      operands.push(arg.slice("--work-tree=".length));
      continue;
    }
    if (arg === "diff") {
      sawDiff = true;
      continue;
    }
    if (arg === "--no-index") {
      sawNoIndex = true;
      continue;
    }
    if (sawDiff && sawNoIndex && !arg.startsWith("-")) {
      operands.push(arg);
    }
  }
  return operands;
}

function collectTarPathArgs(args: string[]): string[] {
  const operands: string[] = [];
  let pendingPath = false;
  for (const arg of args) {
    if (pendingPath) {
      operands.push(arg);
      pendingPath = false;
      continue;
    }
    if (arg === "-f" || arg === "--file") {
      pendingPath = true;
      continue;
    }
    if (arg.startsWith("--file=")) {
      operands.push(arg.slice("--file=".length));
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      const fileFlagIndex = arg.indexOf("f");
      if (fileFlagIndex !== -1) {
        if (fileFlagIndex === arg.length - 1) {
          pendingPath = true;
        } else {
          operands.push(arg.slice(fileFlagIndex + 1));
        }
      }
    }
  }
  return operands;
}

function collectUrlFetchPathArgs(args: string[]): string[] {
  const operands: string[] = [];
  let pendingPath = false;
  for (const arg of args) {
    if (pendingPath) {
      operands.push(arg);
      pendingPath = false;
      continue;
    }
    if (URL_FETCH_PATH_VALUE_FLAGS.has(arg)) {
      pendingPath = true;
      continue;
    }
    if (/^-[bcDdEFiHKoOTw]/u.test(arg) && arg.length > 2) {
      operands.push(arg.slice(2));
      continue;
    }
    const pathOptionValue = readValueAfterPrefix(arg, URL_FETCH_PATH_VALUE_PREFIXES);
    if (pathOptionValue !== null) {
      operands.push(pathOptionValue);
    }
  }
  return operands;
}

function hasExistingNonRootAncestor(
  operand: string,
  realpathSyncFn: typeof fs.realpathSync,
): boolean {
  let current = path.resolve(operand);
  const root = pathRoot(current);
  while (current !== root) {
    try {
      realpathString(realpathSyncFn, current);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return true;
      }
      current = path.dirname(current);
    }
  }
  return false;
}

function isGenericPathLikeOperand(
  operand: string,
  resolvedWorkdir: string,
  realpathSyncFn: typeof fs.realpathSync,
): boolean {
  const value = stripSimpleQuotes(operand.trim());
  if (!value) {
    return false;
  }
  if (containsFileUrl(value) || /^data:/i.test(value)) {
    return true;
  }
  if (path.isAbsolute(value)) {
    return hasExistingNonRootAncestor(value, realpathSyncFn);
  }
  if (value.startsWith(".") || value.includes("/") || value.includes("\\")) {
    return hasExistingNonRootAncestor(path.resolve(resolvedWorkdir, value), realpathSyncFn);
  }
  try {
    realpathString(realpathSyncFn, path.resolve(resolvedWorkdir, value));
    return true;
  } catch {
    return false;
  }
}

function unwrapFileReferenceCandidate(value: string): string | null {
  const candidate = stripSimpleQuotes(value.trim());
  if (candidate.length <= 1) {
    return null;
  }
  if (candidate.startsWith("@") || candidate.startsWith("<")) {
    return candidate.slice(1);
  }
  const referenceMatch = /(?:[=;]|^)[^=;\s]*([@<][^;]+)/u.exec(candidate);
  return referenceMatch ? referenceMatch[1]!.slice(1) : null;
}

function unwrapAttachedShortOptionPathCandidates(value: string): string[] {
  const candidate = stripSimpleQuotes(value.trim());
  if (!/^-[A-Za-z]/u.test(candidate) || candidate.startsWith("--") || candidate.length <= 2) {
    return [];
  }
  const candidates: string[] = [];
  for (let index = 2; index < candidate.length; index += 1) {
    candidates.push(candidate.slice(index));
  }
  return [...new Set(candidates)];
}

function collectGenericPathLikeArgs(
  args: string[],
  resolvedWorkdir: string,
  realpathSyncFn: typeof fs.realpathSync,
): string[] {
  const operands: string[] = [];
  for (const arg of args) {
    const equalsIndex = arg.indexOf("=");
    const baseCandidates = equalsIndex > 0
      ? [arg.slice(equalsIndex + 1)]
      : [arg];
    const candidates = [
      ...baseCandidates,
      ...baseCandidates.flatMap((candidate) => {
        const fileReference = unwrapFileReferenceCandidate(candidate);
        return [
          ...(fileReference ? [fileReference] : []),
          ...unwrapAttachedShortOptionPathCandidates(candidate),
        ];
      }),
    ];
    for (const candidate of candidates) {
      if (isGenericPathLikeOperand(candidate, resolvedWorkdir, realpathSyncFn)) {
        operands.push(candidate);
      }
    }
  }
  return operands;
}

function hasShortFlag(arg: string, flag: string): boolean {
  return arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes(flag);
}

function grepUsesUnsafeSymlinkTraversal(args: string[]): boolean {
  let pending: "directories" | "skip" | null = null;
  let recursive = false;
  let symlinkFollow = false;
  for (const arg of args) {
    if (pending === "directories") {
      if (arg === "recurse") {
        recursive = true;
      }
      pending = null;
      continue;
    }
    if (pending === "skip") {
      pending = null;
      continue;
    }
    if (arg === "--") {
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      continue;
    }
    if (arg === "--dereference-recursive") {
      return true;
    }
    if (arg === "--recursive") {
      recursive = true;
      continue;
    }
    if (arg === "--directories") {
      pending = "directories";
      continue;
    }
    if (arg === "--regexp" || arg === "--file") {
      pending = "skip";
      continue;
    }
    if (arg.startsWith("--directories=")) {
      if (arg.slice("--directories=".length) === "recurse") {
        recursive = true;
      }
      continue;
    }
    if (arg.startsWith("--regexp=") || arg.startsWith("--file=")) {
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }

    for (let index = 1; index < arg.length; index += 1) {
      const flag = arg[index];
      if (flag === "R") {
        return true;
      }
      if (flag === "r") {
        recursive = true;
        continue;
      }
      if (flag === "S") {
        symlinkFollow = true;
        continue;
      }
      if (flag === "d") {
        const value = arg.slice(index + 1);
        if (value) {
          if (value === "recurse") {
            recursive = true;
          }
        } else {
          pending = "directories";
        }
        break;
      }
      if (flag === "e" || flag === "f") {
        if (index === arg.length - 1) {
          pending = "skip";
        }
        break;
      }
    }
  }
  return recursive && symlinkFollow;
}

function usesUnsafeSymlinkFollowOption(programBase: string, args: string[]): boolean {
  if (programBase === "find") {
    return args.some((arg) => arg === "-L" || arg === "-follow" || /^-[EHLPdsxX]*L[EHLPdsxX]*$/u.test(arg));
  }
  if (programBase === "rg") {
    return args.some((arg) => arg === "--follow" || hasShortFlag(arg, "L"));
  }
  if (programBase === "grep" || programBase === "egrep" || programBase === "fgrep") {
    return grepUsesUnsafeSymlinkTraversal(args);
  }
  if (programBase === "ls") {
    const recursive = args.some((arg) => arg === "-R" || arg === "--recursive" || hasShortFlag(arg, "R"));
    return recursive && args.some((arg) => arg === "-L" || arg === "--dereference" || hasShortFlag(arg, "L"));
  }
  if (programBase === "du") {
    return args.some((arg) => arg === "-L" || arg === "--dereference" || hasShortFlag(arg, "L"));
  }
  if (programBase === "cp") {
    const recursive = args.some((arg) => arg === "-R" || arg === "-r" || arg === "-a" || arg === "--recursive" || arg === "--archive" || hasShortFlag(arg, "R") || hasShortFlag(arg, "r") || hasShortFlag(arg, "a"));
    return recursive && args.some((arg) => arg === "-L" || arg === "--dereference" || hasShortFlag(arg, "L"));
  }
  if (programBase === "rsync") {
    const recursive = args.some((arg) => arg === "-r" || arg === "-a" || arg === "--recursive" || arg === "--archive" || hasShortFlag(arg, "r") || hasShortFlag(arg, "a"));
    return recursive && args.some((arg) => arg === "-L" || arg === "-k" || arg === "--copy-links" || arg === "--copy-dirlinks" || arg === "--copy-unsafe-links" || hasShortFlag(arg, "L") || hasShortFlag(arg, "k"));
  }
  if (programBase === "pax") {
    return args.some((arg) => arg === "-L" || hasShortFlag(arg, "L"));
  }
  if (programBase === "zip") {
    return !args.some((arg) => arg === "-y" || arg === "--symlinks" || hasShortFlag(arg, "y"));
  }
  if (programBase === "tar" || programBase === "bsdtar" || programBase === "gnutar") {
    return args.some((arg) => arg === "--dereference" || arg === "--hard-dereference" || hasShortFlag(arg, "h") || hasShortFlag(arg, "L"));
  }
  return false;
}

function validateCommandPathOperands(params: {
  commandParts: string[];
  resolvedRoot: string;
  workspaceRoot: string;
  resolvedWorkdir: string;
  realpathSyncFn: typeof fs.realpathSync;
}): string | null {
  const [program, ...args] = params.commandParts;
  const programBase = commandBaseName(program);
  if (programBase === "env" && args.some((arg) => isInlineEnvAssignment(arg))) {
    return "Inline environment assignments in exec commands are not allowed. Use the env parameter so Friday can validate environment values.";
  }
  let operands: string[] = [];
  if (ALL_ARG_PATH_PROGRAMS.has(programBase)) {
    operands = collectAllPathArgs(args);
  } else if (FIND_PATH_PROGRAMS.has(programBase)) {
    operands = collectFindStartPaths(args);
  } else if (GREP_LIKE_PROGRAMS.has(programBase)) {
    operands = collectSearchPathArgs(args);
  } else if (SED_PATH_PROGRAMS.has(programBase)) {
    operands = collectSedPathArgs(args);
  } else if (programBase === "awk") {
    operands = collectAwkPathArgs(args, params.resolvedWorkdir, params.realpathSyncFn);
  } else if (SCRIPT_THEN_PATH_PROGRAMS.has(programBase)) {
    operands = collectSearchPathArgs(args);
  } else if (SCRIPT_FILE_PROGRAMS.has(programBase)) {
    operands = collectScriptFileArgs(args);
    if (programBase === "ruby") {
      operands.push(...collectRubyLoadPathArgs(args));
    }
  } else if (GIT_PATH_PROGRAMS.has(programBase)) {
    operands = collectGitPathArgs(args);
  } else if (TAR_PATH_PROGRAMS.has(programBase)) {
    operands = collectTarPathArgs(args);
  } else if (URL_FETCH_PATH_PROGRAMS.has(programBase)) {
    operands = collectUrlFetchPathArgs(args);
  } else {
    operands = collectGenericPathLikeArgs(
      args,
      params.resolvedWorkdir,
      params.realpathSyncFn,
    );
  }
  if (
    !FIND_PATH_PROGRAMS.has(programBase)
    && !GREP_LIKE_PROGRAMS.has(programBase)
    && !SCRIPT_THEN_PATH_PROGRAMS.has(programBase)
  ) {
    operands = [
      ...new Set([
        ...operands,
        ...collectGenericPathLikeArgs(
          args,
          params.resolvedWorkdir,
          params.realpathSyncFn,
        ),
      ]),
    ];
  }

  for (const operand of operands) {
    const error = validateCommandOperandPath({
      operand,
      resolvedRoot: params.resolvedRoot,
      workspaceRoot: params.workspaceRoot,
      resolvedWorkdir: params.resolvedWorkdir,
      realpathSyncFn: params.realpathSyncFn,
    });
    if (error) {
      return error;
    }
  }
  if (SCRIPT_FILE_PROGRAMS.has(programBase) && usesScriptEvalArg(programBase, args)) {
    return "Script eval commands are not allowed when shell execution is disabled. Put the script in a file inside the workspace so Friday can validate the script path.";
  }
  if (usesUnsafeSymlinkFollowOption(programBase, args)) {
    return "Symlink-following options are not allowed in exec commands because they can read outside the allowed workspace root.";
  }
  return null;
}
// ─── Factory ───

export function createFridayAgentExecTool(
  options?: CreateFridayAgentExecToolOptions,
): FridayAgentToolDefinition {
  const defaultWorkdir = options?.defaultWorkdir ?? process.cwd();
  const workspaceRoot = options?.workspaceRoot ?? defaultWorkdir;
  const allowShell = options?.allowShell ?? false;
  const spawnFn = options?.spawnImpl ?? spawn;
  const realpathSyncFn = options?.realpathSyncImpl ?? fs.realpathSync;

  return {
    name: "exec",
    description:
      "Execute shell commands. Use background=true for long-running commands. " +
      "Returns stdout+stderr combined output.",
    parameters: {
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        workdir: { type: "string", description: "Working directory (defaults to cwd)" },
        env: { type: "object", description: "Extra environment variables" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds" },
        background: { type: "boolean", description: "Run in background (return immediately)" },
      },
      required: ["command"],
    },
    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const command = readStringParam(args, "command", { required: true });
      const workdir = readStringParam(args, "workdir") ?? defaultWorkdir;
      const env = readRecordParam(args, "env");
      const timeoutMs = readNumberParam(args, "timeoutMs", { integer: true }) ?? FRIDAY_AGENT_EXEC_TIMEOUT_MS;
      const background = readBooleanParam(args, "background") ?? false;

      if (env && Object.keys(env).length > 0) {
        return errorResult(
          "Custom environment variables are not allowed for exec commands. " +
          "Run with the inherited trusted environment only.",
        );
      }

      // Security: reject shell metacharacters when allowShell is false
      if (!allowShell && SHELL_META_RE.test(command)) {
        return errorResult(
          "Command contains shell metacharacters (;|&`$(){}) which are not allowed. " +
          "Use simple commands without shell piping or chaining.",
        );
      }

      // Security: reject Unicode control/whitespace characters that could bypass
      // argument parsing or hide malicious content in invisible characters
      if (!allowShell && UNICODE_CONTROL_RE.test(command)) {
        return errorResult(
          "Command contains Unicode control or non-standard whitespace characters which are not allowed. " +
          "Use only ASCII printable characters and standard spaces.",
        );
      }

      const approvalReason = getApprovalRequiredReasonForExecCommand(command);
      if (approvalReason) {
        return errorResult(`Approval required before execution. ${approvalReason}`);
      }

      // Security: ensure workdir is within the workspace root (resolve symlinks)
      let resolvedWorkdir: string;
      try {
        resolvedWorkdir = realpathSyncFn(workdir) as string;
      } catch (err) {
        console.warn("[friday][agent-exec-tool] workdir resolve failed:", err instanceof Error ? err.message : String(err));
        return errorResult(
          `Working directory "${workdir}" does not exist or is not accessible.`,
        );
      }
      let resolvedRoot: string;
      try {
        resolvedRoot = realpathSyncFn(workspaceRoot) as string;
      } catch (err) {
        console.warn("[friday][agent-exec-tool] workspace root resolve failed:", err instanceof Error ? err.message : String(err));
        resolvedRoot = path.resolve(workspaceRoot);
      }
      if (!resolvedWorkdir.startsWith(resolvedRoot + path.sep) && resolvedWorkdir !== resolvedRoot) {
        return errorResult(
          `Working directory "${workdir}" is outside the allowed workspace root "${workspaceRoot}".`,
        );
      }

      const commandParts = !allowShell ? command.trim().split(/\s+/) : [];
      if (!allowShell) {
        const pathOperandError = validateCommandPathOperands({
          commandParts,
          resolvedRoot,
          workspaceRoot,
          resolvedWorkdir,
          realpathSyncFn,
        });
        if (pathOperandError) {
          return errorResult(pathOperandError);
        }
      }

      const mergedEnv = env ? { ...process.env, ...env } : process.env;

      return new Promise<FridayAgentToolResult>((resolve) => {
        // When allowShell is false, avoid shell: true entirely to prevent shell
        // interpretation of metacharacters, redirections, and path escapes.
        let proc: ChildProcess;
        if (allowShell) {
          proc = spawnFn(command, [], {
            shell: true,
            cwd: resolvedWorkdir,
            env: mergedEnv,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } else {
          // Split command into program + args without shell interpretation
          const parts = commandParts;
          const program = parts[0]!;
          const spawnArgs = parts.slice(1);
          proc = spawnFn(program, spawnArgs, {
            shell: false,
            cwd: resolvedWorkdir,
            env: mergedEnv,
            stdio: ["ignore", "pipe", "pipe"],
          });
        }

        let output = "";
        let outputBytes = 0;
        let killed = false;
        let timedOut = false;

        const appendOutput = (chunk: Buffer) => {
          if (outputBytes >= FRIDAY_AGENT_EXEC_MAX_OUTPUT_BYTES) {
            return;
          }
          const text = chunk.toString("utf8");
          output += text;
          outputBytes += chunk.byteLength;
        };

        proc.stdout?.on("data", appendOutput);
        proc.stderr?.on("data", appendOutput);

        // Timeout handling
        const timer = setTimeout(() => {
          timedOut = true;
          killed = true;
          proc.kill("SIGTERM");
          // Force kill after 5 seconds
          setTimeout(() => {
            if (!proc.killed) {
              proc.kill("SIGKILL");
            }
          }, 5_000);
        }, Math.max(1, timeoutMs));

        // Abort signal handling
        const onAbort = () => {
          if (!killed) {
            killed = true;
            proc.kill("SIGTERM");
          }
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }

        // Background mode — return immediately
        if (background) {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(
            textResult(
              `Command started in background (pid ${String(proc.pid ?? "unknown")}). ` +
              "Output will not be captured.",
            ),
          );
          return;
        }

        proc.on("close", (code: number | null) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);

          const truncated = truncateOutput(output, FRIDAY_AGENT_EXEC_MAX_OUTPUT_BYTES);
          const exitCode = code ?? (killed ? 137 : 1);

          if (timedOut) {
            resolve(
              errorResult(
                `Command timed out after ${String(timeoutMs)}ms (exit code ${String(exitCode)}).\n${truncated}`,
              ),
            );
            return;
          }

          if (exitCode !== 0) {
            resolve(
              errorResult(
                `Command failed (exit code ${String(exitCode)}).\n${truncated}`,
              ),
            );
            return;
          }

          resolve(textResult(truncated || "(no output)"));
        });

        proc.on("error", (err: Error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(errorResult(`Command error: ${err.message}`));
        });
      });
    },
  };
}
