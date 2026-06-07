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
}
