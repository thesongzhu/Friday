import { readFile } from "node:fs/promises";

const ENV_VAR_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type FridaySecretInput =
  | { kind: "inline"; value: string }
  | { kind: "env-ref"; envVar: string }
  | { kind: "secret-ref"; refKey: string }
  | { kind: "file-ref"; path: string }
  | { kind: "command-ref"; command: string };

export interface FridaySecretResolutionBlocker {
  code:
    | "SECRET_REF_INVALID"
    | "SECRET_ENV_VAR_MISSING"
    | "SECRET_REF_NOT_FOUND"
    | "SECRET_FILE_PATH_INVALID"
    | "SECRET_FILE_READ_FAILED"
    | "SECRET_FILE_EMPTY"
    | "SECRET_COMMAND_DISABLED"
    | "SECRET_COMMAND_FAILED"
    | "SECRET_COMMAND_EMPTY";
  message: string;
  refKind: FridaySecretInput["kind"];
  details?: Record<string, unknown>;
}

export type FridaySecretResolutionResult =
  | {
    ok: true;
    value: string;
    source: FridaySecretInput["kind"];
  }
  | {
    ok: false;
    blocker: FridaySecretResolutionBlocker;
  };

export interface ParseFridaySecretInputOptions {
  secretRefPrefixes?: readonly string[];
  trimInline?: boolean;
}

export interface ResolveFridaySecretInputOptions {
  env?: NodeJS.ProcessEnv;
  readSecretRef?: (refKey: string) => string | null | Promise<string | null>;
  readFileText?: (path: string) => Promise<string>;
  execCommand?: (command: string) => Promise<string>;
  allowCommandRefs?: boolean;
  trimValue?: boolean;
}

const DEFAULT_SECRET_REF_PREFIXES = ["secret://"] as const;

