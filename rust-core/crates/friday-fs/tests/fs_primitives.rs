//! REAL adverse/security tests for the S3-substrate safe-fs PRIMITIVES added to
//! `friday-fs`: `list_dir`, `stat_file`, `append_file`, `delete_file`, `move_file`,
//! and `edit_file`.
//!
//! Like `adverse_fs.rs`, every test operates on a real, unique temp directory with real
//! files and **real symlinks created on disk** (`std::os::unix::fs::symlink`) — no mocks,
//! no abstractly-asserted escapes. For each new primitive we prove: a happy path, lexical
//! rejection (absolute / `..` traversal), a real **final-component symlink** rejection (no
//! escape via symlink), a real **ancestor-directory symlink** rejection where the pipeline
//! resolves a parent, and — where applicable — atomicity (no partial file / no temp
//! leftover / original intact on a refused mutation).
//!
//! NOTE (truth label): none of these primitives are wired into the agent-loop
//! `FsToolExecutor` yet — they are library functions with adverse tests only (PROOF-ONLY,
//! Rust-wired-DEV). Wiring is a deferred serial follow-up.

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::PathError;
use friday_fs::{
    append_file_within_root, delete_file_within_root, edit_file_within_root, list_dir_within_root,
    move_file_within_root, stat_file_within_root, FileKind, FsError,
};

