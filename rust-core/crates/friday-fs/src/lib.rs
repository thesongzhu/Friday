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

use std::ffi::OsString;
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

    /// The resolved path is not a directory where one was required (e.g. `list_dir`
    /// on a regular file → `open(O_DIRECTORY)` returns `ENOTDIR`). Distinct from
    /// [`FsError::IsDirectory`], which rejects a directory where a *file* was wanted.
    #[error("path is not a directory")]
    NotADirectory,

    /// `edit_file` could not apply its replacement: the `old_text` to replace was not
    /// found in the file (or was empty). The file is left **byte-for-byte unchanged** —
    /// no write is performed. (Mirrors a no-op `String::replace` on the oracle's `edit`.)
    #[error("edit target text not found in file")]
    EditNoMatch,

    /// An underlying I/O error not classified above.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// `run_command_in_root` could not turn the `command` string into an argv: it was
    /// empty/whitespace-only, or had an unbalanced quote. **Static message — carries NO
    /// path, NO command text, NO secret** (the offending string never reaches the error,
    /// so it cannot leak into a `Display` that flows to a log/ledger). Fail-closed: an
    /// unparseable command is refused, never silently run.
    #[error("command could not be parsed into an argument vector")]
    CommandInvalid,

    /// `run_command_in_root` could not spawn the child (program not found on the fixed
    /// child `PATH`, not executable, or the OS refused the exec). **Static message — the
    /// underlying `io::Error` (which can carry the program name / errno text) is
    /// DELIBERATELY dropped** so no path/secret reaches the error. Fail-closed.
    #[error("command could not be spawned")]
    CommandSpawn,

    /// A caller explicitly required an OS sandbox, but the local platform/runtime cannot provide
    /// the requested substrate. This is a hard fail-closed signal: the command was NOT run.
    #[error("required command sandbox is unavailable")]
    CommandSandboxUnavailable,
}

/// The kind of a [`stat_file_within_root`] target, after the no-follow `lstat`. A
/// final-component **symlink** is never reported (it is rejected as [`FsError::Symlink`]);
/// anything that is neither a regular file nor a directory (FIFO/socket/device) is
/// [`FileKind::Other`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    /// A regular file.
    File,
    /// A directory.
    Dir,
    /// A non-regular, non-directory inode (FIFO, socket, device node, …).
    Other,
}

/// Metadata for a contained path returned by [`stat_file_within_root`]. `mode` is the
/// low 9 permission bits (`& 0o777`); `len` is the inode size (bytes for a file; the
/// directory's own size for a directory). Reported from the single no-follow `lstat`,
/// so it describes exactly the inode named (no symlink follow, no re-resolution).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileStat {
    /// File / directory / other.
    pub kind: FileKind,
    /// Inode size in bytes.
    pub len: u64,
    /// Low 9 permission bits (`mode & 0o777`).
    pub mode: u32,
    /// Whether the inode is not writable by anyone (std `Permissions::readonly`).
    pub readonly: bool,
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
/// directory, fsync the temp, then `rename(2)` it over the target. **Atomic replace** — a
/// reader sees either the full old contents or the full new contents, never a
/// truncated/partial file: the target is mutated ONLY by the final atomic rename, so a
/// mid-write I/O failure leaves the original intact (the documented #30b NIT in the
/// agent-loop ToolExecutor). (We fsync the temp before rename, but do NOT fsync the
/// parent directory, so the *crash-durability* of the committed rename is not guaranteed
/// — "atomic", not "durable across a power loss".)
///
/// **Beyond the oracle (deliberate, NOT a mirror):** the TS write tool
/// (`friday-agent-file-tools.ts`) does open→identity-check→`ftruncate`→`writeFileSync`
/// in place — it guards destructive-zeroing-before-verification but accepts the
/// partial-write window. This temp+rename closes that window; it is a conscious
/// improvement over the oracle, not a port of it.
///
/// **Replace semantics differ from an in-place write (truth-labeled):** because the new
/// file is a fresh inode renamed over the target, a successful replace **normalizes the
/// file's mode to `0o600`** (dropping any prior mode/xattrs/ACLs) and **breaks hardlinks**
/// (the other names keep the old inode). This is acceptable for the agent workspace
/// (agent-written files are `0o600` regular files), but it is strictly different from the
/// oracle's in-place write, which preserves the existing inode/mode. The one protection
/// that IS preserved: a **read-only** (non-owner-writable) existing target is refused with
/// `EACCES`, exactly as an in-place write-open would fail — temp+rename does not silently
/// overwrite a read-only contained file.
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
            // Preserve the open path's (and the oracle's) protection of a read-only file:
            // an in-place write-open of a non-owner-writable file fails EACCES. temp+rename
            // writes via the *parent* dir, so it would otherwise silently overwrite a
            // read-only file (and reset its mode) — refuse instead, EACCES like the oracle.
            if meta.mode() & 0o200 == 0 {
                return Err(FsError::Io(std::io::Error::from_raw_os_error(libc::EACCES)));
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

/// List the entries of a contained directory, **TOCTOU-free**.
///
/// Containment mirrors the read path's *final-component-swap* defense (not merely the
/// lexical gate): the directory is opened `O_NOFOLLOW | O_NONBLOCK` so a final-component
/// **symlink** is rejected (`ELOOP` → [`FsError::Symlink`]) exactly as for [`open_read_within_root`];
/// the realpath-ancestor parent check has already run ([`resolve_within_root`]); a post-open
/// `fstat` then requires the fd to be a **directory** ([`FsError::NotADirectory`] otherwise —
/// `open(O_NOFOLLOW)` succeeds on a regular file / FIFO too, so this mirrors the read path's
/// post-open directory check); and the listing is finally read from the **validated open fd**
/// via `fdopendir`/`readdir` — never by re-resolving the path string. So the entries returned
/// are exactly those of the inode we validated: a name swapped *after* the open cannot redirect
/// the listing — the parity guarantee a plain `std::fs::read_dir(path)` (which re-resolves the
/// name) would NOT give.
///
/// (`O_DIRECTORY` is deliberately NOT used: combined with `O_NOFOLLOW` on a symlink-to-a-dir
/// some platforms return `ENOTDIR` instead of `ELOOP`, which would misclassify a rejected
/// final-component symlink. The post-open `fstat` gives a platform-stable `NotADirectory`.)
///
/// Returns each entry name (excluding `.` and `..`), **sorted** for deterministic output.
///
/// # Residual (same posture as the read/write paths)
/// The ancestor-directory TOCTOU window documented on [`open_read_within_root`] (an
/// *ancestor* swapped for an outside-pointing symlink in the check→open window) is not
/// closed here; the **final** component IS fully closed by `O_NOFOLLOW` + the held fd.
///
/// Listing the trusted root ITSELF is supported: a candidate that denotes the root
/// (`""`, `.`, or `./`) lists the canonicalized root's direct entries. This is the ONE
/// primitive that accepts the root (read/write/stat/edit/append/delete/move still reject
/// it via [`resolve_within_root`]) — the root is the containment boundary, not a path
/// *above* it, so listing its children is escape-safe: `readdir` on the root fd yields the
/// root's direct children only, with `..` excluded, so nothing above the root is ever
/// surfaced. The root case gets the SAME final-component hardening as a sub-dir (real root
/// opened `O_NOFOLLOW | O_NONBLOCK`, post-open `fstat` is-dir, `fdopendir`/`readdir` from
/// the validated fd). Every NON-root candidate still flows through [`resolve_within_root`],
/// so `..` / absolute / final-component-symlink / ancestor-symlink escapes stay rejected.
pub fn list_dir_within_root(root: &Path, candidate: &str) -> Result<Vec<OsString>, FsError> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::IntoRawFd;

    // A candidate that denotes the root (`""`, `.`, `./`) lists the root itself. We
    // canonicalize the root — the IDENTICAL call resolve_within_root step 2 makes (handles
    // /tmp → /private/tmp; a non-existent root is NotFound) — and open THAT. The realpath-
    // ancestor PARENT check is skipped here ONLY because the root has no in-bound parent to
    // validate against (it IS the boundary), NOT because containment is relaxed: every
    // non-root candidate still flows through resolve_within_root, so `..`/absolute/symlink/
    // sub-path escapes remain rejected exactly as before.
    let full = if candidate.is_empty() || candidate == "." || candidate == "./" {
        std::fs::canonicalize(root).map_err(classify_open_err)?
    } else {
        resolve_within_root(root, candidate, /* parent_must_exist */ true)?.full
    };

    // O_NOFOLLOW rejects a final-component symlink (ELOOP → Symlink, via classify_open_err);
    // O_NONBLOCK so the open never blocks; read(true) to read the directory's entries. We do
    // NOT pass O_DIRECTORY (see the doc comment) — the post-open fstat enforces "is a dir".
    // (For the root case `full` is the canonicalized real root — itself never a symlink — so
    // O_NOFOLLOW on it is correct and the dir it opens IS the trusted boundary.)
    let dir = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&full)
        .map_err(classify_open_err)?;

    // Post-open fstat: open(O_NOFOLLOW) succeeds on a regular file / FIFO as well, so require
    // the validated fd to actually be a directory (platform-stable, mirrors the read path).
    if !dir.metadata()?.is_dir() {
        return Err(FsError::NotADirectory);
    }

    // Hand the validated fd to fdopendir, which takes ownership of it; `closedir` (below)
    // closes that fd. We `into_raw_fd` so the `File`'s own Drop will NOT also close it.
    let fd = dir.into_raw_fd();
    // SAFETY: `fd` is a freshly-opened, owned directory fd. On success fdopendir adopts it.
    let dirp = unsafe { libc::fdopendir(fd) };
    if dirp.is_null() {
        let e = std::io::Error::last_os_error();
        // fdopendir did NOT adopt the fd on failure → we must close it ourselves.
        // SAFETY: `fd` is still our owned, open fd (fdopendir failed).
        unsafe {
            libc::close(fd);
        }
        return Err(FsError::from(e));
    }

    let mut entries: Vec<OsString> = Vec::new();
    // Read entries directly from the validated fd — no path re-resolution, so the
    // directory's identity cannot be swapped out from under us. A null return ends the
    // stream (errors during iteration are rare and also surface as a null terminator).
    loop {
        // SAFETY: `dirp` is the live DIR* from the successful fdopendir above.
        let ent = unsafe { libc::readdir(dirp) };
        if ent.is_null() {
            break;
        }
        // SAFETY: `ent` is a valid `*mut dirent` until the next readdir/closedir; its
        // `d_name` is a NUL-terminated C string embedded in that record.
        let name = unsafe { std::ffi::CStr::from_ptr((*ent).d_name.as_ptr()) };
        let bytes = name.to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        entries.push(std::ffi::OsStr::from_bytes(bytes).to_os_string());
    }
    // closedir closes the underlying fd we adopted via into_raw_fd → exactly one close,
    // no leak and no double-close.
    // SAFETY: `dirp` is the live DIR* and is not used after this call.
    unsafe {
        libc::closedir(dirp);
    }

    entries.sort();
    Ok(entries)
}

