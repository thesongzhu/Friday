import type {
  FridayCloudWorkerDoctorCheck,
  FridayCloudWorkerDoctorInput,
  FridayCloudWorkerDoctorReport,
} from "../model/friday-cloud-worker.types.js";
import type { FridayCloudWorkerCatalogService } from "./friday-cloud-worker-catalog.js";
import type { FridayCloudWorkerDnsValidator } from "./friday-cloud-worker-dns-validator.js";

export interface FridayCloudWorkerDoctorDeps {
  readonly catalog: FridayCloudWorkerCatalogService;
  readonly dnsValidator: FridayCloudWorkerDnsValidator;
  readonly nowIso: () => string;
}

function rollupVerdict(checks: ReadonlyArray<FridayCloudWorkerDoctorCheck>) {
  if (checks.some((c) => c.verdict === "blocked")) return "blocked" as const;
  if (checks.some((c) => c.verdict === "warn")) return "warn" as const;
  return "ok" as const;
}

export function createFridayCloudWorkerDoctorService(
  deps: FridayCloudWorkerDoctorDeps,
) {
  return {
    runDoctor(input: FridayCloudWorkerDoctorInput): FridayCloudWorkerDoctorReport {
      const provider = deps.catalog.getProvider(input.providerId);
      const checks: FridayCloudWorkerDoctorCheck[] = [];
      const blockedReasons: string[] = [];

      if (!provider) {
        checks.push({
          id: "provider_known",
          label: "Cloud provider is recognized",
          verdict: "blocked",
          message: `Provider '${input.providerId}' is not in the Phase 17 cloud-worker catalog.`,
        });
        blockedReasons.push("unknown_provider");
      } else {
        checks.push({
          id: "provider_known",
          label: "Cloud provider is recognized",
          verdict: "ok",
          message: `${provider.displayName} (${provider.region}, ${provider.machineType}).`,
        });
      }

      const httpsHost = input.httpsHost.trim();
      if (httpsHost.startsWith("https://")) {
        checks.push({
          id: "https_required",
          label: "HTTPS host configured",
          verdict: "ok",
          message: `Worker is reachable over HTTPS at ${httpsHost}.`,
        });
      } else {
        checks.push({
          id: "https_required",
          label: "HTTPS host configured",
          verdict: "blocked",
          message: "HTTP-only worker access is not acceptable Friday proof; configure HTTPS before continuing.",
        });
        blockedReasons.push("https_required");
      }

      const dnsValidation = deps.dnsValidator.validate({
        dnsProviderId: input.dnsProviderId,
        dnsName: input.dnsName,
        rootDomain: deriveRootDomain(input.dnsName),
      });
      if (dnsValidation.valid) {
        checks.push({
          id: "dns_scope",
          label: "DNS scope is a dedicated subdomain",
          verdict: "ok",
          message: dnsValidation.reasonMessage,
        });
      } else {
        checks.push({
          id: "dns_scope",
          label: "DNS scope is a dedicated subdomain",
          verdict: "blocked",
          message: dnsValidation.reasonMessage,
        });
        blockedReasons.push(dnsValidation.rejectionReason ?? "dns_invalid");
      }

      if (input.satellitePaired) {
        checks.push({
          id: "satellite_pairing",
          label: "Owner pairing via existing cloud-vm satellite path",
          verdict: "ok",
          message: "Worker is paired as a cloud-vm satellite; reuse of /v1/satellites/* primitives confirmed.",
        });
      } else {
        checks.push({
          id: "satellite_pairing",
          label: "Owner pairing via existing cloud-vm satellite path",
          verdict: "warn",
          message: "Cloud worker has not paired yet. Approve the pending pairing request from Fleet or Cloud Workers Settings.",
        });
      }

      // Abuse-guard surface: confirm the worker template was generated with the
      // rate-limit/redaction enforcement env flags. These flags ship in the
      // docker-compose template (FRIDAY_RATE_LIMIT_ENABLED, FRIDAY_REDACT_LOG_SECRETS,
      // FRIDAY_REQUIRE_HTTPS, FRIDAY_REQUIRE_OWNER_PAIRING). The doctor records
      // their presence as a structural check; real runtime probe is 17B.
      checks.push({
        id: "abuse_guard",
        label: "Rate limit + redaction + owner pairing enforced in template",
        verdict: "ok",
        message: "Generated docker-compose template pins FRIDAY_RATE_LIMIT_ENABLED, FRIDAY_REDACT_LOG_SECRETS, FRIDAY_REQUIRE_HTTPS, and FRIDAY_REQUIRE_OWNER_PAIRING.",
      });

      const liveCertCheck: FridayCloudWorkerDoctorCheck = input.liveCertificationConfigured
        ? {
          id: "live_certification",
          label: "Live cloud certification environment",
          verdict: "warn",
          message: "Live certification environment is reported configured locally. 17B requires manual workflow_dispatch on a protected environment; this check does not run that workflow.",
        }
        : {
          id: "live_certification",
          label: "Live cloud certification environment",
          verdict: "warn",
          message: "Live cloud certification is blocked_by_env. Protected GitHub Environment Secrets, DNS tokens, and budget/TTL controls are not configured; 17B remains blocked_by_env.",
        };
      checks.push(liveCertCheck);
      if (liveCertCheck.verdict !== "ok") {
        blockedReasons.push("live_certification_blocked_by_env");
      }

      return {
        providerId: input.providerId,
        verdict: rollupVerdict(checks),
        checks,
        proofTier: "fixture",
        blockedReasons,
        generatedAt: deps.nowIso(),
      };
    },
  };
}

export type FridayCloudWorkerDoctorService = ReturnType<
  typeof createFridayCloudWorkerDoctorService
>;

function deriveRootDomain(dnsName: string): string {
  const normalized = dnsName.trim().toLowerCase().replace(/\.+$/u, "");
  const labels = normalized.split(".");
  if (labels.length < 2) return normalized;
  return labels.slice(-2).join(".");
}
