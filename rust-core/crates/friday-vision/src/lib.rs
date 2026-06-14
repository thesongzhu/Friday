//! friday-vision — the `image_analysis` vision route (Hub-only, secret-bearing).
//!
//! Net-new F11 media capability. Mirrors the Friday TS `image_analysis` tool
//! (`src/agent/tools/friday-agent-image-analysis-tool.ts` + helpers): analyze one
//! or more images with a vision-capable, OpenAI-compatible `/chat/completions`
//! endpoint that accepts multimodal message content (text + `image_url` parts).
//!
//! **Critical gap this crate fills:** `friday-deepseek` / `friday-anthropic`
//! `chat()` send `"content": prompt` as a PLAIN STRING — there is NO multimodal
//! message shape in Rust today. This crate defines the multimodal request/response
//! contract behind a DI seam so the dispatch/validation logic is testable WITHOUT
//! a live provider.
//!
//! Shape (matching the existing `friday-deepseek` provider boundary, §0.1 of the
//! F11 plan):
//! - [`VisionModelClient`] — the DI trait the hub executor dispatches to (the
//!   `impl ToolExecutor` wrapper is a `friday-hub` module, NOT in this crate — a
//!   capability crate cannot depend on `friday-hub` without a cycle).
//! - [`transport::UreqVisionTransport`] — the real blocking `ureq` leg: base64-
//!   encodes local image bytes, POSTs the multimodal body, strict-parses the
//!   reply. **No fallback** — a failed route is a [`VisionError`], never a silent
//!   substitute or canned answer.
//! - [`client::HttpVisionModelClient`] — wires a transport + BYOK key into the
//!   trait.
//! - [`client::StubVisionModelClient`] — deterministic test stub with a fixed
//!   analysis and fixed token counts so all upstream logic is unit-testable
//!   offline. NEVER a runtime fallback.
//!
//! **DARK by default.** [`ENV_ROUTE_ENABLED`] / [`route_enabled`] are consts/pure
//! helpers only; the gate is enforced later at the hub (this crate ships no hub
//! dep, no `ToolExecutor`, no registry/capability change).
//!
//! Trust boundary: provider-secret-bearing (BYOK vision-LLM key) → stays OUT of
//! `friday-ffi`'s phone dependency graph (same boundary as friday-deepseek /
//! friday-anthropic; asserted by `friday-arch-tests`).

use thiserror::Error;

pub mod client;
pub mod transport;

pub use client::{HttpVisionModelClient, StubVisionModelClient};
pub use transport::{UreqVisionTransport, VisionTransport};

/// Hub-only environment variable holding the BYOK vision-LLM API key. Read on the
/// Hub only at the operator-gated live wiring (WIRE); never read in this crate's
/// dark path.
pub const ENV_KEY: &str = "FRIDAY_VISION_API_KEY";

/// Default-OFF runtime flag governing hub dispatch of the `image_analysis` tool.
/// CONST ONLY here — the gate is enforced later at the hub (runtime.rs WIRE arm),
/// mirroring the `FRIDAY_CLAUDE_ROUTE_ENABLED` template. The crate carries no
/// gate logic; this const is the single source of the flag's name.
pub const ENV_ROUTE_ENABLED: &str = "FRIDAY_VISION_TOOL_ENABLED";

/// Maximum number of images per analysis request (mirrors the TS oracle's
/// `MAX_IMAGES = 10`).
pub const MAX_IMAGES: usize = 10;

/// Maximum byte size of a base64-source data URI / inline payload (mirrors the
/// TS oracle's `MAX_DATA_URI_BYTES = 20 MiB`). Enforced on `Base64` parts.
pub const MAX_DATA_URI_BYTES: usize = 20 * 1024 * 1024;

/// True iff the route flag is EXACTLY `"1"` — the same default-OFF semantics as
/// the `FRIDAY_CLAUDE_ROUTE_ENABLED` template (`runtime.rs:948`). Pure read of
/// the supplied value; this crate NEVER reads the process environment itself nor
/// enforces the gate (that is the hub's job at WIRE). Provided so the hub wiring
/// has one canonical predicate.
pub fn route_enabled(flag_value: Option<&str>) -> bool {
    flag_value == Some("1")
}

