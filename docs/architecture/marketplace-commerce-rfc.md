# RFC: Friday Marketplace and Commerce

**Status:** Draft (bounded commerce reference, not the primary marketplace truth)
**Author:** Friday Platform Team
**Created:** 2026-02-23
**Tickets:** FRI-PLAT-091, FRI-PLAT-092, FRI-PLAT-093

---

## 1. Summary

The Marketplace and Commerce system describes a bounded creator listing, entitlement, and payout model for marketplace-delivered assets. It provides listing lifecycle management, pricing plans, entitlements, a payout ledger for creator earnings, and billing integration hooks ready for Stripe (or any future provider). The system integrates with the Agent Packaging (PKG) module for package metadata and the Multi-Tenant Security (SEC) module for tenant-scoped listings.

This RFC is **not** the primary source of truth for Friday's public marketplace direction. The active product backbone remains the **skills lifecycle** described in [../current-source-of-truth.md](../current-source-of-truth.md): generate/import -> validate -> install -> enable -> update -> delete -> verify -> source trust. Workflow and agent assets may join that public ecosystem over time, but they are expected to extend the same backbone rather than replace it with commerce-first flows.

Commerce and publisher operations remain a **bounded operator/admin surface**. Public marketplace truth must not present this RFC as if all Friday deployments already ship a consumer-grade commercial store. The primary public marketplace direction is now **skills/workflows/agents first, free-first, declarative-first, creator-support oriented, and request-board capable**, with `0%` platform commission and no escrow, guarantees, or after-sales obligations.

Closeout evidence for that direction is maintained in operator-controlled evidence storage outside the public source tree.

## 2. Motivation

Friday's Agent Packaging system (FRI-PLAT-051–053) provides the build/sign/install lifecycle, but there is no mechanism for creators to **receive support** for their packages or for consumers to **discover, trust, and optionally support** them. Specific gaps:

1. **No listing lifecycle** — packages in the registry have no concept of draft, review, or publish status for commercial distribution.
2. **No creator support path** — there is no way for users to support creators without turning the ecosystem into a purchase-first store.
3. **No entitlements** — there is no mechanism to grant, check, or revoke access for the bounded legacy commerce surface.
4. **No payout accounting** — creators have no visibility into support or commerce earnings, and the platform has no payout ledger.
5. **No billing integration** — there is no abstraction layer for payment processing, webhooks, or refunds.

The Marketplace and Commerce system addresses all five gaps, building on top of the existing PKG and SEC foundations.

## 3. Goals and Non-Goals

### Goals

- Marketplace listing lifecycle: draft → review → published → suspended → archived.
- Creator support plus bounded legacy pricing models.
- Subscription entitlements with grant, check, revoke, renewal, and grace period support.
- Payout ledger with per-transaction earnings tracking, batch payouts, and tax withholding.
- Billing integration abstraction (Stripe-ready) with webhook handling.
- Creator/publisher identity and verification workflow.
- Tenant-scoped listing visibility via SEC module integration.
- SQLite-based persistence for all marketplace data.
- Cursor-based, paginated API for all queries.
- Idempotency keys on all write operations.

### Marketplace Positioning Constraint

- This RFC does **not** replace the canonical skills lifecycle product path.
- Public marketplace evolution should remain **skills-first**, with workflow and agent assets joining the same trust/install/enable backbone.
- Executable package commerce should be treated as a bounded or legacy-oriented surface unless a later source-of-truth update explicitly promotes it.

### Non-Goals (Out of Scope)

- Frontend marketplace UI (separate workstream).
- Actual Stripe API calls (this phase defines the abstraction; Stripe adapter is Phase 2).
- Tax calculation engine (we record withholding amounts; tax computation is delegated to an external service).
- Marketplace search ranking / recommendation algorithms.
- In-app messaging between buyers and sellers.
- Package runtime metering for usage-based billing (metering adapter is Phase 2).

### 3.1 Locked MVP Profile (2026-03)

This RFC supports multiple commercial models, but the current product profile is intentionally narrower for launch safety and faster closure.

- Listing asset types are restricted to `skill`, `workflow`, and `agent`.
- The presence of `workflow` and `agent` asset types does **not** weaken the rule that the skills lifecycle remains the primary public marketplace backbone.
- Public marketplace assets remain **free-first** for this profile; creator support/tips are the primary reward path.
- Personal `skill`, `workflow`, and `agent` request-board flows are connector-only marketplace extensions. They support matching and submission state, but they do not turn Friday into an escrow, warranty, or arbitration platform.
- Platform commission is fixed at `0%` for creator support in this profile.
- Pricing plan types are restricted to `free` and `one_time`.
- `subscription` and `usage_based` paths remain out of the runtime path for this MVP.
- Successful purchase grants install + run entitlement for the buyer tenant.
- Delivery contract is "install and run in buyer environment"; data ownership stays with buyer tenant only.
- Sellers and other tenants do not receive data-plane access after install.
- Execution blueprints for historical marketplace work are private operator evidence, not public source artifacts.

