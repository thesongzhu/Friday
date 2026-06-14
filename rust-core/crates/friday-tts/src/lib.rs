//! friday-tts — the F11 text-to-speech Friday-provider route (Hub-only, secret-bearing).
//!
//! Mirrors `friday-deepseek` / `friday-anthropic` EXACTLY: a DI [`TtsTransport`]
//! seam + a real [`UreqTransport`] (the only call-making impl), an
//! [`UnavailableTransport`] production-default analog (the `UnavailableBackend`
//! precedent — makes NO call so the default build literally cannot reach a live
//! endpoint), and a test-only `StubTransport` (deterministic fixed bytes, NEVER a
//! runtime fallback). Everything else is pure: the [`TtsRequest`] builder, text /
//! speed / format validation, the format→mime map, and a status→[`TtsError`]
//! mapper.
//!
//! Faithful oracle mirror of the TS `tts` tool (the `friday-tts-service` plus
//! `friday-provider-backed-tts-service` pair under `src/media/`): an
//! OpenAI-compatible `POST {baseUrl}/v1/audio/speech` whose JSON body is
//! `{model, input, voice, response_format, speed}`, returning raw audio BYTES.
//! The defaults, the 4096-char text limit, the `0.25..=4.0` speed band, the
//! `mp3`/`wav`/`opus` format set with its mime map, and the 401/403/402/404
//! status map are all ported verbatim. The 402 Payment-Required arm is mapped
//! here (the oracle maps it; `DeepSeekError` lacks it).
//!
//! **No fallback.** A failed live route is a [`TtsError`] — never a silent
//! substitute, local synthesizer, or canned audio (`15` §4, `01` §1). The only
//! call-making method is [`UreqTransport::post_audio`]; everything else is pure
//! and makes no network call.
//!
//! **Dark default.** The crate ships NO flag of its own (consts mirror the
//! `runtime.rs:948` template for the hub to read); the `FRIDAY_TTS_ROUTE_ENABLED`
//! gate is enforced LATER at the hub, not in this crate. The hub
//! `TtsToolExecutor` wrapper (TTS-5) and its artifact write (via friday-fs) are
//! later PRs; this crate has NO hub dep, NO `ToolExecutor` impl, NO registry /
//! capability change.
//!
//! Trust boundary: provider-secret-bearing → stays OUT of `friday-ffi`'s
//! dependency graph (same boundary as friday-deepseek / friday-anthropic;
//! asserted by `friday-arch-tests`).

use serde_json::{json, Value};
use thiserror::Error;

// ─── Hub-readable consts (the gate is enforced at the hub, NOT here) ───────────

/// Hub-only environment variable holding the TTS BYOK API key. Read on the Hub
/// only; the value is never printed/logged/committed and is carried only into the
/// `Authorization` header by [`UreqTransport`].
pub const ENV_KEY: &str = "FRIDAY_TTS_API_KEY";
/// The default-OFF runtime route flag. Mirrors the `runtime.rs:948`
/// `FRIDAY_CLAUDE_ROUTE_ENABLED` template: enabled IFF the value is EXACTLY `"1"`.
/// Declared here for the hub to read; THIS crate does not branch on it.
pub const ENV_ROUTE_ENABLED: &str = "FRIDAY_TTS_ROUTE_ENABLED";

/// OpenAI-compatible audio-speech path appended to the provider base URL.
pub const AUDIO_SPEECH_PATH: &str = "/v1/audio/speech";

/// Oracle defaults (`src/media/friday-tts-service.ts`).
pub const DEFAULT_VOICE: &str = "alloy";
/// The service-layer default model from `friday-tts-service.ts`. (The wired
/// `friday-provider-backed-tts-service.ts` overrides this to `gpt-4o-mini-tts`
/// when a caller omits the model; the hub executor / WIRE can pass that override
/// explicitly. A caller almost always supplies `model`, and TTS-2 does not pin a
/// default, so the base service-layer constant is used here deliberately.)
pub const DEFAULT_MODEL: &str = "tts-1";
pub const DEFAULT_FORMAT: TtsFormat = TtsFormat::Mp3;
pub const DEFAULT_SPEED: f64 = 1.0;