/// Image-detail hint, mirroring the TS oracle's `ImageDetail` (`low | high |
/// auto`, default `auto`). Serializes to the OpenAI-compatible `image_url.detail`
/// field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ImageDetail {
    Low,
    High,
    #[default]
    Auto,
}

impl ImageDetail {
    /// Parse the TS oracle's accepted detail strings. `None`/empty → `Auto`
    /// (matching `validateDetail`); any other value is a [`VisionError::Validation`].
    pub fn parse(value: Option<&str>) -> Result<Self, VisionError> {
        match value {
            None => Ok(ImageDetail::Auto),
            Some(s) => match s {
                "" => Ok(ImageDetail::Auto),
                "low" => Ok(ImageDetail::Low),
                "high" => Ok(ImageDetail::High),
                "auto" => Ok(ImageDetail::Auto),
                other => Err(VisionError::Validation(format!(
                    "invalid detail \"{other}\". Valid: low, high, auto"
                ))),
            },
        }
    }

    /// The wire value for the OpenAI-compatible `image_url.detail` field.
    pub fn as_str(self) -> &'static str {
        match self {
            ImageDetail::Low => "low",
            ImageDetail::High => "high",
            ImageDetail::Auto => "auto",
        }
    }
}

/// One image source for a [`VisionRequest`]. Mirrors the TS oracle's normalized
/// image inputs (`type: "base64" | "url"`), plus a `WorkspacePath` variant for a
/// local file that the HUB executor resolves+reads through
/// `friday_fs::open_read_within_root` BEFORE constructing the request — so this
/// crate never touches the filesystem and the workspace-containment gate stays in
/// the hub executor (VISOCR-EXEC), exactly where `read_file` enforces it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VisionImage {
    /// An HTTP(S) URL passed straight through as an `image_url`. (SSRF/allowed-origin
    /// guarding, if any, is the hub executor's concern; this crate transmits.)
    Url(String),
    /// Already-decoded image bytes + MIME, encoded by the transport into a
    /// `data:<mime>;base64,<...>` `image_url`. Used for both data-URI inputs and
    /// local files the hub already read.
    Base64 { mime: String, data_base64: String },
    /// A workspace-relative path the hub executor will read into `Base64` BEFORE
    /// the live call. This crate does NOT read it (no filesystem dep); a transport
    /// that is handed an unresolved `WorkspacePath` returns a [`VisionError`]
    /// rather than reaching outside its boundary.
    WorkspacePath(String),
}

/// A multimodal vision request. Built by the hub executor from validated tool
/// params and dispatched to a [`VisionModelClient`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisionRequest {
    /// The analysis prompt / question about the image(s).
    pub prompt: String,
    /// 1..=[`MAX_IMAGES`] image sources.
    pub images: Vec<VisionImage>,
    /// Vision model id (`None` → the transport/caller's default).
    pub model: Option<String>,
    /// Detail hint (default [`ImageDetail::Auto`]).
    pub detail: ImageDetail,
    /// Max response tokens (`None` → provider default).
    pub max_tokens: Option<u32>,
}

impl VisionRequest {
    /// Validate the request shape WITHOUT any I/O (no file read, no network).
    /// Mirrors the TS oracle: at least one image, at most [`MAX_IMAGES`], a
    /// non-empty prompt, and each `Base64` payload within [`MAX_DATA_URI_BYTES`].
    /// Returns the (validated) image count so the hub executor can ledger a
    /// refs-only `image_count`.
    pub fn validate(&self) -> Result<usize, VisionError> {
        if self.prompt.trim().is_empty() {
            return Err(VisionError::Validation("prompt is required".into()));
        }
        if self.images.is_empty() {
            return Err(VisionError::Validation(
                "at least one image is required".into(),
            ));
        }
        if self.images.len() > MAX_IMAGES {
            return Err(VisionError::Validation(format!(
                "too many images ({}). Maximum: {MAX_IMAGES}",
                self.images.len()
            )));
        }
        for img in &self.images {
            match img {
                VisionImage::Base64 { data_base64, mime } => {
                    if mime.trim().is_empty() {
                        return Err(VisionError::Validation(
                            "base64 image missing MIME type".into(),
                        ));
                    }
                    if data_base64.len() > MAX_DATA_URI_BYTES {
                        return Err(VisionError::Validation(format!(
                            "image data exceeds maximum size of {MAX_DATA_URI_BYTES} bytes"
                        )));
                    }
                }
                VisionImage::Url(u) => {
                    if u.trim().is_empty() {
                        return Err(VisionError::Validation("image URL is empty".into()));
                    }
                }
                VisionImage::WorkspacePath(p) => {
                    // The hub executor MUST resolve+read this into Base64 before the
                    // call. Reaching the client with an unresolved path is a caller
                    // bug, never a silent file read from inside this crate.
                    return Err(VisionError::UnresolvedImage(p.clone()));
                }
            }
        }
        Ok(self.images.len())
    }
}

