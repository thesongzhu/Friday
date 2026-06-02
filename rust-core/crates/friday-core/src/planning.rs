//! Agent planning classification + plan state machine (`39` §2 group A / PR-5).
//!
//! A pure port of the **classification + state** core of the TS oracle
//! `src/agent/runtime/friday-agent-planning-gate.ts`:
//!
//! - [`classify_kind`] decides which planning kind a task is, mirroring the
//!   oracle's `detectPlanningKind` **decision order**: a destructive / high-risk
//!   action escalates to [`PlanningKind::MajorDecision`] first, ordinary Q&A /
//!   summarization bypasses the gate (`None`), then the kind hints are matched in
//!   the oracle's order, with the major-decision catch-alls last.
//! - [`PlanState`] is the awaiting-clarification → awaiting-plan-approval →
//!   approved/rejected lifecycle, encoded with the **same** state-machine idiom
//!   as `workflow::WorkflowRunState` (`can_transition_to` / `try_transition` /
//!   `is_terminal`, rejecting illegal transitions with
//!   `CoreError::InvalidTransition`).
//!
//! Faithful-divergence note: for the destructive/high-risk escalation the oracle
//! uses its own `DESTRUCTIVE_ACTION_HINTS` / `DESTRUCTIVE_ACTION_CJK_HINTS`
//! regexes. As directed (PR-5), we instead **reuse**
//! [`crate::tool_policy::is_destructive_request`] — the already-on-main,
//! multilingual (EN + CJK) destructive detector — rather than re-implementing a
//! parallel regex. The two detectors are not byte-identical, but both flag the
//! same destructive intent (delete files/repos/DBs, persist credentials, mutate
//! GitHub/permission/repo settings); reusing the shared one avoids divergence
//! between the gate and the tool policy.
//!
//! Scope note: `classify_kind(task)` is a pure function of the task text only.
//! It ports the **entire text-only** decision order of `detectPlanningKind`:
//! destructive-escalation → QA-bypass → the four kind hints → the three
//! `VAGUE_*` heuristics (deliverable / improvement / strategic-plan, which are
//! themselves pure functions of the task text) → the `MAJOR_DECISION` catch-all.
//!
//! Two genuinely **context-dependent** inputs of the oracle are not ported here
//! because they need runtime state this pure core does not have: the
//! `reviewRequired` flag (forces `major_decision`) and the caller's
//! `operationalMode === "plan"` forcing (forces `major_decision` unless
//! `shouldBypassForcedPlanMode`). Those live in the Hub runtime slice.
//!
//! One **text-only** branch is omitted by a deliberate choice rather than for
//! context: the oracle's `isInformationalHighRiskGuidance` exemption
//! (`INFORMATIONAL_HIGH_RISK_GUIDANCE_HINTS && !DIRECT_HIGH_RISK_ACTION_HINTS`),
//! which lets a purely informational high-risk question ("explain how to safely
//! delete a file") bypass the gate. We do NOT apply that exemption, so such a
//! question OVER-escalates to `MajorDecision` here instead of `None`. This is the
//! safe direction (over-planning an informational ask is harmless; missing a real
//! destructive action is not); porting the gnarly `DIRECT_HIGH_RISK_ACTION_HINTS`
//! alternation for exact parity is left to the coordinator.

use crate::error::CoreError;
use crate::tool_policy::is_destructive_request;

/// The kind of planning a task requires (the oracle's `FridayPlanningKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanningKind {
    /// Generate a new Friday skill.
    GenerateSkill,
    /// Generate / create a workflow, automation, or pipeline.
    GenerateWorkflow,
    /// Deploy / publish / ship / roll out a workflow.
    DeployWorkflow,
    /// Export / package a workflow into a bundle.
    ExportBundle,
    /// A high-stakes decision (architecture/strategy/migration/…), OR any
    /// destructive / high-risk action that must be planned before it runs.
    MajorDecision,
}

impl PlanningKind {
    /// Stable string form (mirrors the oracle's union members).
    pub fn as_str(&self) -> &'static str {
        match self {
            PlanningKind::GenerateSkill => "generate_skill",
            PlanningKind::GenerateWorkflow => "generate_workflow",
            PlanningKind::DeployWorkflow => "deploy_workflow",
            PlanningKind::ExportBundle => "export_workflow_bundle",
            PlanningKind::MajorDecision => "major_decision",
        }
    }
}

