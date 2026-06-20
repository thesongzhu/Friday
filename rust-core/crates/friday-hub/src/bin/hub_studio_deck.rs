//! B4 Studio DARK Hub entrypoint.
//!
//! This is a metadata-only proof surface for the Rust Studio core. It does not
//! create a product route, write files, call providers, or replace the TS Studio
//! surface. The flag is exact-`1` default-off so prod behavior stays unchanged.

use std::env;

use friday_studio::{
    generate_html_deck, render_binary_export, StudioDeckRequest, StudioError, StudioExportFormat,
};
use serde_json::json;
use sha2::{Digest, Sha256};

const FLAG: &str = "FRIDAY_STUDIO_RUST_ENABLED";

struct CliError {
    kind: &'static str,
}

impl CliError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

fn main() {
    match run() {
        Ok(rendered) => println!("{rendered}"),
        Err(err) => {
            let payload = json!({
                "truth_label": "b4_studio_rust_dark_hub",
                "ok": false,
                "live": false,
                "writes_files": false,
                "calls_provider": false,
                "error_kind": err.kind,
            });
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_studio_deck_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, CliError> {
    if !studio_enabled_from_env() {
        return Err(CliError::new("flag_disabled"));
    }

    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) != Some("render-html-deck") {
        return Err(CliError::new("bad_args"));
    }

    let request = StudioDeckRequest {
        topic: arg_value(&args, "--topic").ok_or(CliError::new("bad_args"))?,
        template: arg_value(&args, "--template"),
        notes: arg_value(&args, "--notes"),
        slide_count: arg_value(&args, "--slide-count").and_then(|v| v.parse::<usize>().ok()),
    };
    let outcome = generate_html_deck(&request).map_err(|err| CliError::new(studio_error(&err)))?;

    if let Some(format) = arg_value(&args, "--binary-format") {
        let format = parse_binary_format(&format).ok_or(CliError::new("bad_args"))?;
        render_binary_export(&outcome, format).map_err(|err| CliError::new(studio_error(&err)))?;
    }

    let artifacts: Vec<serde_json::Value> = outcome
        .artifacts
        .iter()
        .map(|artifact| {
            json!({
                "relative_path": artifact.relative_path,
                "format": artifact.format,
                "mime_type": artifact.mime_type,
                "byte_len": artifact.bytes.len(),
                "sha256": sha256_hex(&artifact.bytes),
            })
        })
        .collect();

    let payload = json!({
        "truth_label": "b4_studio_rust_dark_hub",
        "ok": true,
        "live": false,
        "writes_files": false,
        "calls_provider": false,
        "binary_exports_live": false,
        "slide_count": outcome.slides.len(),
        "artifact_count": artifacts.len(),
        "artifacts": artifacts,
    });
    let rendered =
        serde_json::to_string(&payload).map_err(|_| CliError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
}

fn studio_enabled_from_env() -> bool {
    env::var(FLAG).map(|v| v == "1").unwrap_or(false)
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == name).then(|| pair[1].clone()))
        .or_else(|| {
            let prefix = format!("{name}=");
            args.iter()
                .find_map(|arg| arg.strip_prefix(&prefix).map(str::to_string))
        })
}

fn parse_binary_format(value: &str) -> Option<StudioExportFormat> {
    match value {
        "pptx" => Some(StudioExportFormat::Pptx),
        "docx" => Some(StudioExportFormat::Docx),
        "pdf" => Some(StudioExportFormat::Pdf),
        _ => None,
    }
}

fn studio_error(err: &StudioError) -> &'static str {
    match err {
        StudioError::EmptyTopic => "empty_topic",
        StudioError::TopicTooLong { .. } => "topic_too_long",
        StudioError::NotesTooLong { .. } => "notes_too_long",
        StudioError::InvalidSlideCount { .. } => "invalid_slide_count",
        StudioError::ManifestSerialization(_) => "serialize_failed",
        StudioError::UnsupportedFormat(_) => "unsupported_binary_format",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn reject_forbidden_output(rendered: &str) -> Result<(), CliError> {
    friday_hub::refs_guard::reject_forbidden_output(
        rendered,
        &["<!doctype", "<section", "\"speaker_notes\"", "slides\":["],
    )
    .map_err(|_| CliError::new("output_guard"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_matcher_is_exact_one_default_off() {
        env::remove_var(FLAG);
        assert!(!studio_enabled_from_env());
        env::set_var(FLAG, "true");
        assert!(!studio_enabled_from_env());
        env::set_var(FLAG, "1");
        assert!(studio_enabled_from_env());
        env::remove_var(FLAG);
    }

    #[test]
    fn forbidden_output_guard_blocks_artifact_bodies() {
        assert!(reject_forbidden_output(r#"{"body":"<!doctype html>"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"speaker_notes":"x"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"ok":true,"artifact_count":3}"#).is_ok());
    }
}
