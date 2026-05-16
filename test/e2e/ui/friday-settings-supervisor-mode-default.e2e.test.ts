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

interface SupervisorCardState {
  hasCard: boolean;
  modes: string[];
  current: string | null;
  bodyText: string;
  containsRequiredGatesCannotBeDisabled: boolean;
  hasAnyDisableableRequiredGateUi: boolean;
}

async function readSupervisorCardState(page: FridayBrowserPageHandle["page"]): Promise<SupervisorCardState> {
  return await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("h2")).find(
      (node) => (node.textContent ?? "").trim() === "Default supervisor mode",
    );
    if (!heading) {
      return {
        hasCard: false,
        modes: [],
        current: null,
        bodyText: "",
        containsRequiredGatesCannotBeDisabled: false,
        hasAnyDisableableRequiredGateUi: false,
      };
    }
    const section = heading.closest("section");
    if (!section) {
      return {
        hasCard: false,
        modes: [],
        current: null,
        bodyText: "",
        containsRequiredGatesCannotBeDisabled: false,
        hasAnyDisableableRequiredGateUi: false,
      };
    }
    const buttons = Array.from(section.querySelectorAll("button")).map((node) =>
      (node.textContent ?? "").trim(),
    );
    const currentMatch = (section.textContent ?? "").match(
      /Current:\s*(off|light|standard|strict)/,
    );
    const text = (section.textContent ?? "").toLowerCase();
    return {
      hasCard: true,
      modes: buttons,
      current: currentMatch?.[1] ?? null,
      bodyText: section.textContent ?? "",
      containsRequiredGatesCannotBeDisabled: text.includes(
        "required deterministic gates cannot be disabled",
      ),
      hasAnyDisableableRequiredGateUi:
        text.includes("disable required gate") ||
        text.includes("disable gate") ||
        section.querySelector('input[type="checkbox"]') !== null ||
        section.querySelector('input[type="radio"]') !== null,
    };
  });
}

