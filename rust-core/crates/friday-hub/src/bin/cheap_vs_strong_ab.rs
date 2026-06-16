//! `cheap_vs_strong_ab` — a REAL-MODEL A/B harness for the three dark "cheap→stronger"
//! mechanisms (the a#1/a#2/a#3 lanes of the 2026-06-15 orchestration investigation).
//!
//! For each of a CURATED task set it drives the SAME agent loop ([`run_loop_with_policy_flagged`])
//! TWICE — once with the mechanism OFF (baseline) and once ON (treatment) — against a REAL DeepSeek
//! client, then prints a structured side-by-side report: per task the baseline-vs-treatment final
//! answer, turns, total tokens (from `token_ledger`), `cost_estimate` (the a#4 cost table), a
//! deterministic quality signal, and a short delta note.
//!
//! ## The three mechanisms (each a pure-bool / direct-param arm of the loop)
//! - **a#1 `FRIDAY_RICH_SYSTEM_PROMPT_ENABLED`** — the rich operating-guidance preamble. Injected
//!   here as the `rich_prompt_enabled` bool (OFF vs ON).
//! - **a#3 `FRIDAY_QUALITY_ESCALATION_ENABLED`** — flash→pro one-shot escalation. Injected here as
//!   `escalation_client: None` (baseline) vs `Some(pro_client)` (treatment). The pro client is a
//!   FRESH forced-`deepseek-v4-pro` client over the SAME DeepSeek key. NOTE the trigger is narrow:
//!   escalation fires ONLY when the flash leg billed AND its reply failed the tool-call parse
//!   contract (`AgentError::Parse`); with the 4096-token budget that rarely happens, so on a
//!   well-behaved task the pro client is never invoked (zero delta) — that is the honest finding,
//!   reported explicitly per task, never contrived.
//! - **a#2 `FRIDAY_SELF_CRITIQUE_ENABLED`** — the self-critique / verify pass before a finish.
//!   Injected as the `self_critique_enabled` bool PLUS the bound WorkItem's `done_criteria` (passed
//!   directly as a `&[String]`, so the harness needs no WorkItem ceremony). It fires ONLY when the
//!   flag is ON, the criteria are non-empty, AND the model's first finish answer is deficient
//!   against them (the deterministic `answer_passes_done_criteria` check) — otherwise it is inert.
//!
//! ## Key source — same as the hub (NEVER hardcoded, NEVER printed)
//! The real DeepSeek client is built via [`friday_deepseek::DeepSeekClient::from_env`], which reads
//! the SAME `FRIDAY_DEEPSEEK_API_KEY` env var the production hub uses
//! ([`friday_deepseek::ENV_KEY`]). The pro escalation client is a second `from_env` client with the
//! model forced to `deepseek-v4-pro` (the same key — DeepSeek-pro is reachable on it). When the key
//! is ABSENT the real run FAILS FAST with a clear message (it does NOT silently pass).
//!
//! ## CI safety — no key, no real call
//! Running with `--mock-demo` (or in the committed unit tests) uses a deterministic SCRIPTED client
//! instead of the real model, so the harness builds + the comparison-report shape is proven in CI
//! WITHOUT a key and WITHOUT spending quota. The real run (`--real`, ~dozens of cheap DeepSeek
//! calls) is the SEPARATE coordinator step on the host where the key is available.
//!
//! ## Invoke
//! ```text
//! # CI-safe demo (no key, scripted answers — proves the report shape):
//! cargo run -p friday-hub --bin cheap_vs_strong_ab -- --mock-demo
//!
//! # REAL A/B (needs the key; spends DeepSeek quota — coordinator step):
//! FRIDAY_DEEPSEEK_API_KEY=sk-... cargo run -p friday-hub --bin cheap_vs_strong_ab -- --real
//! # optionally restrict to one mechanism: --only rich | --only escalation | --only critique
//! ```

use std::collections::BTreeMap;

use friday_hub::{
    run_loop_with_policy_flagged, AgentError, AgentStep, BilledUsage, FsToolExecutor, LoopOutcome,
    MeteredStep, RunPolicy, TurnTrace,
};
use rusqlite::Connection;

/// The DeepSeek-pro model id (the escalation tier). A model id is not a secret — it is the SAME
/// constant the hub's dark escalation wiring forces via `DeepSeekAgentLlmClient::with_model`.
const DEEPSEEK_PRO_MODEL: &str = "deepseek-v4-pro";

/// Bounded number of model turns per arm (the harness tasks are single-finish shaped; a real
/// tool task may take a couple of turns).
const MAX_TURNS: u64 = 6;

/// Bound the answer text printed in the report so a long model answer never floods the output
/// (the FULL answer is the model's, not a secret — we just keep the side-by-side readable).
const ANSWER_PREVIEW_BYTES: usize = 600;

/// A process-unique suffix for temp DB / workspace paths. Combines the pid, a wall-clock nanos
/// read, AND a monotonic atomic counter so two paths built in the SAME nanosecond (parallel test
/// threads) STILL differ — without the counter, sibling tests could open the SAME SQLite file and
/// collide on the schema bootstrap (`table … already exists`). PURE: a fresh string each call.
fn unique_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}_{}_{}", std::process::id(), nanos, n)
}

// ───────────────────────────── the three mechanisms ─────────────────────────────

/// Which cheap→stronger mechanism a task's A/B exercises. The arm wiring is per-mechanism:
/// rich/critique flip a pure bool; escalation flips the `escalation_client` Option.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mechanism {
    /// a#1 — rich system prompt (`rich_prompt_enabled` bool OFF→ON).
    RichPrompt,
    /// a#3 — flash→pro escalation (`escalation_client` None→Some(pro)).
    Escalation,
    /// a#2 — self-critique (`self_critique_enabled` bool + `done_criteria`).
    SelfCritique,
}

impl Mechanism {
    fn flag(self) -> &'static str {
        match self {
            Mechanism::RichPrompt => "FRIDAY_RICH_SYSTEM_PROMPT_ENABLED",
            Mechanism::Escalation => "FRIDAY_QUALITY_ESCALATION_ENABLED",
            Mechanism::SelfCritique => "FRIDAY_SELF_CRITIQUE_ENABLED",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Mechanism::RichPrompt => "rich",
            Mechanism::Escalation => "escalation",
            Mechanism::SelfCritique => "critique",
        }
    }
    fn parse(s: &str) -> Option<Mechanism> {
        match s {
            "rich" => Some(Mechanism::RichPrompt),
            "escalation" | "esc" => Some(Mechanism::Escalation),
            "critique" | "self_critique" => Some(Mechanism::SelfCritique),
            _ => None,
        }
    }
}

// ───────────────────────────── the curated task set ─────────────────────────────