## 4. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           Marketplace & Commerce                          │
│                                                                          │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────────────┐  │
│  │  Listing Engine   │  │ Pricing Engine    │  │  Entitlement Engine   │  │
│  │  ┌────────────┐  │  │  ┌────────────┐  │  │  ┌────────────────┐  │  │
│  │  │ Lifecycle   │  │  │  │ Plan Mgmt  │  │  │  │ Grant / Revoke │  │  │
│  │  │ State Mach. │  │  │  │ Tier Calc  │  │  │  │ Check / Renew  │  │  │
│  │  └─────┬──────┘  │  │  └─────┬──────┘  │  │  └───────┬────────┘  │  │
│  │        │          │  │        │          │  │          │            │  │
│  └────────┼──────────┘  └────────┼──────────┘  └──────────┼────────────┘  │
│           │                      │                        │              │
│  ┌────────▼──────────────────────▼────────────────────────▼────────────┐  │
│  │                     Purchase & Subscription Engine                   │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │  │
│  │  │ Checkout Flow │  │ Sub Lifecycle │  │ Refund / Chargeback     │  │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────────┘  │  │
│  └─────────┼─────────────────┼─────────────────────┼───────────────────┘  │
│            │                 │                      │                     │
│  ┌─────────▼─────────────────▼──────────────────────▼───────────────────┐  │
│  │                        Billing Abstraction Layer                      │  │
│  │  ┌──────────────┐  ┌──────────────────┐  ┌────────────────────────┐ │  │
│  │  │ Billing Events│  │ Webhook Receiver │  │ Payment Method Vault   │ │  │
│  │  └──────┬───────┘  └──────┬───────────┘  └────────────────────────┘ │  │
│  └─────────┼─────────────────┼──────────────────────────────────────────┘  │
│            │                 │                                            │
│  ┌─────────▼─────────────────▼──────────────────────────────────────────┐  │
│  │                          Payout Ledger                                │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │  │
│  │  │ Earnings Log  │  │ Batch Payouts │  │ Tax Withholding Tracker │   │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────────┘   │  │
│  └─────────┼─────────────────┼─────────────────────┼────────────────────┘  │
│            │                 │                      │                     │
│  ┌─────────▼─────────────────▼──────────────────────▼───────────────────┐  │
│  │                        SQLite Persistence                             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌─────────────────────┐          ┌──────────────────────────────────┐   │
│  │ PKG Module (Package │◄────────►│ SEC Module (Tenant Scoping,      │   │
│  │ Registry & Metadata)│          │ RBAC, Audit)                     │   │
│  └─────────────────────┘          └──────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Responsibility |
|---|---|
| **Listing Engine** | Manages listing lifecycle state machine (draft → review → published → suspended → archived) |
| **Pricing Engine** | Manages pricing plans, tiers, and price calculations for listings |
| **Entitlement Engine** | Grants, checks, revokes, and renews entitlements based on purchase/subscription state |
| **Purchase & Subscription Engine** | Manages checkout flow, subscription lifecycle, refunds, and chargebacks |
| **Billing Abstraction Layer** | Provider-agnostic billing interface; emits billing events, receives webhooks, manages payment methods |
| **Payout Ledger** | Tracks per-transaction creator earnings, batches payouts, records tax withholding |
| **SQLite Persistence** | Single persistence layer for all marketplace data |

## 5. Marketplace Listing Lifecycle

### 5.1 Listing State Machine

```
                    ┌──────────┐
                    │  draft    │
                    └─────┬────┘
                          │ submit for review
                    ┌─────▼────┐
              ┌─────│  review   │─────┐
              │     └──────────┘     │
              │ approved              │ rejected (→ back to draft)
        ┌─────▼──────┐         ┌─────▼────┐
        │  published  │         │  draft    │
        └──┬───┬─────┘         └──────────┘
           │   │
           │   │ policy violation / manual
           │   ┌──────▼──────┐
           │   │  suspended   │
           │   └──────┬──────┘
           │          │ reinstate → published
           │          │ (or archive)
           │   ┌──────▼──────┐
           └──►│  archived    │
               └─────────────┘

    Note: published → archived is also a direct transition (creator withdraws).
```

### 5.2 Listing State Transitions

| From | To | Trigger |
|---|---|---|
| `draft` | `review` | Creator submits listing for review |
| `review` | `published` | Reviewer approves listing |
| `review` | `draft` | Reviewer rejects listing (with feedback) |
| `published` | `suspended` | Policy violation or manual suspension |
| `published` | `archived` | Creator withdraws listing |
| `suspended` | `published` | Admin reinstates listing |
| `suspended` | `archived` | Admin or creator archives suspended listing |

### 5.3 Listing Versioning

Each listing has immutable **versions** that capture a snapshot of the listing content at a point in time. When a creator edits a published listing, a new draft version is created; the published version remains live until the new version is approved.

- A listing always has a `currentVersionId` pointing to the active content.
- Version history is retained for audit and rollback.
- Each version references a specific `packageName` + `packageVersion` from the PKG registry.

#### 5.3.1 Version-Level Workflow Status

Each listing version has its own workflow status independent of the parent listing status:

| Version Status | Description |
|---|---|
| `draft` | Version is being edited; not yet submitted for review |
| `in_review` | Version has been submitted for review |
| `approved` | Version has been approved by a reviewer |
| `rejected` | Version has been rejected by a reviewer (with feedback) |

Version status transitions:
- `draft` → `in_review` (creator submits version for review via `versionId`)
- `in_review` → `approved` (reviewer approves; triggers listing publish if applicable)
- `in_review` → `rejected` (reviewer rejects; creator can edit and resubmit)

The `submitListingForReview` and `reviewListing` API endpoints accept a `versionId` field to target a specific version for workflow transitions.

### 5.4 Listing Review

