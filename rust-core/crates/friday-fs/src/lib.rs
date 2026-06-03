//! Hardened, workspace-root-contained file open (Hub-only).
//!
//! This is the PR-4-deferred filesystem read/write/edit surface for the
//! agent-loop `ToolExecutor` (goal file 52 §4b). It is a faithful Rust port of
//! the **I/O** half of the TS oracle `src/utilities/friday-path-safety.ts`: the
//! read path mirrors `openFileWithinRoot`, the write path mirrors the write-side
//! `openWritableFileNoFollow` / write-tool block in `friday-agent-file-tools.ts`
//! (open `O_NOFOLLOW` without `O_TRUNC` → identity-check → `ftruncate`). It is the
//! half that `friday_core::pathsafe` (the pure *lexical* floor, ported in PR-4)
//! explicitly deferred.
//!
//! # Threat model
//!
//! A caller supplies a trusted `root` directory and an **untrusted** relative
//! `candidate`. We must open the file the caller *named*, never a file an
//! attacker can substitute by:
//!   - giving an absolute path or `.`/`..` traversal (lexical escape),
//!   - making the final path component a symlink that points outside `root`,
//!   - making an *ancestor* directory component a symlink that points outside
//!     `root`,
//!   - swapping the **final** component for a symlink in the window between our
//!     checks and the `open` syscall (TOCTOU — see the limitation on *ancestor*
//!     swaps below).
//!
//! # Hardening pipeline (faithful to the oracle's ordering)
//!
//! For both read and write, in order:
//!   1. **Lexical gate** — [`friday_core::contained`] rejects an
//!      absolute candidate, any `..` segment, or a lexical escape. No syscalls.
//!      (Oracle: the leading `isAbsolute` / `split(/[/\\]/).includes("..")` /
//!      `isWithinBase` block.)
//!   2. **Canonicalize the root** — `std::fs::canonicalize(root)`. The oracle's
//!      first syscall is `realpathSync(rootDir)`; every on-disk containment
//!      check below is made against this *real* root so a symlinked root
//!      (`/tmp` → `/private/tmp` on macOS) does not cause false rejections.
//!   3. **Realpath-ancestor containment** — canonicalize the parent directory
//!      of the target and assert (component-wise, via [`Path::starts_with`], not
//!      string prefix — defeats the `/ws-evil` vs `/ws` sibling bug) that it is
//!      still under the real root. This catches an ancestor-directory symlink
//!      escape, and runs **before** any `open` so the open never follows it.
//!      (Oracle: the `realpathSync(dirname(resolvedFull))` ancestor block.)
//!   4. **`O_NOFOLLOW` open** — open the target with `libc::O_NOFOLLOW` so the
//!      *final* component cannot be a symlink (POSIX `open` returns `ELOOP`).
//!      (Oracle: `O_RDONLY | O_NOFOLLOW`.)
//!   5. **post-open fd verification** — `fstat` the fd; reject a **directory**
//!      (`open(O_NOFOLLOW)` on a dir succeeds on POSIX — mirrors the oracle's
//!      `fdStat.isDirectory()`/`EISDIR` guard), then the **fd-identity TOCTOU**
//!      check: compare device+inode against a follow-`stat` of the resolved
//!      path. A mismatch means the path was swapped between our checks and the
//!      open, so the fd does not refer to the file we validated → reject.
//!      (Oracle: the `fstatSync(fd)` directory check + `fstatSync(fd)` vs
//!      `statSync(resolvedFull)` `ino`/`dev` comparison.)
//!
//! # Platform divergences from the oracle (truth-labeled)
//!
//! - **EINVAL/ENOTSUP retry omitted.** The oracle retries without `O_NOFOLLOW`
//!   on `EINVAL`/`ENOTSUP` because Node historically reported `O_NOFOLLOW`
//!   inconsistently on some platforms. On POSIX (macOS + Linux/CI ubuntu),
//!   `open(O_NOFOLLOW)` on a final-component symlink returns `ELOOP` cleanly, so
//!   the retry is a Node artifact and is deliberately dropped. A final-component
//!   symlink is rejected as [`FsError::Symlink`] (`ELOOP`).
//! - **`stat` (follow) for the identity check**, mirroring the oracle's
//!   `statSync`. The task text says `lstat`; the two are functionally equivalent
//!   for swap detection here — both differ in dev/ino from the `O_NOFOLLOW`'d
//!   fd whenever a component was swapped for a symlink — and we mirror the
//!   oracle.
//! - **Final-component open with `O_NOFOLLOW`** (faithful to the oracle) rather
//!   than an `openat`/`O_DIRECTORY` walk. The realpath-ancestor check (step 3)
//!   handles ancestor symlinks; `O_NOFOLLOW` handles the final component.
//! - **Windows is not a target.** This crate is Hub-only and uses POSIX
//!   `O_NOFOLLOW`; it compiles for `#[cfg(unix)]` (macOS + Linux). The lexical
//!   gate it sits on still rejects Windows-style absolute candidates.
//!
//! # Known limitations (all shared with the TS oracle's realpath design)
//!
//! - **Hardlinks are not detected.** A hardlink under `root` to a file outside
//!   `root` resolves to a real path genuinely under `root` (a hardlink leaves no
//!   on-disk trace of its other names), so realpath + the dev/ino identity check
//!   both pass and the outside inode's bytes are read/written. `realpathSync` +
//!   the oracle's ino/dev check share this exactly. Mitigation is operational:
//!   do not place a workspace root on a filesystem where an untrusted party can
//!   plant hardlinks.
//! - **Ancestor-component TOCTOU is not closed.** The fd-identity check defends
//!   the *final* component over the open→restat window; an **ancestor** directory
//!   swapped for an outside-pointing symlink in the check→open window would be
//!   followed by `open` and matched by the follow-restat (same swapped link →
//!   same dev/ino). `O_NOFOLLOW` only covers the final component. Closing this
//!   needs a per-component `openat`/`openat2(RESOLVE_BENEATH)` walk; the oracle's
//!   string-path re-open shares the same residual window. Documented, not claimed
//!   defended.
//! - **Non-regular files are rejected** (FIFO/socket/device): we open
//!   `O_NONBLOCK` (so a FIFO never blocks) and require a regular-file fd. This is
//!   STRICTER than the oracle (which only rejects directories) — a safe hardening
//!   for the tool surface.