/// Classify a task into a [`PlanningKind`], or `None` if it should bypass the
/// planning gate entirely (ordinary Q&A / summarization, or an unrecognized
/// task). Mirrors the **text-only** decision order of the oracle's
/// `detectPlanningKind`:
///
/// 1. A destructive / high-risk action escalates to [`PlanningKind::MajorDecision`]
///    *before* anything else (so "delete all my files" plans, never silently
///    generates). Detected via [`is_destructive_request`].
/// 2. Ordinary Q&A / summarization requests bypass the gate (`None`).
/// 3. The kind hints, in the oracle's order: skill → deploy → export → workflow.
/// 4. The three `VAGUE_*` heuristics (deliverable / improvement / strategic-plan)
///    escalate to `major_decision`.
/// 5. The `major_decision` catch-all (architecture/strategy/migration/…).
///
/// Whitespace is normalized (trimmed, runs collapsed) before matching, matching
/// the oracle's `normalizeText`.
pub fn classify_kind(task: &str) -> Option<PlanningKind> {
    let normalized = normalize_text(task);
    let lower = normalized.to_ascii_lowercase();

    // 1. Destructive / high-risk action -> MajorDecision (highest precedence).
    //    DELIBERATE DIVERGENCE: the oracle exempts purely *informational* high-risk
    //    guidance (`INFORMATIONAL_HIGH_RISK_GUIDANCE_HINTS && !DIRECT_HIGH_RISK_
    //    ACTION_HINTS`), so "explain how to safely delete a file" returns null
    //    there. That exemption is text-only and portable — we omit it on purpose as
    //    a conservative OVER-escalation (over-planning an informational question is
    //    safe; under-planning a real destructive action is not). The omitted clause
    //    is `DIRECT_HIGH_RISK_ACTION_HINTS`, a gnarly sentence-anchored multi-
    //    alternation; porting it for exact parity is left to the coordinator.
    if is_destructive_request(&normalized) {
        return Some(PlanningKind::MajorDecision);
    }

    // 2. Ordinary Q&A / summarization bypasses the gate.
    if matches_qa_bypass(&lower) {
        return None;
    }

    // 3. Kind hints, in the oracle's matching order.
    if matches_generate_skill(&lower) {
        return Some(PlanningKind::GenerateSkill);
    }
    if matches_deploy_workflow(&lower) {
        return Some(PlanningKind::DeployWorkflow);
    }
    if matches_export_bundle(&lower) {
        return Some(PlanningKind::ExportBundle);
    }
    if matches_generate_workflow(&lower) {
        return Some(PlanningKind::GenerateWorkflow);
    }

    // 4. Vague-deliverable / vague-improvement / vague-strategic-plan asks are
    //    text-only and escalate to MajorDecision (the gate clarifies before
    //    building), in the oracle's order — BEFORE the major-decision hints.
    if matches_vague_deliverable(&lower)
        || matches_vague_improvement(&lower)
        || matches_vague_strategic_plan(&lower)
    {
        return Some(PlanningKind::MajorDecision);
    }

    // 5. Major-decision catch-all.
    if matches_major_decision(&lower) {
        return Some(PlanningKind::MajorDecision);
    }

    None
}

