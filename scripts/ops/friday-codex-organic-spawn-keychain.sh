#!/usr/bin/env bash
#
# Non-interactive local wrapper for friday-codex-organic-spawn.sh.
#
# It reads the already-provisioned Friday local passphrase from macOS Keychain or an
# owner-only file and streams it over stdin. The passphrase is never printed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly ORGANIC_SCRIPT="${SCRIPT_DIR}/friday-codex-organic-spawn.sh"
readonly KEYCHAIN_ACCOUNT="${FRIDAY_CODEX_MISSION_PROOF_KEYCHAIN_ACCOUNT:-friday}"
readonly KEYCHAIN_SERVICE="${FRIDAY_CODEX_MISSION_PROOF_KEYCHAIN_SERVICE:-friday-proof-passphrase}"
readonly PASSPHRASE_FILE="${FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_FILE:-${HOME}/.friday/friday-proof-passphrase}"

if [ ! -x "${ORGANIC_SCRIPT}" ]; then
  echo "FATAL: organic launcher is not executable: ${ORGANIC_SCRIPT}" >&2
  exit 3
fi

passphrase_file_ok() {
  if [ ! -f "${PASSPHRASE_FILE}" ]; then
    return 1
  fi

  local perms
  local owner_uid
  local self_uid
  perms="$(stat -f '%Lp' "${PASSPHRASE_FILE}" 2>/dev/null || true)"
  owner_uid="$(stat -f '%u' "${PASSPHRASE_FILE}" 2>/dev/null || true)"
  self_uid="$(id -u)"

  if [ "${owner_uid}" != "${self_uid}" ]; then
    echo "FATAL: passphrase file must be owned by the current user: ${PASSPHRASE_FILE}" >&2
    exit 4
  fi
  case "${perms}" in
    400|600) ;;
    *)
      echo "FATAL: passphrase file must be mode 0600 or 0400; got ${perms:-unknown}: ${PASSPHRASE_FILE}" >&2
      exit 4
      ;;
  esac
  if [ ! -s "${PASSPHRASE_FILE}" ]; then
    echo "FATAL: passphrase file is empty: ${PASSPHRASE_FILE}" >&2
    exit 4
  fi

  return 0
}

read_provisioned_passphrase() {
  if command -v security >/dev/null 2>&1 \
    && security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w >/dev/null 2>&1; then
    security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${KEYCHAIN_SERVICE}" -w
    return 0
  fi

  if passphrase_file_ok; then
    sed -n '1p' "${PASSPHRASE_FILE}"
    return 0
  fi

  echo "FATAL: no provisioned proof passphrase found." >&2
  echo "Checked keychain account='${KEYCHAIN_ACCOUNT}' service='${KEYCHAIN_SERVICE}' and file='${PASSPHRASE_FILE}'." >&2
  exit 4
}

PASSPHRASE="$(read_provisioned_passphrase)"
trap 'unset PASSPHRASE' EXIT
if [ -z "${PASSPHRASE}" ]; then
  echo "FATAL: provisioned proof passphrase is empty." >&2
  exit 4
fi

printf '%s\n' "${PASSPHRASE}" \
  | FRIDAY_CODEX_MISSION_PROOF_PASSPHRASE_STDIN=1 "${ORGANIC_SCRIPT}" "$@"