function normalizeGenericSecretRef(raw: string, prefixes: readonly string[]): string | null {
  for (const prefix of prefixes) {
    if (!raw.startsWith(prefix)) continue;
    const encoded = raw.slice(prefix.length);
    if (!encoded) return null;
    try {
      const decoded = decodeURIComponent(encoded);
      return decoded.trim().length > 0 ? decoded.trim() : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeFileRefPath(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.startsWith("file://")) {
    try {
      const url = new URL(value);
      return url.pathname.trim().length > 0 ? decodeURIComponent(url.pathname) : null;
    } catch {
      return null;
    }
  }
  if (!value.startsWith("file:")) {
    return null;
  }
  const candidate = value.slice("file:".length).trim();
  return candidate.length > 0 ? candidate : null;
}

function buildInvalidRef(
  raw: string,
  message = "Secret reference format is invalid.",
): FridaySecretResolutionResult {
  return {
    ok: false,
    blocker: {
      code: "SECRET_REF_INVALID",
      message,
      refKind: "inline",
      details: { raw },
    },
  };
}

export function buildFridaySecretRef(refKey: string): string {
  return `secret://${encodeURIComponent(refKey)}`;
}

export function parseFridaySecretInput(
  raw: string,
  options: ParseFridaySecretInputOptions = {},
): FridaySecretInput {
  const value = options.trimInline === false ? raw : raw.trim();
  const secretRefPrefixes = options.secretRefPrefixes ?? DEFAULT_SECRET_REF_PREFIXES;

  if (value.startsWith("$") && ENV_VAR_REGEX.test(value.slice(1))) {
    return { kind: "env-ref", envVar: value.slice(1) };
  }

  if (value.startsWith("env:")) {
    const envVar = value.slice("env:".length).trim();
    if (ENV_VAR_REGEX.test(envVar)) {
      return { kind: "env-ref", envVar };
    }
  }

  if (value.startsWith("file:")) {
    const path = normalizeFileRefPath(value);
    if (path) {
      return { kind: "file-ref", path };
    }
  }

  if (value.startsWith("command:")) {
    const command = value.slice("command:".length).trim();
    if (command.length > 0) {
      return { kind: "command-ref", command };
    }
  }

  const refKey = normalizeGenericSecretRef(value, secretRefPrefixes);
  if (refKey) {
    return { kind: "secret-ref", refKey };
  }

  return { kind: "inline", value };
}

export async function resolveFridaySecretInput(
  input: FridaySecretInput,
  options: ResolveFridaySecretInputOptions = {},
): Promise<FridaySecretResolutionResult> {
  const trimValue = options.trimValue !== false;
  const env = options.env ?? process.env;

  switch (input.kind) {
    case "inline":
      return {
        ok: true,
        value: trimValue ? input.value.trim() : input.value,
        source: "inline",
      };
    case "env-ref": {
      const value = env[input.envVar];
      if (!value || value.trim().length === 0) {
        return {
          ok: false,
          blocker: {
            code: "SECRET_ENV_VAR_MISSING",
            message: `Environment variable '${input.envVar}' is not set.`,
            refKind: "env-ref",
            details: { envVar: input.envVar },
          },
        };
      }
      return {
        ok: true,
        value: trimValue ? value.trim() : value,
        source: "env-ref",
      };
    }
    case "secret-ref": {
      const readSecretRef = options.readSecretRef;
      if (!readSecretRef) {
        return {
          ok: false,
          blocker: {
            code: "SECRET_REF_INVALID",
            message: "Stored secret refs are not supported in this context.",
            refKind: "secret-ref",
            details: { refKey: input.refKey },
          },
        };
      }
      const value = await readSecretRef(input.refKey);
      if (!value || value.trim().length === 0) {
        return {
          ok: false,
          blocker: {
            code: "SECRET_REF_NOT_FOUND",
            message: `Stored secret ref '${input.refKey}' was not found.`,
            refKind: "secret-ref",
            details: { refKey: input.refKey },
          },
        };
      }
      return {
        ok: true,
        value: trimValue ? value.trim() : value,
        source: "secret-ref",
      };
    }
    case "file-ref": {
      if (!input.path.startsWith("/")) {
        return {
          ok: false,
          blocker: {
            code: "SECRET_FILE_PATH_INVALID",
            message: "File secret refs must use an absolute path.",
            refKind: "file-ref",
            details: { path: input.path },
          },
        };
      }
      try {
        const readFileText = options.readFileText ?? (async (path: string) => readFile(path, "utf8"));
        const value = await readFileText(input.path);
        const normalized = trimValue ? value.trim() : value;
        if (normalized.length === 0) {
          return {
            ok: false,
            blocker: {
              code: "SECRET_FILE_EMPTY",
              message: `Secret file '${input.path}' is empty.`,
              refKind: "file-ref",
              details: { path: input.path },
            },
          };
        }
        return {
          ok: true,
          value: normalized,
          source: "file-ref",
        };
      } catch (error) {
        return {
          ok: false,
          blocker: {
            code: "SECRET_FILE_READ_FAILED",
            message: `Failed to read secret file '${input.path}'.`,
            refKind: "file-ref",
            details: {
              path: input.path,
              error: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
    }
    case "command-ref": {
      if (options.allowCommandRefs !== true) {
        return {
          ok: false,
          blocker: {
            code: "SECRET_COMMAND_DISABLED",
            message: "Command-based secret refs are disabled.",
            refKind: "command-ref",
            details: { command: input.command },
          },
        };
      }
      if (!options.execCommand) {
        return {
          ok: false,
          blocker: {
            code: "SECRET_COMMAND_DISABLED",
            message: "Command-based secret refs require an explicit non-shell executor.",
            refKind: "command-ref",
            details: { command: input.command },
          },
        };
      }
      try {
        const execCommand = options.execCommand;
        const value = await execCommand(input.command);
        const normalized = trimValue ? value.trim() : value;
        if (normalized.length === 0) {
          return {
            ok: false,
            blocker: {
              code: "SECRET_COMMAND_EMPTY",
              message: "Command-based secret ref returned empty output.",
              refKind: "command-ref",
              details: { command: input.command },
            },
          };
        }
        return {
          ok: true,
          value: normalized,
          source: "command-ref",
        };
      } catch (error) {
        return {
          ok: false,
          blocker: {
            code: "SECRET_COMMAND_FAILED",
            message: "Command-based secret ref failed to execute.",
            refKind: "command-ref",
            details: {
              command: input.command,
              error: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
    }
  }
}

export function assertFridaySecretInputIsRef(
  raw: string,
  options: ParseFridaySecretInputOptions = {},
): FridaySecretResolutionResult {
  const parsed = parseFridaySecretInput(raw, options);
  if (parsed.kind === "inline") {
    return buildInvalidRef(raw, "Plaintext secret is not allowed in this context.");
  }
  return { ok: true, value: raw, source: parsed.kind };
}
