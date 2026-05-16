/**
 * Phase 13.5A built-in deterministic GateRegistry.
 *
 * The gate registry is intentionally read-only in v1. Required gates are
 * non-disable-able regardless of supervisor mode or user configuration —
 * Light mode may only reduce optional repair budget. Required gates may
 * additionally be augmented by user/supervisor-mode-added optional gates,
 * but never removed.
 *
 * Boundary references live in `friday-task-workflow-boundaries.ts`.
 *
 * @module task-workflows/friday-task-workflow-gates
 */

import type {
  FridayTaskWorkflowGate,
  FridayTaskWorkflowGatePlanEntry,
  FridayTaskWorkflowRisk,
  FridayTaskWorkflowSupervisorMode,
} from "./friday-task-workflow.types.js";

/**
 * Built-in required gates. None of these can be disabled by user config
 * or supervisor mode. Light mode only reduces optional repair budget.
 */
export const FRIDAY_TASK_WORKFLOW_REQUIRED_GATES: readonly FridayTaskWorkflowGate[] = [
  {
    gateId: "claim_evidence_required",
    label: "Verified claims require an evidence ref",
    description:
      "A claim cannot reach status `verified` without at least one evidence ref attached and an evidence-bearing claim kind.",
    required: true,
    mandatoryForRisk: ["low", "medium", "high"],
  },
  {
    gateId: "verifier_fresh_read",
    label: "Verifier verdict requires fresh-read of evidence",
    description:
      "A verifier verdict must be persisted alongside an evidence ref; provider fallback availability is not a verifier verdict.",
    required: true,
    mandatoryForRisk: ["low", "medium", "high"],
  },
  {
    gateId: "docs_intent_not_proof",
    label: "Docs / spec / intent refs are not proof",
    description:
      "Docs/spec/START_HERE references describe intent only and cannot satisfy a verified behavior claim.",
    required: true,
    mandatoryForRisk: ["low", "medium", "high"],
  },
  {
    gateId: "summary_replay_unconfirmed",
    label: "Summary/context replay stays unconfirmed",
    description:
      "Summary and context replay claims cannot satisfy `verified` status; they remain `unverified` until separate fresh evidence is attached.",
    required: true,
    mandatoryForRisk: ["low", "medium", "high"],
  },
  {
    gateId: "cli_self_report_unconfirmed",
    label: "CLI self-report stays unconfirmed",
    description:
      "CLI backend output cannot reach `verified` until Friday fresh-reads referenced evidence; the CLI text alone is not proof.",
    required: true,
    mandatoryForRisk: ["low", "medium", "high"],
  },
  {
    gateId: "provider_fallback_not_audit",
    label: "Provider fallback is availability, not audit",
    description:
      "Provider fallback success records availability only. It cannot be used as a verifier verdict on its own.",
    required: true,
    mandatoryForRisk: ["low", "medium", "high"],
  },
  {
    gateId: "context_package_scope_limit",
    label: "Context package excludes whole-repo source by default",
    description:
      "A task workflow's context package must enumerate scoped allowed files. Whole-repo sentinels like `**` are refused.",
    required: true,
    mandatoryForRisk: ["low", "medium", "high"],
  },
  {
    gateId: "executor_lane_context_bound",
    label: "Executor lanes are bound to a frozen context snapshot",
    description:
      "Every executor lane recorded on the workflow must carry a deterministic context snapshot hash and a captured workflow spec_hash that still matches the workflow at closeout. Lanes whose context binding is missing or mismatched block closeout instead of silently passing.",
    required: true,
    mandatoryForRisk: ["low", "medium", "high"],
  },
];