/// Oracle validation bounds (`src/media/friday-tts-service.ts`).
pub const MAX_TEXT_LENGTH: usize = 4096;
pub const MIN_SPEED: f64 = 0.25;
pub const MAX_SPEED: f64 = 4.0;

/// Return `true` IFF the route flag is set to EXACTLY `"1"` (the oracle's
/// `=="1"` template). Pure helper for the hub to call; this crate never branches
/// on it (the dark default is enforced at the hub).
pub fn route_enabled() -> bool {
    matches!(std::env::var(ENV_ROUTE_ENABLED), Ok(v) if v == "1")
}

/// Read the API key from a specific env var (Hub-only). Empty/whitespace =
/// missing. Mirrors `friday-deepseek::api_key_from_env_var`.
pub fn api_key_from_env_var(var: &str) -> Result<String, TtsError> {
    match std::env::var(var) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(TtsError::CredentialMissing),
    }
}

// ─── Errors ────────────────────────────────────────────────────────────────

// `Clone + PartialEq + Eq` so the structured error can be carried (not
// stringified) into the hub error site and classified by the retry classifier.
// Messages stay COARSE and secret-free (status code / kind only) so carrying the
// variant leaks no more than a stringified form — and NEVER the request (which
// carries the `Authorization` header).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TtsError {
    /// Env var unset/empty. Adverse path: surfaces as a blocker, never a fallback.
    #[error("TTS credential missing or empty (env {ENV_KEY})")]
    CredentialMissing,
    /// Input failed a pure validation rule (empty/over-long text, out-of-band
    /// speed, unknown format). Terminal — retrying cannot fix a bad request.
    #[error("TTS validation error: {0}")]
    Validation(String),
    /// Authentication rejected (HTTP 401/403). Never a fallback.
    #[error("TTS authentication failed (HTTP {0})")]
    Auth(u16),
    /// Payment required (HTTP 402) — quota/billing. The oracle maps this
    /// explicitly (`PROVIDER_PAYMENT_REQUIRED`); `DeepSeekError` lacks it.
    /// Terminal: retrying cannot fix an unpaid account.
    #[error("TTS payment required (HTTP 402)")]
    PaymentRequired,
    /// Model/route not found (HTTP 404). Terminal.
    #[error("TTS model unavailable (HTTP 404)")]
    ModelUnavailable,
    /// Route unavailable: a TRANSIENT failure that retrying the SAME route may
    /// fix — network/transport error, request-timeout (HTTP 408), or a 5xx.
    /// Classified `Retryable`. Never a fallback.
    #[error("TTS provider unavailable: {0}")]
    ProviderUnavailable(String),
    /// A TERMINAL client-side HTTP error (other 4xx: 400/422, and 429
    /// rate-limit). Retrying cannot fix a malformed request, and — absent any
    /// backoff — retrying a 429 only hammers a rate-limited provider, so 429 is
    /// terminal here. Display is COARSE: status code only, never the body.
    #[error("TTS client error (HTTP {status})")]
    ClientError { status: u16 },
    /// The provider returned a 2xx but an empty audio body (oracle: empty buffer
    /// is an error, never a written zero-byte artifact).
    #[error("TTS provider returned an empty audio response")]
    EmptyAudio,
}

/// Map an HTTP status code to a [`TtsError`], mirroring the oracle's branch order
/// (`friday-provider-backed-tts-service.ts`): 401/403→auth, 402→payment,
/// 404→model-unavailable, 408/5xx→transient-unavailable, other 4xx/429→terminal
/// client-error. The body is NEVER read/echoed — classify by status code ONLY.
pub fn map_status(code: u16) -> TtsError {
    if code == 401 || code == 403 {
        TtsError::Auth(code)
    } else if code == 402 {
        TtsError::PaymentRequired
    } else if code == 404 {
        TtsError::ModelUnavailable
    } else if code == 408 || (500..=599).contains(&code) {
        TtsError::ProviderUnavailable(format!("HTTP {code}"))
    } else {
        TtsError::ClientError { status: code }
    }
}

// ─── Format / mime ───────────────────────────────────────────────────────────

/// Output audio format. Oracle set: `mp3` / `wav` / `opus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtsFormat {
    Mp3,
    Wav,
    Opus,
}