Reviews are modeled as a separate entity linked to a listing version:

- A reviewer (admin or designated reviewer role) can approve or reject a listing version.
- Rejected versions include feedback notes for the creator.
- Approved versions trigger automatic listing state transition: `review → published`.

## 6. Pricing Models

### 6.1 Pricing Plan Types (Discriminated Union)

| Type | Description | Fields |
|---|---|---|
| `free` | No charge; entitlement granted immediately | — |
| `one_time` | Single purchase; perpetual access | `price: FridayMoneyAmount` |
| `subscription` | Recurring payment (monthly or yearly) | `intervalMonths` (1 or 12), `price: FridayMoneyAmount`, `trialDays` |
| `usage_based` | Pay-per-use metered billing | `unitLabel`, `tiers[]` (graduated pricing tiers), `currency: FridayCurrencyCode` |

### 6.2 Pricing Tiers (Usage-Based)

Usage-based pricing uses graduated tiers:

```
Tier 1: 0–1,000 units   → $0.01/unit
Tier 2: 1,001–10,000    → $0.008/unit
Tier 3: 10,001+         → $0.005/unit
```

Each tier specifies `upToUnits` (null for the final unbounded tier) and `pricePerUnitCents`.

### 6.3 Price Change Policy for Existing Subscribers

When a creator changes the price of a subscription plan:

- **Existing subscribers** continue at their current price until their next renewal.
- At renewal, they transition to the new price with a **30-day notice** (via billing event).
- If the subscriber cancels before renewal, they keep access until the end of the current period.
- If the price decreases, existing subscribers get the lower price at their next renewal (no notice required).

### 6.4 Free-to-Paid Conversion

When a listing transitions from free to paid:

- Existing users who acquired the free entitlement retain access indefinitely (grandfathered).
- New users must purchase/subscribe at the new price.
- The listing version captures the pricing change, and the old free entitlements are marked `grandfathered: true`.

## 7. Subscription Entitlements

### 7.1 Entitlement Lifecycle

```
    ┌────────────┐
    │   granted   │
    └─────┬──────┘
          │ subscription active / purchase complete
    ┌─────▼──────┐
    │   active    │
    └──┬───┬─────┘
       │   │ payment failed
       │   ┌─────▼──────┐
       │   │   grace     │ (grace period: 7 days default)
       │   └─────┬──────┘
       │         │ payment recovered → active
       │         │ grace expired
       │   ┌─────▼──────┐
       │   │  suspended  │
       │   └─────┬──────┘
       │         │ payment recovered → active
       │         │ admin/auto revoke
       │   ┌─────▼──────┐
       └──►│  revoked    │
           └─────┬──────┘
                 │ re-purchase / re-subscribe
           ┌─────▼──────┐
           │  expired    │ (terminal for one-time with expiry / cancelled sub)
           └─────────────┘
```

### 7.2 Entitlement Check

The entitlement check is a synchronous, low-latency operation:

1. Look up entitlement by `(tenantId, listingId)` or `(tenantId, packageName)`.
2. Check entitlement status is `active` or `grace`.
3. Check expiry (`expiresAt > now`).
4. Return `{ entitled: true/false, reason, expiresAt, gracePeriodEndsAt }`.

**Performance target:** Entitlement check must complete in < 5 ms (p99) using indexed SQLite lookup.

### 7.3 Renewal

- Subscriptions auto-renew at the end of each billing period.
- A billing event (`subscription.renewed`) triggers entitlement extension.
- If payment fails, the entitlement enters `grace` status for 7 days (configurable).
- If payment succeeds during grace, the entitlement is restored to `active`.
- If grace expires, the entitlement transitions to `suspended`, then `revoked` after 30 days.

### 7.4 Grace Period

- Default grace period: 7 days after payment failure.
- During grace, the entitlement remains `active` for the end user (no service interruption).
- The billing system retries payment according to the provider's dunning schedule.
- Grace period length is configurable per pricing plan.

## 8. Payout Ledger

### 8.1 Earnings Tracking

Every completed purchase generates a **payout entry** in the ledger:

- `grossAmount: FridayMoneyAmount` — total amount charged to the buyer.
- `platformFee: FridayMoneyAmount` — platform's commission (fixed at 0% for the creator-support-first profile; bounded legacy commerce may still persist the field for compatibility).
- `netAmount: FridayMoneyAmount` — creator's earnings (gross − platform fee).
- `taxWithholding: FridayMoneyAmount` — amount withheld for tax purposes.

All monetary fields use `FridayMoneyAmount` (`{ amount: FridayAmountCents, currency: FridayCurrencyCode }`), co-locating the integer-cents value with its currency. SQLite row types store these as split `_cents INTEGER` + `currency TEXT` columns; the `fridayMoney()` / `fridayMoneyCents()` / `fridayMoneyCurrency()` helpers define the mapping boundary.

### 8.2 Payout Schedule

- Payouts are batched on a configurable schedule (default: monthly, on the 1st).
- A payout batch aggregates all pending payout entries for a publisher.
- Minimum payout threshold: $50 USD equivalent (configurable). Below-threshold earnings roll over.
- Payout entry statuses: `pending` → `processing` → `completed` / `failed` / `clawed_back`.
- Payout batch statuses: `pending` → `processing` → `completed` / `failed`.

### 8.3 Tax Withholding

