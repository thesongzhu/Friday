//! Pure dangerous-action / tool-use-policy classifier (file 39 §2/§6, PR-2 of the
//! agent-loop NO-GO cluster; UNW-009 multilingual). A faithful port of the TS
//! oracle's `classifyShellRisk` (`friday-agent-tool-risk.ts`, post-#427: wrapper
//! unwrapping + dangerous-flag detection + `mkfs.*` + protected-artifact +
//! sensitive-assignment composition) and the planning-gate destructive-action
//! hints (English **and** Chinese — multilingual scope from day one).
//!
//! NO I/O and **no `regex` dependency** — hand-written deterministic scanners keep
//! `friday-core` dependency-light (it links into the phone binary) and keep the
//! security-relevant matching fully auditable.
//!
//! This module **classifies**; it does NOT authorize. The canonical
//! mutating-action gate (file 39 §2 group A, PR-3) consumes these classifications
//! and decides `Allow`/`Deny`/`RequiresApproval`. A model self-claim never
//! downgrades a classification here — classification is a property of the request,
//! not of what the model asserts about it.

/// Risk ordering (`read_only < low < medium < high < critical`), ported from the
/// TS gate's weighted levels. `Ord` follows declaration order, so comparisons
/// (`risk >= Risk::High`) work directly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Risk {
    ReadOnly,
    Low,
    Medium,
    High,
    Critical,
}

impl Risk {
    pub fn as_str(&self) -> &'static str {
        match self {
            Risk::ReadOnly => "read_only",
            Risk::Low => "low",
            Risk::Medium => "medium",
            Risk::High => "high",
            Risk::Critical => "critical",
        }
    }
}

/// Shell-command risk class (TS `safe | guarded | destructive | blocked`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellRisk {
    /// A known read-only/inspection program (e.g. `ls`, `grep`), or an empty command.
    Safe,
    /// Unknown or general-purpose-mutating program — allowed only under review.
    Guarded,
    /// A known destructive program / flag / wrapper form that must be approved.
    Destructive,
    /// Contains a shell metacharacter / control char — refuse outright (a single
    /// token cannot be classified once it can chain or redirect).
    Blocked,
}

impl ShellRisk {
    /// Map a shell-risk class to the canonical `Risk` ordering consumed by the gate.
    pub fn risk(self) -> Risk {
        match self {
            ShellRisk::Safe => Risk::ReadOnly,
            ShellRisk::Guarded => Risk::Medium,
            ShellRisk::Destructive => Risk::High,
            ShellRisk::Blocked => Risk::Critical,
        }
    }
}

// --- token sets (ported verbatim from friday-agent-tool-risk.ts) -------------

const SAFE_PROGRAMS: &[&str] = &[
    "ls", "cat", "head", "tail", "wc", "file", "stat", "which", "whereis", "echo", "printf",
    "date", "whoami", "uname", "hostname", "pwd", "find", "grep", "rg", "ag", "awk", "sort",
    "uniq", "diff", "comm", "tree", "du", "df", "free", "top", "ps", "env", "printenv", "git",
    "npm", "npx", "yarn", "pnpm", "node", "python", "python3", "cargo", "go", "rustc", "gcc",
    "make", "cmake", "curl", "wget",
];

const DESTRUCTIVE_PROGRAMS: &[&str] = &[
    "rm", "unlink", "shred", "truncate", "dd", "mkfs", "kill", "killall", "pkill",
];

const MUTATING_PROGRAMS: &[&str] = &["sed", "perl", "python", "python3", "node", "jq", "ruby"];

/// Shell metacharacters that allow chaining / redirection / substitution. Their
/// mere presence makes a command unclassifiable as a single program → `Blocked`.
const BLOCKED_SHELL_CHARS: &[char] = &[
    ';', '|', '&', '`', '$', '(', ')', '{', '}', '\n', '\r', '<', '>', '#', '!', '~',
];

/// Protected-artifact file extensions (TS `HIGH_RISK_MUTATION_EXTENSION_RE`).
const PROTECTED_EXTENSIONS: &[&str] = &[
    ".bak", ".backup", ".dump", ".sqlite", ".db", ".sql", ".tar", ".tgz", ".gz", ".zip",
];

/// Protected-artifact name keywords (TS `HIGH_RISK_MUTATION_NAME_RE`).
const PROTECTED_NAMES: &[&str] = &["database", "backup", "snapshot", "restore"];

/// Extensions that mark a file as "obviously textual" — these suppress the
/// protected-*name* keyword match (TS `obviouslyTextual`), so `database.json` is
/// not treated as a protected artifact. (A protected *extension* is never suppressed.)
const OBVIOUSLY_TEXTUAL_EXTS: &[&str] = &[
    ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
];

/// Sensitive-material bare words (matched as whole words, `_` treated as a word
/// char like regex `\b`) plus the compound key forms (TS `SENSITIVE_KEY_RE`).
const SENSITIVE_WORDS: &[&str] = &[
    "secret",
    "password",
    "credential",
    "token",
    "api_token",
    "api-token",
    "apitoken",
    "access_token",
    "access-token",
    "accesstoken",
    "refresh_token",
    "refresh-token",
    "refreshtoken",
    "private_key",
    "private-key",
    "privatekey",
];

/// Destructive command keywords (TS `DESTRUCTIVE_COMMAND_KEYWORD_RE`), used with
/// the protected-artifact escalation.
const DESTRUCTIVE_KEYWORDS: &[&str] = &[
    "rm",
    "remove",
    "delete",
    "unlink",
    "shred",
    "truncate",
    "unlinksync",
    "rmsync",
];

/// Shells/interpreters that exec an opaque code string via a flag (`sh -c "…"`).
const SHELL_PROGRAMS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "ash", "csh", "tcsh"];

// --- program-name normalization ----------------------------------------------

/// Bare, lowercased basename of a program token: strips surrounding quotes,
/// normalizes `\`→`/`, takes the last path segment (TS `normalizeProgramName`).
fn normalize_program_name(token: Option<&str>) -> String {
    let t = token.unwrap_or("");
    let t = t.trim_matches(|c| c == '"' || c == '\'');
    let t = t.replace('\\', "/");
    t.rsplit('/').next().unwrap_or(&t).to_ascii_lowercase()
}

/// `^[A-Za-z_][A-Za-z0-9_]*=` — an inline env-assignment token (`FOO=bar`).
fn is_inline_env_assignment(tok: &str) -> bool {
    let b = tok.as_bytes();
    if b.is_empty() || !(b[0].is_ascii_alphabetic() || b[0] == b'_') {
        return false;
    }
    let mut i = 1;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
        i += 1;
    }
    i < b.len() && b[i] == b'='
}

/// `^-[a-z]*c$` (case-insensitive) — a shell code flag (`-c`, `-lc`, `-ic`).
fn is_shell_code_flag(t: &str) -> bool {
    let b = t.as_bytes();
    if b.len() < 2 || b[0] != b'-' {
        return false;
    }
    let mid = &t[1..];
    mid.chars().all(|c| c.is_ascii_alphabetic()) && mid.to_ascii_lowercase().ends_with('c')
}

/// `^-\d+$` — a `nice` adjustment (`-10`).
fn is_nice_adjustment(opt: &str) -> bool {
    opt.len() > 1 && opt.starts_with('-') && opt[1..].chars().all(|c| c.is_ascii_digit())
}

