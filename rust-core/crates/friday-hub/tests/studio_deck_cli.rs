//! B4 Studio Hub DARK CLI tests.
//!
//! The CLI proves Hub can reach the Rust Studio artifact core behind an exact
//! default-off flag while remaining metadata-only: no file writes, no provider
//! calls, and binary office exports fail closed.

use std::process::Command;

use serde_json::Value;

fn base_cmd() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_hub_studio_deck"));
    cmd.arg("render-html-deck")
        .arg("--topic")
        .arg("Cross-border launch")
        .arg("--template")
        .arg("cross_border")
        .arg("--notes")
        .arg("Audience\nChannel\nRisk")
        .arg("--slide-count")
        .arg("3");
    cmd
}

#[test]
fn flag_off_fails_closed_without_rendering_artifacts() {
    let output = base_cmd()
        .env_remove("FRIDAY_STUDIO_RUST_ENABLED")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["truth_label"], "b4_studio_rust_dark_hub");
    assert_eq!(value["ok"], false);
    assert_eq!(value["live"], false);
    assert_eq!(value["error_kind"], "flag_disabled");
    assert!(value.get("artifacts").is_none());
}

#[test]
fn flag_on_returns_metadata_for_real_html_manifest_and_notes_artifacts() {
    let output = base_cmd()
        .env("FRIDAY_STUDIO_RUST_ENABLED", "1")
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(!stdout.contains("<!doctype"));
    assert!(!stdout.contains("\"speaker_notes\""));
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["truth_label"], "b4_studio_rust_dark_hub");
    assert_eq!(value["ok"], true);
    assert_eq!(value["live"], false);
    assert_eq!(value["writes_files"], false);
    assert_eq!(value["calls_provider"], false);
    assert_eq!(value["binary_exports_live"], false);
    assert_eq!(value["slide_count"], 3);
    assert_eq!(value["artifact_count"], 3);
    let artifacts = value["artifacts"].as_array().unwrap();
    assert_eq!(artifacts[0]["relative_path"], "slides.html");
    assert_eq!(artifacts[1]["relative_path"], "deck.json");
    assert_eq!(artifacts[2]["relative_path"], "speaker-notes.md");
    assert!(artifacts
        .iter()
        .all(|a| a["byte_len"].as_u64().unwrap() > 0));
    assert!(artifacts
        .iter()
        .all(|a| a["sha256"].as_str().is_some_and(|s| s.len() == 64)));
}

#[test]
fn binary_exports_fail_closed_even_when_studio_flag_is_on() {
    let output = base_cmd()
        .env("FRIDAY_STUDIO_RUST_ENABLED", "1")
        .arg("--binary-format")
        .arg("pptx")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["truth_label"], "b4_studio_rust_dark_hub");
    assert_eq!(value["ok"], false);
    assert_eq!(value["live"], false);
    assert_eq!(value["error_kind"], "unsupported_binary_format");
}