- Tax withholding rates are set per publisher based on their tax profile.
- Default withholding: 0% for verified publishers with valid tax forms; configurable fallback rate (e.g., 24% for US backup withholding).
- The system records the withholding amount per payout entry; actual tax remittance is out of scope (handled by finance).

### 8.4 Currency Handling and Financial Precision

- All domain-level monetary amounts are represented using the `FridayMoneyAmount` type: `{ amount: FridayAmountCents, currency: FridayCurrencyCode }`.
- `FridayAmountCents` is a branded integer type (`number & { __brand?: "FridayAmountCents" }`) — always an integer in the smallest currency unit (e.g., cents for USD/EUR). No floating-point values are stored or transmitted.
- `FridayCurrencyCode` is a branded string type (`string & { __brand?: "FridayCurrencyCode" }`) enforcing ISO 4217 at the type level.
- **Row ↔ domain mapping boundary:** SQLite row types store monetary values as split `_cents INTEGER` + `currency TEXT` columns. The helper functions `fridayMoney(cents, currency)`, `fridayMoneyCents(money)`, and `fridayMoneyCurrency(money)` define the explicit conversion boundary between persistence and domain layers.
- API DTOs use `FridayMoneyAmountDto` (`{ amount: number, currency: string }`) — the unbranded equivalent for JSON serialization.
- Currency conversion is not performed by the marketplace; all amounts are in the listing's declared currency.
- Multi-currency support: a listing declares its currency at creation; buyers pay in that currency.

#### 8.4.1 Deterministic Fee Rounding

Platform fee calculations use **banker's rounding (half-even)** for deterministic, bias-free results:

- When splitting a gross amount into platform fee and net payout, the platform fee is computed as `grossAmount.amount × feeBps / 10000`.
- If the result is exactly halfway between two integers (e.g., 2.5), it rounds to the nearest **even** integer (2 in this case).
- This eliminates systematic rounding bias that would accumulate over thousands of transactions.
- All fee calculations are performed in integer arithmetic after applying the rounding rule.
- Reconciliation checks verify that `grossAmount = platformFee + netAmount` for every payout entry (with tax withholding accounted separately).

### 8.5 Payout Reconciliation

- Every payout batch includes a reconciliation check: sum of `netAmount.amount` for all entries in the batch must equal the batch `totalAmount.amount`.
- Mismatch tolerance: < 0.1% (NFR target).
- Reconciliation failures block the batch and raise an alert.

## 9. Billing Integration Hooks

### 9.1 Billing Abstraction

The billing layer is provider-agnostic, exposing a common interface exported from `marketplace/model`:

```typescript
interface FridayBillingProvider {
  readonly name: string;
  createCheckoutSession(params: FridayBillingCheckoutParams): Promise<FridayBillingCheckoutResult>;
  createSubscription(params: FridayBillingSubscriptionParams): Promise<FridayBillingSubscriptionResult>;
  cancelSubscription(externalSubscriptionId: string): Promise<void>;
  refundPayment(externalPaymentId: string, amount?: FridayMoneyAmount): Promise<FridayBillingRefundResult>;
  getPaymentMethod(externalMethodId: string): Promise<FridayBillingPaymentMethodResult>;
}
```

All parameter and result types (`FridayBillingCheckoutParams`, `FridayBillingCheckoutResult`, `FridayBillingSubscriptionParams`, `FridayBillingSubscriptionResult`, `FridayBillingRefundResult`, `FridayBillingPaymentMethodResult`) are exported from `marketplace/model` alongside the `FridayBillingProvider` interface.

Phase 1 defines the **types, event contracts, and provider interface**. Phase 2 implements the Stripe adapter.

### 9.2 Billing Events

All billing state changes are captured as `FridayBillingEvent` records:

| Event Type | Trigger |
|---|---|
| `checkout.completed` | Buyer completes checkout |
| `checkout.abandoned` | Buyer abandons checkout (timeout or explicit cancel) |
| `payment.succeeded` | Payment charge succeeds |
| `payment.failed` | Payment charge fails |
| `subscription.created` | New subscription created |
| `subscription.renewed` | Subscription renewed at period end |
| `subscription.cancelled` | Subscription cancelled by buyer or admin |
| `subscription.paused` | Subscription paused |
| `subscription.resumed` | Subscription resumed after pause |
| `refund.initiated` | Refund initiated |
| `refund.completed` | Refund completed |
| `chargeback.opened` | Chargeback dispute opened |
| `chargeback.won` | Chargeback resolved in platform's favor |
| `chargeback.lost` | Chargeback resolved in buyer's favor |
| `payout.initiated` | Payout batch initiated |
| `payout.completed` | Payout batch completed |
| `payout.failed` | Payout batch failed |

### 9.3 Webhook Handling

External billing providers deliver events via webhooks:

- Each webhook has a `provider`, `externalId`, `eventType`, `payload` (JSON), and `signature`.
- Webhook processing is idempotent: duplicate delivery is detected via `externalId`.
- Failed webhook processing is retried with exponential backoff (via the Retry Engine).
- Webhook signature verification is mandatory before processing.

## 10. Creator/Publisher Identity and Verification

### 10.1 Publisher Profile

Every creator who wants to sell on the marketplace must create a **publisher profile**:

- Display name, bio, avatar URL, website URL.
- Contact email (verified).
- Linked to a `tenantId` and `principalId` from the SEC module.

### 10.2 Verification Workflow

Publishers must be verified before receiving payouts:

| Verification Level | Requirements | Capabilities |
|---|---|---|
| `unverified` | Publisher profile created | Can create draft listings; cannot publish |
| `pending` | Submitted tax forms and identity documents | Awaiting review |
| `verified` | Identity and tax forms approved | Can publish listings and receive payouts |
| `suspended` | Flagged for policy violation | Cannot publish; existing listings suspended |

### 10.3 Verification Fields

- `legalName` — legal entity name.
- `taxId` — tax identification number (encrypted at rest, stored as last-4 for display).
- `country` — ISO 3166-1 alpha-2 country code.
- `payoutMethod` — how the creator receives payouts (bank transfer, etc.).

## 11. Integration with Existing Modules

### 11.1 PKG (Agent Packaging) Integration

- Listings reference `packageName` and `packageVersion` from the PKG registry (`package_registry` table).
- A listing cannot be published if the referenced package version does not exist or has been deleted.
- When a package version is deprecated in PKG, the listing version referencing it is flagged for update.

### 11.2 SEC (Multi-Tenant Security) Integration

- Listings are tenant-scoped: a listing's `tenantId` determines which tenants can see it.
- Global listings (`tenantId = null`) are visible to all tenants.
- Entitlement checks use the SEC module's tenant context to scope queries.
- All marketplace operations emit audit log entries via the SEC audit system.

### 11.3 Required Scopes

| Operation | Required Scope |
|---|---|
| Create/edit listing (own) | `marketplace.listing.write` |
| Submit listing for review | `marketplace.listing.write` |
| Review/approve listing | `marketplace.listing.review` |
| Suspend/reinstate listing | `marketplace.listing.admin` |
| View published listings | `marketplace.listing.read` |
| Purchase / subscribe | `marketplace.purchase.write` |
| Check entitlement | `marketplace.entitlement.read` |
| View own purchases | `marketplace.purchase.read` |
| View payout reports (own) | `marketplace.payout.read` |
| Manage payouts (admin) | `marketplace.payout.admin` |
| Manage publisher profile | `marketplace.publisher.write` |
| Review publisher verification | `marketplace.publisher.admin` |

## 12. Edge Cases

| Edge Case | Handling |
|---|---|
| **Refund after payout** | A negative payout entry is created to claw back the creator's earnings. If the creator's balance goes negative, the amount is deducted from the next payout batch. |
| **Chargeback** | Entitlement is immediately suspended. If chargeback is won, entitlement is restored. If lost, entitlement is revoked and a negative payout entry is created. Platform chargeback fee is passed to the creator. |
| **Price increase for existing subscribers** | Existing subscribers keep their current price until renewal. At renewal, they are notified 30 days in advance. If they don't cancel, the new price applies. |
| **Price decrease for existing subscribers** | New lower price applies at next renewal; no notice required. |
| **Free-to-paid conversion** | Existing free users are grandfathered. New users must pay. Grandfathered entitlements are marked and never expire. |
| **Paid-to-free conversion** | All active entitlements remain. Existing subscribers continue until end of period. No new charges. |
| **Abandoned purchase** | Checkout sessions expire after 30 minutes. A `checkout.abandoned` billing event is emitted. No entitlement is granted. |
| **Currency conversion** | Not performed by the marketplace. Listings declare a single currency. Buyer pays in that currency. Cross-currency support is Phase 2. |
| **Payout below threshold** | Earnings roll over to the next payout period. Displayed in earnings summary as `pendingPayout: FridayMoneyAmount`. |
| **Publisher verification revoked** | All listings transition to `suspended`. Pending payouts are held. |
| **Listing references deleted package** | Listing cannot transition to `published`. If already published and package is deleted, listing is auto-suspended. |
| **Concurrent purchase + refund** | Refund is processed with idempotency key. If purchase is still in progress, refund is queued. Entitlement state machine prevents double-grant. |
| **Subscription renewal during grace period** | If payment succeeds during grace, entitlement restored to `active`. Grace period timer is cancelled. |
| **Duplicate webhook delivery** | Deduplicated via `externalId`. Second delivery returns 200 OK without re-processing. |

## 13. Non-Functional Requirements

| Requirement | Target | Measurement |
|---|---|---|
| **Listing publish success rate** | > 99% | Ratio of successful publish transitions to total publish attempts over 30-day window |
| **Entitlement check accuracy** | 100% | Entitlement check must never return a false positive or false negative (correctness verified via reconciliation job) |
| **Entitlement check latency (p99)** | < 5 ms | Indexed SQLite lookup by `(tenant_id, listing_id)` |
| **Payout reconciliation mismatch** | < 0.1% | Sum of individual `netAmount.amount` vs. batch `totalAmount.amount` |
| **Purchase checkout latency (p95)** | < 2 s | From checkout initiation to billing provider redirect |
| **Webhook processing latency (p95)** | < 500 ms | From webhook receipt to billing event persistence |
| **Listing query latency (p95)** | < 20 ms | Cursor-based paginated query with up to 50,000 listings |
| **Payout batch processing time** | < 60 s | For up to 10,000 pending payout entries per batch |
| **Idempotency key TTL** | 24 hours | Write operations are idempotent within this window |
| **Billing event delivery guarantee** | At-least-once | Webhooks are retried with exponential backoff; deduplication via `externalId` |

## 14. Architecture Decision Records (ADRs)

### ADR-001: Cents-Based Integer Arithmetic Over Floating-Point for Monetary Values

