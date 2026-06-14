//! HTTP transport seam for the vision route.
//!
//! [`VisionTransport`] is the low-level POST seam (mirrors `friday-deepseek`'s
//! `Transport`); the real impl is [`UreqVisionTransport`]. The multimodal-body
//! construction and the strict reply parse are pure functions ([`build_request_body`],
//! [`parse_response`]) so the OpenAI-compatible message shape is testable WITHOUT a
//! live provider. **No fallback** — every adverse path is a [`VisionError`].

use crate::{ImageDetail, VisionError, VisionImage, VisionRequest, VisionResponse};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};

/// The default vision-completions path appended to the BYOK base URL. Mirrors the
/// OpenAI-compatible `/chat/completions` convention the TS oracle targets.
pub const CHAT_COMPLETIONS_PATH: &str = "/v1/chat/completions";

/// Low-level HTTP POST seam. The real impl is [`UreqVisionTransport`]; tests
/// inject a deterministic mock so the multimodal-body and no-fallback logic are
/// provable offline.
pub trait VisionTransport {
    /// POST a JSON body with a bearer credential, returning the parsed JSON reply.
    /// MUST NEVER format the request (which carries the `Authorization` header) or
    /// the response body into an error string.
    fn post_json(&self, url: &str, bearer: &str, body: &Value) -> Result<Value, VisionError>;
}

/// Real blocking HTTP transport (ureq + rustls). Maps errors to controlled
/// [`VisionError`] messages — it never formats the request (which carries the
/// `Authorization` header) into an error string.
pub struct UreqVisionTransport;

impl UreqVisionTransport {
    pub fn new() -> Self {
        UreqVisionTransport
    }
}

impl Default for UreqVisionTransport {
    fn default() -> Self {
        Self::new()
    }
}

/// Map a `ureq::Error` to a controlled, secret-free [`VisionError`] — classify by
/// status code ONLY; never read/echo the response body or the request headers.
/// Same partition as `friday-deepseek::map_ureq_err` (401/403→Auth; 408+5xx→
/// transient ProviderUnavailable; other 4xx + 429→terminal ClientError).
pub fn map_ureq_err(e: ureq::Error) -> VisionError {
    match e {
        ureq::Error::Status(code, _resp) => {
            if code == 401 || code == 403 {
                VisionError::Auth(code)
            } else if code == 408 || (500..=599).contains(&code) {
                VisionError::ProviderUnavailable(format!("HTTP {code}"))
            } else {
                VisionError::ClientError { status: code }
            }
        }
        ureq::Error::Transport(t) => {
            VisionError::ProviderUnavailable(format!("transport: {}", t.kind()))
        }
    }
}

impl VisionTransport for UreqVisionTransport {
    fn post_json(&self, url: &str, bearer: &str, body: &Value) -> Result<Value, VisionError> {
        let resp = ureq::post(url)
            .set("Authorization", &format!("Bearer {bearer}"))
            .set("Accept", "application/json")
            .send_json(body.clone())
            .map_err(map_ureq_err)?;
        resp.into_json::<Value>()
            .map_err(|e| VisionError::BadResponse(format!("invalid JSON: {e}")))
    }
}

/// Render one [`VisionImage`] into its OpenAI-compatible `image_url` part value.
/// A `Base64` image becomes a `data:<mime>;base64,<...>` URI. An unresolved
/// [`VisionImage::WorkspacePath`] is a caller bug — this crate never reads files,
/// so it is surfaced as a clean [`VisionError::UnresolvedImage`].
fn image_url_value(img: &VisionImage, detail: ImageDetail) -> Result<Value, VisionError> {
    let url = match img {
        VisionImage::Url(u) => u.clone(),
        VisionImage::Base64 { mime, data_base64 } => {
            format!("data:{mime};base64,{data_base64}")
        }
        VisionImage::WorkspacePath(p) => return Err(VisionError::UnresolvedImage(p.clone())),
    };
    Ok(json!({
        "type": "image_url",
        "image_url": { "url": url, "detail": detail.as_str() },
    }))
}

