//! Step-3 — setup-readiness blocker labels (truth-labeled).
//!
//! The runtime analog of the file-57 external-preparation checklist: a queryable readiness
//! surface where every external/operator prep item is `Ready { evidence }` ONLY when verified,
//! and otherwise `NotReady { blocker }` with its exact blocker — **never falsely "ready"**.
//! Sealed construction enforces the truth-label invariant by type: a `Ready` MUST carry
//! non-empty evidence; a `NotReady` MUST carry a non-empty blocker. So this surface cannot
//! report a fake-ready item, and [`SetupReadiness::is_release_ready`] is `true` ONLY when every
//! item is genuinely Ready (honest: it is `false` in this build — v1 NO-GO).
//!
//! Read-only / non-side-effecting: it composes cheap, safe signals (env-var PRESENCE — never
//! the value) + truth-labeled "awaiting operator" defaults. It does NOT run provider CLIs or
//! other side-effecting probes (those would go through the mutating-action gate).

/// A prep item's readiness — truth-labeled. Construct via [`ReadinessStatus::ready`] /
/// [`ReadinessStatus::not_ready`], which enforce non-empty evidence / blocker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadinessStatus {
    Ready { evidence: String },
    NotReady { blocker: String },
}

impl ReadinessStatus {
    /// Ready with the evidence that verified it. Panics on empty evidence — a `Ready` without
    /// evidence would be a fake-ready, which this surface forbids.
    pub fn ready(evidence: impl Into<String>) -> Self {
        let evidence = evidence.into();
        assert!(
            !evidence.trim().is_empty(),
            "a Ready status MUST carry non-empty evidence (no fake-ready)"
        );
        ReadinessStatus::Ready { evidence }
    }
    /// Not ready, with the exact blocker. Panics on an empty blocker (no untruth-labeled stub).
    pub fn not_ready(blocker: impl Into<String>) -> Self {
        let blocker = blocker.into();
        assert!(
            !blocker.trim().is_empty(),
            "a NotReady status MUST carry a non-empty exact blocker"
        );
        ReadinessStatus::NotReady { blocker }
    }
    pub fn is_ready(&self) -> bool {
        matches!(self, ReadinessStatus::Ready { .. })
    }
}

/// One external/operator preparation item (a row of the file-57 checklist), with its
/// truth-labeled readiness.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrepItem {
    pub id: &'static str,
    pub category: &'static str,
    pub status: ReadinessStatus,
}

/// The setup-readiness surface: the file-57 prep items + their truth-labeled status.
#[derive(Clone, Debug)]
pub struct SetupReadiness {
    items: Vec<PrepItem>,
}

/// The file-57 prep items, each with its exact blocker as the default (un-prepared) state.
const PREP_BLOCKERS: &[(&str, &str, &str)] = &[
    (
        "deepseek_key",
        "providers",
        "FRIDAY_DEEPSEEK_API_KEY not present in env",
    ),
    (
        "claude_auth",
        "providers",
        "Claude (Anthropic) OAuth/CLI login not present (operator)",
    ),
    (
        "codex_auth",
        "providers",
        "Codex (OpenAI) OAuth/CLI login not present (operator)",
    ),
    (
        "telegram_bot",
        "channels",
        "Telegram bot token + channel not configured (operator)",
    ),
    (
        "discord_lark_feishu",
        "channels",
        "Discord/Lark/Feishu lane not selected/configured",
    ),
    (
        "ios_simulator",
        "devices",
        "iOS simulator build/boot/screenshot not run",
    ),
    (
        "ios_physical_device",
        "devices",
        "physical iPhone + provisioning not available (operator)",
    ),
    (
        "android_emulator",
        "devices",
        "Android emulator build/boot/screenshot not run",
    ),
    (
        "android_physical_device",
        "devices",
        "physical Android device not available (operator)",
    ),
    (
        "hub_phone_sync",
        "devices",
        "real LAN/Tailscale Hub↔phone pairing + sync not available",
    ),
    (
        "desktop_permissions",
        "local",
        "desktop local permissions + secret-entry not granted (operator)",
    ),
    (
        "browser_system_control",
        "local",
        "browser/desktop/system control permissions not granted (operator)",
    ),
    (
        "media_accounts",
        "local",
        "media/OCR/TTS/PDF provider accounts not configured",
    ),
    (
        "npm_release",
        "release",
        "npm/source publish + version tag + GitHub release not approved (operator)",
    ),
    (
        "desktop_distribution",
        "release",
        "desktop app / Homebrew cask / notarized macOS distribution not set up",
    ),
];

impl SetupReadiness {
    /// The honest baseline: every file-57 prep item `NotReady` with its exact blocker (nothing
    /// is operator-prepared by default). `is_release_ready()` is therefore `false` until items
    /// are individually verified Ready.
    pub fn baseline() -> Self {
        let items = PREP_BLOCKERS
            .iter()
            .map(|(id, cat, blk)| PrepItem {
                id,
                category: cat,
                status: ReadinessStatus::not_ready(*blk),
            })
            .collect();
        Self { items }
    }

