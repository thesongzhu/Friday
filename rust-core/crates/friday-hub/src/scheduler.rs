//! S10-A — Rust workflow SCHEDULER substrate (DARK). The hub-layer half of slice
//! A: the restricted CRON-SUBSET parser + the minute-granularity UTC `is_due` /
//! `next_due` evaluator, the deterministic `scheduled_run_id` helper (the
//! at-most-once anchor), and `create_schedule` — the create boundary that
//! validates the cron expression FAIL-CLOSED before it ever reaches a stored row
//! (mirroring how `workflow_def`'s linear-only semantic gate lives above the
//! storage row CHECKs; storage cannot run this parser because it cannot depend on
//! friday-hub).
//!
//! ## Cron subset (everything outside it FAILS CLOSED, at insert AND at read)
//! Five space-separated fields: `min hour dom mon dow`. Each field is one of:
//! * `*`                — every value in range,
//! * `*/n`              — every n-th value from the field's minimum (n >= 1, and
//!                        n must not exceed the field's range — `*/0` and an
//!                        oversized step fail closed),
//! * a bare numeric     — a single value, in range,
//! * a comma list of bare numerics (`v1,v2,...`) — each in range.
//!
//! REJECTED (explicit reason, never guessed): names (`MON`, `JAN`), ranges
//! (`1-5`), step-on-a-range or step-in-a-list (`1-3/2`, `*/5,10`), a seconds
//! field (6+ fields), and the extensions `L` / `W` / `#`. Field ranges:
//! minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-6
//! (0 = Sunday; 7 is NOT accepted — the one canonical spelling, fail-closed).
//!
//! ## dom/dow OR-rule (the most-gotten-wrong cron behavior, pinned + KAT'd)
//! Standard Vixie cron: when BOTH day-of-month and day-of-week are RESTRICTED
//! (neither is `*`), a slot matches if EITHER the dom OR the dow matches. When at
//! least one of them is `*`, the day matches only if BOTH the (possibly-`*`) dom
//! and dow match (i.e. the unrestricted one is always-true). Minute/hour/month
//! are always ANDed.
//!
//! ## UTC + minute granularity
//! A "slot" is a UTC minute. Epoch-millis are floored to the minute; the calendar
//! decomposition (year/month/day/day-of-week) uses a vetted civil-from-days
//! algorithm (leap-year correct) — there is no `chrono` dependency in this
//! workspace and tz support is a deliberate v1 deferral (UTC only).
//!
//! Truth label: DARK substrate — no daemon, no tick loop, nothing fires here
//! (the firing tick is slice B). `create_schedule` writes a BORN-DISABLED row;
//! enabling + deploy + WAL flip are operator-gated. NOT v1 GO.

use friday_storage::schedule::{insert_schedule, NewSchedule};
use friday_storage::StorageError;
use rusqlite::Connection;

/// Milliseconds in one minute (a slot).
const MIN_MS: i64 = 60_000;

/// A parsed cron field: the explicit set of matching values for that position.
/// Built once at parse time so matching is a membership test.
#[derive(Clone, Debug, PartialEq, Eq)]
struct CronField {
    /// `true` iff the field was a bare `*` (needed for the dom/dow OR-rule).
    is_star: bool,
    /// The matching values (sorted, deduped) within the field's range.
    values: Vec<u32>,
}

/// A fully parsed restricted cron expression (5 fields).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CronSchedule {
    minute: CronField,
    hour: CronField,
    dom: CronField,
    month: CronField,
    dow: CronField,
}

