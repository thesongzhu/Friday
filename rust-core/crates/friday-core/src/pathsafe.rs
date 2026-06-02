//! Lexical workspace-root containment (`39` §3 / PR-4-pure).
//!
//! A faithful Rust port of the **lexical** checks in the TS oracle
//! `src/utilities/friday-path-safety.ts` (`isWithinBase` + the lexical parts of
//! `resolveSafePath`): reject an absolute candidate, reject any `..` path
//! segment, resolve the candidate against the root, and reject if the resulting
//! relative path escapes the root (starts with `..` or is itself absolute).
//!
//! Scope — this is **lexical only**. It performs NO syscalls: no `realpath`, no
//! `openat`, no `O_NOFOLLOW`, no `lstat`. The hardened I/O half of the oracle
//! (the `fs.realpathSync` ancestor walk and `openFileWithinRoot`) is deferred to
//! PR-6 / friday-hub, which does not exist yet. Symlink-based escapes are
//! therefore **out of scope** here — this is the pure lexical floor that the
//! hardened I/O check will later sit on top of.
//!
//! Faithful-divergence note: the TS oracle splits path segments on **both** `/`
//! and `\` (`relativePath.split(/[/\\]/)`) to catch Windows-style traversal even
//! on POSIX. We mirror that — a `..` segment is rejected whether delimited by
//! `/` or `\` — so a candidate like `a\..\b` is rejected as traversal on every
//! platform, matching the oracle rather than relying on `std::path` (which treats
//! `\` as an ordinary character on POSIX).

/// Why a candidate path was rejected by [`contained`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathError {
    /// The candidate was an absolute path (the oracle's `PATH_ABSOLUTE_REJECTED`).
    Absolute,
    /// The candidate contained a `..` path segment (the oracle's
    /// `PATH_TRAVERSAL_REJECTED`). Checked before containment, so a candidate
    /// like `a/../../b` is reported as `Traversal`, not `Escape`.
    Traversal,
    /// The candidate resolved to a location outside the root (the oracle's
    /// `PATH_ESCAPE_REJECTED`). With the `..`-segment rule firing first, a purely
    /// lexical join of a `..`-free relative path cannot escape, so this guards the
    /// remaining cases (e.g. a candidate that is itself absolute after a split).
    Escape,
}

/// Lexically resolve `candidate` against `root`, returning the contained absolute
/// path or a [`PathError`] explaining the rejection. Mirrors the oracle's
/// `resolveSafePath(base, relativePath)` lexical behavior.
///
/// Rules (in order, matching the oracle):
/// 1. An **absolute** candidate is rejected ([`PathError::Absolute`]).
/// 2. Any `..` **path segment** (split on `/` or `\`) is rejected
///    ([`PathError::Traversal`]) — *before* any containment math.
/// 3. The candidate is joined onto the (lexically-normalized) `root`; if the
///    lexical relative path from root to the result starts with `..` or is
///    absolute, it is rejected ([`PathError::Escape`]).
///
/// On success the returned string is the lexically-resolved absolute path
/// (`root` normalized, then `candidate` appended), with `.` and empty segments
/// collapsed — never touching the filesystem.
pub fn contained(root: &str, candidate: &str) -> Result<String, PathError> {
    // 1. Reject absolute candidates (TS: `isAbsolute(relativePath)`).
    if is_absolute(candidate) {
        return Err(PathError::Absolute);
    }

    // 2. Reject any `..` segment, splitting on BOTH `/` and `\` (TS:
    //    `relativePath.split(/[/\\]/).includes("..")`).
    if split_segments(candidate).any(|seg| seg == "..") {
        return Err(PathError::Traversal);
    }

    // 3. Resolve candidate against the root, then verify lexical containment
    //    (TS: `resolve(resolvedBase, relativePath)` + `isWithinBase`).
    let resolved_base = lexical_resolve_abs(root);
    let resolved_full = lexical_join(&resolved_base, candidate);
    if !is_within_base(&resolved_base, &resolved_full) {
        return Err(PathError::Escape);
    }

    Ok(resolved_full)
}

/// Lexical port of the oracle's `isWithinBase(base, target)`: true iff `target`
/// is `base` itself or lexically nested under it. Both inputs must already be
/// absolute + lexically normalized.
fn is_within_base(base: &str, target: &str) -> bool {
    if target == base {
        return true;
    }
    match lexical_relative(base, target) {
        // No relative difference -> same path (TS `!rel`).
        Some(rel) if rel.is_empty() => true,
        // `rel` escapes if it IS `..`, STARTS WITH `../`, or is absolute.
        Some(rel) => !(rel == ".." || rel.starts_with("../") || is_absolute(&rel)),
        // Different roots (no relative path) -> not contained.
        None => false,
    }
}

/// Is `path` absolute? POSIX-style leading `/` or a Windows drive/UNC root. We
/// detect Windows roots too so a candidate like `C:\x` or `\\srv\s` is treated
/// as absolute on every platform. NOTE: this is deliberately **stricter** than the
/// POSIX `node:path` oracle, where `isAbsolute("C:\\x")` is `false` (it would treat
/// the drive root as a relative segment). We over-reject Windows/UNC roots in
/// untrusted candidates — over-rejection is always safe (it can never produce an
/// escape), and a workspace-relative path is never legitimately a drive/UNC root.
fn is_absolute(path: &str) -> bool {
    if path.starts_with('/') || path.starts_with('\\') {
        return true;
    }
    // Windows drive root: `C:\` or `C:/` (a drive letter, a colon, a separator).
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
    {
        return true;
    }
    false
}

/// Split a path into segments on `/` AND `\` (mirrors the oracle's
/// `split(/[/\\]/)`). Empty and `.` segments are preserved here so the `..`
/// check sees the raw segments exactly as the oracle does.
fn split_segments(path: &str) -> impl Iterator<Item = &str> {
    path.split(['/', '\\'])
}