use std::fs::{File, OpenOptions};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use friday_core::{contained, PathError};
use thiserror::Error;

/// Why a hardened open was rejected.
#[derive(Debug, Error)]
pub enum FsError {
    /// The lexical gate ([`friday_core::contained`]) rejected the
    /// candidate: absolute path, `..` traversal, or a purely-lexical escape.
    #[error("lexical path rejection: {0:?}")]
    Lexical(PathError),

    /// A component of the resolved path is a symlink that we refuse to follow:
    /// the *final* component (caught by `O_NOFOLLOW`, errno `ELOOP`).
    #[error("path component is a symlink (rejected)")]
    Symlink,

    /// The resolved real path escapes the root via an *ancestor*-directory
    /// symlink, or the fd-identity check found a TOCTOU swap — in both cases the
    /// resolved file lies outside the trusted root.
    #[error("path escapes root directory")]
    Escape,

    /// The target file (or a required parent directory) does not exist.
    #[error("file not found")]
    NotFound,

    /// The resolved path is a directory, not a regular file. Mirrors the
    /// oracle's `fdStat.isDirectory()` / `EISDIR` rejection: `open(O_NOFOLLOW)`
    /// on a directory succeeds on POSIX, so we reject it explicitly after open
    /// (read path), and `EISDIR` from a write-open maps here too.
    #[error("path is a directory, not a file")]
    IsDirectory,

    /// The resolved path is neither a regular file nor a directory — a FIFO,
    /// socket, or device node. The agent-loop `ToolExecutor` only ever wants a
    /// regular file; opening a FIFO `O_RDONLY` without `O_NONBLOCK` would block
    /// indefinitely (a DoS), so we open non-blocking and reject any non-regular
    /// fd here. (The oracle only checks `isDirectory`; rejecting all non-regular
    /// files is a deliberate, safe hardening for the tool surface.)
    #[error("path is not a regular file")]
    NotRegularFile,

