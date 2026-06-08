//! Shared refs-only output guard for the friday-hub proof bins.
//!
//! Several proof bins (`hub_run_task`, `hub_run_readback`, `hub_providers_detect`,
//! `diagnostics_snapshot`, `hub_authed_run`, `hub_resume_approval`,
//! `mission_workbench_projection`) each render a refs-only payload (hashes, lengths,
//! counts, booleans, redacted proof refs, static labels) and, as defense-in-depth,
//! refuse to print if any forbidden marker leaked into that payload. Previously each
//! bin carried its OWN copy-pasted marker list + scan loop; copy-pasting a SECURITY
//! guard risks drift (a fix to one not propagating, a new bin copying a stale list).
//!
//! This module hosts the single source of truth for the COMMON marker set (secret
//! markers + absolute-path markers) and the scan loop. Each bin passes its
//! bin-specific body-field markers (e.g. `final_message"`, `"task"`, `authMethod`)
//! as `extra` so its exact blocking set is preserved.
//!
//! ## Pure DRY consolidation — behavior is byte-identical to pre-#595
//! This is ONLY a de-duplication: [`COMMON_MARKERS`] MATCHES the pre-existing
//! per-bin common set EXACTLY (`Authorization`, `Bearer`, `sk-`, `/Users/`,
//! `/private/`), and each bin's `extra` carries exactly its original bin-specific
//! markers. So every bin's blocking set — and therefore its emit/refuse decision on
//! every input — is unchanged from before the consolidation; the only thing removed
//! was the copy-paste.
//!
//! ## Broadening to `/home,/var,/tmp,/etc` was DROPPED (suggestion #592 refuted)
//! An earlier pass added `/home/`, `/var/`, `/tmp/`, `/etc/` to the common set as a
//! "tighten the guard" measure. That is WRONG and was reverted: these are bare
//! SUBSTRING matches, and a legitimately-contained RELATIVE tool path can have an
//! interior directory segment literally named `etc`/`var`/`tmp`/`home` (e.g.
//! `config/etc/app.conf`). `hub_run_readback` surfaces such relative paths verbatim
//! inside `tool.executed:` event kinds, so `/etc/` matched the `…/etc/…` substring
//! and fail-closed a previously-passing readback (exit 2, `output_guard`) — a real
//! over-block / availability regression with no offsetting leak prevented (proof
//! refs are hex fingerprints, not paths). The #592 "broaden markers" suggestion is
//! refuted and recorded here for the record.
//!
//! (Note: even `/Users/` and `/private/` are substring matches that could, in
//! principle, over-block a relative path containing those exact directory names.
//! That is PRE-EXISTING behavior, preserved exactly — it is NOT changed here.)

/// Common forbidden markers checked for EVERY proof bin: secret-header / api-key
/// markers and the two absolute-path markers that match the pre-#595 per-bin set.
///
/// `sk-` covers OpenAI-style keys; `Authorization` / `Bearer` cover auth headers.
/// `/Users/` and `/private/` reject a macOS absolute path leaking into a refs-only
/// payload (which should only ever carry hashes/lengths/counts/redacted refs).
/// Deliberately NOT broadened to `/home,/var,/tmp,/etc` — see the module docs: those
/// bare substrings over-block legitimate relative tool paths with such interior
/// directory segments (`config/etc/app.conf`) and broke a `hub_run_readback`.
pub const COMMON_MARKERS: &[&str] = &["Authorization", "Bearer", "sk-", "/Users/", "/private/"];

