//! REAL adverse/security + bounds tests for the READ-ONLY `search_within_root`
//! primitive added to `friday-fs` (the `search` agent-loop fs tool).
//!
//! Like `fs_primitives.rs` / `adverse_fs.rs`, every test operates on a real, unique temp
//! directory with real files and **real symlinks created on disk**
//! (`std::os::unix::fs::symlink`) — no mocks, no abstractly-asserted escapes. We prove:
//! a recursive happy path; lexical rejection of an absolute / `..` `subpath`; a real
//! out-of-root `subpath` (ancestor-symlink escape → `Escape`, final-component symlink →
//! `Symlink`); that a real **symlink entry pointing outside the root is NEVER followed**
//! during the walk (its outside target is not read); and that every output bound (hit cap,
//! per-line byte cap, binary-skip, empty-query) holds.
//!
//! NOTE (truth label): `search_within_root` reuses the EXISTING containment primitives
//! (`list_dir_within_root` / `stat_file_within_root` / `open_read_within_root`) for every
//! on-disk access and adds no new `open`/`readdir` path of its own — the hardening pipeline
//! is unchanged. PROOF-ONLY for the read-only `search` tool wiring.

use std::fs;
use std::io::Write;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::PathError;
use friday_fs::{search_within_root, FsError, SearchHit, SEARCH_MAX_HITS, SEARCH_MAX_LINE_BYTES};

