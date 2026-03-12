# RFC: Cross-Program Launch Readiness

**Status:** Draft
**Author:** Friday Platform Team
**Created:** 2026-02-23
**Tickets:** FRI-PLAT-901, FRI-PLAT-902, FRI-PLAT-903, FRI-PLAT-904

---

## 1. Summary

The Cross-Program workstream addresses four cross-cutting concerns that span multiple workstreams and are required for commercial and operational launch readiness:

1. **Product Positioning & Pricing (FRI-PLAT-901)** — SKU tiers, feature gates, usage metering, and pricing model definitions.
2. **Data Governance (FRI-PLAT-902)** — Retention policies, deletion lifecycle, audit exports, and compliance framework mappings (GDPR/CCPA).
3. **Developer Platform (FRI-PLAT-903)** — CLI/SDK templates, package testing framework, reference packages, and developer documentation structure.
4. **Ecosystem Program (FRI-PLAT-904)** — Creator onboarding flows, certification rubrics, trust badges, and marketplace integration.

These concerns integrate with existing modules: SEC (tenant scoping), OBS (audit trail), PKG (package lifecycle), MKT (marketplace listings), and ACC (acceptance testing).

## 2. Motivation

Friday's core platform modules (Rules Engine, NodeRunner, Packaging, Marketplace, Security, Observability, etc.) provide robust technical foundations. However, commercial launch requires several cross-cutting capabilities that no single module owns:

1. **No product tiers.** The platform has no concept of SKU-based feature gating. All tenants have identical access, making freemium, tiered, or enterprise offerings impossible.
2. **No usage metering.** While OBS captures operational metrics, there is no metering model for billing-relevant usage (API calls, agent runs, storage consumption).
3. **No data governance.** Retention policies, deletion lifecycles, and compliance mappings are undefined. Without them, the platform cannot meet GDPR/CCPA requirements.
4. **No developer experience.** Package creation requires reverse-engineering existing packages. There are no templates, no testing framework contract, and no reference implementations.
5. **No ecosystem on-ramp.** Creator onboarding is ad-hoc. There is no certification rubric, no trust signal system, and no structured path from "new creator" to "certified publisher."

This RFC defines the domain models, integration points, and persistence schemas for all four concerns.

## 3. Goals and Non-Goals

### Goals

- **Product tiers defined:** Free, Builder, Operator, Creator, Enterprise — each with explicit feature gate mappings.
- **Usage metering model:** Canonical meter types, quota definitions, and usage record schemas that integrate with OBS metrics and MKT billing.
- **Data retention policies:** Per-object-type, per-tenant configurable retention with soft delete → hard delete → audit-only lifecycle.
- **Compliance mapping:** GDPR and CCPA article-to-capability mappings with evidence requirements.
- **Developer templates:** CLI/SDK template model for agent package scaffolding, integrated with PKG module.
- **Package testing contract:** Test suite definition, execution model, and result schema for pre-publish quality gates.
- **Creator onboarding flow:** Step-based onboarding state machine with prerequisite tracking.
- **Certification rubric:** Requirement categories, scoring model, and badge issuance lifecycle.
- **Trust badge system:** Tiered trust signals (verified, certified, premier) based on certification and track record.
- **SQLite persistence** for all cross-program data.

### Non-Goals (Out of Scope)

- Billing/payment integration (handled by MKT commerce module).
- Stripe or payment processor adapters.
- Frontend UI for tier management, governance dashboards, or developer portals.
- Regional data storage implementation (placeholder fields in schema/types for forward compatibility; enforcement deferred to Phase 2).
- GDPR/CCPA automated enforcement (this phase defines mappings; enforcement is Phase 2).
- CLI/SDK binary distribution (this phase defines the template model; CLI tooling is Phase 2).
- Automated package testing execution (this phase defines the contract; runner is Phase 2).

---

## 4. FRI-PLAT-901: Product Positioning & Pricing

### 4.1 SKU Matrix

Friday defines five product tiers, each targeting a distinct persona:

| Tier | Target Persona | Seat Model | Primary Value |
|------|---------------|------------|---------------|
| **Free** | Individual explorer | Single seat | Try Friday with limited capabilities |
| **Builder** | Individual developer | Single seat | Full agent building, local execution |
| **Operator** | Team lead / ops | Per-seat | Multi-agent orchestration, team workspace |
| **Creator** | Package publisher | Single seat | Marketplace publishing, monetization |
| **Enterprise** | Organization | Per-seat + custom | Tenant isolation, SLAs, custom policies |

### 4.2 Feature Gate Matrix

Feature gates map capabilities to tiers. Each gate has a unique key, a description, and an entitlement per tier (boolean or numeric limit):

| Feature Gate Key | Free | Builder | Operator | Creator | Enterprise |
|-----------------|------|---------|----------|---------|------------|
| `agent.create` | 3 agents | 25 agents | Unlimited | 25 agents | Unlimited |
| `agent.concurrent_runs` | 1 | 5 | 50 | 10 | Custom |
| `workspace.count` | 1 | 3 | 20 | 5 | Unlimited |
| `workspace.members` | 1 | 1 | 25 per ws | 5 per ws | Custom |
| `package.install` | 5 pkgs | Unlimited | Unlimited | Unlimited | Unlimited |
| `package.publish` | ✗ | ✗ | ✗ | Unlimited | Unlimited |
| `marketplace.list` | ✗ | ✗ | ✗ | ✓ | ✓ |
| `marketplace.monetize` | ✗ | ✗ | ✗ | ✓ | ✓ |
| `rules.custom` | 5 rules | Unlimited | Unlimited | Unlimited | Unlimited |
| `observability.retention_days` | 7 | 30 | 90 | 30 | Custom (≤365) |
| `observability.dashboards` | 1 | 5 | Unlimited | 5 | Unlimited |
| `security.rbac` | ✗ | ✗ | ✓ | ✗ | ✓ |
| `security.credential_store` | 3 secrets | 25 | Unlimited | 25 | Unlimited |
| `security.audit_export` | ✗ | ✗ | ✓ | ✗ | ✓ |
| `api.rate_limit_rpm` | 60 | 300 | 1000 | 300 | Custom |
| `support.tier` | Community | Email | Priority | Email | Dedicated |

