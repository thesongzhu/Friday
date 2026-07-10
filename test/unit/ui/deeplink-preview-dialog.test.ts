import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeepLinkPreviewDialog } from "../../../ui/src/components/deeplink/deeplink-preview-dialog";

const DEEPLINK_DIALOG_SOURCE = "ui/src/components/deeplink/deeplink-preview-dialog.tsx";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  onApplied: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: mocks.post,
  },
}));

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushCycles(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await flush();
  }
}

async function waitFor<T>(factory: () => T, predicate: (value: T) => boolean, attempts = 20): Promise<T> {
  for (let index = 0; index < attempts; index += 1) {
    const value = factory();
    if (predicate(value)) {
      return value;
    }
    await act(async () => {
      await flushCycles();
    });
  }
  return factory();
}

function defineGlobal<K extends keyof typeof globalThis>(key: K, value: (typeof globalThis)[K]): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

function getReactProps<T extends HTMLElement>(element: T): Record<string, unknown> {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey ? (element as unknown as Record<string, Record<string, unknown>>)[propsKey] : undefined;
  if (!props) {
    throw new Error("React props were not attached");
  }
  return props;
}

function triggerTextAreaChange(input: HTMLTextAreaElement, value: string): void {
  input.value = value;
  const props = getReactProps(input);
  const onChange = props.onChange;
  if (typeof onChange !== "function") {
    throw new Error("React textarea change handler was not attached");
  }
  onChange({ target: input });
}

function clickButton(button: HTMLButtonElement): void {
  const props = getReactProps(button);
  const onClick = props.onClick;
  if (typeof onClick !== "function") {
    throw new Error("React button click handler was not attached");
  }
  onClick({ stopPropagation: () => undefined });
}

describe("DeepLinkPreviewDialog", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let queryClient: QueryClient;
  let currentPath = "";
  let previousWindow: typeof globalThis.window | undefined;
  let previousDocument: typeof globalThis.document | undefined;
  let previousNavigator: typeof globalThis.navigator | undefined;
  let previousHTMLElement: typeof globalThis.HTMLElement | undefined;
  let previousEvent: typeof globalThis.Event | undefined;

  function LocationProbe() {
    const location = useLocation();
    currentPath = `${location.pathname}${location.search}`;
    return null;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    currentPath = "/start";

    const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
    previousWindow = globalThis.window;
    previousDocument = globalThis.document;
    previousNavigator = globalThis.navigator;
    previousHTMLElement = globalThis.HTMLElement;
    previousEvent = globalThis.Event;

    defineGlobal("window", window as unknown as typeof globalThis.window);
    defineGlobal("document", window.document as unknown as typeof globalThis.document);
    defineGlobal("navigator", window.navigator as unknown as typeof globalThis.navigator);
    defineGlobal("HTMLElement", window.HTMLElement as unknown as typeof globalThis.HTMLElement);
    defineGlobal("Event", window.Event as unknown as typeof globalThis.Event);

    container = window.document.getElementById("root") as HTMLElement;
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
        await flushCycles();
      });
    }
    queryClient.clear();
    defineGlobal("window", previousWindow as typeof globalThis.window);
    defineGlobal("document", previousDocument as typeof globalThis.document);
    defineGlobal("navigator", previousNavigator as typeof globalThis.navigator);
    defineGlobal("HTMLElement", previousHTMLElement as typeof globalThis.HTMLElement);
    defineGlobal("Event", previousEvent as typeof globalThis.Event);
  });

  it("keeps advisory and inline-code chrome on selected Friday tokens", () => {
    const source = readFileSync(DEEPLINK_DIALOG_SOURCE, "utf8");

    expect(source).not.toContain("bg-blue-100");
    expect(source).not.toContain("text-blue-600");
    expect(source).not.toContain("bg-zinc-100");

    expect(source).toContain("bg-[color:var(--color-accent-soft)]");
    expect(source).toContain("text-[color:var(--color-accent)]");
    expect(source).toContain("bg-[color:var(--color-bg-subtle)]");
  });

  it("imports a workflow-template draft and navigates to the returned builder route", async () => {
    const payload = {
      version: 1,
      type: "workflow-template",
      label: "External Workflow Template",
      workflowTemplate: {
        url: "https://example.com/workflows/template.json",
      },
    };
    const resourceUrl = "/workflows/builder?workflowId=workflow-1&draftId=draft-1&focus=draft";
    mocks.post.mockImplementation((path: string, body: unknown) => {
      if (path === "/v1/deeplink/preview") {
        return Promise.resolve({
          preview: {
            valid: true,
            verdict: "ready",
            checks: [],
            permissionSummary: ["Will import an external workflow template as a draft."],
            payload: {
              type: "workflow-template",
              label: "External Workflow Template",
            },
          },
        });
      }
      if (path === "/v1/deeplink/apply") {
        expect(body).toEqual({
          payload,
          confirmed: true,
        });
        return Promise.resolve({
          result: {
            applied: true,
            resourceType: "workflow-template",
            resourceId: "draft-1",
            workflowId: "workflow-1",
            resourceUrl,
            message: "Imported workflow template as draft.",
          },
        });
      }
      throw new Error(`Unexpected deeplink path: ${path}`);
    });

    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/start"] },
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(LocationProbe),
            createElement(DeepLinkPreviewDialog, {
              onClose: vi.fn(),
              onApplied: mocks.onApplied,
            }),
          ),
        ),
      );
      await flushCycles();
    });

    const textarea = container?.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    await act(async () => {
      triggerTextAreaChange(textarea!, JSON.stringify(payload));
      await flushCycles();
    });

    const previewButton = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Preview"),
    ) as HTMLButtonElement | undefined;
    expect(previewButton).toBeDefined();
    await act(async () => {
      clickButton(previewButton!);
      await flushCycles();
    });
    await waitFor(
      () => container?.textContent ?? "",
      (value) => value.includes("Import Draft"),
    );

    const importButton = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Import Draft"),
    ) as HTMLButtonElement | undefined;
    expect(importButton).toBeDefined();
    expect(importButton!.disabled).toBe(false);
    await act(async () => {
      clickButton(importButton!);
      await flushCycles();
    });

    await waitFor(() => currentPath, (value) => value === resourceUrl);
    expect(currentPath).toBe(resourceUrl);
    expect(mocks.post).toHaveBeenCalledWith("/v1/deeplink/preview", { payload });
    expect(mocks.post).toHaveBeenCalledWith("/v1/deeplink/apply", { payload, confirmed: true });
    expect(mocks.onApplied).toHaveBeenCalledTimes(1);
  });
});
