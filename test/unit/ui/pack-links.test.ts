import { describe, expect, it } from "vitest";

import {
  buildPackAssistantHref,
  buildPackChatHref,
  buildPackFlowHref,
  resolvePackLaunchContext,
} from "../../../ui/src/lib/packs/pack-links";
import { getPackById } from "../../../ui/src/lib/packs/pack-registry";

describe("pack links", () => {
  it("builds a pack-aware guided flow href", () => {
    const pack = getPackById("industry-creator-media");
    expect(pack).toBeTruthy();

    expect(buildPackFlowHref(pack!)).toBe("/flow/content-social?packId=industry-creator-media");
    expect(buildPackFlowHref(pack!, { mode: "adjust" })).toBe("/flow/content-social?packId=industry-creator-media&mode=adjust");
  });

  it("builds pack-aware chat and assistant hrefs", () => {
    expect(buildPackAssistantHref("industry-creator-media")).toBe("/assistant?packId=industry-creator-media");
    expect(buildPackChatHref("industry-creator-media")).toBe("/chat?packId=industry-creator-media");
    expect(buildPackChatHref("industry-creator-media", "hello world")).toBe("/chat?packId=industry-creator-media&prompt=hello+world");
  });

  it("only resolves pack launch context when packId matches the wizard", () => {
    expect(resolvePackLaunchContext("content-social", "industry-creator-media")?.id).toBe("industry-creator-media");
    expect(resolvePackLaunchContext("content-social", "industry-cross-border-ecommerce")).toBeNull();
    expect(resolvePackLaunchContext("content-social", null)).toBeNull();
  });
});
