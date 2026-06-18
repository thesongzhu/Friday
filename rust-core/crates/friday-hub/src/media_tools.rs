//! B5 media capability tools — TTS / PDF parse / OCR Hub executor layer.
//!
//! This module is deliberately DARK. It registers no live provider by itself and is reachable
//! only after the Hub's default-OFF `FRIDAY_MEDIA_TOOL_ENABLED` chokepoint permits the action.
//! Runtime defaults inject unavailable clients/providers (fail-closed); tests inject deterministic
//! stubs to prove the flag-ON path is functional without secrets, network, or operator signing.

use crate::{ExecError, ToolExecutor, ToolReceipt};
use base64::Engine as _;
use friday_ocr::{OcrImageFormat, OcrProvider, OcrRequest};
use friday_pdf::{PdfParseLimits, PdfParseRequest, PdfTextExtractor};
use friday_tts::{TtsClient, TtsFormat, TtsRequest};
use std::io::Read as _;
use std::path::PathBuf;

const MAX_MEDIA_FILE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum MediaToolError {
    #[error("media_tool_bad_param:{0}")]
    BadParam(String),
    #[error("tts_error:{0}")]
    Tts(String),
    #[error("pdf_parse_error:{0}")]
    Pdf(String),
    #[error("ocr_error:{0}")]
    Ocr(String),
    #[error("media file exceeds {max} bytes")]
    FileTooLarge { max: usize },
}

pub struct MediaToolExecutor {
    root: PathBuf,
    tts: Box<dyn TtsClient + Send + Sync>,
    pdf: Box<dyn PdfTextExtractor + Send + Sync>,
    ocr: Box<dyn OcrProvider + Send + Sync>,
}

impl MediaToolExecutor {
    pub fn new(
        root: impl Into<PathBuf>,
        tts: Box<dyn TtsClient + Send + Sync>,
        pdf: Box<dyn PdfTextExtractor + Send + Sync>,
        ocr: Box<dyn OcrProvider + Send + Sync>,
    ) -> Self {
        Self {
            root: root.into(),
            tts,
            pdf,
            ocr,
        }
    }

    pub fn for_runtime(root: impl Into<PathBuf>) -> Self {
        Self::new(
            root,
            Box::<friday_tts::UnavailableTtsClient>::default(),
            Box::<friday_pdf::EmbeddedTextExtractor>::default(),
            Box::<friday_ocr::UnavailableOcrProvider>::default(),
        )
    }