/// One curated A/B task. `done_criteria` is non-empty ONLY for the self-critique tasks (it is the
/// bound-WorkItem's criteria the a#2 pass consumes; empty for the other mechanisms ⇒ critique inert
/// even if the flag were on). The `mock_*` answers script the deterministic CI/demo client so the
/// report shape (and a representative quality lift) is provable WITHOUT a real model.
#[derive(Clone)]
struct AbTask {
    id: &'static str,
    mechanism: Mechanism,
    /// The user task fed to the loop (the CLEAN task — recall/rich-prompt augment only the prompt).
    task: &'static str,
    /// The bound WorkItem's done-criteria (a#2 only). Empty for the other mechanisms.
    done_criteria: Vec<String>,
    /// Scripted BASELINE answer (mechanism OFF) for the mock client.
    mock_baseline: MockScript,
    /// Scripted TREATMENT answer (mechanism ON) for the mock client.
    mock_treatment: MockScript,
}

/// What the deterministic mock client replies for one arm. The variants model the real loop's
/// observable shapes so the report columns (answer / turns / tokens / cost / quality / delta) are
/// all exercised — WITHOUT a real model.
#[derive(Clone)]
enum MockScript {
    /// The model finishes immediately with this answer (tokens billed on the one turn).
    Finish {
        answer: &'static str,
        prompt_tokens: i64,
        completion_tokens: i64,
    },
    /// The first finish answer is DEFICIENT; the self-critique re-prompt (same client) returns the
    /// REVISED answer. Used for the critique TREATMENT arm so the a#2 lift is observable in the
    /// mock (the re-prompt is the SECOND scripted reply; both bill on distinct ledger slots).
    FinishThenCritique {
        first_answer: &'static str,
        revised_answer: &'static str,
        prompt_tokens: i64,
        completion_tokens: i64,
    },
    /// The flash leg's reply FAILS the tool-call parse contract (bills, then the escalation arm —
    /// when a pro client is wired — re-dispatches on pro). Used for the escalation TREATMENT arm so
    /// the flash→pro one-shot is observable in the mock. `pro_answer` is what the pro client then
    /// finishes with.
    FlashParseFailThenPro {
        pro_answer: &'static str,
        flash_prompt_tokens: i64,
        flash_completion_tokens: i64,
        pro_prompt_tokens: i64,
        pro_completion_tokens: i64,
    },
    /// A MULTI-STEP TOOL task: turn 1 proposes a tool call (`read_file`), which the loop dispatches
    /// through the real [`FsToolExecutor`] (on the harness's empty workspace this is a deterministic
    /// tool ExecError, threaded back as the turn outcome) — then turn 2 finishes. Two billed rows
    /// (`t0` + `t1`), a 2-turn run. `critique_revised` (when `Some`) makes the FINISH answer
    /// deficient and adds a THIRD reply = the self-critique re-prompt's revised answer (the a#2 path
    /// over a tool-using run). `None` ⇒ the finish answer stands (baseline / non-critique).
    ToolThenFinish {
        tool: &'static str,
        tool_path: &'static str,
        finish_answer: &'static str,
        critique_revised: Option<&'static str>,
        prompt_tokens: i64,
        completion_tokens: i64,
    },
}

/// The curated set — a mix of Q&A, a planning/build ask, and a MULTI-STEP TOOL task. Each
/// mechanism gets both a "lift plausible" and a "lift unlikely / inert" case (the honest
/// both-directions evidence the investigation asked for); the tool task additionally exercises the
/// 2-turn read→answer→critique path through the real `FsToolExecutor`.
fn curated_tasks() -> Vec<AbTask> {
    vec![
        // ---- a#1 rich system prompt ----
        AbTask {
            id: "rich-planning-build",
            mechanism: Mechanism::RichPrompt,
            task: "Plan how to add a rate limiter to an HTTP service: list the steps, the data \
                   structures, and one failure mode to guard against.",
            done_criteria: vec![],
            mock_baseline: MockScript::Finish {
                answer: "Use a token bucket.",
                prompt_tokens: 40,
                completion_tokens: 6,
            },
            mock_treatment: MockScript::Finish {
                answer: "Steps: (1) pick token-bucket per-key; (2) store {tokens, last_refill} in \
                         a map keyed by client id; (3) refill lazily on each request; (4) reject \
                         over-limit with 429 + Retry-After. Failure mode to guard: clock skew / \
                         non-monotonic time inflating the refill — use a monotonic clock.",
                prompt_tokens: 220,
                completion_tokens: 70,
            },
        },
        AbTask {
            id: "rich-qa-definition",
            mechanism: Mechanism::RichPrompt,
            task: "In one sentence, what is the difference between a process and a thread?",
            done_criteria: vec![],
            mock_baseline: MockScript::Finish {
                answer: "A process is a program; a thread is part of it.",
                prompt_tokens: 30,
                completion_tokens: 12,
            },
            mock_treatment: MockScript::Finish {
                answer:
                    "A process owns an isolated address space and resources, while a thread is \
                         a lighter unit of execution that shares its parent process's address \
                         space with sibling threads.",
                prompt_tokens: 210,
                completion_tokens: 34,
            },
        },
        // ---- a#3 flash→pro escalation ----
        AbTask {
            // A task where the (mock) flash leg parse-fails ⇒ escalation fires on the treatment arm.
            id: "escalation-hard-json",
            mechanism: Mechanism::Escalation,
            task: "Return a strict JSON object {\"answer\": <int>} for: how many bits are in a \
                   IPv6 address?",
            done_criteria: vec![],
            mock_baseline: MockScript::Finish {
                answer: "{\"tool\":\"none\",\"answer\":\"128\"}",
                prompt_tokens: 36,
                completion_tokens: 9,
            },
            mock_treatment: MockScript::FlashParseFailThenPro {
                pro_answer: "128",
                flash_prompt_tokens: 36,
                flash_completion_tokens: 40, // flash burned the budget then produced unparseable prose
                pro_prompt_tokens: 36,
                pro_completion_tokens: 8,
            },
        },
        AbTask {
            // A well-behaved task: flash parses fine ⇒ escalation NEVER fires ⇒ zero delta (honest).
            id: "escalation-wellbehaved",
            mechanism: Mechanism::Escalation,
            task: "What is 17 * 23?",
            done_criteria: vec![],
            mock_baseline: MockScript::Finish {
                answer: "391",
                prompt_tokens: 22,
                completion_tokens: 4,
            },
            // Treatment scripts a normal finish too (no parse-fail) ⇒ pro client never invoked.
            mock_treatment: MockScript::Finish {
                answer: "391",
                prompt_tokens: 22,
                completion_tokens: 4,
            },
        },
        // ---- a#2 self-critique ----
        AbTask {
            // Criteria name an artifact token (`src/limiter.rs`) the baseline omits ⇒ deficient ⇒
            // critique re-prompts (treatment) and the revised answer cites it.
            id: "critique-cite-artifact",
            mechanism: Mechanism::SelfCritique,
            task:
                "Where should the rate-limiter middleware live in this repo, and what should the \
                   file contain?",
            done_criteria: vec![
                "the answer must reference the file src/limiter.rs".to_string(),
                "the answer must mention the token-bucket struct".to_string(),
            ],
            mock_baseline: MockScript::Finish {
                // Deficient: never names src/limiter.rs. (Baseline = flag OFF ⇒ accepted as-is.)
                answer: "Put it in the middleware folder.",
                prompt_tokens: 48,
                completion_tokens: 7,
            },
            mock_treatment: MockScript::FinishThenCritique {
                // Same deficient first answer, but the critique re-prompt revises to cite the file.
                first_answer: "Put it in the middleware folder.",
                revised_answer: "Add the middleware in src/limiter.rs holding the token-bucket \
                                 struct {tokens, last_refill} keyed by client id; wire it in the \
                                 router before the handlers.",
                prompt_tokens: 48,
                completion_tokens: 7,
            },
        },
        AbTask {
            // The first answer ALREADY satisfies the criteria ⇒ critique is inert even ON ⇒ zero
            // delta (honest: critique only spends when the answer is deficient).
            id: "critique-already-passes",
            mechanism: Mechanism::SelfCritique,
            task: "Name the config file and say what key sets the limit.",
            done_criteria: vec!["the answer must reference the file config/limits.toml".to_string()],
            mock_baseline: MockScript::Finish {
                answer: "Set max_per_min in config/limits.toml.",
                prompt_tokens: 40,
                completion_tokens: 10,
            },
            mock_treatment: MockScript::Finish {
                // Already passes (mentions config/limits.toml) ⇒ no re-prompt ⇒ byte-identical.
                answer: "Set max_per_min in config/limits.toml.",
                prompt_tokens: 40,
                completion_tokens: 10,
            },
        },
        // ---- a multi-step TOOL task (a#2 critique over a tool-using run) ----
        AbTask {
            // The model reads a file (turn 1, dispatched through the real FsToolExecutor), then
            // finishes (turn 2). Baseline's finish omits the required artifact ⇒ deficient. The
            // treatment's critique re-prompt revises to cite it ⇒ FAIL→PASS over a 2-turn run.
            // This is the task shape where critique ("did it ground its answer on what it read")
            // matters most.
            id: "critique-tooltask-read-then-answer",
            mechanism: Mechanism::SelfCritique,
            task: "Read the limiter source and tell me which struct field tracks the refill time; \
                   name the file.",
            done_criteria: vec![
                "the answer must reference the file src/limiter.rs".to_string(),
                "the answer must name the last_refill field".to_string(),
            ],
            mock_baseline: MockScript::ToolThenFinish {
                tool: "read_file",
                tool_path: "src/limiter.rs",
                // Deficient finish: neither the file nor the field is named.
                finish_answer: "It tracks the time somewhere in the struct.",
                critique_revised: None,
                prompt_tokens: 60,
                completion_tokens: 12,
            },
            mock_treatment: MockScript::ToolThenFinish {
                tool: "read_file",
                tool_path: "src/limiter.rs",
                finish_answer: "It tracks the time somewhere in the struct.",
                // The critique re-prompt grounds the answer on the read + cites both artifacts.
                critique_revised: Some(
                    "In src/limiter.rs the token-bucket struct's last_refill field tracks the \
                     refill timestamp.",
                ),
                prompt_tokens: 60,
                completion_tokens: 12,
            },
        },
    ]
}

