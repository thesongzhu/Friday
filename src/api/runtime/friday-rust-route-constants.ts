// Shared constants for the Rust read-only route qualifier and its mission auto-dispatch producer.
// Keep this file dependency-light so interop bundles can import the real auto-dispatch driver
// without dragging the full API runtime graph into the subprocess.

// These are the RUST registry read-tool names (read_file / list_dir / stat_file / search).
// list_dir/stat_file/search have no TS alias; the grant names what the Rust read-only loop
// natively exposes, exactly matching the runtime qualifier.
export const RUST_ROUTE_READ_TOOL_ALLOWLIST = [
  "read_file",
  "list_dir",
  "stat_file",
  "search",
] as const;

// Single source of truth for the qualifying DeepSeek route shape.
export const RUST_ROUTE_DEEPSEEK_PROVIDER_ID = "deepseek";
export const RUST_ROUTE_DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";

// Single source of truth for mission-bound Codex observe-wrapper runs. This route shape is admitted
// only when a validated missionContext selector and authenticated principal are present; ordinary
// Codex runs stay closed.
export const RUST_ROUTE_CODEX_PROVIDER_ID = "codex";
export const RUST_ROUTE_CODEX_MODEL = "gpt-5.5";

// Codex app-server observe-wrapper runs can legitimately take longer than the generic sealed-WS
// default (30s). Keep the longer budget scoped to mission-bound Codex auto-dispatch so DeepSeek
// read-only smoke runs stay on the short fail-closed path.
export const RUST_ROUTE_CODEX_MISSION_DISPATCH_TIMEOUT_MS = 300_000;