### 4.3 Usage Metering

Usage meters track billing-relevant consumption. Each meter has a key, unit, and aggregation method:

| Meter Key | Unit | Aggregation | Integration |
|-----------|------|-------------|-------------|
| `agent.runs` | count | sum/period | NodeRunner + OBS |
| `agent.run_duration_ms` | milliseconds | sum/period | NodeRunner + OBS |
| `api.requests` | count | sum/period | API gateway + OBS |
| `storage.bytes` | bytes | max/period | Package store |
| `marketplace.transactions` | count | sum/period | MKT commerce |
| `bandwidth.egress_bytes` | bytes | sum/period | Package downloads |

Usage records are emitted by source modules and aggregated by the metering subsystem. Quotas define per-tier limits with configurable overage policies (hard-block, soft-warn, overage-billing).

### 4.4 Pricing Model Types

| Model | Description | Use Case |
|-------|-------------|----------|
| **Per-seat** | Fixed price per user per billing period | Operator, Enterprise |
| **Usage-based** | Pay-per-use based on meter readings | Agent runs, API calls |
| **Hybrid** | Base seat price + usage overage | Enterprise custom |
| **Flat-rate** | Single price for the tier | Free, Builder, Creator |

Pricing model definitions are stored in the cross-program schema and referenced by the MKT billing integration.

### 4.5 Legal/Compliance Review Checklist

Before a tier goes live, the following must be verified:

- [ ] Terms of Service updated for tier-specific terms
- [ ] Acceptable Use Policy reviewed for usage-based limits
- [ ] Data Processing Agreement (DPA) available for Enterprise tier
- [ ] Privacy Policy reflects metering data collection
- [ ] Refund policy defined per pricing model
- [ ] SLA document published for Operator/Enterprise tiers
- [ ] Tax nexus determination completed for all target jurisdictions
- [ ] Export control classification reviewed (EAR/ITAR if applicable)
- [ ] Accessibility compliance (WCAG 2.1 AA) for tier selection flows
- [ ] Cookie/tracking consent for usage metering telemetry

---

## 5. FRI-PLAT-902: Data Governance

### 5.1 Data Retention Policies

Every persisted object type has a configurable retention policy. Policies are scoped per tenant (with platform defaults):

| Object Type | Default Retention | Configurable Range | Notes |
|-------------|------------------|-------------------|-------|
| Audit entries | 365 days | 90–730 days | Regulatory minimum applies |
| Trace spans | Tier-based (7–90d) | 7–365 days | Based on product tier |
| Agent run logs | 30 days | 7–365 days | Includes input/output |
| Deleted packages | 30 days (soft) | 7–90 days | Before hard delete |
| User sessions | 90 days | 30–365 days | |
| Marketplace transactions | 2555 days (7 yr) | Non-configurable | Tax/legal requirement |
| Billing records | 2555 days (7 yr) | Non-configurable | Tax/legal requirement |
| Credential access logs | 365 days | 90–730 days | Security requirement |

### 5.2 Deletion/Purge Lifecycle

All deletable objects follow a three-phase lifecycle:

```
┌──────────┐     ┌──────────────┐     ┌─────────────┐     ┌─────────────┐
│  Active  │────▶│ Soft Deleted  │────▶│ Hard Deleted │────▶│ Audit-Only  │
└──────────┘     └──────────────┘     └─────────────┘     └─────────────┘
                  │ Restorable    │     │ Data purged   │     │ Metadata    │
                  │ Grace period  │     │ References    │     │ only for    │
                  │ configurable  │     │ nullified     │     │ compliance  │
                  └───────────────┘     └───────────────┘     └─────────────┘
```

**State transitions:**

1. **Active → Soft Deleted:** Object marked with `deleted_at` timestamp. Data remains intact. Excluded from queries by default but restorable.
2. **Soft Deleted → Hard Deleted:** After the retention grace period expires, a background job purges the data. All foreign key references are nullified or cascade-deleted. The object's record is replaced with a tombstone containing only the ID, type, deletion timestamp, and deleting principal.
3. **Hard Deleted → Audit-Only:** The tombstone is retained for the audit retention period. No original data remains. Only the fact of deletion is preserved for compliance audits.

**Deletion request model:**
- Deletion requests are explicit, auditable records (not implicit `DELETE` statements).
- Each request tracks: object type, object ID, requesting principal, reason, scheduled purge date, current state, and completion timestamp.
- Requests can be cancelled during the soft-delete grace period.
- Bulk deletion requests (e.g., "delete all data for tenant X") spawn child requests per object.

### 5.3 Regional Storage Considerations (Phase 2 Prep)

Phase 1 does not implement regional storage or data routing. The schema and domain types include placeholder columns to reduce future migration friction, but **regional governance enforcement is deferred to Phase 2**:

- `storage_region` field on retention policies (nullable, unused in Phase 1).
- `data_residency_requirement` field on retention policies (nullable, unused in Phase 1). Expected values: `none`, `country`, `region`, `custom`.
- `allowed_regions` JSON array on retention policies (nullable, unused in Phase 1).
- `region` field on deletion requests (nullable, unused in Phase 1).

**Note:** These fields are present in the schema and types for forward compatibility but are not validated or enforced in Phase 1. Minor schema migrations may still be required when regional governance is implemented, depending on the final routing architecture.

### 5.4 Audit Export

Operators and compliance teams can export audit data in structured formats:

| Format | Description | Use Case |
|--------|-------------|----------|
| **JSON Lines** | One JSON object per line | Programmatic analysis, SIEM import |
| **CSV** | Tabular export with headers | Spreadsheet analysis, auditor review |
| **Parquet** | Columnar format | Data warehouse import, analytics |

