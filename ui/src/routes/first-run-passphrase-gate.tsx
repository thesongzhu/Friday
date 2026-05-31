import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { postBootstrapLocalPassphrase } from "@/lib/api/auth";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

/** Backend minimum for the local passphrase (POST /v1/auth/bootstrap/local-passphrase). */
const MIN_PASSPHRASE_LENGTH = 12;

/**
 * First-run local security gate. Shown when the backend is reachable, the user is not
 * authenticated, and `/v1/auth/bootstrap/status` reports `bootstrapRequired: true`.
 *
 * This is NOT a connection-failure screen — it is the one-time local security setup for
 * THIS machine's Friday. It creates a local passphrase, then logs in, then hands control
 * back to the existing SetupGate (which routes to /setup when `needsSetup: true`).
 *
 * Never logs the passphrase or any token.
 */
export function FirstRunPassphraseGate() {
  const { locale } = useAppLocale();
  const { login } = useAuth();
  const queryClient = useQueryClient();

  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = confirm.length > 0 && passphrase !== confirm;
  const canSubmit =
    passphrase.length >= MIN_PASSPHRASE_LENGTH && passphrase === confirm && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // Client-side validation — never create a session on invalid input.
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(
        localize(
          locale,
          `本机口令至少需要 ${String(MIN_PASSPHRASE_LENGTH)} 个字符。`,
          `Local passphrase must be at least ${String(MIN_PASSPHRASE_LENGTH)} characters.`,
        ),
      );
      return;
    }
    if (passphrase !== confirm) {
      setError(localize(locale, "两次输入的口令不一致。", "The passphrases do not match."));
      return;
    }

    setSubmitting(true);
    try {
      // 1) Create the local passphrase (first-boot only, loopback only).
      await postBootstrapLocalPassphrase({ passphrase });
      // 2) Log in with it so the existing SetupGate can take over.
      await login({ localPassphrase: passphrase });
      // 3) Refresh bootstrap status so RequireAuth re-evaluates and SetupGate routes to /setup.
      await queryClient.invalidateQueries({ queryKey: ["auth", "bootstrap", "status"] });
    } catch (err) {
      // Surface a user-facing message; do NOT echo the passphrase.
      const message = err instanceof Error ? err.message : "Setup failed";
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
          <span style={{ fontSize: "13px", letterSpacing: "0.08em", textTransform: "uppercase", color: "#888" }}>Friday</span>
          <h1 style={{ margin: 0, fontSize: "22px" }}>{localize(locale, "创建本机口令", "Create local passphrase")}</h1>
          <p style={{ margin: 0, color: "#666", fontSize: "14px", lineHeight: 1.5 }}>
            {localize(
              locale,
              "这是本机 Friday 的一次性本地安全设置，不是连接失败。设置口令后即可继续完成 setup。",
              "This is the one-time local security setup for Friday on this machine — not a connection failure. Set a passphrase to continue to setup.",
            )}
          </p>
        </div>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder={localize(locale, "本机口令", "Local passphrase")}
            autoFocus
            autoComplete="new-password"
            aria-label={localize(locale, "本机口令", "Local passphrase")}
            style={{ padding: "10px 12px", borderRadius: "8px", border: "1px solid #ccc", fontSize: "14px" }}
          />
          <input
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            placeholder={localize(locale, "确认本机口令", "Confirm passphrase")}
            autoComplete="new-password"
            aria-label={localize(locale, "确认本机口令", "Confirm passphrase")}
            style={{ padding: "10px 12px", borderRadius: "8px", border: "1px solid #ccc", fontSize: "14px" }}
          />
          {tooShort ? (
            <p style={{ margin: 0, color: "#c0392b", fontSize: "13px" }}>
              {localize(
                locale,
                `本机口令至少需要 ${String(MIN_PASSPHRASE_LENGTH)} 个字符。`,
                `Local passphrase must be at least ${String(MIN_PASSPHRASE_LENGTH)} characters.`,
              )}
            </p>
          ) : null}
          {mismatch ? (
            <p style={{ margin: 0, color: "#c0392b", fontSize: "13px" }}>
              {localize(locale, "两次输入的口令不一致。", "The passphrases do not match.")}
            </p>
          ) : null}
          {error ? <p style={{ margin: 0, color: "#c0392b", fontSize: "13px" }}>{error}</p> : null}
          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              border: "none",
              background: "#111",
              color: "#fff",
              fontSize: "14px",
              cursor: canSubmit ? "pointer" : "not-allowed",
              opacity: canSubmit ? 1 : 0.6,
            }}
          >
            {submitting
              ? localize(locale, "正在创建…", "Creating…")
              : localize(locale, "创建口令并继续", "Create passphrase and continue")}
          </button>
        </form>
      </div>
    </div>
  );
}