// ───────────────────────────── the deterministic mock client ─────────────────────────────

/// A deterministic, metered scripted `AgentLlmClient` for the CI/demo path (NO real model). It
/// mirrors the production `next_step_metered` shape (an OUTER `Ok((inner_step, Some(usage)))` for a
/// chat that ran + billed) so the loop bills + escalates + critiques EXACTLY as it would with the
/// real client. Each successive call consumes the next scripted reply; the model id flows into the
/// billed row so its cost prices correctly off the a#4 table.
struct MockMeteredClient {
    steps: std::cell::RefCell<std::collections::VecDeque<Result<AgentStep, AgentError>>>,
    model: String,
    prompt_tokens: i64,
    completion_tokens: i64,
}

impl MockMeteredClient {
    fn new(
        steps: Vec<Result<AgentStep, AgentError>>,
        model: &str,
        prompt_tokens: i64,
        completion_tokens: i64,
    ) -> Self {
        Self {
            steps: std::cell::RefCell::new(steps.into_iter().collect()),
            model: model.to_string(),
            prompt_tokens,
            completion_tokens,
        }
    }
}

impl friday_hub::AgentLlmClient for MockMeteredClient {
    fn propose_tool_call(&self, _task: &str) -> Result<friday_hub::RawToolCall, AgentError> {
        // The loop drives `next_step_metered`; the single-shot path is never used here.
        Err(AgentError::Model(
            "mock: propose_tool_call unused".to_string(),
        ))
    }
    fn next_step_metered(
        &self,
        _task: &str,
        _history: &[TurnTrace],
    ) -> Result<MeteredStep, AgentError> {
        let step = self
            .steps
            .borrow_mut()
            .pop_front()
            // A script that runs out (e.g. a critique re-prompt the test did not script) finishes
            // safely rather than panicking — the loop is bounded by MAX_TURNS regardless.
            .unwrap_or(Ok(AgentStep::Finish {
                message: "mock: script exhausted".to_string(),
            }));
        let usage = BilledUsage {
            provider_kind: friday_core::ProviderKind::DeepSeek,
            model: self.model.clone(),
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
        };
        Ok((step, Some(usage)))
    }
}

/// Build the primary (flash) + optional escalation (pro) mock clients for ONE arm from its script.
/// Returns `(primary, Option<pro>)`. The pro client is `Some` only when the arm both scripts a
/// flash parse-fail AND is a treatment arm with escalation wired — that is encoded by the caller
/// passing `escalation_armed`.
fn mock_clients_for(
    script: &MockScript,
    escalation_armed: bool,
) -> (MockMeteredClient, Option<MockMeteredClient>) {
    match script {
        MockScript::Finish {
            answer,
            prompt_tokens,
            completion_tokens,
        } => (
            MockMeteredClient::new(
                vec![Ok(AgentStep::Finish {
                    message: answer.to_string(),
                })],
                "deepseek-v4-flash",
                *prompt_tokens,
                *completion_tokens,
            ),
            None,
        ),
        MockScript::FinishThenCritique {
            first_answer,
            revised_answer,
            prompt_tokens,
            completion_tokens,
        } => (
            // First reply = deficient finish; second reply (the critique re-prompt, SAME client) =
            // the revised finish. Both bill on the one client (distinct ledger slots).
            MockMeteredClient::new(
                vec![
                    Ok(AgentStep::Finish {
                        message: first_answer.to_string(),
                    }),
                    Ok(AgentStep::Finish {
                        message: revised_answer.to_string(),
                    }),
                ],
                "deepseek-v4-flash",
                *prompt_tokens,
                *completion_tokens,
            ),
            None,
        ),
        MockScript::FlashParseFailThenPro {
            pro_answer,
            flash_prompt_tokens,
            flash_completion_tokens,
            pro_prompt_tokens,
            pro_completion_tokens,
        } => {
            let flash = MockMeteredClient::new(
                vec![Err(AgentError::Parse(
                    "not a single JSON object".to_string(),
                ))],
                "deepseek-v4-flash",
                *flash_prompt_tokens,
                *flash_completion_tokens,
            );
            let pro = if escalation_armed {
                Some(MockMeteredClient::new(
                    vec![Ok(AgentStep::Finish {
                        message: pro_answer.to_string(),
                    })],
                    DEEPSEEK_PRO_MODEL,
                    *pro_prompt_tokens,
                    *pro_completion_tokens,
                ))
            } else {
                // Baseline arm: no pro client ⇒ the flash parse-fail just fails the run closed.
                None
            };
            (flash, pro)
        }
        MockScript::ToolThenFinish {
            tool,
            tool_path,
            finish_answer,
            critique_revised,
            prompt_tokens,
            completion_tokens,
        } => {
            // Turn 1: a tool call (the loop dispatches it through the real FsToolExecutor); turn 2:
            // finish. A `critique_revised` adds a THIRD reply (the self-critique re-prompt's revised
            // answer) so the a#2 path is exercised over a tool-using run.
            let mut steps = vec![
                Ok(AgentStep::Tool(friday_hub::RawToolCall {
                    action: tool.to_string(),
                    params: vec![("path".to_string(), tool_path.to_string())],
                })),
                Ok(AgentStep::Finish {
                    message: finish_answer.to_string(),
                }),
            ];
            if let Some(revised) = critique_revised {
                steps.push(Ok(AgentStep::Finish {
                    message: revised.to_string(),
                }));
            }
            (
                MockMeteredClient::new(
                    steps,
                    "deepseek-v4-flash",
                    *prompt_tokens,
                    *completion_tokens,
                ),
                None,
            )
        }
    }
}