Export configuration:
- **Scheduled exports:** Cron-based (daily, weekly, monthly) with configurable scope (date range, object types, principals).
- **On-demand exports:** Ad-hoc requests with same scoping options.
- **Destination:** Local filesystem path (Phase 1). S3/GCS/Azure Blob destinations in Phase 2.
- **Encryption:** Exports can be encrypted with a tenant-provided public key.
- **Size limits:** Maximum 10M records per export job. Larger scopes are automatically chunked.

### 5.5 GDPR/CCPA Compliance Mapping

| Regulation | Article/Section | Requirement | Friday Capability | Module |
|-----------|----------------|-------------|-------------------|--------|
| GDPR Art. 15 | Right of Access | Data subject can request all their data | Audit export scoped by principal ID | OBS + XPR |
| GDPR Art. 17 | Right to Erasure | Data subject can request deletion | Deletion request → full lifecycle | XPR |
| GDPR Art. 20 | Data Portability | Export in machine-readable format | JSON Lines export | XPR |
| GDPR Art. 25 | Data Protection by Design | Privacy-preserving defaults | Deny-by-default gates, minimal retention | SEC + XPR |
| GDPR Art. 30 | Records of Processing | Maintain processing activity register | Audit trail + compliance mappings | OBS + XPR |
| GDPR Art. 32 | Security of Processing | Appropriate technical measures | Encryption at rest, RBAC, audit | SEC |
| GDPR Art. 33 | Breach Notification | 72-hour notification obligation | Alert pipeline + compliance event type | OBS |
| CCPA §1798.100 | Right to Know | Disclose categories of data collected | Compliance mapping registry | XPR |
| CCPA §1798.105 | Right to Delete | Delete personal information on request | Deletion lifecycle | XPR |
| CCPA §1798.110 | Right to Know (Specific) | Disclose specific pieces of data | Principal-scoped audit export | OBS + XPR |
| CCPA §1798.120 | Right to Opt-Out | Opt out of data sale | Not applicable (Friday does not sell data) | N/A |
| CCPA §1798.125 | Non-Discrimination | Equal service regardless of rights exercise | Feature gates independent of compliance requests | XPR |

### 5.6 Integration Points

- **SEC module:** Tenant scoping ensures retention policies and deletion requests respect tenant boundaries. Deletion of a tenant triggers cascade deletion requests for all tenant-owned objects.
- **OBS module:** Audit trail entries reference compliance framework mappings. Audit export uses OBS query infrastructure for date-range and principal-scoped retrieval.

---

## 6. FRI-PLAT-903: Developer Platform

### 6.1 CLI/SDK Template Structure

Package templates provide scaffolding for common agent package types. Each template defines:

```
template/
├── manifest.template.json    # Pre-filled FridayPackageManifest with placeholders
├── src/
│   ├── skills/               # Skill definition stubs
│   ├── rules/                # Rule policy stubs
│   └── playbooks/            # Playbook template stubs
├── tests/
│   ├── unit/                 # Unit test stubs
│   └── acceptance/           # Acceptance test stubs (ACC integration)
├── README.md.template        # Documentation template
└── .friday/
    └── config.json           # Template metadata and variable definitions
```

**Template categories:**

| Category | Description | Included Assets |
|----------|-------------|----------------|
| `skill_pack` | A collection of skills with no playbooks | Skills + unit tests |
| `workflow_pack` | Playbook-driven workflows | Playbooks + rules + acceptance tests |
| `full_agent` | Complete agent with skills, rules, playbooks | All asset types |
| `provider_plugin` | Integration provider (API, database, etc.) | Provider config + skills |
| `starter` | Minimal hello-world package | Single skill + manifest |

Templates are versioned and stored in the package registry as a special `template` capability type.

### 6.2 Package Testing Framework Contract

The testing framework defines a contract for pre-publish quality validation:

**Test suite structure:**
```typescript
// Conceptual — actual types in friday-cross-program.types.ts
{
  suiteId: "uuid",
  packageName: "@friday/example",
  packageVersion: "1.0.0",
  tests: [
    {
      testId: "uuid",
      name: "skill-invocation-test",
      category: "functional",       // functional | integration | acceptance | performance
      timeout: 30000,               // ms
      inputs: { ... },              // Test inputs
      expectedOutputs: { ... },     // Expected outputs (partial match)
      assertions: [ ... ],          // Assertion rules
    }
  ]
}
```

**Test execution model:**
1. Test suites are declared in the package's `tests/` directory.
2. The `friday test` CLI command discovers and runs all suites.
3. Results are structured as `FridayPackageTestResult` records.
4. Pre-publish hooks in the PKG module can require passing test suites.

**Integration with ACC module:**
- `FridayPackageTestResult` is a discriminated union keyed by `category`. When `category` is `"acceptance"`, the result carries a `FridayXprAcceptanceVerdict` with `verdict` (pass/fail/warn), `severity`, and `evidence` — lossless mapping from `FridayAcceptanceVerdict` in the ACC module.
- Non-acceptance categories (`functional`, `integration`, `performance`) use the standard result shape without verdict/severity.
- The testing framework delegates acceptance-category tests to the ACC engine.

### 6.3 Reference Package Specification

Reference packages serve as canonical examples of best practices:

| Reference Package | Demonstrates |
|------------------|-------------|
| `@friday/ref-skill-pack` | Skill definition, manifest, unit tests |
| `@friday/ref-workflow` | Playbook, rules, acceptance tests, end-to-end flow |
| `@friday/ref-provider` | Provider plugin with credential store integration |
| `@friday/ref-full-agent` | Complete agent: skills + rules + playbooks + tests |

Each reference package includes:
- Complete, runnable source code.
- Inline documentation explaining every design decision.
- Passing test suites demonstrating the testing framework.
- Published to the registry as `reference` capability for discoverability.

### 6.4 Developer Documentation Structure

