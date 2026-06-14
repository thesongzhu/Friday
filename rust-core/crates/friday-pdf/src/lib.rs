//! friday-pdf — the `pdf_parse` domain crate (Hub-only, no phone surface).
//!
//! This crate is the pure-domain half of Friday's `pdf_parse` tool. It mirrors
//! the TS oracle `createFridayAgentPdfParseTool`
//! (`src/agent/tools/friday-agent-pdf-parse-tool.ts`): extract text from a local
//! PDF inside the workspace and return page count, per-page text, and a combined
//! truncated text field.
//!
//! Boundary (the F11 `§0.1` linchpin rule, matching the deepseek/anthropic
//! precedent): the capability crate ships the **DI trait + a deterministic
//! stub**; it does NOT `impl friday_hub::ToolExecutor` (that would force a
//! `friday-pdf → friday-hub` cycle). The `impl ToolExecutor` wrapper is a
//! `friday-hub` MODULE (`pdf_parse_executor.rs`, the later PDF-EXEC PR), which
//! reads the workspace-confined bytes via `friday_fs::open_read_within_root` and
//! delegates the *parsing* to a `dyn PdfTextExtractor` injected here.
//!
//! What lands in THIS PR (PDF-1):
//! - [`PdfTextExtractor`] — the DI trait (`extract(bytes, max_pages, max_chars)`).
//! - [`PdfParseResult`] / [`PdfPage`] — the output shape, mirroring the oracle
//!   JSON `{pageCount, parsedPages, truncated, text, pages:[{pageNumber,text}]}`
//!   (the `filePath` field is supplied by the hub executor, not the extractor).
//! - [`PdfError`] — a structured, secret-free error.
//! - [`StubPdfExtractor`] — a deterministic in-tree extractor (fixture output
//!   derived from the byte input, NO real PDF parsing) so every clamp/window/
//!   truncate path is unit-testable with no external dependency.
//! - The clamp/page-window/truncate primitives ([`clamp_max_pages`],
//!   [`clamp_max_chars`], [`truncate_output`], [`assemble_pages`]) ported
//!   **verbatim** from the oracle so the eventual real extractor (PDF-2) and the
//!   stub produce byte-identical bounding.
//!
//! The real embedded-text extractor (`RealPdfExtractor`, `src/real.rs`) lands in
//! PDF-2 behind the DEFAULT-OFF `pdf-extract-live` cargo feature (declared in
//! this crate's `Cargo.toml`). The default build links ONLY [`StubPdfExtractor`].
//!
//! Pure domain logic: NO I/O, NO network, NO `SystemTime::now`, NO env reads.
//! There is no runtime flag in this crate — the `FRIDAY_PDF_PARSE_ENABLED` gate
//! is enforced later at the hub (the WIRE composite arm), never here.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Oracle clamp bounds for `maxPages` (`friday-agent-pdf-parse-tool.ts:15-16,60`).
pub const DEFAULT_MAX_PAGES: u32 = 50;
pub const MAX_ALLOWED_PAGES: u32 = 500;
/// Lower clamp bound for `maxPages` (the oracle clamps to `[1, 500]`).
pub const MIN_ALLOWED_PAGES: u32 = 1;

/// Oracle clamp bounds for `maxChars` (`:17-18,61`). The default mirrors the
/// oracle's `FRIDAY_AGENT_READ_MAX_BYTES = 50 * 1024` (friday-agent.constants).
pub const DEFAULT_MAX_CHARS: u32 = 50 * 1024;
pub const MAX_ALLOWED_CHARS: u32 = 250_000;
/// Lower clamp bound for `maxChars` (the oracle clamps to `[1_000, 250_000]`).
pub const MIN_ALLOWED_CHARS: u32 = 1_000;

/// The marker the oracle appends when a string is truncated past its byte budget
/// (`truncateOutput`, friday-agent-tool-helpers.ts).
pub const TRUNCATION_MARKER: &str = "\n... [truncated]";

/// One extracted page. Mirrors the oracle `{pageNumber, text}` entry.
///
/// `text` is the per-page text **after** the oracle's per-page
/// `truncateOutput(text, maxChars)` byte-bounding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdfPage {
    /// 1-based page number, matching the oracle (`pageNumber`).
    pub page_number: u32,
    /// The page's extracted text, byte-bounded to `max_chars`.
    pub text: String,
}