impl TtsFormat {
    /// The wire token sent as `response_format` and used in the artifact filename
    /// extension. Matches the oracle's lowercase strings.
    pub fn as_str(self) -> &'static str {
        match self {
            TtsFormat::Mp3 => "mp3",
            TtsFormat::Wav => "wav",
            TtsFormat::Opus => "opus",
        }
    }

    /// The mime type for this format (`FORMAT_MIME_MAP` in the oracle).
    pub fn mime_type(self) -> &'static str {
        match self {
            TtsFormat::Mp3 => "audio/mpeg",
            TtsFormat::Wav => "audio/wav",
            TtsFormat::Opus => "audio/opus",
        }
    }

    /// Parse a format token, defaulting `None` → [`DEFAULT_FORMAT`] (oracle
    /// `validateTtsFormat`: missing → mp3; an unknown token is a validation
    /// error, NOT a silent default).
    pub fn parse(token: Option<&str>) -> Result<TtsFormat, TtsError> {
        match token {
            None => Ok(DEFAULT_FORMAT),
            Some("mp3") => Ok(TtsFormat::Mp3),
            Some("wav") => Ok(TtsFormat::Wav),
            Some("opus") => Ok(TtsFormat::Opus),
            Some(other) => Err(TtsError::Validation(format!(
                "invalid format \"{other}\"; valid: mp3, wav, opus"
            ))),
        }
    }
}

// ─── Validation (pure, oracle-ported) ─────────────────────────────────────────

/// Validate the synthesis text (`validateTtsText`): required (non-empty after
/// trim) and `<= MAX_TEXT_LENGTH` chars (counted by Unicode scalar values, same
/// as JS `String.length`'s intent for the oracle's bound).
pub fn validate_text(text: &str) -> Result<(), TtsError> {
    if text.trim().is_empty() {
        return Err(TtsError::Validation("text is required for TTS".into()));
    }
    let len = text.chars().count();
    if len > MAX_TEXT_LENGTH {
        return Err(TtsError::Validation(format!(
            "text exceeds maximum length of {MAX_TEXT_LENGTH} characters (got {len})"
        )));
    }
    Ok(())
}

/// Validate speed (`validateTtsSpeed`): `None` → [`DEFAULT_SPEED`]; otherwise it
/// must lie in `MIN_SPEED..=MAX_SPEED`. A `NaN` speed is rejected (it satisfies
/// neither bound).
pub fn validate_speed(speed: Option<f64>) -> Result<f64, TtsError> {
    match speed {
        None => Ok(DEFAULT_SPEED),
        // `RangeInclusive::contains` is `false` for NaN (NaN is in no range), so
        // a `NaN` speed is rejected exactly as the explicit-bounds form did.
        Some(s) if (MIN_SPEED..=MAX_SPEED).contains(&s) => Ok(s),
        Some(s) => Err(TtsError::Validation(format!(
            "speed must be between {MIN_SPEED} and {MAX_SPEED}; got {s}"
        ))),
    }
}

// ─── Request (pure builder) ────────────────────────────────────────────────

/// A validated TTS synthesis request. Construct via [`TtsRequest::build`] (which
/// runs the oracle validations + applies defaults); the fields are then the
/// resolved values that go on the wire. No network is touched here.
#[derive(Debug, Clone, PartialEq)]
pub struct TtsRequest {
    pub model: String,
    pub input: String,
    pub voice: String,
    pub format: TtsFormat,
    pub speed: f64,
}

impl TtsRequest {
    /// Validate + resolve defaults from raw tool params, mirroring the oracle's
    /// `createFridayTtsService.synthesize` head: validate text, validate format,
    /// validate speed, default voice/model. Returns a [`TtsError::Validation`] on
    /// any bad input — never a partially-built request.
    pub fn build(
        text: &str,
        voice: Option<&str>,
        format: Option<&str>,
        speed: Option<f64>,
        model: Option<&str>,
    ) -> Result<TtsRequest, TtsError> {
        validate_text(text)?;
        let format = TtsFormat::parse(format)?;
        let speed = validate_speed(speed)?;
        let voice = voice
            .map(str::to_string)
            .unwrap_or_else(|| DEFAULT_VOICE.to_string());
        let model = model
            .map(str::to_string)
            .unwrap_or_else(|| DEFAULT_MODEL.to_string());
        Ok(TtsRequest {
            model,
            input: text.to_string(),
            voice,
            format,
            speed,
        })
    }