    fn param<'a>(params: &'a [(String, String)], key: &str) -> Result<&'a str, ExecError> {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
            .ok_or_else(|| ExecError::MissingParam(key.to_string()))
    }

    fn optional_param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.trim().is_empty())
    }

    fn read_workspace_bytes(&self, path: &str, max: usize) -> Result<Vec<u8>, ExecError> {
        let mut file = friday_fs::open_read_within_root(&self.root, path).map_err(ExecError::Fs)?;
        let mut buf = Vec::new();
        file.by_ref()
            .take((max + 1) as u64)
            .read_to_end(&mut buf)
            .map_err(ExecError::Io)?;
        if buf.len() > max {
            return Err(ExecError::Media(MediaToolError::FileTooLarge { max }));
        }
        Ok(buf)
    }

    fn execute_tts(
        &self,
        params: &[(String, String)],
    ) -> Result<(ToolReceipt, Option<friday_core::ToolUsageMeasurement>), ExecError> {
        let text = Self::param(params, "text")?.to_string();
        let text_chars = text.chars().count() as i64;
        let format = match Self::optional_param(params, "format") {
            Some("mp3") | None => None,
            Some("wav") => Some(TtsFormat::Wav),
            Some("opus") => Some(TtsFormat::Opus),
            Some(other) => {
                return Err(ExecError::Media(MediaToolError::BadParam(format!(
                    "unsupported tts format `{other}`"
                ))));
            }
        };
        let speed = Self::optional_param(params, "speed")
            .map(|v| {
                v.parse::<f32>().map_err(|_| {
                    ExecError::Media(MediaToolError::BadParam(format!("invalid tts speed `{v}`")))
                })
            })
            .transpose()?;
        let request = TtsRequest {
            text,
            voice: Self::optional_param(params, "voice").map(str::to_string),
            format,
            speed,
            model: Self::optional_param(params, "model").map(str::to_string),
        };
        match self.tts.synthesize(&request) {
            Ok(out) => {
                let usage = friday_core::ToolUsageMeasurement::new(
                    "tts",
                    "tts_provider",
                    out.model.clone(),
                    "input_chars",
                    text_chars,
                    "audio_bytes",
                    out.audio.len() as i64,
                    None,
                    None,
                )
                .map_err(|e| ExecError::Media(MediaToolError::BadParam(e.to_string())))?;
                Ok((
                    ToolReceipt {
                        action: "tts".to_string(),
                        summary: format!(
                            "tts [{}]: {} byte(s) {}",
                            out.model,
                            out.audio.len(),
                            out.mime_type
                        ),
                        content: Some(format!(
                            "{{\"mimeType\":\"{}\",\"bytes\":{},\"voice\":\"{}\",\"model\":\"{}\",\"format\":\"{}\"}}",
                            out.mime_type,
                            out.audio.len(),
                            out.voice,
                            out.model,
                            out.format.as_str()
                        )),
                    },
                    Some(usage),
                ))
            }
            Err(e) => Ok((
                ToolReceipt {
                    action: "tts".to_string(),
                    summary: "tts: refused (provider unavailable)".to_string(),
                    content: Some(format!(
                        "tts is unavailable: {e}. Refusing to silently synthesize audio."
                    )),
                },
                None,
            )),
        }
    }

    fn execute_pdf_parse(
        &self,
        params: &[(String, String)],
    ) -> Result<(ToolReceipt, Option<friday_core::ToolUsageMeasurement>), ExecError> {
        let path = Self::param(params, "path")?;
        let max_pages = parse_usize_param(params, "maxPages")
            .or_else(|| parse_usize_param(params, "max_pages"))
            .unwrap_or(friday_pdf::DEFAULT_MAX_PAGES);
        let max_chars = parse_usize_param(params, "maxChars")
            .or_else(|| parse_usize_param(params, "max_chars"))
            .unwrap_or(friday_pdf::DEFAULT_MAX_CHARS);
        let bytes = self.read_workspace_bytes(path, MAX_MEDIA_FILE_BYTES)?;
        let input_bytes = bytes.len() as i64;
        let outcome = self
            .pdf
            .extract_text(&PdfParseRequest {
                bytes,
                limits: PdfParseLimits {
                    max_pages,
                    max_chars,
                },
            })
            .map_err(|e| ExecError::Media(MediaToolError::Pdf(e.to_string())))?;
        let output_chars = outcome.text.chars().count() as i64;
        let usage = friday_core::ToolUsageMeasurement::new(
            "pdf_parse",
            "local_pdf",
            "embedded_text",
            "document_bytes",
            input_bytes,
            "text_chars",
            output_chars,
            None,
            None,
        )
        .map_err(|e| ExecError::Media(MediaToolError::BadParam(e.to_string())))?;
        Ok((
            ToolReceipt {
                action: "pdf_parse".to_string(),
                summary: format!(
                    "pdf_parse: {} page(s), {} parsed, {} char(s)",
                    outcome.page_count, outcome.parsed_pages, output_chars
                ),
                content: Some(format!(
                    "{{\"pageCount\":{},\"parsedPages\":{},\"truncated\":{},\"text\":{}}}",
                    outcome.page_count,
                    outcome.parsed_pages,
                    outcome.truncated,
                    serde_json::to_string(&outcome.text).unwrap_or_else(|_| "\"\"".to_string())
                )),
            },
            Some(usage),
        ))
    }

    fn execute_ocr(
        &self,
        params: &[(String, String)],
    ) -> Result<(ToolReceipt, Option<friday_core::ToolUsageMeasurement>), ExecError> {
        let (image, format) = if let Some(data_uri) = Self::optional_param(params, "image") {
            decode_ocr_data_uri(data_uri)?
        } else {
            let path = Self::param(params, "path")?;
            let bytes = self.read_workspace_bytes(path, friday_ocr::DEFAULT_MAX_IMAGE_BYTES)?;
            let format = sniff_ocr_format(path, &bytes).ok_or_else(|| {
                ExecError::Media(MediaToolError::BadParam(
                    "ocr image must be png, jpeg, or webp".to_string(),
                ))
            })?;
            (bytes, format)
        };
        let input_bytes = image.len() as i64;
        let max_output_chars = parse_usize_param(params, "maxOutputChars")
            .or_else(|| parse_usize_param(params, "max_output_chars"));
        let outcome = self
            .ocr
            .extract_text(&OcrRequest {
                image,
                format,
                prompt: Self::optional_param(params, "prompt").map(str::to_string),
                model: Self::optional_param(params, "model").map(str::to_string),
                max_output_chars,
            })
            .map_err(|e| ExecError::Media(MediaToolError::Ocr(e.to_string())))?;
        let output_chars = outcome.text.chars().count() as i64;
        let usage = friday_core::ToolUsageMeasurement::new(
            "ocr_extract",
            "ocr_provider",
            outcome.model.clone(),
            "image_bytes",
            input_bytes,
            "text_chars",
            output_chars,
            None,
            None,
        )
        .map_err(|e| ExecError::Media(MediaToolError::BadParam(e.to_string())))?;
        Ok((
            ToolReceipt {
                action: "ocr_extract".to_string(),
                summary: format!("ocr_extract [{}]: {} char(s)", outcome.model, output_chars),
                content: Some(format!(
                    "{{\"model\":\"{}\",\"text\":{}}}",
                    outcome.model,
                    serde_json::to_string(&outcome.text).unwrap_or_else(|_| "\"\"".to_string())
                )),
            },
            Some(usage),
        ))
    }
}