/// Metadata of a contained path (file OR directory), via a no-follow `lstat`.
///
/// The final component is `lstat`'d (no symlink follow): a final-component **symlink** is
/// rejected ([`FsError::Symlink`]) exactly as the read path's `O_NOFOLLOW` would — so this
/// never reports *through* a symlink and never escapes the root via one — and the parent is
/// realpath-ancestor-contained (shared [`resolve_within_root`]). Because the result IS the
/// single `lstat` we performed (not a re-resolution), there is no final-component TOCTOU:
/// the returned [`FileStat`] describes exactly the inode named. Unlike the read path this
/// does NOT open the file, so it can stat any kind (including FIFO/socket/device, reported
/// as [`FileKind::Other`]) without the open-side regular-file restriction.
pub fn stat_file_within_root(root: &Path, candidate: &str) -> Result<FileStat, FsError> {
    let resolved = resolve_within_root(root, candidate, /* parent_must_exist */ true)?;
    let meta = std::fs::symlink_metadata(&resolved.full).map_err(classify_open_err)?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        return Err(FsError::Symlink);
    }
    let kind = if ft.is_dir() {
        FileKind::Dir
    } else if ft.is_file() {
        FileKind::File
    } else {
        FileKind::Other
    };
    Ok(FileStat {
        kind,
        len: meta.len(),
        mode: meta.mode() & 0o777,
        readonly: meta.permissions().readonly(),
    })
}

/// Append `contents` to a contained file (creating it `0o600` if absent), with the full
/// read/write open hardening. Mirrors [`open_write_within_root`] but opens `O_APPEND` (every
/// write lands at the current end-of-file) and does NOT truncate.
///
/// # Atomicity (truth-labeled)
/// This is a **positional append, not an atomic replace** — the slice's "atomic temp+rename
/// where applicable" deliberately does NOT apply to append. A mid-append I/O failure can
/// leave a partial *tail* of `contents` appended, but can never corrupt or truncate the
/// file's pre-existing bytes (`O_APPEND` only ever extends). We intentionally do NOT
/// implement append as read+concat+temp-rename "atomic append": that would silently
/// normalize the file mode to `0o600` and break hardlinks on **every** append — a surprising
/// side effect for a primitive named "append" (and a whole-file rewrite per call).
///
/// Safety is identical to the write path: `O_NOFOLLOW` refuses a final-component symlink
/// (`ELOOP`), `O_NONBLOCK` avoids a FIFO hang, and [`verify_fd_identity`] rejects a
/// directory / non-regular fd / TOCTOU swap **before** any bytes are appended.
pub fn append_file_within_root(
    root: &Path,
    candidate: &str,
    contents: &[u8],
) -> Result<(), FsError> {
    use std::io::Write;
    let resolved = resolve_within_root(root, candidate, /* parent_must_exist */ true)?;
    let mut file = OpenOptions::new()
        .append(true) // O_APPEND (implies write); positional append, no truncate
        .create(true) // create-if-absent
        .mode(0o600) // owner-only on create (applied only with O_CREAT)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&resolved.full)
        .map_err(classify_open_err)?;
    // Reject a directory / non-regular fd / TOCTOU swap BEFORE appending any bytes.
    verify_fd_identity(&file, &resolved.full)?;
    file.write_all(contents)?;
    Ok(())
}

/// Delete a contained **regular file** (`unlink`), without following a final-component
/// symlink.
///
/// Pipeline: lexical gate + canonicalized-root + realpath-ancestor parent check (shared
/// [`resolve_within_root`]), then a no-follow `lstat` don't-clobber policy mirroring the
/// write path — a **symlink** target is refused ([`FsError::Symlink`]) (we never remove a
/// link the model named as a "file"), a **directory** is refused ([`FsError::IsDirectory`])
/// (this is a file primitive; there is no `rmdir` here), and any non-regular inode is refused
/// ([`FsError::NotRegularFile`]). A missing target is [`FsError::NotFound`].
///
/// The `lstat`→`unlink` TOCTOU is harmless: `unlink(2)` never follows a symlink, so even a
/// final-component swap to an outside-pointing symlink in the window would remove only the
/// *link*, never the outside target — there is no escape, only the don't-clobber policy.
pub fn delete_file_within_root(root: &Path, candidate: &str) -> Result<(), FsError> {
    let resolved = resolve_within_root(root, candidate, /* parent_must_exist */ true)?;
    let meta = std::fs::symlink_metadata(&resolved.full).map_err(classify_open_err)?;
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
    std::fs::remove_file(&resolved.full)?;
    Ok(())
}

