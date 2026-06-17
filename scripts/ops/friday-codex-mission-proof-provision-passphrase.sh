#!/usr/bin/env bash
#
# Provision the Friday proof passphrase for A12/OG5 dev/test automation.
#
# Default mode stores the passphrase in macOS keychain by letting the `security`
# CLI prompt locally. File mode prompts hidden in this shell and writes a
# current-user-only 0600 file. Do not paste the passphrase into chat.
#
set -euo pipefail

readonly KEYCHAIN_ACCOUNT="${FRIDAY_CODEX_MISSION_PROOF_KEYCHAIN_ACCOUNT:-friday}"
readonly KEYCHAIN_SERVICE="${FRIDAY_CODEX_MISSION_PROOF_KEYCHAIN_SERVICE:-friday-proof-passphrase}"
readonly PASSPHRASE_FILE="${FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_FILE:-${HOME}/.friday/friday-proof-passphrase}"

usage() {
  cat <<'USAGE'
Usage:
  friday-codex-mission-proof-provision-passphrase.sh [--keychain|--file|--check]

Modes:
  --keychain  Store/update the passphrase in macOS keychain (default).
  --file      Store/update an owner-only file at ~/.friday/friday-proof-passphrase
              or FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_FILE.
  --check     Print only present/absent readiness, never the passphrase.

Security:
  Do not pass the passphrase as an argument. Keychain mode leaves prompting to
  `security add-generic-password -w` with -w as the final option. File mode uses
  hidden terminal input and writes mode 0600.
USAGE
}

die() {
  echo "FATAL: $*" >&2
  exit 3
}

check_keychain_present() {
  command -v security >/dev/null 2>&1 \
    && security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w >/dev/null 2>&1
}

check_file_present() {
  if [ ! -f "${PASSPHRASE_FILE}" ]; then
    return 1
  fi

  local perms
  local owner_uid
  local self_uid
  perms="$(stat -f '%Lp' "${PASSPHRASE_FILE}" 2>/dev/null || true)"
  owner_uid="$(stat -f '%u' "${PASSPHRASE_FILE}" 2>/dev/null || true)"
  self_uid="$(id -u)"

  [ "${owner_uid}" = "${self_uid}" ] || return 1
  case "${perms}" in
    400|600) ;;
    *) return 1 ;;
  esac
  [ -s "${PASSPHRASE_FILE}" ] || return 1
}

check_status() {
  if check_keychain_present; then
    echo "keychain: present"
  else
    echo "keychain: absent"
  fi

  if check_file_present; then
    echo "file: present (${PASSPHRASE_FILE})"
  else
    echo "file: absent (${PASSPHRASE_FILE})"
  fi
}

provision_keychain() {
  command -v security >/dev/null 2>&1 || die "macOS security CLI is required for --keychain mode."

  echo "The macOS security CLI will prompt locally for the Friday proof passphrase."
  echo "The passphrase will not be printed by this script."
  security add-generic-password -U -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w

  if check_keychain_present; then
    echo "keychain: present"
  else
    echo "FATAL: keychain item was not readable after provision." >&2
    exit 4
  fi
}

provision_file() {
  local target_dir
  local tmp_file=""
  local first=""
  local second=""

  if [ -L "${PASSPHRASE_FILE}" ]; then
    echo "FATAL: passphrase file path must not be a symlink: ${PASSPHRASE_FILE}" >&2
    exit 4
  fi

  trap 'unset first second; [ -n "${tmp_file:-}" ] && rm -f "${tmp_file}"' EXIT

  target_dir="$(dirname "${PASSPHRASE_FILE}")"
  mkdir -p "${target_dir}"
  chmod 700 "${target_dir}" 2>/dev/null || true

  printf 'Enter Friday proof passphrase for file provision (input hidden): ' >&2
  if ! read -rs first; then
    printf '\n' >&2
    echo "FATAL: failed to read passphrase." >&2
    exit 4
  fi
  printf '\n' >&2
  printf 'Confirm Friday proof passphrase (input hidden): ' >&2
  if ! read -rs second; then
    printf '\n' >&2
    echo "FATAL: failed to read passphrase confirmation." >&2
    exit 4
  fi
  printf '\n' >&2

  if [ -z "${first}" ]; then
    echo "FATAL: empty passphrase." >&2
    exit 4
  fi
  if [ "${first}" != "${second}" ]; then
    echo "FATAL: passphrase confirmation did not match." >&2
    exit 4
  fi

  umask 077
  tmp_file="$(mktemp "${PASSPHRASE_FILE}.tmp.XXXXXX")"
  printf '%s\n' "${first}" > "${tmp_file}"
  chmod 600 "${tmp_file}"
  mv -f "${tmp_file}" "${PASSPHRASE_FILE}"
  unset first second
  tmp_file=""

  if check_file_present; then
    echo "file: present (${PASSPHRASE_FILE})"
  else
    echo "FATAL: passphrase file was not valid after provision." >&2
    exit 4
  fi
}

mode="keychain"
case "${1:-}" in
  ""|--keychain) mode="keychain" ;;
  --file) mode="file" ;;
  --check) mode="check" ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 3
    ;;
esac

case "${mode}" in
  keychain) provision_keychain ;;
  file) provision_file ;;
  check) check_status ;;
esac
