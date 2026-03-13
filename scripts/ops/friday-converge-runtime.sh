#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKSPACE="${WORKSPACE:-$ROOT_DIR}"
MODEL_SPEC=""
PROVIDER_ID=""
STATE_DIR=""
DRY_RUN="false"
KEEP_OPENCLAW="false"

usage() {
  cat <<'EOF'
Usage:
  scripts/ops/friday-converge-runtime.sh --model <provider-kind/model-id> [options]

Options:
  --model <spec>         Required. Example: openai/gpt-4o-mini, ollama/llama3.2:3b
  --provider-id <id>     Optional. Force specific provider profile id in Friday DB.
  --state-dir <path>     Optional. Friday state dir (default: platform convention).
  --dry-run              Print actions without mutating state.
  --keep-openclaw        Do not stop/disable OpenClaw launch agents.
  -h, --help             Show this help.
EOF
}

log() {
  printf '[converge] %s\n' "$*"
}

run_cmd() {
  if [[ "$DRY_RUN" == "true" ]]; then
    log "DRY-RUN: $*"
    return 0
  fi
  "$@"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --model" >&2
        usage
        exit 2
      fi
      MODEL_SPEC="$2"
      shift 2
      ;;
    --provider-id)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --provider-id" >&2
        usage
        exit 2
      fi
      PROVIDER_ID="$2"
      shift 2
      ;;
    --state-dir)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --state-dir" >&2
        usage
        exit 2
      fi
      STATE_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    --keep-openclaw)
      KEEP_OPENCLAW="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$MODEL_SPEC" ]]; then
  echo "--model is required" >&2
  usage
  exit 2
fi

if [[ "$MODEL_SPEC" != */* ]]; then
  echo "--model must be in <provider-kind/model-id> format, got: $MODEL_SPEC" >&2
  exit 2
fi

MODEL_PROVIDER_KIND="${MODEL_SPEC%%/*}"
MODEL_ID="${MODEL_SPEC#*/}"
if [[ -z "$MODEL_PROVIDER_KIND" || -z "$MODEL_ID" ]]; then
  echo "Invalid --model value: $MODEL_SPEC" >&2
  exit 2
fi

if [[ -z "$STATE_DIR" ]]; then
  case "$(uname -s)" in
    Darwin)
      STATE_DIR="$HOME/Library/Application Support/Friday/state"
      ;;
    Linux)
      STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/friday"
      ;;
    *)
      STATE_DIR="$HOME/.friday/state"
      ;;
  esac
fi

DB_PATH="$STATE_DIR/friday.db"
FRIDAY_JSON="$HOME/.friday/friday.json"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
FRIDAY_LABEL="com.friday.hub"
FRIDAY_COMPANION_LABEL="com.friday.companion"
FRIDAY_UI_LABEL="com.friday.ui-open"
OPENCLAW_LABELS=("ai.openclaw.gateway" "com.clawdbot.gateway")
UID_VALUE="$(id -u)"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$HOME/.friday/converge-backups/$TIMESTAMP"

if [[ ! -d "$WORKSPACE" ]]; then
  echo "Workspace not found: $WORKSPACE" >&2
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "Friday DB not found: $DB_PATH" >&2
  echo "Start Friday once before running convergence." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

if ! command -v launchctl >/dev/null 2>&1; then
  echo "launchctl is required on macOS for runtime convergence" >&2
  exit 1
fi

if [[ "$DRY_RUN" != "true" ]]; then
  mkdir -p "$BACKUP_DIR"
  if [[ -f "$FRIDAY_JSON" ]]; then
    cp "$FRIDAY_JSON" "$BACKUP_DIR/friday.json.bak"
  fi
  for label in "${OPENCLAW_LABELS[@]}"; do
    plist="$LAUNCH_AGENTS_DIR/$label.plist"
    if [[ -f "$plist" ]]; then
      cp "$plist" "$BACKUP_DIR/$label.plist.bak"
    fi
  done
fi

log "State dir: $STATE_DIR"
log "DB path: $DB_PATH"
log "Target model: $MODEL_PROVIDER_KIND/$MODEL_ID"
if [[ -n "$PROVIDER_ID" ]]; then
  log "Forced provider id: $PROVIDER_ID"
fi
if [[ "$DRY_RUN" == "true" ]]; then
  log "Dry-run mode enabled"
fi

if [[ "$KEEP_OPENCLAW" != "true" ]]; then
  log "Disabling competing OpenClaw runtimes"
  for label in "${OPENCLAW_LABELS[@]}"; do
    run_cmd launchctl bootout "gui/$UID_VALUE/$label" >/dev/null 2>&1 || true
    run_cmd launchctl disable "gui/$UID_VALUE/$label" >/dev/null 2>&1 || true
  done
  run_cmd pkill -f "openclaw-gateway" >/dev/null 2>&1 || true
  run_cmd pkill -f "clawdbot.*gateway" >/dev/null 2>&1 || true
fi

log "Legacy channel migration is now handled by Friday startup against setup_state + managed secrets"
if [[ "$DRY_RUN" == "true" ]]; then
  log "DRY-RUN: no direct channel mutation; next Friday start will reconcile legacy config"
fi

log "Setting Friday default routing model in state DB"
if [[ "$DRY_RUN" == "true" ]]; then
  log "DRY-RUN: update provider_profiles + hub_settings.llm.routing.v1"