/// Move/rename a contained **regular file** to another contained path via `rename(2)`
/// (atomic within a filesystem). BOTH endpoints are independently hardened.
///
/// - **Source**: shared [`resolve_within_root`] + a no-follow `lstat` requiring a regular
///   file — a symlink source is refused ([`FsError::Symlink`]), a directory
///   ([`FsError::IsDirectory`]), any non-regular inode ([`FsError::NotRegularFile`]), and a
///   missing source ([`FsError::NotFound`]).
/// - **Destination**: shared [`resolve_within_root`] (so its parent is realpath-ancestor-
///   contained) + a no-follow `lstat` don't-clobber — an existing **symlink** or
///   **directory** at the destination is refused (we never replace a link/dir); an existing
///   regular file IS replaced (the atomic same-name replace `rename` provides).
///
/// `rename(2)` follows no symlinks on either end (it operates on the names), is atomic, and
/// both parents are realpath-contained, so neither endpoint can escape the root. Residual: a
/// parent-*directory* swap between the realpath check and the rename is the same path-based
/// TOCTOU tracked for [`open_write_within_root`] (hardening = `renameat`/dir-fd-relative ops).
pub fn move_file_within_root(root: &Path, src: &str, dst: &str) -> Result<(), FsError> {
    let src_res = resolve_within_root(root, src, /* parent_must_exist */ true)?;
    let dst_res = resolve_within_root(root, dst, /* parent_must_exist */ true)?;

    // Source must be an existing regular file (no symlink / dir / special).
    let src_meta = std::fs::symlink_metadata(&src_res.full).map_err(classify_open_err)?;
    let sft = src_meta.file_type();
    if sft.is_symlink() {
        return Err(FsError::Symlink);
    }
    if sft.is_dir() {
        return Err(FsError::IsDirectory);
    }
    if !sft.is_file() {
        return Err(FsError::NotRegularFile);
    }

    // Don't-clobber a non-regular destination (symlink / dir); a regular file is replaced.
    match std::fs::symlink_metadata(&dst_res.full) {
        Ok(dmeta) => {
            let dft = dmeta.file_type();
            if dft.is_symlink() {
                return Err(FsError::Symlink);
            }
            if dft.is_dir() {
                return Err(FsError::IsDirectory);
            }
            if !dft.is_file() {
                return Err(FsError::NotRegularFile);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(classify_open_err(e)),
    }

    std::fs::rename(&src_res.full, &dst_res.full)?;
    Ok(())
}

/// Replace the **first** occurrence of `old_text` with `new_text` in a contained file, then
/// write the result back **atomically** (temp+rename via [`write_file_within_root`]).
///
/// Faithful to the TS oracle's `edit` tool (`content.replace(oldText, newText)` — first match
/// only). This is a thin composition: the read goes through [`open_read_within_root`] and the
/// write through [`write_file_within_root`], so it inherits ALL of their containment + atomicity
/// guarantees and adds no new open path of its own (no fresh attack surface).
///
/// # Errors
/// - The file must be valid UTF-8; a binary file surfaces as [`FsError::Io`] (`InvalidData`).
/// - If `old_text` is empty or not present, the file is left **byte-for-byte unchanged** and
///   [`FsError::EditNoMatch`] is returned — no write occurs.
/// - Containment / symlink / not-found failures surface from the underlying read or atomic
///   write exactly as for those primitives.
pub fn edit_file_within_root(
    root: &Path,
    candidate: &str,
    old_text: &str,
    new_text: &str,
) -> Result<(), FsError> {
    use std::io::Read;
    // Hardened read (lexical gate + O_NOFOLLOW + realpath-ancestor + fd-identity).
    let mut file = open_read_within_root(root, candidate)?;
    let mut content = String::new();
    // read_to_string returns ErrorKind::InvalidData for non-UTF-8 content → FsError::Io.
    file.read_to_string(&mut content).map_err(FsError::Io)?;

    // First-occurrence replace, faithful to the oracle. An empty `old_text` would otherwise
    // prepend at every position; treat it as a no-match for predictability.
    if old_text.is_empty() || !content.contains(old_text) {
        return Err(FsError::EditNoMatch);
    }
    let updated = content.replacen(old_text, new_text, 1);

    // Atomic replace (temp+rename): a mid-write failure leaves the original file intact.
    write_file_within_root(root, candidate, updated.as_bytes())
}

/// A single line that matched a [`search_within_root`] query.
///
/// `relative_path` is the path of the matching file **relative to the root**, with `/`
/// separators (never absolute, never containing `..` — it is built only from `readdir`
/// entry names under the contained root). `line_number` is 1-based. `line_text` is the
/// matching line with its terminator stripped, **truncated to at most
/// [`SEARCH_MAX_LINE_BYTES`] bytes on a UTF-8 char boundary** (so a single pathological
/// long line can never blow the output bound).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchHit {
    /// Path of the matching file, relative to the root (`/`-separated, no `..`/absolute).
    pub relative_path: String,
    /// 1-based line number of the match within the file.
    pub line_number: u64,
    /// The matching line (terminator stripped), truncated to [`SEARCH_MAX_LINE_BYTES`].
    pub line_text: String,
}

/// Hard cap on the total number of [`SearchHit`]s a single search returns. The walk stops
/// the instant this is reached, so output (and the `Vec` backing it) is bounded regardless
/// of how many lines match across the tree.
pub const SEARCH_MAX_HITS: usize = 200;
/// Hard cap on the byte length of each [`SearchHit::line_text`] (truncated on a char
/// boundary). Defends against a single multi-megabyte line.
pub const SEARCH_MAX_LINE_BYTES: usize = 512;
/// Hard cap on the number of files OPENED+scanned in a single search. Once reached the walk
/// stops, so a tree with millions of files cannot make the search unbounded.
pub const SEARCH_MAX_FILES: usize = 2_000;
/// Hard cap on the number of directories DESCENDED into in a single search. Bounds traversal
/// over a pathologically wide/deep tree.
pub const SEARCH_MAX_DIRS: usize = 4_096;
/// Hard cap on the bytes read from any ONE file (via `Read::take`, so it holds even if the
/// file grows after we stat it — no TOCTOU on the size). Bounds per-file memory; bytes past
/// this point are not scanned.
pub const SEARCH_MAX_FILE_BYTES: u64 = 1_048_576; // 1 MiB

/// READ-ONLY literal-substring search over the UTF-8 text files contained in `root`,
/// recursive from the root (or, when `subpath` is `Some`, from that contained sub-directory
/// or single file).
///
/// # Containment (no new attack surface)
/// Every on-disk access goes through the EXISTING hardened primitives — there is no fresh
/// `open`/`readdir` path here:
/// - directory listing via [`list_dir_within_root`] (lexical gate + `O_NOFOLLOW` +
///   realpath-ancestor; never lists *through* a symlink),
/// - per-entry classification via [`stat_file_within_root`] (no-follow `lstat`; a
///   final-component **symlink** is `Err(`[`FsError::Symlink`]`)`),
/// - file reads via [`open_read_within_root`] (`O_NOFOLLOW` + fd-identity TOCTOU check).
///
/// Candidate paths are built ONLY from `readdir` entry names joined under the contained
/// root, so each access is independently re-validated by `resolve_within_root`. We **stat
/// every entry before touching it** and SKIP anything that is not a real regular file or
/// real directory: a symlink (`Err(Symlink)`) is skipped — **we never follow it**, so a
/// symlink pointing outside the root is never read and never descended into; FIFOs/sockets/
/// devices ([`FileKind::Other`]) are skipped; and a non-UTF-8 entry name (which cannot form
/// a `&str` candidate) is skipped. We therefore only ever call `list_dir` on REAL
/// directories. The `subpath` argument itself is validated through the same pipeline, so an
/// absolute / `..` / out-of-root / symlink `subpath` is REJECTED (`Err`).
///
/// # Bounds (truth-labeled: what is and is NOT bounded)
/// Every accumulator and every read is hard-capped by a constant:
/// - **Output** — at most [`SEARCH_MAX_HITS`] hits in the returned `Vec`, each
///   [`SearchHit::line_text`] truncated to [`SEARCH_MAX_LINE_BYTES`] bytes on a char boundary.
/// - **Files opened** — at most [`SEARCH_MAX_FILES`] files are opened+scanned.
/// - **Per-file bytes** — at most [`SEARCH_MAX_FILE_BYTES`] bytes are read from any ONE file,
///   enforced by `Read::take` on the open fd (so the bound holds even if the file grows after
///   we stat it — no size TOCTOU); bytes past the cap are never read into memory.
/// - **Directories listed** — at most [`SEARCH_MAX_DIRS`] directories are popped+listed.
/// - **Pending worklist** — the iterative descent's `worklist` of pending directories is
///   capped: a directory is enqueued only while `dirs_enqueued < SEARCH_MAX_DIRS`, so
///   `worklist.len()` is O([`SEARCH_MAX_DIRS`]) at ALL times and its peak memory is a constant
///   × the max enqueued path length — it can NEVER accumulate the full cross-directory fanout
///   of the on-disk tree. This is **bounded descent**: search still visits up to
///   [`SEARCH_MAX_DIRS`] directories; directories beyond the budget are simply not enqueued.
///
/// The walk stops the moment the hit or file cap is hit.
///
/// **The ONE remaining (inherited) residual — a single directory's listing.** Each directory
/// is listed via the shared [`list_dir_within_root`] primitive, which materializes that one
/// directory's entry names into a `Vec` in full before this walk processes them (it is the
/// IDENTICAL allocation the `list_dir` tool itself makes — search adds no new listing path).
/// So peak memory for processing a single directory scales with THAT directory's entry count;
/// a single adversarial mega-directory (millions of entries) would make that one `Vec` large
/// even though everything else here is constant-bounded. This is a pre-existing property of
/// the shared listing primitive, NOT introduced by search, and is deliberately left to
/// `list_dir_within_root` rather than worked around here (changing the shared primitive is
/// riskier than documenting the inherited residual). Mitigation is operational, exactly as for
/// the hardlink residual above: host workspace roots should not contain adversarial
/// mega-directories.
///
/// # Text handling
/// Binary / non-UTF-8 files are skipped gracefully: a file containing a NUL byte is treated
/// as binary, and otherwise only the valid UTF-8 prefix is scanned (a multibyte char split
/// by the size cap is tolerated). An empty `query` matches nothing and returns `Ok(vec![])`
/// (an empty needle would otherwise match every line). Matching is a plain literal
/// substring (`str::contains`), case-sensitive.
///
/// Results are sorted by `(relative_path, line_number)` for a deterministic order.
pub fn search_within_root(
    root: &Path,
    query: &str,
    subpath: Option<&str>,
) -> Result<Vec<SearchHit>, FsError> {
    use std::os::unix::ffi::OsStrExt;

    let mut hits: Vec<SearchHit> = Vec::new();
    // An empty needle would match every line — nothing meaningful to search for, and a
    // guaranteed cap blow. Treat it as "no matches" (bounded, safe).
    if query.is_empty() {
        return Ok(hits);
    }

    let mut files_scanned: usize = 0;
    let mut dirs_visited: usize = 0;
    // Total directories EVER enqueued onto `worklist`. Every push is guarded by
    // `dirs_enqueued < SEARCH_MAX_DIRS`, so `worklist.len() <= dirs_enqueued <= SEARCH_MAX_DIRS`
    // holds at ALL times — the pending worklist can never accumulate the full cross-directory
    // fanout of the on-disk tree. Peak worklist memory is therefore bounded by a constant
    // (SEARCH_MAX_DIRS) × the max enqueued path length, not by the size of the tree. (Before
    // this cap the worklist was pushed to for every subdirectory child with no budget, so its
    // peak scaled with the tree.) This is BOUNDED DESCENT: search still visits up to
    // SEARCH_MAX_DIRS directories; deeper/wider directories beyond the budget are simply not
    // enqueued. A `push_dir` closure centralizes the guarded push so the invariant cannot drift.
    let mut dirs_enqueued: usize = 0;

    // Resolve the starting point. The root-denoting tokens start a full-tree walk; any other
    // `subpath` is validated through `stat_file_within_root` (so absolute/`..`/out-of-root/
    // symlink subpaths are rejected here) and may name either a directory (walk it) or a
    // single regular file (scan just it).
    let mut worklist: Vec<String> = Vec::new();
    // Guarded push: enqueue `d` only if the total-ever-enqueued budget is not exhausted, so
    // `worklist.len()` is O(SEARCH_MAX_DIRS) for the whole walk. Returns whether it enqueued
    // (callers ignore it — a dropped directory is just not descended into).
    let push_dir = |worklist: &mut Vec<String>, dirs_enqueued: &mut usize, d: String| {
        if *dirs_enqueued < SEARCH_MAX_DIRS {
            worklist.push(d);
            *dirs_enqueued += 1;
        }
    };
    match subpath {
        None => push_dir(&mut worklist, &mut dirs_enqueued, String::new()),
        Some(s) if s.is_empty() || s == "." || s == "./" => {
            push_dir(&mut worklist, &mut dirs_enqueued, String::new())
        }
        Some(s) => match stat_file_within_root(root, s)?.kind {
            FileKind::Dir => push_dir(&mut worklist, &mut dirs_enqueued, s.to_string()),
            FileKind::File => {
                files_scanned += 1;
                scan_file_into(root, s, query, &mut hits);
            }
            FileKind::Other => {}
        },
    }

    'walk: while let Some(dir) = worklist.pop() {
        // Now subsumed by the enqueue cap (`push_dir` enforces dirs_enqueued < SEARCH_MAX_DIRS,
        // and we can never pop more than we pushed) — kept as a defensive floor so the visit
        // count is bounded even if the enqueue invariant were ever weakened.
        if dirs_visited >= SEARCH_MAX_DIRS {
            break;
        }
        dirs_visited += 1;
        // A directory that races out from under us (removed / perms) is skipped, not fatal —
        // best-effort search. `dir == ""` lists the root itself (the contained root case).
        let entries = match list_dir_within_root(root, &dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for name_os in entries {
            // A non-UTF-8 entry name cannot form a `&str` candidate for the lexical gate;
            // skip it (the file is simply not searchable by this text tool).
            let name = match std::str::from_utf8(name_os.as_bytes()) {
                Ok(n) => n,
                Err(_) => continue,
            };
            let child = if dir.is_empty() {
                name.to_string()
            } else {
                format!("{dir}/{name}")
            };
            // Stat (no-follow) classifies the entry. A SYMLINK is `Err(Symlink)` → skipped:
            // we never follow it, so an outside-pointing link is never read or descended.
            match stat_file_within_root(root, &child) {
                Ok(st) => match st.kind {
                    // Guarded push: a child directory is enqueued only while the
                    // total-ever-enqueued budget (SEARCH_MAX_DIRS) is not exhausted, so the
                    // pending worklist stays O(SEARCH_MAX_DIRS). Beyond the budget the child
                    // is simply not descended into (bounded descent).
                    FileKind::Dir => push_dir(&mut worklist, &mut dirs_enqueued, child),
                    FileKind::File => {
                        if files_scanned >= SEARCH_MAX_FILES {
                            break 'walk;
                        }
                        files_scanned += 1;
                        scan_file_into(root, &child, query, &mut hits);
                        if hits.len() >= SEARCH_MAX_HITS {
                            break 'walk;
                        }
                    }
                    FileKind::Other => {}
                },
                Err(_) => continue,
            }
        }
    }

    hits.sort_by(|a, b| {
        (a.relative_path.as_str(), a.line_number).cmp(&(b.relative_path.as_str(), b.line_number))
    });
    hits.truncate(SEARCH_MAX_HITS);
    Ok(hits)
}

/// Scan ONE contained regular file (named by `rel`, relative to `root`) for literal
/// `query`, appending up to the global [`SEARCH_MAX_HITS`] cap into `hits`. The read goes
/// through [`open_read_within_root`] (full hardening) and is byte-capped via `Read::take`,
/// so this opens no new path and bounds per-file memory. Any read/containment error (e.g. a
/// TOCTOU swap detected by the hardened open) skips the file silently — best-effort, never
/// fatal to the overall search.
fn scan_file_into(root: &Path, rel: &str, query: &str, hits: &mut Vec<SearchHit>) {
    use std::io::Read;
    let file = match open_read_within_root(root, rel) {
        Ok(f) => f,
        Err(_) => return,
    };
    let mut bytes: Vec<u8> = Vec::new();
    // HARD per-file byte cap via take — holds even if the file grew after we stat'd it.
    if file
        .take(SEARCH_MAX_FILE_BYTES)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return;
    }
    // Binary heuristic: a NUL byte ⇒ treat as binary and skip (same screen git uses).
    if bytes.contains(&0) {
        return;
    }
    // Decode UTF-8; if the size cap split a trailing multibyte char, scan the valid prefix.
    let text = match std::str::from_utf8(&bytes) {
        Ok(s) => s,
        Err(e) => match std::str::from_utf8(&bytes[..e.valid_up_to()]) {
            Ok(s) => s,
            Err(_) => return,
        },
    };
    for (idx, line) in text.lines().enumerate() {
        if hits.len() >= SEARCH_MAX_HITS {
            return;
        }
        if line.contains(query) {
            hits.push(SearchHit {
                relative_path: rel.to_string(),
                line_number: (idx as u64) + 1,
                line_text: truncate_to_char_boundary(line, SEARCH_MAX_LINE_BYTES),
            });
        }
    }
}

