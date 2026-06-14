//! [`VisionModelClient`] implementations.
//!
//! - [`HttpVisionModelClient`] — the real client: validate → build multimodal body
//!   → POST via an injected [`VisionTransport`] → strict-parse. **No fallback.**
//! - [`StubVisionModelClient`] — a deterministic test stub (fixed analysis + token
//!   counts) so all upstream dispatch/validation logic is unit-testable offline.
//!   NEVER a runtime fallback — it is constructed only by tests / the dark dispatch
//!   path that explicitly wants determinism, never silently substituted for a
//!   failed live route.

use crate::transport::{build_request_body, parse_response, UreqVisionTransport, VisionTransport};
use crate::{VisionError, VisionModelClient, VisionRequest, VisionResponse};

/// The default vision model used when a [`VisionRequest`] supplies none. The hub
/// wiring can override at construction; this is only the fallback id sent on the
/// wire (the REPORTED model is what gets ledgered).
pub const DEFAULT_MODEL: &str = "gpt-4o-mini";

/// The real vision client: an injected [`VisionTransport`] + a BYOK bearer key +
/// the provider base URL + a default model. Production construction supplies the
/// real [`UreqVisionTransport`]; tests inject a mock transport.
pub struct HttpVisionModelClient<T: VisionTransport> {
    transport: T,
    api_key: String,
    base_url: String,
    default_model: String,
}

impl HttpVisionModelClient<UreqVisionTransport> {
    /// Construct the real client from an explicit base URL + BYOK key. (The key is
    /// never logged; the hub reads it from [`crate::ENV_KEY`] at the WIRE arm and
    /// passes it here — this crate never reads the process environment itself.)
    pub fn new(api_key: impl Into<String>, base_url: impl Into<String>) -> Self {
        Self::with_transport(UreqVisionTransport::new(), api_key, base_url)
    }
}