/// Lexically normalize a (possibly relative) `root` into an absolute, slash-
/// delimited path, collapsing `.` and empty segments. `..` is preserved as a
/// segment so a `root` that itself contains `..` is normalized lexically (the
/// root is trusted, so we do not reject it — only the untrusted candidate is
/// segment-checked). A relative root is anchored at `/` (we never read the cwd —
/// staying syscall-free; absolute results keep containment math well-defined).
fn lexical_resolve_abs(root: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for seg in split_segments(root) {
        match seg {
            "" | "." => {}
            ".." => {
                // Pop a real parent if present; never pop below the root anchor.
                if matches!(stack.last(), Some(&s) if s != "..") {
                    stack.pop();
                } else {
                    stack.push("..");
                }
            }
            other => stack.push(other),
        }
    }
    // Drop any leading `..` that would climb above the anchor (root is trusted;
    // it cannot escape itself), then render as an absolute `/`-rooted path.
    while stack.first() == Some(&"..") {
        stack.remove(0);
    }
    format!("/{}", stack.join("/"))
}

/// Lexically join an already-normalized absolute `base` with a `..`-free,
/// non-absolute `candidate`, collapsing `.` and empty segments.
fn lexical_join(base: &str, candidate: &str) -> String {
    let mut stack: Vec<&str> = base.split('/').filter(|s| !s.is_empty()).collect();
    for seg in split_segments(candidate) {
        match seg {
            "" | "." => {}
            // `..` is already rejected by `contained` before we get here; collapse
            // defensively rather than panic if ever reached directly.
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    format!("/{}", stack.join("/"))
}

/// Lexical relative path from `from` to `to` (both absolute, `/`-delimited,
/// normalized). Mirrors Node's `path.relative` for the cases the containment
/// check needs: returns the `../`-prefixed relative string, an empty string for
/// equal paths, or `None` when the two share no common root (cannot happen for
/// two `/`-rooted paths, but kept total).
fn lexical_relative(from: &str, to: &str) -> Option<String> {
    let from_segs: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let to_segs: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();

    let common = from_segs
        .iter()
        .zip(to_segs.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let up = from_segs.len() - common;
    let mut parts: Vec<&str> = vec![".."; up];
    parts.extend_from_slice(&to_segs[common..]);
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legitimately_contained_relative_path_is_accepted() {
        // A plain nested relative path resolves inside the root.
        assert_eq!(
            contained("/ws", "skills/foo.txt"),
            Ok("/ws/skills/foo.txt".to_string())
        );
        // Deeper nesting is fine.
        assert_eq!(
            contained("/ws/root", "a/b/c"),
            Ok("/ws/root/a/b/c".to_string())
        );
    }

    #[test]
    fn absolute_candidate_is_rejected() {
        assert_eq!(contained("/ws", "/etc/passwd"), Err(PathError::Absolute));
        // Windows-style absolute candidates are also rejected (cross-platform).
        assert_eq!(contained("/ws", "C:\\Windows"), Err(PathError::Absolute));
        assert_eq!(contained("/ws", "\\\\srv\\share"), Err(PathError::Absolute));
    }

    #[test]
    fn parent_traversal_is_rejected() {
        // A leading `../` segment.
        assert_eq!(contained("/ws", "../secret"), Err(PathError::Traversal));
        // A bare `..`.
        assert_eq!(contained("/ws", ".."), Err(PathError::Traversal));
    }

    #[test]
    fn escape_via_embedded_traversal_is_rejected_as_traversal() {
        // `a/../../b` escapes conceptually, but the `..`-segment rule fires FIRST
        // (faithful to the oracle's order: traversal check precedes containment).
        assert_eq!(contained("/ws", "a/../../b"), Err(PathError::Traversal));
    }

    #[test]
    fn nested_traversal_segment_is_rejected() {
        // A `..` buried mid-path is still a traversal segment.
        assert_eq!(
            contained("/ws", "a/b/../../../escape"),
            Err(PathError::Traversal)
        );
        // Backslash-delimited traversal is caught too (oracle splits on `/` and `\`).
        assert_eq!(contained("/ws", "a\\..\\b"), Err(PathError::Traversal));
    }

    #[test]
    fn dot_and_empty_segments_are_handled() {
        // `.` and empty segments collapse; the path stays contained.
        assert_eq!(contained("/ws", "."), Ok("/ws".to_string()));
        assert_eq!(contained("/ws", ""), Ok("/ws".to_string()));
        assert_eq!(contained("/ws", "./a/./b"), Ok("/ws/a/b".to_string()));
        assert_eq!(contained("/ws", "a//b"), Ok("/ws/a/b".to_string()));
    }

    #[test]
    fn candidate_equal_to_root_is_contained() {
        // The oracle's `isWithinBase` returns true when target == base.
        assert_eq!(contained("/ws", "."), Ok("/ws".to_string()));
    }

    #[test]
    fn root_is_lexically_normalized_before_join() {
        // A root with redundant `.`/`//` segments still produces a clean contained path.
        assert_eq!(
            contained("/ws/./root//", "a/b"),
            Ok("/ws/root/a/b".to_string())
        );
    }

    #[test]
    fn sibling_prefix_is_not_treated_as_contained() {
        // `is_within_base` must not treat `/ws-evil` as nested under `/ws` just
        // because of a shared string prefix. (Reached via the helper directly,
        // since a `..`-free candidate cannot produce a sibling escape lexically.)
        assert!(!is_within_base("/ws", "/ws-evil/x"));
        assert!(is_within_base("/ws", "/ws/x"));
        assert!(is_within_base("/ws", "/ws"));
    }
}