/// The extractor output. Mirrors the oracle JSON
/// `{pageCount, parsedPages, truncated, text, pages}`.
///
/// The oracle additionally returns `filePath`; that is supplied by the hub
/// executor (which owns the resolved path), NOT by the pure extractor, so it is
/// deliberately absent here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdfParseResult {
    /// Total pages in the document (`pageCount`).
    pub page_count: u32,
    /// Pages actually parsed (`parsedPages`) — `pages.len()`, bounded by the
    /// page window AND the early combined-length break.
    pub parsed_pages: u32,
    /// `true` iff the document had more pages than were parsed OR the combined
    /// text exceeded `max_chars` (`pageCount > pages.length || combined.length > maxChars`).
    pub truncated: bool,
    /// The combined `--- Page N ---`-joined text, byte-bounded to `max_chars`.
    pub text: String,
    /// The per-page texts (each byte-bounded to `max_chars`).
    pub pages: Vec<PdfPage>,
}

/// Structured, secret-free extraction error. Mirrors the oracle's adverse paths
/// (`not a PDF`, parse failure). The path-confinement / not-found errors live at
/// the hub executor's `open_read_within_root` boundary (PDF-EXEC), NOT here —
/// this trait receives bytes that are already workspace-confined.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PdfError {
    /// The input bytes are not a parseable PDF (the oracle's
    /// `PDF parsing failed: …`). Display is coarse; it never echoes raw bytes.
    #[error("PDF parse failed: {0}")]
    Parse(String),
    /// The input was empty / not a PDF document at all (no `%PDF` header).
    #[error("input is not a PDF document")]
    NotPdf,
}

/// The DI seam (the `§0.1` rule: trait lives in the capability crate; the
/// `impl ToolExecutor` wrapper is hub-side). The real backend (`RealPdfExtractor`,
/// PDF-2, behind `pdf-extract-live`) and the deterministic [`StubPdfExtractor`]
/// both implement this; the hub executor (PDF-EXEC) holds a `Box<dyn PdfTextExtractor>`.
///
/// `extract` is pure with respect to its inputs: same `(bytes, max_pages,
/// max_chars)` → same `PdfParseResult` (for the stub, deterministically; for the
/// real extractor, given the same document). It performs NO I/O and NO network.
pub trait PdfTextExtractor {
    /// Extract text from in-memory PDF `bytes`, honouring the page window
    /// (`max_pages`) and the combined char budget (`max_chars`).
    ///
    /// `max_pages` / `max_chars` are the caller's RAW requested values; the
    /// implementation clamps them via [`clamp_max_pages`] / [`clamp_max_chars`]
    /// (so a caller passing `0`/`None`/an absurd value gets the oracle defaults).
    fn extract(
        &self,
        bytes: &[u8],
        max_pages: Option<u32>,
        max_chars: Option<u32>,
    ) -> Result<PdfParseResult, PdfError>;
}

/// Clamp the requested `maxPages` to `[1, 500]` with default `50`, mirroring the
/// oracle `clampInteger(value, 1, 500, 50)` (`:60` + `clampInteger :148`).
///
/// `None` (the oracle's `undefined`/non-finite) → the default. The value is
/// already an integer in Rust, so the oracle's `Math.trunc` is a no-op here.
pub fn clamp_max_pages(value: Option<u32>) -> u32 {
    match value {
        None => DEFAULT_MAX_PAGES,
        Some(v) => v.clamp(MIN_ALLOWED_PAGES, MAX_ALLOWED_PAGES),
    }
}

/// Clamp the requested `maxChars` to `[1_000, 250_000]` with default `50*1024`,
/// mirroring the oracle `clampInteger(value, 1_000, 250_000, 50*1024)` (`:61`).
pub fn clamp_max_chars(value: Option<u32>) -> u32 {
    match value {
        None => DEFAULT_MAX_CHARS,
        Some(v) => v.clamp(MIN_ALLOWED_CHARS, MAX_ALLOWED_CHARS),
    }
}