/// Transparent wrapper option table (TS `COMMAND_WRAPPER_OPTS`): `(value_opts, flag_opts)`.
/// `value_opts` consume a following token; `flag_opts` are value-less. `None` = not a wrapper.
fn wrapper_opts(prog: &str) -> Option<(&'static [&'static str], &'static [&'static str])> {
    match prog {
        "env" => Some((
            &["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
            &[
                "-i",
                "--ignore-environment",
                "-",
                "-0",
                "--null",
                "-v",
                "--debug",
            ],
        )),
        "sudo" => Some((
            &[
                "-u",
                "--user",
                "-g",
                "--group",
                "-C",
                "--close-from",
                "-h",
                "--host",
                "-p",
                "--prompt",
                "-r",
                "--role",
                "-t",
                "--type",
                "-U",
                "--other-user",
                "-D",
                "--chdir",
                "-R",
                "--chroot",
            ],
            &[
                "-A",
                "--askpass",
                "-b",
                "--background",
                "-E",
                "--preserve-env",
                "-H",
                "--set-home",
                "-i",
                "--login",
                "-K",
                "--remove-timestamp",
                "-k",
                "--reset-timestamp",
                "-l",
                "--list",
                "-n",
                "--non-interactive",
                "-P",
                "--preserve-groups",
                "-S",
                "--stdin",
                "-s",
                "--shell",
                "-V",
                "--version",
                "-v",
                "--validate",
            ],
        )),
        "doas" => Some((&["-u", "-C"], &["-L", "-n", "-s"])),
        "command" => Some((&[], &["-p", "-v", "-V"])),
        "nice" => Some((&["-n", "--adjustment"], &[])),
        "nohup" => Some((&[], &[])),
        "setsid" => Some((&[], &["-c", "--ctty", "-f", "--fork", "-w", "--wait"])),
        "timeout" => Some((
            &["-s", "--signal", "-k", "--kill-after"],
            &["--preserve-status", "--foreground", "-v", "--verbose", "-f"],
        )),
        "xargs" => Some((
            &[
                "-I",
                "-n",
                "--max-args",
                "-P",
                "--max-procs",
                "-d",
                "--delimiter",
                "-E",
                "-L",
                "--max-lines",
                "-s",
                "--max-chars",
                "-a",
                "--arg-file",
            ],
            &[
                "-0",
                "--null",
                "-p",
                "--interactive",
                "-r",
                "--no-run-if-empty",
                "-t",
                "--verbose",
                "-x",
                "--exit",
                "-i",
                "--replace",
                "-e",
                "--eof",
                "-l",
            ],
        )),
        "time" => Some((
            &["-o", "--output", "-f", "--format"],
            &["-p", "-v", "--verbose", "-a", "--append"],
        )),
        _ => None,
    }
}

/// Result of stripping transparent wrappers (TS `UnwrappedCommand`).
struct Unwrapped<'a> {
    /// Set when the wrapper form itself requires approval (opaque `sh -c`, unparseable wrapper).
    approve: bool,
    /// The innermost command tokens to classify.
    inner: Vec<&'a str>,
}

/// Strip transparent command wrappers (`env`/`sudo`/`nice`/`timeout`/`xargs`/…) and
/// inline env-assignment prefixes so the INNERMOST command is what gets classified,
/// and force approval when a shell is handed an opaque code string or a wrapper has
/// an unrecognized option. Recurses (depth-guarded) for nested forms like `sudo env rm`.
/// Faithful port of TS `unwrapCommand`.
fn unwrap_command<'a>(parts: &[&'a str]) -> Unwrapped<'a> {
    let mut toks: Vec<&'a str> = parts.to_vec();
    let mut depth = 0;
    while !toks.is_empty() {
        if depth >= 8 {
            return Unwrapped {
                approve: true,
                inner: toks,
            };
        }
        depth += 1;

        let mut s = 0;
        while s < toks.len() && is_inline_env_assignment(toks[s]) {
            s += 1;
        }
        if s > 0 {
            toks = toks[s..].to_vec();
            if toks.is_empty() {
                break;
            }
        }

        let prog = normalize_program_name(toks.first().copied());

        if SHELL_PROGRAMS.contains(&prog.as_str())
            && toks[1..].iter().any(|t| is_shell_code_flag(t))
        {
            return Unwrapped {
                approve: true,
                inner: toks,
            };
        }

        // `command -v`/`-V` is a lookup, not an exec wrapper.
        if prog == "command" && toks[1..].iter().any(|&t| t == "-v" || t == "-V") {
            break;
        }

        let (value_opts, flag_opts) = match wrapper_opts(&prog) {
            Some(spec) => spec,
            None => break, // not a transparent wrapper → effective command
        };

        let mut i = 1;
        let mut unrecognized = false;
        while i < toks.len() {
            let opt = toks[i];
            if !opt.starts_with('-') {
                break;
            }
            if opt == "--" {
                i += 1;
                break;
            }
            if opt.contains('=') {
                i += 1;
                continue;
            }
            if prog == "nice" && is_nice_adjustment(opt) {
                i += 1;
                continue;
            }
            if value_opts.contains(&opt) {
                i += 2;
                continue;
            }
            if flag_opts.contains(&opt) {
                i += 1;
                continue;
            }
            // attached-value short option, e.g. `-n10` / `-uroot`. `opt.get(..2)`
            // (not `&opt[..2]`) so a multibyte option like `-é` returns None instead
            // of panicking on a non-char-boundary slice → falls through to "unrecognized".
            if !opt.starts_with("--") && opt.get(..2).is_some_and(|p| value_opts.contains(&p)) {
                i += 1;
                continue;
            }
            unrecognized = true;
            break;
        }
        if unrecognized {
            return Unwrapped {
                approve: true,
                inner: toks,
            };
        }
        if prog == "env" {
            while i < toks.len() && is_inline_env_assignment(toks[i]) {
                i += 1;
            }
        }
        if prog == "timeout" && i < toks.len() && !toks[i].starts_with('-') {
            i += 1; // positional DURATION
        }
        if i >= toks.len() {
            return Unwrapped {
                approve: false,
                inner: toks,
            };
        }
        toks = toks[i..].to_vec();
    }
    Unwrapped {
        approve: false,
        inner: toks,
    }
}

// --- dangerous-flag detection (git / find) -----------------------------------

const GIT_GLOBAL_OPTS_WITH_VALUE: &[&str] = &[
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
    "--super-prefix",
    "--config-env",
    "--shallow-file",
    "--attr-source",
];
const GIT_GLOBAL_FLAGS_NO_VALUE: &[&str] = &[
    "--no-pager",
    "--paginate",
    "-p",
    "--bare",
    "--no-replace-objects",
    "--literal-pathspecs",
    "--glob-pathspecs",
    "--noglob-pathspecs",
    "--icase-pathspecs",
    "--no-optional-locks",
    "--no-lazy-fetch",
    "--no-advice",
    "--version",
    "--html-path",
    "--man-path",
    "--info-path",
];
const GIT_SUBCOMMAND_UNKNOWN_OPT: isize = -2;

/// Locate the git subcommand index, skipping known global options. `-1` = none;
/// `GIT_SUBCOMMAND_UNKNOWN_OPT` = an unrecognized leading option (fail safe to a scan).
fn git_subcommand_start(parts: &[&str]) -> isize {
    let mut i = 1usize;
    while i < parts.len() {
        let tok = parts[i];
        if !tok.starts_with('-') {
            return i as isize;
        }
        if tok.contains('=') {
            i += 1;
            continue;
        }
        if GIT_GLOBAL_OPTS_WITH_VALUE.contains(&tok) {
            i += 2;
            continue;
        }
        if GIT_GLOBAL_FLAGS_NO_VALUE.contains(&tok) {
            i += 1;
            continue;
        }
        return GIT_SUBCOMMAND_UNKNOWN_OPT;
    }
    -1
}