```
docs/
├── getting-started/
│   ├── quickstart.md              # 5-minute first package
│   ├── concepts.md                # Core concepts overview
│   └── installation.md            # CLI/SDK setup
├── guides/
│   ├── creating-skills.md         # Skill authoring guide
│   ├── writing-rules.md           # Rule policy authoring
│   ├── building-playbooks.md      # Playbook composition
│   ├── testing-packages.md        # Testing framework guide
│   ├── publishing-packages.md     # Registry and marketplace
│   └── provider-plugins.md        # Provider integration
├── reference/
│   ├── manifest-schema.md         # FridayPackageManifest reference
│   ├── cli-commands.md            # CLI command reference
│   ├── api-types.md               # TypeScript type reference
│   └── acceptance-tests.md        # Acceptance test API
├── tutorials/
│   ├── first-skill-pack.md        # Step-by-step skill pack
│   ├── workflow-automation.md     # End-to-end workflow
│   └── marketplace-listing.md    # Publish and monetize
└── changelog.md                   # Version history
```

### 6.5 Integration with PKG Module

- Templates are stored as `FridayPackageRegistryEntry` records with `capability: "template:*"`.
- The `friday init` CLI command reads a `FridayPackageTemplate` and scaffolds a new package directory.
- Test suites reference the PKG manifest for package name/version resolution.
- Reference packages are published through the standard PKG publish pipeline.

---

## 7. FRI-PLAT-904: Ecosystem Program

### 7.1 Creator Onboarding Flow

Creator onboarding follows a step-based state machine:

```
┌────────────┐     ┌────────────┐     ┌────────────┐     ┌────────────┐
│  Registered │────▶│  Profile   │────▶│  Agreement │────▶│  Verified  │
│             │     │  Complete  │     │  Signed    │     │            │
└────────────┘     └────────────┘     └────────────┘     └────────────┘
                                                                │
                                                                ▼
                                                         ┌────────────┐
                                                         │   Active   │
                                                         │  Creator   │
                                                         └────────────┘
```

**Onboarding steps:**

| Step | Name | Prerequisites | Verification |
|------|------|--------------|-------------|
| 1 | `register` | Valid account | Email verified |
| 2 | `profile_complete` | Step 1 | Display name, bio, avatar, links |
| 3 | `agreement_signed` | Step 2 | Creator Agreement + DPA signed |
| 4 | `identity_verified` | Step 3 | Identity verification (email + optional ID) |
| 5 | `first_package` | Step 4 | At least one package published |
| 6 | `active` | Step 5 | Onboarding complete |

**Onboarding state values:** `not_started`, `in_progress`, `completed`, `blocked`, `expired`.

Each step tracks: step ID, status, started at, completed at, evidence (e.g., signed agreement ID), and blocker reason (if blocked).

### 7.2 Certification Rubric

Certification validates that a creator or package meets quality standards:

**Rubric categories:**

| Category | Weight | Requirements |
|----------|--------|-------------|
| **Code Quality** | 25% | Passes all acceptance tests, no critical linter warnings, documented exports |
| **Security** | 25% | Signed package, no known vulnerabilities, minimal permissions |
| **Documentation** | 20% | README, API reference, changelog, usage examples |
| **Reliability** | 15% | Error handling, retry logic, graceful degradation |
| **User Experience** | 15% | Clear configuration, helpful error messages, intuitive defaults |

**Scoring model:**
- Each category has 0–100 sub-score based on specific requirement checks.
- Overall score = weighted sum of category scores.
- Certification thresholds: **Bronze ≥ 60**, **Silver ≥ 75**, **Gold ≥ 90**.
- Certification expires after 12 months or when a major version is published (whichever comes first).

**Requirement types:**
- `automated` — checked by the acceptance testing framework (ACC).
- `manual` — reviewed by a human reviewer or creator self-attestation.
- `metric` — derived from platform metrics (install count, error rate, response time).

### 7.3 Trust Badge System

Trust badges provide visual signals of creator and package quality:

| Badge | Level | Criteria | Displayed On |
|-------|-------|----------|-------------|
| **Verified Creator** | `verified` | Identity verified, agreement signed | Creator profile, all listings |
| **Certified Package** | `certified` | Package passes certification rubric (Bronze+) | Package listing |
| **Top Rated** | `top_rated` | ≥ 4.5 avg rating, ≥ 50 installs | Package listing |
| **Premier Creator** | `premier` | ≥ 3 Gold-certified packages, ≥ 1000 total installs | Creator profile, all listings |
| **Security Audited** | `security_audited` | Passed third-party security audit | Package listing |
| **Official** | `official` | Published by the Friday platform team | Package listing |

**Trust levels (ordered):** `none` → `verified` → `certified` → `premier` → `official`.

Badges are computed by the ecosystem engine and cached. Recomputation occurs on:
- Package publish/update
- Certification completion
- Rating threshold crossings
- Periodic recalculation (daily)

### 7.4 Integration Points

- **MKT module:** Creator onboarding is a prerequisite for `FridayPublisherVerification` in the marketplace. Trust badges are surfaced on `FridayListing` cards.
- **ACC module:** Certification rubric `automated` requirements delegate to the acceptance testing engine. Test results feed into the rubric scoring.
- **PKG module:** Reference packages and templates are published through the standard package lifecycle.

---

## 8. Non-Functional Requirements

| NFR | Target | Measurement |
|-----|--------|-------------|
| Feature gate evaluation latency | p99 < 5ms | In-memory cache with SQLite backing store |
| Usage meter recording throughput | ≥ 10,000 records/sec | Batch insert with WAL mode |
| Deletion lifecycle completion | < 1 hour soft→hard (after grace period) | Background job monitoring |
| Audit export throughput | ≥ 50,000 records/min | Streaming export with chunking |
| Template scaffolding time | < 5 sec | CLI cold-start to files on disk |
| Certification scoring time | < 30 sec per package | Parallel requirement evaluation |
| Trust badge recomputation | < 60 sec for full recalc | Batch query + cache invalidation |
| Data model backwards compatibility | Zero breaking changes in minor versions | Additive-only schema evolution |