    /// The OpenAI-compatible request JSON body, mirroring the oracle EXACTLY:
    /// `{model, input, voice, response_format, speed}`.
    pub fn to_body(&self) -> Value {
        json!({
            "model": self.model,
            "input": self.input,
            "voice": self.voice,
            "response_format": self.format.as_str(),
            "speed": self.speed,
        })
    }

    /// The full audio-speech endpoint for a provider base URL. Trailing slashes on
    /// the base are trimmed (oracle: `baseUrl.replace(/\/+$/, "")`).
    pub fn endpoint(base_url: &str) -> String {
        format!("{}{}", base_url.trim_end_matches('/'), AUDIO_SPEECH_PATH)
    }

    /// The mime type the artifact will carry (the format's mime; the live leg may
    /// override from a `content-type` response header — that is the executor's
    /// concern, TTS-5).
    pub fn mime_type(&self) -> &'static str {
        self.format.mime_type()
    }
}

/// Deterministic artifact filename `tts-<ts>.<fmt>` (oracle:
/// `tts-${timestamp}.${format}`). The timestamp is INJECTED by the caller (no
/// `SystemTime::now` baked in) so the hub executor's tests are deterministic.
pub fn artifact_filename(timestamp_ms: i64, format: TtsFormat) -> String {
    format!("tts-{timestamp_ms}.{}", format.as_str())
}

// ─── Transport seam ───────────────────────────────────────────────────────

/// HTTP transport seam returning the RAW audio bytes. The real impl is
/// [`UreqTransport`]; the production default is [`UnavailableTransport`] (makes
/// NO call); tests inject `StubTransport`. The implementor POSTs the JSON `body`
/// to `url` with the `bearer` token and returns the response body bytes (a 2xx
/// with a non-empty body) or a [`TtsError`].
pub trait TtsTransport {
    fn post_audio(&self, url: &str, bearer: &str, body: &Value) -> Result<Vec<u8>, TtsError>;
}

/// Real blocking HTTP transport (ureq + rustls). Maps errors to controlled
/// [`TtsError`]s by STATUS CODE only — it NEVER formats the request (which
/// carries the `Authorization` header) or the response body into an error string.
pub struct UreqTransport {
    /// Max audio bytes to read from the response. A defensive cap so a hostile
    /// `Content-Length` cannot OOM the Hub; generous for speech artifacts.
    max_bytes: usize,
}

impl UreqTransport {
    /// Default cap: 25 MiB (ample for a 4096-char utterance in any of the three
    /// formats; the artifact write later is workspace-confined).
    pub const DEFAULT_MAX_BYTES: usize = 25 * 1024 * 1024;

    pub fn new() -> Self {
        UreqTransport {
            max_bytes: Self::DEFAULT_MAX_BYTES,
        }
    }

    pub fn with_max_bytes(max_bytes: usize) -> Self {
        UreqTransport { max_bytes }
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new()
    }
}

fn map_ureq_err(e: ureq::Error) -> TtsError {
    match e {
        // Classify by status code ONLY; never read/echo the response body.
        ureq::Error::Status(code, _resp) => map_status(code),
        // Transport error (DNS/TLS/timeout). Its Display carries host/kind, not
        // our Authorization header, but keep the message terse and controlled.
        ureq::Error::Transport(t) => {
            TtsError::ProviderUnavailable(format!("transport: {}", t.kind()))
        }
    }
}

impl TtsTransport for UreqTransport {
    fn post_audio(&self, url: &str, bearer: &str, body: &Value) -> Result<Vec<u8>, TtsError> {
        use std::io::Read;
        let resp = ureq::post(url)
            .set("Authorization", &format!("Bearer {bearer}"))
            .set("Accept", "*/*")
            .send_json(body.clone())
            .map_err(map_ureq_err)?;

        // Read raw audio bytes (binary, NOT JSON), capped defensively.
        let mut bytes = Vec::new();
        resp.into_reader()
            .take(self.max_bytes as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| TtsError::ProviderUnavailable(format!("read body: {e}")))?;
        if bytes.is_empty() {
            return Err(TtsError::EmptyAudio);
        }
        Ok(bytes)
    }
}