/// Build the OpenAI-compatible multimodal `/chat/completions` request body for a
/// validated [`VisionRequest`]. The single user message's `content` is an ARRAY
/// of parts: one `{type:"text"}` prompt part followed by one `{type:"image_url"}`
/// part per image. This is the multimodal shape that `friday-deepseek` /
/// `friday-anthropic` lack (they send a plain-string `content`).
///
/// Pure — no I/O. Assumes the caller already ran [`VisionRequest::validate`]
/// (so images are non-empty, within bounds, and have no unresolved paths); a
/// stray unresolved path is still defended here.
pub fn build_request_body(req: &VisionRequest, model: &str) -> Result<Value, VisionError> {
    let mut content: Vec<Value> = Vec::with_capacity(req.images.len() + 1);
    content.push(json!({ "type": "text", "text": req.prompt }));
    for img in &req.images {
        content.push(image_url_value(img, req.detail)?);
    }
    let mut body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": content }],
        "stream": false,
    });
    if let Some(max) = req.max_tokens {
        body["max_tokens"] = json!(max);
    }
    Ok(body)
}

/// Strict-parse an OpenAI-compatible chat-completion reply into a
/// [`VisionResponse`]. Ledgers the REPORTED model id (avoids stale-model claims).
/// Usage tokens are optional (vision providers vary); a missing usage object is
/// NOT an error. `image_count` is supplied by the caller (the validated count).
/// **No fallback** — a malformed body is a clean [`VisionError::BadResponse`].
pub fn parse_response(
    v: &Value,
    requested_model: &str,
    image_count: usize,
) -> Result<VisionResponse, VisionError> {
    let choice0 = v
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .ok_or_else(|| VisionError::BadResponse("missing `choices[0]`".into()))?;

    // content may be a plain string OR a parts array (providers differ); accept
    // both, join text parts. A reply with no extractable text is a BadResponse —
    // never a silent empty analysis passed off as success.
    let message = choice0
        .get("message")
        .ok_or_else(|| VisionError::BadResponse("missing `choices[0].message`".into()))?;
    let analysis = extract_text(message.get("content"))
        .ok_or_else(|| VisionError::BadResponse("missing analysis text in message".into()))?;

    let reported_model = v
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(requested_model)
        .to_string();

    let usage = v.get("usage");
    let input_tokens = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(Value::as_i64);
    let output_tokens = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(Value::as_i64);

    Ok(VisionResponse {
        analysis,
        model: reported_model,
        image_count,
        input_tokens,
        output_tokens,
        // OCR latent mirror: the vision route never writes it (see lib.rs).
        extracted_text: None,
    })
}