---

## 9. Edge Cases

### 9.1 Product & Pricing
- **Tier downgrade with active resources exceeding new limits:** Existing resources are grandfathered (read-only access) but no new resources can be created until within limits. Grace period: 30 days.
- **Usage meter clock skew:** Records with timestamps > 5 minutes in the future are rejected. Records up to 24 hours in the past are accepted for late-arriving events.
- **Mid-billing-period tier change:** Prorated based on day-of-period. Usage meters reset at billing period boundaries.
- **Enterprise custom limits:** Stored as tenant-level overrides. Feature gate evaluation checks tenant override → tier default → platform default (in that order).

### 9.2 Data Governance
- **Deletion of object referenced by other objects:** Foreign key references are nullified (not cascade-deleted) unless explicitly configured for cascade. Orphaned references are logged as audit events.
- **Deletion request during active processing:** The deletion enters a `pending` state and waits for in-flight operations to complete (with a configurable timeout, default 5 minutes).
- **Tenant deletion with active subscriptions:** Subscriptions are cancelled first (triggering MKT refund flow), then tenant deletion proceeds.
- **Audit export of deleted data:** `FridayDeletionTombstone` records are included in exports (controlled by `includeTombstones` scope flag, default true) with `[DELETED]` markers. Original data is not recoverable from exports after hard deletion. Tombstones provide compliance-grade evidence linking the deletion to the requesting principal and deletion request.
- **Conflicting retention policies:** Longer retention wins (conservative approach for compliance safety).

### 9.3 Developer Platform
- **Template version incompatibility with current platform:** The `fridayVersionRange` in the template manifest is checked before scaffolding. Incompatible templates are rejected with a clear error and suggested alternatives.
- **Test suite timeout:** Default 5-minute overall suite timeout. Individual test timeouts are capped at the suite timeout. Timed-out tests are recorded as `error` (not `fail`) with a timeout indicator.
- **Circular template dependencies:** Templates cannot depend on other templates. The scaffolding engine validates this at registration time.

### 9.4 Ecosystem
- **Onboarding step regression:** If a prerequisite becomes invalid (e.g., email no longer verified), the onboarding state machine transitions back to the affected step. All downstream steps are reset to `not_started`.
- **Certification during package update:** A new certification is required for major version bumps. Minor/patch versions inherit the parent certification until expiry.
- **Badge revocation:** If a creator's certified package count drops below the Premier threshold (e.g., a package is deprecated), the badge is revoked at the next recomputation. A 30-day grace period applies.
- **Duplicate onboarding requests:** Idempotent — if the creator already has an active onboarding flow, the existing flow is returned.

---

## 10. Architecture Decision Records

### ADR-001: Feature Gates as Data, Not Code

**Context:** Feature gating can be implemented as compile-time flags, runtime code checks, or data-driven evaluation.

**Decision:** Feature gates are stored as data (`FridayFeatureGate` rows) and evaluated at runtime by a gate evaluation engine. Gate definitions are loaded into an in-memory cache on startup and refreshed on change.

**Rationale:**
- Data-driven gates can be changed without redeployment.
- Tenant-level overrides (Enterprise custom limits) require per-tenant data.
- A/B testing and gradual rollouts are possible with data-driven gates.
- The existing Rules Engine pattern (data-driven evaluation) provides a proven model.

**Consequences:**
- Every feature-gated code path must call the gate evaluation function.
- Gate evaluation must be fast (< 5ms p99) to avoid latency impact.
- Cache invalidation must be reliable (stale gates = wrong access).

### ADR-002: Three-Phase Deletion Over Immediate Purge

**Context:** Data deletion can be immediate (hard delete on request) or phased (soft → hard → audit-only).

**Decision:** All deletions follow the three-phase lifecycle with configurable grace periods.

**Rationale:**
- Soft delete enables undo/recovery for accidental deletions.
- Phased deletion ensures referential integrity is maintained (references are nullified before purge).
- Audit-only tombstones satisfy compliance requirements (proof of deletion).
- Immediate purge risks data loss with no recovery path.

**Consequences:**
- Storage is not immediately reclaimed on deletion.
- Background jobs are required for phase transitions.
- Queries must filter by `deleted_at IS NULL` (or use a view).

### ADR-003: Template-Based Scaffolding Over Code Generation

**Context:** Developer experience can be provided through template-based scaffolding (copy + replace placeholders) or code generation (AST manipulation, code synthesis).

**Decision:** Use template-based scaffolding with variable substitution.

**Rationale:**
- Templates are easy to author, version, and distribute as packages.
- No dependency on language-specific AST tools.
- Templates are inspectable — developers can read the template to understand what they'll get.
- Code generation is brittle and hard to maintain across platform versions.

**Consequences:**
- Templates must be updated for each platform version with breaking manifest changes.
- Complex scaffolding scenarios (conditional sections, loops) require a simple template language.
- Template variables must be well-documented.

### ADR-004: Weighted Rubric Scoring Over Pass/Fail Certification

**Context:** Certification can be binary (pass/fail against a checklist) or scored (weighted rubric with tiers).

**Decision:** Use a weighted rubric with Bronze/Silver/Gold tiers.

**Rationale:**
- Tiered certification rewards incremental quality improvement.
- Weighted categories allow the platform to emphasize security and code quality.
- A single pass/fail threshold discourages investment beyond the minimum.
- Tiers map naturally to trust badges and marketplace prominence.

**Consequences:**
- Scoring logic must be transparent and reproducible.
- Weight changes affect existing certifications (recalculation required).
- Creators may game low-weight categories — weights must be chosen carefully.

---

## 11. Persistence Schema

### 11.1 Product & Pricing Tables