// ───────────────────────────── ledger aggregation (PURE) ─────────────────────────────

/// The token/cost rollup for ONE run, read from `token_ledger` filtered by `run_id` (the loop
/// writes the run as the ledger `session_id` AND the authoritative `run_id` column). PURE over the
/// connection: a read-only aggregation, no mutation.
#[derive(Clone, Debug, PartialEq)]
struct RunRollup {
    /// Number of billed model calls (ledger rows) — turns PLUS any escalation/critique sub-call.
    billed_calls: i64,
    total_tokens: i64,
    /// Summed `cost_estimate` (the a#4 table). `None` only if NO row had a priced cost.
    cost_usd: Option<f64>,
}

/// Aggregate `token_ledger` for a run. SUM(cost_estimate) is NULL only when every row's cost is
/// NULL (an unpriced model); a known DeepSeek pair always prices, so a real run yields `Some`.
fn aggregate_run(conn: &Connection, run_id: &str) -> rusqlite::Result<RunRollup> {
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(total_tokens), 0), SUM(cost_estimate) \
         FROM token_ledger WHERE run_id = ?1",
        [run_id],
        |r| {
            Ok(RunRollup {
                billed_calls: r.get(0)?,
                total_tokens: r.get(1)?,
                cost_usd: r.get(2)?,
            })
        },
    )
}

// ───────────────────────────── the comparison row + report (PURE) ─────────────────────────────

/// The deterministic quality signal for one answer against a task's `done_criteria`. This re-uses
/// the SAME artifact-token rule the loop's `answer_passes_done_criteria` applies (kept in lockstep
/// here so the report's signal matches the mechanism's own acceptance check). For a task with NO
/// criteria the signal is just "non-empty answer".
fn quality_signal(answer: &str, done_criteria: &[String]) -> bool {
    if answer.trim().is_empty() {
        return false;
    }
    let answer_lc = answer.to_lowercase();
    for criterion in done_criteria {
        for token in criterion.split_whitespace() {
            let token = token.trim_matches(|c: char| {
                matches!(
                    c,
                    '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | ':'
                ) || matches!(c, '.' | '!' | '?')
            });
            let is_artifact_like = token.len() >= 4
                && !token.contains(char::is_whitespace)
                && token.chars().any(|c| matches!(c, '/' | '.' | '_'));
            if is_artifact_like && !answer_lc.contains(&token.to_lowercase()) {
                return false;
            }
        }
    }
    true
}

/// The captured result of ONE arm (baseline or treatment).
#[derive(Clone, Debug)]
struct ArmResult {
    status: String,
    turns: u64,
    answer: String,
    rollup: RunRollup,
    /// The deterministic quality signal (did it pass the done_criteria / is it non-empty).
    quality_pass: bool,
}

/// One task's full A/B comparison (both arms + a derived delta note).
#[derive(Clone, Debug)]
struct ComparisonRow {
    task_id: String,
    mechanism: &'static str,
    flag: &'static str,
    task: String,
    baseline: ArmResult,
    treatment: ArmResult,
    delta_note: String,
}

/// Derive the short, honest delta note from the two arms. Names the OBSERVABLE difference:
/// whether the mechanism fired (extra billed call / changed answer), the token+cost delta, and the
/// quality-signal change — including the explicit "never fired / inert ⇒ zero delta" case.
fn delta_note(mech: Mechanism, base: &ArmResult, treat: &ArmResult) -> String {
    let extra_calls = treat.rollup.billed_calls - base.rollup.billed_calls;
    let tok_delta = treat.rollup.total_tokens - base.rollup.total_tokens;
    let answer_changed = base.answer.trim() != treat.answer.trim();
    let quality_up = !base.quality_pass && treat.quality_pass;
    let quality_down = base.quality_pass && !treat.quality_pass;

    let fired = match mech {
        // escalation "fired" = a SECOND (pro) call was billed beyond the baseline.
        Mechanism::Escalation => extra_calls > 0,
        // critique "fired" = an extra (critique) call was billed.
        Mechanism::SelfCritique => extra_calls > 0,
        // rich prompt does not add a call; it "fired" iff the prompt actually changed the answer.
        Mechanism::RichPrompt => answer_changed,
    };

    let mut parts: Vec<String> = Vec::new();
    parts.push(match mech {
        Mechanism::Escalation => {
            if fired {
                "escalation FIRED (flash parse-fail → pro re-dispatch)".to_string()
            } else {
                "escalation NEVER fired (flash parsed cleanly) — INERT, zero delta".to_string()
            }
        }
        Mechanism::SelfCritique => {
            if fired {
                "self-critique FIRED (first answer deficient → one re-prompt)".to_string()
            } else {
                "self-critique INERT (first answer already passed / no criteria) — zero delta"
                    .to_string()
            }
        }
        Mechanism::RichPrompt => {
            if fired {
                "rich prompt CHANGED the answer".to_string()
            } else {
                "rich prompt did not change the answer".to_string()
            }
        }
    });
    parts.push(format!(
        "tokens {}→{} (Δ{:+}), calls {}→{} (Δ{:+})",
        base.rollup.total_tokens,
        treat.rollup.total_tokens,
        tok_delta,
        base.rollup.billed_calls,
        treat.rollup.billed_calls,
        extra_calls,
    ));
    if let (Some(b), Some(t)) = (base.rollup.cost_usd, treat.rollup.cost_usd) {
        parts.push(format!("cost ${:.6}→${:.6} (Δ${:+.6})", b, t, t - b));
    }
    if quality_up {
        parts.push("quality signal: FAIL→PASS (lift)".to_string());
    } else if quality_down {
        parts.push("quality signal: PASS→FAIL (REGRESSION)".to_string());
    } else {
        parts.push(format!(
            "quality signal unchanged ({})",
            if treat.quality_pass { "PASS" } else { "FAIL" }
        ));
    }
    parts.join("; ")
}