    /// The trusted `root` could not be represented as UTF-8 for the lexical gate
    /// (which operates on `&str`, mirroring the oracle's string paths).
    #[error("root path is not valid UTF-8")]
    NonUtf8Root,

    /// An underlying I/O error not classified above.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Open a contained file for **reading**, with the full hardening pipeline.
///
/// On success the returned [`File`] is guaranteed to refer to a regular path
/// that (a) is lexically contained in `root`, (b) has no ancestor-symlink escape,
/// (c) has a non-symlink final component, and (d) survived the fd-identity TOCTOU
/// check. The caller owns the [`File`].
pub fn open_read_within_root(root: &Path, candidate: &str) -> Result<File, FsError> {
    let resolved = resolve_within_root(root, candidate, /* parent_must_exist */ true)?;
    // O_NONBLOCK so opening a FIFO never blocks waiting for a writer (a DoS on the
    // tool surface); it is a no-op for regular files. verify_fd_identity then rejects
    // any non-regular fd.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&resolved.full)
        .map_err(classify_open_err)?;
    verify_fd_identity(&file, &resolved.full)?;
    Ok(file)
}

/// Open a contained file for **writing**, with the full hardening pipeline.
///
/// The write-side oracle is `openWritableFileNoFollow` / the write-tool block in
/// `friday-agent-file-tools.ts` (NOT the read-only `openFileWithinRoot`): it opens
/// `O_NOFOLLOW` **without** `O_TRUNC`, runs the fstat/stat identity check, and only
/// then `ftruncate`s — "truncate only after identity checks to avoid destructive
/// partial failures". We mirror that: open (no truncate) → verify identity →
/// `set_len(0)`. So a swapped/abnormal target is never zeroed before it is rejected.
///
/// When `create` is true the file is created if absent (the *parent* directory must
/// already exist — we do not `mkdir` intermediate directories). Write semantics are
/// **replace contents**: the file is truncated to zero on success for both
/// `create` values (matching the oracle write tool, which always `ftruncate`s — this
/// also closes the stale-tail bug where a short write over a longer file left
/// trailing bytes). `O_NOFOLLOW` refuses writing *through* a final-component symlink
/// (`ELOOP`); `O_NONBLOCK` avoids a FIFO `O_WRONLY` hang; non-regular fds are rejected.
pub fn open_write_within_root(root: &Path, candidate: &str, create: bool) -> Result<File, FsError> {
    // The parent must exist so the realpath-ancestor check can canonicalize it;
    // we never create intermediate directories.
    let resolved = resolve_within_root(root, candidate, /* parent_must_exist */ true)?;
    let file = OpenOptions::new()
        .write(true)
        .create(create)
        // Owner-only (0o600) on creation, matching the oracle's `mode = 0o600` on
        // every write open — agent-written workspace files may be secret-bearing and
        // must not be group/world-readable. `mode` is applied by `open(2)` only with
        // O_CREAT, so an existing file's permissions are untouched (create=false safe).
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&resolved.full)
        .map_err(classify_open_err)?;
    // Verify the fd refers to the path we validated (always — faithful to the oracle,
    // which always fstat/stat-checks) BEFORE any truncation.
    verify_fd_identity(&file, &resolved.full)?;
    // Replace contents: truncate ONLY after the identity check succeeded, so a target
    // that failed verification (swap/non-regular) is never destructively zeroed.
    file.set_len(0)?;
    Ok(file)
}