```sql
-- Product tier definitions
CREATE TABLE IF NOT EXISTS product_tiers (
  id          TEXT PRIMARY KEY,
  tier_key    TEXT NOT NULL UNIQUE,  -- 'free', 'builder', 'operator', 'creator', 'enterprise'
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  seat_model  TEXT NOT NULL,         -- 'single', 'per_seat', 'custom'
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Feature gate definitions
-- Domain types use typed discriminated unions (FridayGateValue) keyed by valueType.
-- Row types keep JSON strings for SQLite persistence; mappers deserialize to domain types.
-- Numeric gates: JSON value field is number | null (null = unlimited).
--   isCustom flag indicates enterprise-configurable limits.
CREATE TABLE IF NOT EXISTS feature_gates (
  id              TEXT PRIMARY KEY,
  gate_key        TEXT NOT NULL UNIQUE,  -- 'agent.create', 'workspace.count', etc.
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  value_type      TEXT NOT NULL,         -- 'boolean', 'numeric', 'enum'
  default_value   TEXT NOT NULL,         -- JSON-encoded FridayGateValue
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Feature entitlements: gate × tier matrix
CREATE TABLE IF NOT EXISTS feature_entitlements (
  id          TEXT PRIMARY KEY,
  gate_id     TEXT NOT NULL REFERENCES feature_gates(id),
  tier_id     TEXT NOT NULL REFERENCES product_tiers(id),
  value       TEXT NOT NULL,  -- JSON-encoded FridayGateValue
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(gate_id, tier_id)
);

-- Tenant-level entitlement overrides (Enterprise custom)
CREATE TABLE IF NOT EXISTS feature_entitlement_overrides (
  id          TEXT PRIMARY KEY,
  gate_id     TEXT NOT NULL REFERENCES feature_gates(id),
  tenant_id   TEXT NOT NULL,
  value       TEXT NOT NULL,  -- JSON-encoded FridayGateValue
  reason      TEXT,
  granted_by  TEXT NOT NULL,
  expires_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(gate_id, tenant_id)
);

-- Usage meter definitions
CREATE TABLE IF NOT EXISTS usage_meters (
  id              TEXT PRIMARY KEY,
  meter_key       TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  unit            TEXT NOT NULL,  -- 'count', 'bytes', 'milliseconds'
  aggregation     TEXT NOT NULL,  -- 'sum', 'max', 'avg'
  reset_interval  TEXT NOT NULL,  -- 'hourly', 'daily', 'monthly', 'billing_period'
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Usage quotas: meter × tier limits
-- Domain type uses FridayOverageRate discriminated union keyed by overagePolicy.
-- Row type keeps separate overage_policy + overage_rate (JSON) columns for SQLite.
CREATE TABLE IF NOT EXISTS usage_quotas (
  id              TEXT PRIMARY KEY,
  meter_id        TEXT NOT NULL REFERENCES usage_meters(id),
  tier_id         TEXT NOT NULL REFERENCES product_tiers(id),
  limit_value     INTEGER,            -- NULL = unlimited
  overage_policy  TEXT NOT NULL,       -- 'hard_block', 'soft_warn', 'overage_billing'
  overage_rate    TEXT,                -- JSON: FridayOverageRateBilling fields (if overage_billing)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(meter_id, tier_id)
);

-- Usage records (append-only)
CREATE TABLE IF NOT EXISTS usage_records (
  id          TEXT PRIMARY KEY,
  meter_id    TEXT NOT NULL REFERENCES usage_meters(id),
  tenant_id   TEXT NOT NULL,
  value       REAL NOT NULL,
  recorded_at TEXT NOT NULL,
  period_key  TEXT NOT NULL,  -- e.g. '2026-02' for monthly
  source      TEXT NOT NULL,  -- originating module
  metadata    TEXT,           -- JSON additional context
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_records_tenant_meter_period
  ON usage_records(tenant_id, meter_id, period_key);

-- Pricing model definitions (discriminated union keyed by model_type)
-- CHECK constraints enforce: flat_rate/per_seat → meter_id must be NULL;
--                            usage_based/hybrid → meter_id must be NOT NULL.
CREATE TABLE IF NOT EXISTS pricing_models (
  id                TEXT PRIMARY KEY,
  tier_id           TEXT NOT NULL REFERENCES product_tiers(id),
  model_type        TEXT NOT NULL,     -- 'flat_rate', 'per_seat', 'usage_based', 'hybrid'
  base_price        INTEGER NOT NULL,  -- minor units (e.g. cents)
  currency          TEXT NOT NULL,     -- e.g. 'USD'
  billing_interval  TEXT NOT NULL,     -- 'monthly', 'annual'
  meter_id          TEXT REFERENCES usage_meters(id),  -- required for usage_based/hybrid
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (
    (model_type IN ('flat_rate', 'per_seat') AND meter_id IS NULL)
    OR
    (model_type IN ('usage_based', 'hybrid') AND meter_id IS NOT NULL)
  )
);
```

### 11.2 Data Governance Tables