/// Normalize text the way the oracle's `normalizeText` does: trim, then collapse
/// internal whitespace runs to single spaces.
fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Does `lower` (lowercased) contain `needle` (lowercase) as a `\b`-bounded word?
/// Word chars are `[a-z0-9_]`, mirroring the regex `\b` used throughout the
/// oracle's hint patterns.
fn contains_word(lower: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let bytes = lower.as_bytes();
    let nlen = needle.len();
    let mut from = 0;
    while let Some(rel) = lower[from..].find(needle) {
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

/// True if `lower` matches `<verb> (a )?(new )?(<filler>)?<noun>` — a verb (whole
/// word), followed by a single space and the OPTIONAL determiner sequence the
/// oracle regexes allow, then the noun as a whole word *immediately* after.
///
/// This is the FAITHFUL shape of the oracle's `GENERATE_SKILL_HINTS` /
/// `GENERATE_WORKFLOW_HINTS`: those regexes do NOT allow arbitrary text between
/// the verb and the noun — only the literal optional tokens `a `, `new ` (and,
/// for the skill pattern, `friday `). So "set up an automation" does NOT match
/// the oracle (the noun is not adjacent modulo those tokens), and neither does it
/// here. `lower` must already be lowercased and whitespace-normalized (single
/// spaces). `fillers` is the extra optional token(s) beyond `a `/`new ` (empty
/// for workflow; `["friday "]` for skill).
fn verb_then_noun(lower: &str, verbs: &[&str], fillers: &[&str], nouns: &[&str]) -> bool {
    for v in verbs {
        let mut vfrom = 0;
        while let Some(vrel) = lower[vfrom..].find(v) {
            let vpos = vfrom + vrel;
            let vend = vpos + v.len();
            // Verb must be a whole word on its left edge.
            let left_ok = vpos == 0 || !is_word_byte(lower.as_bytes()[vpos - 1]);
            // And followed by a single space (the verbs are multi-word-safe, e.g.
            // "set up"); the oracle uses a literal space between verb and the
            // optional determiners.
            if left_ok
                && lower[vend..].starts_with(' ')
                && noun_after_optionals(&lower[vend + 1..], fillers, nouns)
            {
                return true;
            }
            vfrom = vend;
        }
    }
    false
}

/// Given the text right after "`<verb> `", consume the OPTIONAL determiner
/// sequence (`a `, then `new `, then each `filler`, each at most once and in
/// order, matching the oracle's `(?:a )?(?:new )?(?:friday )?`) and return true
/// iff a `noun` then begins as a whole word.
fn noun_after_optionals(rest: &str, fillers: &[&str], nouns: &[&str]) -> bool {
    let mut rest = rest;
    rest = rest.strip_prefix("a ").unwrap_or(rest);
    rest = rest.strip_prefix("new ").unwrap_or(rest);
    for f in fillers {
        rest = rest.strip_prefix(f).unwrap_or(rest);
    }
    for n in nouns {
        if let Some(after) = rest.strip_prefix(n) {
            // Noun must end on a word boundary (so "skill" does not match inside
            // "reskill"; the `\b` in the oracle pattern).
            if after.is_empty() || !is_word_byte(after.as_bytes()[0]) {
                return true;
            }
        }
    }
    false
}

/// True if `needle` occurs as a `\b`-bounded WHOLE WORD whose start lies within
/// `window` chars after byte offset `start` in `lower`, returning the byte index
/// just past that occurrence. Scans onward past in-word/out-of... matches so a
/// first failed boundary does not mask a later valid one (a bare `find` would
/// trade the over-match for an under-match). `lower` must be lowercased.
fn word_within(lower: &str, start: usize, needle: &str, window: usize) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let bytes = lower.as_bytes();
    let mut from = start;
    while let Some(rel) = lower[from..].find(needle) {
        let pos = from + rel;
        // Out of the window (measured in CHARS, like the oracle's `{0,N}`): since
        // matches only move further right, none later can be closer — stop.
        if lower[start..pos].chars().count() > window {
            return None;
        }
        let end = pos + needle.len();
        let left_ok = pos == 0 || !is_word_byte(bytes[pos - 1]);
        let right_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
        if left_ok && right_ok {
            return Some(end);
        }
        from = pos + 1;
    }
    None
}

/// Like [`word_within`] but yields the end index of EVERY whole-word occurrence of
/// `needle` starting within `window` chars after `start` (not just the first). The
/// oracle regex `A[\s\S]{0,N}B[\s\S]{0,N}C` backtracks across B positions; a
/// first-occurrence-only scan under-detects when an earlier B's window doesn't reach
/// a C but a later B's does. `lower` must be lowercased.
fn word_ends_within(lower: &str, start: usize, needle: &str, window: usize) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() {
        return out;
    }
    let bytes = lower.as_bytes();
    let mut from = start;
    while let Some(rel) = lower[from..].find(needle) {
        let pos = from + rel;
        if lower[start..pos].chars().count() > window {
            break;
        }
        let end = pos + needle.len();
        let left_ok = pos == 0 || !is_word_byte(bytes[pos - 1]);
        let right_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
        if left_ok && right_ok {
            out.push(end);
        }
        from = pos + 1;
    }
    out
}