/// Render the full side-by-side report (deterministic text). PURE over the rows.
fn render_report(rows: &[ComparisonRow], mode: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "=== cheap_vs_strong_ab — A/B report ({mode}) ===\n\
         {} task(s); per task: BASELINE (flag OFF) vs TREATMENT (flag ON)\n\n",
        rows.len()
    ));
    // Group by mechanism for readability.
    let mut by_mech: BTreeMap<&str, Vec<&ComparisonRow>> = BTreeMap::new();
    for r in rows {
        by_mech.entry(r.mechanism).or_default().push(r);
    }
    for (mech, group) in &by_mech {
        out.push_str(&format!("── mechanism: {mech} ──\n"));
        for r in group {
            out.push_str(&format!("• [{}] flag={}\n", r.task_id, r.flag));
            out.push_str(&format!("  task: {}\n", r.task));
            out.push_str(&format!(
                "  BASELINE : status={} turns={} calls={} tokens={} cost={} quality={}\n",
                r.baseline.status,
                r.baseline.turns,
                r.baseline.rollup.billed_calls,
                r.baseline.rollup.total_tokens,
                fmt_cost(r.baseline.rollup.cost_usd),
                pass_str(r.baseline.quality_pass),
            ));
            out.push_str(&format!("    answer: {}\n", preview(&r.baseline.answer)));
            out.push_str(&format!(
                "  TREATMENT: status={} turns={} calls={} tokens={} cost={} quality={}\n",
                r.treatment.status,
                r.treatment.turns,
                r.treatment.rollup.billed_calls,
                r.treatment.rollup.total_tokens,
                fmt_cost(r.treatment.rollup.cost_usd),
                pass_str(r.treatment.quality_pass),
            ));
            out.push_str(&format!("    answer: {}\n", preview(&r.treatment.answer)));
            out.push_str(&format!("  Δ {}\n\n", r.delta_note));
        }
    }
    // A compact summary: per mechanism, how many tasks the treatment changed / lifted.
    out.push_str("── summary ──\n");
    for (mech, group) in &by_mech {
        let lifted = group
            .iter()
            .filter(|r| !r.baseline.quality_pass && r.treatment.quality_pass)
            .count();
        let regressed = group
            .iter()
            .filter(|r| r.baseline.quality_pass && !r.treatment.quality_pass)
            .count();
        let changed = group
            .iter()
            .filter(|r| r.baseline.answer.trim() != r.treatment.answer.trim())
            .count();
        out.push_str(&format!(
            "  {mech}: {} task(s); answer changed in {changed}; quality lift in {lifted}; \
             regression in {regressed}\n",
            group.len()
        ));
    }
    out
}

fn fmt_cost(c: Option<f64>) -> String {
    match c {
        Some(v) => format!("${v:.6}"),
        None => "$NULL".to_string(),
    }
}

fn pass_str(p: bool) -> &'static str {
    if p {
        "PASS"
    } else {
        "FAIL"
    }
}

/// Truncate the answer for display, on a char boundary, with an explicit elision marker.
fn preview(s: &str) -> String {
    let one_line = s.replace('\n', " ");
    if one_line.len() <= ANSWER_PREVIEW_BYTES {
        return one_line;
    }
    let mut end = ANSWER_PREVIEW_BYTES;
    while !one_line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… [{} bytes total]", &one_line[..end], one_line.len())
}

// ───────────────────────────── the per-arm runner ─────────────────────────────

/// Drive ONE arm of ONE task through `run_loop_with_policy_flagged` against the supplied primary +
/// optional escalation client, then aggregate its ledger. The mechanism's flag is INJECTED as a
/// pure bool (rich/critique) or the `escalation_client` Option (escalation) — env-free + per-arm
/// deterministic. A fresh `run_id` per arm keeps the ledger aggregation cleanly separated.
#[allow(clippy::too_many_arguments)]
fn run_arm(
    conn: &Connection,
    workspace_root: &std::path::Path,
    run_id: &str,
    task_text: &str,
    rich_prompt_enabled: bool,
    self_critique_enabled: bool,
    done_criteria: &[String],
    primary: &dyn friday_hub::AgentLlmClient,
    escalation: Option<&dyn friday_hub::AgentLlmClient>,
) -> Result<ArmResult, String> {
    friday_storage::agent_run::create_run(conn, run_id, task_text, 1_000)
        .map_err(|e| format!("create_run({run_id}): {e:?}"))?;
    let executor = FsToolExecutor::new(workspace_root);
    let policy = RunPolicy::new(None, Vec::<String>::new(), false);
    let outcome: LoopOutcome = run_loop_with_policy_flagged(
        primary,
        &executor,
        conn,
        run_id,
        task_text,
        "",   // recall_preamble — none for the harness (we isolate the mechanism)
        None, // operator_vk — unprovisioned (mutating writes Pause; the curated tasks finish)
        &no_approval(),
        &policy,
        MAX_TURNS,
        None, // cancel
        None, // steer
        1_000,
        false, // activity_needs_me
        false, // clarification_enabled — OFF so the gate never short-circuits the A/B
        false, // subagent_enabled
        rich_prompt_enabled,
        self_critique_enabled,
        done_criteria,
        None, // work_item_id — criteria injected directly; no WorkItem ceremony
        escalation,
    )
    .map_err(|e| format!("loop({run_id}): {e:?}"))?;

    let rollup = aggregate_run(conn, run_id).map_err(|e| format!("aggregate({run_id}): {e:?}"))?;
    let answer = outcome.final_message.clone().unwrap_or_default();
    let quality_pass = quality_signal(&answer, done_criteria);
    Ok(ArmResult {
        status: format!("{:?}", outcome.status),
        turns: outcome.turns,
        answer,
        rollup,
        quality_pass,
    })
}

/// A deny-all approval closure — the harness never auto-approves a mutating action (the curated
/// tasks are answer-shaped; a mutating write would Pause, which the report would show honestly).
/// The gate request/approval types live in `friday_core::gate` (the bin's public dependency).
fn no_approval(
) -> impl Fn(&friday_core::gate::MutatingActionRequest) -> Option<friday_core::gate::CanonicalApproval>
{
    |_req| None
}

// ───────────────────────────── arm wiring per mechanism ─────────────────────────────