// ── run_command: hardened shell-FREE process exec, contained to `root` ──────────────────────
//
// THREAT MODEL & SECURITY MODEL (this is the highest-risk tool surface — read before editing).
// `run_command` is the ONLY primitive here that spawns an external process. It rides the
// EXISTING gate/approval seam (registered `mutating=true, Risk::High`; a command with shell
// metacharacters is already classified Critical → gate DENY; the exact command is bound into
// the Ed25519 action_digest), so this helper is only ever reached AFTER an operator signed the
// exact command. On top of that single-use approval, the helper enforces a hard, defense-in-
// depth model so that even a slipped-through or operator-mis-signed command is contained:
//
//   1. NO SHELL. We never invoke `sh -c`. The command string is tokenized by a minimal,
//      quote-aware splitter (single + double quotes for args-with-spaces) into argv, and
//      argv[0] is exec'd DIRECTLY. There is NO shell expansion, NO globbing, NO env/`$VAR`
//      substitution, NO pipe/redirect/`;|&` handling. A metacharacter that slips past the gate
//      is therefore an inert LITERAL argument, never interpreted. `$HOME` is the 5 bytes
//      `$HOME`, not the home directory.
//   2. ENV SCRUB (prevents provider-key exfiltration). `env_clear()` then set ONLY a minimal,
//      fixed allow-list: `PATH` to a constant safe value, plus `LANG=C`/`LC_ALL=C` for
//      deterministic output. The child does NOT inherit the hub process environment, so a
//      command cannot read `FRIDAY_DEEPSEEK_API_KEY` or any other secret out of `env`. (With no
//      shell, `$FRIDAY...` is a literal anyway — env_clear is mandatory defense-in-depth.)
//   3. CWD CONTAINMENT. `current_dir(root)` is set per-child (we never mutate the hub's global
//      cwd via `set_current_dir`). The root is canonicalized/validated to exist first.
//   4. TIMEOUT + KILL. A wall-clock deadline ([`RUN_COMMAND_TIMEOUT`]); on expiry the child is
//      SIGKILL'd (and its process group) so a `sleep`/hang cannot pin a hub thread. The
//      capture is DEADLOCK-FREE: dedicated reader threads drain stdout+stderr (a child whose
//      output exceeds the OS pipe buffer can never block on write), capping the RETAINED bytes
//      while still consuming the rest. The child is `setpgid`'d into its OWN process group, and the
//      group is SIGKILL'd on EVERY return path (not only on timeout) so any IN-GROUP descendant is
//      reaped, its write-fd closes, and the pipe EOFs. Critically, the reader drain is itself
//      DEADLINE-BOUNDED (timeout + a small grace, [`RUN_COMMAND_DRAIN_GRACE`]) and does NOT rely on
//      EOF: a grandchild that `setsid()`-ESCAPES the process group cannot be reached by the killpg,
//      but it ALSO cannot pin the hub, because the readers self-terminate at the deadline whether or
//      not the pipe ever EOFs. So the call ALWAYS returns within ~timeout + grace. The escaped
//      grandchild is an orphan daemon (inherent to an operator-signed daemon-launching command — the
//      gate signed a command that double-forks/`setsid`; signing a daemon yields a daemon), NOT a
//      hub-thread hang. (See the inline note for the residual sub-ms pgid-reuse window — accepted
//      over an unbounded hang, the same trade `std::process::Command::output()` makes.)
//   5. OUTPUT BOUND. Combined stdout+stderr is capped at [`RUN_COMMAND_MAX_OUTPUT_BYTES`]
//      RETAINED bytes (truncated on a char boundary; `output_truncated` set). The model-facing
//      feedback path bounds this further to 2048 bytes downstream.
//   6. FAIL CLOSED. Tokenize failure → [`FsError::CommandInvalid`]; spawn failure →
//      [`FsError::CommandSpawn`]. Both messages are STATIC (no path/command/secret/errno).
//      A successful spawn ALWAYS returns `Ok(CommandRunResult)` — including a non-zero exit and
//      a timeout (those are RESULTS, not errors).