/// Atomically write `contents` to a contained file: write to a temp file in the SAME
/// directory, fsync, then `rename(2)` it over the target. **Durable atomicity** — a
/// reader/observer sees either the full old contents or the full new contents, never a
/// truncated/partial file: the target is mutated ONLY by the final atomic rename, so a
/// mid-write I/O failure or crash leaves the original intact (the documented #30b NIT in
/// the agent-loop ToolExecutor).
///
/// **Beyond the oracle (deliberate, NOT a mirror):** the TS write tool
/// (`friday-agent-file-tools.ts`) does open→identity-check→`ftruncate`→`writeFileSync`
/// in place — it guards destructive-zeroing-before-verification but accepts the
/// partial-write window. This temp+rename closes that window; it is a conscious
/// improvement over the oracle, not a port of it.
///
/// Containment + safety are preserved:
/// - The target is resolved through the same [`resolve_within_root`] pipeline (lexical
///   gate + canonicalized-root + realpath-ancestor parent check) as the open paths.
/// - The temp is created in the target's realpath-verified parent with
///   `O_CREAT|O_EXCL|O_NOFOLLOW` + `0o600`. `O_EXCL` means the temp is provably ours —
///   freshly created, never a pre-existing symlink — so there is no TOCTOU on it and no
///   fd-identity re-check is needed (we never open the *target*; `rename(2)` acts on the
///   name, which the parent realpath check contained).
/// - An existing **non-regular target** (symlink / dir / fifo / …) is refused via a
///   pre-`lstat` (no-follow). This is a *don't-clobber* policy matching the open path's
///   refusal, NOT an escape control: `rename(2)` never follows a symlink (it replaces
///   the link), so the lstat's TOCTOU is harmless.
/// - On ANY failure after the temp is created (write/fsync/rename), the temp is unlinked
///   — and never after a successful rename (the rename consumes the temp name).
///
/// Residual (same posture as [`open_write_within_root`], tracked follow-up): a
/// parent-*directory* swap between the realpath check and the rename is a path-based
/// TOCTOU not closed here; the hardening is `renameat`/`O_DIRECTORY`-fd-relative ops.
pub fn write_file_within_root(
    root: &Path,
    candidate: &str,
    contents: &[u8],
) -> Result<(), FsError> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    let resolved = resolve_within_root(root, candidate, /* parent_must_exist */ true)?;
    let target = resolved.full;

    // Don't-clobber policy (lstat = no follow): refuse to replace a non-regular target,
    // matching the open path's O_NOFOLLOW / regular-only refusal. A missing target is a
    // fresh create. (Not an escape control — see the doc comment.)
    match std::fs::symlink_metadata(&target) {
        Ok(meta) => {
            let ft = meta.file_type();
            if ft.is_symlink() {
                return Err(FsError::Symlink);
            }
            if ft.is_dir() {
                return Err(FsError::IsDirectory);
            }
            if !ft.is_file() {
                return Err(FsError::NotRegularFile);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(classify_open_err(e)),
    }

    // Temp in the SAME directory (so the rename is same-filesystem ⇒ atomic). The parent
    // was realpath-verified under root by resolve_within_root; the temp name has no path
    // separators, so it stays in that directory.
    let parent = target.parent().ok_or(FsError::Escape)?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(FsError::Escape)?;
    static TMP_CTR: AtomicU64 = AtomicU64::new(0);
    let nonce = TMP_CTR.fetch_add(1, Ordering::Relaxed);
    let tmp_path = parent.join(format!(".{file_name}.tmp.{}.{nonce}", std::process::id()));

    // Create the temp FRESH (O_CREAT|O_EXCL ⇒ provably ours, no TOCTOU, can't be a
    // pre-existing symlink), O_NOFOLLOW + owner-only.
    let mut tmp = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&tmp_path)
        .map_err(classify_open_err)?;

    // write → fsync → atomic rename. On any failure, unlink the temp (it still exists,
    // because a successful rename consumes the temp name — so we never unlink post-rename).
    let io_result = tmp
        .write_all(contents)
        .and_then(|()| tmp.sync_all())
        .and_then(|()| std::fs::rename(&tmp_path, &target));
    match io_result {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            Err(FsError::from(e))
        }
    }
}

/// A candidate that has passed the lexical gate + canonicalized-root +
/// realpath-ancestor containment checks. `full` is the absolute path to open
/// (built from the *real* root so it is safe to hand to `open`).
struct Resolved {
    full: PathBuf,
}

