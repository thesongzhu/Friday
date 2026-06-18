//! Friday F11 / B5 PDF parsing capability — the text-extraction seam.
//!
//! This crate is deliberately Hub-side and DARK: it defines the [`PdfTextExtractor`]
//! DI trait, a deterministic [`StubPdfTextExtractor`], and a small
//! [`EmbeddedTextExtractor`] for embedded-text PDFs. It does not register a Hub
//! tool, read workspace files, or flip a production flag. A future Hub executor
//! still owns path containment, file-size limits, governance, and tool exposure.
//!
//! The embedded extractor is intentionally conservative. It is not a complete PDF
//! engine, but it is a real non-stub KAT substrate for simple text PDFs: it scans
//! content bytes for literal strings used by common `Tj` / `TJ` text operators,
//! decodes PDF escapes, estimates page count from `/Type /Page` markers, clamps
//! page windows, and truncates combined output.

pub const DEFAULT_MAX_PAGES: usize = 50;
pub const MAX_ALLOWED_PAGES: usize = 500;
pub const MIN_ALLOWED_CHARS: usize = 1_000;
pub const DEFAULT_MAX_CHARS: usize = 64 * 1024;
pub const MAX_ALLOWED_CHARS: usize = 250_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PdfParseLimits {
    pub max_pages: usize,
    pub max_chars: usize,
}

impl Default for PdfParseLimits {
    fn default() -> Self {
        Self {
            max_pages: DEFAULT_MAX_PAGES,
            max_chars: DEFAULT_MAX_CHARS,
        }
    }
}

impl PdfParseLimits {
    pub fn clamped(self) -> Self {
        Self {
            max_pages: self.max_pages.clamp(1, MAX_ALLOWED_PAGES),
            max_chars: self.max_chars.clamp(MIN_ALLOWED_CHARS, MAX_ALLOWED_CHARS),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PdfParseRequest {
    pub bytes: Vec<u8>,
    pub limits: PdfParseLimits,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PdfPageText {
    pub page_number: usize,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PdfTextOutcome {
    pub page_count: usize,
    pub parsed_pages: usize,
    pub truncated: bool,
    pub text: String,
    pub pages: Vec<PdfPageText>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PdfParseError {
    EmptyDocument,
    NotPdf,
    NoExtractableText,
}

impl std::fmt::Display for PdfParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyDocument => f.write_str("pdf document is empty"),
            Self::NotPdf => f.write_str("document does not look like a PDF"),
            Self::NoExtractableText => f.write_str("pdf contained no extractable embedded text"),
        }
    }
}

impl std::error::Error for PdfParseError {}

pub trait PdfTextExtractor {
    fn extract_text(&self, request: &PdfParseRequest) -> Result<PdfTextOutcome, PdfParseError>;
}

#[derive(Default)]
pub struct EmbeddedTextExtractor;

impl PdfTextExtractor for EmbeddedTextExtractor {
    fn extract_text(&self, request: &PdfParseRequest) -> Result<PdfTextOutcome, PdfParseError> {
        if request.bytes.is_empty() {
            return Err(PdfParseError::EmptyDocument);
        }
        if !looks_like_pdf(&request.bytes) {
            return Err(PdfParseError::NotPdf);
        }

        let limits = request.limits.clamped();
        let page_count = estimate_page_count(&request.bytes).max(1);
        let parse_page_count = page_count.min(limits.max_pages);
        let literals = extract_pdf_literal_strings(&request.bytes);
        if literals.is_empty() {
            return Err(PdfParseError::NoExtractableText);
        }

        let mut combined = literals.join(" ");
        normalize_text(&mut combined);
        if combined.is_empty() {
            return Err(PdfParseError::NoExtractableText);
        }

        let truncated_text = truncate_chars(&combined, limits.max_chars);
        let truncated =
            page_count > parse_page_count || combined.chars().count() > limits.max_chars;
        Ok(PdfTextOutcome {
            page_count,
            parsed_pages: parse_page_count,
            truncated,
            text: truncated_text.clone(),
            pages: vec![PdfPageText {
                page_number: 1,
                text: truncated_text,
            }],
        })
    }
}

pub struct StubPdfTextExtractor {
    pub text: String,
}

impl Default for StubPdfTextExtractor {
    fn default() -> Self {
        Self {
            text: "STUB-PDF: extracted text".to_string(),
        }
    }
}

impl PdfTextExtractor for StubPdfTextExtractor {
    fn extract_text(&self, request: &PdfParseRequest) -> Result<PdfTextOutcome, PdfParseError> {
        if request.bytes.is_empty() {
            return Err(PdfParseError::EmptyDocument);
        }
        let limits = request.limits.clamped();
        let text = truncate_chars(&self.text, limits.max_chars);
        Ok(PdfTextOutcome {
            page_count: 1,
            parsed_pages: 1,
            truncated: self.text.chars().count() > limits.max_chars,
            text: text.clone(),
            pages: vec![PdfPageText {
                page_number: 1,
                text,
            }],
        })
    }
}

fn looks_like_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-") || bytes.windows(5).take(128).any(|w| w == b"%PDF-")
}

fn estimate_page_count(bytes: &[u8]) -> usize {
    let text = String::from_utf8_lossy(bytes);
    text.match_indices("/Type /Page")
        .filter(|(idx, _)| !text[*idx..].starts_with("/Type /Pages"))
        .count()
}

fn extract_pdf_literal_strings(bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'(' {
            i += 1;
            continue;
        }
        let Some((literal, next)) = read_literal_string(bytes, i + 1) else {
            i += 1;
            continue;
        };
        let after = skip_ascii_ws(bytes, next);
        if is_text_operator_after_literal(bytes, after) {
            let mut text = literal;
            normalize_text(&mut text);
            if !text.is_empty() {
                out.push(text);
            }
        }
        i = next;
    }
    out
}

fn read_literal_string(bytes: &[u8], mut i: usize) -> Option<(String, usize)> {
    let mut depth = 1usize;
    let mut out = Vec::new();
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'\\' => {
                i += 1;
                if i >= bytes.len() {
                    return None;
                }
                let escaped = match bytes[i] {
                    b'n' => b'\n',
                    b'r' => b'\r',
                    b't' => b'\t',
                    b'b' => 0x08,
                    b'f' => 0x0c,
                    b'(' => b'(',
                    b')' => b')',
                    b'\\' => b'\\',
                    other => other,
                };
                out.push(escaped);
            }
            b'(' => {
                depth += 1;
                out.push(b);
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some((String::from_utf8_lossy(&out).to_string(), i + 1));
                }
                out.push(b);
            }
            other => out.push(other),
        }
        i += 1;
    }
    None
}

