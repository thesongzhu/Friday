/**
 * Central route-contract helpers for HTTP route registration.
 *
 * Public HTTP paths remain stable, but the runtime route surface now accepts
 * only canonical lowercase dot-separated operation IDs.
 */

export const FRIDAY_ROUTE_OPERATION_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9]+)*$/;
/**
 * Historical public operationId migration map.
 *
 * This is machine-readable on purpose so docs/contracts/tooling can explain
 * the one-time rename without the runtime continuing to accept non-canonical
 * operation IDs.
 */
export const FRIDAY_ROUTE_OPERATION_ID_RENAMES = {
  "auth.bootstrap.localPassphrase": "auth.bootstrap.local.passphrase",
  "cancelAgentRun": "agent.runs.cancel",
  "desktop.permissions.listDecisions": "desktop.permissions.decisions.list",
  "desktop.policies.addRule": "desktop.policies.rules.create",
  "desktop.policies.removeRule": "desktop.policies.rules.delete",
  "desktop.recordings.listSteps": "desktop.recordings.steps.list",
  "discovery.getCatalog": "discovery.catalog.get",
  "discovery.getPolicy": "discovery.policy.get",
  "discovery.listPrograms": "discovery.programs.list",
  "discovery.updatePolicy": "discovery.policy.update",
  "marketplace.listings.submitForReview": "marketplace.listings.review.submit",
  "marketplace.publishers.reviewVerification": "marketplace.publishers.verification.review",
  "marketplace.publishers.submitVerification": "marketplace.publishers.verification.submit",
  "marketplace.skills.syncStatus": "marketplace.skills.status.sync",
  "nodeRunner.execute": "node.runner.execute",
  "nodeRunner.executions.get": "node.runner.executions.get",
  "nodeRunner.executions.list": "node.runner.executions.list",
  "observability.alertRules.create": "observability.alert.rules.create",
  "observability.alertRules.delete": "observability.alert.rules.delete",
  "observability.alertRules.get": "observability.alert.rules.get",
  "observability.alertRules.list": "observability.alert.rules.list",
  "observability.alertRules.update": "observability.alert.rules.update",
  "security.secrets.accessLog": "security.secrets.access.log",
  "workflows.importBundle": "workflows.bundles.import",
} as const;

export type FridayRenamedOperationId =
  keyof typeof FRIDAY_ROUTE_OPERATION_ID_RENAMES;

export type FridayCanonicalRenamedOperationId =
  (typeof FRIDAY_ROUTE_OPERATION_ID_RENAMES)[FridayRenamedOperationId];

export function isFridayCanonicalRouteOperationId(operationId: string): boolean {
  return FRIDAY_ROUTE_OPERATION_ID_PATTERN.test(operationId);
}