/// A real, unique temp directory that is recursively removed on drop. Std-only (no
/// `tempfile` dependency) per the workspace's minimal-dependency convention.
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut path = std::env::temp_dir();
        path.push(format!(
            "friday-fs-prim-{}-{}-{}",
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

fn write_file(path: &Path, contents: &str) {
    let mut f = fs::File::create(path).expect("create file");
    f.write_all(contents.as_bytes()).expect("write file");
}

fn read_file(path: &Path) -> String {
    let mut f = fs::File::open(path).expect("open");
    let mut s = String::new();
    f.read_to_string(&mut s).expect("read");
    s
}

/// Count temp files (`.<name>.tmp.*`) left in a dir — must be zero after an atomic write.
fn temp_leftovers(dir: &Path) -> usize {
    fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
        .count()
}

// ════════════════════════════ list_dir ════════════════════════════

#[test]
fn list_dir_happy_lists_sorted_entries_without_dot_dot() {
    let root = TempDir::new();
    let dir = root.path().join("sub");
    fs::create_dir(&dir).unwrap();
    write_file(&dir.join("b.txt"), "b");
    write_file(&dir.join("a.txt"), "a");
    fs::create_dir(dir.join("nested")).unwrap();

    let entries = list_dir_within_root(root.path(), "sub").expect("list contained dir");
    let names: Vec<String> = entries
        .iter()
        .map(|e| e.to_string_lossy().into_owned())
        .collect();
    // Sorted, and `.`/`..` excluded.
    assert_eq!(names, vec!["a.txt", "b.txt", "nested"]);
}

#[test]
fn list_dir_absolute_and_traversal_are_rejected_lexically() {
    let root = TempDir::new();
    assert!(matches!(
        list_dir_within_root(root.path(), "/etc").unwrap_err(),
        FsError::Lexical(PathError::Absolute)
    ));
    assert!(matches!(
        list_dir_within_root(root.path(), "../..").unwrap_err(),
        FsError::Lexical(PathError::Traversal)
    ));
}

#[test]
fn list_dir_final_component_symlink_to_outside_dir_is_rejected() {
    let root = TempDir::new();
    let outside = TempDir::new();
    // Real outside directory with a real entry, so a non-hardened readdir WOULD list it.
    write_file(&outside.path().join("leaked.txt"), "x");
    // <root>/link -> <outside>
    symlink(outside.path(), root.path().join("link")).expect("final-component dir symlink");

    let err = list_dir_within_root(root.path(), "link").unwrap_err();
    assert!(
        matches!(err, FsError::Symlink),
        "a final-component symlink dir must be rejected by O_NOFOLLOW, got {err:?}"
    );
}

#[test]
fn list_dir_ancestor_symlink_escape_is_rejected() {
    let root = TempDir::new();
    let outside = TempDir::new();
    let outside_dir = outside.path().join("realdir");
    fs::create_dir_all(outside_dir.join("inner")).unwrap();
    // <root>/sub -> <outside>/realdir  (sub is a non-final symlink component)
    symlink(&outside_dir, root.path().join("sub")).expect("ancestor symlink");

    let err = list_dir_within_root(root.path(), "sub/inner").unwrap_err();
    assert!(
        matches!(err, FsError::Escape),
        "an ancestor-dir symlink escape must be rejected, got {err:?}"
    );
}

#[test]
fn list_dir_on_a_regular_file_is_not_a_directory() {
    let root = TempDir::new();
    write_file(&root.path().join("f.txt"), "data");
    let err = list_dir_within_root(root.path(), "f.txt").unwrap_err();
    assert!(
        matches!(err, FsError::NotADirectory),
        "listing a regular file must be NotADirectory, got {err:?}"
    );
}

#[test]
fn list_dir_root_candidate_lists_the_root_entries() {
    let root = TempDir::new();
    write_file(&root.path().join("b.txt"), "b");
    write_file(&root.path().join("a.txt"), "a");
    fs::create_dir(root.path().join("sub")).unwrap();

    // All three root-denoting tokens (`.`, ``, `./`) list the ROOT's own direct entries,
    // sorted, with `.`/`..` excluded — the workspace-root listing the agent loop needs.
    let expected = vec!["a.txt".to_string(), "b.txt".to_string(), "sub".to_string()];
    for token in [".", "", "./"] {
        let entries = list_dir_within_root(root.path(), token)
            .unwrap_or_else(|e| panic!("root token {token:?} must list the root, got {e:?}"));
        let names: Vec<String> = entries
            .iter()
            .map(|e| e.to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, expected, "root token {token:?}");
    }

    // Escape-safety is preserved: only the literal root tokens bypass resolve_within_root;
    // `..` / absolute / a final-component dir-symlink are STILL rejected.
    assert!(matches!(
        list_dir_within_root(root.path(), "..").unwrap_err(),
        FsError::Lexical(PathError::Traversal)
    ));
    assert!(matches!(
        list_dir_within_root(root.path(), "/etc").unwrap_err(),
        FsError::Lexical(PathError::Absolute)
    ));
    let outside = TempDir::new();
    write_file(&outside.path().join("leaked.txt"), "x");
    symlink(outside.path(), root.path().join("link")).expect("final-component dir symlink");
    assert!(
        matches!(
            list_dir_within_root(root.path(), "link").unwrap_err(),
            FsError::Symlink
        ),
        "a final-component dir symlink must still be rejected even with root-listing support"
    );
}

// ════════════════════════════ stat_file ════════════════════════════

#[test]
fn stat_file_happy_reports_regular_file_kind_size_mode() {
    let root = TempDir::new();
    let p = root.path().join("f.txt");
    write_file(&p, "hello world"); // 11 bytes
    fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();

    let st = stat_file_within_root(root.path(), "f.txt").expect("stat contained file");
    assert_eq!(st.kind, FileKind::File);
    assert_eq!(st.len, 11);
    assert_eq!(st.mode, 0o640);
    assert!(!st.readonly);
}

#[test]
fn stat_file_reports_directory_kind() {
    let root = TempDir::new();
    fs::create_dir(root.path().join("d")).unwrap();
    let st = stat_file_within_root(root.path(), "d").expect("stat contained dir");
    assert_eq!(st.kind, FileKind::Dir);
}

#[test]
fn stat_file_final_component_symlink_is_rejected() {
    let root = TempDir::new();
    let outside = TempDir::new();
    let secret = outside.path().join("secret.txt");
    write_file(&secret, "OUTSIDE");
    symlink(&secret, root.path().join("link.txt")).expect("symlink");

    let err = stat_file_within_root(root.path(), "link.txt").unwrap_err();
    assert!(
        matches!(err, FsError::Symlink),
        "stat must refuse a final-component symlink (no follow), got {err:?}"
    );
}

#[test]
fn stat_file_absolute_and_traversal_rejected_and_missing_is_not_found() {
    let root = TempDir::new();
    assert!(matches!(
        stat_file_within_root(root.path(), "/etc/passwd").unwrap_err(),
        FsError::Lexical(PathError::Absolute)
    ));
    assert!(matches!(
        stat_file_within_root(root.path(), "../x").unwrap_err(),
        FsError::Lexical(PathError::Traversal)
    ));
    assert!(matches!(
        stat_file_within_root(root.path(), "nope.txt").unwrap_err(),
        FsError::NotFound
    ));
}

// ════════════════════════════ append_file ════════════════════════════

#[test]
fn append_file_creates_then_appends_and_is_owner_only() {
    let root = TempDir::new();
    // Create-if-absent.
    append_file_within_root(root.path(), "log.txt", b"AAA").unwrap();
    assert_eq!(read_file(&root.path().join("log.txt")), "AAA");
    // Owner-only on create (oracle parity).
    assert_eq!(
        fs::metadata(root.path().join("log.txt")).unwrap().mode() & 0o777,
        0o600
    );
    // Append extends, does not replace.
    append_file_within_root(root.path(), "log.txt", b"BBB").unwrap();
    assert_eq!(read_file(&root.path().join("log.txt")), "AAABBB");
    assert_eq!(
        temp_leftovers(root.path()),
        0,
        "append is in-place, no temp"
    );
}

#[test]
fn append_file_through_final_symlink_is_rejected_outside_intact() {
    let root = TempDir::new();
    let outside = TempDir::new();
    let target = outside.path().join("t.txt");
    write_file(&target, "ORIGINAL");
    symlink(&target, root.path().join("a.txt")).expect("symlink");

    let err = append_file_within_root(root.path(), "a.txt", b"PWN").unwrap_err();
    assert!(matches!(err, FsError::Symlink), "got {err:?}");
    // Never appended through the symlink.
    assert_eq!(read_file(&target), "ORIGINAL");
}

#[test]
fn append_file_traversal_and_directory_target_rejected() {
    let root = TempDir::new();
    assert!(matches!(
        append_file_within_root(root.path(), "../x.txt", b"x").unwrap_err(),
        FsError::Lexical(PathError::Traversal)
    ));
    fs::create_dir(root.path().join("d")).unwrap();
    assert!(matches!(
        append_file_within_root(root.path(), "d", b"x").unwrap_err(),
        FsError::IsDirectory
    ));
}

// ════════════════════════════ delete_file ════════════════════════════

#[test]
fn delete_file_happy_removes_regular_file() {
    let root = TempDir::new();
    let p = root.path().join("gone.txt");
    write_file(&p, "bye");
    delete_file_within_root(root.path(), "gone.txt").unwrap();
    assert!(!p.exists(), "file must be removed");
}

#[test]
fn delete_file_refuses_symlink_leaving_link_and_target_intact() {
    let root = TempDir::new();
    let outside = TempDir::new();
    let target = outside.path().join("keep.txt");
    write_file(&target, "KEEP ME");
    let link = root.path().join("link.txt");
    symlink(&target, &link).expect("symlink");

    let err = delete_file_within_root(root.path(), "link.txt").unwrap_err();
    assert!(matches!(err, FsError::Symlink), "got {err:?}");
    // The link itself and the outside target both survive (we removed neither).
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(read_file(&target), "KEEP ME");
}

#[test]
fn delete_file_refuses_directory_and_traversal_and_reports_missing() {
    let root = TempDir::new();
    fs::create_dir(root.path().join("d")).unwrap();
    assert!(matches!(
        delete_file_within_root(root.path(), "d").unwrap_err(),
        FsError::IsDirectory
    ));
    assert!(root.path().join("d").is_dir(), "dir must be untouched");
    assert!(matches!(
        delete_file_within_root(root.path(), "../escape").unwrap_err(),
        FsError::Lexical(PathError::Traversal)
    ));
    assert!(matches!(
        delete_file_within_root(root.path(), "nope.txt").unwrap_err(),
        FsError::NotFound
    ));
}

// ════════════════════════════ move_file ════════════════════════════

#[test]
fn move_file_happy_renames_and_replaces_existing_regular_dst() {
    let root = TempDir::new();
    write_file(&root.path().join("src.txt"), "PAYLOAD");
    move_file_within_root(root.path(), "src.txt", "dst.txt").unwrap();
    assert!(!root.path().join("src.txt").exists(), "source must be gone");
    assert_eq!(read_file(&root.path().join("dst.txt")), "PAYLOAD");

    // Replacing an existing regular destination is allowed (atomic same-name replace).
    write_file(&root.path().join("src2.txt"), "NEW");
    move_file_within_root(root.path(), "src2.txt", "dst.txt").unwrap();
    assert_eq!(read_file(&root.path().join("dst.txt")), "NEW");
}

#[test]
fn move_file_into_nested_contained_dir_ok() {
    let root = TempDir::new();
    fs::create_dir(root.path().join("sub")).unwrap();
    write_file(&root.path().join("a.txt"), "X");
    move_file_within_root(root.path(), "a.txt", "sub/b.txt").unwrap();
    assert_eq!(read_file(&root.path().join("sub/b.txt")), "X");
}

#[test]
fn move_file_rejects_absolute_or_traversal_src_or_dst() {
    let root = TempDir::new();
    write_file(&root.path().join("s.txt"), "x");
    // Escaping destination (absolute) refused — no write outside root.
    let outside = TempDir::new();
    let abs_dst = outside.path().join("leak.txt");
    assert!(matches!(
        move_file_within_root(root.path(), "s.txt", abs_dst.to_str().unwrap()).unwrap_err(),
        FsError::Lexical(PathError::Absolute)
    ));
    assert!(!abs_dst.exists(), "must not have escaped to absolute dst");
    // Traversal source refused.
    assert!(matches!(
        move_file_within_root(root.path(), "../s.txt", "d.txt").unwrap_err(),
        FsError::Lexical(PathError::Traversal)
    ));
}

#[test]
fn move_file_refuses_symlink_src_and_symlink_dst() {
    let root = TempDir::new();
    let outside = TempDir::new();
    let outside_file = outside.path().join("o.txt");
    write_file(&outside_file, "OUTSIDE");

    // Symlink SOURCE refused.
    symlink(&outside_file, root.path().join("slink.txt")).unwrap();
    write_file(&root.path().join("real.txt"), "REAL");
    assert!(matches!(
        move_file_within_root(root.path(), "slink.txt", "out.txt").unwrap_err(),
        FsError::Symlink
    ));

    // Symlink DESTINATION refused (don't replace a link), outside target intact.
    symlink(&outside_file, root.path().join("dlink.txt")).unwrap();
    let err = move_file_within_root(root.path(), "real.txt", "dlink.txt").unwrap_err();
    assert!(matches!(err, FsError::Symlink), "got {err:?}");
    assert_eq!(
        read_file(&outside_file),
        "OUTSIDE",
        "outside target untouched"
    );
    assert_eq!(
        read_file(&root.path().join("real.txt")),
        "REAL",
        "src intact"
    );
}

#[test]
fn move_file_refuses_dir_dst_and_missing_src() {
    let root = TempDir::new();
    write_file(&root.path().join("s.txt"), "x");
    fs::create_dir(root.path().join("ddir")).unwrap();
    assert!(matches!(
        move_file_within_root(root.path(), "s.txt", "ddir").unwrap_err(),
        FsError::IsDirectory
    ));
    assert!(matches!(
        move_file_within_root(root.path(), "missing.txt", "d.txt").unwrap_err(),
        FsError::NotFound
    ));
}

// ════════════════════════════ edit_file ════════════════════════════

#[test]
fn edit_file_happy_replaces_first_occurrence_atomically() {
    let root = TempDir::new();
    write_file(&root.path().join("doc.txt"), "hello world, hello moon");
    edit_file_within_root(root.path(), "doc.txt", "hello", "bye").unwrap();
    // First occurrence only (oracle parity).
    assert_eq!(
        read_file(&root.path().join("doc.txt")),
        "bye world, hello moon"
    );
    // Atomic write via temp+rename: no temp leftover.
    assert_eq!(temp_leftovers(root.path()), 0);
}

#[test]
fn edit_file_no_match_leaves_file_unchanged() {
    let root = TempDir::new();
    write_file(&root.path().join("doc.txt"), "unchanged content");
    let err = edit_file_within_root(root.path(), "doc.txt", "absent", "X").unwrap_err();
    assert!(matches!(err, FsError::EditNoMatch), "got {err:?}");
    assert_eq!(read_file(&root.path().join("doc.txt")), "unchanged content");
    assert_eq!(temp_leftovers(root.path()), 0, "no write on no-match");

    // Empty old_text is treated as a no-match too (no prepend surprise).
    assert!(matches!(
        edit_file_within_root(root.path(), "doc.txt", "", "X").unwrap_err(),
        FsError::EditNoMatch
    ));
    assert_eq!(read_file(&root.path().join("doc.txt")), "unchanged content");
}

#[test]
fn edit_file_binary_content_is_invalid_data() {
    let root = TempDir::new();
    // Invalid UTF-8 bytes on disk.
    fs::write(root.path().join("bin.dat"), [0xff, 0xfe, 0x00, 0x01]).unwrap();
    let err = edit_file_within_root(root.path(), "bin.dat", "a", "b").unwrap_err();
    assert!(
        matches!(&err, FsError::Io(e) if e.kind() == std::io::ErrorKind::InvalidData),
        "non-UTF8 file must surface InvalidData, got {err:?}"
    );
}

#[test]
fn edit_file_through_symlink_or_traversal_is_rejected_outside_intact() {
    let root = TempDir::new();
    let outside = TempDir::new();
    let target = outside.path().join("t.txt");
    write_file(&target, "OUTSIDE SECRET");
    symlink(&target, root.path().join("link.txt")).unwrap();

    // The hardened read path refuses the final-component symlink.
    let err = edit_file_within_root(root.path(), "link.txt", "OUTSIDE", "X").unwrap_err();
    assert!(matches!(err, FsError::Symlink), "got {err:?}");
    assert_eq!(
        read_file(&target),
        "OUTSIDE SECRET",
        "outside file untouched"
    );

    assert!(matches!(
        edit_file_within_root(root.path(), "../t.txt", "a", "b").unwrap_err(),
        FsError::Lexical(PathError::Traversal)
    ));
}
