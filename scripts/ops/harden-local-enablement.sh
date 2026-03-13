#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
LEGACY_FILE="${HOME}/.friday/friday.json"

mkdir -p "$(dirname "${ENV_FILE}")"
touch "${ENV_FILE}"

backup_env() {
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  cp "${ENV_FILE}" "${ENV_FILE}.bak.${stamp}"
}

escape_single_quotes() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g"
}

quote_env_value() {
  local raw="$1"
  printf "'%s'" "$(escape_single_quotes "${raw}")"
}

upsert_env() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { found = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      found = 1
      next
    }
    { print }
    END {
      if (!found) {
        print key "=" value
      }
    }
  ' "${ENV_FILE}" > "${tmp}"
  mv "${tmp}" "${ENV_FILE}"
}

get_existing_env_value() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 || true)"
  if [[ -z "${line}" ]]; then
    return 1
  fi
  printf "%s" "${line#*=}"
}

strip_wrapping_quotes() {
  local raw="$1"
  if [[ "${raw}" == \"*\" && "${raw}" == *\" ]]; then
    printf "%s" "${raw:1:${#raw}-2}"
    return 0
  fi
  if [[ "${raw}" == \'*\' && "${raw}" == *\' ]]; then
    printf "%s" "${raw:1:${#raw}-2}"
    return 0
  fi
  printf "%s" "${raw}"
}

load_legacy_discord_token() {
  if [[ ! -f "${LEGACY_FILE}" ]]; then
    return 1
  fi
  jq -r '.channels.discord.token // .channels.discord.botToken // empty' "${LEGACY_FILE}"
}

load_legacy_allowed_users_json() {
  if [[ ! -f "${LEGACY_FILE}" ]]; then
    printf "[]"
    return 0
  fi
  jq -c '.channels.discord.allowedUsers // .channels.discord.allowFrom // []' "${LEGACY_FILE}"
}

mask_secret() {
  local input="$1"
  local len="${#input}"
  if (( len <= 8 )); then
    printf "****"
    return 0
  fi
  printf "%s****%s" "${input:0:4}" "${input:len-4:4}"
}

generate_token_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
  fi
}

build_discord_channels_json() {
  local allowed_users_json="$1"
  jq -cn --argjson allowedUsers "${allowed_users_json}" '
    {
      enabled: true,
      instances: [
        {
          kind: "discord",
          enabled: true,
          token: "$DISCORD_BOT_TOKEN",
          requireMention: false,
          allowedUsers: $allowedUsers
        }
      ]
    }
  '
}

build_mcp_servers_json() {
  jq -cn --arg root "${ROOT_DIR}" '
    [
      {
        id: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", $root],
        cwd: $root,
        timeoutMs: 20000
      }
    ]
  '
}

main() {
  backup_env

  local discord_token="${DISCORD_BOT_TOKEN:-}"
  if [[ -z "${discord_token}" ]]; then
    local existing_discord_raw
    existing_discord_raw="$(get_existing_env_value "DISCORD_BOT_TOKEN" || true)"
    if [[ -n "${existing_discord_raw}" ]]; then
      discord_token="$(strip_wrapping_quotes "${existing_discord_raw}")"
    fi
  fi
  if [[ -z "${discord_token}" ]]; then
    discord_token="$(load_legacy_discord_token || true)"
  fi

  local allowed_users_json
  allowed_users_json="$(load_legacy_allowed_users_json)"

  local token_secret
  token_secret="${FRIDAY_TOKEN_SECRET:-}"
  if [[ -z "${token_secret}" ]]; then
    local existing_token_raw
    existing_token_raw="$(get_existing_env_value "FRIDAY_TOKEN_SECRET" || true)"
    if [[ -n "${existing_token_raw}" ]]; then
      token_secret="$(strip_wrapping_quotes "${existing_token_raw}")"
    fi
  fi
  if [[ -z "${token_secret}" ]]; then
    token_secret="$(generate_token_secret)"
  fi

  local channels_json
  channels_json="$(build_discord_channels_json "${allowed_users_json}")"
  local mcp_servers_json
  mcp_servers_json="$(build_mcp_servers_json)"

  upsert_env "FRIDAY_TOKEN_SECRET" "$(quote_env_value "${token_secret}")"
  upsert_env "FRIDAY_CHANNEL_SECRET_POLICY" "strict"
  upsert_env "FRIDAY_BROWSER_PRESENTATION_MODE" "auto"
  upsert_env "FRIDAY_DESKTOP_ENABLED" "true"
  upsert_env "FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS" "$(quote_env_value "${ROOT_DIR}")"
  upsert_env "FRIDAY_MCP_SERVERS" "$(quote_env_value "${mcp_servers_json}")"

  if [[ -n "${discord_token}" ]]; then
    upsert_env "DISCORD_BOT_TOKEN" "$(quote_env_value "${discord_token}")"
    upsert_env "FRIDAY_CHANNELS_JSON" "$(quote_env_value "${channels_json}")"
  fi

  echo "[enablement][ok] Updated ${ENV_FILE}"
  echo "[enablement][ok] FRIDAY_CHANNEL_SECRET_POLICY=strict"
  echo "[enablement][ok] FRIDAY_BROWSER_PRESENTATION_MODE=auto"
  echo "[enablement][ok] FRIDAY_DESKTOP_ENABLED=true"
  echo "[enablement][ok] FRIDAY_MCP_SERVERS configured (filesystem server)"

  if [[ -n "${discord_token}" ]]; then
    echo "[enablement][ok] FRIDAY_CHANNELS_JSON uses env ref (\$DISCORD_BOT_TOKEN)"
    echo "[enablement][ok] DISCORD_BOT_TOKEN set (masked: $(mask_secret "${discord_token}"))"
  else
    echo "[enablement][warn] Discord token not found in env or legacy config; channel override not set."
  fi
}

main "$@"