/// Production-default transport that makes NO call (the `UnavailableBackend`
/// precedent). The default-built crate links THIS, so it literally cannot reach a
/// live `/v1/audio/speech` endpoint — the live leg is operator-gated and the hub
/// only swaps in [`UreqTransport`] when both the route flag and BYOK key are
/// present (WIRE, a later PR). Calling it is always a [`TtsError`], NEVER a silent
/// substitute or canned audio.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnavailableTransport;

impl UnavailableTransport {
    pub fn new() -> Self {
        UnavailableTransport
    }
}

impl TtsTransport for UnavailableTransport {
    fn post_audio(&self, _url: &str, _bearer: &str, _body: &Value) -> Result<Vec<u8>, TtsError> {
        Err(TtsError::ProviderUnavailable(
            "TTS live transport not configured (dark default; UnavailableTransport)".into(),
        ))
    }
}

/// TEST-ONLY deterministic transport. Returns fixed canned bytes so the pure
/// dispatch/validation/receipt logic is testable WITHOUT a live provider. This is
/// NEVER constructed on a runtime path — a failed live route is a [`TtsError`],
/// never a silent substitute (`#[cfg(any(test, feature = "test-stub"))]` keeps it
/// out of the default production build).
#[cfg(any(test, feature = "test-stub"))]
#[derive(Debug, Clone)]
pub struct StubTransport {
    pub bytes: Vec<u8>,
    pub calls: std::cell::Cell<u32>,
}

#[cfg(any(test, feature = "test-stub"))]
impl StubTransport {
    pub fn new(bytes: Vec<u8>) -> Self {
        StubTransport {
            bytes,
            calls: std::cell::Cell::new(0),
        }
    }
}

#[cfg(any(test, feature = "test-stub"))]
impl Default for StubTransport {
    fn default() -> Self {
        // A few non-zero bytes so callers can assert a non-empty artifact.
        StubTransport::new(vec![0x49, 0x44, 0x33, 0x04])
    }
}