**Context:** Monetary values must be precise. Floating-point arithmetic introduces rounding errors that compound across thousands of transactions.

**Decision:** All monetary amounts are stored and computed as integers in the smallest currency unit (cents for USD/EUR), wrapped in the `FridayMoneyAmount` type (`{ amount: FridayAmountCents, currency: FridayCurrencyCode }`). `FridayAmountCents` and `FridayCurrencyCode` are branded types for compile-time safety. Fee splitting uses banker's rounding (half-even) for deterministic results.

**Consequences:**
- (+) No floating-point rounding errors.
- (+) Exact reconciliation — sum of parts always equals the whole.
- (+) Simple integer arithmetic for splits, fees, and aggregations.
- (+) Currency always co-located with the amount — no orphaned `currency` fields.
- (+) Banker's rounding eliminates systematic bias across thousands of transactions.
- (−) Display layer must convert cents to human-readable format (acceptable — standard practice).

### ADR-002: Discriminated Union for Pricing Plans Over Polymorphic Class Hierarchy

**Context:** Pricing plans have fundamentally different shapes (free has no price, usage-based has tiers, subscription has intervals). Need a type-safe representation.

**Decision:** Model `FridayPricingPlan` as a TypeScript discriminated union keyed on `type: "free" | "one_time" | "subscription" | "usage_based"`. Each variant carries only the fields relevant to that pricing model.

**Consequences:**
- (+) Exhaustive switch/case handling enforced by TypeScript compiler.
- (+) No nullable "god object" with optional fields for every pricing model.
- (+) Clean serialization — `type` field serves as both discriminator and persistence marker.
- (−) Adding a new pricing model requires updating the union (acceptable — pricing models change rarely).

### ADR-003: Separate Entitlement Table Over Deriving Entitlements from Purchases

**Context:** Entitlements could be computed on-the-fly from purchase/subscription records, or stored as first-class entities.

**Decision:** Store entitlements as a separate `marketplace_entitlements` table with explicit status and expiry fields.

**Consequences:**
- (+) O(1) entitlement checks via indexed lookup — no joins or computation.
- (+) Entitlements can be granted/revoked independently of purchase flow (admin overrides, gifting, trials).
- (+) Clear audit trail — entitlement state transitions are explicit.
- (−) Must keep entitlements in sync with purchase/subscription state (handled by billing event processing).

### ADR-004: Provider-Agnostic Billing Abstraction Over Direct Stripe Integration

**Context:** The marketplace needs payment processing. Stripe is the initial target, but vendor lock-in should be avoided.

**Decision:** Define a `BillingProvider` interface and billing event types that are provider-agnostic. Phase 1 defines types and events only; Phase 2 implements the Stripe adapter.

**Consequences:**
- (+) Can switch billing providers without rewriting core marketplace logic.
- (+) Billing events form a complete audit trail independent of provider.
- (+) Testable without live payment processing (mock provider for tests).
- (−) Additional abstraction layer adds complexity (acceptable — prevents vendor lock-in).

### ADR-005: Monthly Payout Batching Over Real-Time Payouts

**Context:** Creator payouts could be instant (per-transaction) or batched (periodic).

**Decision:** Batch payouts monthly with a configurable minimum threshold ($50 USD equivalent). Individual payout entries are recorded per transaction; payout batches aggregate them.

**Consequences:**
- (+) Reduces payment processing costs (fewer transactions).
- (+) Simplifies reconciliation (batch-level checks).
- (+) Allows clawback for refunds/chargebacks before payout.
- (−) Creators must wait up to 30 days for earnings (acceptable — industry standard for marketplaces).

### ADR-006: Idempotency Keys Scoped to (Principal, Operation, Key) Over Global Key Uniqueness

**Context:** Marketplace write operations (purchase, subscribe, refund) must be idempotent to handle retries safely. Same pattern as PKG module.

**Decision:** Idempotency keys are scoped to `(principal_id, operation, key)` with a 24-hour TTL. Same payload hash returns cached response; different payload hash returns 409 conflict.

**Consequences:**
- (+) Consistent with PKG module's idempotency pattern.
- (+) Different principals can use the same key string independently.
- (+) Bounded storage with automatic expiry.
- (−) 24-hour window means operations cannot be replayed after expiry (acceptable).

### ADR-007: Listing Versioning with Immutable Snapshots Over In-Place Edits

**Context:** When a creator updates a published listing (description, screenshots, pricing), the change must go through review. The published version must remain live during review.

**Decision:** Each listing has immutable **versions** (content snapshots). Edits create a new draft version; the current published version remains live until the new version is approved.

**Consequences:**
- (+) Published listing is always stable — no partial edits visible to buyers.
- (+) Full version history for audit and rollback.
- (+) Review workflow operates on a specific version snapshot.
- (−) More storage than in-place edits (acceptable — text content is small).

## 15. SQLite Schema