/// Extract the assistant text from a `content` value that may be either a plain
/// string or an array of `{type:"text",text}` parts. Returns `None` only when
/// there is no text at all.
fn extract_text(content: Option<&Value>) -> Option<String> {
    match content {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(parts)) => {
            let mut out = String::new();
            for p in parts {
                if let Some(t) = p.get("text").and_then(Value::as_str) {
                    out.push_str(t);
                }
            }
            // Distinguish "no text parts" (None) from "empty string content"
            // (Some("")) — an array with zero text parts is treated as missing.
            if parts
                .iter()
                .any(|p| p.get("text").and_then(Value::as_str).is_some())
            {
                Some(out)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Encode raw image bytes to standard base64 (for building a [`VisionImage::Base64`]
/// from bytes the hub executor read via `friday_fs::open_read_within_root`). Pure.
pub fn encode_image_bytes(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> VisionRequest {
        VisionRequest {
            prompt: "describe".into(),
            images: vec![
                VisionImage::Url("https://x/a.png".into()),
                VisionImage::Base64 {
                    mime: "image/png".into(),
                    data_base64: "QUJD".into(),
                },
            ],
            model: None,
            detail: ImageDetail::High,
            max_tokens: Some(256),
        }
    }

    #[test]
    fn body_has_multimodal_content_array_one_text_plus_one_per_image() {
        let body = build_request_body(&req(), "vis-pro").unwrap();
        assert_eq!(body["model"], "vis-pro");
        assert_eq!(body["stream"], false);
        assert_eq!(body["max_tokens"], 256);
        let content = body["messages"][0]["content"].as_array().unwrap();
        // 1 text part + 2 image parts.
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "describe");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["image_url"]["url"], "https://x/a.png");
        assert_eq!(content[1]["image_url"]["detail"], "high");
        // base64 image becomes a data URI.
        assert_eq!(content[2]["image_url"]["url"], "data:image/png;base64,QUJD");
    }

    #[test]
    fn body_omits_max_tokens_when_none() {
        let mut r = req();
        r.max_tokens = None;
        let body = build_request_body(&r, "m").unwrap();
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn body_build_rejects_unresolved_workspace_path() {
        let r = VisionRequest {
            prompt: "x".into(),
            images: vec![VisionImage::WorkspacePath("a.png".into())],
            model: None,
            detail: ImageDetail::Auto,
            max_tokens: None,
        };
        assert!(matches!(
            build_request_body(&r, "m").unwrap_err(),
            VisionError::UnresolvedImage(_)
        ));
    }

    #[test]
    fn parse_response_reads_string_content_and_reported_model() {
        let v = json!({
            "model": "vis-pro-0613",
            "choices": [{"message": {"role": "assistant", "content": "a tabby cat"}}],
            "usage": {"prompt_tokens": 1200, "completion_tokens": 18}
        });
        let r = parse_response(&v, "vis-pro", 2).unwrap();
        assert_eq!(r.analysis, "a tabby cat");
        assert_eq!(r.model, "vis-pro-0613");
        assert_eq!(r.image_count, 2);
        assert_eq!(r.input_tokens, Some(1200));
        assert_eq!(r.output_tokens, Some(18));
        assert!(r.extracted_text.is_none());
    }

    #[test]
    fn parse_response_reads_parts_array_content() {
        let v = json!({
            "model": "m",
            "choices": [{"message": {"content": [
                {"type": "text", "text": "hello "},
                {"type": "text", "text": "world"}
            ]}}]
        });
        let r = parse_response(&v, "m", 1).unwrap();
        assert_eq!(r.analysis, "hello world");
        // usage absent → tokens None (not an error).
        assert_eq!(r.input_tokens, None);
        assert_eq!(r.output_tokens, None);
    }

    #[test]
    fn parse_response_falls_back_to_requested_model_when_unreported() {
        let v = json!({
            "choices": [{"message": {"content": "x"}}]
        });
        let r = parse_response(&v, "requested-m", 1).unwrap();
        assert_eq!(r.model, "requested-m");
    }

    #[test]
    fn parse_response_missing_choices_is_bad_response() {
        let v = json!({"model": "m"});
        assert!(matches!(
            parse_response(&v, "m", 1).unwrap_err(),
            VisionError::BadResponse(_)
        ));
    }

    #[test]
    fn parse_response_missing_text_is_bad_response_not_silent_empty() {
        // A reply with no text content is an error — never a silent empty analysis
        // passed off as a successful vision result.
        let v = json!({
            "model": "m",
            "choices": [{"message": {"content": [{"type": "image_url"}]}}]
        });
        assert!(matches!(
            parse_response(&v, "m", 1).unwrap_err(),
            VisionError::BadResponse(_)
        ));
    }

    #[test]
    fn map_ureq_status_partition_matches_deepseek_boundary() {
        let status_err = |code: u16| {
            let resp = ureq::Response::new(code, "x", "{}").unwrap();
            map_ureq_err(ureq::Error::Status(code, resp))
        };
        for code in [500u16, 502, 503, 504, 599, 408] {
            assert!(matches!(
                status_err(code),
                VisionError::ProviderUnavailable(ref r) if r == &format!("HTTP {code}")
            ));
        }
        for code in [400u16, 404, 409, 422, 429] {
            assert!(
                matches!(status_err(code), VisionError::ClientError { status } if status == code)
            );
        }
        assert!(matches!(status_err(401), VisionError::Auth(401)));
        assert!(matches!(status_err(403), VisionError::Auth(403)));
    }

    #[test]
    fn encode_image_bytes_is_standard_base64() {
        assert_eq!(encode_image_bytes(b"ABC"), "QUJD");
        assert_eq!(encode_image_bytes(b""), "");
    }
}
