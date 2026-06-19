//! Friday B4 Studio/document export foundation: DARK Rust owner seam.
//!
//! This crate is intentionally Hub-side and DARK:
//! * no Hub route wiring;
//! * no production flag flip;
//! * no filesystem writes;
//! * no provider calls;
//! * no replacement of the existing TypeScript Studio surface.
//!
//! It gives B4 a Rust-owned, functional artifact core for HTML slide decks and
//! explicit fail-closed placeholders for binary office exports. The caller owns
//! persistence, path containment, auth, and future live gating.

use serde::Serialize;

pub const DEFAULT_SLIDE_COUNT: usize = 5;
pub const MAX_TOPIC_CHARS: usize = 160;
pub const MAX_NOTES_CHARS: usize = 8 * 1024;
pub const MAX_SLIDES: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StudioExportFormat {
    HtmlDeck,
    JsonManifest,
    MarkdownSpeakerNotes,
    Pptx,
    Docx,
    Pdf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioDeckRequest {
    pub topic: String,
    pub template: Option<String>,
    pub notes: Option<String>,
    pub slide_count: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StudioSlide {
    pub index: usize,
    pub title: String,
    pub bullets: Vec<String>,
    pub speaker_notes: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioArtifact {
    pub relative_path: String,
    pub format: StudioExportFormat,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioDeckOutcome {
    pub title: String,
    pub template: String,
    pub slides: Vec<StudioSlide>,
    pub artifacts: Vec<StudioArtifact>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum StudioError {
    #[error("studio topic is required")]
    EmptyTopic,
    #[error("studio topic exceeds {max} chars (got {got})")]
    TopicTooLong { got: usize, max: usize },
    #[error("studio notes exceed {max} chars (got {got})")]
    NotesTooLong { got: usize, max: usize },
    #[error("studio slide count must be between 1 and {max} (got {got})")]
    InvalidSlideCount { got: usize, max: usize },
    #[error("studio manifest serialization failed: {0}")]
    ManifestSerialization(String),
    #[error("studio export format {0:?} is not wired in Rust yet; capability remains DARK")]
    UnsupportedFormat(StudioExportFormat),
}

pub fn generate_html_deck(request: &StudioDeckRequest) -> Result<StudioDeckOutcome, StudioError> {
    let topic = validate_topic(&request.topic)?;
    let notes = validate_notes(request.notes.as_deref().unwrap_or(""))?;
    let slide_count = validate_slide_count(request.slide_count.unwrap_or(DEFAULT_SLIDE_COUNT))?;
    let template = request
        .template
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("pitch")
        .to_string();
    let slides = build_slides(topic, &template, notes, slide_count);
    let title = format!("Slides - {topic}");
    let html = render_html_deck(&title, &slides);
    let manifest = render_manifest(&title, &template, &slides)?;
    let speaker_notes = render_speaker_notes(&title, &slides);
    Ok(StudioDeckOutcome {
        title,
        template,
        slides,
        artifacts: vec![
            StudioArtifact {
                relative_path: "slides.html".to_string(),
                format: StudioExportFormat::HtmlDeck,
                mime_type: "text/html".to_string(),
                bytes: html.into_bytes(),
            },
            StudioArtifact {
                relative_path: "deck.json".to_string(),
                format: StudioExportFormat::JsonManifest,
                mime_type: "application/json".to_string(),
                bytes: manifest.into_bytes(),
            },
            StudioArtifact {
                relative_path: "speaker-notes.md".to_string(),
                format: StudioExportFormat::MarkdownSpeakerNotes,
                mime_type: "text/markdown".to_string(),
                bytes: speaker_notes.into_bytes(),
            },
        ],
    })
}

pub fn render_binary_export(
    _outcome: &StudioDeckOutcome,
    format: StudioExportFormat,
) -> Result<StudioArtifact, StudioError> {
    match format {
        StudioExportFormat::HtmlDeck
        | StudioExportFormat::JsonManifest
        | StudioExportFormat::MarkdownSpeakerNotes => Err(StudioError::UnsupportedFormat(format)),
        StudioExportFormat::Pptx | StudioExportFormat::Docx | StudioExportFormat::Pdf => {
            Err(StudioError::UnsupportedFormat(format))
        }
    }
}

fn validate_topic(topic: &str) -> Result<&str, StudioError> {
    let topic = topic.trim();
    if topic.is_empty() {
        return Err(StudioError::EmptyTopic);
    }
    let got = topic.chars().count();
    if got > MAX_TOPIC_CHARS {
        return Err(StudioError::TopicTooLong {
            got,
            max: MAX_TOPIC_CHARS,
        });
    }
    Ok(topic)
}

fn validate_notes(notes: &str) -> Result<&str, StudioError> {
    let got = notes.chars().count();
    if got > MAX_NOTES_CHARS {
        return Err(StudioError::NotesTooLong {
            got,
            max: MAX_NOTES_CHARS,
        });
    }
    Ok(notes)
}

fn validate_slide_count(slide_count: usize) -> Result<usize, StudioError> {
    if slide_count == 0 || slide_count > MAX_SLIDES {
        return Err(StudioError::InvalidSlideCount {
            got: slide_count,
            max: MAX_SLIDES,
        });
    }
    Ok(slide_count)
}

fn build_slides(topic: &str, template: &str, notes: &str, slide_count: usize) -> Vec<StudioSlide> {
    let note_lines: Vec<&str> = notes
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    (0..slide_count)
        .map(|idx| {
            let index = idx + 1;
            let theme = slide_theme(template, index);
            let source_note = note_lines.get(idx).copied().unwrap_or(topic);
            StudioSlide {
                index,
                title: format!("{theme}: {topic}"),
                bullets: vec![
                    format!("Focus: {source_note}"),
                    format!("Template lane: {template}"),
                    "Review with operator before external delivery.".to_string(),
                ],
                speaker_notes: format!(
                    "Slide {index} notes: ground this section in the supplied material and verify claims before publishing."
                ),
            }
        })
        .collect()
}

fn slide_theme(template: &str, index: usize) -> &'static str {
    match (template, index) {
        ("research", 1) => "Question",
        ("research", _) => "Evidence",
        ("data", 1) => "Metric",
        ("data", _) => "Insight",
        ("cross_border", 1) => "Market",
        ("cross_border", _) => "Channel",
        ("product", 1) => "Product",
        ("product", _) => "Use case",
        (_, 1) => "Opening",
        (_, 2) => "Problem",
        (_, 3) => "Approach",
        (_, 4) => "Proof",
        _ => "Next step",
    }
}

fn render_html_deck(title: &str, slides: &[StudioSlide]) -> String {
    let mut html = String::new();
    html.push_str("<!doctype html><html><head><meta charset=\"utf-8\"><title>");
    html.push_str(&escape_html(title));
    html.push_str("</title><style>");
    html.push_str("body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:#f7f7f5;color:#171717}");
    html.push_str("section{min-height:100vh;padding:72px 9vw;box-sizing:border-box;border-bottom:1px solid #ddd}");
    html.push_str("h1{font-size:44px;margin:0 0 24px}li{font-size:24px;line-height:1.45;margin:12px 0}.note{margin-top:36px;color:#555}");
    html.push_str("</style></head><body>");
    for slide in slides {
        html.push_str("<section><h1>");
        html.push_str(&escape_html(&slide.title));
        html.push_str("</h1><ul>");
        for bullet in &slide.bullets {
            html.push_str("<li>");
            html.push_str(&escape_html(bullet));
            html.push_str("</li>");
        }
        html.push_str("</ul><p class=\"note\">");
        html.push_str(&escape_html(&slide.speaker_notes));
        html.push_str("</p></section>");
    }
    html.push_str("</body></html>\n");
    html
}

fn render_speaker_notes(title: &str, slides: &[StudioSlide]) -> String {
    let mut out = format!("# {title}\n\n");
    for slide in slides {
        out.push_str(&format!("## Slide {} - {}\n\n", slide.index, slide.title));
        out.push_str(&slide.speaker_notes);
        out.push_str("\n\n");
    }
    out
}

fn render_manifest(
    title: &str,
    template: &str,
    slides: &[StudioSlide],
) -> Result<String, StudioError> {
    #[derive(Serialize)]
    struct Manifest<'a> {
        schema_version: &'static str,
        title: &'a str,
        template: &'a str,
        slide_count: usize,
        slides: &'a [StudioSlide],
        truth_label: &'static str,
    }

    serde_json::to_string_pretty(&Manifest {
        schema_version: "friday.studio.deck.v1",
        title,
        template,
        slide_count: slides.len(),
        slides,
        truth_label: "rust_dark_html_deck_only_no_pptx_docx_pdf_live",
    })
    .map(|s| format!("{s}\n"))
    .map_err(|e| StudioError::ManifestSerialization(e.to_string()))
}

fn escape_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> StudioDeckRequest {
        StudioDeckRequest {
            topic: "Cross-border launch".to_string(),
            template: Some("cross_border".to_string()),
            notes: Some("Audience\nChannel\nRisk".to_string()),
            slide_count: Some(3),
        }
    }

    #[test]
    fn generates_real_html_manifest_and_notes_artifacts() {
        let outcome = generate_html_deck(&request()).unwrap();
        assert_eq!(outcome.slides.len(), 3);
        assert_eq!(outcome.artifacts.len(), 3);
        let html = String::from_utf8(
            outcome
                .artifacts
                .iter()
                .find(|a| a.format == StudioExportFormat::HtmlDeck)
                .unwrap()
                .bytes
                .clone(),
        )
        .unwrap();
        assert!(html.contains("<!doctype html>"));
        assert!(html.contains("Cross-border launch"));
        assert!(html.contains("Market: Cross-border launch"));
        let manifest = String::from_utf8(
            outcome
                .artifacts
                .iter()
                .find(|a| a.format == StudioExportFormat::JsonManifest)
                .unwrap()
                .bytes
                .clone(),
        )
        .unwrap();
        assert!(manifest.contains("\"schema_version\": \"friday.studio.deck.v1\""));
        assert!(manifest.contains("rust_dark_html_deck_only_no_pptx_docx_pdf_live"));
    }

    #[test]
    fn escapes_html_from_user_material() {
        let mut req = request();
        req.topic = "<script>alert(1)</script>".to_string();
        let outcome = generate_html_deck(&req).unwrap();
        let html = String::from_utf8(outcome.artifacts[0].bytes.clone()).unwrap();
        assert!(!html.contains("<script>alert(1)</script>"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
    }

    #[test]
    fn validates_bounds_fail_closed() {
        let mut req = request();
        req.topic = " ".to_string();
        assert!(matches!(
            generate_html_deck(&req).unwrap_err(),
            StudioError::EmptyTopic
        ));
        req.topic = "Valid".to_string();
        req.slide_count = Some(MAX_SLIDES + 1);
        assert!(matches!(
            generate_html_deck(&req).unwrap_err(),
            StudioError::InvalidSlideCount { .. }
        ));
    }

    #[test]
    fn binary_exports_are_explicitly_dark_fail_closed() {
        let outcome = generate_html_deck(&request()).unwrap();
        assert_eq!(
            render_binary_export(&outcome, StudioExportFormat::Pptx).unwrap_err(),
            StudioError::UnsupportedFormat(StudioExportFormat::Pptx)
        );
        assert_eq!(
            render_binary_export(&outcome, StudioExportFormat::Docx).unwrap_err(),
            StudioError::UnsupportedFormat(StudioExportFormat::Docx)
        );
        assert_eq!(
            render_binary_export(&outcome, StudioExportFormat::Pdf).unwrap_err(),
            StudioError::UnsupportedFormat(StudioExportFormat::Pdf)
        );
    }
}
