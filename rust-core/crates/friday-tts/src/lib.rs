//! Friday F11 / B5 text-to-speech capability — the model-call seam.
//!
//! This crate is deliberately Hub-side and DARK: it defines the [`TtsClient`] DI
//! trait, an OpenAI-compatible speech request shaper, a fail-closed
//! [`UnavailableTtsClient`] default, and a deterministic [`StubTtsClient`] for
//! functional KATs. It does not register a Hub tool, flip a prod flag, read an
//! operator key, or execute a live provider call by itself.
//!
//! The owning `friday-hub` executor can later validate/govern a tool request and
//! inject a real transport. Until then this crate is a non-live build-DARK seam:
//! flag-OFF behavior is unchanged, while flag-ON tests can prove non-stub
//! request construction and fail-closed behavior without network or secrets.

use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const DEFAULT_OPENAI_TTS_MODEL: &str = "gpt-4o-mini-tts";
pub const DEFAULT_TTS_VOICE: &str = "alloy";
pub const DEFAULT_TTS_FORMAT: TtsFormat = TtsFormat::Mp3;
pub const DEFAULT_TTS_SPEED: f32 = 1.0;
pub const MAX_TTS_TEXT_CHARS: usize = 4096;
pub const MIN_TTS_SPEED: f32 = 0.25;
pub const MAX_TTS_SPEED: f32 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsFormat {
    Mp3,
    Wav,
    Opus,
}

impl TtsFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Wav => "wav",
            Self::Opus => "opus",
        }
    }

    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Mp3 => "audio/mpeg",
            Self::Wav => "audio/wav",
            Self::Opus => "audio/opus",
        }
    }
}