/** Built-in optional gates that can be layered on top of required gates. */
export const FRIDAY_TASK_WORKFLOW_OPTIONAL_GATES: readonly FridayTaskWorkflowGate[] = [
  {
    gateId: "independent_verifier_required",
    label: "Independent verifier verdict required for high-risk claims",
    description:
      "High-risk task workflows must use a verifier lane separate from the executor lane; provider fallback availability is not independence.",
    required: false,
    mandatoryForRisk: ["high"],
  },
  {
    gateId: "channel_command_confirmation_required",
    label: "Channel commands require confirmation",
    description:
      "Configured-channel commands must route to confirmed canonical actions before mutating task state.",
    required: false,
    mandatoryForRisk: ["medium", "high"],
  },
];

export const FRIDAY_TASK_WORKFLOW_BUILTIN_GATES: readonly FridayTaskWorkflowGate[] = [
  ...FRIDAY_TASK_WORKFLOW_REQUIRED_GATES,
  ...FRIDAY_TASK_WORKFLOW_OPTIONAL_GATES,
];

const REQUIRED_GATE_IDS: ReadonlySet<string> = new Set(
  FRIDAY_TASK_WORKFLOW_REQUIRED_GATES.map((gate) => gate.gateId),
);

const KNOWN_GATE_IDS: ReadonlySet<string> = new Set(
  FRIDAY_TASK_WORKFLOW_BUILTIN_GATES.map((gate) => gate.gateId),
);

/** Returns true if `gateId` is a required deterministic gate. */
export function isFridayRequiredGate(gateId: string): boolean {
  return REQUIRED_GATE_IDS.has(gateId);
}

/** Returns true if `gateId` is a known built-in gate (required or optional). */
export function isFridayKnownGate(gateId: string): boolean {
  return KNOWN_GATE_IDS.has(gateId);
}

/**
 * Compute the per-workflow gate plan for a given risk + supervisor mode.
 *
 * The resulting plan ALWAYS contains every required gate. Additional gates
 * may be layered on top by:
 *   - the risk classification (mandatoryForRisk match), or
 *   - the user explicitly opting in via `additionalGateIds`.
 *
 * Light mode and Off mode cannot remove required gates. Strict mode adds
 * `independent_verifier_required` and `channel_command_confirmation_required`.
 */
export function planFridayTaskWorkflowGates(input: {
  risk: FridayTaskWorkflowRisk;
  supervisorMode: FridayTaskWorkflowSupervisorMode;
  additionalGateIds?: readonly string[];
}): readonly FridayTaskWorkflowGatePlanEntry[] {
  const planByGateId = new Map<string, FridayTaskWorkflowGatePlanEntry>();

  for (const gate of FRIDAY_TASK_WORKFLOW_REQUIRED_GATES) {
    planByGateId.set(gate.gateId, {
      gateId: gate.gateId,
      required: true,
      additiveUser: false,
    });
  }

  for (const gate of FRIDAY_TASK_WORKFLOW_OPTIONAL_GATES) {
    if (gate.mandatoryForRisk.includes(input.risk)) {
      planByGateId.set(gate.gateId, {
        gateId: gate.gateId,
        required: false,
        additiveUser: false,
      });
    }
  }

  if (input.supervisorMode === "strict") {
    for (const gate of FRIDAY_TASK_WORKFLOW_OPTIONAL_GATES) {
      if (!planByGateId.has(gate.gateId)) {
        planByGateId.set(gate.gateId, {
          gateId: gate.gateId,
          required: false,
          additiveUser: false,
        });
      }
    }
  }

  for (const gateId of input.additionalGateIds ?? []) {
    if (!isFridayKnownGate(gateId)) {
      continue;
    }
    if (!planByGateId.has(gateId)) {
      planByGateId.set(gateId, {
        gateId,
        required: REQUIRED_GATE_IDS.has(gateId),
        additiveUser: true,
      });
    }
  }

  return [...planByGateId.values()];
}

/** Default per-supervisor-mode optional repair budget. */
export function defaultFridayTaskWorkflowBudget(
  mode: FridayTaskWorkflowSupervisorMode,
): number {
  switch (mode) {
    case "off":
      return 0;
    case "light":
      return 1;
    case "standard":
      return 4;
    case "strict":
      return 8;
  }
}