/// Why a cron expression was rejected. Always carries an explicit, bounded
/// reason — a malformed expression is NEVER guessed/coerced.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CronParseError {
    #[error("cron expression must have exactly 5 fields (min hour dom mon dow), found {found}")]
    WrongFieldCount { found: usize },
    #[error("cron field {field} ('{token}') is empty")]
    EmptyField { field: &'static str, token: String },
    #[error(
        "cron field {field} ('{token}') uses an unsupported form; only '*', '*/n', a bare \
         number, or a comma list of bare numbers are allowed (no names, ranges, '/' on a \
         range or list, seconds, or L/W/# extensions)"
    )]
    UnsupportedForm { field: &'static str, token: String },
    #[error("cron field {field} ('{token}') step must be >= 1 and <= the field range")]
    BadStep { field: &'static str, token: String },
    #[error("cron field {field} value {value} is out of range {min}..={max}")]
    OutOfRange {
        field: &'static str,
        value: u32,
        min: u32,
        max: u32,
    },
}

/// Errors creating a schedule: a fail-closed cron parse, or a storage failure.
#[derive(Debug, thiserror::Error)]
pub enum CreateScheduleError {
    #[error("schedule id must be non-empty")]
    EmptyScheduleId,
    #[error("workflow id must be non-empty")]
    EmptyWorkflowId,
    #[error("cron expression rejected: {0}")]
    Cron(#[from] CronParseError),
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
}

struct FieldSpec {
    name: &'static str,
    min: u32,
    max: u32,
}

const MINUTE: FieldSpec = FieldSpec {
    name: "minute",
    min: 0,
    max: 59,
};
const HOUR: FieldSpec = FieldSpec {
    name: "hour",
    min: 0,
    max: 23,
};
const DOM: FieldSpec = FieldSpec {
    name: "day-of-month",
    min: 1,
    max: 31,
};
const MONTH: FieldSpec = FieldSpec {
    name: "month",
    min: 1,
    max: 12,
};
const DOW: FieldSpec = FieldSpec {
    name: "day-of-week",
    min: 0,
    max: 6,
};

/// Parse one cron field against its [`FieldSpec`], fail-closed.
fn parse_field(spec: &FieldSpec, token: &str) -> Result<CronField, CronParseError> {
    if token.is_empty() {
        return Err(CronParseError::EmptyField {
            field: spec.name,
            token: token.to_string(),
        });
    }

    // `*` — every value in range.
    if token == "*" {
        return Ok(CronField {
            is_star: true,
            values: (spec.min..=spec.max).collect(),
        });
    }

    // `*/n` — every n-th value from the field minimum. ONLY a bare `*/n` (no
    // range step, no list step) is supported.
    if let Some(step_str) = token.strip_prefix("*/") {
        let step: u32 = step_str
            .parse()
            .map_err(|_| CronParseError::UnsupportedForm {
                field: spec.name,
                token: token.to_string(),
            })?;
        // step >= 1 and not larger than the span (a step bigger than the range
        // would only ever match the minimum — reject as almost-certainly a typo,
        // fail-closed rather than silently degenerate).
        let span = spec.max - spec.min;
        if step == 0 || step > span {
            return Err(CronParseError::BadStep {
                field: spec.name,
                token: token.to_string(),
            });
        }
        let values: Vec<u32> = (spec.min..=spec.max).step_by(step as usize).collect();
        return Ok(CronField {
            is_star: false,
            values,
        });
    }

    // A bare number OR a comma list of bare numbers. Each element must parse as a
    // plain integer in range — anything else (names, ranges, embedded steps)
    // fails closed.
    let mut values: Vec<u32> = Vec::new();
    for element in token.split(',') {
        if element.is_empty() {
            return Err(CronParseError::UnsupportedForm {
                field: spec.name,
                token: token.to_string(),
            });
        }
        // Reject any non-digit byte explicitly (so `1-3`, `MON`, `*/2` inside a
        // list, `+5`, ` 5` all fail closed rather than parse-erroring ambiguously).
        if !element.bytes().all(|b| b.is_ascii_digit()) {
            return Err(CronParseError::UnsupportedForm {
                field: spec.name,
                token: token.to_string(),
            });
        }
        let v: u32 = element
            .parse()
            .map_err(|_| CronParseError::UnsupportedForm {
                field: spec.name,
                token: token.to_string(),
            })?;
        if v < spec.min || v > spec.max {
            return Err(CronParseError::OutOfRange {
                field: spec.name,
                value: v,
                min: spec.min,
                max: spec.max,
            });
        }
        values.push(v);
    }
    values.sort_unstable();
    values.dedup();
    Ok(CronField {
        is_star: false,
        values,
    })
}

/// Parse a restricted 5-field cron expression, fail-closed. The single
/// chokepoint used at BOTH insert-time validation and the due-check (so a row
/// can never become live with an expression the evaluator would later choke on).
pub fn parse_cron(expr: &str) -> Result<CronSchedule, CronParseError> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(CronParseError::WrongFieldCount {
            found: fields.len(),
        });
    }
    Ok(CronSchedule {
        minute: parse_field(&MINUTE, fields[0])?,
        hour: parse_field(&HOUR, fields[1])?,
        dom: parse_field(&DOM, fields[2])?,
        month: parse_field(&MONTH, fields[3])?,
        dow: parse_field(&DOW, fields[4])?,
    })
}

/// A UTC wall-clock decomposition of a minute slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UtcMinute {
    minute: u32,
    hour: u32,
    /// day-of-month, 1..=31
    dom: u32,
    /// month, 1..=12
    month: u32,
    /// day-of-week, 0=Sunday .. 6=Saturday
    dow: u32,
}

/// Decompose an epoch-millis instant into its UTC minute fields. Uses Howard
/// Hinnant's `civil_from_days` algorithm (public-domain, leap-year correct for
/// the full proleptic Gregorian range) for the date part; the day-of-week is the
/// same algorithm's well-known epoch anchor (1970-01-01 was a Thursday).
fn utc_minute_from_ms(ms: i64) -> UtcMinute {
    // Floor-divide to seconds then to days/seconds-of-day (works for negatives).
    let total_secs = ms.div_euclid(1000);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let days = total_secs.div_euclid(86_400); // days since 1970-01-01 (can be negative)

    let minute = ((secs_of_day / 60) % 60) as u32;
    let hour = (secs_of_day / 3600) as u32;

    // day-of-week: 1970-01-01 is a Thursday (=4 in 0=Sun..6=Sat).
    let dow = (days.rem_euclid(7) + 4).rem_euclid(7) as u32;

    // civil_from_days (Hinnant): days are relative to 1970-01-01.
    let z = days + 719_468; // shift epoch to 0000-03-01
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
                                                   // (the calendar YEAR is intentionally not retained — cron has no year field,
                                                   // so matching never needs it; the `era`/`yoe` intermediates exist only to
                                                   // resolve month + day-of-month correctly across leap years.)

    UtcMinute {
        minute,
        hour,
        dom: d as u32,
        month: m as u32,
        dow,
    }
}

/// Does this cron schedule match the given UTC minute slot? Applies the standard
/// Vixie dom/dow OR-rule (see module docs).
fn matches(cron: &CronSchedule, t: &UtcMinute) -> bool {
    if !cron.minute.values.contains(&t.minute) {
        return false;
    }
    if !cron.hour.values.contains(&t.hour) {
        return false;
    }
    if !cron.month.values.contains(&t.month) {
        return false;
    }
    let dom_match = cron.dom.values.contains(&t.dom);
    let dow_match = cron.dow.values.contains(&t.dow);
    if !cron.dom.is_star && !cron.dow.is_star {
        // Both restricted → OR.
        dom_match || dow_match
    } else {
        // At least one is `*` (always-true) → AND (the unrestricted one is true).
        dom_match && dow_match
    }
}

/// Floor an epoch-millis instant to its minute slot (epoch-millis at second 0 of
/// the minute). The canonical slot identity used for receipts + deterministic
/// run ids.
pub fn slot_floor_ms(ms: i64) -> i64 {
    ms.div_euclid(MIN_MS) * MIN_MS
}

/// Is the schedule due AT the minute slot containing `slot_ms`? (Floors to the
/// minute first.)
pub fn is_due(cron: &CronSchedule, slot_ms: i64) -> bool {
    let floored = slot_floor_ms(slot_ms);
    matches(cron, &utc_minute_from_ms(floored))
}

/// The next minute slot (epoch-millis, floored) STRICTLY AFTER `after_ms` at
/// which the schedule is due, or `None` if none occurs within the forward search
/// bound. The bound exists so a GENUINELY-impossible expression (e.g. Feb 30,
/// which the dom/dow rule can never satisfy) returns `None` instead of looping
/// forever — and `None` therefore unambiguously means "never fires," NOT "I
/// didn't look far enough."
///
/// The bound must exceed the LONGEST gap between consecutive firings of any
/// SATISFIABLE expression. That worst case is a leap-day schedule
/// (`"0 0 29 2 *"`): consecutive Feb-29s can be up to 8 years apart across a
/// non-leap century boundary (e.g. 2096 → 2104, since 2100 is not a leap year),
/// ~2922 days. So `8 * 366` days (2928) covers it with margin; ~4.2M minute
/// iterations is sub-second and this is off the firing hot path anyway.
pub fn next_due(cron: &CronSchedule, after_ms: i64) -> Option<i64> {
    // Start at the next minute boundary strictly after `after_ms`.
    let start = slot_floor_ms(after_ms) + MIN_MS;
    const MAX_MINUTES: i64 = 8 * 366 * 24 * 60;
    let mut slot = start;
    for _ in 0..MAX_MINUTES {
        if matches(cron, &utc_minute_from_ms(slot)) {
            return Some(slot);
        }
        slot += MIN_MS;
    }
    None
}

/// The DETERMINISTIC run id for a scheduled fire: `sched:<schedule_id>:<slot_ts>`
/// where `slot_ts` is the floored UTC-minute epoch-millis of the due slot. This
/// is the at-most-once ANCHOR — the future tick (slice B) passes this id to the
/// engine's `run_workflow`, whose first act is `create_run` with `run_id` as the
/// PRIMARY KEY, so two daemons racing the same slot produce exactly one winning
/// INSERT and the loser fails closed on the duplicate PK. This slice builds and
/// tests the FORMATTER ONLY; it wires NO firing.
pub fn scheduled_run_id(schedule_id: &str, slot_ts: i64) -> String {
    format!("sched:{schedule_id}:{slot_ts}")
}

/// Create a schedule at the only legitimate create boundary: validate the cron
/// expression FAIL-CLOSED (rejecting anything outside the restricted subset)
/// BEFORE it reaches a stored row, then insert a BORN-DISABLED schedule. This is
/// the hub-layer create gate; callers MUST use it rather than
/// `friday_storage::schedule::insert_schedule` directly so a row can never be
/// created with an expression the due-check evaluator would later reject.
///
/// Born disabled: creating a schedule never starts firing; enabling is a
/// separate explicit operator act (`friday_storage::schedule::set_enabled`).
pub fn create_schedule(
    conn: &Connection,
    schedule_id: &str,
    workflow_id: &str,
    cron_expr: &str,
    now: i64,
) -> Result<(), CreateScheduleError> {
    if schedule_id.trim().is_empty() {
        return Err(CreateScheduleError::EmptyScheduleId);
    }
    if workflow_id.trim().is_empty() {
        return Err(CreateScheduleError::EmptyWorkflowId);
    }
    // Fail-closed cron validation at insert time (the second guard is the
    // due-check re-parse in the future tick).
    parse_cron(cron_expr)?;
    insert_schedule(
        conn,
        &NewSchedule {
            schedule_id,
            workflow_id,
            cron_expr,
        },
        now,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- date decomposition KATs (the off-by-one trap) ----------------------

    fn ymd_hm_to_ms(y: i64, m: i64, d: i64, h: i64, min: i64) -> i64 {
        // Inverse civil_from_days (days_from_civil, Hinnant) for building test
        // instants independently of the code under test.
        let yy = if m <= 2 { y - 1 } else { y };
        let era = if yy >= 0 { yy } else { yy - 399 } / 400;
        let yoe = yy - era * 400;
        let mp = if m > 2 { m - 3 } else { m + 9 };
        let doy = (153 * mp + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        (days * 86_400 + h * 3600 + min * 60) * 1000
    }

    #[test]
    fn utc_minute_decomposition_known_dates() {
        // 1970-01-01 00:00 UTC = epoch 0, Thursday (dow=4).
        let t0 = utc_minute_from_ms(0);
        assert_eq!(
            (t0.minute, t0.hour, t0.dom, t0.month, t0.dow),
            (0, 0, 1, 1, 4)
        );
        // 2000-02-29 (leap day) 13:37 UTC — leap-year correctness.
        let leap = utc_minute_from_ms(ymd_hm_to_ms(2000, 2, 29, 13, 37));
        assert_eq!(
            (leap.minute, leap.hour, leap.dom, leap.month),
            (37, 13, 29, 2)
        );
        // 2021-03-01 is a Monday (dow=1); 2026-06-10 is a Wednesday (dow=3).
        let mon = utc_minute_from_ms(ymd_hm_to_ms(2021, 3, 1, 0, 0));
        assert_eq!(mon.dow, 1);
        let wed = utc_minute_from_ms(ymd_hm_to_ms(2026, 6, 10, 0, 0));
        assert_eq!(wed.dow, 3);
        // A pre-epoch instant decomposes correctly (negative days path).
        let pre = utc_minute_from_ms(ymd_hm_to_ms(1969, 12, 31, 23, 59));
        assert_eq!((pre.dom, pre.month, pre.minute, pre.hour), (31, 12, 59, 23));
    }

    // --- parser ACCEPT KATs --------------------------------------------------

    #[test]
    fn parses_star_step_numeric_and_list() {
        // every minute
        assert!(parse_cron("* * * * *").is_ok());
        // top of every hour
        let c = parse_cron("0 * * * *").unwrap();
        assert_eq!(c.minute.values, vec![0]);
        assert!(c.hour.is_star);
        // */15 minute -> 0,15,30,45
        let c = parse_cron("*/15 * * * *").unwrap();
        assert_eq!(c.minute.values, vec![0, 15, 30, 45]);
        // comma list, deduped + sorted
        let c = parse_cron("30,0,30 9,17 * * *").unwrap();
        assert_eq!(c.minute.values, vec![0, 30]);
        assert_eq!(c.hour.values, vec![9, 17]);
        // dow 0..6 incl Sunday=0
        let c = parse_cron("0 0 * * 0").unwrap();
        assert_eq!(c.dow.values, vec![0]);
        // boundary values
        assert!(parse_cron("59 23 31 12 6").is_ok());
        assert!(parse_cron("0 0 1 1 0").is_ok());
    }

    // --- parser FAIL-CLOSED KATs (one per rejected family) -------------------

    #[test]
    fn rejects_wrong_field_count() {
        assert!(matches!(
            parse_cron("* * * *"),
            Err(CronParseError::WrongFieldCount { found: 4 })
        ));
        // a seconds field (6 fields) fails closed
        assert!(matches!(
            parse_cron("0 * * * * *"),
            Err(CronParseError::WrongFieldCount { found: 6 })
        ));
        assert!(matches!(
            parse_cron(""),
            Err(CronParseError::WrongFieldCount { found: 0 })
        ));
    }

    #[test]
    fn rejects_names() {
        assert!(matches!(
            parse_cron("0 0 * JAN *"),
            Err(CronParseError::UnsupportedForm { .. })
        ));
        assert!(matches!(
            parse_cron("0 0 * * MON"),
            Err(CronParseError::UnsupportedForm { .. })
        ));
    }

    #[test]
    fn rejects_ranges() {
        assert!(matches!(
            parse_cron("0 0 * * 1-5"),
            Err(CronParseError::UnsupportedForm { .. })
        ));
        // step-on-a-range
        assert!(matches!(
            parse_cron("0 0-10/2 * * *"),
            Err(CronParseError::UnsupportedForm { .. })
        ));
    }

    #[test]
    fn rejects_step_inside_a_list_and_bad_steps() {
        // a `*/n` element inside a comma list is not a bare numeric
        assert!(matches!(
            parse_cron("*/5,10 * * * *"),
            Err(CronParseError::UnsupportedForm { .. })
        ));
        // */0 is a bad step
        assert!(matches!(
            parse_cron("*/0 * * * *"),
            Err(CronParseError::BadStep { .. })
        ));
        // a step larger than the field range fails closed
        assert!(matches!(
            parse_cron("*/60 * * * *"),
            Err(CronParseError::BadStep { .. })
        ));
    }

    #[test]
    fn rejects_lwhash_and_out_of_range() {
        assert!(matches!(
            parse_cron("0 0 L * *"),
            Err(CronParseError::UnsupportedForm { .. })
        ));
        assert!(matches!(
            parse_cron("0 0 15W * *"),
            Err(CronParseError::UnsupportedForm { .. })
        ));
        assert!(matches!(
            parse_cron("0 0 * * 1#2"),
            Err(CronParseError::UnsupportedForm { .. })
        ));
        // dow=7 is NOT accepted (one canonical Sunday spelling = 0)
        assert!(matches!(
            parse_cron("0 0 * * 7"),
            Err(CronParseError::OutOfRange { value: 7, .. })
        ));
        // minute 60 out of range
        assert!(matches!(
            parse_cron("60 0 * * *"),
            Err(CronParseError::OutOfRange { value: 60, .. })
        ));
        // dom 0 out of range (dom is 1-based)
        assert!(matches!(
            parse_cron("0 0 0 * *"),
            Err(CronParseError::OutOfRange { value: 0, .. })
        ));
    }

    // --- is_due / matching KATs ---------------------------------------------

    #[test]
    fn is_due_minute_hour_match() {
        // "30 9 * * *" -> 09:30 UTC daily.
        let c = parse_cron("30 9 * * *").unwrap();
        assert!(is_due(&c, ymd_hm_to_ms(2026, 6, 10, 9, 30)));
        // not due at 09:31, not at 10:30
        assert!(!is_due(&c, ymd_hm_to_ms(2026, 6, 10, 9, 31)));
        assert!(!is_due(&c, ymd_hm_to_ms(2026, 6, 10, 10, 30)));
        // floors within-minute timestamps to the slot (second 45 still due)
        assert!(is_due(&c, ymd_hm_to_ms(2026, 6, 10, 9, 30) + 45_000));
    }

    #[test]
    fn dom_dow_or_rule_when_both_restricted() {
        // "0 0 13 * 5": midnight on the 13th OR on a Friday (dow=5). 2026-06-10
        // is a Wednesday (dow=3) and the 10th — neither matches.
        let c = parse_cron("0 0 13 * 5").unwrap();
        assert!(!is_due(&c, ymd_hm_to_ms(2026, 6, 10, 0, 0)));
        // 2026-06-12 is a Friday (dow=5) but the 12th -> dow matches => due (OR).
        assert!(is_due(&c, ymd_hm_to_ms(2026, 6, 12, 0, 0)));
        // 2026-06-13 is the 13th (a Saturday, dow=6) -> dom matches => due (OR).
        assert!(is_due(&c, ymd_hm_to_ms(2026, 6, 13, 0, 0)));
    }

    #[test]
    fn dom_dow_and_rule_when_one_is_star() {
        // "0 0 13 * *": only the 13th, any weekday (dow=*) -> AND with always-true.
        let c = parse_cron("0 0 13 * *").unwrap();
        assert!(is_due(&c, ymd_hm_to_ms(2026, 6, 13, 0, 0)));
        assert!(!is_due(&c, ymd_hm_to_ms(2026, 6, 12, 0, 0)));
        // "0 0 * * 5": only Friday, any dom -> AND with always-true.
        let c = parse_cron("0 0 * * 5").unwrap();
        assert!(is_due(&c, ymd_hm_to_ms(2026, 6, 12, 0, 0))); // Friday
        assert!(!is_due(&c, ymd_hm_to_ms(2026, 6, 13, 0, 0))); // Saturday
    }

    // --- next_due KATs incl. the bounded never-fires case --------------------

    #[test]
    fn next_due_finds_following_slot() {
        let c = parse_cron("30 9 * * *").unwrap();
        // strictly AFTER 09:30 today -> 09:30 tomorrow.
        let at = ymd_hm_to_ms(2026, 6, 10, 9, 30);
        let next = next_due(&c, at).unwrap();
        assert_eq!(next, ymd_hm_to_ms(2026, 6, 11, 9, 30));
        // strictly after means the same-slot is skipped even if currently due.
        assert!(next > at);
    }

    #[test]
    fn next_due_returns_none_for_impossible_expr() {
        // Feb 30 never exists, and with dow=* the AND-rule requires BOTH dom and
        // dow, so day 30 in month 2 never matches -> bounded search returns None
        // (the bound is sized so None means "genuinely never," not "I gave up").
        let c = parse_cron("0 0 30 2 *").unwrap();
        assert_eq!(next_due(&c, 0), None);
    }

    #[test]
    fn next_due_finds_leap_day_across_a_multi_year_gap() {
        // "0 0 29 2 *" (midnight on Feb 29) fires only in leap years. From a
        // non-leap-year instant the next firing can be YEARS away — the bound MUST
        // be large enough that this returns a real slot and NOT a false None (the
        // bug a one-year bound would cause). From 1970-01-01 the next Feb 29 is in
        // 1972.
        let c = parse_cron("0 0 29 2 *").unwrap();
        let next =
            next_due(&c, 0).expect("a leap-day schedule DOES fire — must not be a false None");
        assert_eq!(next, ymd_hm_to_ms(1972, 2, 29, 0, 0));
        // And across a NON-leap century boundary (the 8-year worst case): the next
        // Feb 29 strictly after 2096-02-29 is 2104-02-29 (2100 is not a leap year).
        let after_2096 = ymd_hm_to_ms(2096, 2, 29, 0, 0);
        let next = next_due(&c, after_2096).expect("8-year gap must still resolve");
        assert_eq!(next, ymd_hm_to_ms(2104, 2, 29, 0, 0));
    }

    // --- scheduled_run_id KAT (the at-most-once anchor) ----------------------

    #[test]
    fn scheduled_run_id_is_deterministic_and_exact() {
        assert_eq!(
            scheduled_run_id("daily", 1_700_000_040_000),
            "sched:daily:1700000040000"
        );
        // same inputs -> identical id (the dup-PK claim depends on this).
        assert_eq!(scheduled_run_id("s", 60_000), scheduled_run_id("s", 60_000));
        // distinct slots -> distinct ids.
        assert_ne!(scheduled_run_id("s", 0), scheduled_run_id("s", 60_000));
    }
}