#[derive(Clone, Debug)]
pub struct TtsRequest {
    pub text: String,
    pub voice: Option<String>,
    pub format: Option<TtsFormat>,
    pub speed: Option<f32>,
    pub model: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TtsOutcome {
    pub audio: Vec<u8>,
    pub mime_type: String,
    pub format: TtsFormat,
    pub voice: String,
    pub model: String,
}

#[derive(Debug, thiserror::Error)]
pub enum TtsError {
    #[error("tts request text is required")]
    EmptyText,
    #[error("tts request text exceeds {max} characters (got {got})")]
    TextTooLong { got: usize, max: usize },
    #[error("tts speed must be between {min} and {max} (got {got})")]
    InvalidSpeed { got: f32, min: f32, max: f32 },
    #[error("tts credential missing")]
    CredentialMissing,
    #[error("tts provider unavailable: {0}")]
    Unavailable(String),
    #[error("tts provider error: {0}")]
    Provider(String),
    #[error("tts provider returned empty audio")]
    EmptyAudio,
}

pub trait TtsClient {
    fn synthesize(&self, request: &TtsRequest) -> Result<TtsOutcome, TtsError>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct TtsHttpRequest {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TtsHttpResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

pub trait TtsTransport {
    fn post_audio(&self, request: &TtsHttpRequest) -> Result<TtsHttpResponse, TtsError>;
}

pub struct OpenAiCompatibleTtsClient<T: TtsTransport> {
    transport: T,
    base_url: String,
    api_key: Option<String>,
    default_model: String,
    default_voice: String,
}

impl<T: TtsTransport> OpenAiCompatibleTtsClient<T> {
    pub fn new(transport: T, base_url: impl Into<String>, api_key: Option<String>) -> Self {
        Self {
            transport,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key,
            default_model: DEFAULT_OPENAI_TTS_MODEL.to_string(),
            default_voice: DEFAULT_TTS_VOICE.to_string(),
        }
    }

    pub fn with_defaults(
        transport: T,
        base_url: impl Into<String>,
        api_key: Option<String>,
        default_model: impl Into<String>,
        default_voice: impl Into<String>,
    ) -> Self {
        Self {
            transport,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key,
            default_model: default_model.into(),
            default_voice: default_voice.into(),
        }
    }

    fn validated_parts<'a>(
        &'a self,
        request: &'a TtsRequest,
    ) -> Result<(&'a str, &'a str, TtsFormat, f32), TtsError> {
        validate_tts_text(&request.text)?;
        let speed = validate_tts_speed(request.speed.unwrap_or(DEFAULT_TTS_SPEED))?;
        let model = request.model.as_deref().unwrap_or(&self.default_model);
        let voice = request.voice.as_deref().unwrap_or(&self.default_voice);
        let format = request.format.unwrap_or(DEFAULT_TTS_FORMAT);
        Ok((model, voice, format, speed))
    }

    pub fn build_http_request(&self, request: &TtsRequest) -> Result<TtsHttpRequest, TtsError> {
        let (model, voice, format, speed) = self.validated_parts(request)?;
        let api_key = self
            .api_key
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or(TtsError::CredentialMissing)?;
        let mut headers = BTreeMap::new();
        headers.insert("Content-Type".to_string(), "application/json".to_string());
        headers.insert("Authorization".to_string(), format!("Bearer {api_key}"));
        Ok(TtsHttpRequest {
            url: format!("{}/v1/audio/speech", self.base_url),
            headers,
            body: json!({
                "model": model,
                "input": request.text,
                "voice": voice,
                "response_format": format.as_str(),
                "speed": speed,
            }),
        })
    }
}

impl<T: TtsTransport> TtsClient for OpenAiCompatibleTtsClient<T> {
    fn synthesize(&self, request: &TtsRequest) -> Result<TtsOutcome, TtsError> {
        let (model, voice, format, _) = self.validated_parts(request)?;
        let http = self.build_http_request(request)?;
        let response = self.transport.post_audio(&http)?;
        if !(200..=299).contains(&response.status) {
            return Err(TtsError::Provider(format!(
                "http status {}",
                response.status
            )));
        }
        if response.body.is_empty() {
            return Err(TtsError::EmptyAudio);
        }
        let mime_type = response
            .content_type
            .as_deref()
            .and_then(|ct| ct.split(';').next())
            .map(str::trim)
            .filter(|ct| !ct.is_empty())
            .unwrap_or_else(|| format.mime_type())
            .to_string();
        Ok(TtsOutcome {
            audio: response.body,
            mime_type,
            format,
            voice: voice.to_string(),
            model: model.to_string(),
        })
    }
}

#[derive(Default)]
pub struct UnavailableTtsClient;

impl TtsClient for UnavailableTtsClient {
    fn synthesize(&self, _request: &TtsRequest) -> Result<TtsOutcome, TtsError> {
        Err(TtsError::Unavailable(
            "tts client is not wired; capability remains DARK".to_string(),
        ))
    }
}

pub struct StubTtsClient {
    pub model: String,
    pub voice: String,
    pub format: TtsFormat,
}

impl Default for StubTtsClient {
    fn default() -> Self {
        Self {
            model: "stub-tts-1".to_string(),
            voice: DEFAULT_TTS_VOICE.to_string(),
            format: TtsFormat::Mp3,
        }
    }
}

impl TtsClient for StubTtsClient {
    fn synthesize(&self, request: &TtsRequest) -> Result<TtsOutcome, TtsError> {
        validate_tts_text(&request.text)?;
        validate_tts_speed(request.speed.unwrap_or(DEFAULT_TTS_SPEED))?;
        let format = request.format.unwrap_or(self.format);
        let voice = request.voice.clone().unwrap_or_else(|| self.voice.clone());
        let model = request.model.clone().unwrap_or_else(|| self.model.clone());
        Ok(TtsOutcome {
            audio: format!("STUB-TTS:{model}:{voice}:{}", request.text).into_bytes(),
            mime_type: format.mime_type().to_string(),
            format,
            voice,
            model,
        })
    }
}

pub fn validate_tts_text(text: &str) -> Result<(), TtsError> {
    if text.trim().is_empty() {
        return Err(TtsError::EmptyText);
    }
    let got = text.chars().count();
    if got > MAX_TTS_TEXT_CHARS {
        return Err(TtsError::TextTooLong {
            got,
            max: MAX_TTS_TEXT_CHARS,
        });
    }
    Ok(())
}

pub fn validate_tts_speed(speed: f32) -> Result<f32, TtsError> {
    if !(MIN_TTS_SPEED..=MAX_TTS_SPEED).contains(&speed) {
        return Err(TtsError::InvalidSpeed {
            got: speed,
            min: MIN_TTS_SPEED,
            max: MAX_TTS_SPEED,
        });
    }
    Ok(speed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct MockTransport {
        last_request: RefCell<Option<TtsHttpRequest>>,
        response: TtsHttpResponse,
    }

    impl MockTransport {
        fn new(response: TtsHttpResponse) -> Self {
            Self {
                last_request: RefCell::new(None),
                response,
            }
        }
    }

    impl TtsTransport for MockTransport {
        fn post_audio(&self, request: &TtsHttpRequest) -> Result<TtsHttpResponse, TtsError> {
            *self.last_request.borrow_mut() = Some(request.clone());
            Ok(self.response.clone())
        }
    }

    fn sample_request() -> TtsRequest {
        TtsRequest {
            text: "hello friday".to_string(),
            voice: None,
            format: None,
            speed: None,
            model: None,
        }
    }

    #[test]
    fn openai_client_builds_audio_speech_request_shape() {
        let transport = MockTransport::new(TtsHttpResponse {
            status: 200,
            content_type: Some("audio/mpeg; charset=binary".to_string()),
            body: b"audio".to_vec(),
        });
        let client = OpenAiCompatibleTtsClient::new(
            transport,
            "https://api.openai.example/",
            Some("k".into()),
        );
        let out = client.synthesize(&sample_request()).unwrap();
        assert_eq!(out.audio, b"audio");
        assert_eq!(out.mime_type, "audio/mpeg");
        assert_eq!(out.format, TtsFormat::Mp3);
        assert_eq!(out.voice, DEFAULT_TTS_VOICE);
        assert_eq!(out.model, DEFAULT_OPENAI_TTS_MODEL);

        let sent = client.transport.last_request.borrow().clone().unwrap();
        assert_eq!(sent.url, "https://api.openai.example/v1/audio/speech");
        assert_eq!(
            sent.headers.get("Authorization").map(String::as_str),
            Some("Bearer k")
        );
        assert_eq!(sent.body["model"], DEFAULT_OPENAI_TTS_MODEL);
        assert_eq!(sent.body["input"], "hello friday");
        assert_eq!(sent.body["voice"], DEFAULT_TTS_VOICE);
        assert_eq!(sent.body["response_format"], "mp3");
        assert_eq!(sent.body["speed"], 1.0);
    }

    #[test]
    fn openai_client_honors_overrides() {
        let transport = MockTransport::new(TtsHttpResponse {
            status: 200,
            content_type: Some("audio/wav".to_string()),
            body: b"wav".to_vec(),
        });
        let client = OpenAiCompatibleTtsClient::with_defaults(
            transport,
            "https://tts.example",
            Some("k".into()),
            "default-model",
            "default-voice",
        );
        let mut req = sample_request();
        req.model = Some("gpt-4o-mini-tts".to_string());
        req.voice = Some("nova".to_string());
        req.format = Some(TtsFormat::Wav);
        req.speed = Some(1.5);
        let out = client.synthesize(&req).unwrap();
        assert_eq!(out.mime_type, "audio/wav");
        assert_eq!(out.format, TtsFormat::Wav);
        assert_eq!(out.voice, "nova");
        assert_eq!(out.model, "gpt-4o-mini-tts");

        let sent = client.transport.last_request.borrow().clone().unwrap();
        assert_eq!(sent.body["model"], "gpt-4o-mini-tts");
        assert_eq!(sent.body["voice"], "nova");
        assert_eq!(sent.body["response_format"], "wav");
        assert_eq!(sent.body["speed"], 1.5);
    }

    #[test]
    fn credential_missing_fails_closed_before_transport_call() {
        let transport = MockTransport::new(TtsHttpResponse {
            status: 200,
            content_type: None,
            body: b"audio".to_vec(),
        });
        let client = OpenAiCompatibleTtsClient::new(transport, "https://tts.example", None);
        let err = client.synthesize(&sample_request()).unwrap_err();
        assert!(matches!(err, TtsError::CredentialMissing));
        assert!(client.transport.last_request.borrow().is_none());
    }

    #[test]
    fn empty_text_and_speed_bounds_fail_closed() {
        assert!(matches!(validate_tts_text("  "), Err(TtsError::EmptyText)));
        assert!(matches!(
            validate_tts_text(&"x".repeat(MAX_TTS_TEXT_CHARS + 1)),
            Err(TtsError::TextTooLong { .. })
        ));
        assert!(matches!(
            validate_tts_speed(MIN_TTS_SPEED - 0.01),
            Err(TtsError::InvalidSpeed { .. })
        ));
        assert!(matches!(
            validate_tts_speed(MAX_TTS_SPEED + 0.01),
            Err(TtsError::InvalidSpeed { .. })
        ));
    }

    #[test]
    fn provider_errors_and_empty_audio_are_errors_not_fallbacks() {
        let http_500 = MockTransport::new(TtsHttpResponse {
            status: 500,
            content_type: None,
            body: b"nope".to_vec(),
        });
        let client =
            OpenAiCompatibleTtsClient::new(http_500, "https://tts.example", Some("k".into()));
        assert!(matches!(
            client.synthesize(&sample_request()).unwrap_err(),
            TtsError::Provider(_)
        ));

        let empty = MockTransport::new(TtsHttpResponse {
            status: 200,
            content_type: None,
            body: Vec::new(),
        });
        let client = OpenAiCompatibleTtsClient::new(empty, "https://tts.example", Some("k".into()));
        assert!(matches!(
            client.synthesize(&sample_request()).unwrap_err(),
            TtsError::EmptyAudio
        ));
    }

    #[test]
    fn unavailable_client_is_the_default_fail_closed_dark_posture() {
        let err = UnavailableTtsClient
            .synthesize(&sample_request())
            .unwrap_err();
        assert!(matches!(err, TtsError::Unavailable(_)));
    }

    #[test]
    fn stub_client_is_deterministic_and_offline() {
        let stub = StubTtsClient::default();
        let mut req = sample_request();
        req.voice = Some("echo".to_string());
        req.format = Some(TtsFormat::Opus);
        let out = stub.synthesize(&req).unwrap();
        assert_eq!(out.mime_type, "audio/opus");
        assert_eq!(out.format, TtsFormat::Opus);
        assert_eq!(out.voice, "echo");
        assert_eq!(out.model, "stub-tts-1");
        assert!(String::from_utf8(out.audio)
            .unwrap()
            .contains("hello friday"));
    }
}