/// The oracle's "JS string `.length`" — the number of UTF-16 code units.
///
/// The oracle's page-window early break and the `truncated` flag both test
/// `combined.length >= / > maxChars`, where `.length` is UTF-16 code units (NOT
/// bytes, NOT Unicode scalar count). We mirror that exactly so the parsed-page
/// window and the truncated flag are byte-for-byte faithful to the oracle for
/// any input (including astral-plane characters).
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Byte-bounded truncation, ported verbatim from the oracle `truncateOutput`
/// (friday-agent-tool-helpers.ts:409): if the UTF-8 byte length is within
/// `max_bytes`, return the text unchanged; otherwise cut at the largest char
/// boundary whose prefix fits in `max_bytes` bytes and append
/// [`TRUNCATION_MARKER`].
///
/// The oracle binary-searches a UTF-16 slice index; Rust slices on byte indices
/// at char boundaries. Both keep the largest prefix whose UTF-8 encoding is
/// `<= max_bytes` then append the marker, so the produced output is identical
/// for all inputs (the only representational difference — UTF-16 unit vs byte
/// cut index — collapses because both target the same UTF-8 byte budget).
pub fn truncate_output(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        // `str::len()` is the UTF-8 byte length — exactly the oracle's
        // `Buffer.byteLength(text, "utf8")`.
        return text.to_string();
    }
    // Largest char-boundary prefix whose UTF-8 length is <= max_bytes.
    let mut cut = 0usize;
    for (idx, ch) in text.char_indices() {
        let end = idx + ch.len_utf8();
        if end <= max_bytes {
            cut = end;
        } else {
            break;
        }
    }
    let mut out = String::with_capacity(cut + TRUNCATION_MARKER.len());
    out.push_str(&text[..cut]);
    out.push_str(TRUNCATION_MARKER);
    out
}

/// Assemble the per-page texts into the oracle's `{pageCount, parsedPages,
/// truncated, text, pages}` shape, applying the EXACT oracle page-window +
/// combined-join + early-break + truncated-flag semantics (`:98-121`).
///
/// `page_texts` is the raw (untruncated) extracted text for the pages within the
/// `maxPages` window — i.e. the extractor has ALREADY limited it to at most
/// `maxPages` entries (the oracle's `parsePageCount = min(pageCount, maxPages)`
/// loop bound). `page_count` is the document's TRUE total page count, which is
/// what feeds the `pageCount > parsedPages` truncated test.
///
/// Oracle algorithm (preserved verbatim):
/// 1. For `pageNumber` in `1..=page_texts.len()`:
///    - push `{pageNumber, truncateOutput(text, maxChars)}`;
///    - `combined += (combined ? "\n\n" : "") + "--- Page N ---\n" + text`
///      (note: the COMBINED uses the RAW page text, not the per-page-truncated text);
///    - if `combined.length >= maxChars` → break.
/// 2. `truncated = pageCount > pages.length || combined.length > maxChars`.
/// 3. `text = truncateOutput(combined, maxChars)`.
pub fn assemble_pages(page_count: u32, page_texts: &[String], max_chars: u32) -> PdfParseResult {
    let max_chars_usize = max_chars as usize;

    let mut pages: Vec<PdfPage> = Vec::with_capacity(page_texts.len());
    let mut combined = String::new();

    for (i, raw_text) in page_texts.iter().enumerate() {
        let page_number = (i as u32) + 1;
        pages.push(PdfPage {
            page_number,
            text: truncate_output(raw_text, max_chars_usize),
        });
        if !combined.is_empty() {
            combined.push_str("\n\n");
        }
        combined.push_str("--- Page ");
        combined.push_str(&page_number.to_string());
        combined.push_str(" ---\n");
        combined.push_str(raw_text);
        if utf16_len(&combined) >= max_chars_usize {
            break;
        }
    }

    let parsed_pages = pages.len() as u32;
    let truncated = page_count > parsed_pages || utf16_len(&combined) > max_chars_usize;
    let text = truncate_output(&combined, max_chars_usize);

    PdfParseResult {
        page_count,
        parsed_pages,
        truncated,
        text,
        pages,
    }
}