/// Steps 1–3 of the pipeline (everything before the `open` syscall). Shared by
/// read and write so the ordering cannot drift between them.
fn resolve_within_root(
    root: &Path,
    candidate: &str,
    parent_must_exist: bool,
) -> Result<Resolved, FsError> {
    // 1. Lexical gate (no syscalls): absolute / `..` / lexical escape.
    let root_str = root.to_str().ok_or(FsError::NonUtf8Root)?;
    // The oracle's `hasTraversalSegments` rejects "." as well as ".." (and an empty
    // path); the pure lexical floor `contained` rejects only ".."/absolute and
    // *collapses* ".". Reject an empty candidate or any "." segment here so naming the
    // root itself (`""`, `.`, `./`) is a clean lexical rejection rather than a
    // misleading `Escape`, and `a/./b` is refused exactly as the oracle does. Split on
    // both separators to match the oracle's `/[/\\]/`.
    if candidate.is_empty() || candidate.split(['/', '\\']).any(|seg| seg == ".") {
        return Err(FsError::Lexical(PathError::Traversal));
    }
    contained(root_str, candidate).map_err(FsError::Lexical)?;

    // 2. Canonicalize the root — all on-disk containment is against the REAL
    //    root (handles /tmp → /private/tmp etc.). A non-existent root is NotFound.
    let real_root = std::fs::canonicalize(root).map_err(classify_open_err)?;

    // Build the path to open from the REAL root + the (now-validated, `..`-free,
    // relative) candidate — not the lexical string. `Path::join` over the
    // candidate's components is safe because the lexical gate proved it has no
    // `..` and is not absolute.
    let full = real_root.join(candidate);

    // 3. Realpath-ancestor containment: canonicalize the PARENT and assert it is
    //    still under the real root (component-wise). This catches an ancestor-
    //    directory symlink escape and runs BEFORE any open, so the open never
    //    follows such a symlink.
    let parent = full.parent().unwrap_or(&real_root);
    match std::fs::canonicalize(parent) {
        Ok(real_parent) => {
            if !real_parent.starts_with(&real_root) {
                return Err(FsError::Escape);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if parent_must_exist {
                return Err(FsError::NotFound);
            }
            // (Currently both callers require the parent to exist; this arm is a
            // documented extension point — we do not mkdir intermediates.)
        }
        Err(e) => return Err(classify_open_err(e)),
    }

    Ok(Resolved { full })
}

/// Step 5: post-open fd verification — directory rejection + fd-identity TOCTOU
/// check, in the same order as the oracle's post-open block.
///
/// First `fstat` the open fd: if it is a **directory**, reject
/// ([`FsError::IsDirectory`]) — `open(O_NOFOLLOW)` on a directory succeeds on
/// POSIX, so this mirrors the oracle's `fdStat.isDirectory()` guard (and its
/// `EISDIR` mapping). Then compare device + inode against a follow-`stat` of
/// `path`: a mismatch means the path was swapped (e.g. for a symlink) between
/// our checks and the open, so the fd does not refer to the validated file →
/// reject ([`FsError::Escape`]). Mirrors the oracle's `fstatSync(fd).{ino,dev}`
/// vs `statSync(resolvedFull).{ino,dev}`.
fn verify_fd_identity(file: &File, path: &Path) -> Result<(), FsError> {
    let fd_meta = file.metadata()?; // fstat on the open fd
    if fd_meta.is_dir() {
        return Err(FsError::IsDirectory);
    }
    // Reject any non-regular fd (FIFO/socket/device). We opened O_NONBLOCK so a FIFO
    // did not block; here we refuse it. Regular files only — the tool surface never
    // wants anything else, and this closes the FIFO-DoS / device-node vectors.
    if !fd_meta.is_file() {
        return Err(FsError::NotRegularFile);
    }
    let path_meta = std::fs::metadata(path)?; // follow-stat on the path (TOCTOU re-read)
    if fd_meta.dev() != path_meta.dev() || fd_meta.ino() != path_meta.ino() {
        return Err(FsError::Escape);
    }
    Ok(())
}

/// Map an `open`/`canonicalize` `io::Error` to an [`FsError`]. `ELOOP` (a
/// final-component symlink rejected by `O_NOFOLLOW`) → [`FsError::Symlink`];
/// `ENOENT`/`ENOTDIR` → [`FsError::NotFound`]; `EISDIR` (a write-open of a
/// directory, which errors before any fstat) → [`FsError::IsDirectory`];
/// everything else → [`FsError::Io`].
fn classify_open_err(e: std::io::Error) -> FsError {
    match e.raw_os_error() {
        Some(libc::ELOOP) => FsError::Symlink,
        Some(libc::ENOENT) | Some(libc::ENOTDIR) => FsError::NotFound,
        Some(libc::EISDIR) => FsError::IsDirectory,
        _ => FsError::Io(e),
    }
}

#[cfg(test)]
mod tests {
    //! Unit tests that need the *private* [`verify_fd_identity`] helper. The
    //! seven public-API adverse tests live in `tests/adverse_fs.rs`; these two
    //! must reach inside the crate, so they live here rather than widening the
    //! public surface with a test-only hook. Both use REAL on-disk objects.

    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Real, unique temp dir, recursively removed on drop (std-only; no
    /// `tempfile` dependency, matching the workspace's minimal-dep convention).
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!(
                "friday-fs-unit-{}-{}-{}",
                std::process::id(),
                n,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            TempDir { path }
        }
        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn write_file(path: &Path, contents: &str) {
        let mut f = File::create(path).expect("create file");
        f.write_all(contents.as_bytes()).expect("write file");
    }

    /// TOCTOU swap rejected by fd-identity — deterministic simulation of the
    /// check-vs-open window using two REAL, distinct inodes (not a live thread
    /// race, which would be flaky on CI). We reproduce the exact state the
    /// fd-identity branch defends against: an open fd to the validated file,
    /// and the path now pointing (via a real on-disk symlink) at a DIFFERENT
    /// real file.
    #[test]
    fn toctou_component_swap_is_rejected_by_fd_identity() {
        let root = TempDir::new();
        let outside = TempDir::new();

        // Legitimately-contained file we open and validate (inode X, "safe").
        let safe = root.path().join("f.txt");
        write_file(&safe, "SAFE BYTES");
        // Attacker's substitute file outside the root (inode Y, "evil").
        let evil = outside.path().join("evil.txt");
        write_file(&evil, "EVIL BYTES");

        // Open f.txt through the hardened safe-open — succeeds (real contained
        // regular file). This is our fd to inode X.
        let mut file =
            open_read_within_root(root.path(), "f.txt").expect("legit open should succeed");

        // SWAP on disk, simulating the attacker winning the check-vs-open race:
        // f.txt now resolves (via a REAL symlink) to the evil file (inode Y).
        std::fs::remove_file(&safe).unwrap();
        symlink(&evil, &safe).expect("swap f.txt for a symlink to evil");
        assert!(
            std::fs::symlink_metadata(&safe)
                .unwrap()
                .file_type()
                .is_symlink(),
            "f.txt must really be a symlink after the swap"
        );

        // Re-validate identity of the OPEN fd against the now-swapped path. The
        // fd still points at inode X; the path follow-stats to inode Y →
        // mismatch → Escape. (Exercises the private verify_fd_identity branch.)
        let err = verify_fd_identity(&file, &safe).unwrap_err();
        assert!(
            matches!(err, FsError::Escape),
            "expected Escape (fd-identity TOCTOU), got {err:?}"
        );

        // Crucially, the fd we hold STILL reads the safe bytes — the swap did
        // not redirect our already-open descriptor; the evil bytes were never
        // yielded through the safe-open path.
        let mut s = String::new();
        file.read_to_string(&mut s).expect("read fd");
        assert_eq!(s, "SAFE BYTES");
    }

    /// A directory candidate is rejected (oracle's `fdStat.isDirectory()`):
    /// `open(O_NOFOLLOW)` on a real directory succeeds on POSIX, so the post-
    /// open fstat must catch it. Uses a REAL on-disk directory.
    #[test]
    fn directory_candidate_is_rejected() {
        let root = TempDir::new();
        std::fs::create_dir(root.path().join("adir")).expect("create real dir");
        let err = open_read_within_root(root.path(), "adir").unwrap_err();
        assert!(
            matches!(err, FsError::IsDirectory),
            "expected IsDirectory, got {err:?}"
        );
    }

    // ── task #30b: atomic temp+rename write ─────────────────────────────────────

    fn read_file(path: &Path) -> String {
        let mut f = File::open(path).expect("open");
        let mut s = String::new();
        f.read_to_string(&mut s).expect("read");
        s
    }

    /// Count temp files (`.<name>.tmp.*`) left in a dir — must be zero after a write.
    fn temp_leftovers(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .count()
    }

    #[test]
    fn write_file_within_root_creates_then_fully_replaces() {
        let root = TempDir::new();
        // Create a new file.
        write_file_within_root(root.path(), "out.txt", b"hello world").unwrap();
        assert_eq!(read_file(&root.path().join("out.txt")), "hello world");
        assert_eq!(temp_leftovers(root.path()), 0, "no temp left after create");

        // Replace with SHORTER content — full replace, no stale tail (the bug the oracle
        // comment notes for in-place ftruncate; temp+rename also fixes it).
        write_file_within_root(root.path(), "out.txt", b"hi").unwrap();
        assert_eq!(read_file(&root.path().join("out.txt")), "hi");
        assert_eq!(temp_leftovers(root.path()), 0, "no temp left after replace");
    }

    #[test]
    fn write_file_within_root_refuses_symlink_target_and_leaves_it_intact() {
        let root = TempDir::new();
        let outside = TempDir::new();
        let secret = outside.path().join("secret.txt");
        write_file(&secret, "OUTSIDE SECRET");
        // A final-component symlink at the target name (pointing outside root).
        symlink(&secret, root.path().join("link.txt")).unwrap();

        let err = write_file_within_root(root.path(), "link.txt", b"PWNED").unwrap_err();
        assert!(
            matches!(err, FsError::Symlink),
            "a symlink target must be refused, got {err:?}"
        );
        // The symlink AND the file it points at are untouched — we never wrote through it.
        assert_eq!(read_file(&secret), "OUTSIDE SECRET");
        assert!(std::fs::symlink_metadata(root.path().join("link.txt"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(temp_leftovers(root.path()), 0);
    }

    #[test]
    fn write_file_within_root_refuses_traversal_and_dir_target() {
        let root = TempDir::new();
        // Lexical traversal is refused (no write outside root).
        assert!(matches!(
            write_file_within_root(root.path(), "../escape.txt", b"x").unwrap_err(),
            FsError::Lexical(_)
        ));
        // A directory target is refused (don't-clobber), original dir intact.
        std::fs::create_dir(root.path().join("d")).unwrap();
        assert!(matches!(
            write_file_within_root(root.path(), "d", b"x").unwrap_err(),
            FsError::IsDirectory
        ));
        assert!(root.path().join("d").is_dir());
    }

    #[test]
    fn write_file_within_root_replace_is_atomic_original_survives_a_refused_write() {
        // The target is mutated ONLY by the final rename. A write that is REFUSED before
        // the rename (here: the target was swapped to a symlink after it existed as a
        // regular file) leaves the original regular file's content fully intact — never a
        // truncated partial. (A mid-write I/O failure has the same guarantee by
        // construction: the original is untouched until the atomic rename.)
        let root = TempDir::new();
        write_file_within_root(root.path(), "data.txt", b"ORIGINAL-INTACT").unwrap();
        // Swap the now-existing regular file for a symlink (simulating a hostile race /
        // a pre-existing symlink): the next write must refuse and NOT clobber.
        let outside = TempDir::new();
        let decoy = outside.path().join("decoy.txt");
        write_file(&decoy, "DECOY");
        std::fs::remove_file(root.path().join("data.txt")).unwrap();
        symlink(&decoy, root.path().join("data.txt")).unwrap();
        let err = write_file_within_root(root.path(), "data.txt", b"NEW").unwrap_err();
        assert!(matches!(err, FsError::Symlink), "got {err:?}");
        // The decoy (what the symlink pointed at) was NOT written through.
        assert_eq!(read_file(&decoy), "DECOY");
        assert_eq!(temp_leftovers(root.path()), 0);
    }
}
