import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

/**
 * SEC-SETUP-BOOTSTRAP-001 (CR-1) — first-run DEVICE-BOUND owner gate.
 *
 * Shown when the backend reports `bootstrapRequired: true` AND
 * `deviceClaimAvailable: true` (device-owner authority is enabled — which requires
 * the native-IPC attestation precondition). It binds THIS machine's owner slot to a
 * device key and logs in by proving possession of that key — no passphrase.
 *
 * HONESTY: this gate NEVER fabricates attestation. If the device-key capability is
 * unavailable in this context it FAILS CLOSED with a clear message and does NOT
 * silently fall back to the passphrase path as the authoritative one. Minting a
 * session still requires the backend's native-IPC precondition; if the backend
 * refuses, the error is surfaced (not papered over).
 *
 * Never logs any key material or token.
 */
export function FirstRunDeviceClaimGate() {
  const { locale } = useAppLocale();
  const { deviceOwnerLogin, deviceKeyAvailable } = useAuth();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleClaim() {
    setError(null);
    if (!deviceKeyAvailable) {
      // Fail closed — do NOT fabricate a device key or silently use passphrase.
      setError(
        localize(
          locale,
          "此环境不支持设备安全密钥（需要安全上下文）。请在受支持的本机入口中打开 Friday 后重试。",
          "Device security keys are not available in this context (a secure context is required). Reopen Friday from a supported local entrypoint and retry.",
        ),
      );
      return;
    }
    setSubmitting(true);
    try {
      // 1) Generate/get the device key, claim the owner slot, and log in by PoP.
      await deviceOwnerLogin();
      // 2) Refresh bootstrap status so RequireAuth re-evaluates and SetupGate routes on.
      await queryClient.invalidateQueries({ queryKey: ["auth", "bootstrap", "status"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Device setup failed";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: "16px",
        fontFamily: "system-ui, sans-serif",
        padding: "24px",
      }}
    >
      <div style={{ width: "100%", maxWidth: "380px", display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontSize: "13px", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)" }}>Friday</span>
          <h1 style={{ margin: 0, fontSize: "22px" }}>{localize(locale, "绑定本机设备所有者", "Bind this device as owner")}</h1>
          <p style={{ margin: 0, color: "var(--muted)", fontSize: "14px", lineHeight: 1.5 }}>
            {localize(
              locale,
              "这是本机 Friday 的一次性本地安全设置。Friday 会在本设备生成一把安全密钥并绑定为所有者，之后用它证明身份，无需口令。",
              "This is the one-time local security setup for Friday on this machine. Friday generates a security key on this device and binds it as the owner, then proves your identity with it — no passphrase.",
            )}
          </p>
        </div>
        {!deviceKeyAvailable ? (
          <p style={{ margin: 0, color: "var(--danger)", fontSize: "13px" }}>
            {localize(
              locale,
              "此环境不支持设备安全密钥。请在受支持的本机入口中打开 Friday。",
              "Device security keys are not available here. Open Friday from a supported local entrypoint.",
            )}
          </p>
        ) : null}
        {error ? <p style={{ margin: 0, color: "var(--danger)", fontSize: "13px" }}>{error}</p> : null}
        <button
          type="button"
          onClick={() => void handleClaim()}
          disabled={submitting}
          aria-label={localize(locale, "绑定本机设备并继续", "Bind this device and continue")}
          style={{
            padding: "10px 12px",
            borderRadius: "8px",
            border: "none",
            background: "var(--ink)",
            color: "var(--paper-strong)",
            fontSize: "14px",
            cursor: submitting ? "not-allowed" : "pointer",
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting
            ? localize(locale, "正在绑定设备…", "Binding device…")
            : localize(locale, "绑定本机设备并继续", "Bind this device and continue")}
        </button>
      </div>
    </div>
  );
}