/// Defense-in-depth: scan `rendered` for any forbidden marker and refuse (Err) if
/// one is present. Always checks [`COMMON_MARKERS`]; additionally checks each marker
/// in `extra` (the calling bin's body-field markers that must never appear).
///
/// On a hit, returns `Err(<matched marker>)` so the caller can map it into its own
/// error type (and, for bins that surface the marker in a message, keep that text).
/// A pure function — no I/O — so it is trivially testable and side-effect free.
pub fn reject_forbidden_output(rendered: &str, extra: &[&str]) -> Result<(), String> {
    for marker in COMMON_MARKERS.iter().chain(extra.iter()) {
        if rendered.contains(marker) {
            return Err((*marker).to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_common_secret_marker_trips_the_guard() {
        for (input, marker) in [
            (r#"{"h":"Authorization: x"}"#, "Authorization"),
            (r#"{"x":"Bearer abc"}"#, "Bearer"),
            (r#"{"x":"sk-secret"}"#, "sk-"),
        ] {
            assert_eq!(
                reject_forbidden_output(input, &[]).err().as_deref(),
                Some(marker),
                "secret marker {marker} must trip the guard"
            );
        }
    }

    #[test]
    fn every_common_path_marker_trips_the_guard() {
        // ONLY the two pre-#595 absolute-path markers — `/home,/var,/tmp,/etc` were
        // dropped (they over-block legit relative paths; see the over-block regression
        // test below and the module docs).
        for (input, marker) in [
            (r#"{"p":"/Users/op/x"}"#, "/Users/"),
            (r#"{"p":"/private/etc/x"}"#, "/private/"),
        ] {
            assert_eq!(
                reject_forbidden_output(input, &[]).err().as_deref(),
                Some(marker),
                "path marker {marker} must trip the guard"
            );
        }
    }

    #[test]
    fn dropped_unix_root_markers_no_longer_trip_as_absolute_paths() {
        // These ABSOLUTE paths were tripped by #595's broadened common set; that
        // broadening is reverted, so they now pass (matching pre-#595 behavior). This
        // is intentional: the original per-bin guards never listed these roots.
        for input in [
            r#"{"p":"/home/op/x"}"#,
            r#"{"p":"/var/db/x"}"#,
            r#"{"p":"/tmp/x"}"#,
            r#"{"p":"/etc/passwd"}"#,
        ] {
            assert!(
                reject_forbidden_output(input, &[]).is_ok(),
                "dropped marker must NOT trip the guard for input {input}"
            );
        }
    }

    #[test]
    fn extra_markers_trip_the_guard() {
        // A bin-specific body-field marker that is NOT in the common set.
        assert_eq!(
            reject_forbidden_output(r#"{"final_message":"hi"}"#, &["final_message\""])
                .err()
                .as_deref(),
            Some("final_message\"")
        );
        assert_eq!(
            reject_forbidden_output(r#"{"x":"authMethod"}"#, &["authMethod"])
                .err()
                .as_deref(),
            Some("authMethod")
        );
        // The SAME string passes when its marker is NOT supplied as an extra
        // (proving extras are additive, not baked into the common set).
        assert!(reject_forbidden_output(r#"{"x":"authMethod"}"#, &[]).is_ok());
    }

    #[test]
    fn safe_refs_only_payload_passes() {
        // Hashes, lengths, counts, booleans, redacted proof refs, static labels.
        let safe = r#"{"truth_label":"rust_wired_dev","proof_only":true,"ok":true,"final_message_sha256":"00ab","final_message_len":3,"turns":2,"executed_tools":1,"selectedRoute":"proof://route-decision/0a1b2c3d4e5f6071"}"#;
        assert!(reject_forbidden_output(safe, &["final_message\""]).is_ok());
    }

    #[test]
    fn relative_tool_filename_does_not_false_trip() {
        // event_kinds carries free-form `tool.executed:` strings with RELATIVE
        // filenames (no leading slash) — these are intentionally NOT forbidden.
        let input = r#"{"event_kinds":["plan.none","tool.executed:read 15 bytes from notes.md","agent.finished"]}"#;
        assert!(reject_forbidden_output(input, &["\"task\""]).is_ok());
    }

    #[test]
    fn interior_dir_segment_named_like_a_unix_root_does_not_false_trip() {
        // REGRESSION (over-block introduced by #595's broadened common set, now
        // reverted): a LEGITIMATELY-contained RELATIVE tool path may have an interior
        // directory segment literally named `etc`/`var`/`tmp`/`home`. Such a path
        // (no leading slash) is surfaced verbatim inside a `tool.executed:` event
        // kind in `hub_run_readback`'s success payload. The broadened markers
        // (`/etc/`,`/var/`,`/tmp/`,`/home/`) matched the `/etc/` substring inside
        // `config/etc/app.conf` and fail-closed the WHOLE readback (exit 2,
        // `output_guard`) — a previously-passing readback. With the common set back
        // to the original (no Unix-root path markers beyond `/Users/`,`/private/`),
        // these interior segments are permitted again.
        let readback = r#"{"event_kinds":["tool.executed:read 15 bytes from config/etc/app.conf","tool.executed:write 8 bytes to data/var/state.json","tool.executed:read 4 bytes from cache/tmp/scratch","agent.finished"]}"#;
        assert!(
            reject_forbidden_output(readback, &["\"task\""]).is_ok(),
            "interior etc/var/tmp/home dir segments in a relative tool path must not trip the guard"
        );
        // Also as bare interior segments without the tool-event wrapper.
        assert!(reject_forbidden_output(r#"{"p":"a/home/b"}"#, &[]).is_ok());
        assert!(reject_forbidden_output(r#"{"p":"x/etc/y"}"#, &[]).is_ok());
    }

    #[test]
    fn safe_label_with_no_marker_does_not_false_trip() {
        // Labels/words that merely resemble a marker but lack the exact substring.
        // "task_count" contains no `"task"` (quoted) and no path/secret marker.
        assert!(reject_forbidden_output(r#"{"task_count":4,"vary":7}"#, &["\"task\""]).is_ok());
        // Words resembling a (now-dropped) Unix root — `etcetera`/`tmpfile`/`homevar` —
        // carry no common/secret marker and pass.
        assert!(reject_forbidden_output(r#"{"note":"etcetera tmpfile homevar"}"#, &[]).is_ok());
    }
}