/// For one task, run BOTH arms with the MOCK client and return the comparison row. This is the
/// deterministic CI/demo path (no real model). The arm wiring matches the mechanism.
fn run_task_mock(
    conn: &Connection,
    workspace_root: &std::path::Path,
    t: &AbTask,
) -> Result<ComparisonRow, String> {
    let base_run = format!("{}-base", t.id);
    let treat_run = format!("{}-treat", t.id);

    // BASELINE arm (mechanism OFF) — its own scripted client; escalation never armed.
    let (base_primary, base_pro) = mock_clients_for(&t.mock_baseline, false);
    let base_pro_dyn = base_pro
        .as_ref()
        .map(|c| c as &dyn friday_hub::AgentLlmClient);
    let baseline = run_arm(
        conn,
        workspace_root,
        &base_run,
        t.task,
        false, // rich OFF
        false, // critique OFF
        &t.done_criteria,
        &base_primary,
        base_pro_dyn,
    )?;

    // TREATMENT arm (mechanism ON) — flags/escalation flipped per the mechanism.
    let (rich_on, critique_on) = match t.mechanism {
        Mechanism::RichPrompt => (true, false),
        Mechanism::SelfCritique => (false, true),
        Mechanism::Escalation => (false, false),
    };
    let escalation_armed = t.mechanism == Mechanism::Escalation;
    let (treat_primary, treat_pro) = mock_clients_for(&t.mock_treatment, escalation_armed);
    let treat_pro_dyn = treat_pro
        .as_ref()
        .map(|c| c as &dyn friday_hub::AgentLlmClient);
    let treatment = run_arm(
        conn,
        workspace_root,
        &treat_run,
        t.task,
        rich_on,
        critique_on,
        &t.done_criteria,
        &treat_primary,
        treat_pro_dyn,
    )?;

    let delta = delta_note(t.mechanism, &baseline, &treatment);
    Ok(ComparisonRow {
        task_id: t.id.to_string(),
        mechanism: t.mechanism.label(),
        flag: t.mechanism.flag(),
        task: t.task.to_string(),
        baseline,
        treatment,
        delta_note: delta,
    })
}

// ───────────────────────────── the real (live DeepSeek) path ─────────────────────────────

/// Run BOTH arms of one task against the REAL DeepSeek client. The flash client is shared-shape
/// (`DeepSeekAgentLlmClient::new`); the pro escalation client is a FRESH forced-`deepseek-v4-pro`
/// client over the SAME key. Each arm gets its own freshly-built clients so the two arms never
/// share mutable state.
#[cfg(not(test))]
fn run_task_real(
    conn: &Connection,
    workspace_root: &std::path::Path,
    t: &AbTask,
) -> Result<ComparisonRow, String> {
    use friday_hub::DeepSeekAgentLlmClient;

    let base_run = format!("{}-base", t.id);
    let treat_run = format!("{}-treat", t.id);

    // BASELINE arm: flash only, mechanism OFF.
    let base_flash = DeepSeekAgentLlmClient::new(
        friday_deepseek::DeepSeekClient::from_env()
            .map_err(|e| format!("DeepSeek key/init (baseline {}): {e}", t.id))?,
    );
    let baseline = run_arm(
        conn,
        workspace_root,
        &base_run,
        t.task,
        false,
        false,
        &t.done_criteria,
        &base_flash,
        None,
    )?;

    // TREATMENT arm: flags/escalation flipped per mechanism, fresh real clients.
    let (rich_on, critique_on) = match t.mechanism {
        Mechanism::RichPrompt => (true, false),
        Mechanism::SelfCritique => (false, true),
        Mechanism::Escalation => (false, false),
    };
    let treat_flash = DeepSeekAgentLlmClient::new(
        friday_deepseek::DeepSeekClient::from_env()
            .map_err(|e| format!("DeepSeek key/init (treatment {}): {e}", t.id))?,
    );
    // The pro escalation client (a#3) — built only for the escalation mechanism.
    let treat_pro = if t.mechanism == Mechanism::Escalation {
        Some(DeepSeekAgentLlmClient::with_model(
            friday_deepseek::DeepSeekClient::from_env()
                .map_err(|e| format!("DeepSeek-pro key/init ({}): {e}", t.id))?,
            DEEPSEEK_PRO_MODEL,
        ))
    } else {
        None
    };
    let treat_pro_dyn = treat_pro
        .as_ref()
        .map(|c| c as &dyn friday_hub::AgentLlmClient);
    let treatment = run_arm(
        conn,
        workspace_root,
        &treat_run,
        t.task,
        rich_on,
        critique_on,
        &t.done_criteria,
        &treat_flash,
        treat_pro_dyn,
    )?;

    let delta = delta_note(t.mechanism, &baseline, &treatment);
    Ok(ComparisonRow {
        task_id: t.id.to_string(),
        mechanism: t.mechanism.label(),
        flag: t.mechanism.flag(),
        task: t.task.to_string(),
        baseline,
        treatment,
        delta_note: delta,
    })
}

// ───────────────────────────── entrypoint ─────────────────────────────

/// A throwaway hub DB for the harness (the loop writes `agent_run` + `token_ledger`; we then read
/// the ledger back). A unique temp path keeps each invocation hermetic. Used only by the runtime
/// entrypoint (`real_main`); the tests open their own.
#[cfg(not(test))]
fn open_harness_db() -> Result<friday_storage::Db, String> {
    // A unique temp path so concurrent invocations never collide on the schema bootstrap.
    let path = std::env::temp_dir().join(format!("friday_ab_{}.sqlite", unique_suffix()));
    friday_storage::Db::open_hub(&path.to_string_lossy()).map_err(|e| format!("open_hub: {e:?}"))
}

#[cfg(not(test))]
fn main() {
    match real_main() {
        Ok(()) => {}
        Err(e) => {
            // A clear fail-fast message (e.g. missing key) on stderr + a non-zero exit — NEVER a
            // silent pass. The error string carries no secret.
            eprintln!("cheap_vs_strong_ab: {e}");
            std::process::exit(1);
        }
    }
}

/// `real_main` returns a clear error string on the fail-fast paths (no key, bad arg) so `main` can
/// print it and exit non-zero — a missing key is NEVER a silent pass.
#[cfg(not(test))]
fn real_main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mock = args.iter().any(|a| a == "--mock-demo");
    let real = args.iter().any(|a| a == "--real");
    // --only <mechanism> restricts the set (rich | escalation | critique).
    let only: Option<Mechanism> = args
        .iter()
        .position(|a| a == "--only")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| Mechanism::parse(s));

    if mock == real {
        return Err(
            "specify exactly one of --mock-demo (CI-safe, no key) or --real (needs \
             FRIDAY_DEEPSEEK_API_KEY, spends quota). e.g. `--mock-demo`"
                .to_string(),
        );
    }

    let tasks: Vec<AbTask> = curated_tasks()
        .into_iter()
        .filter(|t| only.map(|m| t.mechanism == m).unwrap_or(true))
        .collect();
    if tasks.is_empty() {
        return Err("no tasks selected (check --only value: rich|escalation|critique)".to_string());
    }

    let db = open_harness_db()?;
    let workspace = std::env::temp_dir().join(format!("friday_ab_ws_{}", std::process::id()));
    std::fs::create_dir_all(&workspace).map_err(|e| format!("workspace: {e}"))?;

    let mode;
    let mut rows = Vec::new();
    if real {
        // FAIL-FAST when the key is absent — NOT a silent pass. (The real client's `from_env` would
        // also fail, but we check up front so the message is unambiguous and no run is half-done.)
        if friday_deepseek::api_key_from_env_var(friday_deepseek::ENV_KEY).is_err() {
            return Err(format!(
                "--real requires the DeepSeek key in env var {} (the SAME var the hub reads); \
                 it is absent or empty. Set it and re-run, or use --mock-demo for the CI-safe path.",
                friday_deepseek::ENV_KEY
            ));
        }
        mode = "REAL DeepSeek";
        for t in &tasks {
            rows.push(run_task_real(db.conn(), &workspace, t)?);
        }
    } else {
        mode = "MOCK (scripted, no real call)";
        for t in &tasks {
            rows.push(run_task_mock(db.conn(), &workspace, t)?);
        }
    }

    print!("{}", render_report(&rows, mode));
    Ok(())
}