/// Wall-clock timeout for [`run_command_in_root`]. A child still running past this is killed
/// (SIGKILL to its process group) and the result reports `timed_out=true`. 30s is generous for
/// a single dev command yet bounds a hang to a fixed window.
pub const RUN_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Hard cap on the COMBINED (stdout + stderr) bytes RETAINED from a command. Bytes past this are
/// read-and-discarded (so the child never blocks) but not stored; `output_truncated` is set.
/// 64 KiB — comfortably above the model-facing 2048-byte feedback bound, so the operator/audit
/// path sees a useful head without the helper itself buffering unboundedly.
pub const RUN_COMMAND_MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// Extra grace added to `timeout` to form the OVERALL output-drain deadline. After the leader (and
/// its in-group descendants) exit, any buffered in-group output still has this long to flush/EOF
/// before the reader threads are cut loose. It also caps the worst-case extra time a
/// process-group-ESCAPING (`setsid`) grandchild holding the pipe write-fd open can keep the readers
/// draining: the call returns within `timeout + RUN_COMMAND_DRAIN_GRACE`, never the grandchild's
/// lifetime. Small (2s) — enough to flush real output, short enough that the hub thread is never
/// pinned.
pub const RUN_COMMAND_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// Fixed, safe `PATH` for the env-scrubbed child. The hub process `PATH` is NOT inherited; only
/// these standard system dirs are searched for argv[0]. This is load-bearing: after `env_clear()`
/// a child with no `PATH` cannot resolve a bare program name like `echo`.
pub const RUN_COMMAND_CHILD_PATH: &str = "/usr/bin:/bin:/usr/local/bin";

/// macOS Seatbelt entrypoint used by the opt-in sandboxed command runner.
pub const DARWIN_SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The result of a successfully-SPAWNED command (a tokenize/spawn FAILURE is an `Err`, never
/// this). `exit_code` is `None` when the child was killed by a signal (incl. our timeout kill)
/// or otherwise has no normal exit code. `output` is the combined, byte-capped, char-boundary-
/// safe stdout+stderr. `output_truncated` ⇒ the retained output is INCOMPLETE — either more output
/// existed than the byte cap retained, OR the output-drain deadline ([`RUN_COMMAND_DRAIN_GRACE`])
/// cut reading short before EOF (e.g. a process-group-escaping grandchild held the pipe open).
/// `timed_out` ⇒ the child exceeded [`RUN_COMMAND_TIMEOUT`] and was killed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandRunResult {
    /// Process exit code, or `None` if terminated by a signal (incl. the timeout kill).
    pub exit_code: Option<i32>,
    /// Combined stdout+stderr, byte-capped to [`RUN_COMMAND_MAX_OUTPUT_BYTES`] (char-safe).
    pub output: String,
    /// Whether the retained output is INCOMPLETE: output beyond the byte cap was discarded, OR the
    /// drain deadline cut reading short before EOF (see [`RUN_COMMAND_DRAIN_GRACE`]).
    pub output_truncated: bool,
    /// Whether the child was killed for exceeding the timeout.
    pub timed_out: bool,
}

/// Minimal, quote-aware tokenizer: split `command` into argv. Handles single (`'…'`) and double
/// (`"…"`) quotes so arguments-with-spaces survive; performs NO shell expansion, NO globbing, NO
/// `$VAR` substitution, NO escape processing beyond what quotes delimit. A backslash is an
/// ORDINARY character (it is NOT an escape) — keeping the tokenizer's behavior trivially
/// auditable and refusing to grant the command any shell-like power. Returns the argv on success;
/// `Err(())` on an UNBALANCED quote. An empty/whitespace-only command yields an EMPTY argv (the
/// caller rejects that as [`FsError::CommandInvalid`]). Quote chars delimit but are not retained;
/// adjacent quoted/unquoted runs concatenate into one token (`a"b"c` → `abc`).
fn tokenize_command(command: &str) -> Result<Vec<String>, ()> {
    let mut argv: Vec<String> = Vec::new();
    let mut cur = String::new();
    // `in_token` distinguishes an empty quoted token (`""` → one empty arg) from no token at all.
    let mut in_token = false;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            // Unquoted whitespace ends the current token (if any) and is not retained.
            ' ' | '\t' | '\n' | '\r' => {
                if in_token {
                    argv.push(std::mem::take(&mut cur));
                    in_token = false;
                }
            }
            '\'' | '"' => {
                let quote = c;
                in_token = true; // even `''`/`""` produces an (empty) token
                loop {
                    match chars.next() {
                        Some(ch) if ch == quote => break, // closing quote
                        Some(ch) => cur.push(ch),         // literal inside the quote (incl. spaces)
                        None => return Err(()),           // unbalanced quote → reject
                    }
                }
            }
            other => {
                in_token = true;
                cur.push(other);
            }
        }
    }
    if in_token {
        argv.push(cur);
    }
    Ok(argv)
}

/// Run `command` as a SHELL-FREE, env-scrubbed, cwd-contained, timed, output-bounded child
/// process under `root`. See the module-level security model above. Uses the default
/// [`RUN_COMMAND_TIMEOUT`]; [`run_command_in_root_with_timeout`] takes an explicit timeout (tests
/// use a short one). The `root` must exist (canonicalized) or this is [`FsError::NotFound`].
pub fn run_command_in_root(root: &Path, command: &str) -> Result<CommandRunResult, FsError> {
    run_command_in_root_with_timeout(root, command, RUN_COMMAND_TIMEOUT)
}

/// [`run_command_in_root`] with an explicit `timeout` (the only difference). Exposed so tests can
/// drive the TIMEOUT branch deterministically with a sub-second deadline rather than waiting the
/// production 30s. The security model is otherwise identical.
pub fn run_command_in_root_with_timeout(
    root: &Path,
    command: &str,
    timeout: std::time::Duration,
) -> Result<CommandRunResult, FsError> {
    run_command_in_root_inner(root, command, timeout, CommandSandbox::None)
}

/// Whether the local host can provide the opt-in Darwin Seatbelt sandbox substrate.
pub fn darwin_sandbox_exec_available() -> bool {
    cfg!(target_os = "macos") && Path::new(DARWIN_SANDBOX_EXEC).is_file()
}