```sql
-- ═══════════════════════════════════════════════════════════════
-- PUBLISHERS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_publishers (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  principal_id      TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  bio               TEXT,
  avatar_url        TEXT,
  website_url       TEXT,
  contact_email     TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK(verification_status IN ('unverified', 'pending', 'verified', 'suspended')),
  legal_name        TEXT,
  tax_id_last4      TEXT,
  country           TEXT,
  payout_method     TEXT,
  platform_fee_bps  INTEGER NOT NULL DEFAULT 3000,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(tenant_id, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_publishers_tenant
  ON marketplace_publishers(tenant_id);

CREATE INDEX IF NOT EXISTS idx_marketplace_publishers_status
  ON marketplace_publishers(verification_status);

-- ═══════════════════════════════════════════════════════════════
-- LISTINGS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id                  TEXT PRIMARY KEY,
  publisher_id        TEXT NOT NULL REFERENCES marketplace_publishers(id),
  slug                TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft', 'review', 'published', 'suspended', 'archived')),
  current_version_id  TEXT,
  pending_version_id  TEXT,
  tenant_id           TEXT,
  tags_json           TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_publisher
  ON marketplace_listings(publisher_id);

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_status
  ON marketplace_listings(status) WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_tenant
  ON marketplace_listings(tenant_id) WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_slug
  ON marketplace_listings(slug);

-- ═══════════════════════════════════════════════════════════════
-- LISTING VERSIONS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_listing_versions (
  id                TEXT PRIMARY KEY,
  listing_id        TEXT NOT NULL REFERENCES marketplace_listings(id),
  version_number    INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft', 'in_review', 'approved', 'rejected')),
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  long_description  TEXT,
  screenshot_urls_json TEXT NOT NULL DEFAULT '[]',
  package_name      TEXT NOT NULL,
  package_version   TEXT NOT NULL,
  pricing_plan_json TEXT NOT NULL,
  release_notes     TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE(listing_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listing_versions_listing
  ON marketplace_listing_versions(listing_id);

-- ═══════════════════════════════════════════════════════════════
-- LISTING REVIEWS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_listing_reviews (
  id                TEXT PRIMARY KEY,
  listing_id        TEXT NOT NULL REFERENCES marketplace_listings(id),
  version_id        TEXT NOT NULL REFERENCES marketplace_listing_versions(id),
  reviewer_id       TEXT NOT NULL,
  decision          TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
  notes             TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listing_reviews_listing
  ON marketplace_listing_reviews(listing_id);

CREATE INDEX IF NOT EXISTS idx_marketplace_listing_reviews_version
  ON marketplace_listing_reviews(version_id);

-- ═══════════════════════════════════════════════════════════════
-- PRICING PLANS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_pricing_plans (
  id                TEXT PRIMARY KEY,
  listing_id        TEXT NOT NULL REFERENCES marketplace_listings(id),
  type              TEXT NOT NULL CHECK(type IN ('free', 'one_time', 'subscription', 'usage_based')),
  currency          TEXT,
  price_amount_cents INTEGER,
  interval_months   INTEGER,
  trial_days        INTEGER,
  unit_label        TEXT,
  tiers_json        TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_pricing_plans_listing
  ON marketplace_pricing_plans(listing_id) WHERE is_active = 1;

-- ═══════════════════════════════════════════════════════════════
-- PURCHASES
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_purchases (
  id                TEXT PRIMARY KEY,
  buyer_tenant_id   TEXT NOT NULL,
  buyer_principal_id TEXT NOT NULL,
  listing_id        TEXT NOT NULL REFERENCES marketplace_listings(id),
  listing_version_id TEXT NOT NULL REFERENCES marketplace_listing_versions(id),
  pricing_plan_id   TEXT NOT NULL REFERENCES marketplace_pricing_plans(id),
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'completed', 'failed', 'refunded', 'disputed')),
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  external_payment_id TEXT,
  idempotency_key   TEXT,
  completed_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_buyer
  ON marketplace_purchases(buyer_tenant_id, buyer_principal_id);

CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_listing
  ON marketplace_purchases(listing_id);

CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_status
  ON marketplace_purchases(status);

CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_idempotency
  ON marketplace_purchases(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════
-- SUBSCRIPTIONS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_subscriptions (
  id                  TEXT PRIMARY KEY,
  purchase_id         TEXT NOT NULL REFERENCES marketplace_purchases(id),
  buyer_tenant_id     TEXT NOT NULL,
  buyer_principal_id  TEXT NOT NULL,
  listing_id          TEXT NOT NULL REFERENCES marketplace_listings(id),
  pricing_plan_id     TEXT NOT NULL REFERENCES marketplace_pricing_plans(id),
  status              TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'past_due', 'paused', 'cancelled', 'expired')),
  current_period_start TEXT NOT NULL,
  current_period_end   TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  cancelled_at        TEXT,
  external_subscription_id TEXT,
  trial_ends_at       TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_subscriptions_buyer
  ON marketplace_subscriptions(buyer_tenant_id, buyer_principal_id);

CREATE INDEX IF NOT EXISTS idx_marketplace_subscriptions_listing
  ON marketplace_subscriptions(listing_id);

CREATE INDEX IF NOT EXISTS idx_marketplace_subscriptions_status
  ON marketplace_subscriptions(status) WHERE status IN ('active', 'past_due');

-- ═══════════════════════════════════════════════════════════════
-- ENTITLEMENTS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_entitlements (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  principal_id      TEXT NOT NULL,
  listing_id        TEXT NOT NULL REFERENCES marketplace_listings(id),
  package_name      TEXT NOT NULL,
  source_type       TEXT NOT NULL CHECK(source_type IN ('purchase', 'subscription', 'grant', 'trial')),
  source_id         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'grace', 'suspended', 'revoked', 'expired')),
  granted_at        TEXT NOT NULL,
  expires_at        TEXT,
  grace_period_ends_at TEXT,
  grandfathered     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_entitlements_unique
  ON marketplace_entitlements(tenant_id, listing_id, principal_id)
  WHERE status IN ('active', 'grace');

CREATE INDEX IF NOT EXISTS idx_marketplace_entitlements_tenant_listing
  ON marketplace_entitlements(tenant_id, listing_id)
  WHERE status IN ('active', 'grace');

CREATE INDEX IF NOT EXISTS idx_marketplace_entitlements_package
  ON marketplace_entitlements(package_name, tenant_id)
  WHERE status IN ('active', 'grace');

-- ═══════════════════════════════════════════════════════════════
-- REFUNDS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_refunds (
  id                TEXT PRIMARY KEY,
  purchase_id       TEXT NOT NULL REFERENCES marketplace_purchases(id),
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'completed', 'failed')),
  external_refund_id TEXT,
  initiated_by      TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  completed_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_marketplace_refunds_purchase
  ON marketplace_refunds(purchase_id);

-- ═══════════════════════════════════════════════════════════════
-- PAYOUT ENTRIES (per-transaction earnings)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_payout_entries (
  id                  TEXT PRIMARY KEY,
  publisher_id        TEXT NOT NULL REFERENCES marketplace_publishers(id),
  purchase_id         TEXT NOT NULL REFERENCES marketplace_purchases(id),
  listing_id          TEXT NOT NULL REFERENCES marketplace_listings(id),
  gross_amount_cents  INTEGER NOT NULL,
  platform_fee_cents  INTEGER NOT NULL,
  net_amount_cents    INTEGER NOT NULL,
  tax_withholding_cents INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL,
  payout_batch_id     TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'clawed_back')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_payout_entries_publisher
  ON marketplace_payout_entries(publisher_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_marketplace_payout_entries_batch
  ON marketplace_payout_entries(payout_batch_id) WHERE payout_batch_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════
-- PAYOUT BATCHES
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_payout_batches (
  id                  TEXT PRIMARY KEY,
  publisher_id        TEXT NOT NULL REFERENCES marketplace_publishers(id),
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
  total_amount_cents  INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  entry_count         INTEGER NOT NULL,
  period_start        TEXT NOT NULL,
  period_end          TEXT NOT NULL,
  external_payout_id  TEXT,
  initiated_at        TEXT NOT NULL,
  completed_at        TEXT,
  failed_reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_marketplace_payout_batches_publisher
  ON marketplace_payout_batches(publisher_id);

CREATE INDEX IF NOT EXISTS idx_marketplace_payout_batches_status
  ON marketplace_payout_batches(status) WHERE status IN ('pending', 'processing');

-- ═══════════════════════════════════════════════════════════════
-- BILLING EVENTS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_billing_events (
  id                TEXT PRIMARY KEY,
  event_type        TEXT NOT NULL,
  source            TEXT NOT NULL CHECK(source IN ('internal', 'webhook')),
  reference_type    TEXT,
  reference_id      TEXT,
  payload_json      TEXT NOT NULL DEFAULT '{}',
  processed         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_billing_events_type
  ON marketplace_billing_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_billing_events_unprocessed
  ON marketplace_billing_events(processed) WHERE processed = 0;

-- ═══════════════════════════════════════════════════════════════
-- BILLING WEBHOOKS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_billing_webhooks (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  signature         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'received'
    CHECK(status IN ('received', 'processing', 'processed', 'failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  received_at       TEXT NOT NULL,
  processed_at      TEXT,
  UNIQUE(provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_billing_webhooks_status
  ON marketplace_billing_webhooks(status) WHERE status IN ('received', 'processing', 'failed');

-- ═══════════════════════════════════════════════════════════════
-- PAYMENT METHODS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_payment_methods (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  principal_id      TEXT NOT NULL,
  type              TEXT NOT NULL CHECK(type IN ('card', 'bank_account', 'external')),
  provider          TEXT NOT NULL,
  external_method_id TEXT NOT NULL,
  display_label     TEXT NOT NULL,
  is_default        INTEGER NOT NULL DEFAULT 0,
  expires_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_payment_methods_owner
  ON marketplace_payment_methods(tenant_id, principal_id);

-- ═══════════════════════════════════════════════════════════════
-- IDEMPOTENCY KEYS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_idempotency_keys (
  principal_id      TEXT NOT NULL,
  operation         TEXT NOT NULL,
  key               TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  response_json     TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  PRIMARY KEY (principal_id, operation, key)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_idempotency_expires
  ON marketplace_idempotency_keys(expires_at);
```

## 16. Future Work (Phase 2+)

- **Stripe adapter implementation**: Concrete billing provider adapter for Stripe Checkout, Billing, and Connect.
- **Usage metering adapter**: Runtime metering integration for usage-based pricing.
- **Marketplace frontend**: Visual listing browser, search, reviews, ratings, and purchase flow.
- **Search and ranking**: Full-text search, popularity ranking, and recommendation engine.
- **Multi-currency support**: Currency conversion at checkout with exchange rate management.
- **Automated tax calculation**: Integration with tax calculation services (e.g., Stripe Tax, Avalara).
- **Creator analytics dashboard**: Revenue trends, conversion rates, subscriber metrics.
- **Gifting and promo codes**: Discount codes, gift purchases, and promotional campaigns.
- **Marketplace federation**: Cross-hub listing discovery and purchase.
- **Review and rating system**: Buyer reviews, star ratings, and moderation.
