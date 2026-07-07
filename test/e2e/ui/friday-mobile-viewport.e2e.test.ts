import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFridayMockBrowserE2eEnv,
  type FridayMockBrowserE2eEnv,
  type FridayBrowserPageHandle,
} from "./_helpers/browser-env-mock.js";

const CHROMIUM_AVAILABLE = (() => {
  try {
    const pw = require("playwright") as { chromium: { executablePath: () => string } };
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
})();

const BROWSER_E2E_TIMEOUT_MS = 180_000;
const MOBILE_VIEWPORT_WIDTH = 375;
const MOBILE_VIEWPORT_HEIGHT = 812;

describe.skipIf(!CHROMIUM_AVAILABLE)("Friday mobile viewport (375px, mock hub browser E2E)", () => {
  let env: FridayMockBrowserE2eEnv | null = null;
  let pageHandle: FridayBrowserPageHandle | null = null;

  afterEach(async () => {
    if (pageHandle) {
      await pageHandle.close();
      pageHandle = null;
    }
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it("home page renders without horizontal overflow at 375px width", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayMockBrowserE2eEnv();
    pageHandle = await env.newPage();
    await pageHandle.page.setViewportSize({
      width: MOBILE_VIEWPORT_WIDTH,
      height: MOBILE_VIEWPORT_HEIGHT,
    });

    await pageHandle.page.goto("/home");
    await pageHandle.page.waitForFunction(() => {
      const bodyText = document.body.textContent?.trim() ?? "";
      return bodyText.length > 50 && !bodyText.includes("Something went wrong");
    }, { timeout: 45_000 });

    const overflowState = await pageHandle.page.evaluate(() => {
      const docWidth = document.documentElement.scrollWidth;
      const viewportWidth = window.innerWidth;
      return {
        documentWidth: docWidth,
        viewportWidth,
        hasHorizontalOverflow: docWidth > viewportWidth,
      };
    });

    expect(overflowState.hasHorizontalOverflow).toBe(false);
  });

  it("home page exposes a D6 mobile-web hero pet surface at 375px width", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayMockBrowserE2eEnv();
    pageHandle = await env.newPage();
    await pageHandle.page.setViewportSize({
      width: MOBILE_VIEWPORT_WIDTH,
      height: MOBILE_VIEWPORT_HEIGHT,
    });

    await pageHandle.page.goto("/home");
    await pageHandle.page.waitForFunction(() => {
      const bodyText = document.body.textContent?.trim() ?? "";
      return bodyText.length > 50 && !bodyText.includes("Something went wrong");
    }, { timeout: 45_000 });

    const mobileHeroPet = pageHandle.page.getByTestId("mobile-web-hero-pet");
    await mobileHeroPet.waitFor({ state: "visible", timeout: 5_000 });
    expect(await mobileHeroPet.isVisible()).toBe(true);
    expect(await mobileHeroPet.getAttribute("data-friday-pet-stage")).toBe("mobile-web");
    expect(await mobileHeroPet.getAttribute("data-friday-mobile-strategy")).toBe("design-truth-aligned");

    const petRenderProof = await mobileHeroPet.evaluate(async (stage) => {
      function wait(ms: number): Promise<void> {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
      }

      function canvasFingerprint(canvas: HTMLCanvasElement): { nonBlank: boolean; hash: number } {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          return { nonBlank: false, hash: 0 };
        }
        const width = Math.max(1, canvas.width);
        const height = Math.max(1, canvas.height);
        const data = context.getImageData(0, 0, width, height).data;
        let nonBlank = false;
        let hash = 2166136261;
        for (let index = 0; index < data.length; index += 4) {
          const alpha = data[index + 3] ?? 0;
          const red = data[index] ?? 0;
          const green = data[index + 1] ?? 0;
          const blue = data[index + 2] ?? 0;
          if (alpha > 0 && (red !== 0 || green !== 0 || blue !== 0)) {
            nonBlank = true;
          }
          hash ^= red + green * 3 + blue * 5 + alpha * 7 + index;
          hash = Math.imul(hash, 16777619);
        }
        return { nonBlank, hash: hash >>> 0 };
      }

      const staticPetImages = Array.from(stage.querySelectorAll("img"))
        .map((image) => image.getAttribute("src") ?? "")
        .filter((source) => source.includes("/source/pet/g-idle.png"));
      const deadline = Date.now() + 5_000;
      let latestProof = {
        hasCanvas: false,
        canvasNonBlank: false,
        frameChanged: false,
        staticPetImages,
      };
      while (Date.now() < deadline) {
        const canvas = stage.querySelector("canvas");
        if (canvas instanceof HTMLCanvasElement) {
          const before = canvasFingerprint(canvas);
          const pointerDown = typeof PointerEvent === "function"
            ? new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
            : new MouseEvent("mousedown", { bubbles: true, cancelable: true });
          stage.dispatchEvent(pointerDown);
          stage.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          await wait(350);
          const after = canvasFingerprint(canvas);
          latestProof = {
            hasCanvas: true,
            canvasNonBlank: before.nonBlank || after.nonBlank,
            frameChanged: before.hash !== after.hash,
            staticPetImages,
          };
          if (latestProof.canvasNonBlank && latestProof.frameChanged) {
            return latestProof;
          }
        }
        await wait(100);
      }
      return latestProof;
    });

    expect(petRenderProof.staticPetImages).toEqual([]);
    expect(petRenderProof.hasCanvas).toBe(true);
    expect(petRenderProof.canvasNonBlank).toBe(true);
    expect(petRenderProof.frameChanged).toBe(true);

    const mobileHome = pageHandle.page.getByTestId("mobile-web-home-surface");
    await mobileHome.waitFor({ state: "visible", timeout: 5_000 });
    expect(await mobileHome.isVisible()).toBe(true);
    const mobileHomeText = await mobileHome.textContent();
    expect(mobileHomeText).toContain("Friday Home");
    expect(mobileHomeText).toMatch(/Command Sheet|命令面板/);
    expect(mobileHomeText).toMatch(/Chat|聊天/);
    expect(mobileHomeText).toMatch(/Status|状态/);
  });

  it("skills page renders without horizontal overflow at 375px width", { timeout: BROWSER_E2E_TIMEOUT_MS }, async () => {
    env = await createFridayMockBrowserE2eEnv();
    pageHandle = await env.newPage();
    await pageHandle.page.setViewportSize({
      width: MOBILE_VIEWPORT_WIDTH,
      height: MOBILE_VIEWPORT_HEIGHT,
    });

    await pageHandle.page.goto("/skills");
    await pageHandle.page.waitForFunction(() => {
      const bodyText = document.body.textContent?.trim() ?? "";
      return bodyText.length > 20 && !bodyText.includes("Something went wrong");
    }, { timeout: 45_000 });

    const overflowState = await pageHandle.page.evaluate(() => {
      const docWidth = document.documentElement.scrollWidth;
      const viewportWidth = window.innerWidth;
      return {
        documentWidth: docWidth,
        viewportWidth,
        hasHorizontalOverflow: docWidth > viewportWidth,
      };
    });

    expect(overflowState.hasHorizontalOverflow).toBe(false);
  });
});