/// A deterministic, in-tree [`PdfTextExtractor`] — NO real PDF parsing.
///
/// It derives fixture page texts from the byte input so that every clamp / page-
/// window / truncate path in [`assemble_pages`] is exercised end-to-end with no
/// external dependency and no `pdf-extract-live` feature. This is NEVER a runtime
/// fallback for the real extractor: PDF-EXEC injects exactly one of
/// `StubPdfExtractor` (dark default) or `RealPdfExtractor` (feature + flag), never
/// silently substitutes one for the other.
///
/// Model: the stub treats the input as a `\x0c` (form-feed) separated set of
/// UTF-8 "pages" (an inert, deterministic convention — NOT the PDF wire format)
/// following a leading `%PDF` marker. An input without the `%PDF` marker is
/// [`PdfError::NotPdf`]; the literal bytes `__pdf_parse_error__` anywhere in the
/// input force a [`PdfError::Parse`] so the adverse path is testable. The
/// document's reported `page_count` is the number of fixture pages BEFORE the
/// `max_pages` window is applied.
#[derive(Debug, Clone, Default)]
pub struct StubPdfExtractor;

impl StubPdfExtractor {
    pub fn new() -> Self {
        StubPdfExtractor
    }
}

impl PdfTextExtractor for StubPdfExtractor {
    fn extract(
        &self,
        bytes: &[u8],
        max_pages: Option<u32>,
        max_chars: Option<u32>,
    ) -> Result<PdfParseResult, PdfError> {
        let max_pages = clamp_max_pages(max_pages);
        let max_chars = clamp_max_chars(max_chars);

        let content = String::from_utf8_lossy(bytes);
        if content.contains("__pdf_parse_error__") {
            return Err(PdfError::Parse("stub forced parse error".to_string()));
        }
        // An inert "is this a PDF" gate: the stub fixture convention requires a
        // leading `%PDF` marker (matching a real PDF header), else it is NotPdf.
        if !content.starts_with("%PDF") {
            return Err(PdfError::NotPdf);
        }

        // Fixture pages: form-feed separated, after the `%PDF` header marker.
        let body = content.strip_prefix("%PDF").unwrap_or(&content);
        let all_pages: Vec<String> = body
            .split('\x0c')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();

        // The document's TRUE total page count (before the max_pages window).
        let page_count = all_pages.len() as u32;

        // parsePageCount = min(pageCount, maxPages): window the page texts before
        // assembly so the early combined-length break in `assemble_pages` matches
        // the oracle (which only ever pushes pages within the maxPages window).
        let windowed: Vec<String> = all_pages.into_iter().take(max_pages as usize).collect();

        Ok(assemble_pages(page_count, &windowed, max_chars))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- clamp ----------------------------------------------------------

    #[test]
    fn clamp_max_pages_matches_oracle_bounds() {
        assert_eq!(clamp_max_pages(None), DEFAULT_MAX_PAGES); // undefined -> default 50
        assert_eq!(clamp_max_pages(Some(0)), MIN_ALLOWED_PAGES); // below min -> 1
        assert_eq!(clamp_max_pages(Some(1)), 1);
        assert_eq!(clamp_max_pages(Some(50)), 50);
        assert_eq!(clamp_max_pages(Some(500)), 500);
        assert_eq!(clamp_max_pages(Some(99_999)), MAX_ALLOWED_PAGES); // above max -> 500
    }

    #[test]
    fn clamp_max_chars_matches_oracle_bounds() {
        assert_eq!(clamp_max_chars(None), DEFAULT_MAX_CHARS); // undefined -> 50*1024
        assert_eq!(clamp_max_chars(Some(0)), MIN_ALLOWED_CHARS); // below min -> 1000
        assert_eq!(clamp_max_chars(Some(500)), MIN_ALLOWED_CHARS);
        assert_eq!(clamp_max_chars(Some(1_000)), 1_000);
        assert_eq!(clamp_max_chars(Some(50 * 1024)), 50 * 1024);
        assert_eq!(clamp_max_chars(Some(250_000)), MAX_ALLOWED_CHARS);
        assert_eq!(clamp_max_chars(Some(999_999)), MAX_ALLOWED_CHARS); // above max -> 250000
    }

    // ---- truncate_output ------------------------------------------------

    #[test]
    fn truncate_output_under_budget_is_unchanged() {
        let s = "hello world";
        assert_eq!(truncate_output(s, 1024), s);
        // Exactly at the byte budget is NOT truncated (<=).
        assert_eq!(truncate_output(s, s.len()), s);
    }

    #[test]
    fn truncate_output_over_budget_cuts_and_marks() {
        let s = "abcdefghij"; // 10 bytes
        let out = truncate_output(s, 4);
        assert_eq!(out, format!("abcd{TRUNCATION_MARKER}"));
    }

    #[test]
    fn truncate_output_never_splits_a_multibyte_char() {
        // "é" is 2 UTF-8 bytes; budget 3 must keep only the first "é" (2 bytes),
        // never half of the second.
        let s = "ééé"; // 6 bytes
        let out = truncate_output(s, 3);
        assert_eq!(out, format!("é{TRUNCATION_MARKER}"));
        assert!(out.starts_with('é'));
    }

    // ---- utf16_len (the oracle .length) ---------------------------------

    #[test]
    fn utf16_len_matches_js_string_length() {
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("é"), 1); // BMP scalar -> 1 UTF-16 unit
        assert_eq!(utf16_len("😀"), 2); // astral -> surrogate pair -> 2 units (JS .length)
    }

