//! REAL adverse filesystem tests for the hardened safe-open.
//!
//! Every test below operates on a real, unique temp directory under the OS temp
//! dir, with real files and **real symlinks created on disk** (via
//! `std::os::unix::fs::symlink`). There are NO mocks and NO abstractly-asserted
//! symlinks: each escape vector is materialized on the filesystem, the open is
//! attempted, and we assert both that it is rejected AND (where applicable) that
//! the escaped target's bytes are never yielded.
//!
//! TOCTOU note (truth label): a live check-vs-open *thread race* is inherently
//! nondeterministic and would be flaky on CI. Instead the TOCTOU test performs a
//! **deterministic simulation of the check-vs-open window using two real,
//! distinct inodes**: it opens a real file, then on disk replaces that path with
//! a real symlink to a different real file, then runs the exact fd-identity
//! verification against the swapped path. This exercises the real
//! `fstat(fd)` vs `stat(path)` dev/ino branch with real on-disk objects — it is
//! not a live race, and is labeled as such.

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::PathError;
use friday_fs::{open_read_within_root, open_write_within_root, FsError};

/// A real, unique temp directory that is recursively removed on drop. Std-only
/// (no `tempfile` dependency) per the workspace's minimal-dependency convention.
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut path = std::env::temp_dir();
        path.push(format!(
            "friday-fs-test-{}-{}-{}",
            std::process::id(),
            n,
            // Nanos for extra uniqueness across rapid re-runs.
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
        // Best-effort cleanup; ignore errors (test teardown).
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn write_file(path: &Path, contents: &str) {
    let mut f = fs::File::create(path).expect("create file");
    f.write_all(contents.as_bytes()).expect("write file");
}

fn read_to_string(mut f: fs::File) -> String {
    let mut s = String::new();
    f.read_to_string(&mut s).expect("read fd");
    s
}

// ─── 1. Absolute path rejected (lexical) ───
#[test]
fn absolute_candidate_is_rejected_lexically() {
    let root = TempDir::new();
    // A real file exists at the absolute target so a non-hardened open WOULD
    // succeed — proving the rejection is the safety gate, not just ENOENT.
    let outside = TempDir::new();
    let secret = outside.path().join("secret.txt");
    write_file(&secret, "TOP SECRET");

    let abs = secret.to_str().unwrap();
    let err = open_read_within_root(root.path(), abs).unwrap_err();
    assert!(
        matches!(err, FsError::Lexical(PathError::Absolute)),
        "expected Lexical(Absolute), got {err:?}"
    );
}

// ─── 2. `..` traversal rejected (lexical) ───
#[test]
fn parent_traversal_is_rejected_lexically() {
    let root = TempDir::new();
    // Real sibling-escape target: <root>/../<sibling>/secret.txt would resolve
    // outside root; place a real file there so only the lexical gate stops us.
    let parent = root.path().parent().unwrap();
    let sibling_secret = parent.join("friday-fs-escape-secret.txt");
    write_file(&sibling_secret, "ESCAPED");

    let err = open_read_within_root(root.path(), "../friday-fs-escape-secret.txt").unwrap_err();
    assert!(
        matches!(err, FsError::Lexical(PathError::Traversal)),
        "expected Lexical(Traversal), got {err:?}"
    );

    let _ = fs::remove_file(&sibling_secret);
}

// ─── 3. FINAL-component symlink pointing outside root rejected (O_NOFOLLOW) ───
#[test]
fn final_component_symlink_escape_is_rejected_by_nofollow() {
    let root = TempDir::new();
    let outside = TempDir::new();
    let secret = outside.path().join("secret.txt");
    write_file(&secret, "OUTSIDE SECRET BYTES");

    // Real symlink: <root>/link.txt -> <outside>/secret.txt
    let link = root.path().join("link.txt");
    symlink(&secret, &link).expect("create final-component symlink");
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink(),
        "link.txt must really be a symlink on disk"
    );

    let err = open_read_within_root(root.path(), "link.txt").unwrap_err();
    assert!(
        matches!(err, FsError::Symlink),
        "expected Symlink (O_NOFOLLOW/ELOOP), got {err:?}"
    );
    // The escaped secret bytes were never yielded: the call returned Err, so
    // there is no File from which "OUTSIDE SECRET BYTES" could have been read.
}

// ─── 4. ANCESTOR-directory symlink escape rejected (realpath-ancestor) ───
#[test]
fn ancestor_directory_symlink_escape_is_rejected() {
    let root = TempDir::new();
    let outside = TempDir::new();
    // Real file in an outside directory: <outside>/realdir/secret.txt
    let outside_dir = outside.path().join("realdir");
    fs::create_dir_all(&outside_dir).unwrap();
    let secret = outside_dir.join("secret.txt");
    write_file(&secret, "ANCESTOR ESCAPE BYTES");

    // Real ANCESTOR symlink: <root>/sub -> <outside>/realdir
    // so the candidate "sub/secret.txt" has a non-final symlink component whose
    // target escapes the root. O_NOFOLLOW would NOT catch this (the final
    // component `secret.txt` is a real file); the realpath-ancestor check must.
    let sub = root.path().join("sub");
    symlink(&outside_dir, &sub).expect("create ancestor-dir symlink");
    assert!(
        fs::symlink_metadata(&sub).unwrap().file_type().is_symlink(),
        "sub must really be a symlink on disk"
    );

    let err = open_read_within_root(root.path(), "sub/secret.txt").unwrap_err();
    assert!(
        matches!(err, FsError::Escape),
        "expected Escape (realpath-ancestor), got {err:?}"
    );
}

// ─── 5. TOCTOU swap rejected (fd-identity) ───
// NOTE: the TOCTOU fd-identity test needs the *private* `verify_fd_identity`
// helper (a live thread race would be flaky on CI), so it lives as a unit test
// in `src/lib.rs` (`tests::toctou_component_swap_is_rejected_by_fd_identity`)
// rather than widening the crate's public API with a test-only hook. It is a
// REAL on-disk symlink swap between two distinct inodes, deterministic. The
// directory-rejection unit test lives there too.

// ─── 6. Legitimately-contained file opened OK (read returns its bytes) ───
#[test]
fn contained_file_opens_and_reads_back() {
    let root = TempDir::new();
    // Nested, real, contained file.
    let dir = root.path().join("skills");
    fs::create_dir_all(&dir).unwrap();
    write_file(&dir.join("note.txt"), "hello world");

    let file = open_read_within_root(root.path(), "skills/note.txt").expect("contained open OK");
    assert_eq!(read_to_string(file), "hello world");
}

// ─── 7. Write within root creates/writes OK; contained read-back matches ───
#[test]
fn write_within_root_creates_and_readback_matches() {
    let root = TempDir::new();

    // create=true on a fresh path creates the file.
    {
        let mut f =
            open_write_within_root(root.path(), "out.txt", true).expect("contained write OK");
        f.write_all(b"written via safe-open").expect("write bytes");
        f.flush().expect("flush");
    }

    // Read it back through the hardened read path — bytes match.
    let f = open_read_within_root(root.path(), "out.txt").expect("read back contained file");
    assert_eq!(read_to_string(f), "written via safe-open");

    // The real file exists on disk inside the root.
    assert!(root.path().join("out.txt").exists());
}

// ─── Bonus: write through a final-component symlink is refused (O_NOFOLLOW) ───
#[test]
fn write_through_final_symlink_is_rejected() {
    let root = TempDir::new();
    let outside = TempDir::new();
    let target = outside.path().join("target.txt");
    write_file(&target, "ORIGINAL");

    // <root>/w.txt -> <outside>/target.txt
    let link = root.path().join("w.txt");
    symlink(&target, &link).expect("create symlink");

    let err = open_write_within_root(root.path(), "w.txt", false).unwrap_err();
    assert!(
        matches!(err, FsError::Symlink),
        "expected Symlink, got {err:?}"
    );
    // The outside target was NOT modified through the symlink.
    assert_eq!(fs::read_to_string(&target).unwrap(), "ORIGINAL");
}

// ─── Reviewer A#3: write replaces contents (no stale tail), create=false ───
#[test]
fn write_overwrite_truncates_no_stale_tail() {
    let root = TempDir::new();
    let p = root.path().join("data.txt");
    write_file(&p, "AAAAAAAAAA"); // 10 bytes already present

    // create=false: must exist, then REPLACE contents. The short write must not
    // leave a stale tail (the pre-fix O_TRUNC-less write left "BBBAAAAAAA").
    {
        let mut f = open_write_within_root(root.path(), "data.txt", false).expect("overwrite OK");
        f.write_all(b"BBB").expect("write");
        f.flush().expect("flush");
    }
    assert_eq!(
        fs::read_to_string(&p).unwrap(),
        "BBB",
        "write must replace contents, not leave a stale tail"
    );
}

// ─── Reviewer A#3: create=true over an existing longer file also replaces ───
#[test]
fn write_create_replaces_existing_contents() {
    let root = TempDir::new();
    let p = root.path().join("data.txt");
    write_file(&p, "OLD LONG CONTENT");
    {
        let mut f = open_write_within_root(root.path(), "data.txt", true).expect("create+replace");
        f.write_all(b"NEW").expect("write");
        f.flush().expect("flush");
    }
    assert_eq!(fs::read_to_string(&p).unwrap(), "NEW");
}

// ─── Reviewer A#1: truncation happens only AFTER the identity check ───
// (A swapped/abnormal target must never be zeroed before rejection.) Here the
// final component is a symlink to an outside file with content; the write is
// refused (Symlink) and the OUTSIDE file is byte-unchanged — proving set_len(0)
// did not run before verification.
#[test]
fn write_does_not_truncate_before_verification() {
    let root = TempDir::new();
    let outside = TempDir::new();
    let target = outside.path().join("t.txt");
    write_file(&target, "MUST SURVIVE");
    let link = root.path().join("s.txt");
    symlink(&target, &link).expect("symlink");

    let err = open_write_within_root(root.path(), "s.txt", false).unwrap_err();
    assert!(
        matches!(err, FsError::Symlink),
        "expected Symlink, got {err:?}"
    );
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "MUST SURVIVE",
        "outside target must not be truncated before the symlink rejection"
    );
}