/// [`run_command_in_root`] with a required macOS Seatbelt sandbox around the child process.
///
/// This is intentionally a separate opt-in surface: existing callers keep their byte-for-byte
/// runner behavior, while callers that require OS sandboxing get fail-closed behavior if
/// `sandbox-exec` is unavailable. The sandbox permits file writes only under `root` and denies
/// outbound networking.
pub fn run_command_in_root_with_darwin_sandbox_timeout(
    root: &Path,
    command: &str,
    timeout: std::time::Duration,
) -> Result<CommandRunResult, FsError> {
    run_command_in_root_inner(root, command, timeout, CommandSandbox::DarwinSeatbelt)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CommandSandbox {
    None,
    DarwinSeatbelt,
}

fn run_command_in_root_inner(
    root: &Path,
    command: &str,
    timeout: std::time::Duration,
    sandbox: CommandSandbox,
) -> Result<CommandRunResult, FsError> {
    use std::os::unix::process::CommandExt as _;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};

    // (1) Tokenize — NO shell. Empty/whitespace-only or unbalanced-quote → fail closed.
    let argv = tokenize_command(command).map_err(|()| FsError::CommandInvalid)?;
    if argv.is_empty() {
        return Err(FsError::CommandInvalid);
    }
    let program = &argv[0];
    let args = &argv[1..];

    // (3) CWD containment — the root must exist; canonicalize so a symlinked root (e.g.
    //     /tmp → /private/tmp) is the real dir, and so a non-existent root is a clean NotFound.
    let real_root = std::fs::canonicalize(root).map_err(classify_open_err)?;

    let sandboxed_args;
    let (spawn_program, spawn_args): (&str, &[String]) = match sandbox {
        CommandSandbox::None => (program, args),
        CommandSandbox::DarwinSeatbelt => {
            if !darwin_sandbox_exec_available() {
                return Err(FsError::CommandSandboxUnavailable);
            }
            sandboxed_args = darwin_sandbox_exec_args(&real_root, program, args);
            (DARWIN_SANDBOX_EXEC, sandboxed_args.as_slice())
        }
    };

    let mut cmd = Command::new(spawn_program);
    cmd.args(spawn_args)
        .current_dir(&real_root) // per-child cwd; never set_current_dir (global)
        .stdin(Stdio::null()) // no inherited stdin; a reader can't block on a tty
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // (2) ENV SCRUB — clear EVERYTHING, then set only the fixed safe allow-list. The child
    //     cannot read the hub's FRIDAY_DEEPSEEK_API_KEY (or any inherited secret) from `env`.
    cmd.env_clear()
        .env("PATH", RUN_COMMAND_CHILD_PATH)
        .env("LANG", "C")
        .env("LC_ALL", "C");

    // (4) Put the child in its OWN process group so the timeout kill reaches any grandchildren it
    //     spawned (killpg), not just argv[0]. setpgid(0,0) in the child is async-signal-safe and
    //     touches only the child — the single documented `unsafe` here.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    // (6) Spawn — on failure DROP the io::Error (it can carry the program name/errno) → static.
    let mut child = cmd.spawn().map_err(|_| FsError::CommandSpawn)?;
    let pid = child.id() as libc::pid_t;

    // (4/5) DEADLINE-BOUNDED, DEADLOCK-FREE bounded capture. Each pipe is drained by its own thread
    //       so a child emitting more than the OS pipe buffer can NEVER block on write (which would
    //       otherwise masquerade as a timeout). The shared buffer retains at most
    //       RUN_COMMAND_MAX_OUTPUT_BYTES COMBINED across both streams; bytes past the cap are
    //       read-and-discarded. `truncated` records that more existed.
    //
    //       Crucially, the drain is bounded by an ABSOLUTE wall-clock deadline (timeout + a small
    //       grace) rather than by waiting for EOF. EOF normally arrives first — when the leader and
    //       its in-group descendants exit (or we SIGKILL the group) every copy of the write-fd
    //       closes, the pipe EOFs, and the reader returns at once. But a grandchild that called
    //       `setsid()`/`setpgid()` has ESCAPED the leader's process group: our killpg can NOT reach
    //       it, so if it inherited and keeps the write-fd open the pipe NEVER EOFs. Without a
    //       deadline the reader's blocking `read()` would hang forever and the `r.join()` below
    //       would PIN the calling hub thread (the recv_timeout only ever guarded the LEADER, which
    //       has already exited). So each reader self-terminates at `drain_deadline`: it sets its fd
    //       non-blocking and `poll()`s against the REMAINING budget, stopping (and marking the
    //       output truncated) when the deadline passes. The threads therefore exit on their own and
    //       the unchanged join loop below is naturally bounded — NO unbounded block, NO thread leak.
    let shared: Arc<Mutex<(Vec<u8>, bool)>> =
        Arc::new(Mutex::new((Vec::with_capacity(4096), false)));

    // Absolute deadline for the WHOLE drain: the command's own timeout plus a small grace so that,
    // once the leader exits, any IN-GROUP buffered output still has a moment to flush/EOF before we
    // cut the readers loose. A process-group-escaping grandchild holding the pipe open is bounded by
    // this same deadline (it can never push past it), which is the whole point.
    let drain_deadline = std::time::Instant::now() + timeout + RUN_COMMAND_DRAIN_GRACE;

    // Drain `r` into `shared` until EOF or `deadline`, whichever comes first. The fd is set
    // non-blocking and we `poll()` against the remaining budget so a never-EOF pipe (an escaped
    // grandchild holding the write-fd) can NOT pin this thread: at the deadline we mark the output
    // truncated and return, leaving the thread promptly joinable. `R: Read + AsRawFd` so we can
    // reach the underlying fd for fcntl/poll while still using the buffered `read()` path.
    fn drain_into<R: std::io::Read + std::os::unix::io::AsRawFd>(
        mut r: R,
        shared: Arc<Mutex<(Vec<u8>, bool)>>,
        deadline: std::time::Instant,
    ) {
        let fd = r.as_raw_fd();
        // Set the read end non-blocking (a separate open-file-description from the child's write
        // end, so the child's I/O semantics are unchanged). If fcntl fails we bail rather than risk
        // an unbounded blocking read.
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                return;
            }
        }
        let mut chunk = [0u8; 8192];
        loop {
            // Remaining budget; once it hits zero the deadline has passed → stop and mark truncated.
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                shared.lock().unwrap().1 = true; // deadline cut the drain short → output truncated
                return;
            }
            let mut pfd = libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            };
            // Clamp to i32 milliseconds (>=1 so we never busy-spin); the loop re-checks the real
            // deadline above, so a clamp shorter than `remaining` only costs an extra poll.
            let timeout_ms = remaining.as_millis().clamp(1, i32::MAX as u128) as libc::c_int;
            let pr = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
            if pr < 0 {
                let e = std::io::Error::last_os_error();
                if e.kind() == std::io::ErrorKind::Interrupted {
                    continue; // EINTR — re-poll against the (re-checked) deadline
                }
                return; // poll itself failed — stop draining this stream (do not block)
            }
            if pr == 0 {
                continue; // poll timed out; loop re-checks the deadline and returns if reached
            }
            // Readable OR hung-up (POLLHUP). Attempt the read UNCONDITIONALLY — gating on POLLIN
            // would `continue` on a POLLHUP and busy-spin, since poll re-reports POLLHUP instantly.
            match r.read(&mut chunk) {
                Ok(0) => return, // EOF — child (and any in-group descendant) closed this fd
                Ok(n) => {
                    let mut guard = shared.lock().unwrap();
                    let (buf, truncated) = &mut *guard;
                    let remaining = RUN_COMMAND_MAX_OUTPUT_BYTES.saturating_sub(buf.len());
                    if remaining == 0 {
                        *truncated = true; // already full — keep reading to EOF, discard
                    } else if n > remaining {
                        buf.extend_from_slice(&chunk[..remaining]);
                        *truncated = true;
                    } else {
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    // drop guard, keep reading so the child never blocks on a full pipe
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue, // EINTR
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => continue, // EAGAIN → re-poll
                Err(_) => return, // pipe broke (child died) — done draining this stream
            }
        }
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut readers = Vec::new();
    if let Some(out) = stdout {
        let s = Arc::clone(&shared);
        readers.push(std::thread::spawn(move || {
            drain_into(out, s, drain_deadline)
        }));
    }
    if let Some(err) = stderr {
        let s = Arc::clone(&shared);
        readers.push(std::thread::spawn(move || {
            drain_into(err, s, drain_deadline)
        }));
    }

    // Waiter thread: block on wait() and report the status over a channel so the main thread can
    // impose the deadline with recv_timeout.
    let (tx, rx) = mpsc::channel::<std::io::Result<std::process::ExitStatus>>();
    std::thread::spawn(move || {
        let status = child.wait();
        let _ = tx.send(status);
    });

    let (exit_code, timed_out) = match rx.recv_timeout(timeout) {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(_)) => (None, false), // wait() itself failed — treat as no code, not a hang
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // (4) KILL the whole process group (negative pid → killpg semantics), then reap so
            //     the waiter thread's wait() returns and the pipes EOF (readers can join).
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
                libc::kill(pid, libc::SIGKILL); // belt-and-suspenders if setpgid raced
            }
            let _ = rx.recv(); // reap the (now-killed) child
            (None, true)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => (None, false),
    };

    // (4) SIGKILL the whole process group on EVERY path, not just the timeout path. The leader is
    //     now reaped (normal exit, or our kill), but it may have spawned descendants. Any descendant
    //     that is STILL IN the leader's process group is reached by this killpg: it dies, its copies
    //     of the stdout/stderr write-fd close, the pipe EOFs, and the corresponding reader returns
    //     at once. This is why we setpgid'd the child into its OWN group — the killpg here cannot
    //     touch the hub or any unrelated process.
    //
    //     HONEST RESIDUAL — escaped grandchildren are NOT reaped, and that is INHERENT. A grandchild
    //     that called `setsid()`/`setpgid(0,0)` has left the leader's process group, so this killpg
    //     can NEVER reach it; if it inherited and keeps the pipe write-fd open, the pipe never EOFs.
    //     We do NOT hunt it down: this surface only runs an operator-signed, single-use command, and
    //     an operator who signs a command that DAEMONIZES (the standard double-fork/`setsid` that
    //     retains stdout) gets a daemon — that orphan is the approved behavior of the approved
    //     command, not a containment failure. What this code MUST guarantee is that such an escapee
    //     can NOT pin the hub: the reader threads are DEADLINE-BOUNDED (see `drain_into` above), so
    //     they self-terminate at `drain_deadline` (= timeout + grace) regardless of an escaped writer
    //     holding the pipe open. The `r.join()` below is therefore bounded on every path WITHOUT
    //     depending on this killpg producing an EOF, and the call returns within ~timeout + grace.
    //     RESIDUAL (pgid reuse): on the normal-exit path the leader was already reaped, so in the
    //     vanishingly small window where the OS recycled its freed pgid onto an unrelated new group,
    //     this killpg could signal that group. Sub-millisecond, accepted, ESRCH ignored — the same
    //     trade `std::process::Command::output()` makes.
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }

    // The reader threads either already returned (the child's/in-group fds EOF'd, or the pipe
    // broke) or will self-terminate at `drain_deadline` if an escaped grandchild is holding the
    // write-fd open. Either way each thread exits ON ITS OWN, so these joins are bounded on every
    // path — they do NOT depend on the killpg above forcing an EOF.
    for r in readers {
        let _ = r.join();
    }

    let (bytes, truncated) = {
        let guard = shared.lock().unwrap();
        guard.clone()
    };
    // Lossy UTF-8 (command output need not be valid UTF-8), then char-boundary truncate as a
    // belt to the byte cap (the cap above is enforced on raw bytes; this keeps the String valid).
    let output = truncate_to_char_boundary(
        &String::from_utf8_lossy(&bytes),
        RUN_COMMAND_MAX_OUTPUT_BYTES,
    );

    Ok(CommandRunResult {
        exit_code,
        output,
        output_truncated: truncated,
        timed_out,
    })
}