/// True if some `first` phrase occurs as a whole word and some `second` phrase
/// begins as a whole word within `window` chars after it. Faithful to the
/// oracle's `\bA\b[\s\S]{0,N}\bB\b` co-occurrence patterns (the VAGUE_* hints,
/// which DO allow arbitrary text in the gap but require WORD boundaries on both
/// terms — so "app" inside "happy" does not match). `lower` must be lowercased.
fn co_occurs_within(lower: &str, firsts: &[&str], seconds: &[&str], window: usize) -> bool {
    for a in firsts {
        let mut afrom = 0;
        while let Some(arel) = lower[afrom..].find(a) {
            let apos = afrom + arel;
            let aend = apos + a.len();
            let left_ok = apos == 0 || !is_word_byte(lower.as_bytes()[apos - 1]);
            let right_ok = aend >= lower.len() || !is_word_byte(lower.as_bytes()[aend]);
            if left_ok
                && right_ok
                && seconds
                    .iter()
                    .any(|b| word_within(lower, aend, b, window).is_some())
            {
                return true;
            }
            afrom = aend;
        }
    }
    false
}

// --- text-only hint matchers (faithful to the oracle's regexes) -------------

/// `QA_BYPASS_HINTS`: ordinary Q&A / summarization / explanation requests.
fn matches_qa_bypass(lower: &str) -> bool {
    const HINTS: &[&str] = &[
        "summarize",
        "summarise",
        "explain",
        "describe",
        "what is",
        "tell me about",
        "list",
        "show",
        "how does",
        "how do i",
        "how can i",
        "what steps",
        "guide me",
        "walk me through",
        "overview",
        "translate",
        "recap",
        "compare",
        "analyze",
        "analyse",
    ];
    HINTS.iter().any(|h| contains_word(lower, h))
}

/// `GENERATE_SKILL_HINTS`: `(generate|create|build) (a )?(new )?(friday )?skill`
/// or "skill generator". The verb and `skill` are adjacent modulo the optional
/// determiners — not separated by arbitrary text.
fn matches_generate_skill(lower: &str) -> bool {
    if contains_word(lower, "skill generator") {
        return true;
    }
    verb_then_noun(
        lower,
        &["generate", "create", "build"],
        &["friday "],
        &["skill"],
    )
}

/// `GENERATE_WORKFLOW_HINTS`:
/// `(generate|create|build|set up|make) (a )?(new )?(workflow|automation|pipeline)`.
/// The noun is adjacent modulo `a `/`new ` only — "set up an automation" does NOT
/// match (faithful to the oracle, which has no "an" alternative).
fn matches_generate_workflow(lower: &str) -> bool {
    verb_then_noun(
        lower,
        &["generate", "create", "build", "set up", "make"],
        &[],
        &["workflow", "automation", "pipeline"],
    )
}

/// `DEPLOY_WORKFLOW_HINTS`: deploy/publish/ship/roll out workflow.
fn matches_deploy_workflow(lower: &str) -> bool {
    contains_word(lower, "deploy workflow")
        || contains_word(lower, "publish workflow")
        || contains_word(lower, "ship workflow")
        || contains_word(lower, "roll out workflow")
}

/// `EXPORT_WORKFLOW_HINTS`: export workflow / workflow bundle / package workflow.
fn matches_export_bundle(lower: &str) -> bool {
    contains_word(lower, "export workflow")
        || contains_word(lower, "workflow bundle")
        || contains_word(lower, "package workflow")
}

/// `VAGUE_DELIVERABLE_HINTS`: an under-specified "build me a website/app/tool/…"
/// request — text-only, so it escalates to MajorDecision (the gate clarifies
/// before building). Faithful to the oracle's verb`[\s\S]{0,80}`noun co-occurrence.
fn matches_vague_deliverable(lower: &str) -> bool {
    const VERBS: &[&str] = &[
        "build",
        "create",
        "make",
        "design",
        "set up",
        "put together",
        // The oracle's `help me (?:build|create|make|design)` alternative.
        "help me build",
        "help me create",
        "help me make",
        "help me design",
    ];
    const NOUNS: &[&str] = &[
        "website",
        "web site",
        "site",
        "web app",
        "app",
        "landing page",
        "dashboard",
        "tool",
        "project",
        "prototype",
        "feature",
        "product",
    ];
    co_occurs_within(lower, VERBS, NOUNS, 80)
}

