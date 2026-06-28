#!/usr/bin/env bash
set -euo pipefail

# ─── AI Workflow Generator E2E Test ───
# Prerequisites:
#   1. Friday server running: npx tsx src/cli/friday-cli.ts start
#   2. At least one BYOK provider configured (Anthropic/OpenAI/Google)
#
# Usage: bash scripts/e2e-workflow-generator.sh [BASE_URL]

BASE_URL="${1:-http://localhost:3141}"
BOLD='\033[1m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
CYAN='\033[36m'
RESET='\033[0m'

log() { echo -e "${CYAN}[$(date +%H:%M:%S)]${RESET} $*"; }
ok()  { echo -e "${GREEN}✅ $*${RESET}"; }
err() { echo -e "${RED}❌ $*${RESET}"; exit 1; }
warn(){ echo -e "${YELLOW}⚠️  $*${RESET}"; }

# ─── Step 0: Health check ───
log "${BOLD}Step 0: Health check${RESET}"
HEALTH=$(curl -sf "${BASE_URL}/v1/health" 2>/dev/null) || err "Server not reachable at ${BASE_URL}. Start Friday first: npx tsx src/cli/friday-cli.ts start"
echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
ok "Server is running"

# ─── Step 1: Login to get auth token ───
log "${BOLD}Step 1: Login${RESET}"

# Try default dev credentials
LOGIN_RESP=$(curl -sf -X POST "${BASE_URL}/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@friday.dev","password":"friday-dev"}' 2>/dev/null) || {
  warn "Default dev login failed. Trying without auth (server may not require it)..."
  TOKEN=""
}

if [ -n "${LOGIN_RESP:-}" ]; then
  TOKEN=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))" 2>/dev/null || echo "")
  if [ -n "$TOKEN" ]; then
    ok "Logged in, got token"
  else
    warn "Login response had no accessToken, trying without auth"
    TOKEN=""
  fi
fi

# Auth header helper
auth_header() {
  if [ -n "${TOKEN:-}" ]; then
    echo "Authorization: Bearer $TOKEN"
  else
    echo "X-No-Auth: true"
  fi
}

# ─── Step 2: Check providers ───
log "${BOLD}Step 2: Check BYOK providers${RESET}"
PROVIDERS=$(curl -sf -H "$(auth_header)" "${BASE_URL}/v1/providers" 2>/dev/null) || warn "Could not list providers"
echo "$PROVIDERS" | python3 -m json.tool 2>/dev/null || echo "${PROVIDERS:-no response}"

