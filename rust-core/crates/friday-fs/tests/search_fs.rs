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
use friday_fs::{
    search_within_root, FsError, SearchHit, SEARCH_MAX_DIRS, SEARCH_MAX_FILES,
    SEARCH_MAX_FILE_BYTES, SEARCH_MAX_HITS, SEARCH_MAX_LINE_BYTES,
};

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

// ════════════════════════════ cap enforcement (per-file, files, dirs) ════════════════════════════

#[test]
fn search_file_byte_cap_truncates_the_read_so_a_match_beyond_the_cap_is_not_returned() {
    // SEARCH_MAX_FILE_BYTES: `scan_file_into` reads at most this many bytes via `Read::take`,
    // so a match positioned BEYOND the cap is NEVER read and never returned, while a match
    // within the cap IS. This proves `Read::take` truly bounds the read (not just the output).
    let root = TempDir::new();

    let cap = SEARCH_MAX_FILE_BYTES as usize;
    // Line 1 holds an EARLY marker (well within the cap → must be returned).
    let mut body: Vec<u8> = Vec::with_capacity(cap + 64);
    body.extend_from_slice(b"EARLYMARK on line one\n");
    // NUL-free ASCII padding ('a' lines) so the binary heuristic does NOT skip the file, and so
    // the file's length comfortably exceeds the per-file cap. We pad until the byte offset is
    // strictly past `cap`, THEN append the LATE marker — so every byte of LATEMARK lands beyond
    // SEARCH_MAX_FILE_BYTES and is truncated away by `take`.
    while body.len() <= cap {
        // 64 'a' + newline; cheap, NUL-free, guaranteed to step past the cap.
        body.extend_from_slice(&[b'a'; 64]);
        body.push(b'\n');
    }
    assert!(
        body.len() > cap,
        "padding must push the file past the per-file byte cap"
    );
    body.extend_from_slice(b"LATEMARK beyond the cap\n");
    write_file(&root.path().join("big.txt"), &body);

    let early = search_within_root(root.path(), "EARLYMARK", None).expect("search ok");
    assert_eq!(
        locs(&early),
        vec![("big.txt".to_string(), 1)],
        "a match within the per-file byte cap must be returned"
    );

    let late = search_within_root(root.path(), "LATEMARK", None).expect("search ok");
    assert!(
        late.is_empty(),
        "a match positioned BEYOND SEARCH_MAX_FILE_BYTES must NOT be returned (Read::take \
         bounds the read), got {late:?}"
    );
}

#[test]
fn search_caps_files_opened_so_a_late_sorted_match_beyond_the_file_cap_is_not_scanned() {
    // SEARCH_MAX_FILES: at most this many files are opened+scanned. We place a CONTROL match in
    // the first file (sort order) and a SENTINEL match in a file that sorts AFTER the cap, with
    // SEARCH_MAX_FILES non-matching filler files in between. The walk scans files in
    // `list_dir_within_root` SORTED order and breaks at the file cap, so the control is scanned
    // and the sentinel never is. (Filler files are non-matching, so the much smaller hit cap —
    // SEARCH_MAX_HITS ≪ SEARCH_MAX_FILES — is NOT what stops the walk: only the file cap is.)
    let root = TempDir::new();

    // Control: sorts first, matches.
    write_file(&root.path().join("f0000000.txt"), b"CTRLMARK control\n");
    // Exactly SEARCH_MAX_FILES non-matching filler files, named so they sort between the control
    // and the sentinel (f0000001 .. ). One byte each ⇒ fast even at the cap.
    for i in 1..=SEARCH_MAX_FILES {
        write_file(&root.path().join(format!("f{i:07}.txt")), b"x\n");
    }
    // Sentinel: a 'z'-prefixed name sorts AFTER every filler, so it is at sort position
    // SEARCH_MAX_FILES + 2 — past the cap → never opened.
    write_file(
        &root.path().join("zzz_sentinel.txt"),
        b"SENTMARK sentinel\n",
    );

    let ctrl = search_within_root(root.path(), "CTRLMARK", None).expect("search ok");
    assert_eq!(
        locs(&ctrl),
        vec![("f0000000.txt".to_string(), 1)],
        "the control file (within the file cap) must be scanned and matched"
    );

    let sent = search_within_root(root.path(), "SENTMARK", None).expect("search ok");
    assert!(
        sent.is_empty(),
        "a match in a file sorted BEYOND SEARCH_MAX_FILES must NOT be scanned (file cap), \
         got {sent:?}"
    );
}