// ───────────────────────────── tests (NO real call — scripted only) ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> friday_storage::Db {
        let path = std::env::temp_dir().join(format!("friday_ab_test_{}.sqlite", unique_suffix()));
        friday_storage::Db::open_hub(&path.to_string_lossy()).unwrap()
    }

    fn workspace() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("friday_ab_test_ws_{}", unique_suffix()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// The whole curated set runs through the MOCK A/B and yields one comparison row per task with
    /// BOTH arms populated (the report-shape proof; NO real call).
    #[test]
    fn mock_ab_produces_one_comparison_row_per_task_both_arms() {
        let db = mem_db();
        let ws = workspace();
        let tasks = curated_tasks();
        let rows: Vec<ComparisonRow> = tasks
            .iter()
            .map(|t| run_task_mock(db.conn(), &ws, t).unwrap())
            .collect();
        assert_eq!(rows.len(), tasks.len(), "one row per curated task");
        for r in &rows {
            // Both arms finished (the curated tasks are finish-shaped; the escalation treatment
            // recovers the flash parse-fail via pro).
            assert_eq!(
                r.baseline.status, "Finished",
                "{} baseline finished",
                r.task_id
            );
            assert_eq!(
                r.treatment.status, "Finished",
                "{} treatment finished",
                r.task_id
            );
            // Every arm billed at least one model call (a finish chat spends tokens).
            assert!(
                r.baseline.rollup.billed_calls >= 1,
                "{} baseline billed",
                r.task_id
            );
            assert!(
                r.treatment.rollup.billed_calls >= 1,
                "{} treat billed",
                r.task_id
            );
            // The flag + mechanism labels are stamped.
            assert!(!r.flag.is_empty() && !r.mechanism.is_empty());
            assert!(!r.delta_note.is_empty(), "{} has a delta note", r.task_id);
        }
        // The report renders to non-empty deterministic text mentioning every flag.
        let report = render_report(&rows, "MOCK (test)");
        assert!(report.contains("FRIDAY_RICH_SYSTEM_PROMPT_ENABLED"));
        assert!(report.contains("FRIDAY_QUALITY_ESCALATION_ENABLED"));
        assert!(report.contains("FRIDAY_SELF_CRITIQUE_ENABLED"));
        assert!(report.contains("── summary ──"));
    }

    /// The MULTI-STEP TOOL task drives a 2-turn run through the real `FsToolExecutor`: turn 1
    /// dispatches `read_file` (threaded into history), turn 2 finishes — so each arm bills at least
    /// 2 rows and runs >1 turn. The treatment's self-critique then revises the deficient finish to
    /// cite the artifacts (FAIL→PASS), proving the a#2 path over a tool-using run, not just a Q&A.
    #[test]
    fn tool_task_runs_two_turns_through_executor_and_critique_lifts() {
        let db = mem_db();
        let ws = workspace();
        let t = curated_tasks()
            .into_iter()
            .find(|t| t.id == "critique-tooltask-read-then-answer")
            .unwrap();
        let row = run_task_mock(db.conn(), &ws, &t).unwrap();
        // Both arms run the tool turn + the finish turn (>1 turn, >=2 billed rows).
        assert!(
            row.baseline.turns >= 2,
            "baseline ran the tool turn + finish (turns={})",
            row.baseline.turns
        );
        assert!(
            row.baseline.rollup.billed_calls >= 2,
            "tool turn + finish = >=2 billed rows (got {})",
            row.baseline.rollup.billed_calls
        );
        // Baseline finish is deficient (no artifacts) ⇒ FAIL; treatment critique revises ⇒ PASS.
        assert!(!row.baseline.quality_pass, "baseline deficient ⇒ FAIL");
        assert!(row.treatment.quality_pass, "critique-revised ⇒ PASS");
        assert!(row
            .treatment
            .answer
            .to_lowercase()
            .contains("src/limiter.rs"));
        assert!(row.treatment.answer.to_lowercase().contains("last_refill"));
        // The critique re-prompt is an extra billed call beyond the baseline's tool+finish.
        assert!(
            row.treatment.rollup.billed_calls > row.baseline.rollup.billed_calls,
            "critique re-prompt adds a billed row ({} > {})",
            row.treatment.rollup.billed_calls,
            row.baseline.rollup.billed_calls
        );
        assert!(row.delta_note.contains("self-critique FIRED"));
    }

    /// a#1 rich-prompt arm: the treatment (rich ON) uses a richer scripted answer ⇒ the answer
    /// CHANGES and the delta note says so. (The bool flips; the loop carries it.)
    #[test]
    fn rich_prompt_arm_changes_answer_and_notes_it() {
        let db = mem_db();
        let ws = workspace();
        let t = curated_tasks()
            .into_iter()
            .find(|t| t.id == "rich-planning-build")
            .unwrap();
        let row = run_task_mock(db.conn(), &ws, &t).unwrap();
        assert_ne!(
            row.baseline.answer.trim(),
            row.treatment.answer.trim(),
            "rich-prompt treatment answer differs from baseline"
        );
        assert!(
            row.treatment.rollup.total_tokens > row.baseline.rollup.total_tokens,
            "richer prompt ⇒ more tokens"
        );
        assert!(row.delta_note.contains("rich prompt CHANGED the answer"));
    }

    /// a#3 escalation FIRES: the treatment flash leg parse-fails, the pro client is wired, and a
    /// SECOND (pro) ledger row appears — two billed calls vs the baseline's one. The recovered
    /// answer is pro's.
    #[test]
    fn escalation_fires_bills_second_pro_row_and_recovers() {
        let db = mem_db();
        let ws = workspace();
        let t = curated_tasks()
            .into_iter()
            .find(|t| t.id == "escalation-hard-json")
            .unwrap();
        let row = run_task_mock(db.conn(), &ws, &t).unwrap();
        assert_eq!(
            row.treatment.status, "Finished",
            "pro recovers the parse-fail"
        );
        assert_eq!(
            row.treatment.rollup.billed_calls, 2,
            "flash leg + pro leg = two truthful rows"
        );
        assert_eq!(
            row.baseline.rollup.billed_calls, 1,
            "baseline flash finishes in one call"
        );
        assert_eq!(row.treatment.answer.trim(), "128", "pro's answer is used");
        assert!(row.delta_note.contains("escalation FIRED"));
        // The pro row prices off the a#4 table (pro is a known pair) ⇒ a Some cost.
        assert!(
            row.treatment.rollup.cost_usd.is_some(),
            "pro pair is priced"
        );
    }

    /// a#3 escalation NEVER fires on a well-behaved task: flash parses cleanly, no pro call ⇒ the
    /// arms are token-identical and the note says "INERT, zero delta" — the honest finding.
    #[test]
    fn escalation_inert_on_wellbehaved_task_zero_delta() {
        let db = mem_db();
        let ws = workspace();
        let t = curated_tasks()
            .into_iter()
            .find(|t| t.id == "escalation-wellbehaved")
            .unwrap();
        let row = run_task_mock(db.conn(), &ws, &t).unwrap();
        assert_eq!(row.baseline.rollup.billed_calls, 1);
        assert_eq!(
            row.treatment.rollup.billed_calls, 1,
            "no pro call ⇒ still one billed row"
        );
        assert_eq!(
            row.baseline.rollup.total_tokens, row.treatment.rollup.total_tokens,
            "inert ⇒ token-identical arms"
        );
        assert!(row.delta_note.contains("NEVER fired"));
    }

    /// a#2 self-critique FIRES: the baseline (flag OFF) accepts a deficient answer (FAIL signal);
    /// the treatment (flag ON, non-empty criteria, deficient first answer) re-prompts ONCE and the
    /// revised answer cites the required artifact ⇒ quality FAIL→PASS, and an extra critique call
    /// is billed.
    #[test]
    fn self_critique_fires_lifts_quality_and_bills_extra_call() {
        let db = mem_db();
        let ws = workspace();
        let t = curated_tasks()
            .into_iter()
            .find(|t| t.id == "critique-cite-artifact")
            .unwrap();
        let row = run_task_mock(db.conn(), &ws, &t).unwrap();
        // Baseline answer is deficient against the criteria ⇒ FAIL.
        assert!(!row.baseline.quality_pass, "baseline deficient ⇒ FAIL");
        // Treatment re-prompt cites src/limiter.rs ⇒ PASS.
        assert!(
            row.treatment.quality_pass,
            "critique revised answer passes ⇒ PASS"
        );
        assert!(
            row.treatment
                .answer
                .to_lowercase()
                .contains("src/limiter.rs"),
            "revised answer cites the required artifact"
        );
        // The critique re-prompt is a SECOND billed call (turn + critique sub-call).
        assert_eq!(
            row.treatment.rollup.billed_calls, 2,
            "finish turn + one critique re-prompt = two billed rows"
        );
        assert_eq!(
            row.baseline.rollup.billed_calls, 1,
            "baseline accepts the first answer ⇒ one billed row"
        );
        assert!(row.delta_note.contains("self-critique FIRED"));
        assert!(row.delta_note.contains("FAIL→PASS"));
    }

    /// a#2 self-critique INERT: the first answer already satisfies the criteria ⇒ no re-prompt ⇒
    /// arms are token-identical and quality is PASS on both — zero delta (honest).
    #[test]
    fn self_critique_inert_when_first_answer_passes() {
        let db = mem_db();
        let ws = workspace();
        let t = curated_tasks()
            .into_iter()
            .find(|t| t.id == "critique-already-passes")
            .unwrap();
        let row = run_task_mock(db.conn(), &ws, &t).unwrap();
        assert!(
            row.baseline.quality_pass && row.treatment.quality_pass,
            "both PASS"
        );
        assert_eq!(
            row.baseline.rollup.billed_calls, row.treatment.rollup.billed_calls,
            "no critique re-prompt ⇒ same billed-call count"
        );
        assert!(row.delta_note.contains("INERT"));
    }

    /// `aggregate_run` is a faithful PURE rollup: a run with two billed rows sums tokens + cost.
    #[test]
    fn aggregate_run_sums_tokens_and_cost_over_a_run() {
        let db = mem_db();
        let ws = workspace();
        // Drive the escalation-fires task so a run has TWO ledger rows (flash + pro).
        let t = curated_tasks()
            .into_iter()
            .find(|t| t.id == "escalation-hard-json")
            .unwrap();
        let row = run_task_mock(db.conn(), &ws, &t).unwrap();
        let agg = &row.treatment.rollup;
        assert_eq!(agg.billed_calls, 2);
        // tokens = flash(36+40) + pro(36+8) = 120.
        assert_eq!(
            agg.total_tokens,
            76 + 44,
            "summed total_tokens across both rows"
        );
        assert!(agg.cost_usd.unwrap() > 0.0, "summed cost is positive");
    }

    /// The deterministic quality signal mirrors `answer_passes_done_criteria`: an artifact token in
    /// the criteria must appear in the answer; a no-criteria task passes on any non-empty answer.
    #[test]
    fn quality_signal_requires_artifact_token_from_criteria() {
        let criteria = vec!["must reference src/limiter.rs here".to_string()];
        assert!(!quality_signal(
            "put it in the middleware folder",
            &criteria
        ));
        assert!(quality_signal("add it to src/limiter.rs now", &criteria));
        // No criteria ⇒ any non-empty answer passes; empty fails.
        assert!(quality_signal("anything", &[]));
        assert!(!quality_signal("   ", &[]));
    }

    /// `delta_note` names the three honest shapes: rich-changed, escalation-fired/never,
    /// critique-fired/inert — and always carries the token+cost delta.
    #[test]
    fn delta_note_names_fired_vs_inert() {
        let base = ArmResult {
            status: "Finished".into(),
            turns: 1,
            answer: "x".into(),
            rollup: RunRollup {
                billed_calls: 1,
                total_tokens: 10,
                cost_usd: Some(0.001),
            },
            quality_pass: false,
        };
        let treat_fired = ArmResult {
            status: "Finished".into(),
            turns: 1,
            answer: "y".into(),
            rollup: RunRollup {
                billed_calls: 2,
                total_tokens: 30,
                cost_usd: Some(0.003),
            },
            quality_pass: true,
        };
        let note = delta_note(Mechanism::SelfCritique, &base, &treat_fired);
        assert!(note.contains("self-critique FIRED"));
        assert!(note.contains("FAIL→PASS"));
        assert!(note.contains("tokens 10→30"));
        assert!(note.contains("cost $"));

        // Inert escalation: identical arms.
        let treat_inert = base.clone();
        let note2 = delta_note(Mechanism::Escalation, &base, &treat_inert);
        assert!(note2.contains("NEVER fired"));
        assert!(note2.contains("Δ+0"));
    }

    /// Mechanism flag/label mapping is exact (the report stamps the real env-var names).
    #[test]
    fn mechanism_flag_and_label_mapping_is_exact() {
        assert_eq!(
            Mechanism::RichPrompt.flag(),
            "FRIDAY_RICH_SYSTEM_PROMPT_ENABLED"
        );
        assert_eq!(
            Mechanism::Escalation.flag(),
            "FRIDAY_QUALITY_ESCALATION_ENABLED"
        );
        assert_eq!(
            Mechanism::SelfCritique.flag(),
            "FRIDAY_SELF_CRITIQUE_ENABLED"
        );
        assert_eq!(Mechanism::parse("rich"), Some(Mechanism::RichPrompt));
        assert_eq!(Mechanism::parse("esc"), Some(Mechanism::Escalation));
        assert_eq!(
            Mechanism::parse("self_critique"),
            Some(Mechanism::SelfCritique)
        );
        assert_eq!(Mechanism::parse("nope"), None);
    }
}