/// A vision analysis result (the bits Friday surfaces + ledgers).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisionResponse {
    /// The model's analysis text (read-type, model-facing `content`).
    pub analysis: String,
    /// The model id the response reported (ledger the reported model, not the
    /// requested one, to avoid stale-model claims — same discipline as
    /// `friday-deepseek`).
    pub model: String,
    /// Number of images in the request (refs-only ledger field).
    pub image_count: usize,
    /// Prompt/input tokens, if the provider reported usage.
    pub input_tokens: Option<i64>,
    /// Completion/output tokens, if the provider reported usage.
    pub output_tokens: Option<i64>,
    /// OCR latent-field mirror: the Friday TS oracle has a never-written
    /// `extractedText?` field (zero writers; the actual text mechanism is the
    /// vision LLM). Mirrored here as a latent `None` — this crate is NOT an OCR
    /// engine; the dedicated `ocr` route (friday-ocr) uses an extract-text prompt.
    pub extracted_text: Option<String>,
}

// `Clone + PartialEq + Eq` so the structured error can be carried (not stringified)
// into the hub error site and classified. Messages stay COARSE and secret-free
// (status code / kind only — see `transport::map_ureq_err`), so carrying the
// variant leaks no more than a stringified form would.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum VisionError {
    /// Env var unset/empty at the hub. Adverse path: a blocker, never a fallback.
    #[error("vision credential missing or empty (env {ENV_KEY})")]
    CredentialMissing,
    /// Request shape invalid (bad detail, no/too-many images, oversized payload).
    /// Mirrors the TS oracle's `VALIDATION_ERROR` (HTTP 400 class).
    #[error("vision request invalid: {0}")]
    Validation(String),
    /// A [`VisionImage::WorkspacePath`] reached the client unresolved — the hub
    /// executor must read it into `Base64` first. This crate never reads files.
    #[error("unresolved workspace image path reached the vision client: {0}")]
    UnresolvedImage(String),
    /// Authentication rejected (HTTP 401/403). Never a fallback.
    #[error("vision authentication failed (HTTP {0})")]
    Auth(u16),
    /// TRANSIENT failure that retrying the SAME route may fix — network/transport
    /// error, request-timeout (408), or a server-side 5xx. Never a fallback.
    #[error("vision provider unavailable: {0}")]
    ProviderUnavailable(String),
    /// A TERMINAL client-side HTTP error (other 4xx: 400/404/422 and 429 rate-limit
    /// — no backoff mechanism, so 429 is terminal). Display is COARSE: status code
    /// only, never the response body. Never a fallback.
    #[error("vision client error (HTTP {status})")]
    ClientError { status: u16 },
    /// Response did not match the documented multimodal-completion shape.
    #[error("vision response shape unexpected: {0}")]
    BadResponse(String),
}

/// The dependency-injection seam the hub `VisionToolExecutor` dispatches to. The
/// real impl is [`HttpVisionModelClient`]; tests inject [`StubVisionModelClient`]
/// so the no-hidden-call, no-fallback, and validation logic are provable offline.
pub trait VisionModelClient {
    /// Analyze the images per the prompt. The ONLY call-making method.
    /// **No fallback** — a failed route is a [`VisionError`], never a substitute.
    fn analyze(&self, req: &VisionRequest) -> Result<VisionResponse, VisionError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detail_parses_oracle_values_and_defaults_to_auto() {
        assert_eq!(ImageDetail::parse(None).unwrap(), ImageDetail::Auto);
        assert_eq!(ImageDetail::parse(Some("")).unwrap(), ImageDetail::Auto);
        assert_eq!(ImageDetail::parse(Some("low")).unwrap(), ImageDetail::Low);
        assert_eq!(ImageDetail::parse(Some("high")).unwrap(), ImageDetail::High);
        assert_eq!(ImageDetail::parse(Some("auto")).unwrap(), ImageDetail::Auto);
        assert_eq!(ImageDetail::default(), ImageDetail::Auto);
    }

