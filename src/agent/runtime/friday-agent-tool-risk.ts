// ─── Shell risk classification (Initiative B.3) ───

/**
 * Typed shell risk levels for command classification.
 *
 * - safe: read-only commands with no side effects
 * - guarded: mutating but reversible, may proceed with logging
 * - destructive: irreversible mutations requiring approval
 * - blocked: never allowed (shell injection vectors)
 */
export type FridayShellRiskLevel = "safe" | "guarded" | "destructive" | "blocked";

export interface FridayShellRiskClassification {
  level: FridayShellRiskLevel;
  reason?: string;
  program?: string;
}

const PROVIDER_MUTATING_ACTIONS = new Set([
  "create",
  "update",
  "delete",
  "activate_profile",
  "oauth_init",
  "oauth_complete",
  "set_default",
]);

const INFORMATIONAL_PROVIDER_GUIDANCE_RE =
  /\b(how do i|how can i|guide me|walk me through|show me how|what steps|step by step|explain how|tell me how)\b/i;
const INFORMATIONAL_PROVIDER_GUIDANCE_CJK_RE =
  /(怎么|如何|指导我|一步一步|逐步|告诉我怎么|教我怎么).{0,12}(连接|配置|设置|接入|anthropic|claude|api key|密钥)/i;

const SAFE_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "file", "stat", "which", "whereis",
  "echo", "printf", "date", "whoami", "uname", "hostname", "pwd",
  "find", "grep", "rg", "ag", "awk", "sort", "uniq", "diff", "comm",
  "tree", "du", "df", "free", "top", "ps", "env", "printenv",
  "git", "npm", "npx", "yarn", "pnpm", "node", "python", "python3",
  "cargo", "go", "rustc", "gcc", "make", "cmake",
  "curl", "wget",
]);