describe.skipIf(!CHROMIUM_AVAILABLE)(
  "Settings page SupervisorModeDefaultCard (mock hub browser E2E)",
  () => {
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

    it(
      "shows four modes, cancel does not persist, confirm persists only task_workflow_supervisor_mode_default with no memory write",
      { timeout: BROWSER_E2E_TIMEOUT_MS },
      async () => {
        env = await createFridayMockBrowserE2eEnv();
        pageHandle = await env.newPage();

        const allApiRequests: Array<{
          method: string;
          url: string;
          body: string | null;
        }> = [];
        pageHandle.page.on("request", (req) => {
          const url = req.url();
          if (url.includes("/v1/")) {
            allApiRequests.push({
              method: req.method(),
              url,
              body: req.postData(),
            });
          }
        });

        await pageHandle.page.goto("/settings");
        await pageHandle.page.waitForFunction(
          () =>
            Array.from(document.querySelectorAll("h2")).some(
              (node) => (node.textContent ?? "").trim() === "Default supervisor mode",
            ),
          undefined,
          { timeout: 45_000 },
        );
        await pageHandle.page.waitForFunction(
          () => {
            const heading = Array.from(document.querySelectorAll("h2")).find(
              (node) => (node.textContent ?? "").trim() === "Default supervisor mode",
            );
            const section = heading?.closest("section");
            if (!section) return false;
            const enabledButtons = Array.from(section.querySelectorAll("button")).filter(
              (btn) => !(btn as HTMLButtonElement).disabled,
            );
            return enabledButtons.length >= 4;
          },
          undefined,
          { timeout: 30_000 },
        );

        const initial = await readSupervisorCardState(pageHandle.page);
        expect(initial.hasCard).toBe(true);
        expect(initial.modes).toEqual(
          expect.arrayContaining(["off", "light", "standard", "strict"]),
        );
        expect(initial.modes.filter((mode) =>
          ["off", "light", "standard", "strict"].includes(mode),
        )).toHaveLength(4);
        expect(initial.current).toBe("standard");
        expect(initial.containsRequiredGatesCannotBeDisabled).toBe(true);
        expect(initial.hasAnyDisableableRequiredGateUi).toBe(false);

        await pageHandle.page.evaluate(() => {
          const heading = Array.from(document.querySelectorAll("h2")).find(
            (node) => (node.textContent ?? "").trim() === "Default supervisor mode",
          );
          const section = heading?.closest("section");
          const button = Array.from(section?.querySelectorAll("button") ?? []).find(
            (b) => (b.textContent ?? "").trim() === "light",
          );
          (button as HTMLButtonElement | undefined)?.click();
        });
        await pageHandle.page
          .locator(
            '[role="dialog"][aria-label="Confirm supervisor default change"]',
          )
          .waitFor({ state: "visible", timeout: 10_000 });

        const requestsBeforeCancel = allApiRequests.length;
        await pageHandle.page.evaluate(() => {
          const dialog = document.querySelector(
            '[role="dialog"][aria-label="Confirm supervisor default change"]',
          );
          const cancelButton = Array.from(
            dialog?.querySelectorAll("button") ?? [],
          ).find((b) => (b.textContent ?? "").trim() === "Cancel");
          (cancelButton as HTMLButtonElement | undefined)?.click();
        });
        await pageHandle.page.waitForFunction(
          () =>
            document.querySelector(
              '[role="dialog"][aria-label="Confirm supervisor default change"]',
            ) === null,
          undefined,
          { timeout: 5_000 },
        );
        await pageHandle.page.waitForTimeout(600);

        const requestsAfterCancel = allApiRequests.slice(requestsBeforeCancel);
        const putAfterCancel = requestsAfterCancel.filter(
          (r) =>
            r.method === "PUT" && r.url.includes("/v1/uix/preferences"),
        );
        expect(putAfterCancel).toHaveLength(0);

        const stateAfterCancel = await readSupervisorCardState(pageHandle.page);
        expect(stateAfterCancel.current).toBe("standard");

        await pageHandle.page.evaluate(() => {
          const heading = Array.from(document.querySelectorAll("h2")).find(
            (node) => (node.textContent ?? "").trim() === "Default supervisor mode",
          );
          const section = heading?.closest("section");
          const button = Array.from(section?.querySelectorAll("button") ?? []).find(
            (b) => (b.textContent ?? "").trim() === "strict",
          );
          (button as HTMLButtonElement | undefined)?.click();
        });
        await pageHandle.page
          .locator(
            '[role="dialog"][aria-label="Confirm supervisor default change"]',
          )
          .waitFor({ state: "visible", timeout: 10_000 });

        const putRequestPromise = pageHandle.page.waitForRequest(
          (req) =>
            req.method() === "PUT" &&
            req.url().includes("/v1/uix/preferences"),
          { timeout: 5_000 },
        );
        const requestsBeforeConfirm = allApiRequests.length;
        await pageHandle.page.evaluate(() => {
          const dialog = document.querySelector(
            '[role="dialog"][aria-label="Confirm supervisor default change"]',
          );
          const saveButton = Array.from(
            dialog?.querySelectorAll("button") ?? [],
          ).find((b) => (b.textContent ?? "").trim() === "Save");
          (saveButton as HTMLButtonElement | undefined)?.click();
        });
        const putRequest = await putRequestPromise;
        const putBody = JSON.parse(putRequest.postData() ?? "{}");
        expect(putBody.preferences).toBeInstanceOf(Array);
        expect(putBody.preferences).toHaveLength(1);
        expect(putBody.preferences[0].category).toBe("uix");
        expect(putBody.preferences[0].key).toBe(
          "task_workflow_supervisor_mode_default",
        );
        expect(putBody.preferences[0].value).toBe("strict");

        await pageHandle.page.waitForFunction(
          () => {
            const heading = Array.from(document.querySelectorAll("h2")).find(
              (node) => (node.textContent ?? "").trim() === "Default supervisor mode",
            );
            const section = heading?.closest("section");
            const match = (section?.textContent ?? "").match(
              /Current:\s*(off|light|standard|strict)/,
            );
            return match?.[1] === "strict";
          },
          undefined,
          { timeout: 5_000 },
        );

        const requestsAfterConfirm = allApiRequests.slice(requestsBeforeConfirm);
        const memoryWritesAfterConfirm = requestsAfterConfirm.filter(
          (r) =>
            (r.method === "POST" ||
              r.method === "PUT" ||
              r.method === "PATCH" ||
              r.method === "DELETE") &&
            (r.url.includes("/v1/memory") ||
              r.url.match(/\/v1\/memor(y|ies)/) !== null),
        );
        expect(memoryWritesAfterConfirm).toHaveLength(0);
      },
    );
  },
);