/// A real, unique temp directory that is recursively removed on drop (std-only).
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut path = std::env::temp_dir();
        path.push(format!(
            "friday-fs-search-{}-{}-{}",
            std::process::id(),
            n,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        TempDir { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn write_file(path: &Path, contents: &[u8]) {
    let mut f = fs::File::create(path).expect("create file");
    f.write_all(contents).expect("write file");
}

/// Convenience: collect just the `(relative_path, line_number)` pairs.
fn locs(hits: &[SearchHit]) -> Vec<(String, u64)> {
    hits.iter()
        .map(|h| (h.relative_path.clone(), h.line_number))
        .collect()
}

// ════════════════════════════ happy path ════════════════════════════

#[test]
fn search_finds_literal_matches_recursively_sorted() {
    let root = TempDir::new();
    fs::create_dir(root.path().join("sub")).unwrap();
    write_file(
        &root.path().join("a.txt"),
        b"first line\nhas NEEDLE here\nlast\n",
    );
    write_file(&root.path().join("b.txt"), b"nothing relevant\n");
    write_file(
        &root.path().join("sub/c.txt"),
        b"x\ny\nNEEDLE again on three\nNEEDLE four\n",
    );

    let hits = search_within_root(root.path(), "NEEDLE", None).expect("search ok");
    // Sorted by (relative_path, line_number): a.txt:2, sub/c.txt:3, sub/c.txt:4.
    assert_eq!(
        locs(&hits),
        vec![
            ("a.txt".to_string(), 2),
            ("sub/c.txt".to_string(), 3),
            ("sub/c.txt".to_string(), 4),
        ]
    );
    // The matching line text is carried, terminator stripped.
    assert_eq!(hits[0].line_text, "has NEEDLE here");
    // A non-matching file contributes nothing.
    assert!(!hits.iter().any(|h| h.relative_path == "b.txt"));
}

#[test]
fn search_subpath_scopes_to_a_contained_subdir() {
    let root = TempDir::new();
    fs::create_dir(root.path().join("sub")).unwrap();
    write_file(&root.path().join("top.txt"), b"TARGET at top\n");
    write_file(&root.path().join("sub/inner.txt"), b"a\nTARGET inside\n");

    let hits = search_within_root(root.path(), "TARGET", Some("sub")).expect("scoped search ok");
    // ONLY the file under `sub` is searched — the top-level match is excluded.
    assert_eq!(locs(&hits), vec![("sub/inner.txt".to_string(), 2)]);
}

#[test]
fn search_subpath_may_name_a_single_file() {
    let root = TempDir::new();
    write_file(&root.path().join("only.txt"), b"WORD one\nno\nWORD two\n");
    write_file(&root.path().join("other.txt"), b"WORD elsewhere\n");

    let hits = search_within_root(root.path(), "WORD", Some("only.txt")).expect("file search ok");
    assert_eq!(
        locs(&hits),
        vec![("only.txt".to_string(), 1), ("only.txt".to_string(), 3)]
    );
}

// ════════════════════════════ containment / rejection ════════════════════════════

#[test]
fn search_absolute_and_traversal_subpath_are_rejected_lexically() {
    let root = TempDir::new();
    write_file(&root.path().join("a.txt"), b"NEEDLE\n");

    assert!(matches!(
        search_within_root(root.path(), "NEEDLE", Some("/etc")).unwrap_err(),
        FsError::Lexical(PathError::Absolute)
    ));
    assert!(matches!(
        search_within_root(root.path(), "NEEDLE", Some("../..")).unwrap_err(),
        FsError::Lexical(PathError::Traversal)
    ));
}

#[test]
fn search_out_of_root_subpath_via_ancestor_symlink_is_rejected() {
    let root = TempDir::new();
    let outside = TempDir::new();
    let outside_dir = outside.path().join("realdir");
    fs::create_dir_all(outside_dir.join("inner")).unwrap();
    write_file(&outside_dir.join("inner/secret.txt"), b"NEEDLE outside\n");
    // <root>/sub -> <outside>/realdir  (an ancestor symlink in the candidate)
    symlink(&outside_dir, root.path().join("sub")).expect("ancestor symlink");

    // A subpath whose ANCESTOR escapes the root resolves outside → Escape (never searched).
    let err = search_within_root(root.path(), "NEEDLE", Some("sub/inner")).unwrap_err();
    assert!(
        matches!(err, FsError::Escape),
        "an ancestor-symlink subpath escape must be rejected, got {err:?}"
    );
}

#[test]
fn search_final_component_symlink_subpath_is_rejected() {
    let root = TempDir::new();
    let outside = TempDir::new();
    write_file(&outside.path().join("o.txt"), b"NEEDLE outside\n");
    // <root>/link -> <outside>/o.txt  (final-component symlink as the subpath)
    symlink(outside.path().join("o.txt"), root.path().join("link")).expect("file symlink");

    let err = search_within_root(root.path(), "NEEDLE", Some("link")).unwrap_err();
    assert!(
        matches!(err, FsError::Symlink),
        "a final-component symlink subpath must be rejected (never followed), got {err:?}"
    );
}

#[test]
fn search_does_not_follow_a_symlink_entry_pointing_outside_root() {
    let root = TempDir::new();
    let outside = TempDir::new();
    // Real outside content that a NON-hardened recursive grep WOULD read & match.
    fs::create_dir(outside.path().join("od")).unwrap();
    write_file(&outside.path().join("od/leaked.txt"), b"NEEDLE leaked\n");
    write_file(&outside.path().join("ofile.txt"), b"NEEDLE leaked file\n");

    // In-root, legitimately searchable match.
    write_file(&root.path().join("inside.txt"), b"NEEDLE inside\n");
    // A symlink to an outside DIRECTORY and a symlink to an outside FILE — both must be
    // SKIPPED by the walk (stat → Symlink → not followed), so their targets are never read.
    symlink(outside.path().join("od"), root.path().join("dirlink")).expect("dir symlink");
    symlink(
        outside.path().join("ofile.txt"),
        root.path().join("filelink"),
    )
    .expect("file symlink");

    let hits = search_within_root(root.path(), "NEEDLE", None).expect("search ok");
    // ONLY the in-root file matched; neither symlink target leaked.
    assert_eq!(locs(&hits), vec![("inside.txt".to_string(), 1)]);
    assert!(
        !hits.iter().any(|h| h.line_text.contains("leaked")),
        "a symlink pointing outside the root was followed — outside content leaked: {hits:?}"
    );
}

// ════════════════════════════ bounds / graceful skips ════════════════════════════

#[test]
fn search_empty_query_returns_no_matches() {
    let root = TempDir::new();
    write_file(&root.path().join("a.txt"), b"line one\nline two\n");
    let hits = search_within_root(root.path(), "", None).expect("search ok");
    assert!(hits.is_empty(), "empty query matches nothing (bounded)");
}

#[test]
fn search_caps_total_hits() {
    let root = TempDir::new();
    // Far more matching lines than the cap, in one file.
    let mut body = String::new();
    for _ in 0..(SEARCH_MAX_HITS + 250) {
        body.push_str("HIT line\n");
    }
    write_file(&root.path().join("many.txt"), body.as_bytes());

    let hits = search_within_root(root.path(), "HIT", None).expect("search ok");
    assert_eq!(
        hits.len(),
        SEARCH_MAX_HITS,
        "total hits must be hard-capped at SEARCH_MAX_HITS"
    );
}

#[test]
fn search_truncates_an_overlong_matching_line_on_a_char_boundary() {
    let root = TempDir::new();
    // A single matching line far longer than the per-line cap, with a multibyte char
    // straddling the cap boundary to prove we back up to a char boundary (valid UTF-8).
    let mut line = String::from("NEEDLE ");
    line.push_str(&"é".repeat(SEARCH_MAX_LINE_BYTES)); // 2 bytes each ⇒ well over the cap
    line.push('\n');
    write_file(&root.path().join("long.txt"), line.as_bytes());

    let hits = search_within_root(root.path(), "NEEDLE", None).expect("search ok");
    assert_eq!(hits.len(), 1);
    let text = &hits[0].line_text;
    assert!(
        text.len() <= SEARCH_MAX_LINE_BYTES,
        "line_text must be capped at SEARCH_MAX_LINE_BYTES, got {} bytes",
        text.len()
    );
    // Truncation backed up to a UTF-8 char boundary ⇒ the String is valid by construction
    // (it IS a String); assert it begins with the real prefix and is non-trivial.
    assert!(text.starts_with("NEEDLE "), "prefix preserved: {text:?}");
    assert!(
        text.len() >= SEARCH_MAX_LINE_BYTES - 1,
        "filled near the cap"
    );
}

#[test]
fn search_skips_binary_and_non_utf8_files_gracefully() {
    let root = TempDir::new();
    // A "binary" file: the needle bytes are present but so is a NUL ⇒ skipped as binary.
    write_file(&root.path().join("bin.dat"), b"MARK\x00\x01\x02MARK\n");
    // An invalid-UTF-8 (no NUL) file: lone continuation byte ⇒ valid prefix only is scanned;
    // here the prefix has no match, so nothing leaks from the garbage tail.
    write_file(
        &root.path().join("bad.txt"),
        b"clean\n\xff\xfe MARK trailing\n",
    );
    // A genuine UTF-8 text file with the needle ⇒ matched.
    write_file(&root.path().join("good.txt"), b"a MARK b\n");

    let hits = search_within_root(root.path(), "MARK", None).expect("search ok");
    // ONLY the real text file matched; the binary file was skipped wholesale.
    assert!(
        hits.iter().any(|h| h.relative_path == "good.txt"),
        "the UTF-8 text file must match"
    );
    assert!(
        !hits.iter().any(|h| h.relative_path == "bin.dat"),
        "a NUL-bearing binary file must be skipped, got {hits:?}"
    );
}