fn skip_ascii_ws(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

fn is_text_operator_after_literal(bytes: &[u8], i: usize) -> bool {
    bytes.get(i..i + 2) == Some(b"Tj")
        || bytes.get(i..i + 1) == Some(b"'")
        || bytes.get(i..i + 1) == Some(b"\"")
        || bytes
            .get(i..i + 2)
            .is_some_and(|pair| pair == b"] " || pair == b"]\n" || pair == b"]\r")
        || bytes.get(i..i + 3) == Some(b"]TJ")
}

fn normalize_text(text: &mut String) {
    let mut normalized = String::new();
    let mut last_was_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                normalized.push(' ');
                last_was_space = true;
            }
        } else {
            normalized.push(ch);
            last_was_space = false;
        }
    }
    *text = normalized.trim().to_string();
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE_TEXT_PDF: &[u8] = br#"%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT
/F1 24 Tf
100 700 Td
(Hello \(Friday\)) Tj
ET
endstream
endobj
%%EOF"#;

    fn request(bytes: &[u8]) -> PdfParseRequest {
        PdfParseRequest {
            bytes: bytes.to_vec(),
            limits: PdfParseLimits::default(),
        }
    }

    #[test]
    fn embedded_extractor_reads_simple_literal_text_pdf() {
        let out = EmbeddedTextExtractor
            .extract_text(&request(SIMPLE_TEXT_PDF))
            .unwrap();
        assert_eq!(out.page_count, 1);
        assert_eq!(out.parsed_pages, 1);
        assert!(!out.truncated);
        assert!(out.text.contains("Hello (Friday)"));
        assert_eq!(out.pages[0].page_number, 1);
    }

    #[test]
    fn embedded_extractor_rejects_non_pdf_and_empty_pdf() {
        assert_eq!(
            EmbeddedTextExtractor.extract_text(&request(b"not a pdf")),
            Err(PdfParseError::NotPdf)
        );
        assert_eq!(
            EmbeddedTextExtractor.extract_text(&request(b"")),
            Err(PdfParseError::EmptyDocument)
        );
    }

    #[test]
    fn embedded_extractor_errors_when_no_text_literal_is_available() {
        let bytes = b"%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF";
        assert_eq!(
            EmbeddedTextExtractor.extract_text(&request(bytes)),
            Err(PdfParseError::NoExtractableText)
        );
    }

    #[test]
    fn limits_are_clamped_and_output_is_truncated() {
        let long_text = "a".repeat(MIN_ALLOWED_CHARS + 25);
        let bytes = format!(
            "%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nstream\n({long_text}) Tj\nendstream\n%%EOF"
        );
        let out = EmbeddedTextExtractor
            .extract_text(&PdfParseRequest {
                bytes: bytes.into_bytes(),
                limits: PdfParseLimits {
                    max_pages: 9999,
                    max_chars: 5,
                },
            })
            .unwrap();
        assert_eq!(out.text.len(), MIN_ALLOWED_CHARS);
        assert!(out.text.chars().all(|ch| ch == 'a'));
        assert!(out.truncated);
    }

    #[test]
    fn stub_extractor_is_deterministic_and_offline() {
        let out = StubPdfTextExtractor::default()
            .extract_text(&request(SIMPLE_TEXT_PDF))
            .unwrap();
        assert_eq!(out.page_count, 1);
        assert_eq!(out.text, "STUB-PDF: extracted text");
    }
}