impl ToolExecutor for MediaToolExecutor {
    fn execute(&self, action: &str, params: &[(String, String)]) -> Result<ToolReceipt, ExecError> {
        self.execute_with_usage(action, params)
            .map(|(receipt, _)| receipt)
    }

    fn execute_with_usage(
        &self,
        action: &str,
        params: &[(String, String)],
    ) -> Result<(ToolReceipt, Option<friday_core::ToolUsageMeasurement>), ExecError> {
        match action {
            "tts" => self.execute_tts(params),
            "pdf_parse" => self.execute_pdf_parse(params),
            "ocr_extract" => self.execute_ocr(params),
            other => Err(ExecError::Unsupported(other.to_string())),
        }
    }
}

fn parse_usize_param(params: &[(String, String)], key: &str) -> Option<usize> {
    params
        .iter()
        .find(|(k, _)| k == key)
        .and_then(|(_, v)| v.parse::<usize>().ok())
}

fn decode_ocr_data_uri(uri: &str) -> Result<(Vec<u8>, OcrImageFormat), ExecError> {
    let rest = uri.strip_prefix("data:").ok_or_else(|| {
        ExecError::Media(MediaToolError::BadParam(
            "ocr data URI must start with data:".to_string(),
        ))
    })?;
    let (meta, payload) = rest.split_once(',').ok_or_else(|| {
        ExecError::Media(MediaToolError::BadParam("malformed data URI".to_string()))
    })?;
    let media_type = meta.strip_suffix(";base64").ok_or_else(|| {
        ExecError::Media(MediaToolError::BadParam(
            "ocr data URI must be base64".to_string(),
        ))
    })?;
    let format = format_from_media_type(media_type).ok_or_else(|| {
        ExecError::Media(MediaToolError::BadParam(format!(
            "unsupported ocr media type `{media_type}`"
        )))
    })?;
    let image = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|_| ExecError::Media(MediaToolError::BadParam("bad base64".to_string())))?;
    Ok((image, format))
}

fn format_from_media_type(media_type: &str) -> Option<OcrImageFormat> {
    match media_type.to_ascii_lowercase().as_str() {
        "image/png" => Some(OcrImageFormat::Png),
        "image/jpeg" | "image/jpg" => Some(OcrImageFormat::Jpeg),
        "image/webp" => Some(OcrImageFormat::Webp),
        _ => None,
    }
}

fn sniff_ocr_format(path: &str, bytes: &[u8]) -> Option<OcrImageFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") || path.to_ascii_lowercase().ends_with(".png") {
        return Some(OcrImageFormat::Png);
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) || path.to_ascii_lowercase().ends_with(".jpg") {
        return Some(OcrImageFormat::Jpeg);
    }
    if path.to_ascii_lowercase().ends_with(".jpeg") {
        return Some(OcrImageFormat::Jpeg);
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(OcrImageFormat::Webp);
    }
    None
}