const BLOCKED_SHELL_PATTERNS = [
  /[;|&`$(){}\n\r<>#!~]/,           // shell metacharacters
  /[\u0000-\u001f\u007f-\u009f]/,   // control characters
];

/**
 * Classify the risk level of a shell command.
 */
export function classifyShellRisk(command: string): FridayShellRiskClassification {
  const trimmed = command.trim();
  if (!trimmed) {
    return { level: "safe", reason: "empty command" };
  }

  // Check for shell injection vectors
  for (const pattern of BLOCKED_SHELL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { level: "blocked", reason: "Shell metacharacters or control characters detected" };
    }
  }

  const parts = trimmed.split(/\s+/);
  const program = parts[0]?.toLowerCase() ?? "";

  // Destructive programs always require approval
  // Also match mkfs.* variants (mkfs.ext4, mkfs.xfs, etc.)
  const programBase = program.includes(".") ? program.split(".")[0]! : program;
  if (DESTRUCTIVE_PROGRAMS.has(program) || DESTRUCTIVE_PROGRAMS.has(programBase)) {
    return { level: "destructive", reason: `${program} is a destructive command`, program };
  }

  // Destructive FLAGS on otherwise-safe programs (git reset --hard, git clean -fdx,
  // find . -delete) — classification must key on flags, not just the program name.
  const dangerousFlagReason = detectDangerousShellFlagReason(program, parts);
  if (dangerousFlagReason) {
    return { level: "destructive", reason: dangerousFlagReason, program };
  }

  // Protected artifact + destructive keyword
  const touchesProtected = listPotentialFilePaths(trimmed)
    .some((fp) => requiresApprovalForProtectedArtifactPath(fp));
  if (touchesProtected && DESTRUCTIVE_COMMAND_KEYWORD_RE.test(trimmed.toLowerCase())) {
    return { level: "destructive", reason: "Destructive operation on protected artifact", program };
  }

  // Sensitive credential manipulation
  if (SENSITIVE_ASSIGNMENT_RE.test(trimmed)) {
    return { level: "destructive", reason: "Token/secret mutation detected", program };
  }
  if (SENSITIVE_KEY_RE.test(trimmed.toLowerCase()) && MUTATING_PROGRAMS.has(program)) {
    return { level: "destructive", reason: "Sensitive key manipulation via mutating program", program };
  }

  // Known safe programs
  if (SAFE_PROGRAMS.has(program)) {
    return { level: "safe", program };
  }

  // Unknown programs — guarded by default
  return { level: "guarded", reason: "Unknown program, treating as guarded", program };
}

// ─── Existing approval gate logic ───

const SENSITIVE_KEY_RE = /\b(api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|credential|private[_-]?key|token)\b/i;
const SENSITIVE_ASSIGNMENT_RE = /(?:["']?(api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|credential|private[_-]?key|token)["']?\s*[:=]|(?:export\s+)?[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=)/i;
const DESTRUCTIVE_PROGRAMS = new Set([
  "rm", "unlink", "shred", "truncate",
  "dd",       // raw device/file write — data destruction
  "mkfs",     // format filesystem
  "kill",     // terminate process by PID
  "killall",  // terminate processes by name
  "pkill",    // terminate processes by pattern
]);
const MUTATING_PROGRAMS = new Set(["sed", "perl", "python", "python3", "node", "jq", "ruby"]);
const HIGH_RISK_MUTATION_EXTENSION_RE = /\.(?:bak|backup|dump|sqlite|db|sql|tar|tgz|gz|zip)$/i;
const HIGH_RISK_MUTATION_NAME_RE = /\b(database|backup|snapshot|restore)\b/i;
const DESTRUCTIVE_COMMAND_KEYWORD_RE = /\b(rm|remove|delete|unlink|shred|truncate|unlinksync|rmsync)\b/i;

function requiresApprovalForProtectedArtifactPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const baseName = normalized.split("/").at(-1) ?? normalized;
  const lowerBaseName = baseName.toLowerCase();
  const obviouslyTextual = /\.(?:md|txt|json|ya?ml|toml|ini|cfg|conf)$/i.test(lowerBaseName);

  if (HIGH_RISK_MUTATION_EXTENSION_RE.test(lowerBaseName)) {
    return true;
  }

  if (!obviouslyTextual && HIGH_RISK_MUTATION_NAME_RE.test(lowerBaseName)) {
    return true;
  }

  return false;
}

function listPotentialFilePaths(text: string): string[] {
  return [...new Set(text.match(/\b[\w./-]+\.[A-Za-z0-9]+\b/g) ?? [])];
}

// git global options that precede the subcommand and, when given in their space-form
// (without `=`), ALSO consume the following token. Used to locate the real subcommand for
// forms like `git -C /repo reset --hard`. NOTE: this set is an optimization for the precise
// path, not a security boundary — an option we forget to list does NOT open a bypass, because
// `gitSubcommandStart` fails safe on anything it does not recognize (see below).
const GIT_GLOBAL_OPTS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix",
  // plumbing options that take a separate-token value (Reviewer-A bypass class):
  "--config-env", "--shallow-file", "--attr-source",
]);

// git global options that take NO value, so the next token is still a global option or the
// subcommand. Recognizing the common ones keeps the precise path in play; an unrecognized
// flag simply falls through to the fail-safe scan below.
const GIT_GLOBAL_FLAGS_NO_VALUE = new Set([
  "--no-pager", "--paginate", "-p", "--bare", "--no-replace-objects", "--literal-pathspecs",
  "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks",
  "--no-lazy-fetch", "--no-advice", "--version", "--html-path", "--man-path", "--info-path",
]);

// Sentinel: a leading git global option we do NOT recognize. We cannot reliably locate the
// subcommand by position (an unknown option might consume the next token, masquerading its
// value as the subcommand — the exact `git --shallow-file <v> reset --hard` bypass class).
// The caller must fail safe and scan the whole token list instead of trusting position.
const GIT_SUBCOMMAND_UNKNOWN_OPT = -2;

function gitSubcommandStart(parts: readonly string[]): number {
  let i = 1;
  while (i < parts.length) {
    const tok = parts[i]!;
    if (!tok.startsWith("-")) return i; // first non-option token is the subcommand
    if (tok.includes("=")) { // `--opt=value` carries its value inline — single token
      i += 1;
      continue;
    }
    if (GIT_GLOBAL_OPTS_WITH_VALUE.has(tok)) { // `-C <v>` / `--git-dir <v>` consume next token
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_FLAGS_NO_VALUE.has(tok)) { // known value-less flag — skip just the flag
      i += 1;
      continue;
    }
    return GIT_SUBCOMMAND_UNKNOWN_OPT; // unrecognized global option → fail safe, do not guess
  }
  return -1;
}

// Precise per-subcommand check: given a known subcommand and the tokens that follow it,
// return an approval reason for a destructive flag combination, else null.
function gitDestructiveReason(sub: string, rest: readonly string[]): string | null {
  const s = sub.toLowerCase();
  const hasForce = rest.some((a) => a === "-f" || a === "--force");
  if (s === "reset" && rest.some((a) => a === "--hard")) {
    return "`git reset --hard` irreversibly discards uncommitted changes and requires explicit approval in the current run context.";
  }
  if (s === "clean" && rest.some((a) => /^-[a-z]*f[a-z]*$/i.test(a) || a === "--force")) {
    return "`git clean -f…` permanently deletes untracked files and requires explicit approval in the current run context.";
  }
  if ((s === "checkout" || s === "restore" || s === "switch") && (hasForce || rest.some((a) => a === "--hard"))) {
    return `\`git ${s} --force\` discards local changes and requires explicit approval in the current run context.`;
  }
  return null;
}

