import type {
  FridayCloudWorkerDnsProviderId,
  FridayCloudWorkerDnsValidationInput,
  FridayCloudWorkerDnsValidationResult,
} from "../model/friday-cloud-worker.types.js";

const SUPPORTED_DNS_PROVIDERS: ReadonlyArray<FridayCloudWorkerDnsProviderId> = [
  "dnspod",
  "cloudflare",
];

const DEDICATED_SUBDOMAIN_PREFIX = "friday-test.";
const DEDICATED_SUBDOMAIN_PATTERN = "*.friday-test.<your-domain>";
const DNS_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/u, "");
}

function isValidDnsName(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split(".");
  if (labels.length < 3) return false;
  return labels.every((label) => DNS_LABEL_PATTERN.test(label));
}

export function createFridayCloudWorkerDnsValidator() {
  return {
    validate(input: FridayCloudWorkerDnsValidationInput): FridayCloudWorkerDnsValidationResult {
      const normalizedDnsName = normalizeHost(input.dnsName);
      const normalizedRootDomain = normalizeHost(input.rootDomain);
      const baseResult = {
        valid: false,
        dnsProviderId: input.dnsProviderId,
        dnsName: input.dnsName,
        rootDomain: input.rootDomain,
        normalizedDnsName,
        normalizedRootDomain,
        dedicatedSubdomainPattern: DEDICATED_SUBDOMAIN_PATTERN,
      } as const;

      if (
        !SUPPORTED_DNS_PROVIDERS.includes(
          input.dnsProviderId as FridayCloudWorkerDnsProviderId,
        )
      ) {
        return {
          ...baseResult,
          rejectionReason: "unsupported_dns_provider",
          reasonMessage:
            "Only DNSPod and Cloudflare dedicated-subdomain automation are supported in Phase 17.",
        };
      }

      if (normalizedDnsName.includes("*")) {
        return {
          ...baseResult,
          rejectionReason: "wildcard_rejected",
          reasonMessage:
            "Wildcard DNS automation is rejected. Use a single dedicated subdomain such as worker.friday-test.<your-domain>.",
        };
      }

      if (normalizedRootDomain.length === 0) {
        return {
          ...baseResult,
          rejectionReason: "root_domain_rejected",
          reasonMessage:
            "Root domain must be supplied. Provide the apex domain you own (e.g. example.com) so Friday can confirm the dedicated subdomain is properly scoped.",
        };
      }

      if (normalizedDnsName === normalizedRootDomain) {
        return {
          ...baseResult,
          rejectionReason: "root_domain_rejected",
          reasonMessage:
            "The supplied DNS name is the root domain itself. Friday requires a dedicated subdomain to avoid affecting your apex DNS records.",
        };
      }

      if (!isValidDnsName(normalizedDnsName)) {
        return {
          ...baseResult,
          rejectionReason: "invalid_dns_name",
          reasonMessage:
            "DNS name is not a syntactically valid host (lowercase labels separated by dots, at least 3 labels).",
        };
      }

      if (
        !normalizedDnsName.endsWith(`.${normalizedRootDomain}`) ||
        normalizedDnsName === normalizedRootDomain
      ) {
        return {
          ...baseResult,
          rejectionReason: "dns_name_outside_root_domain",
          reasonMessage:
            "DNS name must be a subdomain of the supplied root domain.",
        };
      }

      const subdomainPart = normalizedDnsName.slice(
        0,
        normalizedDnsName.length - normalizedRootDomain.length - 1,
      );
      if (!subdomainPart.endsWith(`.${DEDICATED_SUBDOMAIN_PREFIX.slice(0, -1)}`) &&
          subdomainPart !== DEDICATED_SUBDOMAIN_PREFIX.slice(0, -1) &&
          !subdomainPart.includes(`.${DEDICATED_SUBDOMAIN_PREFIX.slice(0, -1)}.`)) {
        // Subdomain must sit underneath the dedicated `friday-test` label,
        // e.g. worker.friday-test.example.com. This blocks broad/root-domain
        // tokens from accidentally landing on the apex or unrelated zones.
        const prefixToken = DEDICATED_SUBDOMAIN_PREFIX.slice(0, -1);
        const isUnderDedicated =
          subdomainPart === prefixToken ||
          subdomainPart.endsWith(`.${prefixToken}`);
        if (!isUnderDedicated) {
          return {
            ...baseResult,
            rejectionReason: "missing_dedicated_subdomain_prefix",
            reasonMessage:
              "DNS name must live underneath a dedicated friday-test subdomain such as worker.friday-test.<your-domain>.",
          };
        }
      }

      return {
        ...baseResult,
        valid: true,
        reasonMessage:
          "Dedicated subdomain is valid for Friday cloud worker DNS automation.",
      };
    },
  };
}

export type FridayCloudWorkerDnsValidator = ReturnType<
  typeof createFridayCloudWorkerDnsValidator
>;