#[test]
fn search_caps_dirs_and_keeps_the_pending_worklist_bounded() {
    // SEARCH_MAX_DIRS: at most this many directories are listed, AND — the fix under test — the
    // pending `worklist` is bounded because a directory is enqueued only while
    // `dirs_enqueued < SEARCH_MAX_DIRS`. We build a WIDE FLAT tree (a deep chain would blow past
    // PATH_MAX): SEARCH_MAX_DIRS + margin EMPTY child directories directly under the root, with
    // exactly TWO matching files (control + sentinel) so neither the hit cap nor the file cap
    // can interfere — only the directory enqueue cap decides what is searched.
    //
    // Mechanics: the walk lists `root`, enqueueing children in `list_dir_within_root` SORTED
    // order; the root itself already consumed one enqueue slot, so only SEARCH_MAX_DIRS - 1
    // children are enqueued — the LOWEST that-many in sort order (`d000000` … `d{cap-2}`) — and
    // every higher-sorted directory is DROPPED at enqueue (bounded descent). The pops are LIFO,
    // but with only two matching files no early cap fires, so EVERY enqueued directory is still
    // visited. Therefore:
    //   - CONTROL match lives in `d000000` (definitely enqueued) → searched & returned.
    //   - SENTINEL match lives in the HIGHEST-sorted dir (definitely dropped) → never searched.
    //
    // We assert the bound via observable behavior (the dropped sentinel) rather than peeking at
    // `worklist.len()`: if the worklist were UNbounded (the old code), every child would be
    // enqueued and the sentinel WOULD be found. Its absence is the proof the enqueue cap held.
    let root = TempDir::new();

    // A comfortable margin past the cap so the sentinel is unambiguously in the dropped set and
    // the test is not off-by-one fragile.
    let total_dirs = SEARCH_MAX_DIRS + 64;
    // Zero-padded names ⇒ lexicographic sort == numeric order (matching `list_dir`'s sort).
    let control_rel = format!("d{:06}/m.txt", 0);
    let sentinel_rel = format!("d{:06}/m.txt", total_dirs - 1);
    for i in 0..total_dirs {
        let d = root.path().join(format!("d{i:06}"));
        fs::create_dir(&d).unwrap();
        // Only the lowest- and highest-sorted dirs hold a matching file; the rest are empty, so
        // neither the hit cap (SEARCH_MAX_HITS) nor the file cap (SEARCH_MAX_FILES) can fire and
        // pre-empt the walk — the directory enqueue cap is the sole determinant.
        if i == 0 || i == total_dirs - 1 {
            write_file(&d.join("m.txt"), b"DIRMARK here\n");
        }
    }

    let hits = search_within_root(root.path(), "DIRMARK", None).expect("search ok");

    // The lowest-sorted directory is within the enqueue budget → its file is searched.
    assert!(
        hits.iter().any(|h| h.relative_path == control_rel),
        "the control file in the lowest-sorted dir must be searched, got hits {hits:?}"
    );
    // The highest-sorted directory is beyond the enqueue budget → dropped → never searched.
    assert!(
        !hits.iter().any(|h| h.relative_path == sentinel_rel),
        "a file in a directory beyond SEARCH_MAX_DIRS must NOT be searched (the pending \
         worklist is bounded — enqueue cap held), but {sentinel_rel} was matched"
    );
    // With exactly two matching files, the control is the ONLY hit — confirming the walk neither
    // descended the dropped sentinel dir nor blew any cap.
    assert_eq!(
        locs(&hits),
        vec![(control_rel.clone(), 1)],
        "exactly the control match (sentinel dir dropped at the enqueue cap)"
    );
}