/// A `--`-prefixed unambiguous prefix of `full_flag` (git accepts abbreviations:
/// `--har`→`--hard`). Length ≥ 3 so `--x` is the minimum (TS `matchesLongFlag`).
fn matches_long_flag(token: &str, full_flag: &str) -> bool {
    token.len() >= 3 && token.starts_with("--") && full_flag.starts_with(token)
}

/// `^-[a-z]*f[a-z]*$` (case-insensitive) — a `git clean` force cluster (`-f`, `-fd`, `-fdx`).
fn is_clean_force_cluster(a: &str) -> bool {
    let b = a.as_bytes();
    if b.len() < 2 || b[0] != b'-' || a.starts_with("--") {
        return false;
    }
    let mid = &a[1..];
    mid.chars().all(|c| c.is_ascii_alphabetic()) && mid.to_ascii_lowercase().contains('f')
}

/// Per-subcommand destructive-flag check (TS `gitDestructiveReason`).
fn git_destructive(sub: &str, rest: &[&str]) -> bool {
    let s = sub.to_ascii_lowercase();
    let has_force = rest
        .iter()
        .any(|&a| a == "-f" || matches_long_flag(a, "--force"));
    if s == "reset" && rest.iter().any(|&a| matches_long_flag(a, "--hard")) {
        return true;
    }
    if s == "clean"
        && rest
            .iter()
            .any(|&a| is_clean_force_cluster(a) || matches_long_flag(a, "--force"))
    {
        return true;
    }
    if (s == "checkout" || s == "restore" || s == "switch")
        && (has_force || rest.iter().any(|&a| matches_long_flag(a, "--hard")))
    {
        return true;
    }
    false
}

/// Fail-safe scan when a leading global option is unrecognized (TS `gitDestructiveReasonByScan`).
fn git_destructive_by_scan(tokens: &[&str]) -> bool {
    (0..tokens.len()).any(|k| git_destructive(tokens[k], &tokens[k + 1..]))
}

/// Detect destructive FLAG combinations on name-safe programs (`git reset --hard`,
/// `git clean -fdx`, `find … -delete`). Faithful port of TS `detectDangerousShellFlagReason`.
fn detect_dangerous_flag(program: &str, parts: &[&str]) -> bool {
    if program == "git" {
        let sub_idx = git_subcommand_start(parts);
        if sub_idx == GIT_SUBCOMMAND_UNKNOWN_OPT {
            return git_destructive_by_scan(&parts[1..]);
        }
        if sub_idx == -1 {
            return false;
        }
        let idx = sub_idx as usize;
        return git_destructive(parts.get(idx).copied().unwrap_or(""), &parts[idx + 1..]);
    }
    if program == "find" {
        return parts[1..].contains(&"-delete");
    }
    false
}

// --- shell classification ----------------------------------------------------

/// True if the command contains a blocking shell metacharacter or a control char.
pub fn contains_blocked_shell_char(command: &str) -> bool {
    command
        .chars()
        .any(|c| BLOCKED_SHELL_CHARS.contains(&c) || c.is_control())
}

/// Classify a shell command, faithful to the TS oracle's `classifyShellRisk`
/// (post-#427): empty → `Safe`; a shell metacharacter/control char → `Blocked`;
/// otherwise unwrap transparent wrappers (`env`/`sudo`/`timeout`/…) and classify the
/// INNER command — an opaque `sh -c` or unparseable wrapper → `Destructive`; a
/// destructive program (incl. `mkfs.*` stem) → `Destructive`; a destructive flag
/// (`git reset --hard`, `find … -delete`) → `Destructive`; protected-artifact +
/// destructive keyword → `Destructive`; sensitive credential assignment, or a
/// sensitive key via a mutating interpreter → `Destructive`; a known safe program →
/// `Safe`; an unknown program defaults to `Guarded` (never silently `Safe`).
pub fn shell_risk(command: &str) -> ShellRisk {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return ShellRisk::Safe;
    }
    if contains_blocked_shell_char(trimmed) {
        return ShellRisk::Blocked;
    }
    let parts: Vec<&str> = trimmed.split_whitespace().collect();

    let uw = unwrap_command(&parts);
    if uw.approve {
        return ShellRisk::Destructive;
    }
    let effective = uw.inner;
    let program = normalize_program_name(effective.first().copied());
    let stem = program.split('.').next().unwrap_or(program.as_str());
    if DESTRUCTIVE_PROGRAMS.contains(&program.as_str()) || DESTRUCTIVE_PROGRAMS.contains(&stem) {
        return ShellRisk::Destructive;
    }
    if detect_dangerous_flag(&program, &effective) {
        return ShellRisk::Destructive;
    }
    let lower = trimmed.to_ascii_lowercase();
    if list_potential_file_paths(trimmed)
        .iter()
        .any(|p| touches_protected_artifact(p))
        && contains_destructive_keyword(&lower)
    {
        return ShellRisk::Destructive;
    }
    if contains_sensitive_assignment(trimmed) {
        return ShellRisk::Destructive;
    }
    if contains_sensitive_material(&lower) && MUTATING_PROGRAMS.contains(&program.as_str()) {
        return ShellRisk::Destructive;
    }
    if SAFE_PROGRAMS.contains(&program.as_str()) {
        return ShellRisk::Safe;
    }
    ShellRisk::Guarded
}

// --- file / content classification -------------------------------------------

/// Extract path-like candidates from a command (TS `listPotentialFilePaths`,
/// regex `\b[\w./-]+\.[A-Za-z0-9]+\b`). Scans maximal runs of `[A-Za-z0-9_./-]`
/// and, within each, carves every prefix ending at a `.<alnum>+` followed by a
/// word boundary — so a protected path is recovered even when joined to other
/// text by a non-set char (`report.db,v` → `report.db`; `"data.sql"` → `data.sql`)
/// or trailed by a suffix (`report.db-bak` → `report.db`). Each candidate is then
/// tested by `touches_protected_artifact`. A per-token `ends_with` would miss all
/// of these (a destructive→Safe gap the reviewers caught).
fn list_potential_file_paths(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let in_set = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'/' | b'-');
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if !in_set(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && in_set(bytes[i]) {
            i += 1;
        }
        let run = &text[start..i];
        let rb = run.as_bytes();
        // Carve each `…<name>.<alnum>+<word-boundary>` prefix in the run.
        let mut j = 0;
        while j < rb.len() {
            if rb[j] == b'.' {
                let mut e = j + 1;
                while e < rb.len() && rb[e].is_ascii_alphanumeric() {
                    e += 1;
                }
                // at least one alnum after '.', and a `\b` after it (`_`/alnum is a word char).
                if e > j + 1 && (e == rb.len() || !is_word_byte(rb[e])) {
                    out.push(&run[..e]);
                }
            }
            j += 1;
        }
    }
    out
}