// Fail-safe scan used only when an unrecognized leading global option is present: treat each
// token as a candidate subcommand and check the tokens after it, so a destructive combination
// cannot hide behind an option we don't model. Because this only runs when a leading option is
// unrecognized, it does NOT produce the `git commit -m "reset --hard"` false-positive (there the
// subcommand `commit` is found by position and the scan is never reached).
function gitDestructiveReasonByScan(tokens: readonly string[]): string | null {
  for (let k = 0; k < tokens.length; k++) {
    const reason = gitDestructiveReason(tokens[k]!, tokens.slice(k + 1));
    if (reason) return reason;
  }
  return null;
}

/**
 * Detect destructive FLAG combinations on programs that are otherwise allow-listed as
 * "safe" by name (e.g. git, find). Classification by program name alone let irreversible
 * operations like `git reset --hard`, `git clean -fdx`, and `find . -delete` slip through
 * without approval; this closes that flag-vs-program gap. Leading git global options
 * (`git -C <path> …`, `git --no-pager …`) are skipped so the subcommand is found regardless
 * of the invocation form; an UNRECOGNIZED leading option fails safe to a full-token scan so
 * obscure plumbing options (`git --shallow-file <v> reset --hard`) cannot hide a destructive
 * subcommand. Returns an approval reason string when a dangerous flag combination is present,
 * else null.
 */
function detectDangerousShellFlagReason(program: string, parts: readonly string[]): string | null {
  if (program === "git") {
    const subIdx = gitSubcommandStart(parts);
    if (subIdx === GIT_SUBCOMMAND_UNKNOWN_OPT) {
      return gitDestructiveReasonByScan(parts.slice(1));
    }
    if (subIdx === -1) {
      return null;
    }
    return gitDestructiveReason(parts[subIdx] ?? "", parts.slice(subIdx + 1));
  }
  if (program === "find") {
    if (parts.slice(1).some((a) => a === "-delete")) {
      return "`find … -delete` permanently removes matched files and requires explicit approval in the current run context.";
    }
  }
  return null;
}

function readToolAction(args: Record<string, unknown>): string {
  return typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
}

export function getPolicyDeniedReasonForToolCall(
  task: string,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName !== "provider") {
    return null;
  }

  const action = readToolAction(args);
  if (!PROVIDER_MUTATING_ACTIONS.has(action)) {
    return null;
  }

  const normalizedTask = task.trim();
  if (!normalizedTask) {
    return null;
  }

  if (
    INFORMATIONAL_PROVIDER_GUIDANCE_RE.test(normalizedTask)
    || INFORMATIONAL_PROVIDER_GUIDANCE_CJK_RE.test(normalizedTask)
  ) {
    return "Informational guidance requests must not mutate provider configuration. Explain the steps first and wait for explicit approval before changing providers.";
  }

  return null;
}

export function getApprovalRequiredReasonForExecCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const program = parts[0]?.toLowerCase() ?? "";
  const lowerCommand = trimmed.toLowerCase();
  const touchesProtectedArtifact = listPotentialFilePaths(trimmed)
    .some((filePath) => requiresApprovalForProtectedArtifactPath(filePath));

  if (touchesProtectedArtifact && DESTRUCTIVE_COMMAND_KEYWORD_RE.test(lowerCommand)) {
    return "Deleting backup/dump/snapshot-like artifacts is destructive and requires explicit approval in the current run context.";
  }

  if (DESTRUCTIVE_PROGRAMS.has(program)) {
    return "Deleting files from the shell is destructive and requires explicit approval in the current run context.";
  }

  const dangerousFlagReason = detectDangerousShellFlagReason(program, parts);
  if (dangerousFlagReason) {
    return dangerousFlagReason;
  }

  if (SENSITIVE_ASSIGNMENT_RE.test(trimmed)) {
    return "Rotating or mutating token/secret-like values requires explicit approval in the current run context.";
  }

  if (SENSITIVE_KEY_RE.test(lowerCommand) && MUTATING_PROGRAMS.has(program)) {
    return "Rotating or mutating token/secret-like values requires explicit approval in the current run context.";
  }

  return null;
}

export function getApprovalRequiredReasonForFileMutation(
  filePath: string,
  fragments: string[],
): string | null {
  if (requiresApprovalForProtectedArtifactPath(filePath)) {
    return `Mutating backup/dump/snapshot-like artifact "${filePath}" requires explicit approval in the current run context.`;
  }

  const haystack = fragments.join("\n");
  if (SENSITIVE_ASSIGNMENT_RE.test(haystack)) {
    return `Mutating sensitive token/secret-like material in "${filePath}" requires explicit approval in the current run context.`;
  }
  return null;
}

export function getApprovalRequiredReasonForToolCall(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName === "provider") {
    const action = readToolAction(args);
    if (PROVIDER_MUTATING_ACTIONS.has(action)) {
      return "Mutating provider configuration or authentication requires explicit approval in the current run context.";
    }
  }

  if (toolName === "exec" && typeof args.command === "string") {
    return getApprovalRequiredReasonForExecCommand(args.command);
  }

  if (toolName === "write") {
    const filePath = typeof args.path === "string" ? args.path : "unknown file";
    const content = typeof args.content === "string" ? args.content : "";
    return getApprovalRequiredReasonForFileMutation(filePath, [content]);
  }

  if (toolName === "edit") {
    const filePath = typeof args.path === "string" ? args.path : "unknown file";
    const oldText = typeof args.oldText === "string" ? args.oldText : "";
    const newText = typeof args.newText === "string" ? args.newText : "";
    return getApprovalRequiredReasonForFileMutation(filePath, [oldText, newText]);
  }

  // P1-SEC-002: browser requires approval for JS execution and dangerous URLs
  if (toolName === "browser") {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "evaluate") {
      return "Executing arbitrary JavaScript in the browser requires explicit approval.";
    }
    const url = typeof args.url === "string" ? args.url : "";
    if (url && /^(file:|javascript:|data:)/i.test(url)) {
      return `Navigating to a potentially dangerous URL scheme (${url.split(":")[0]}:) requires explicit approval.`;
    }
  }

  // P2-SEC-011: canvas:eval requires approval — arbitrary JS execution in canvas context
  if (toolName === "canvas") {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "eval" || action === "evaluate") {
      return "Executing arbitrary JavaScript in the canvas requires explicit approval.";
    }
  }

  // P2-SEC-012: xhs:post requires approval — publishes content to social media
  if (toolName === "xhs") {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "post" || action === "publish" || action === "comment") {
      return "Publishing content to social media (Xiaohongshu) requires explicit approval.";
    }
  }

  // P2-SEC-010: desktop:launch_app requires approval — OS application control
  if (toolName === "desktop") {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "launch_app" || action === "close_app") {
      return "Launching or closing desktop applications requires explicit approval.";
    }
  }

  // P2-SEC-011: tts:speak/synthesize requires approval — audio output
  if (toolName === "tts") {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "speak" || action === "synthesize") {
      return "Text-to-speech audio output requires explicit approval.";
    }
  }

  if (toolName === "guide_lens") {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "update_preferences" || action === "update_avatar") {
      return "Changing Guide Lens preferences requires explicit approval in the current run context.";
    }
  }

  return null;
}