impl<T: VisionTransport> HttpVisionModelClient<T> {
    /// For tests / alternate transports. (`api_key` is never logged.)
    pub fn with_transport(
        transport: T,
        api_key: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Self {
        HttpVisionModelClient {
            transport,
            api_key: api_key.into(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            default_model: DEFAULT_MODEL.to_string(),
        }
    }

    /// Override the default model id sent when a request omits one.
    pub fn with_default_model(mut self, model: impl Into<String>) -> Self {
        self.default_model = model.into();
        self
    }

    fn endpoint(&self) -> String {
        format!(
            "{}{}",
            self.base_url,
            crate::transport::CHAT_COMPLETIONS_PATH
        )
    }
}

impl<T: VisionTransport> VisionModelClient for HttpVisionModelClient<T> {
    fn analyze(&self, req: &VisionRequest) -> Result<VisionResponse, VisionError> {
        // 1. Validate WITHOUT any I/O — refuses an unresolved workspace path, bad
        //    detail (already an enum), no/too-many images, oversized payload.
        let image_count = req.validate()?;
        // 2. Build the multimodal body (the shape the plain-string providers lack).
        let model = req.model.as_deref().unwrap_or(&self.default_model);
        let body = build_request_body(req, model)?;
        // 3. The ONLY network call. No retry, no second provider, no fallback.
        let v = self
            .transport
            .post_json(&self.endpoint(), &self.api_key, &body)?;
        // 4. Strict parse; ledger the reported model.
        parse_response(&v, model, image_count)
    }
}

/// A deterministic stub client. Returns a fixed analysis + token counts so the
/// hub executor's param-validation / receipt-shape / no-fallback logic is provable
/// offline. It STILL runs [`VisionRequest::validate`] first, so the stub exercises
/// the same adverse-path errors as the real client (it is NOT a yes-machine).
/// It makes NO network call and is NEVER a silent substitute for a failed live
/// route.
#[derive(Clone, Debug)]
pub struct StubVisionModelClient {
    pub analysis: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

impl Default for StubVisionModelClient {
    fn default() -> Self {
        StubVisionModelClient {
            analysis: "stub vision analysis: a deterministic placeholder description".into(),
            model: "stub-vision-model".into(),
            input_tokens: 100,
            output_tokens: 20,
        }
    }
}

impl StubVisionModelClient {
    pub fn new() -> Self {
        Self::default()
    }
}

impl VisionModelClient for StubVisionModelClient {
    fn analyze(&self, req: &VisionRequest) -> Result<VisionResponse, VisionError> {
        // Same validation as the real path — a malformed request still fails,
        // proving the stub does not paper over adverse inputs.
        let image_count = req.validate()?;
        Ok(VisionResponse {
            analysis: self.analysis.clone(),
            model: self.model.clone(),
            image_count,
            input_tokens: Some(self.input_tokens),
            output_tokens: Some(self.output_tokens),
            extracted_text: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::map_ureq_err;
    use crate::{ImageDetail, VisionImage};
    use serde_json::{json, Value};
    use std::cell::Cell;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// Mock transport: counts POSTs and returns a canned result or a canned error.
    struct MockTransport {
        post_calls: Cell<u32>,
        result: Result<Value, VisionError>,
    }

    impl MockTransport {
        fn ok(v: Value) -> Self {
            MockTransport {
                post_calls: Cell::new(0),
                result: Ok(v),
            }
        }
        fn err(e: VisionError) -> Self {
            MockTransport {
                post_calls: Cell::new(0),
                result: Err(e),
            }
        }
    }

    impl VisionTransport for MockTransport {
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &Value,
        ) -> Result<Value, VisionError> {
            self.post_calls.set(self.post_calls.get() + 1);
            self.result.clone()
        }
    }

    fn good_reply() -> Value {
        json!({
            "model": "vis-pro-0613",
            "choices": [{"message": {"role": "assistant", "content": "a red bicycle"}}],
            "usage": {"prompt_tokens": 1500, "completion_tokens": 12}
        })
    }

    fn req() -> VisionRequest {
        VisionRequest {
            prompt: "what is in the image?".into(),
            images: vec![VisionImage::Url("https://x/a.png".into())],
            model: Some("vis-pro".into()),
            detail: ImageDetail::Auto,
            max_tokens: Some(128),
        }
    }

    #[test]
    fn http_client_happy_path_one_call_reported_model() {
        let c = HttpVisionModelClient::with_transport(
            MockTransport::ok(good_reply()),
            "key-not-real",
            "https://vis.example.com",
        );
        let resp = c.analyze(&req()).unwrap();
        assert_eq!(resp.analysis, "a red bicycle");
        assert_eq!(resp.model, "vis-pro-0613");
        assert_eq!(resp.image_count, 1);
        assert_eq!(resp.input_tokens, Some(1500));
        assert_eq!(resp.output_tokens, Some(12));
        // Exactly ONE network call — no retry/fallback.
        assert_eq!(c.transport.post_calls.get(), 1);
    }

    #[test]
    fn http_client_validation_failure_makes_zero_calls() {
        // An invalid request never reaches the transport.
        let bad = VisionRequest {
            prompt: "x".into(),
            images: vec![],
            model: None,
            detail: ImageDetail::Auto,
            max_tokens: None,
        };
        let c = HttpVisionModelClient::with_transport(
            MockTransport::ok(good_reply()),
            "k",
            "https://vis.example.com",
        );
        assert!(matches!(
            c.analyze(&bad).unwrap_err(),
            VisionError::Validation(_)
        ));
        assert_eq!(
            c.transport.post_calls.get(),
            0,
            "must not call on invalid input"
        );
    }

    #[test]
    fn http_client_provider_error_does_not_fallback() {
        let c = HttpVisionModelClient::with_transport(
            MockTransport::err(VisionError::ProviderUnavailable("HTTP 503".into())),
            "k",
            "https://vis.example.com",
        );
        let err = c.analyze(&req()).unwrap_err();
        assert!(matches!(err, VisionError::ProviderUnavailable(_)));
        // One attempt, then surfaced — no second provider/stub substitution.
        assert_eq!(c.transport.post_calls.get(), 1);
    }

    #[test]
    fn http_client_auth_error_surfaces() {
        let c = HttpVisionModelClient::with_transport(
            MockTransport::err(VisionError::Auth(401)),
            "k",
            "https://vis.example.com",
        );
        assert!(matches!(
            c.analyze(&req()).unwrap_err(),
            VisionError::Auth(401)
        ));
    }

    #[test]
    fn http_client_uses_default_model_when_request_omits_one() {
        let mut r = req();
        r.model = None;
        let c = HttpVisionModelClient::with_transport(
            // reply omits `model` so parse falls back to the requested (default) id
            MockTransport::ok(json!({"choices": [{"message": {"content": "x"}}]})),
            "k",
            "https://vis.example.com",
        )
        .with_default_model("my-default-vis");
        let resp = c.analyze(&r).unwrap();
        assert_eq!(resp.model, "my-default-vis");
    }

    #[test]
    fn stub_returns_deterministic_result_and_validates() {
        let stub = StubVisionModelClient::new();
        let resp = stub.analyze(&req()).unwrap();
        assert_eq!(resp.analysis, StubVisionModelClient::default().analysis);
        assert_eq!(resp.model, "stub-vision-model");
        assert_eq!(resp.input_tokens, Some(100));
        assert_eq!(resp.output_tokens, Some(20));
        assert_eq!(resp.image_count, 1);
        assert!(resp.extracted_text.is_none());
    }

    #[test]
    fn stub_still_rejects_invalid_request() {
        // The stub is not a yes-machine: it runs the same validation.
        let stub = StubVisionModelClient::new();
        let bad = VisionRequest {
            prompt: "".into(),
            images: vec![VisionImage::Url("https://x/a.png".into())],
            model: None,
            detail: ImageDetail::Auto,
            max_tokens: None,
        };
        assert!(matches!(
            stub.analyze(&bad).unwrap_err(),
            VisionError::Validation(_)
        ));
    }

    /// A one-shot HTTP server to drive the REAL UreqVisionTransport end-to-end:
    /// proves the full validate→build→POST→parse path against a local socket and
    /// that a 4xx body carrying a secret is NOT echoed into the error.
    ///
    /// The POST request carries a JSON body, so the server must DRAIN the full
    /// request (request line + headers + the `Content-Length` body) before
    /// replying — otherwise replying-then-closing while ureq is still flushing the
    /// request body breaks the connection (os error 22 on the client read). We
    /// parse `Content-Length` from the headers and read exactly that many body
    /// bytes, then write the response.
    fn serve_http_once(
        status: u16,
        reason: &'static str,
        body: &'static str,
    ) -> (String, thread::JoinHandle<()>) {
        use std::io::BufRead;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream);
            // Read headers line-by-line until the blank line; capture Content-Length.
            let mut content_length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 {
                    break;
                }
                let trimmed = line.trim_end();
                if trimmed.is_empty() {
                    break; // end of headers
                }
                if let Some(rest) = trimmed.to_ascii_lowercase().strip_prefix("content-length:") {
                    content_length = rest.trim().parse().unwrap_or(0);
                }
            }
            // Drain exactly the declared body so the client finishes flushing.
            if content_length > 0 {
                let mut body_buf = vec![0u8; content_length];
                reader.read_exact(&mut body_buf).unwrap();
            }
            let mut stream = reader.into_inner();
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            let _ = stream.flush();
        });
        (format!("http://{addr}"), handle)
    }

    #[test]
    fn real_transport_full_path_against_local_server() {
        let (base_url, handle) = serve_http_once(
            200,
            "OK",
            r#"{"model":"vis-pro-0613","choices":[{"message":{"content":"a dog"}}],"usage":{"prompt_tokens":900,"completion_tokens":5}}"#,
        );
        let c = HttpVisionModelClient::new("key-not-real", base_url);
        let resp = c.analyze(&req()).unwrap();
        handle.join().unwrap();
        assert_eq!(resp.analysis, "a dog");
        assert_eq!(resp.model, "vis-pro-0613");
        assert_eq!(resp.input_tokens, Some(900));
    }

    #[test]
    fn real_transport_4xx_is_coarse_and_secret_free() {
        let (base_url, handle) = serve_http_once(
            429,
            "Too Many Requests",
            r#"{"error":"quota hit for SECRET-QUOTA-BODY"}"#,
        );
        let c = HttpVisionModelClient::new("test-key-not-real", base_url);
        let err = c.analyze(&req()).unwrap_err();
        handle.join().unwrap();
        assert!(matches!(err, VisionError::ClientError { status: 429 }));
        for rendered in [format!("{err:?}"), format!("{err}")] {
            for forbidden in [
                "SECRET-QUOTA-BODY",
                "test-key-not-real",
                "Authorization",
                "Bearer",
            ] {
                assert!(
                    !rendered.contains(forbidden),
                    "render leaked {forbidden}: {rendered}"
                );
            }
            assert!(rendered.contains("429"), "status code missing: {rendered}");
        }
    }

    #[test]
    fn real_transport_network_fail_without_secret() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let c = HttpVisionModelClient::new("test-key-not-real", format!("http://{addr}"));
        let err = c.analyze(&req()).unwrap_err();
        assert!(matches!(
            err,
            VisionError::ProviderUnavailable(ref r) if r.starts_with("transport:")
        ));
        let rendered = format!("{err:?}");
        for forbidden in ["test-key-not-real", "Authorization", "Bearer"] {
            assert!(
                !rendered.contains(forbidden),
                "leaked {forbidden}: {rendered}"
            );
        }
    }

    #[test]
    fn map_ureq_err_is_reachable_from_client_module() {
        // Sanity: the transport error mapper is the shared classifier.
        let resp = ureq::Response::new(503, "x", "{}").unwrap();
        assert!(matches!(
            map_ureq_err(ureq::Error::Status(503, resp)),
            VisionError::ProviderUnavailable(_)
        ));
    }
}
