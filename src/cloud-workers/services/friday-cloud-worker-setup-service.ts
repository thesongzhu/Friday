import { createFridayCloudWorkerCatalogService } from "./friday-cloud-worker-catalog.js";
import { createFridayCloudWorkerDnsValidator } from "./friday-cloud-worker-dns-validator.js";
import { createFridayCloudWorkerDoctorService } from "./friday-cloud-worker-doctor.js";
import { createFridayCloudWorkerPackageService } from "./friday-cloud-worker-package.js";
import { createFridayCloudWorkerTeardownService } from "./friday-cloud-worker-teardown.js";

export interface FridayCloudWorkerSetupServiceDeps {
  readonly nowIso: () => string;
}

export function createFridayCloudWorkerSetupService(
  deps: FridayCloudWorkerSetupServiceDeps,
) {
  const catalog = createFridayCloudWorkerCatalogService();
  const dnsValidator = createFridayCloudWorkerDnsValidator();
  const doctor = createFridayCloudWorkerDoctorService({ catalog, dnsValidator, nowIso: deps.nowIso });
  const teardown = createFridayCloudWorkerTeardownService({ catalog, nowIso: deps.nowIso });
  const packageService = createFridayCloudWorkerPackageService({ catalog, dnsValidator });

  return {
    catalog,
    dnsValidator,
    doctor,
    teardown,
    packageService,
  };
}

export type FridayCloudWorkerSetupService = ReturnType<
  typeof createFridayCloudWorkerSetupService
>;