PROVIDER_COUNT=$(echo "${PROVIDERS:-[]}" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    items = data if isinstance(data, list) else data.get('providers', data.get('items', []))
    print(len(items))
except:
    print(0)
" 2>/dev/null)

if [ "${PROVIDER_COUNT:-0}" = "0" ]; then
  warn "No providers configured. The workflow generator needs at least one BYOK provider."
  warn "Register one first:"
  echo ""
  echo "  curl -X POST ${BASE_URL}/v1/providers \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -H '$(auth_header)' \\"
  echo "    -d '{"
  echo "      \"kind\": \"anthropic\","
  echo "      \"name\": \"My Anthropic\","
  echo "      \"baseUrl\": \"https://api.anthropic.com\","
  echo "      \"authMode\": \"api-key\","
  echo "      \"api\": \"anthropic-messages\","
  echo "      \"supportedModels\": [\"claude-sonnet-4-6\"],"
  echo "      \"apiKey\": \"sk-ant-xxx\","
  echo "      \"defaultModel\": \"claude-sonnet-4-6\","
  echo "      \"enabled\": true"
  echo "    }'"
  echo ""
  err "Add a provider and re-run this script."
fi
ok "Found ${PROVIDER_COUNT} provider(s)"

# ─── Step 3: Create workflow generation session ───
log "${BOLD}Step 3: Create workflow generation session${RESET}"
SESSION_RESP=$(curl -sf -X POST "${BASE_URL}/v1/workflows/generator/sessions" \
  -H "Content-Type: application/json" \
  -H "$(auth_header)" \
  -d '{
    "goal": "A simple workflow that takes a text input, checks if it is longer than 100 characters, and if so summarizes it using an AI skill, otherwise passes it through unchanged",
    "userId": "e2e-test-user",
    "channel": "cli"
  }') || err "Failed to create session"

echo "$SESSION_RESP" | python3 -m json.tool 2>/dev/null || echo "$SESSION_RESP"

SESSION_ID=$(echo "$SESSION_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
session = data.get('session', {})
print(session.get('sessionId', ''))
" 2>/dev/null)

MODE=$(echo "$SESSION_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('mode', ''))
" 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
  err "No sessionId in response"
fi
ok "Session created: $SESSION_ID (mode: $MODE)"

# ─── Step 4: If clarification needed, submit answers ───
if [ "$MODE" = "clarification_required" ]; then
  log "${BOLD}Step 4: Answering clarification questions${RESET}"
  
  QUESTIONS=$(echo "$SESSION_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for q in data.get('questions', []):
    print(f'  - {q}')
" 2>/dev/null)
  echo "Questions from LLM:"
  echo "$QUESTIONS"

  TURN_RESP=$(curl -sf -X POST "${BASE_URL}/v1/workflows/generator/sessions/${SESSION_ID}/messages" \
    -H "Content-Type: application/json" \
    -H "$(auth_header)" \
    -d '{
      "message": "Use manual trigger. For the AI summarization step, use any available AI skill or a transform step that calls AI. The error policy should be fail_fast with user notification. Input is a single string called text_input. Output should be called result with the final text."
    }') || err "Failed to submit turn"

  echo "$TURN_RESP" | python3 -m json.tool 2>/dev/null || echo "$TURN_RESP"

  MODE=$(echo "$TURN_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('mode', ''))
" 2>/dev/null)

  ok "Turn submitted (mode: $MODE)"

  # If still clarifying, submit one more
  if [ "$MODE" = "clarification_required" ]; then
    log "Still clarifying, submitting more details..."
    TURN_RESP2=$(curl -sf -X POST "${BASE_URL}/v1/workflows/generator/sessions/${SESSION_ID}/messages" \
      -H "Content-Type: application/json" \
      -H "$(auth_header)" \
      -d '{
        "message": "That is all the information. Please proceed with generating the workflow."
      }') || err "Failed to submit second turn"

    MODE=$(echo "$TURN_RESP2" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('mode', ''))
" 2>/dev/null)
    ok "Second turn submitted (mode: $MODE)"
  fi
else
  log "${BOLD}Step 4: Skipped (LLM went straight to generation)${RESET}"
fi

# ─── Step 5: Generate draft (if not already generated) ───
if [ "$MODE" != "preview_ready" ]; then
  log "${BOLD}Step 5: Generate draft${RESET}"
  DRAFT_RESP=$(curl -sf -X POST "${BASE_URL}/v1/workflows/generator/sessions/${SESSION_ID}/generate" \
    -H "Content-Type: application/json" \
    -H "$(auth_header)" \
    -d '{}') || err "Failed to generate draft"

  echo "$DRAFT_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
draft = data.get('draft', {})
spec = draft.get('spec', {})
validation = draft.get('validation', {})
print(f'Workflow: {spec.get(\"name\", \"?\")}')
print(f'Steps: {len(spec.get(\"steps\", []))}')
print(f'Edges: {len(spec.get(\"edges\", []))}')
print(f'Tests: {len(spec.get(\"tests\", []))}')
print(f'Validation OK: {validation.get(\"ok\", False)}')
print(f'Repair attempts: {validation.get(\"repairAttempts\", 0)}')
" 2>/dev/null || echo "$DRAFT_RESP"

  VALID=$(echo "$DRAFT_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('draft', {}).get('validation', {}).get('ok', False))
" 2>/dev/null)

  if [ "$VALID" = "True" ]; then
    ok "Draft generated and valid!"
  else
    warn "Draft generated but has validation issues"
    echo "$DRAFT_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for issue in data.get('draft', {}).get('validation', {}).get('issues', []):
    print(f'  [{issue[\"severity\"]}] {issue[\"code\"]}: {issue[\"message\"]}')
" 2>/dev/null
  fi
else
  log "${BOLD}Step 5: Draft already generated in conversation${RESET}"
  VALID="True"
fi

# ─── Step 6: Get session state ───
log "${BOLD}Step 6: Get session details${RESET}"
GET_RESP=$(curl -sf -H "$(auth_header)" "${BASE_URL}/v1/workflows/generator/sessions/${SESSION_ID}") || warn "Failed to get session"
echo "$GET_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
session = data.get('session', {})
turns = data.get('turns', [])
has_draft = data.get('draft') is not None
print(f'Status: {session.get(\"status\", \"?\")}')
print(f'Turns: {len(turns)}')
print(f'Has draft: {has_draft}')
" 2>/dev/null || echo "${GET_RESP:-no response}"
ok "Session retrieved"

# ─── Step 7: Approve and save (only if valid) ───
if [ "$VALID" = "True" ]; then
  log "${BOLD}Step 7: Approve and save workflow${RESET}"
  APPROVE_RESP=$(curl -sf -X POST "${BASE_URL}/v1/workflows/generator/sessions/${SESSION_ID}/approve" \
    -H "Content-Type: application/json" \
    -H "$(auth_header)") || err "Failed to approve"

  echo "$APPROVE_RESP" | python3 -m json.tool 2>/dev/null || echo "$APPROVE_RESP"

  WORKFLOW_ID=$(echo "$APPROVE_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('workflowId', ''))
" 2>/dev/null)

  ok "Workflow saved! ID: ${WORKFLOW_ID:-unknown}"
else
  log "${BOLD}Step 7: Skipped (draft has validation errors)${RESET}"

  # Cancel instead
  log "Cancelling session..."
  curl -sf -X DELETE "${BASE_URL}/v1/workflows/generator/sessions/${SESSION_ID}" \
    -H "$(auth_header)" > /dev/null 2>&1 || true
  ok "Session cancelled"
fi

# ─── Done ───
echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  E2E Workflow Generator Test Complete  ${RESET}"
echo -e "${BOLD}${GREEN}═══════════════════════════════════════${RESET}"
echo ""
echo "Session ID: $SESSION_ID"
[ -n "${WORKFLOW_ID:-}" ] && echo "Workflow ID: $WORKFLOW_ID"
echo ""