/// True if a path targets a protected artifact (TS `requiresApprovalForProtectedArtifactPath`):
/// a protected extension (`.db`, `.sql`, `.bak`, ...) always qualifies; a protected name
/// keyword (`database`, `backup`, ...) qualifies only when the basename is NOT an obviously
/// textual file (`.md`/`.json`/`.yaml`/...). Inspects the basename only.
pub fn touches_protected_artifact(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let base = normalized
        .rsplit('/')
        .next()
        .unwrap_or(&normalized)
        .to_ascii_lowercase();
    if PROTECTED_EXTENSIONS.iter().any(|ext| base.ends_with(ext)) {
        return true;
    }
    let obviously_textual = OBVIOUSLY_TEXTUAL_EXTS.iter().any(|ext| base.ends_with(ext));
    !obviously_textual && PROTECTED_NAMES.iter().any(|w| contains_word(&base, w))
}

/// True if text contains sensitive material (secret/token/credential/password or
/// a compound key form). Whole-word match with `_` treated as a word char (TS `SENSITIVE_KEY_RE`).
pub fn contains_sensitive_material(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    SENSITIVE_WORDS.iter().any(|w| contains_word(&lower, w))
}

/// True if text contains a destructive command keyword (TS `DESTRUCTIVE_COMMAND_KEYWORD_RE`).
fn contains_destructive_keyword(lower: &str) -> bool {
    DESTRUCTIVE_KEYWORDS.iter().any(|w| contains_word(lower, w))
}

/// Sensitive-key prefixes (lowercased) used by the assignment detector.
const SENSITIVE_ASSIGN_KEYS: &[&str] = &[
    "api_token",
    "api-token",
    "apitoken",
    "access_token",
    "access-token",
    "accesstoken",
    "refresh_token",
    "refresh-token",
    "refreshtoken",
    "private_key",
    "private-key",
    "privatekey",
    "secret",
    "password",
    "credential",
    "token",
];
const ASSIGN_KEYWORDS: &[&str] = &["token", "secret", "password", "credential"];

/// True if text is a credential mutation (TS `SENSITIVE_ASSIGNMENT_RE`, case-insensitive):
/// a sensitive key optionally quoted then `:`/`=`, OR a word containing a credential keyword
/// (`MY_TOKEN_VALUE`, `tokenizer`) directly followed by `=`.
pub fn contains_sensitive_assignment(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    // Alt 1: key, optional quote, optional ws, then ':' or '='.
    for k in SENSITIVE_ASSIGN_KEYS {
        let mut from = 0;
        while let Some(rel) = lower[from..].find(k) {
            let after = from + rel + k.len();
            let rest = &lower[after..];
            let rest = rest.strip_prefix(['"', '\'']).unwrap_or(rest);
            let rest = rest.trim_start();
            if rest.starts_with(':') || rest.starts_with('=') {
                return true;
            }
            from = from + rel + 1;
        }
    }
    // Alt 2: a word (alnum/_) containing a credential keyword, then optional ws, then '='.
    for kw in ASSIGN_KEYWORDS {
        let mut from = 0;
        while let Some(rel) = lower[from..].find(kw) {
            let pos = from + rel;
            let mut hi = pos + kw.len();
            while hi < bytes.len() && (bytes[hi].is_ascii_alphanumeric() || bytes[hi] == b'_') {
                hi += 1;
            }
            if lower[hi..].trim_start().starts_with('=') {
                return true;
            }
            from = pos + 1;
        }
    }
    false
}

// --- destructive-request detection (planning gate; EN + CJK) -----------------

const EN_DESTRUCT_VERBS: &[&str] = &[
    "delete", "remove", "erase", "wipe", "purge",    // ↓ `clean up` mirrors the oracle's
    "clean up", // `clean(?:\s+up)?` so the in-window match starts AFTER "up" (reviewer-B C2);
    "clean", "clear", "drop", "reset", "destroy", "rm", "unlink", "shred", "truncate", "format",
];
const EN_DESTRUCT_OBJECTS: &[&str] = &[
    "file",
    "files",
    "folder",
    "folders",
    "directory",
    "directories",
    "workspace",
    "repo",
    "repository",
    "database",
    "table",
    "branch",
    "settings",
    "setting",
    "config",
    "permissions",
    "permission",
    "backup",
    "dump",
    "snapshot",
    "cache",
    "tmp",
    "logs",
    "log",
    "all",
    "everything",
    // C2 hardening (reviewer-B): high-risk delete/reset targets the oracle's list
    // omits. So "reset the production credentials" / "delete the production
    // deployment" / "wipe the tokens" now escalate (via deployment/credentials/token —
    // bare "production" was dropped to avoid `rotate the production banner` false flags).
    "deployment",
    "deployments",
    "credentials",
    "credential",
    "token",
    "tokens",
];
const EN_SAVE_VERBS: &[&str] = &["save", "store", "write", "persist", "record", "remember"];
const EN_SAVE_OBJECTS: &[&str] = &[
    "api key",
    "api_key",
    "api-key",
    "apikey",
    "access token",
    "access_token",
    "access-token",
    "accesstoken",
    "refresh token",
    "refresh_token",
    "refresh-token",
    "refreshtoken",
    "token",
    "secret",
    "password",
    "credential",
    "private key",
    "private_key",
    "private-key",
    "privatekey",
];
const EN_CONFIG_VERBS: &[&str] = &[
    "change", "modify", "update", "set", "disable", "enable", "remove", "delete", "reset",
];
const EN_CONFIG_OBJECTS: &[&str] = &[
    "github",
    "branch protection",
    "repo settings",
    "repository settings",
    "permissions",
    "permission",
    "secrets",
    "secret",
    "provider config",
    "routing config",
    // C2 hardening: repo visibility + 2FA toggles via config verbs
    // (set/change/update/disable/enable + these) — catches "change the repo
    // visibility to public" / "disable 2fa" without the noisy bare `make` verb.
    // NOTE: bare `public`/`private` were dropped (reviewer A+B C2 round-2): with the
    // config verbs they flooded ordinary coding asks ("change the public API",
    // "set the field to private"). The motivating case ("change repo visibility to
    // public") is carried by `visibility`; "disable 2fa" by `2fa`.
    "visibility",
    "2fa",
    "mfa",
    "two-factor",
];
/// C2 hardening (reviewer-B), DELIBERATE divergence from the TS oracle: high-risk
/// operations phrased outside the file/credential/config clauses above
/// (`revoke tokens`, `rotate the signing key`, `transfer ownership`, `force push`/
/// `overwrite history`, `grant admin`, `turn off branch protection`,
/// `leak/expose the secret`). The oracle SHARES this under-detection; we close it
/// because the planning gate should escalate these to a plan. Stricter is safe here
/// (over-planning a high-risk ask is harmless; under-planning a destructive one is
/// not). Repo-visibility ("make X public") is NOT here — bare `make` was dropped as a
/// flooding verb; it is caught via the config clause (`change/set visibility`).
const EN_HIGHRISK_VERBS: &[&str] = &[
    "revoke",
    "rotate",
    "transfer",
    "overwrite",
    "leak",
    "expose",
    "grant",
    "turn off",
    "force push",
    "force-push",
    // NOTE: `make` was dropped (reviewer A+B C2): even word-bounded it pairs with
    // common objects ("make a cake for the public bake sale") and floods the gate.
    // Repo-visibility ("make X public") is instead caught via the config clause
    // (set/change/update + public/private/visibility).
];
const EN_HIGHRISK_OBJECTS: &[&str] = &[
    "token",
    "tokens",
    "access token",
    "credential",
    "credentials",
    "key",
    "keys",
    "signing key",
    "api key",
    "admin",
    "ownership",
    "deployment",
    "deployments",
    "history",
    // NOTE: `production` was dropped as a bare object (reviewer A+B C2): it caused
    // `rotate the production banner image`-class false flags. The real cases catch
    // via their concrete object (delete+deployment, reset+credentials, wipe+database).
    "main",
    "master",
    "2fa",
    "mfa",
    "two-factor",
    // NOTE: bare `public`/`private` dropped here too (reviewer A+B C2 round-2): they
    // flooded "rotate the public key"-class asks while adding nothing — `rotate ...
    // key` already fires via `key`, and visibility changes fire via the config clause.
    "branch protection",
    "secret",
    "secrets",
    "permission",
    "permissions",
];
/// Programs that, followed by an argument, are a destructive shell action.
const DESTRUCT_EXEC: &[&str] = &["rm", "unlink", "shred", "truncate", "mkfs", "dd"];