    /// Apply cheap, SAFE auto-detection: flip `deepseek_key` to Ready iff the DeepSeek key env
    /// var is PRESENT (presence only — the value is never read/logged). `present` is supplied so
    /// the logic is pure/testable; [`SetupReadiness::detect_env`] passes the real env check.
    pub fn detect_with(&mut self, deepseek_key_present: bool) {
        if deepseek_key_present {
            self.mark_ready(
                "deepseek_key",
                "FRIDAY_DEEPSEEK_API_KEY present in env (presence-checked; value never read)",
            );
        }
    }

    /// [`SetupReadiness::detect_with`] using the real env (presence of `FRIDAY_DEEPSEEK_API_KEY`,
    /// never its value).
    pub fn detect_env(&mut self) {
        let present = std::env::var_os("FRIDAY_DEEPSEEK_API_KEY")
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        self.detect_with(present);
    }

    /// Mark a prep item Ready WITH the evidence that verified it (no fake-ready — evidence is
    /// enforced non-empty by [`ReadinessStatus::ready`]). No-op for an unknown id.
    pub fn mark_ready(&mut self, id: &str, evidence: impl Into<String>) {
        let evidence = evidence.into();
        if let Some(item) = self.items.iter_mut().find(|i| i.id == id) {
            item.status = ReadinessStatus::ready(evidence);
        }
    }

    pub fn get(&self, id: &str) -> Option<&PrepItem> {
        self.items.iter().find(|i| i.id == id)
    }

    pub fn items(&self) -> &[PrepItem] {
        &self.items
    }

    /// The not-ready items (the active blockers).
    pub fn blockers(&self) -> Vec<&PrepItem> {
        self.items.iter().filter(|i| !i.status.is_ready()).collect()
    }

    /// Release-ready ONLY when EVERY prep item is genuinely Ready. Honest: `false` in this
    /// build (most items await operator prep) — a true result is the release-gate's prep half.
    pub fn is_release_ready(&self) -> bool {
        self.items.iter().all(|i| i.status.is_ready())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baseline_is_all_not_ready_with_blockers_not_release_ready() {
        let r = SetupReadiness::baseline();
        assert!(!r.items().is_empty());
        // every item NotReady with a non-empty exact blocker (no fake-ready, no empty label)
        for item in r.items() {
            match &item.status {
                ReadinessStatus::NotReady { blocker } => assert!(!blocker.trim().is_empty()),
                ReadinessStatus::Ready { .. } => {
                    panic!("baseline must be all NotReady: {}", item.id)
                }
            }
        }
        // honest v1: not release-ready (nothing operator-prepared by default)
        assert!(!r.is_release_ready());
        assert_eq!(r.blockers().len(), r.items().len());
    }

    #[test]
    fn detect_env_presence_flips_deepseek_only_value_never_read() {
        let mut present = SetupReadiness::baseline();
        present.detect_with(true);
        assert!(present.get("deepseek_key").unwrap().status.is_ready());
        // detecting presence does not make the product release-ready (other items still blocked)
        assert!(!present.is_release_ready());

        let mut absent = SetupReadiness::baseline();
        absent.detect_with(false);
        assert!(!absent.get("deepseek_key").unwrap().status.is_ready());
    }

    #[test]
    fn mark_ready_flips_one_with_evidence_unknown_id_is_noop() {
        let mut r = SetupReadiness::baseline();
        r.mark_ready(
            "telegram_bot",
            "operator configured bot @fridaybot + token verified",
        );
        let item = r.get("telegram_bot").unwrap();
        match &item.status {
            ReadinessStatus::Ready { evidence } => {
                assert!(evidence.contains("operator configured"))
            }
            other => panic!("expected Ready, got {other:?}"),
        }
        // still not release-ready (the rest are blocked) — honest
        assert!(!r.is_release_ready());
        // unknown id is a no-op (no fabricated item)
        r.mark_ready("does_not_exist", "x");
        assert!(r.get("does_not_exist").is_none());
    }

    #[test]
    #[should_panic(expected = "non-empty evidence")]
    fn ready_without_evidence_is_rejected_no_fake_ready() {
        let _ = ReadinessStatus::ready("   ");
    }

    #[test]
    #[should_panic(expected = "non-empty exact blocker")]
    fn not_ready_without_blocker_is_rejected() {
        let _ = ReadinessStatus::not_ready("");
    }

    #[test]
    fn release_ready_only_when_all_items_verified() {
        let mut r = SetupReadiness::baseline();
        // mark EVERY item ready (operator did everything) → release-ready half satisfied.
        let ids: Vec<&'static str> = r.items().iter().map(|i| i.id).collect();
        for id in ids {
            r.mark_ready(id, "verified");
        }
        assert!(r.is_release_ready());
        assert!(r.blockers().is_empty());
        // one regression → not release-ready (a single un-prepared item blocks).
        r.items[0].status = ReadinessStatus::not_ready("regressed");
        assert!(!r.is_release_ready());
    }
}