/// `VAGUE_IMPROVEMENT_HINTS`: "make Friday/this app/the repo … better/
/// production-ready/…" — a vague improvement ask. Text-only -> MajorDecision.
/// Faithful to the oracle's verb`[\s\S]{0,80}`subject`[\s\S]{0,80}`quality chain.
fn matches_vague_improvement(lower: &str) -> bool {
    const VERBS: &[&str] = &["make", "improve", "prepare", "turn"];
    const SUBJECTS: &[&str] = &[
        "friday",
        "this app",
        "the app",
        "this project",
        "the project",
        "the repo",
        "repository",
        "workspace",
    ];
    const QUALITIES: &[&str] = &[
        "better",
        "production-ready",
        "production ready",
        "usable",
        "ready",
        "safer",
        "stable",
        "polished",
    ];
    // verb -> subject within 80, then subject -> quality within 80 (the oracle's
    // two `[\s\S]{0,80}` gaps). All three terms are matched as whole words via
    // `word_within`, so an in-word coincidence (e.g. "ready" inside "already")
    // does not satisfy the chain.
    for v in VERBS {
        let mut vfrom = 0;
        while let Some(vrel) = lower[vfrom..].find(v) {
            let vpos = vfrom + vrel;
            let vend = vpos + v.len();
            let left_ok = vpos == 0 || !is_word_byte(lower.as_bytes()[vpos - 1]);
            let right_ok = vend >= lower.len() || !is_word_byte(lower.as_bytes()[vend]);
            if left_ok && right_ok {
                // For EACH whole-word subject occurrence within the window, look for
                // a whole-word quality within the window after IT. Iterating all
                // subject occurrences (not just the first) mirrors the oracle regex's
                // backtracking — an earlier subject whose window misses a quality must
                // not mask a later subject whose window reaches one.
                for s in SUBJECTS {
                    for send in word_ends_within(lower, vend, s, 80) {
                        if QUALITIES
                            .iter()
                            .any(|q| word_within(lower, send, q, 80).is_some())
                        {
                            return true;
                        }
                    }
                }
            }
            vfrom = vend;
        }
    }
    false
}

/// `VAGUE_STRATEGIC_PLAN_HINTS`: explicit "vague request / production-ready /
/// ask the clarification questions" phrasings. Text-only -> MajorDecision.
fn matches_vague_strategic_plan(lower: &str) -> bool {
    const HINTS: &[&str] = &[
        "workflow plan",
        "production-ready",
        "production ready",
        "intentionally vague",
        "vague request",
        "ask the missing clarification questions",
        "wait for my answers before",
        "wait for our answers before",
        "wait for the answers before",
        "wait for answers before",
    ];
    HINTS.iter().any(|h| contains_word(lower, h))
}

/// `MAJOR_DECISION_HINTS`: architecture / strategy / migration / roadmap / plan /
/// refactor / overhaul / decision / tradeoff phrasings.
fn matches_major_decision(lower: &str) -> bool {
    const HINTS: &[&str] = &[
        "architecture",
        "architect",
        "strategy",
        "migration",
        "roadmap",
        "implementation plan",
        "rollout plan",
        "major refactor",
        "large refactor",
        "overhaul",
        "choose between",
        "decision",
        "tradeoff",
        "design the approach",
    ];
    HINTS.iter().any(|h| contains_word(lower, h))
}

/// The plan lifecycle the oracle drives through `planReview.gate.state`
/// (`awaiting_clarification` → `awaiting_plan_approval` → `approved` /
/// `rejected`). Encoded with the SAME state-machine idiom as
/// `workflow::WorkflowRunState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanState {
    /// The gate is collecting clarification answers before drafting a plan.
    AwaitingClarification,
    /// A plan has been drafted and is awaiting the user's approve/reject.
    AwaitingPlanApproval,
    /// The user approved the plan — terminal (no re-decide).
    Approved,
    /// The user rejected the plan — terminal (no re-decide).
    Rejected,
}

