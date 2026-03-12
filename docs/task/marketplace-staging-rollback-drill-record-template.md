> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Marketplace Staging Rollback Drill Record Template

**Drill date (UTC):**  
**Operator:**  
**Environment:** `staging`  
**Git commit:**  
**Related runbook:** `docs/task/marketplace-agent-mvp-runtime-runbook-2026-03-01.md`  
**Automation evidence file:**  

---

## 1. Preconditions

1. Current release candidate deployed to staging.
2. Feature flags baseline captured:
   - `FRIDAY_MARKETPLACE_COMMERCE_ENABLED=`
   - `FRIDAY_MARKETPLACE_INSTALL_REQUIRED=`
   - `FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED=`
3. Baseline integration checks passed.

---

## 2. Drill Scenarios

### Scenario A: Install Gate Rollback

- Action:
  - Set `FRIDAY_MARKETPLACE_INSTALL_REQUIRED=false`.
  - Restart staging service.
- Expected:
  - Entitled listing execution is allowed even when installation record is missing.
- Observed:
  - 
- Result: `PASS | FAIL`
- Start time (UTC):
- End time (UTC):

### Scenario B: Commerce Runtime Rollback

- Action:
  - Set `FRIDAY_MARKETPLACE_COMMERCE_ENABLED=false`.
  - Restart staging service.
- Expected:
  - Marketplace commerce routes unavailable.
  - Non-marketplace runtime remains healthy.
- Observed:
  - 
- Result: `PASS | FAIL`
- Start time (UTC):
- End time (UTC):

### Scenario C: Agent Install Rollback

- Action:
  - Set `FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED=false`.
  - Restart staging service.
- Expected:
  - Agent install attempts fail with `INSTALL_AGENT_ASSET_DISABLED`.
  - Workflow/skill install remains unaffected.
- Observed:
  - 
- Result: `PASS | FAIL`
- Start time (UTC):
- End time (UTC):

---

## 3. Restoration

1. Restore baseline flag values.
2. Restart staging service.
3. Re-run targeted verification checks.

Result: `PASS | FAIL`

---

## 4. Evidence Links

1. CI/job log:
2. Script output (`scripts/ops/marketplace-staging-rollback-drill.sh`):
3. Endpoint probe screenshots/logs:
4. Incident ticket (if any):

---

## 5. Sign-off

- Operator:
- Reviewer:
- Decision: `READY_FOR_RELEASE | BLOCKED`
- Notes:
