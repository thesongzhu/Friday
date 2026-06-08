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
//! as `extra` so its exact blocking set is preserved — now unioned with a broadened
//! common path set.
//!
//! Broadening note (defense-in-depth, inert today): the common path set now covers
//! `/home/`, `/var/`, `/tmp/`, `/etc/` in addition to the original `/Users/`,
//! `/private/`. Nothing dynamic currently reaches these outputs as an absolute path
//! (proof refs are hex fingerprints, not paths; relative tool filenames have no
//! leading slash), so this strictly tightens the guard without changing any bin's
//! verified safe output.

/// Common forbidden markers checked for EVERY proof bin: secret-header / api-key
/// markers and absolute-path markers across the common Unix path roots.
///
/// `sk-` covers OpenAI-style keys; `Authorization` / `Bearer` cover auth headers.
/// The path markers reject any absolute filesystem path leaking into a refs-only
/// payload (which should only ever carry hashes/lengths/counts/redacted refs).
pub const COMMON_MARKERS: &[&str] = &[
    "Authorization",
    "Bearer",
    "sk-",
    "/Users/",
    "/private/",
    "/home/",
    "/var/",
    "/tmp/",
    "/etc/",
];

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
        for (input, marker) in [
            (r#"{"p":"/Users/op/x"}"#, "/Users/"),
            (r#"{"p":"/private/tmp/x"}"#, "/private/"),
            (r#"{"p":"/home/op/x"}"#, "/home/"),
            (r#"{"p":"/var/db/x"}"#, "/var/"),
            (r#"{"p":"/tmp/x"}"#, "/tmp/"),
            (r#"{"p":"/etc/passwd"}"#, "/etc/"),
        ] {
            assert_eq!(
                reject_forbidden_output(input, &[]).err().as_deref(),
                Some(marker),
                "path marker {marker} must trip the guard"
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
    fn safe_label_with_no_marker_does_not_false_trip() {
        // Labels/words that merely resemble a marker but lack the exact substring.
        // "task_count" contains no `"task"` (quoted) and no path/secret marker.
        assert!(reject_forbidden_output(r#"{"task_count":4,"vary":7}"#, &["\"task\""]).is_ok());
        // "etcetera" must not trip `/etc/` (no slashes), "tmpfile" must not trip `/tmp/`.
        assert!(reject_forbidden_output(r#"{"note":"etcetera tmpfile homevar"}"#, &[]).is_ok());
    }
}