const CJK_DESTRUCT_VERBS: &[&str] = &[
    "删除",
    "清理",
    "清空",
    "抹掉",
    "擦除",
    "移除",
    "销毁",
    "格式化",
];
const CJK_DESTRUCT_OBJECTS: &[&str] = &[
    "文件",
    "文件夹",
    "目录",
    "仓库",
    "数据库",
    "备份",
    "快照",
    "缓存",
    "日志",
    "所有",
    "全部",
];
const CJK_SAVE_VERBS: &[&str] = &["保存", "写入", "记录", "存储"];
const CJK_SAVE_OBJECTS: &[&str] = &["token", "令牌", "密钥", "密码", "凭据", "secret", "api key"];
const CJK_CONFIG_VERBS: &[&str] = &[
    "修改", "更改", "改变", "关闭", "开启", "删除",
    // C2 hardening (CJK parity, best-effort): revoke / transfer.
    "撤销", "转移",
];
const CJK_CONFIG_OBJECTS: &[&str] = &[
    "github",
    "分支保护",
    "仓库设置",
    "权限",
    "配置",
    "provider",
    "供应商",
    // C2 hardening: token / key / credentials / deployment / ownership.
    "令牌",
    "密钥",
    "凭据",
    "部署",
    "所有权",
];

/// True if the request describes a destructive / high-risk action (delete files/repos/DBs,
/// persist credentials, mutate GitHub/permission/repo settings, or invoke a destructive program
/// with an argument). Detects both English and Chinese phrasings (UNW-009 multilingual).
///
/// Known limitations vs the oracle (Reviewer-B C2 differential, both low-severity):
/// - **Homoglyph / Unicode case-fold evasion (under-detect).** Matching lowercases via
///   `to_ascii_lowercase`, while the oracle's `/iu` does full Unicode case-fold; a
///   confusable like U+212A (Kelvin, ≈`K`) in `保存to\u{212A}en` evades. This is a
///   classification gate, not the execution backstop (`shell_risk` still classifies a
///   real destructive command), and the evasion is exotic. Closing it belongs in the
///   shared normalization layer (a full case-fold), not here.
/// - **Window counted in code points (over-detect, safe).** The gap is
///   `chars().count()`; the EN oracle's `/i` (no `u`) counts UTF-16 units, so astral-
///   char-laden gaps make us slightly MORE permissive (never less). The CJK oracle is
///   `/iu` (code points) and matches exactly.
pub fn is_destructive_request(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    // EN clauses port `\bverb\b…\bobject\b` → word_bound = true. CJK clauses port the
    // no-`\b` `DESTRUCTIVE_ACTION_CJK_HINTS` → word_bound = false (pure substring), so a
    // CJK verb glued to an ASCII object (`保存access_token`) still matches as the oracle does.
    co_occurs_within(&lower, EN_DESTRUCT_VERBS, EN_DESTRUCT_OBJECTS, 120, true)
        || co_occurs_within(&lower, EN_SAVE_VERBS, EN_SAVE_OBJECTS, 80, true)
        || co_occurs_within(&lower, EN_CONFIG_VERBS, EN_CONFIG_OBJECTS, 100, true)
        || co_occurs_within(&lower, EN_HIGHRISK_VERBS, EN_HIGHRISK_OBJECTS, 100, true)
        || has_exec_with_arg(&lower, DESTRUCT_EXEC)
        || co_occurs_within(text, CJK_DESTRUCT_VERBS, CJK_DESTRUCT_OBJECTS, 80, false)
        || co_occurs_within(&lower, CJK_SAVE_VERBS, CJK_SAVE_OBJECTS, 80, false)
        || co_occurs_within(&lower, CJK_CONFIG_VERBS, CJK_CONFIG_OBJECTS, 80, false)
}

// --- scanning helpers (no regex) ---------------------------------------------

/// True if `needle` occurs in `haystack` bounded by non-word chars (`[a-z0-9_]` is a word
/// char, mirroring regex `\b`). `needle`/`haystack` must be lowercased by the caller.
fn contains_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let nlen = needle.len();
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(needle) {
        let pos = from + rel;
        let before_ok = pos == 0 || !is_word_byte(bytes[pos - 1]);
        let after_idx = pos + nlen;
        let after_ok = after_idx >= bytes.len() || !is_word_byte(bytes[after_idx]);
        if before_ok && after_ok {
            return true;
        }
        from = pos + 1;
    }
    false
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// True if some `verb` occurs and some `object` begins within `window` chars after
/// that verb ends. `word_bound` mirrors whether the oracle clause being ported
/// carries `\b`:
///
/// - The English `DESTRUCTIVE_ACTION_HINTS` is `\bverb\b[\s\S]{0,N}\bobject\b`, so EN
///   clauses pass `word_bound = true`. A `\b` is a transition between a word byte
///   (`is_word_byte` = `[a-z0-9_]`) and a non-word byte (or a string edge), enforced
///   PER EDGE and only when the needle's own edge byte is a word byte: an ASCII needle
///   must sit at a word/non-word seam (`key` ⊄ `turkey`, `token` ⊄ `tokenizer` — both
///   live list entries; `make`/`production` were dropped from the lists entirely).
/// - The Chinese `DESTRUCTIVE_ACTION_CJK_HINTS` has **no `\b` anywhere** — it is a pure
///   `(?:verb).{0,N}(?:object)` substring match — so CJK clauses pass
///   `word_bound = false`. This is load-bearing: those clauses deliberately list ASCII
///   objects (`token`/`secret`/`api key`/`github`/`provider`) so a CJK verb can be
///   glued to them. Bounding the object edge there is wrong in the unsafe
///   (under-detection) direction — it drops the canonical credential spellings
///   (`保存token`, `写入access_token`, `修改provider_config`, `保存tokens`), exactly the
///   credential-persistence asks the clause exists to catch. Reviewer A+B C2
///   round-2/3 flagged a symmetric word-bound as BLOCKING; the fix is to NOT bound the
///   CJK clauses at all (their oracle has no `\b`).
///
/// `vfrom`/`ofrom` advance by the matched needle's byte length (always a char
/// boundary — a `+1` could panic on CJK).
fn co_occurs_within(
    haystack: &str,
    verbs: &[&str],
    objects: &[&str],
    window: usize,
    word_bound: bool,
) -> bool {
    let bytes = haystack.as_bytes();
    // Per-edge `\b` (only when `word_bound`): require the left seam only if the needle
    // starts with a word byte, the right seam only if it ends with one. When
    // `word_bound` is false the clause's oracle has no `\b`, so every position is a
    // valid match position (pure substring). Needles are never empty, so `start < end`
    // and both `bytes[start]` / `bytes[end - 1]` are in range.
    let bounded = |start: usize, end: usize| -> bool {
        if !word_bound {
            return true;
        }
        let left_ok = !is_word_byte(bytes[start]) || start == 0 || !is_word_byte(bytes[start - 1]);
        let right_ok =
            !is_word_byte(bytes[end - 1]) || end >= bytes.len() || !is_word_byte(bytes[end]);
        left_ok && right_ok
    };
    for v in verbs {
        let mut vfrom = 0;
        while let Some(vrel) = haystack[vfrom..].find(v) {
            let vpos = vfrom + vrel;
            let vend = vpos + v.len();
            if bounded(vpos, vend) {
                for o in objects {
                    // Scan EVERY object occurrence within the window — a non-bounded
                    // early hit must not mask a later word-bounded one.
                    let mut ofrom = vend;
                    while let Some(orel) = haystack[ofrom..].find(o) {
                        let opos = ofrom + orel;
                        if haystack[vend..opos].chars().count() > window {
                            break; // later occurrences are only farther away
                        }
                        let oend = opos + o.len();
                        if bounded(opos, oend) {
                            return true;
                        }
                        ofrom = oend; // advance past this occurrence (char boundary)
                    }
                }
            }
            vfrom = vend;
        }
    }
    false
}