    // ---- assemble_pages: page-window + join + early-break + truncated ----

    #[test]
    fn assemble_joins_pages_with_page_headers() {
        let pages = vec!["alpha".to_string(), "beta".to_string()];
        let res = assemble_pages(2, &pages, 100_000);
        assert_eq!(res.page_count, 2);
        assert_eq!(res.parsed_pages, 2);
        assert!(!res.truncated);
        assert_eq!(res.text, "--- Page 1 ---\nalpha\n\n--- Page 2 ---\nbeta");
        assert_eq!(res.pages.len(), 2);
        assert_eq!(res.pages[0].page_number, 1);
        assert_eq!(res.pages[0].text, "alpha");
        assert_eq!(res.pages[1].page_number, 2);
        assert_eq!(res.pages[1].text, "beta");
    }

    #[test]
    fn assemble_truncated_true_when_more_pages_than_window() {
        // page_count=5 but only the first 2 page texts were extracted (the
        // extractor applied the maxPages window) -> pageCount > parsedPages.
        let pages = vec!["a".to_string(), "b".to_string()];
        let res = assemble_pages(5, &pages, 100_000);
        assert_eq!(res.parsed_pages, 2);
        assert!(
            res.truncated,
            "pageCount(5) > parsedPages(2) must set truncated"
        );
    }

    #[test]
    fn assemble_early_break_when_combined_reaches_max_chars() {
        // Each page contributes "--- Page N ---\n" (15 chars) + the body. With a
        // small max_chars the loop breaks after the first page whose combined
        // length reaches the budget, so parsed_pages < window and truncated.
        let big = "x".repeat(50);
        let pages = vec![big.clone(), big.clone(), big.clone()];
        let res = assemble_pages(3, &pages, 30);
        assert_eq!(
            res.parsed_pages, 1,
            "break after the first over-budget page"
        );
        assert!(res.truncated);
        // The combined text was itself byte-truncated to the budget.
        assert!(res.text.ends_with(TRUNCATION_MARKER));
    }

    #[test]
    fn assemble_empty_document_is_not_truncated() {
        let res = assemble_pages(0, &[], 100_000);
        assert_eq!(res.page_count, 0);
        assert_eq!(res.parsed_pages, 0);
        assert!(!res.truncated);
        assert_eq!(res.text, "");
        assert!(res.pages.is_empty());
    }

    #[test]
    fn assemble_combined_uses_raw_text_pages_use_truncated_text() {
        // The oracle builds `combined` from the RAW page text but stores the
        // per-page-TRUNCATED text in `pages[]`. Verify the divergence.
        let long = "y".repeat(20);
        let pages = vec![long.clone()];
        // max_chars=10: page text is truncated to 10 bytes + marker; combined is
        // built from the raw 20-char text (header + raw) then byte-truncated.
        let res = assemble_pages(1, &pages, 10);
        assert_eq!(res.pages[0].text, truncate_output(&long, 10));
        assert!(res.pages[0].text.ends_with(TRUNCATION_MARKER));
        assert!(res.text.ends_with(TRUNCATION_MARKER));
    }