```sql
-- Retention policy definitions
CREATE TABLE IF NOT EXISTS retention_policies (
  id                          TEXT PRIMARY KEY,
  object_type                 TEXT NOT NULL,
  tenant_id                   TEXT,             -- NULL = platform default
  retention_days              INTEGER NOT NULL,
  min_days                    INTEGER NOT NULL,
  max_days                    INTEGER NOT NULL,
  action                      TEXT NOT NULL,     -- 'soft_delete', 'hard_delete', 'archive', 'audit_only'
  is_configurable             INTEGER NOT NULL DEFAULT 1,
  storage_region              TEXT,             -- future: regional storage
  data_residency_requirement  TEXT,             -- Phase 2: 'none', 'country', 'region', 'custom'
  allowed_regions             TEXT,             -- Phase 2: JSON array of allowed region strings
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

-- Partial unique indexes for retention_policies:
-- Platform defaults (tenant_id IS NULL): one policy per object_type.
-- Tenant overrides (tenant_id IS NOT NULL): one policy per (object_type, tenant_id).
-- A plain UNIQUE(object_type, tenant_id) treats NULLs as distinct, allowing
-- duplicate platform defaults — partial indexes prevent that.
CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_default
  ON retention_policies(object_type) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_tenant
  ON retention_policies(object_type, tenant_id) WHERE tenant_id IS NOT NULL;

-- Retention rules (specific conditions within a policy)
CREATE TABLE IF NOT EXISTS retention_rules (
  id          TEXT PRIMARY KEY,
  policy_id   TEXT NOT NULL REFERENCES retention_policies(id),
  name        TEXT NOT NULL,
  condition   TEXT NOT NULL,  -- JSON expression evaluated against object metadata
  override_days INTEGER,      -- If set, overrides the policy retention_days
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Deletion requests
CREATE TABLE IF NOT EXISTS deletion_requests (
  id              TEXT PRIMARY KEY,
  object_type     TEXT NOT NULL,
  object_id       TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  state           TEXT NOT NULL,  -- 'pending', 'processing', 'completed', 'failed', 'cancelled'
  reason          TEXT NOT NULL,
  requested_by    TEXT NOT NULL,
  parent_request  TEXT REFERENCES deletion_requests(id),  -- for bulk cascades
  scheduled_at    TEXT NOT NULL,   -- when hard delete should execute
  started_at      TEXT,
  completed_at    TEXT,
  error_message   TEXT,
  region          TEXT,            -- Phase 2 regional governance
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deletion_requests_state
  ON deletion_requests(state, scheduled_at);

-- Deletion tombstones: compliance-grade evidence of hard-deleted objects (XPR-FIX-04)
CREATE TABLE IF NOT EXISTS deletion_tombstones (
  id                    TEXT PRIMARY KEY,
  object_type           TEXT NOT NULL,
  object_id             TEXT NOT NULL,
  tenant_id             TEXT NOT NULL,
  lifecycle_phase       TEXT NOT NULL,  -- 'hard_deleted', 'audit_only'
  deletion_request_id   TEXT NOT NULL REFERENCES deletion_requests(id),
  deleted_by            TEXT NOT NULL,
  soft_deleted_at       TEXT NOT NULL,
  hard_deleted_at       TEXT NOT NULL,
  audit_only_at         TEXT,           -- when tombstone transitions to audit-only
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deletion_tombstones_tenant
  ON deletion_tombstones(tenant_id, object_type);

-- Audit exports
CREATE TABLE IF NOT EXISTS audit_exports (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  format          TEXT NOT NULL,  -- 'json_lines', 'csv', 'parquet'
  scope_json      TEXT NOT NULL,  -- JSON: date range, object types, principals
  schedule        TEXT,           -- cron expression (NULL = on-demand)
  encryption_key  TEXT,           -- public key for encrypted export
  state           TEXT NOT NULL,  -- 'pending', 'running', 'completed', 'failed'
  output_path     TEXT,
  record_count    INTEGER,
  file_size_bytes INTEGER,
  started_at      TEXT,
  completed_at    TEXT,
  error_message   TEXT,
  requested_by    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Compliance framework mappings
CREATE TABLE IF NOT EXISTS compliance_frameworks (
  id          TEXT PRIMARY KEY,
  framework   TEXT NOT NULL,  -- 'gdpr', 'ccpa', 'hipaa', 'sox'
  version     TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(framework, version)
);

CREATE TABLE IF NOT EXISTS compliance_mappings (
  id              TEXT PRIMARY KEY,
  framework_id    TEXT NOT NULL REFERENCES compliance_frameworks(id),
  article         TEXT NOT NULL,   -- e.g. 'Art. 17', '§1798.105'
  requirement     TEXT NOT NULL,
  capability      TEXT NOT NULL,   -- Friday capability that satisfies it
  module          TEXT NOT NULL,   -- owning module
  evidence_type   TEXT NOT NULL,   -- 'automated', 'manual', 'audit_trail'
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

### 11.3 Developer Platform Tables

```sql
-- Package templates
CREATE TABLE IF NOT EXISTS package_templates (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  category              TEXT NOT NULL,  -- 'skill_pack', 'workflow_pack', 'full_agent', 'provider_plugin', 'starter'
  description           TEXT NOT NULL,
  version               TEXT NOT NULL,
  registry_id           TEXT REFERENCES package_registry(id),  -- link to PKG registry
  manifest_json         TEXT NOT NULL,  -- template manifest with placeholders
  variables_json        TEXT NOT NULL,  -- variable definitions for placeholder substitution
  files_json            TEXT NOT NULL,  -- file tree structure
  friday_version_range  TEXT NOT NULL,  -- compatible platform version range (aligned with PKG manifest)
  author                TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- Package test suites
CREATE TABLE IF NOT EXISTS package_test_suites (
  id              TEXT PRIMARY KEY,
  package_name    TEXT NOT NULL,
  package_version TEXT NOT NULL,
  suite_name      TEXT NOT NULL,
  tests_json      TEXT NOT NULL,  -- array of test definitions
  timeout_ms      INTEGER NOT NULL DEFAULT 300000,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Package test results
-- When category = 'acceptance', acceptance_verdict_json carries the full
-- FridayXprAcceptanceVerdict (verdict, severity, evidence) for lossless ACC compat.
CREATE TABLE IF NOT EXISTS package_test_results (
  id                      TEXT PRIMARY KEY,
  suite_id                TEXT NOT NULL REFERENCES package_test_suites(id),
  test_name               TEXT NOT NULL,
  category                TEXT NOT NULL,  -- 'functional', 'integration', 'acceptance', 'performance'
  status                  TEXT NOT NULL,  -- 'pass', 'fail', 'error', 'skip'
  duration_ms             INTEGER NOT NULL,
  message                 TEXT,
  evidence_json           TEXT,           -- structured evidence (assertions, outputs)
  acceptance_verdict_json TEXT,           -- JSON FridayXprAcceptanceVerdict (acceptance category only)
  executed_at             TEXT NOT NULL,
  created_at              TEXT NOT NULL
);

-- Reference packages
CREATE TABLE IF NOT EXISTS reference_packages (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  description     TEXT NOT NULL,
  demonstrates    TEXT NOT NULL,  -- what the reference demonstrates
  registry_id     TEXT REFERENCES package_registry(id),
  source_url      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

### 11.4 Ecosystem Tables

```sql
-- Creator onboarding flows
CREATE TABLE IF NOT EXISTS creator_onboarding (
  id              TEXT PRIMARY KEY,
  creator_id      TEXT NOT NULL UNIQUE,
  tenant_id       TEXT NOT NULL,
  state           TEXT NOT NULL,  -- 'not_started', 'in_progress', 'completed', 'blocked', 'expired'
  current_step    TEXT NOT NULL,  -- step key
  started_at      TEXT,
  completed_at    TEXT,
  expires_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Onboarding steps (per-flow)
CREATE TABLE IF NOT EXISTS onboarding_steps (
  id              TEXT PRIMARY KEY,
  onboarding_id   TEXT NOT NULL REFERENCES creator_onboarding(id),
  step_key        TEXT NOT NULL,  -- 'register', 'profile_complete', etc.
  step_order      INTEGER NOT NULL,
  status          TEXT NOT NULL,  -- 'not_started', 'in_progress', 'completed', 'blocked', 'expired'
  prerequisites   TEXT NOT NULL,  -- JSON array of step keys
  evidence_json   TEXT,           -- proof of completion
  blocker_reason  TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(onboarding_id, step_key)
);

-- Certification rubrics
CREATE TABLE IF NOT EXISTS certification_rubrics (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  version         TEXT NOT NULL,
  categories_json TEXT NOT NULL,  -- JSON: category definitions with weights
  thresholds_json TEXT NOT NULL,  -- JSON: badge thresholds (bronze/silver/gold)
  validity_days   INTEGER NOT NULL DEFAULT 365,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(name, version)
);

-- Certifications (issued)
CREATE TABLE IF NOT EXISTS certifications (
  id              TEXT PRIMARY KEY,
  rubric_id       TEXT NOT NULL REFERENCES certification_rubrics(id),
  package_name    TEXT NOT NULL,
  package_version TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  overall_score   REAL NOT NULL,
  category_scores TEXT NOT NULL,  -- JSON: per-category scores
  badge_level     TEXT NOT NULL,  -- 'bronze', 'silver', 'gold'
  issued_at       TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  revocation_reason TEXT,
  certified_by    TEXT NOT NULL,  -- principal or 'system'
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Trust badges
CREATE TABLE IF NOT EXISTS trust_badges (
  id              TEXT PRIMARY KEY,
  badge_type      TEXT NOT NULL,  -- 'verified_creator', 'certified_package', etc.
  subject_type    TEXT NOT NULL,  -- 'creator', 'package'
  subject_id      TEXT NOT NULL,
  trust_level     TEXT NOT NULL,  -- 'none', 'verified', 'certified', 'premier', 'official'
  criteria_json   TEXT NOT NULL,  -- JSON: criteria that were met
  granted_at      TEXT NOT NULL,
  expires_at      TEXT,
  revoked_at      TEXT,
  revocation_reason TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trust_badges_subject
  ON trust_badges(subject_type, subject_id);
```

---

## 12. Cross-Module Integration Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Cross-Program (XPR)                                  │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Product &    │  │    Data      │  │  Developer   │  │  Ecosystem   │   │
│  │  Pricing      │  │  Governance  │  │  Platform    │  │  Program     │   │
│  │  (901)        │  │  (902)       │  │  (903)       │  │  (904)       │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                 │                 │                 │             │
└─────────┼─────────────────┼─────────────────┼─────────────────┼─────────────┘
          │                 │                 │                 │
    ┌─────▼─────┐     ┌────▼────┐      ┌────▼────┐      ┌────▼────┐
    │   SEC     │     │  OBS    │      │  PKG    │      │  MKT    │
    │ (tenant   │     │ (audit  │      │ (package│      │ (listing│
    │  scoping) │     │  trail) │      │  mgmt)  │      │  comm.) │
    └───────────┘     └─────────┘      └─────────┘      └─────────┘
                                                               │
                                                         ┌─────▼─────┐
                                                         │   ACC     │
                                                         │ (accept.  │
                                                         │  testing) │
                                                         └───────────┘
```

**Integration contracts:**

| Source (XPR) | Target Module | Integration Point |
|-------------|--------------|-------------------|
| Product & Pricing | SEC | Tenant tier stored on `FridayTenant`; gate evaluation uses tenant context |
| Product & Pricing | OBS | Usage meter records emitted as OBS metrics |
| Product & Pricing | MKT | Pricing models referenced by marketplace billing |
| Data Governance | SEC | Deletion requests scoped by tenant; cascade on tenant deletion |
| Data Governance | OBS | Audit export queries OBS audit store; retention policies apply to OBS data |
| Developer Platform | PKG | Templates stored as packages; test suites run pre-publish |
| Ecosystem | MKT | Onboarding prerequisite for publisher verification; badges on listings |
| Ecosystem | ACC | Certification rubric delegates automated checks to ACC engine |

---

## 13. Future Considerations

1. **Regional data storage (Phase 2):** Implement data routing based on `storage_region` and `data_residency_requirement`.
2. **Automated compliance enforcement (Phase 2):** GDPR/CCPA request handler that orchestrates deletion lifecycle from subject request to completion.
3. **CLI/SDK distribution (Phase 2):** Package and distribute the `friday` CLI as a standalone binary.
4. **Test runner implementation (Phase 2):** Build the execution engine for `FridayPackageTestSuite` definitions.
5. **Marketplace search ranking integration:** Trust badges and certification scores influence listing ranking algorithms.
6. **A/B testing framework:** Feature gates support percentage-based rollouts for A/B experiments.
7. **Multi-region audit export:** Export directly to cloud storage (S3, GCS, Azure Blob).
