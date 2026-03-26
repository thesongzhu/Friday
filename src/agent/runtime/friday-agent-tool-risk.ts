const SENSITIVE_KEY_RE = /\b(api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|credential|private[_-]?key|token)\b/i;
const SENSITIVE_ASSIGNMENT_RE = /(?:["']?(api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|credential|private[_-]?key|token)["']?\s*[:=]|(?:export\s+)?[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=)/i;
const DESTRUCTIVE_PROGRAMS = new Set(["rm", "unlink", "shred", "truncate"]);
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

  return null;
}