else
  DB_PATH="$DB_PATH" PROVIDER_ID="$PROVIDER_ID" MODEL_PROVIDER_KIND="$MODEL_PROVIDER_KIND" MODEL_ID="$MODEL_ID" node --input-type=commonjs <<'NODE'
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH;
const forcedProviderId = process.env.PROVIDER_ID || "";
const targetKind = process.env.MODEL_PROVIDER_KIND;
const targetModel = process.env.MODEL_ID;

if (!dbPath || !targetKind || !targetModel) {
  throw new Error("Missing required env for DB routing update");
}

const db = new Database(dbPath);
try {
  db.exec("BEGIN IMMEDIATE");

  const provider = forcedProviderId
    ? db.prepare(
        "SELECT id, kind, enabled FROM provider_profiles WHERE id = ?"
      ).get(forcedProviderId)
    : db.prepare(
        `SELECT id, kind, enabled
         FROM provider_profiles
         WHERE enabled = 1 AND kind = ?
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`
      ).get(targetKind);

  if (!provider) {
    const candidates = db.prepare(
      "SELECT id, kind, enabled, default_model FROM provider_profiles ORDER BY kind, updated_at DESC"
    ).all();
    throw new Error(
      `No enabled provider found for kind '${targetKind}'. Candidates: ${JSON.stringify(candidates)}`
    );
  }
  if (provider.enabled !== 1) {
    throw new Error(`Provider ${provider.id} is disabled`);
  }
  if (forcedProviderId && provider.kind !== targetKind) {
    throw new Error(
      `Forced provider '${provider.id}' kind '${provider.kind}' does not match model provider kind '${targetKind}'`
    );
  }

  db.prepare(
    "UPDATE provider_profiles SET default_model = ?, updated_at = ? WHERE id = ?"
  ).run(targetModel, new Date().toISOString(), provider.id);

  const existingRow = db.prepare(
    "SELECT value_json FROM hub_settings WHERE key = 'llm.routing.v1'"
  ).get();

  let routing = {
    defaultProviderId: provider.id,
    defaultModel: targetModel,
    fallbackProviderIds: [],
  };

  if (existingRow && typeof existingRow.value_json === "string") {
    try {
      const parsed = JSON.parse(existingRow.value_json);
      const fallback = Array.isArray(parsed.fallbackProviderIds)
        ? parsed.fallbackProviderIds.filter((x) => typeof x === "string" && x !== provider.id)
        : [];
      routing = {
        defaultProviderId: provider.id,
        defaultModel: targetModel,
        fallbackProviderIds: fallback,
      };
    } catch {
      // keep default routing object above
    }
  }

  const now = new Date().toISOString();
  const json = JSON.stringify(routing);
  const hasKey = db.prepare("SELECT key FROM hub_settings WHERE key = 'llm.routing.v1'").get();
  if (hasKey) {
    db.prepare(
      `UPDATE hub_settings
       SET value_json = ?, revision = revision + 1, updated_at = ?
       WHERE key = 'llm.routing.v1'`
    ).run(json, now);
  } else {
    db.prepare(
      `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at)
       VALUES ('llm.routing.v1', ?, 1, ?, ?)`
    ).run(json, now, now);
  }

  db.exec("COMMIT");
  process.stdout.write(
    JSON.stringify({
      defaultProviderId: provider.id,
      providerKind: provider.kind,
      defaultModel: targetModel,
      routing,
    }) + "\n"
  );
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
} finally {
  db.close();
}
NODE
fi

log "Restarting Friday runtime"
run_cmd launchctl enable "gui/$UID_VALUE/$FRIDAY_COMPANION_LABEL" >/dev/null 2>&1 || true
run_cmd launchctl kickstart -k "gui/$UID_VALUE/$FRIDAY_COMPANION_LABEL"
run_cmd launchctl enable "gui/$UID_VALUE/$FRIDAY_LABEL" >/dev/null 2>&1 || true
run_cmd launchctl kickstart -k "gui/$UID_VALUE/$FRIDAY_LABEL"
run_cmd launchctl enable "gui/$UID_VALUE/$FRIDAY_UI_LABEL" >/dev/null 2>&1 || true
run_cmd launchctl kickstart -k "gui/$UID_VALUE/$FRIDAY_UI_LABEL" >/dev/null 2>&1 || true

log "Convergence verification"
if [[ "$DRY_RUN" == "true" ]]; then
  log "DRY-RUN: launchctl list | grep -E 'com\\.friday\\.(hub|companion|ui-open)|openclaw|clawdbot'"
else
  launchctl list | grep -E "com\\.friday\\.(hub|companion|ui-open)|openclaw|clawdbot" || true
fi
if [[ "$DRY_RUN" != "true" ]]; then
  DB_PATH="$DB_PATH" node --input-type=commonjs <<'NODE'
const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH);
try {
  const routing = db.prepare("SELECT value_json FROM hub_settings WHERE key = 'llm.routing.v1'").get();
  const setup = db.prepare("SELECT channels_json, network_host, network_port, updated_at FROM friday_setup_state WHERE id='singleton'").get();
  process.stdout.write(`[converge] llm.routing.v1=${routing ? routing.value_json : "<missing>"}\n`);
  process.stdout.write(`[converge] setup.channels_json=${setup ? setup.channels_json : "<missing>"}\n`);
  process.stdout.write(`[converge] setup.network=${setup ? `${setup.network_host}:${setup.network_port}` : "<missing>"}\n`);
} finally {
  db.close();
}
NODE
fi

if [[ "$DRY_RUN" != "true" ]]; then
  log "Backup directory: $BACKUP_DIR"
fi
log "Done."