fn darwin_sandbox_exec_args(root: &Path, program: &str, args: &[String]) -> Vec<String> {
    let mut wrapped = vec![
        "-p".to_string(),
        darwin_sandbox_profile(root),
        "--".to_string(),
        program.to_string(),
    ];
    wrapped.extend(args.iter().cloned());
    wrapped
}

fn darwin_sandbox_profile(root: &Path) -> String {
    format!(
        "(version 1)\n\
         (allow default)\n\
         (deny network*)\n\
         (deny file-write* (require-not (subpath {})))\n",
        darwin_sandbox_profile_string(root)
    )
}

fn darwin_sandbox_profile_string(path: &Path) -> String {
    let mut out = String::from("\"");
    for ch in path.to_string_lossy().chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// Truncate `s` to at most `max` bytes, backing up to the nearest UTF-8 char boundary so the
/// result is always valid UTF-8 (never splits a multibyte char).
fn truncate_to_char_boundary(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
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
    fn write_file_within_root_refuses_readonly_target_leaving_content_and_mode_intact() {
        // Parity with the open path / oracle: a read-only (non-owner-writable) regular
        // target is refused with EACCES — temp+rename does NOT silently overwrite it (nor
        // reset its mode). This is also the genuine "a regular file survives a refused
        // write" case: the original content + mode are untouched (the target is mutated
        // ONLY by the final rename, which never happens here).
        use std::os::unix::fs::PermissionsExt;
        let root = TempDir::new();
        let path = root.path().join("ro.txt");
        write_file(&path, "ORIGINAL-INTACT");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();

        let err = write_file_within_root(root.path(), "ro.txt", b"OVERWRITE").unwrap_err();
        assert!(
            matches!(&err, FsError::Io(e) if e.raw_os_error() == Some(libc::EACCES)),
            "a read-only target must be refused EACCES, got {err:?}"
        );
        // Content fully intact (never truncated/partial) and mode NOT reset to 0o600.
        assert_eq!(read_file(&path), "ORIGINAL-INTACT");
        assert_eq!(
            std::fs::metadata(&path).unwrap().mode() & 0o777,
            0o444,
            "the refused write must not have replaced the file (mode preserved)"
        );
        assert_eq!(temp_leftovers(root.path()), 0);

        // Make it writable → the write now succeeds and fully replaces.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_file_within_root(root.path(), "ro.txt", b"NEW").unwrap();
        assert_eq!(read_file(&path), "NEW");
    }

    // ── run_command: shell-free hardened exec ───────────────────────────────────────────────

    /// The quote-aware tokenizer (NO shell): quotes delimit args-with-spaces, no expansion, no
    /// backslash-escape, adjacent runs concatenate, unbalanced quotes are rejected.
    #[test]
    fn tokenize_command_is_minimal_and_quote_aware() {
        assert_eq!(
            tokenize_command("echo hello").unwrap(),
            vec!["echo", "hello"]
        );
        // single + double quotes keep spaces inside one arg
        assert_eq!(
            tokenize_command("echo 'a b' \"c d\"").unwrap(),
            vec!["echo", "a b", "c d"]
        );
        // adjacent quoted/unquoted runs concatenate; empty quotes ⇒ an empty arg
        assert_eq!(tokenize_command("a\"b\"c").unwrap(), vec!["abc"]);
        assert_eq!(tokenize_command("x '' y").unwrap(), vec!["x", "", "y"]);
        // metachars are LITERAL (no shell): `$HOME`, `|`, `;` are ordinary chars in args
        assert_eq!(
            tokenize_command("echo $HOME | rm ; ls").unwrap(),
            vec!["echo", "$HOME", "|", "rm", ";", "ls"]
        );
        // whitespace-only ⇒ empty argv (caller maps to CommandInvalid)
        assert!(tokenize_command("   ").unwrap().is_empty());
        // unbalanced quote ⇒ Err
        assert!(tokenize_command("echo 'unterminated").is_err());
        assert!(tokenize_command("echo \"unterminated").is_err());
    }

    /// Empty / whitespace-only / unbalanced-quote commands fail closed with the STATIC-message
    /// CommandInvalid (no command text in the error).
    #[test]
    fn run_command_rejects_unparseable_fail_closed() {
        let root = TempDir::new();
        assert!(matches!(
            run_command_in_root(root.path(), "").unwrap_err(),
            FsError::CommandInvalid
        ));
        assert!(matches!(
            run_command_in_root(root.path(), "   ").unwrap_err(),
            FsError::CommandInvalid
        ));
        assert!(matches!(
            run_command_in_root(root.path(), "echo 'oops").unwrap_err(),
            FsError::CommandInvalid
        ));
        // Static message: the error Display must not echo the command string.
        let msg = run_command_in_root(root.path(), "echo 'oops")
            .unwrap_err()
            .to_string();
        assert!(
            !msg.contains("oops"),
            "error must not leak command text: {msg}"
        );
    }

    /// A program not on the fixed child PATH cannot be spawned → static-message CommandSpawn.
    #[test]
    fn run_command_unknown_program_fails_closed() {
        let root = TempDir::new();
        let err =
            run_command_in_root(root.path(), "definitely_not_a_real_program_xyz").unwrap_err();
        assert!(matches!(err, FsError::CommandSpawn), "got {err:?}");
        assert!(
            !err.to_string()
                .contains("definitely_not_a_real_program_xyz"),
            "spawn error must not leak the program name"
        );
    }

    /// Simple command: echo hello → exit 0, output contains "hello", not truncated/timed-out.
    /// Also proves the env-scrubbed child can still resolve a bare program via the fixed PATH.
    #[test]
    fn run_command_simple_echo() {
        let root = TempDir::new();
        let r = run_command_in_root(root.path(), "echo hello").unwrap();
        assert_eq!(r.exit_code, Some(0));
        assert!(r.output.contains("hello"), "output was {:?}", r.output);
        assert!(!r.output_truncated);
        assert!(!r.timed_out);
    }

    /// CWD containment: the child runs with cwd == root, so `ls` sees ONLY root's contents (and
    /// nothing from the parent / outside).
    #[test]
    fn run_command_cwd_is_root() {
        let root = TempDir::new();
        write_file(&root.path().join("inside.txt"), "x");
        // A sibling file OUTSIDE root that ls(root) must never see.
        let outside = TempDir::new();
        write_file(&outside.path().join("outside.txt"), "y");

        let r = run_command_in_root(root.path(), "ls").unwrap();
        assert_eq!(r.exit_code, Some(0));
        assert!(
            r.output.contains("inside.txt"),
            "ls(cwd=root) must list root: {:?}",
            r.output
        );
        assert!(
            !r.output.contains("outside.txt"),
            "ls must not see files outside root (cwd containment): {:?}",
            r.output
        );
    }

    /// ENV SCRUB: a sentinel secret is set in THE CHILD'S would-be inherited env only if env_clear
    /// failed. We prove env_clear by running `env` and asserting the child env is EXACTLY the
    /// fixed allow-list — no inherited HOME, no sentinel, PATH == the fixed value. (We avoid
    /// mutating the process-global env; instead we assert the child env is the allow-list, which
    /// is a STRONGER proof than "the one sentinel is absent".)
    #[test]
    fn run_command_env_is_scrubbed_to_allowlist() {
        let root = TempDir::new();
        let r = run_command_in_root(root.path(), "env").unwrap();
        assert_eq!(r.exit_code, Some(0));
        let lines: Vec<&str> = r.output.lines().filter(|l| !l.is_empty()).collect();
        // PATH is the fixed allow-list; LANG/LC_ALL are C; nothing else leaks in.
        assert!(
            r.output.contains(&format!("PATH={RUN_COMMAND_CHILD_PATH}")),
            "child PATH must be the fixed allow-list: {:?}",
            r.output
        );
        assert!(r.output.contains("LANG=C"), "env was {:?}", r.output);
        // No inherited hub env: HOME / any FRIDAY_* secret must be ABSENT.
        assert!(
            !r.output.contains("HOME="),
            "child must not inherit HOME: {:?}",
            r.output
        );
        assert!(
            !r.output.contains("FRIDAY_"),
            "child must not inherit any FRIDAY_* secret: {:?}",
            r.output
        );
        // The child env is EXACTLY {PATH, LANG, LC_ALL} — nothing else (defense-in-depth proof).
        let keys: std::collections::BTreeSet<&str> =
            lines.iter().filter_map(|l| l.split('=').next()).collect();
        assert_eq!(
            keys,
            ["LANG", "LC_ALL", "PATH"].into_iter().collect(),
            "child env must be exactly the fixed allow-list, got {keys:?}"
        );
    }

    /// NO-SHELL: `echo $HOME` prints the LITERAL `$HOME` (no expansion) because there is no shell
    /// and no env-var substitution. (Doubly so: HOME is not even in the scrubbed child env.)
    #[test]
    fn run_command_no_shell_expansion() {
        let root = TempDir::new();
        let r = run_command_in_root(root.path(), "echo $HOME").unwrap();
        assert_eq!(r.exit_code, Some(0));
        assert_eq!(r.output.trim_end(), "$HOME", "no shell expansion expected");
    }

    #[test]
    fn darwin_sandbox_profile_quotes_path_literals() {
        let path = PathBuf::from("/tmp/friday \"quoted\" path\\tail");
        let quoted = darwin_sandbox_profile_string(&path);
        assert_eq!(quoted, "\"/tmp/friday \\\"quoted\\\" path\\\\tail\"");

        let profile = darwin_sandbox_profile(&path);
        assert!(profile.contains("(deny network*)"));
        assert!(profile.contains("(deny file-write* (require-not (subpath "));
        assert!(profile.contains(&quoted));
    }

    #[test]
    fn darwin_sandbox_required_fails_closed_when_unavailable() {
        if darwin_sandbox_exec_available() {
            return;
        }
        let root = TempDir::new();
        let err = run_command_in_root_with_darwin_sandbox_timeout(
            root.path(),
            "echo hi",
            std::time::Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(
            matches!(err, FsError::CommandSandboxUnavailable),
            "required sandbox must fail closed, got {err:?}"
        );
    }

    #[test]
    fn darwin_sandbox_allows_root_write_when_available() {
        if !darwin_sandbox_exec_available() {
            return;
        }
        let root = TempDir::new();
        let r = run_command_in_root_with_darwin_sandbox_timeout(
            root.path(),
            "touch inside.txt",
            std::time::Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(r.exit_code, Some(0), "sandbox output: {:?}", r.output);
        assert!(root.path().join("inside.txt").is_file());
    }

    #[test]
    fn darwin_sandbox_blocks_outside_write_when_available() {
        if !darwin_sandbox_exec_available() {
            return;
        }
        let root = TempDir::new();
        let outside = TempDir::new();
        let outside_file = outside.path().join("outside.txt");
        let command = format!("touch {}", outside_file.display());

        let r = run_command_in_root_with_darwin_sandbox_timeout(
            root.path(),
            &command,
            std::time::Duration::from_secs(5),
        )
        .unwrap();
        assert_ne!(
            r.exit_code,
            Some(0),
            "outside write must be blocked; output: {:?}",
            r.output
        );
        assert!(
            !outside_file.exists(),
            "sandboxed command must not create files outside root"
        );
    }

    /// TIMEOUT + KILL: `sleep 5` with a SHORT (200ms) test timeout → timed_out=true, child killed,
    /// and the call returns promptly (well under the 5s the sleep would take).
    #[test]
    fn run_command_times_out_and_kills_child() {
        let root = TempDir::new();
        let start = std::time::Instant::now();
        let r = run_command_in_root_with_timeout(
            root.path(),
            "sleep 5",
            std::time::Duration::from_millis(200),
        )
        .unwrap();
        let elapsed = start.elapsed();
        assert!(r.timed_out, "sleep 5 under a 200ms timeout must time out");
        assert_eq!(r.exit_code, None, "a killed child has no normal exit code");
        assert!(
            elapsed < std::time::Duration::from_secs(3),
            "must return promptly after the kill, took {elapsed:?}"
        );
    }

    /// SETSID-ESCAPE BOUND (the load-bearing reliability test). A `perl` LEADER forks a grandchild
    /// that calls `POSIX::setsid()` — ESCAPING the leader's process group — and then HOLDS stdout
    /// open while sleeping far longer than the timeout+grace; the leader then EXITS (but only AFTER
    /// the grandchild has escaped — a sync pipe enforces that ordering deterministically, see below).
    /// `recv_timeout` returns the instant the leader exits (`timed_out=false`), and our process-group
    /// SIGKILL can NOT reach the (now-escaped) grandchild, so the stdout pipe never EOFs. Pre-fix the
    /// unbounded `r.join()` would block on the grandchild's full lifetime (or forever), pinning the
    /// calling thread. Post-fix the reader drain is deadline-bounded, so the call MUST return within
    /// ~timeout + grace regardless. We use a 1s timeout (grace 2s ⇒ ~3s drain deadline) and a
    /// grandchild that sleeps 30s, then assert the call returns in < 8s — well above the ~3s drain
    /// deadline (generous headroom for a loaded CI runner's scheduling jitter) yet far below the
    /// grandchild's 30s lifetime. This test FAILS on the pre-fix code (it would take ~30s, blowing
    /// the 8s bound) and PASSES on the deadline-bounded fix (returns ~3s).
    #[test]
    fn run_command_setsid_escaped_grandchild_does_not_pin_thread() {
        let root = TempDir::new();
        // perl is on PATH (/usr/bin/perl). Quote-aware tokenizer: pass the program as one '...'
        // single-quoted arg so the script survives as a single literal token (no shell, no $expand).
        // The grandchild setsid()'s (new session ⇒ new process group ⇒ escapes the leader's group),
        // keeps STDOUT (it does NOT close it) and sleeps 30s; the leader prints + exits at once.
        //
        // DETERMINISM (the only thing that made this flake): the grandchild MUST complete
        // `POSIX::setsid()` — i.e. ESCAPE the leader's process group — BEFORE the leader exits.
        // The helper's recv_timeout returns the instant the leader exits and then fires the
        // unconditional `kill(-pid, SIGKILL)` against the leader's group. If a loaded runner had
        // not yet scheduled the grandchild's `setsid()`, the grandchild would still be IN that group,
        // get killed, close its stdout fd → the pipe would EOF and `output_truncated` would be FALSE
        // (the helper behaving correctly for the scenario that actually happened — an un-escaped,
        // in-group descendant IS the killpg's job — but NOT the escape scenario this test means to
        // exercise). We close that window with a SYNC PIPE created inside perl (`pipe`, on its own
        // fds — NOT stdout/stderr, so the drains are untouched): the grandchild does `setsid()`
        // first, then writes one byte; the leader BLOCKS reading that byte before it prints/exits.
        // So the leader cannot exit (and the helper's kill cannot fire) until the escape is a fact.
        // Each side closes the pipe end it does not use, so a grandchild that died for any reason
        // yields EOF on the leader's `sysread` (returns 0, the leader proceeds and exits) — never a
        // hang. The leader's `print "leader\n"` is therefore still emitted only after the escape.
        let script = "pipe(my $rd, my $wr) or exit 4; \
                      my $pid = fork(); \
                      if (!defined $pid) { exit 3 } \
                      if ($pid == 0) { close $rd; POSIX::setsid(); $| = 1; print \"grandchild\\n\"; syswrite($wr, \"x\", 1); sleep 30; exit 0 } \
                      close $wr; my $b; sysread($rd, $b, 1); print \"leader\\n\"; exit 0;";
        let command = format!("perl -MPOSIX -e '{script}'");
        let timeout = std::time::Duration::from_secs(1);
        // Bound: well above the ~3s drain deadline (loaded-CI headroom) yet far below the
        // grandchild's 30s lifetime, so this cleanly separates "deadline-bounded" from "pinned".
        let bound = std::time::Duration::from_secs(8);
        let start = std::time::Instant::now();
        let r = run_command_in_root_with_timeout(root.path(), &command, timeout).unwrap();
        let elapsed = start.elapsed();
        // The HARD requirement: bounded by ~timeout + grace, NOT the grandchild's 30s lifetime.
        assert!(
            elapsed < bound,
            "an escaped setsid grandchild holding stdout must NOT pin the call; \
             returned in {elapsed:?} (must be < {bound:?})"
        );
        // The leader exited on its own well within the timeout, so this is NOT a timeout-kill of
        // the leader: `timed_out` reflects the leader, which exited normally.
        assert!(
            !r.timed_out,
            "the leader exited on its own; timed_out must reflect the leader, not the drain cut"
        );
        // The deadline cut the drain short (the grandchild's pipe never EOF'd) ⇒ output marked
        // truncated/incomplete (we reuse `output_truncated` as the deadline-cut signal).
        assert!(
            r.output_truncated,
            "a deadline-bounded drain that never saw EOF must report the output as truncated"
        );
    }

    /// OUTPUT BOUND: a single self-terminating program that emits > the cap (`seq 1 200000`,
    /// hundreds of KiB of ASCII, then EXITS) → output_truncated=true and the RETAINED bytes are
    /// <= the cap. No shell pipe needed (we banned the shell), and no timeout (it exits).
    #[test]
    fn run_command_output_is_bounded() {
        let root = TempDir::new();
        let r = run_command_in_root(root.path(), "seq 1 200000").unwrap();
        assert!(!r.timed_out, "seq exits on its own — must not time out");
        assert!(
            r.output_truncated,
            "output beyond the cap must be truncated"
        );
        assert!(
            r.output.len() <= RUN_COMMAND_MAX_OUTPUT_BYTES,
            "retained bytes {} must be <= cap {}",
            r.output.len(),
            RUN_COMMAND_MAX_OUTPUT_BYTES
        );
    }

    /// A non-zero EXIT is a RESULT, not an Err: `false` exits 1.
    #[test]
    fn run_command_nonzero_exit_is_a_result() {
        let root = TempDir::new();
        let r = run_command_in_root(root.path(), "false").unwrap();
        assert_eq!(r.exit_code, Some(1));
        assert!(!r.timed_out);
    }

    /// A non-existent root is a clean NotFound (canonicalize), not a spawn of the command.
    #[test]
    fn run_command_missing_root_is_not_found() {
        let missing = std::env::temp_dir().join(format!(
            "friday-fs-no-such-root-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let err = run_command_in_root(&missing, "echo hi").unwrap_err();
        assert!(matches!(err, FsError::NotFound), "got {err:?}");
    }
}
