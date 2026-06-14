//! artifact — the browser artifact-path helper (pure path-string logic), ported from the
//! TS `sanitizeArtifactPathSegment` / `browserArtifactDir`.
//!
//! Screenshot / PDF captures are written under
//! `<workspaceRoot>/.friday/artifacts/browser/<sanitized-sessionId>/…`. This module
//! computes that path and sanitizes the session-id segment so a hostile session id can't
//! traverse out of the artifacts dir. It does NO filesystem I/O — the actual byte writes
//! happen in the handler PRs (B2a) via the friday-fs root-containment primitives
//! (`create_dir_all_within_root` / `write_file_within_root`), which apply the realpath /
//! symlink-escape gate on top of this lexical sanitization. This crate carries no
//! friday-fs dependency.

use std::path::PathBuf;

use thiserror::Error;

/// A session-id (or other segment) that cannot be turned into a safe path component.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ArtifactPathError {
    /// The input was empty, was only separators, contained a `.`/`..` segment, or
    /// sanitized down to nothing — i.e. it could not yield a safe single path component.
    #[error("invalid artifact path segment \"{0}\"")]
    InvalidSegment(String),
}

/// Sanitize an arbitrary string into a SINGLE safe path component (the oracle's
/// `sanitizeArtifactPathSegment`):
///
/// 1. trim; split on any run of `/`/`\\`; drop empties;
/// 2. reject if there are no segments OR any segment is `.`/`..` (no traversal);
/// 3. join the surviving segments with `_`, replace any run of non-`[A-Za-z0-9._-]` with a
///    single `_`, and strip leading/trailing `._-`;
/// 4. reject if the result is empty.
///
/// The result NEVER contains a path separator — it is always one component.
pub fn sanitize_artifact_path_segment(input: &str) -> Result<String, ArtifactPathError> {
    let invalid = || ArtifactPathError::InvalidSegment(input.to_string());

    let raw = input.trim();
    let segments: Vec<&str> = raw.split(['/', '\\']).filter(|s| !s.is_empty()).collect();

    if segments.is_empty() || segments.iter().any(|s| *s == "." || *s == "..") {
        return Err(invalid());
    }

    // Join surviving segments with '_', then collapse non-allowed runs to a single '_'.
    let joined = segments.join("_");
    let mut collapsed = String::with_capacity(joined.len());
    let mut prev_was_underscore_fill = false;
    for ch in joined.chars() {
        let allowed = ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-';
        if allowed {
            collapsed.push(ch);
            prev_was_underscore_fill = false;
        } else if !prev_was_underscore_fill {
            collapsed.push('_');
            prev_was_underscore_fill = true;
        }
    }

    // Strip leading/trailing `._-`.
    let sanitized = collapsed.trim_matches(|c| c == '.' || c == '_' || c == '-');

    if sanitized.is_empty() {
        return Err(invalid());
    }
    Ok(sanitized.to_string())
}

/// Compute the per-session browser artifact directory RELATIVE to the workspace root:
/// `.friday/artifacts/browser/<sanitized-sessionId>`. The returned path is relative — the
/// handler joins it under the workspace root and writes through the friday-fs containment
/// gate (which re-validates against traversal/symlink-escape). Returns the sanitization
/// error if the session id is unsafe.
pub fn browser_artifact_dir(session_id: &str) -> Result<PathBuf, ArtifactPathError> {
    let safe = sanitize_artifact_path_segment(session_id)?;
    let mut p = PathBuf::from(".friday");
    p.push("artifacts");
    p.push("browser");
    p.push(safe);
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_session_id_passes_through() {
        assert_eq!(sanitize_artifact_path_segment("s1").unwrap(), "s1");
        assert_eq!(
            sanitize_artifact_path_segment("session-abc_123.v2").unwrap(),
            "session-abc_123.v2"
        );
    }

    #[test]
    fn traversal_segments_are_rejected() {
        // Any segment that is exactly "." or ".." rejects the whole input (no traversal).
        assert!(sanitize_artifact_path_segment("..").is_err());
        assert!(sanitize_artifact_path_segment("a/../b").is_err());
        assert!(sanitize_artifact_path_segment("./x").is_err());
        // NOTE: "/etc/passwd" has NO "."/".."" segment ([etc, passwd]) → it is NOT a
        // traversal; it sanitizes to the single component "etc_passwd" (asserted in
        // `path_separators_are_joined_with_underscore_not_kept`). The separators are
        // dropped, so the result can never escape the artifacts dir lexically.
    }

    #[test]
    fn path_separators_are_joined_with_underscore_not_kept() {
        // "/etc/passwd" → segments [etc, passwd] → "etc_passwd" (NO separator survives).
        let out = sanitize_artifact_path_segment("etc/passwd").unwrap();
        assert_eq!(out, "etc_passwd");
        assert!(!out.contains('/'));
        let win = sanitize_artifact_path_segment("a\\b\\c").unwrap();
        assert_eq!(win, "a_b_c");
    }

    #[test]
    fn disallowed_chars_collapse_to_single_underscore() {
        assert_eq!(sanitize_artifact_path_segment("a  b!!!c").unwrap(), "a_b_c");
    }

    #[test]
    fn leading_trailing_punctuation_is_stripped() {
        assert_eq!(sanitize_artifact_path_segment("__abc--").unwrap(), "abc");
        assert_eq!(sanitize_artifact_path_segment("...x...").unwrap(), "x");
    }

    #[test]
    fn empty_or_all_punctuation_is_rejected() {
        assert!(sanitize_artifact_path_segment("").is_err());
        assert!(sanitize_artifact_path_segment("   ").is_err());
        assert!(sanitize_artifact_path_segment("///").is_err());
        // Sanitizes down to empty after stripping → reject.
        assert!(sanitize_artifact_path_segment("!!!").is_err());
        assert!(sanitize_artifact_path_segment("___").is_err());
    }

    #[test]
    fn artifact_dir_is_relative_and_under_friday_artifacts_browser() {
        let dir = browser_artifact_dir("s1").unwrap();
        assert_eq!(
            dir,
            PathBuf::from(".friday/artifacts/browser/s1"),
            "got {dir:?}"
        );
        // Hostile session id is sanitized into one component.
        let dir2 = browser_artifact_dir("../../escape").unwrap_or_else(|_| PathBuf::new());
        // "../../escape" → segments contain ".." → rejected → empty fallback above.
        assert_eq!(dir2, PathBuf::new());
    }

    #[test]
    fn artifact_dir_rejects_unsafe_session_id() {
        assert!(browser_artifact_dir("..").is_err());
        assert!(browser_artifact_dir("").is_err());
    }
}
