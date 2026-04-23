#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { getRootPath, validatePhaseArg } from "./closeout-lib.mjs";

const phaseId = validatePhaseArg(process.argv[2]);

const checks = {
  phase1: [
    // Canonical contract notes live in docs/current-source-of-truth.md.
    // README.md is the user-facing landing page and should not carry
    // API contract fragments.
    {
      path: "docs/current-source-of-truth.md",
      required: [
        "## Canonical and compatibility route families",
        "/v1/realtime/*` is the canonical realtime transport surface.",
        "/v1/workflow-approvals*` is the canonical workflow approval surface; `/v1/approvals*` remains a compatibility alias",
        "/v1/diagnosis/*",
        "/v1/auto-fix/*",
        "`GET /v1/version` is the canonical lightweight version surface; `/v1/health` remains the public liveness probe.",
        "/v1/sessions/:sessionKey",
      ],
    },
    {
      path: "docs/SSD-GAP-REPORT.md",
      required: [
        "Archived: historical audit/plan/report material.",
        "## Canonical contract decisions already settled",
        "/v1/ws` is a compatibility alias, not the primary transport contract.",
        "/v1/workflow-approvals*` is canonical; `/v1/approvals*` is compatibility-only.",
      ],
    },
    {
      path: "docs/distributed-architecture.md",
      required: [
        "Status:** Design reference",
        "current-source-of-truth.md",
        "Ownership model:** `[Deferred]`",
        "Current discovery baseline is: static peers, registered satellites, and the trust-scored fleet directory.",
      ],
    },
    {
      path: "docs/archive/CX15-SSD-UPDATE-PLAN.md",
      required: [
        "Archived and superseded",
        "no longer an active contract source",
      ],
    },
  ],
  phase2: [
    {
      path: "docs/current-source-of-truth.md",
      required: [
        "/v1/fleet/*",
        "/v1/satellites/*",
        "hub`, `satellite:<id>`, or `capability-match`",
        "Satellite-offline execution failures must surface as explicit blocked or retryable state",
      ],
    },
    // Fleet & Distributed Execution details moved to docs/current-source-of-truth.md
  ],
  phase3: [
    {
      path: "docs/current-source-of-truth.md",
      required: [
        "The supervised agent loop is a steady-state runtime surface",
        "cooldown retries",
        "repeated-failure halt conditions",
        "rollback/verification evidence",
      ],
    },
    {
      path: "docs/VISION.md",
      required: [
        "unrestricted autonomous agent loop beyond the supervised self-healing surface",
      ],
    },
  ],
  phase4: [
    {
      path: "docs/current-source-of-truth.md",
      required: [
        "Acceptance custom checks execute in a sandboxed runtime",
        "Provider-level retry circuit breakers",
        "Rules simulation, rule version history, and audit-log visibility",
      ],
    },
    // Phase 4 acceptance/retry/rules details moved to docs/current-source-of-truth.md
  ],
  phase5: [
    {
      path: "docs/current-source-of-truth.md",
      required: [
        "/v1/skills/*` is the canonical skill lifecycle surface",
        "/v1/marketplace/sources*` is the canonical source-management surface",
        "Generated skills must be able to flow directly into verification, install or enable recommendation, diagnosis, and recovery.",
        "/v1/plugins*` and `/v1/marketplace/plugins*` are active plugin distribution surfaces",
        "/v1/marketplace/requests*` is the canonical connector-only request board",
      ],
    },
    // Skills lifecycle and marketplace details moved to docs/current-source-of-truth.md
  ],
  marketplace: [
    // Marketplace contract details moved to docs/current-source-of-truth.md and architecture RFC
    {
      path: "docs/current-source-of-truth.md",
      required: [
        "The **skills lifecycle is the primary marketplace backbone**.",
        "Public marketplace support for `workflow` and `agent` assets extends this same backbone",
        "Public marketplace assets are **declarative-first**.",
        "creator reputation must be multi-signal rather than star-only.",
        "`0%` commission on creator support",
      ],
    },
    {
      path: "docs/ops/friday-capability-matrix.md",
      required: [
        "Creator support and request board",
        "Plugin marketplace and commerce",
        "Validated but temporary",
        "Deferred",
      ],
    },
    {
      path: "docs/architecture/marketplace-commerce-rfc.md",
      required: [
        "skills/workflows/agents first, free-first, declarative-first, creator-support oriented, and request-board capable",
        "bounded operator/admin surface",
        "Platform commission is fixed at `0%`",
      ],
    },
  ],
  final: [
    {
      path: "docs/current-source-of-truth.md",
      required: [
        "npm run release:verify",
        "npm run closeout:final",
      ],
    },
    {
      path: "docs/VISION.md",
      required: [
        "trusted-device passkey remote access",
        "a real fleet control plane",
        "deeper fleet-triggered remediation beyond the current satellite degradation/offline ingestion, cooldown sweep, and operator loop visibility",
        "supervised, bounded automation system",
      ],
    },
    {
      path: "docs/ops/friday-capability-matrix.md",
      required: [
        "What Friday Can Do Today",
        "What Friday Usually Does Only Under Supervision",
        "What Friday does **not** reliably claim today",
        "Plugin marketplace and commerce",
      ],
    },
    {
      path: "docs/ops/friday-vs-openclaw.md",
      required: [
        "Friday has closed the explicitly tracked OpenClaw overlap goals",
        "not full behavioral identity",
        "Why Friday Can Still Miss Expectations",
      ],
    },
    {
      path: "docs/reports/closeout/README.md",
      required: [
        "Phase 1",
        "Phase 6",
        "validated and keep",
        "validated but temporary",
        "deferred",
      ],
    },
  ],
};

let failures = 0;

for (const check of checks[phaseId]) {
  const absolutePath = getRootPath(check.path);
  const content = readFileSync(absolutePath, "utf-8");
  for (const needle of check.required) {
    if (!content.includes(needle)) {
      console.error(`❌ Missing required truth fragment in ${check.path}: ${needle}`);
      failures += 1;
    } else {
      console.log(`✅ ${check.path}: ${needle}`);
    }
  }
}

if (failures > 0) {
  console.error(`\n❌ Closeout truth check failed for ${phaseId} with ${failures} missing fragment(s)`);
  process.exit(1);
}

console.log(`\n🎉 Closeout truth check passed for ${phaseId}`);
