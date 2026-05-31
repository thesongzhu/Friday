import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocaleProvider } from "@/providers/locale-provider";
import { FirstRunPassphraseGate } from "./first-run-passphrase-gate";
import * as authApi from "@/lib/api/auth";

const loginMock = vi.fn();

// Controlled useAuth so we can assert login() wiring without the full provider.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    authError: null,
    login: loginMock,
    logout: vi.fn(),
    retryLocalSession: vi.fn(),
  }),
}));

// Locale-agnostic queries: this component renders localized copy (ZH/EN), so we assert on
// DOM structure + API-mock wiring, never on localized strings.
function renderGate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <FirstRunPassphraseGate />
      </LocaleProvider>
    </QueryClientProvider>,
  );
  const inputs = utils.container.querySelectorAll<HTMLInputElement>('input[type="password"]');
  const form = utils.container.querySelector("form")!;
  const submit = utils.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  return { ...utils, passInput: inputs[0], confirmInput: inputs[1], form, submit };
}

beforeEach(() => {
  loginMock.mockReset();
  loginMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FirstRunPassphraseGate", () => {
  it("renders a create-passphrase form (two password inputs + submit), not a splash", () => {
    const { passInput, confirmInput, submit } = renderGate();
    expect(passInput).toBeTruthy();
    expect(confirmInput).toBeTruthy();
    expect(submit).toBeTruthy();
    // submit is disabled until a valid passphrase is entered (no accidental empty bootstrap)
    expect(submit.disabled).toBe(true);
  });

  it("rejects a too-short passphrase without creating a session", async () => {
    const bootstrapSpy = vi.spyOn(authApi, "postBootstrapLocalPassphrase").mockResolvedValue({
      initialized: true,
      initializedAt: "2026-05-31T00:00:00Z",
      userId: "admin-001",
    });
    const { passInput, confirmInput, form, submit } = renderGate();
    fireEvent.change(passInput, { target: { value: "short" } });
    fireEvent.change(confirmInput, { target: { value: "short" } });
    expect(submit.disabled).toBe(true); // guard: cannot submit a <12-char passphrase
    fireEvent.submit(form);
    await new Promise((r) => setTimeout(r, 20));
    expect(bootstrapSpy).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("blocks submit when confirm passphrase does not match", async () => {
    const bootstrapSpy = vi.spyOn(authApi, "postBootstrapLocalPassphrase").mockResolvedValue({
      initialized: true,
      initializedAt: "2026-05-31T00:00:00Z",
      userId: "admin-001",
    });
    const { passInput, confirmInput, form, submit } = renderGate();
    fireEvent.change(passInput, { target: { value: "correct horse battery" } });
    fireEvent.change(confirmInput, { target: { value: "different value here" } });
    expect(submit.disabled).toBe(true); // guard: mismatch disables submit
    fireEvent.submit(form);
    await new Promise((r) => setTimeout(r, 20));
    expect(bootstrapSpy).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("on a valid passphrase: bootstraps then logs in with the same value", async () => {
    const bootstrapSpy = vi.spyOn(authApi, "postBootstrapLocalPassphrase").mockResolvedValue({
      initialized: true,
      initializedAt: "2026-05-31T00:00:00Z",
      userId: "admin-001",
    });
    const { passInput, confirmInput, form, submit } = renderGate();
    const value = "correct horse battery staple";
    fireEvent.change(passInput, { target: { value } });
    fireEvent.change(confirmInput, { target: { value } });
    expect(submit.disabled).toBe(false); // valid + matching → enabled
    fireEvent.submit(form);
    await waitFor(() => {
      expect(bootstrapSpy).toHaveBeenCalledWith({ passphrase: value });
    });
    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledWith({ localPassphrase: value });
    });
  });
});