    #[test]
    fn detail_rejects_unknown_without_leaking() {
        let err = ImageDetail::parse(Some("ultra")).unwrap_err();
        assert!(matches!(err, VisionError::Validation(_)));
        assert!(format!("{err}").contains("ultra"));
    }

    #[test]
    fn detail_wire_strings() {
        assert_eq!(ImageDetail::Low.as_str(), "low");
        assert_eq!(ImageDetail::High.as_str(), "high");
        assert_eq!(ImageDetail::Auto.as_str(), "auto");
    }

    #[test]
    fn route_enabled_only_for_exact_one() {
        assert!(route_enabled(Some("1")));
        assert!(!route_enabled(Some("0")));
        assert!(!route_enabled(Some("true")));
        assert!(!route_enabled(Some(" 1")));
        assert!(!route_enabled(Some("")));
        assert!(!route_enabled(None));
    }

    fn req_with(images: Vec<VisionImage>) -> VisionRequest {
        VisionRequest {
            prompt: "what is in this image?".into(),
            images,
            model: None,
            detail: ImageDetail::Auto,
            max_tokens: None,
        }
    }

    #[test]
    fn validate_accepts_url_and_base64() {
        let r = req_with(vec![
            VisionImage::Url("https://example.com/a.png".into()),
            VisionImage::Base64 {
                mime: "image/png".into(),
                data_base64: "aGVsbG8=".into(),
            },
        ]);
        assert_eq!(r.validate().unwrap(), 2);
    }

    #[test]
    fn validate_rejects_empty_prompt() {
        let mut r = req_with(vec![VisionImage::Url("https://x/a.png".into())]);
        r.prompt = "   ".into();
        assert!(matches!(
            r.validate().unwrap_err(),
            VisionError::Validation(_)
        ));
    }

    #[test]
    fn validate_rejects_zero_images() {
        let r = req_with(vec![]);
        assert!(matches!(
            r.validate().unwrap_err(),
            VisionError::Validation(_)
        ));
    }

    #[test]
    fn validate_rejects_too_many_images() {
        let imgs = (0..MAX_IMAGES + 1)
            .map(|i| VisionImage::Url(format!("https://x/{i}.png")))
            .collect();
        let r = req_with(imgs);
        let err = r.validate().unwrap_err();
        assert!(matches!(err, VisionError::Validation(_)));
        assert!(format!("{err}").contains(&MAX_IMAGES.to_string()));
    }

    #[test]
    fn validate_rejects_oversized_base64() {
        let r = req_with(vec![VisionImage::Base64 {
            mime: "image/png".into(),
            data_base64: "a".repeat(MAX_DATA_URI_BYTES + 1),
        }]);
        assert!(matches!(
            r.validate().unwrap_err(),
            VisionError::Validation(_)
        ));
    }

    #[test]
    fn validate_rejects_base64_missing_mime() {
        let r = req_with(vec![VisionImage::Base64 {
            mime: "  ".into(),
            data_base64: "aGVsbG8=".into(),
        }]);
        assert!(matches!(
            r.validate().unwrap_err(),
            VisionError::Validation(_)
        ));
    }

    #[test]
    fn validate_rejects_unresolved_workspace_path() {
        // A WorkspacePath must be read into Base64 by the hub executor BEFORE the
        // call. Reaching the client with it is a caller bug, surfaced as a clean
        // error — this crate never reads the filesystem.
        let r = req_with(vec![VisionImage::WorkspacePath(".friday/img/a.png".into())]);
        assert!(matches!(
            r.validate().unwrap_err(),
            VisionError::UnresolvedImage(_)
        ));
    }

    #[test]
    fn extracted_text_is_a_latent_none_mirror_not_an_ocr_engine() {
        // The oracle's extractedText is never written; this crate mirrors it as a
        // latent None. The vision response carries analysis, not OCR text.
        let resp = VisionResponse {
            analysis: "a cat".into(),
            model: "vis-1".into(),
            image_count: 1,
            input_tokens: Some(10),
            output_tokens: Some(4),
            extracted_text: None,
        };
        assert!(resp.extracted_text.is_none());
    }
}
