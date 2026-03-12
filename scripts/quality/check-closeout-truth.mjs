#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { getRootPath, validatePhaseArg } from "./closeout-lib.mjs";

const phaseId = validatePhaseArg(process.argv[2]);

const checks = {
  phase1: [
    {
      path: "README.md",
      required: [
        "### Canonical Contract Notes",
        "/v1/realtime/*` is the canonical realtime surface.",
        "/v1/workflow-approvals*` is the canonical approvals surface.",
        "/v1/diagnosis/*` and `/v1/auto-fix/*` are the canonical self-healing route families.",
        "`sessionKey` is the canonical session route shape.",
      ],
    },
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
      path: "docs/CX15-SSD-UPDATE-PLAN.md",
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
    {
      path: "README.md",
      required: [
        "Fleet & Distributed Execution",
        "Register satellites, pair and sync them, place workflow nodes on `hub`, explicit satellites, or capability-matched nodes, and operate the fleet from `/fleet`.",
      ],
    },
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
    {
      path: "README.md",
      required: [
        "acceptance tests now support sandboxed custom checks plus version history",
        "retry now includes provider-level circuit breakers and replay evidence",
        "rules expose simulation plus explainable audit trails",
      ],
    },
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
    {
      path: "README.md",
      required: [
        "Skills lifecycle closeout",
        "Plugin Marketplace & Commerce",
        "connector-only request board",
      ],
    },
  ],
  marketplace: [
    {
      path: "README.md",
      required: [
        "creator-support-first",
        "the platform does not take a commission or provide escrow, guarantees, or after-sales support.",
        "/v1/marketplace/assets*` is the canonical public catalog and detail read surface",
        "/v1/marketplace/requests*` is the connector-only request board",
      ],
    },
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