    // ---- StubPdfExtractor: end-to-end through the trait ------------------

    fn stub_doc(pages: &[&str]) -> Vec<u8> {
        // %PDF header + form-feed-separated pages (the stub fixture convention).
        let body = pages.join("\x0c");
        format!("%PDF\x0c{body}").into_bytes()
    }

    #[test]
    fn stub_extracts_multi_page_document() {
        let ex = StubPdfExtractor::new();
        let doc = stub_doc(&["first page", "second page"]);
        let res = ex.extract(&doc, None, None).unwrap();
        assert_eq!(res.page_count, 2);
        assert_eq!(res.parsed_pages, 2);
        assert!(!res.truncated);
        assert_eq!(res.pages[0].text, "first page");
        assert_eq!(res.pages[1].text, "second page");
        assert_eq!(
            res.text,
            "--- Page 1 ---\nfirst page\n\n--- Page 2 ---\nsecond page"
        );
    }

    #[test]
    fn stub_is_deterministic() {
        let ex = StubPdfExtractor::new();
        let doc = stub_doc(&["a", "b", "c"]);
        let r1 = ex.extract(&doc, Some(10), Some(5000)).unwrap();
        let r2 = ex.extract(&doc, Some(10), Some(5000)).unwrap();
        assert_eq!(r1, r2);
    }

    #[test]
    fn stub_applies_max_pages_window_and_sets_truncated() {
        let ex = StubPdfExtractor::new();
        let doc = stub_doc(&["p1", "p2", "p3", "p4"]);
        let res = ex.extract(&doc, Some(2), None).unwrap();
        assert_eq!(
            res.page_count, 4,
            "true total page count survives the window"
        );
        assert_eq!(res.parsed_pages, 2, "only maxPages parsed");
        assert!(res.truncated, "pageCount(4) > parsedPages(2)");
        assert_eq!(res.pages.len(), 2);
    }

    #[test]
    fn stub_rejects_non_pdf_input() {
        let ex = StubPdfExtractor::new();
        assert_eq!(
            ex.extract(b"not a pdf", None, None).unwrap_err(),
            PdfError::NotPdf
        );
        assert_eq!(ex.extract(b"", None, None).unwrap_err(), PdfError::NotPdf);
    }

    #[test]
    fn stub_forced_parse_error_is_testable() {
        let ex = StubPdfExtractor::new();
        let doc = stub_doc(&["ok", "__pdf_parse_error__"]);
        assert!(matches!(
            ex.extract(&doc, None, None).unwrap_err(),
            PdfError::Parse(_)
        ));
    }

    #[test]
    fn stub_clamps_absurd_inputs_to_oracle_defaults() {
        let ex = StubPdfExtractor::new();
        let doc = stub_doc(&["only page"]);
        // max_pages 0 clamps to 1 (>=1 page parsed); max_chars 0 clamps to 1000.
        let res = ex.extract(&doc, Some(0), Some(0)).unwrap();
        assert_eq!(res.parsed_pages, 1);
        assert_eq!(res.page_count, 1);
    }

    // ---- error/result serde round-trip (the receipt projection shape) ----

    #[test]
    fn result_serializes_with_the_oracle_field_set() {
        let res = assemble_pages(1, &["hi".to_string()], 100_000);
        let v: serde_json::Value = serde_json::to_value(&res).unwrap();
        // snake_case field names (the Rust receipt; the hub maps to the oracle
        // camelCase at projection time). Assert the field SET is the oracle's.
        let obj = v.as_object().unwrap();
        assert!(obj.contains_key("page_count"));
        assert!(obj.contains_key("parsed_pages"));
        assert!(obj.contains_key("truncated"));
        assert!(obj.contains_key("text"));
        assert!(obj.contains_key("pages"));
        // No filePath: that is the hub executor's field, not the extractor's.
        assert!(!obj.contains_key("file_path"));
        let back: PdfParseResult = serde_json::from_value(v).unwrap();
        assert_eq!(back, res);
    }
}