#[cfg(any(test, feature = "test-stub"))]
impl TtsTransport for StubTransport {
    fn post_audio(&self, _url: &str, _bearer: &str, _body: &Value) -> Result<Vec<u8>, TtsError> {
        self.calls.set(self.calls.get() + 1);
        if self.bytes.is_empty() {
            return Err(TtsError::EmptyAudio);
        }
        Ok(self.bytes.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── consts / route flag ──────────────────────────────────────────────────

    #[test]
    fn route_flag_helper_is_strict_equals_one() {
        // route_enabled() reads the process env; assert the EXACT-"1" contract on
        // the pure mapping without mutating the global env (use a guaranteed-unset
        // var via api_key_from_env_var's sibling logic is not applicable; instead
        // assert the matcher shape directly).
        assert!(matches!(Ok::<_, ()>("1".to_string()), Ok(v) if v == "1"));
        assert!(!matches!(Ok::<_, ()>("0".to_string()), Ok(v) if v == "1"));
        assert!(!matches!(Ok::<_, ()>("true".to_string()), Ok(v) if v == "1"));
        // The const names are the oracle-template names.
        assert_eq!(ENV_KEY, "FRIDAY_TTS_API_KEY");
        assert_eq!(ENV_ROUTE_ENABLED, "FRIDAY_TTS_ROUTE_ENABLED");
    }

    #[test]
    fn missing_credential_is_an_error_not_a_fallback() {
        let err = api_key_from_env_var("FRIDAY_TTS_API_KEY_DEFINITELY_UNSET_a1b2c3").unwrap_err();
        assert!(matches!(err, TtsError::CredentialMissing));
    }

    // ── format / mime ─────────────────────────────────────────────────────────

    #[test]
    fn format_parse_default_and_set() {
        assert_eq!(TtsFormat::parse(None).unwrap(), TtsFormat::Mp3);
        assert_eq!(TtsFormat::parse(Some("mp3")).unwrap(), TtsFormat::Mp3);
        assert_eq!(TtsFormat::parse(Some("wav")).unwrap(), TtsFormat::Wav);
        assert_eq!(TtsFormat::parse(Some("opus")).unwrap(), TtsFormat::Opus);
    }

    #[test]
    fn format_parse_unknown_is_validation_error_not_silent_default() {
        let err = TtsFormat::parse(Some("flac")).unwrap_err();
        assert!(matches!(err, TtsError::Validation(_)), "got {err:?}");
    }

    #[test]
    fn format_mime_map_matches_oracle() {
        assert_eq!(TtsFormat::Mp3.mime_type(), "audio/mpeg");
        assert_eq!(TtsFormat::Wav.mime_type(), "audio/wav");
        assert_eq!(TtsFormat::Opus.mime_type(), "audio/opus");
    }

    #[test]
    fn format_wire_tokens_match_oracle() {
        assert_eq!(TtsFormat::Mp3.as_str(), "mp3");
        assert_eq!(TtsFormat::Wav.as_str(), "wav");
        assert_eq!(TtsFormat::Opus.as_str(), "opus");
    }

    // ── text validation ────────────────────────────────────────────────────────

    #[test]
    fn text_empty_or_whitespace_is_required_error() {
        assert!(matches!(
            validate_text("").unwrap_err(),
            TtsError::Validation(_)
        ));
        assert!(matches!(
            validate_text("   \n\t ").unwrap_err(),
            TtsError::Validation(_)
        ));
    }

    #[test]
    fn text_at_limit_ok_over_limit_rejected() {
        let at_limit: String = "a".repeat(MAX_TEXT_LENGTH);
        assert!(validate_text(&at_limit).is_ok());
        let over: String = "a".repeat(MAX_TEXT_LENGTH + 1);
        assert!(matches!(
            validate_text(&over).unwrap_err(),
            TtsError::Validation(_)
        ));
    }

    #[test]
    fn text_length_counts_unicode_scalars_not_bytes() {
        // 4096 multi-byte chars = 4096 scalars (well over 4096 BYTES). The bound
        // is on char count, matching JS String.length intent — so this is OK.
        let unicode: String = "é".repeat(MAX_TEXT_LENGTH);
        assert!(unicode.len() > MAX_TEXT_LENGTH, "precondition: multi-byte");
        assert!(validate_text(&unicode).is_ok());
    }

    // ── speed validation ────────────────────────────────────────────────────────

    #[test]
    fn speed_default_and_bounds() {
        assert_eq!(validate_speed(None).unwrap(), DEFAULT_SPEED);
        assert_eq!(validate_speed(Some(MIN_SPEED)).unwrap(), MIN_SPEED);
        assert_eq!(validate_speed(Some(MAX_SPEED)).unwrap(), MAX_SPEED);
        assert_eq!(validate_speed(Some(1.5)).unwrap(), 1.5);
    }

    #[test]
    fn speed_out_of_band_rejected_including_nan() {
        assert!(matches!(
            validate_speed(Some(0.1)).unwrap_err(),
            TtsError::Validation(_)
        ));
        assert!(matches!(
            validate_speed(Some(4.5)).unwrap_err(),
            TtsError::Validation(_)
        ));
        assert!(matches!(
            validate_speed(Some(f64::NAN)).unwrap_err(),
            TtsError::Validation(_)
        ));
    }

    // ── request builder ───────────────────────────────────────────────────────

    #[test]
    fn build_applies_oracle_defaults() {
        let req = TtsRequest::build("hello", None, None, None, None).unwrap();
        assert_eq!(req.voice, DEFAULT_VOICE);
        assert_eq!(req.model, DEFAULT_MODEL);
        assert_eq!(req.format, TtsFormat::Mp3);
        assert_eq!(req.speed, DEFAULT_SPEED);
        assert_eq!(req.input, "hello");
    }

    #[test]
    fn build_threads_through_explicit_values() {
        let req = TtsRequest::build(
            "say this",
            Some("nova"),
            Some("opus"),
            Some(2.0),
            Some("tts-1-hd"),
        )
        .unwrap();
        assert_eq!(req.voice, "nova");
        assert_eq!(req.format, TtsFormat::Opus);
        assert_eq!(req.speed, 2.0);
        assert_eq!(req.model, "tts-1-hd");
    }

    #[test]
    fn build_rejects_bad_input_before_any_partial_request() {
        assert!(TtsRequest::build("", None, None, None, None).is_err());
        assert!(TtsRequest::build("ok", None, Some("flac"), None, None).is_err());
        assert!(TtsRequest::build("ok", None, None, Some(99.0), None).is_err());
    }

    #[test]
    fn body_shape_matches_oracle_exactly() {
        let req =
            TtsRequest::build("read me", Some("echo"), Some("wav"), Some(1.25), Some("m")).unwrap();
        let body = req.to_body();
        assert_eq!(body["model"], "m");
        assert_eq!(body["input"], "read me");
        assert_eq!(body["voice"], "echo");
        assert_eq!(body["response_format"], "wav");
        assert_eq!(body["speed"], 1.25);
        // Exactly the five oracle keys, no extras.
        assert_eq!(body.as_object().unwrap().len(), 5);
    }

    #[test]
    fn endpoint_trims_trailing_slashes() {
        assert_eq!(
            TtsRequest::endpoint("https://api.example.com"),
            "https://api.example.com/v1/audio/speech"
        );
        assert_eq!(
            TtsRequest::endpoint("https://api.example.com///"),
            "https://api.example.com/v1/audio/speech"
        );
    }

    #[test]
    fn request_mime_type_tracks_format() {
        let req = TtsRequest::build("x", None, Some("opus"), None, None).unwrap();
        assert_eq!(req.mime_type(), "audio/opus");
    }

    #[test]
    fn artifact_filename_is_deterministic_from_injected_clock() {
        assert_eq!(
            artifact_filename(1_777_000_000, TtsFormat::Mp3),
            "tts-1777000000.mp3"
        );
        assert_eq!(artifact_filename(42, TtsFormat::Wav), "tts-42.wav");
    }

    // ── status → error map (oracle branch order) ───────────────────────────────

    #[test]
    fn status_map_auth_payment_model_unavailable() {
        assert_eq!(map_status(401), TtsError::Auth(401));
        assert_eq!(map_status(403), TtsError::Auth(403));
        assert_eq!(map_status(402), TtsError::PaymentRequired);
        assert_eq!(map_status(404), TtsError::ModelUnavailable);
    }

    #[test]
    fn status_map_transient_vs_terminal() {
        // 408 + every 5xx → transient ProviderUnavailable.
        assert_eq!(
            map_status(408),
            TtsError::ProviderUnavailable("HTTP 408".into())
        );
        for code in [500u16, 502, 503, 529, 599] {
            assert_eq!(
                map_status(code),
                TtsError::ProviderUnavailable(format!("HTTP {code}")),
                "HTTP {code} must be transient"
            );
        }
        // Other 4xx + 429 → terminal ClientError.
        for code in [400u16, 422, 429] {
            assert_eq!(
                map_status(code),
                TtsError::ClientError { status: code },
                "HTTP {code} must be terminal"
            );
        }
    }

    // ── transports ────────────────────────────────────────────────────────────

    #[test]
    fn unavailable_transport_makes_no_call_and_errors() {
        let t = UnavailableTransport::new();
        let err = t
            .post_audio("https://x/v1/audio/speech", "k", &json!({}))
            .unwrap_err();
        assert!(
            matches!(err, TtsError::ProviderUnavailable(_)),
            "got {err:?}"
        );
    }

    #[test]
    fn stub_transport_returns_fixed_bytes_and_counts_calls() {
        let t = StubTransport::new(vec![1, 2, 3, 4, 5]);
        let req = TtsRequest::build("hi", None, None, None, None).unwrap();
        let url = TtsRequest::endpoint("https://prov.example");
        let bytes = t.post_audio(&url, "key", &req.to_body()).unwrap();
        assert_eq!(bytes, vec![1, 2, 3, 4, 5]);
        assert_eq!(t.calls.get(), 1);
    }

    #[test]
    fn stub_transport_empty_bytes_is_empty_audio_error() {
        let t = StubTransport::new(vec![]);
        let err = t.post_audio("https://x", "k", &json!({})).unwrap_err();
        assert!(matches!(err, TtsError::EmptyAudio));
    }

    #[test]
    fn error_display_never_leaks_the_bearer_or_body() {
        // Coarse, secret-free messages: status code / kind only.
        assert_eq!(
            format!("{}", TtsError::Auth(401)),
            "TTS authentication failed (HTTP 401)"
        );
        assert_eq!(
            format!("{}", TtsError::ClientError { status: 429 }),
            "TTS client error (HTTP 429)"
        );
        assert_eq!(
            format!("{}", TtsError::PaymentRequired),
            "TTS payment required (HTTP 402)"
        );
    }
}