/// True if any `prog` appears at a LEFT word boundary immediately followed by
/// `\s+\S+` — a destructive program invoked with an argument (TS
/// `\b(?:rm|...)\s+\S+`). Matched as a left-`\b`-bounded substring, NOT by
/// whitespace-token basename equality: a prog glued to a preceding non-word byte
/// still matches at the seam (`啊rm x`, `请rm /data`, `.rm x`, `/bin/rm x`) — the
/// exec-clause analog of the CJK/punct→ASCII glue `co_occurs_within` handles, and
/// faithful to the oracle's `\b` (a non-word→word transition; CJK/`/`/`.`/`-` are all
/// non-word). The right side is `\s+\S+` (whitespace then an argument), NOT a word
/// boundary, so `rmdir foo` / `ddrescue x` do not match (no whitespace after the prog).
/// Reviewer-B C2: token-basename equality missed every CJK/punct-prefixed exec.
fn has_exec_with_arg(haystack: &str, progs: &[&str]) -> bool {
    let bytes = haystack.as_bytes();
    for prog in progs {
        let plen = prog.len();
        let mut from = 0;
        while let Some(rel) = haystack[from..].find(prog) {
            let pos = from + rel;
            let end = pos + plen;
            // Left word boundary: start-of-string, or the preceding byte is non-word.
            let left_ok = pos == 0 || !is_word_byte(bytes[pos - 1]);
            if left_ok {
                // `\s+\S+`: the byte right after `prog` must be whitespace, and some
                // non-whitespace must follow it (an argument). `prog` is ASCII so
                // `end` is a char boundary; iterate chars from there.
                let mut rest = haystack[end..].chars();
                if rest.next().is_some_and(char::is_whitespace) && rest.any(|c| !c.is_whitespace())
                {
                    return true;
                }
            }
            from = pos + 1; // `prog` is ASCII, so `pos + 1` is a char boundary.
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risk_is_ordered() {
        assert!(Risk::ReadOnly < Risk::Low);
        assert!(Risk::Low < Risk::Medium);
        assert!(Risk::Medium < Risk::High);
        assert!(Risk::High < Risk::Critical);
    }

    #[test]
    fn shell_safe_programs_are_safe() {
        assert_eq!(shell_risk("ls -la"), ShellRisk::Safe);
        assert_eq!(shell_risk("grep foo bar.txt"), ShellRisk::Safe);
        assert_eq!(shell_risk("/usr/bin/git status"), ShellRisk::Safe);
        assert_eq!(shell_risk("\"git\" status"), ShellRisk::Safe); // quoted program
        assert_eq!(shell_risk("LS"), ShellRisk::Safe);
        assert_eq!(shell_risk(""), ShellRisk::Safe); // empty command (matches TS)
        assert_eq!(shell_risk("   "), ShellRisk::Safe);
    }

    #[test]
    fn shell_destructive_programs_and_mkfs_variants() {
        assert_eq!(shell_risk("rm -rf build"), ShellRisk::Destructive);
        assert_eq!(shell_risk("/bin/rm x"), ShellRisk::Destructive);
        assert_eq!(
            shell_risk("dd if=/dev/zero of=/dev/sda"),
            ShellRisk::Destructive
        );
        // mkfs.* stem must be recognized.
        assert_eq!(shell_risk("mkfs.ext4 /dev/sda1"), ShellRisk::Destructive);
        assert_eq!(
            shell_risk("/sbin/mkfs.xfs /dev/sdb"),
            ShellRisk::Destructive
        );
    }

    #[test]
    fn shell_metacharacters_and_control_chars_are_blocked() {
        assert_eq!(shell_risk("ls; rm -rf /"), ShellRisk::Blocked);
        assert_eq!(shell_risk("echo $(rm x)"), ShellRisk::Blocked);
        assert_eq!(shell_risk("cat a | sh"), ShellRisk::Blocked);
        assert_eq!(shell_risk("echo x > /etc/passwd"), ShellRisk::Blocked);
        assert_eq!(shell_risk("ls && rm x"), ShellRisk::Blocked);
        assert_eq!(shell_risk("ls\t-l\u{7f}"), ShellRisk::Blocked); // control char
    }

    #[test]
    fn shell_transparent_wrappers_unwrap_to_inner_command() {
        // env/sudo/nice/timeout etc. must not mask a destructive inner command.
        assert_eq!(shell_risk("env rm -rf /data"), ShellRisk::Destructive);
        assert_eq!(
            shell_risk("env FOO=bar rm -rf /data"),
            ShellRisk::Destructive
        );
        assert_eq!(shell_risk("sudo rm -rf /data"), ShellRisk::Destructive);
        assert_eq!(
            shell_risk("sudo -u root rm -rf /data"),
            ShellRisk::Destructive
        );
        assert_eq!(shell_risk("sudo env rm -rf /data"), ShellRisk::Destructive);
        assert_eq!(shell_risk("timeout 5 rm x"), ShellRisk::Destructive);
        assert_eq!(shell_risk("nice -n 10 rm x"), ShellRisk::Destructive);
        // A wrapper around a safe program stays safe.
        assert_eq!(shell_risk("sudo ls -la"), ShellRisk::Safe);
        assert_eq!(shell_risk("env FOO=bar ls"), ShellRisk::Safe);
    }

    #[test]
    fn shell_opaque_and_unparseable_wrappers_require_approval() {
        // `sh -c "…"` is an opaque code string → destructive (approval).
        assert_eq!(shell_risk("sh -c rmstuff"), ShellRisk::Destructive);
        assert_eq!(shell_risk("bash -lc whatever"), ShellRisk::Destructive);
        // An unrecognized wrapper option hides the wrapped command → destructive.
        assert_eq!(shell_risk("sudo --frobnicate rm x"), ShellRisk::Destructive);
    }

    #[test]
    fn shell_dangerous_git_and_find_flags() {
        assert_eq!(shell_risk("git reset --hard"), ShellRisk::Destructive);
        assert_eq!(shell_risk("git reset --har"), ShellRisk::Destructive); // abbreviation
        assert_eq!(shell_risk("git clean -fdx"), ShellRisk::Destructive);
        assert_eq!(
            shell_risk("git checkout --force main"),
            ShellRisk::Destructive
        );
        assert_eq!(
            shell_risk("git -C /repo reset --hard"),
            ShellRisk::Destructive
        );
        assert_eq!(shell_risk("find . -delete"), ShellRisk::Destructive);
        // A non-destructive git/find stays safe.
        assert_eq!(shell_risk("git status"), ShellRisk::Safe);
        assert_eq!(shell_risk("git commit -m wip"), ShellRisk::Safe);
        assert_eq!(shell_risk("find . -name foo"), ShellRisk::Safe);
    }

    #[test]
    fn shell_protected_artifact_and_sensitive_escalations() {
        // protected artifact + destructive keyword.
        assert_eq!(shell_risk("rm data/app.db"), ShellRisk::Destructive); // rm is destructive anyway
                                                                          // sensitive credential assignment.
        assert_eq!(
            shell_risk("export API_TOKEN=newval"),
            ShellRisk::Destructive
        );
        assert_eq!(shell_risk("env token=secretval ls"), ShellRisk::Destructive);
        // sensitive key via mutating interpreter.
        assert_eq!(
            shell_risk("sed -i s/x/y/ token.conf"),
            ShellRisk::Destructive
        );
    }

    #[test]
    fn protected_path_carved_from_joined_tokens() {
        // Reviewer-found destructive->Safe gap: a protected extension joined to other
        // text by a non-path char (comma, quote) or trailed by a suffix must still be
        // carved out and escalated when a destructive keyword is present.
        assert_eq!(shell_risk("git rm report.db,v"), ShellRisk::Destructive); // comma
        assert_eq!(shell_risk("npm remove report.db,v"), ShellRisk::Destructive);
        assert_eq!(shell_risk("delete \"data.sql\""), ShellRisk::Destructive); // quotes
        assert_eq!(shell_risk("delete dump.tar-bak"), ShellRisk::Destructive); // .tar before suffix? .tar carved
                                                                               // No destructive keyword -> not escalated (the .db is referenced read-only).
        assert_eq!(shell_risk("git status report.db"), ShellRisk::Safe);
        // Textual file with a destructive keyword -> not protected (parity with oracle).
        assert_eq!(shell_risk("git rm notes.txt"), ShellRisk::Safe);
        // Bare protected NAME without an extension must NOT over-escalate (no path candidate).
        assert_eq!(shell_risk("remove backup"), ShellRisk::Guarded);
        assert_eq!(shell_risk("delete the database"), ShellRisk::Guarded);
        // The carving helper directly.
        assert!(list_potential_file_paths("git rm report.db,v").contains(&"report.db"));
        assert!(list_potential_file_paths("a.sql,b.txt").contains(&"a.sql"));
    }

    #[test]
    fn shell_unknown_and_interpreters_are_guarded() {
        assert_eq!(shell_risk("frobnicate --yes"), ShellRisk::Guarded);
        assert_eq!(shell_risk("sed -i s/a/b/ f"), ShellRisk::Guarded);
        assert_eq!(shell_risk("chmod 777 x"), ShellRisk::Guarded); // not in destructive set (shared w/ TS)
    }

    #[test]
    fn shell_risk_maps_to_canonical_risk() {
        assert_eq!(ShellRisk::Safe.risk(), Risk::ReadOnly);
        assert_eq!(ShellRisk::Guarded.risk(), Risk::Medium);
        assert_eq!(ShellRisk::Destructive.risk(), Risk::High);
        assert_eq!(ShellRisk::Blocked.risk(), Risk::Critical);
    }

    #[test]
    fn protected_artifacts_match_oracle_with_textual_suppression() {
        // Protected extension always qualifies.
        assert!(touches_protected_artifact("data/app.db"));
        assert!(touches_protected_artifact("dump.SQL"));
        assert!(touches_protected_artifact("backups/2026.tar.gz"));
        // Protected name on a NON-textual extension qualifies.
        assert!(touches_protected_artifact("prod-database.log"));
        assert!(touches_protected_artifact("nightly-snapshot.bin"));
        // Protected name on an obviously-textual file is SUPPRESSED (matches TS).
        assert!(!touches_protected_artifact("app-database.json"));
        assert!(!touches_protected_artifact("nightly-snapshot.yaml"));
        assert!(!touches_protected_artifact("restore.txt"));
        // `_database` has no word boundary before "database" (`_` is a word char).
        assert!(!touches_protected_artifact("the_database_file.bin"));
        assert!(!touches_protected_artifact("src/main.rs"));
    }

    #[test]
    fn sensitive_material_is_word_bounded() {
        assert!(contains_sensitive_material("here is my SECRET value"));
        assert!(contains_sensitive_material("the access-token field"));
        assert!(contains_sensitive_material("a bare token here"));
        assert!(!contains_sensitive_material("the tokenizer module"));
        assert!(!contains_sensitive_material("passwordless is fine"));
        assert!(!contains_sensitive_material("just some text"));
    }

    #[test]
    fn sensitive_assignment_detects_both_forms() {
        assert!(contains_sensitive_assignment("export API_TOKEN=newval"));
        assert!(contains_sensitive_assignment("token=secretvalue"));
        assert!(contains_sensitive_assignment("client_secret=abc"));
        assert!(contains_sensitive_assignment("password: hunter2"));
        assert!(contains_sensitive_assignment("MY_TOKEN_VALUE=x")); // trailing word chars after keyword
        assert!(!contains_sensitive_assignment(
            "just reading a token from a file"
        ));
        assert!(!contains_sensitive_assignment(
            "describe the password policy"
        ));
    }

    #[test]
    fn destructive_request_english() {
        assert!(is_destructive_request(
            "please delete all the files in the workspace"
        ));
        assert!(is_destructive_request("Drop the database table"));
        assert!(is_destructive_request("wipe everything"));
        assert!(is_destructive_request("save my api key for later"));
        assert!(is_destructive_request("store the refresh token please"));
        assert!(is_destructive_request("persist the apikey to disk")); // zero-sep compound key
        assert!(is_destructive_request(
            "disable branch protection on github"
        ));
        assert!(is_destructive_request("rm build/output"));
        assert!(!is_destructive_request(
            "delete this typo in the sentence above"
        ));
        assert!(!is_destructive_request("summarize the meeting notes"));
        assert!(!is_destructive_request("save me a seat at lunch"));
    }

    #[test]
    fn destructive_request_chinese_unw009() {
        assert!(is_destructive_request("请删除工作区里的所有文件"));
        assert!(is_destructive_request("清空数据库"));
        assert!(is_destructive_request("销毁这个仓库的备份"));
        assert!(is_destructive_request("保存我的密钥到磁盘"));
        assert!(is_destructive_request("修改仓库设置和权限"));
        assert!(is_destructive_request("关闭分支保护"));
        assert!(!is_destructive_request("总结一下今天的会议"));
        assert!(!is_destructive_request("写一首关于春天的诗"));
        // C2 CJK parity: revoke token / transfer ownership / delete deployment.
        assert!(is_destructive_request("撤销所有令牌"));
        assert!(is_destructive_request("转移仓库的所有权"));
        assert!(is_destructive_request("删除生产部署"));
    }

    #[test]
    fn destructive_request_high_risk_operations_c2() {
        // Reviewer-B C2: high-risk ops the oracle's lists (and the pre-fix port)
        // under-detected. All must now escalate.
        for t in [
            "turn off branch protection",
            "change the repo visibility to public", // config: change+visibility (public dropped)
            "disable 2fa for all users",            // config: disable+2fa
            "reset the production credentials",     // destruct: reset+credentials
            "revoke all access tokens",
            "rotate the signing key in prod",
            "grant admin to everyone",
            "transfer ownership of the repo",
            "force push to main and overwrite history", // force push+main / overwrite+history
            "delete the production deployment",         // destruct: delete+deployment
            "expose the api key in the logs",
            "leak the secret to the channel",
        ] {
            assert!(is_destructive_request(t), "C2: must escalate {t:?}");
        }
        // Controls — benign asks must NOT be over-flagged. After word-bounding
        // co_occurs_within (reviewer A+B) + dropping the noisy `make` verb and bare
        // `production` object, these no longer spuriously escalate.
        for t in [
            "summarize the meeting notes",
            "explain how oauth tokens work",
            "rotate the image ninety degrees",
            "transfer the call to support",
            "what is branch protection",
            "make a turkey sandwich", // `make`+`key`⊂turkey — dropped+word-bound
            "make a keyboard shortcut",
            "make this method private", // `make` dropped (and bare `private` dropped)
            "remove the tokenizer module", // `token`⊂tokenizer — word-bounded
            "delete the reproduction steps", // `production`⊂reproduction — word-bounded + dropped
            "rotate the production banner image", // bare `production` object dropped
            "the deployment went smoothly", // no verb
            "lawmaker discusses public policy", // `make`⊂lawmaker — dropped+word-bound
            // Reviewer-B C2 round-2 Finding 2: dropping bare `public`/`private` from
            // the config + high-risk object lists de-floods everyday coding asks.
            "change the public API",
            "update the public docs",
            "modify the public interface",
            "set the field to private",
            "expose a public getter",
        ] {
            assert!(!is_destructive_request(t), "C2: must NOT flag benign {t:?}");
        }
    }

    #[test]
    fn destructive_request_cjk_verb_glued_to_ascii_object_c2_round2() {
        // Reviewer A+B C2 round-2/3 BLOCKING regression: the oracle's CJK regex has NO
        // `\b` (pure `(?:verb).{0,80}(?:object)` substring), so a CJK verb glued to an
        // ASCII object must escalate regardless of what byte sits on either side of the
        // object. The CJK clauses now pass `word_bound = false`. Oracle returns true for
        // every case below.
        for t in [
            // round-2: leading CJK→ASCII edge (verb glued to object front).
            "保存token",        // save + credential(token), glued
            "保存token到磁盘",  // …mid-sentence
            "帮我保存token",    // …with a leading verb phrase
            "写入secret",       // write + secret
            "修改provider",     // modify + provider config
            "修改provider配置", // …trailing CJK
            "保存 token",       // the spaced form must keep working too
            // round-3 (Reviewer A): ASCII object suffixed by another word byte.
            "保存tokens", // plural — object trailing edge is a word byte
            "写入secrets",
            "修改providers",
            "保存tokens到磁盘",
            "修改githubactions", // github + "actions"
            // round-3 (Reviewer B): `_`-glued canonical credential identifiers — the
            // single most common token spelling; `_` is a word byte on BOTH edges.
            "写入access_token",
            "保存client_secret",
            "存储refresh_token",
            "保存api_secret",
            "记录access_token到日志",
            "修改provider_config",
            "修改github_settings",
        ] {
            assert!(
                is_destructive_request(t),
                "C2 round-2/3: must escalate {t:?}"
            );
        }
    }

    #[test]
    fn destructive_exec_clause_matches_glued_program_c2() {
        // Reviewer-B C2 F1: a destructive program glued to a preceding NON-word byte
        // (CJK / punctuation / path sep) + a whitespace-delimited argument must
        // escalate — the oracle's `\b(?:rm|...)\s+\S+` fires at the seam.
        for t in [
            "啊rm xyz",
            "请rm /data",
            ".rm x",
            "-rm x",
            "/bin/rm x",
            "rm -rf build", // the plain case still works
        ] {
            assert!(is_destructive_request(t), "F1: must escalate {t:?}");
        }
        // Controls: program embedded inside a larger word (no LEFT boundary) or with no
        // whitespace+argument after it must NOT fire the exec clause (nor any other).
        for t in [
            "set an alarm for noon", // `rm`⊂alarm, left 'a' is a word byte
            "disarm the alert",      // `rm`⊂disarm, left 'a' is a word byte
            "rmdir the folder",      // `rm` then 'd' (no whitespace after the prog)
            "perform the task",      // `rm`⊂perform, left 'o' is a word byte
        ] {
            assert!(
                !is_destructive_request(t),
                "F1 control: must NOT flag {t:?}"
            );
        }
    }

    #[test]
    fn destructive_clean_up_verb_c2() {
        // Reviewer-B C2 F2: `clean up` is its own verb (oracle `clean(?:\s+up)?`) so the
        // in-window object match starts after "up", not after "clean".
        assert!(is_destructive_request("clean up the workspace"));
        assert!(is_destructive_request("please clean up the database"));
    }

    #[test]
    fn destructive_request_no_panic_on_cjk_verb_without_object() {
        // Regression: a CJK verb (3-byte chars) with NO in-window object previously
        // advanced `vfrom` by 1 byte, slicing mid-char and panicking. Must not panic.
        assert!(!is_destructive_request("销毁了我的代码"));
        assert!(!is_destructive_request("保存了一段文字"));
        assert!(!is_destructive_request("修改了一下代码"));
        assert!(!is_destructive_request("删除删除"));
        // BA-construction (object before verb) — not matched (shared TS limit), must not panic.
        let _ = is_destructive_request("把所有文件删除");
        assert!(!is_destructive_request("把所有文件删除")); // verb after object → no match, no panic
    }

    #[test]
    fn destructive_window_is_bounded() {
        let filler = "x ".repeat(200);
        assert!(!is_destructive_request(&format!("delete {filler} files")));
        assert!(is_destructive_request("delete the files"));
    }

    #[test]
    fn unwrap_does_not_panic_on_weird_tokens() {
        // env-assignment skip must not mishandle non-ASCII / empty / lone-dash tokens.
        assert_eq!(shell_risk("程序=rm x"), ShellRisk::Guarded); // CJK name=… is NOT an inline env assignment
        assert_eq!(shell_risk("=rm"), ShellRisk::Guarded);
        let _ = shell_risk("中文=value rm x");
        let _ = shell_risk("- -");
    }

    #[test]
    fn wrapper_multibyte_option_does_not_panic_and_requires_approval() {
        // Reviewer-found CRITICAL: a wrapper option `-<multibyte>` previously sliced
        // `&opt[..2]` mid-char and panicked. Now `opt.get(..2)` returns None → the
        // option is unrecognized → the wrapped command can't be verified → Destructive.
        assert_eq!(shell_risk("sudo -é rm -rf /data"), ShellRisk::Destructive);
        assert_eq!(shell_risk("nice -é ls"), ShellRisk::Destructive);
        assert_eq!(shell_risk("xargs -😀 rm"), ShellRisk::Destructive);
        assert_eq!(shell_risk("timeout -é 5 rm x"), ShellRisk::Destructive);
        assert_eq!(shell_risk("env -中 ls"), ShellRisk::Destructive);
        // A genuine attached-value short option still parses (no panic, unwraps to inner).
        assert_eq!(
            shell_risk("sudo -uroot rm -rf /data"),
            ShellRisk::Destructive
        );
        assert_eq!(shell_risk("sudo -uroot ls"), ShellRisk::Safe);
    }
}