// ─── Reviewer A#2: write-open of a directory → IsDirectory (EISDIR) ───
#[test]
fn write_to_directory_is_rejected_isdirectory() {
    let root = TempDir::new();
    fs::create_dir(root.path().join("adir")).expect("create dir");
    let err = open_write_within_root(root.path(), "adir", false).unwrap_err();
    assert!(
        matches!(err, FsError::IsDirectory),
        "expected IsDirectory (EISDIR), got {err:?}"
    );
}

// ─── Reviewer B#F3: a FIFO is rejected as non-regular WITHOUT blocking ───
#[test]
fn fifo_is_rejected_not_regular_and_does_not_hang() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let root = TempDir::new();
    let fifo = root.path().join("pipe");
    let c = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    // Real named pipe inside the root. O_NONBLOCK must let the open return so the
    // post-open fstat can reject it; without it, O_RDONLY would block forever.
    let rc = unsafe { libc::mkfifo(c.as_ptr(), 0o644) };
    assert_eq!(rc, 0, "mkfifo should succeed");

    let err = open_read_within_root(root.path(), "pipe").unwrap_err();
    assert!(
        matches!(err, FsError::NotRegularFile),
        "expected NotRegularFile, got {err:?}"
    );
}

// ─── Reviewer A#5 / B#F4: `.`, empty, and interior `.` segments rejected ───
#[test]
fn dot_and_empty_candidates_are_rejected_lexically() {
    let root = TempDir::new();
    for cand in ["", ".", "./", "a/./b"] {
        let err = open_read_within_root(root.path(), cand).unwrap_err();
        assert!(
            matches!(err, FsError::Lexical(PathError::Traversal)),
            "candidate {cand:?}: expected Lexical(Traversal), got {err:?}"
        );
    }
}

// ─── Reviewer B#round-2: a created file is owner-only (0o600), oracle parity ───
#[test]
fn created_file_is_owner_only_0o600() {
    use std::os::unix::fs::PermissionsExt;
    let root = TempDir::new();
    {
        let _f = open_write_within_root(root.path(), "secret.txt", true).expect("create");
    }
    let mode = fs::metadata(root.path().join("secret.txt"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(
        mode & 0o777,
        0o600,
        "agent-created file must be owner-only (0o600), got {:o}",
        mode & 0o777
    );
}