impl PlanState {
    pub fn as_str(&self) -> &'static str {
        match self {
            PlanState::AwaitingClarification => "awaiting_clarification",
            PlanState::AwaitingPlanApproval => "awaiting_plan_approval",
            PlanState::Approved => "approved",
            PlanState::Rejected => "rejected",
        }
    }

    /// `Approved` and `Rejected` are terminal: a decided plan cannot be re-decided.
    pub fn is_terminal(&self) -> bool {
        matches!(self, PlanState::Approved | PlanState::Rejected)
    }

    pub fn can_transition_to(&self, next: PlanState) -> bool {
        use PlanState::*;
        matches!(
            (self, next),
            (AwaitingClarification, AwaitingPlanApproval)
                | (AwaitingPlanApproval, Approved)
                | (AwaitingPlanApproval, Rejected)
        )
    }

    pub fn try_transition(self, next: PlanState) -> Result<PlanState, CoreError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(CoreError::InvalidTransition {
                entity: "agent_plan",
                from: self.as_str(),
                to: next.as_str(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PlanState::*;
    use super::*;

    #[test]
    fn classifies_generate_skill() {
        assert_eq!(
            classify_kind("Please generate a new Friday skill for me"),
            Some(PlanningKind::GenerateSkill)
        );
        assert_eq!(
            classify_kind("build a skill that triages email"),
            Some(PlanningKind::GenerateSkill)
        );
    }

    #[test]
    fn classifies_generate_workflow() {
        assert_eq!(
            classify_kind("create a workflow that posts a daily summary"),
            Some(PlanningKind::GenerateWorkflow)
        );
        // "set up [a] [new] (workflow|automation|pipeline)" — the noun is adjacent
        // modulo the optional determiners.
        assert_eq!(
            classify_kind("set up a new automation for my inbox"),
            Some(PlanningKind::GenerateWorkflow)
        );
        assert_eq!(
            classify_kind("build a pipeline to sync my notes"),
            Some(PlanningKind::GenerateWorkflow)
        );
    }

    #[test]
    fn generate_workflow_requires_the_noun_adjacent_to_the_verb() {
        // Faithful to the oracle: the noun must follow the verb modulo only
        // `a `/`new ` — "set up AN automation" does NOT match the workflow hint
        // (no "an" alternative in the regex), and falls through to None here just
        // as it returns null in the oracle.
        assert_eq!(classify_kind("set up an automation for my inbox"), None);
        // Likewise a far-apart verb/noun ("create ... a long sentence ... workflow")
        // is not the GenerateWorkflow pattern.
        assert_eq!(
            classify_kind("create something today and later we can think about a workflow"),
            None
        );
    }

    #[test]
    fn classifies_vague_deliverable_and_improvement_as_major_decision() {
        // VAGUE_DELIVERABLE: an under-specified "build me a website" -> MajorDecision.
        assert_eq!(
            classify_kind("build me a website for my bakery"),
            Some(PlanningKind::MajorDecision)
        );
        assert_eq!(
            classify_kind("build a simple tool to track tasks"),
            Some(PlanningKind::MajorDecision)
        );
        // VAGUE_IMPROVEMENT: "make Friday production-ready" -> MajorDecision.
        assert_eq!(
            classify_kind("make Friday more production-ready and stable"),
            Some(PlanningKind::MajorDecision)
        );
    }

    #[test]
    fn vague_improvement_backtracks_across_repeated_subjects() {
        // Reviewer-A under-detection fix: an EARLIER subject occurrence whose
        // 80-char quality window misses must not mask a LATER subject occurrence
        // whose window reaches a quality (the oracle regex backtracks across B
        // positions). Here the first "friday" is far from any quality word, but the
        // second "friday" is immediately followed by "ready".
        let task = "improve friday in lots of little unrelated ways here and there and \
                    then friday should be ready";
        assert_eq!(classify_kind(task), Some(PlanningKind::MajorDecision));
    }

    #[test]
    fn vague_hints_require_whole_word_nouns_not_in_word_coincidences() {
        // Faithful to the oracle's `\bnoun\b`: "app" inside "happy" must NOT trip
        // VAGUE_DELIVERABLE, and "ready" inside "already" must NOT trip
        // VAGUE_IMPROVEMENT — these are plain non-actionable sentences -> None.
        assert_eq!(classify_kind("create a happy moment for the team"), None);
        assert_eq!(classify_kind("we already improved the layout"), None);
    }

    #[test]
    fn classifies_deploy_workflow() {
        assert_eq!(
            classify_kind("deploy workflow to production now"),
            Some(PlanningKind::DeployWorkflow)
        );
        // Deploy is matched before the generic generate-workflow hint.
        assert_eq!(
            classify_kind("publish workflow for the team"),
            Some(PlanningKind::DeployWorkflow)
        );
    }

    #[test]
    fn classifies_export_bundle() {
        assert_eq!(
            classify_kind("export workflow as a shareable artifact"),
            Some(PlanningKind::ExportBundle)
        );
        assert_eq!(
            classify_kind("create a workflow bundle for backup"),
            Some(PlanningKind::ExportBundle)
        );
    }

    #[test]
    fn classifies_major_decision() {
        assert_eq!(
            classify_kind("help me choose the migration strategy for the database"),
            Some(PlanningKind::MajorDecision)
        );
        // A non-QA architecture/strategy phrasing escalates to MajorDecision.
        assert_eq!(
            classify_kind("design the right architecture for this system"),
            Some(PlanningKind::MajorDecision)
        );
    }

    #[test]
    fn qa_phrasing_wins_over_a_major_decision_hint() {
        // Faithful to the oracle's decision ORDER: the QA-bypass check runs BEFORE
        // the major-decision hint check, so a question that merely mentions
        // "architecture" still bypasses the gate (it is information, not a plan).
        assert_eq!(classify_kind("what is the right architecture here"), None);
    }

    #[test]
    fn destructive_request_escalates_to_major_decision_english() {
        // A destructive action escalates to MajorDecision even though it mentions
        // no "architecture/strategy" hint — the safety floor.
        assert_eq!(
            classify_kind("delete all the files in my workspace"),
            Some(PlanningKind::MajorDecision)
        );
        // The save-credential clause also escalates (persisting a secret is high-risk).
        assert_eq!(
            classify_kind("save my api key to the config file"),
            Some(PlanningKind::MajorDecision)
        );
    }

    #[test]
    fn destructive_request_escalates_to_major_decision_chinese() {
        // Multilingual: a Chinese destructive request also escalates (reusing the
        // shared CJK-aware `is_destructive_request`).
        // "delete all the files in my workspace" (verb 删除 precedes object 文件).
        assert_eq!(
            classify_kind("删除我工作区里的所有文件"),
            Some(PlanningKind::MajorDecision)
        );
        // "save my key to the config file" (verb 保存 precedes object 密钥) — the
        // CJK save-credential clause of `is_destructive_request`.
        assert_eq!(
            classify_kind("保存我的密钥到配置文件"),
            Some(PlanningKind::MajorDecision)
        );
    }

    #[test]
    fn ordinary_qa_bypasses_the_gate() {
        assert_eq!(classify_kind("summarize this thread for me"), None);
        assert_eq!(classify_kind("explain how OAuth works"), None);
        assert_eq!(classify_kind("what is the capital of France"), None);
        // An unrecognized, non-actionable task is also None.
        assert_eq!(classify_kind("the weather is nice today"), None);
    }

    #[test]
    fn plan_state_legal_path_to_approved() {
        let s = AwaitingClarification
            .try_transition(AwaitingPlanApproval)
            .unwrap()
            .try_transition(Approved)
            .unwrap();
        assert!(s.is_terminal());
        assert_eq!(s, Approved);
    }

    #[test]
    fn plan_state_legal_path_to_rejected() {
        let s = AwaitingClarification
            .try_transition(AwaitingPlanApproval)
            .unwrap()
            .try_transition(Rejected)
            .unwrap();
        assert!(s.is_terminal());
        assert_eq!(s, Rejected);
    }

    #[test]
    fn plan_state_illegal_transitions_are_rejected() {
        // Cannot skip clarification straight to approval-decision.
        assert!(AwaitingClarification.try_transition(Approved).is_err());
        assert!(AwaitingClarification.try_transition(Rejected).is_err());
        // Cannot jump from clarification to clarification (no self-loop defined).
        assert!(AwaitingClarification
            .try_transition(AwaitingClarification)
            .is_err());
    }

    #[test]
    fn plan_state_terminal_cannot_be_redecided() {
        assert!(Approved.is_terminal());
        assert!(Rejected.is_terminal());
        // No re-decide: a decided plan cannot transition anywhere.
        assert!(Approved.try_transition(Rejected).is_err());
        assert!(Rejected.try_transition(Approved).is_err());
        assert!(Approved.try_transition(AwaitingPlanApproval).is_err());
        assert!(Rejected.try_transition(AwaitingPlanApproval).is_err());
        // AwaitingClarification / AwaitingPlanApproval are NOT terminal.
        assert!(!AwaitingClarification.is_terminal());
        assert!(!AwaitingPlanApproval.is_terminal());
    }

    #[test]
    fn invalid_transition_error_carries_entity_and_states() {
        let err = AwaitingClarification.try_transition(Approved).unwrap_err();
        assert_eq!(
            err,
            CoreError::InvalidTransition {
                entity: "agent_plan",
                from: "awaiting_clarification",
                to: "approved",
            }
        );
    }
}
