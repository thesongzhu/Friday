import { describe, expect, it } from "vitest";

import { listFridayCrossBorderWorkflowTemplateIds } from "../../../src/packs/cross-border/friday-cross-border-workflow-catalog";
import { getPackById } from "../../../ui/src/lib/packs/pack-registry";

describe("cross-border pack registry", () => {
  it("binds the cross-border pack to the real workflow template assets", () => {
    const pack = getPackById("industry-cross-border-ecommerce");
    expect(pack).toBeTruthy();
    expect(pack?.backingTemplateIds).toEqual(listFridayCrossBorderWorkflowTemplateIds());
  });

  it("keeps the curated cross-border skill surface in place", () => {
    const pack = getPackById("industry-cross-border-ecommerce");
    expect(pack).toBeTruthy();
    expect(pack?.curatedSkills.map((skill) => skill.skillId)).toEqual([
      "summarize-shop-performance",
      "cross-border-product-scout",
      "cross-border-top-category-watch",
      "cross-border-spike-detector",
      "cross-border-price-match-review",
      "cross-border-listing-image-layout-audit",
      "cross-border-customer-service-brief",
      "cross-border-weekly-growth-review",
    ]);
  });
});
