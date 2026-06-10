//! S8 — TS published-version → Rust LINEAR-ONLY workflow translator. DARK
//! substrate: no production route, no scheduler, no TS runtime change; workflow
//! execution remains fenced in TS and is NOT product-replaced; NOT v1 GO.
//!
//! ## Source format (cited from the TS oracle)
//! A TS workflow's published version is `FridayWorkflowVersionEntity.graphJson`
//! (`src/workflows/model/friday-workflow.types.ts`, persisted as
//! `workflow_versions.graph_json` since `v001-initial.ts`). Its parsed shape is
//! `FridayCompiledWorkflowGraphV2` (`src/workflows/model/friday-workflow-graph.types.ts`):
//! `{ schemaVersion:"2.0", graph:{ nodes, edges, variables? }, failurePolicy,
//! tests, checksum }` — and the TS `parseGraphJson` also accepts RAW graphs with
//! top-level `nodes`/`edges`, which this translator mirrors. Node types are
//! `trigger | action | condition | data | ai | approval` with the TS aliases
//! `start→trigger`, `tool_call/skill_call→action`, `transform→data`,
//! `human_approval→approval`. An `action` node names its callee via
//! `config.skillId ?? config.ref` and passes `config.args`
//! (`src/node-runner/engine/workflow-action-adapter.ts`); a STRING arg starting
//! with `$` is an EXPRESSION the TS evaluator resolves at run time
//! (`resolveValue` in `src/workflows/engine/friday-workflow-node-executor.ts`).
//!
//! ## HARD RULE (operator decision Q2, binding): LINEAR-ONLY, fail-closed
//! Only the LINEAR subset translates. ANY DAG/branch/parallel/unsupported
//! feature in the source produces an explicit, fail-closed
//! [`TsTranslation::Unsupported`] carrying per-feature reasons + preserved
//! refs-only source metadata — NEVER a silent flattening, NEVER a partial
//! translation that drops nodes, NEVER misrepresented as supported. The full
//! source is scanned (all blockers are reported, not just the first), so the
//! honest gap list is complete.
//!
//! What fails closed (the chasm, kept visible — never claim DAG parity):
//! - **branching/parallel topology**: fan-out, fan-in, multiple entry nodes,
//!   disconnected islands, cycles, conditional edges, edge ports;
//! - **node types** with no Rust executor semantics: `condition`, `data`
//!   (incl. the `transform` alias), `ai`, `approval`, unknown types (the TS
//!   parser defaults unknown types to `action`; this translator deliberately
//!   does NOT — defaulting an unknown type would misrepresent it as supported);
//! - **triggers** other than a single leading manual trigger (schedule/event
//!   triggers are S10 scheduler scope, operator-gated);
//! - **actions** whose callee does not canonicalize to a Rust
//!   [`crate::ToolRegistry`] action via the single-source-of-truth
//!   [`crate::tool_name_map::canonical_rust_name`] (a TS-only skill/tool must
//!   not be stored as if runnable);
//! - **expression args** (`$…`), non-scalar args, unsafe keys, and the
//!   `exec`-only knobs (`workdir`/`env`/`timeoutMs`/`background`) recorded in
//!   [`crate::tool_name_map::PARAM_SCHEMA_DIFFS`] as having no Rust surface;
//! - **per-step retry policies** (maxAttempts > 1) and **timeouts** (the Rust
//!   engine has no per-step retry/timeout; dropping them silently would remove
//!   a bound the author set);
//! - **failure policies** other than `fail_fast` (the Rust engine fails the
//!   run on a step error; honoring `continue_on_error`/`fallback_step`/
//!   `compensate`/`pause_for_approval` is unbuilt);
//! - **graph variables** (no variable substitution exists in the Rust engine).
//!
//! What IS translated for a pure-linear source: the ordered `action` chain →
//! [`crate::workflow_def::StoredWorkflowDefV1`] steps (TS aliases mapped to
//! canonical Rust actions; `edit`'s `oldText`/`newText` renamed to
//! `old_text`/`new_text` per the recorded param-schema diff; scalar args
//! stringified). A single LEADING manual trigger contributes no step and is
//! recorded in the metadata (`manual_trigger_elided`) — an explicit record,
//! not a silent drop. `tests` in the source are fixtures, not executable
//! semantics; their count is preserved in the metadata.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::tool_name_map::canonical_rust_name;
use crate::workflow_def::{StoredWorkflowDefV1, StoredWorkflowStepV1, WORKFLOW_DEF_SCHEMA_VERSION};

/// Refs-only provenance preserved from the TS source: ids / counts / coarse
/// labels ONLY — never node configs, args, prompts, or secrets. Serializable so
/// it can be persisted into `workflow_definition.source_meta`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TsSourceMeta {
    /// `schemaVersion` of the compiled graph (e.g. `"2.0"`), when present.
    pub source_schema_version: Option<String>,
    pub workflow_id: Option<String>,
    pub workflow_version_id: Option<String>,
    /// The SOURCE graph's own checksum field (not the Rust row checksum).
    pub source_checksum: Option<String>,
    pub node_count: usize,
    pub edge_count: usize,
    /// Normalized node-type histogram (refs-only labels).
    pub node_type_counts: BTreeMap<String, usize>,
    pub test_count: usize,
    /// True when a single LEADING manual trigger node was honestly elided (it
    /// is an entry marker, not an executable step).
    pub manual_trigger_elided: bool,
}

/// One explicit, per-feature blocker. `feature` is a closed-vocabulary label;
/// `reason` is an honest human-readable explanation; `node_or_edge` names the
/// offending element when there is one (an id/label — refs-only).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UnsupportedFeature {
    pub feature: &'static str,
    pub node_or_edge: Option<String>,
    pub reason: String,
}

/// The translator's fail-closed result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TsTranslation {
    /// The source is pure-linear and fully translated.
    Linear {
        definition: StoredWorkflowDefV1,
        source_meta: TsSourceMeta,
    },
    /// The source uses at least one unsupported feature. NOTHING was
    /// translated (never partial); every blocker is listed.
    Unsupported {
        reasons: Vec<UnsupportedFeature>,
        preserved_source_meta: TsSourceMeta,
    },
}

// --- normalized intermediate shapes ------------------------------------------

struct TsNode {
    id: String,
    /// normalized type label, or the raw label when unknown (reported, never defaulted)
    node_type: Result<&'static str, String>,
    config: Map<String, Value>,
    retry_policy: Option<Value>,
    timeout_ms: Option<Value>,
}

struct TsEdge {
    id: String,
    source: Option<String>,
    target: Option<String>,
    condition: Option<String>,
    has_ports: bool,
}

/// Mirror of the TS `normalizeWorkflowNodeType` alias table — minus its
/// unknown→`action` default, which this translator deliberately fails closed.
fn normalize_node_type(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "trigger" | "start" => Ok("trigger"),
        "action" | "tool_call" | "skill_call" => Ok("action"),
        "condition" => Ok("condition"),
        "data" | "transform" => Ok("data"),
        "ai" => Ok("ai"),
        "approval" | "human_approval" => Ok("approval"),
        other => Err(other.to_string()),
    }
}

fn as_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn as_object(v: Option<&Value>) -> Option<&Map<String, Value>> {
    v.and_then(Value::as_object)
}

/// The selected graph level: raw node/edge arrays plus the object that carries
/// graph-level fields (e.g. `variables`).
struct GraphSource<'a> {
    nodes: &'a Vec<Value>,
    edges: Vec<Value>,
    graph_level: &'a Map<String, Value>,
}

/// Mirror of TS `parseGraphJson`'s source selection: `graph.nodes` (compiled
/// v2) or top-level `nodes` (raw/generated), with edges from the same level.
fn select_nodes_edges(raw: &Map<String, Value>) -> Option<GraphSource<'_>> {
    if let Some(graph) = as_object(raw.get("graph")) {
        if let Some(nodes) = graph.get("nodes").and_then(Value::as_array) {
            let edges = graph
                .get("edges")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            return Some(GraphSource {
                nodes,
                edges,
                graph_level: graph,
            });
        }
    }
    if let Some(nodes) = raw.get("nodes").and_then(Value::as_array) {
        let edges = raw
            .get("edges")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        return Some(GraphSource {
            nodes,
            edges,
            graph_level: raw,
        });
    }
    None
}

fn normalize_node(v: &Value, index: usize) -> TsNode {
    let obj = v.as_object();
    let id = obj
        .and_then(|o| as_str(o.get("id")))
        // mirror the TS parser's positional default id
        .unwrap_or_else(|| format!("node-{}", index + 1));
    let raw_type = obj
        .and_then(|o| as_str(o.get("type")).or_else(|| as_str(o.get("kind"))))
        .unwrap_or_default();
    let node_type = normalize_node_type(&raw_type);
    let config = obj
        .and_then(|o| {
            as_object(o.get("config"))
                .or_else(|| as_object(o.get("data")))
                .cloned()
        })
        .unwrap_or_default();
    TsNode {
        id,
        node_type,
        config,
        retry_policy: obj.and_then(|o| o.get("retryPolicy")).cloned(),
        timeout_ms: obj.and_then(|o| o.get("timeoutMs")).cloned(),
    }
}

fn normalize_edge(v: &Value, index: usize) -> TsEdge {
    let obj = v.as_object();
    let pick = |keys: &[&str]| -> Option<String> {
        obj.and_then(|o| keys.iter().find_map(|k| as_str(o.get(*k))))
    };
    let source = pick(&["sourceNodeId", "source", "from"]);
    let target = pick(&["targetNodeId", "target", "to"]);
    TsEdge {
        id: pick(&["id"]).unwrap_or_else(|| format!("edge-{}", index + 1)),
        source,
        target,
        condition: pick(&["condition", "when"]),
        has_ports: obj
            .is_some_and(|o| o.contains_key("sourcePort") || o.contains_key("targetPort")),
    }
}

fn build_meta(raw: &Map<String, Value>, nodes: &[TsNode], edge_count: usize) -> TsSourceMeta {
    let mut node_type_counts: BTreeMap<String, usize> = BTreeMap::new();
    for n in nodes {
        let label = match &n.node_type {
            Ok(t) => (*t).to_string(),
            Err(raw_label) if raw_label.is_empty() => "missing".to_string(),
            Err(_) => "unknown".to_string(),
        };
        *node_type_counts.entry(label).or_insert(0) += 1;
    }
    TsSourceMeta {
        source_schema_version: as_str(raw.get("schemaVersion")),
        workflow_id: as_str(raw.get("workflowId")),
        workflow_version_id: as_str(raw.get("workflowVersionId")),
        source_checksum: as_str(raw.get("checksum")),
        node_count: nodes.len(),
        edge_count,
        node_type_counts,
        test_count: raw
            .get("tests")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
        manual_trigger_elided: false,
    }
}

fn empty_meta() -> TsSourceMeta {
    TsSourceMeta {
        source_schema_version: None,
        workflow_id: None,
        workflow_version_id: None,
        source_checksum: None,
        node_count: 0,
        edge_count: 0,
        node_type_counts: BTreeMap::new(),
        test_count: 0,
        manual_trigger_elided: false,
    }
}

/// Keys whose presence in a trigger config means the trigger is NOT manual
/// (schedule/event triggers are S10 scheduler scope — operator-gated, unbuilt).
const NON_MANUAL_TRIGGER_KEYS: &[&str] = &["cron", "schedule", "interval", "event", "source"];

/// TS `resolveArgs` drops these silently; the translator fails closed instead.
const UNSAFE_ARG_KEYS: &[&str] = &["__proto__", "constructor", "prototype"];

/// `exec`-only knobs with no Rust `run_command` surface
/// ([`crate::tool_name_map::PARAM_SCHEMA_DIFFS`]); silently dropping them would
/// change semantics (e.g. lose a cwd or a timeout), so they fail closed.
const EXEC_ONLY_KEYS: &[&str] = &["workdir", "env", "timeoutMs", "background"];

/// Translate a TS published-version workflow graph (the
/// `FridayWorkflowVersionEntity.graphJson` value) into the Rust LINEAR-ONLY
/// stored definition. `name` is the TS workflow's display name (it lives on
/// the workflow entity, not inside the graph). See module docs for the binding
/// fail-closed rules.
pub fn translate_ts_published_version(graph_json: &Value, name: &str) -> TsTranslation {
    let mut reasons: Vec<UnsupportedFeature> = Vec::new();

    let Some(raw) = graph_json.as_object() else {
        return TsTranslation::Unsupported {
            reasons: vec![UnsupportedFeature {
                feature: "unparseable_graph",
                node_or_edge: None,
                reason: "graph JSON must be a non-null object (mirrors the TS parseGraphJson \
                         contract)"
                    .into(),
            }],
            preserved_source_meta: empty_meta(),
        };
    };

    let Some(GraphSource {
        nodes: raw_nodes,
        edges: raw_edges,
        graph_level,
    }) = select_nodes_edges(raw)
    else {
        return TsTranslation::Unsupported {
            reasons: vec![UnsupportedFeature {
                feature: "unparseable_graph",
                node_or_edge: None,
                reason: "graph must contain a 'nodes' array (top level or under 'graph')".into(),
            }],
            preserved_source_meta: build_meta(raw, &[], 0),
        };
    };

    let nodes: Vec<TsNode> = raw_nodes
        .iter()
        .enumerate()
        .map(|(i, v)| normalize_node(v, i))
        .collect();
    let edges: Vec<TsEdge> = raw_edges
        .iter()
        .enumerate()
        .map(|(i, v)| normalize_edge(v, i))
        .collect();
    let mut meta = build_meta(raw, &nodes, edges.len());

    if nodes.is_empty() {
        reasons.push(UnsupportedFeature {
            feature: "empty_graph",
            node_or_edge: None,
            reason: "the source graph has no nodes; an empty workflow is not translatable".into(),
        });
    }

    // --- per-node feature scan ------------------------------------------------
    let mut seen_ids = std::collections::HashSet::new();
    let mut trigger_ids: Vec<&str> = Vec::new();
    for node in &nodes {
        if !seen_ids.insert(node.id.as_str()) {
            reasons.push(UnsupportedFeature {
                feature: "duplicate_node_id",
                node_or_edge: Some(node.id.clone()),
                reason: format!("node id '{}' appears more than once", node.id),
            });
        }
        match &node.node_type {
            Ok("trigger") => {
                trigger_ids.push(&node.id);
                scan_trigger(node, &mut reasons);
            }
            Ok("action") => scan_action(node, &mut reasons),
            Ok("condition") => reasons.push(UnsupportedFeature {
                feature: "branch_condition_node",
                node_or_edge: Some(node.id.clone()),
                reason: format!(
                    "node '{}' is a condition node: branching is not supported (LINEAR-ONLY v1, \
                     operator decision Q2); fail-closed, never flattened",
                    node.id
                ),
            }),
            Ok("data") => reasons.push(UnsupportedFeature {
                feature: "transform_node",
                node_or_edge: Some(node.id.clone()),
                reason: format!(
                    "node '{}' is a data/transform node: the Rust engine has no \
                     transform/expression evaluator; fail-closed, never dropped",
                    node.id
                ),
            }),
            Ok("ai") => reasons.push(UnsupportedFeature {
                feature: "ai_node",
                node_or_edge: Some(node.id.clone()),
                reason: format!(
                    "node '{}' is an ai node: model-driven steps are not part of the linear \
                     built-in-tool subset",
                    node.id
                ),
            }),
            Ok("approval") => reasons.push(UnsupportedFeature {
                feature: "approval_node",
                node_or_edge: Some(node.id.clone()),
                reason: format!(
                    "node '{}' is an approval node: TS approval semantics are not mapped in v1 \
                     (the Rust planner/gate already checkpoint mutating steps, but an explicit \
                     approval NODE is a distinct construct; fail-closed rather than approximated)",
                    node.id
                ),
            }),
            Ok(other) => reasons.push(UnsupportedFeature {
                // unreachable with the current normalize table; fail closed anyway.
                feature: "unknown_node_type",
                node_or_edge: Some(node.id.clone()),
                reason: format!("node '{}' has unhandled normalized type '{other}'", node.id),
            }),
            Err(raw_label) => reasons.push(UnsupportedFeature {
                feature: "unknown_node_type",
                node_or_edge: Some(node.id.clone()),
                reason: format!(
                    "node '{}' has unknown type '{raw_label}'; the TS parser would default it to \
                     'action' but this translator fails closed (defaulting would misrepresent it \
                     as supported)",
                    node.id
                ),
            }),
        }
        if let Some(retry) = &node.retry_policy {
            let single_attempt = retry
                .as_object()
                .and_then(|o| o.get("maxAttempts"))
                .and_then(Value::as_i64)
                .is_some_and(|n| n <= 1);
            if !single_attempt {
                reasons.push(UnsupportedFeature {
                    feature: "step_retry_policy",
                    node_or_edge: Some(node.id.clone()),
                    reason: format!(
                        "node '{}' carries a retryPolicy with retries: the Rust engine has no \
                         per-step retry; silently dropping it would change semantics",
                        node.id
                    ),
                });
            }
        }
        if node.timeout_ms.as_ref().is_some_and(|v| !v.is_null()) {
            reasons.push(UnsupportedFeature {
                feature: "step_timeout",
                node_or_edge: Some(node.id.clone()),
                reason: format!(
                    "node '{}' sets timeoutMs: the Rust engine has no per-step timeout; silently \
                     dropping it would remove a bound the author set",
                    node.id
                ),
            });
        }
    }
    if trigger_ids.len() > 1 {
        reasons.push(UnsupportedFeature {
            feature: "multiple_triggers",
            node_or_edge: Some(trigger_ids.join(",")),
            reason: "more than one trigger node (parallel entry semantics)".into(),
        });
    }

    // --- edge feature scan ------------------------------------------------------
    let node_ids: std::collections::HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    for edge in &edges {
        if let Some(cond) = &edge.condition {
            reasons.push(UnsupportedFeature {
                feature: "conditional_edge",
                node_or_edge: Some(edge.id.clone()),
                reason: format!(
                    "edge '{}' carries condition '{cond}': conditional routing is branching \
                     (LINEAR-ONLY v1); fail-closed, never flattened",
                    edge.id
                ),
            });
        }
        if edge.has_ports {
            reasons.push(UnsupportedFeature {
                feature: "edge_ports",
                node_or_edge: Some(edge.id.clone()),
                reason: format!(
                    "edge '{}' uses sourcePort/targetPort: port-routed multi-output topology is \
                     not part of the linear subset",
                    edge.id
                ),
            });
        }
        match (&edge.source, &edge.target) {
            (Some(s), Some(t))
                if node_ids.contains(s.as_str()) && node_ids.contains(t.as_str()) => {}
            _ => reasons.push(UnsupportedFeature {
                feature: "edge_dangling",
                node_or_edge: Some(edge.id.clone()),
                reason: format!(
                    "edge '{}' references a missing/empty endpoint (source: {:?}, target: {:?})",
                    edge.id, edge.source, edge.target
                ),
            }),
        }
    }

    // --- graph-level features ----------------------------------------------------
    if graph_level
        .get("variables")
        .and_then(Value::as_object)
        .is_some_and(|m| !m.is_empty())
    {
        reasons.push(UnsupportedFeature {
            feature: "graph_variables",
            node_or_edge: None,
            reason: "the graph declares variables: the Rust engine has no variable \
                     substitution; fail-closed"
                .into(),
        });
    }
    if let Some(policy) = raw.get("failurePolicy").and_then(Value::as_object) {
        if let Some(strategy) = as_str(policy.get("onFailure")) {
            if strategy != "fail_fast" {
                reasons.push(UnsupportedFeature {
                    feature: "failure_policy",
                    node_or_edge: None,
                    reason: format!(
                        "failurePolicy.onFailure = '{strategy}': the Rust engine only fail-fasts \
                         (continue_on_error/fallback_step/compensate/pause_for_approval are \
                         unbuilt); translating it would misrepresent the policy as honored"
                    ),
                });
            }
        }
    }

    // --- topology: must be ONE linear chain covering every node -------------------
    // Only meaningful when edges are structurally sound; dangling edges were
    // already reported and would make degree counts misleading.
    let chain: Option<Vec<&TsNode>> = if reasons.iter().any(|r| {
        r.feature == "edge_dangling"
            || r.feature == "duplicate_node_id"
            || r.feature == "empty_graph"
    }) {
        None
    } else {
        check_linear_topology(&nodes, &edges, &mut reasons)
    };

    if !reasons.is_empty() {
        return TsTranslation::Unsupported {
            reasons,
            preserved_source_meta: meta,
        };
    }
    let chain = chain.expect("no reasons implies a resolved chain");

    // --- build the linear definition (chain order) --------------------------------
    let mut steps: Vec<StoredWorkflowStepV1> = Vec::with_capacity(chain.len());
    for (pos, node) in chain.iter().enumerate() {
        match node.node_type {
            Ok("trigger") => {
                if pos == 0 {
                    // A single LEADING manual trigger is the entry marker, not an
                    // executable step: elide it EXPLICITLY (recorded in metadata).
                    meta.manual_trigger_elided = true;
                } else {
                    return TsTranslation::Unsupported {
                        reasons: vec![UnsupportedFeature {
                            feature: "trigger_not_entry",
                            node_or_edge: Some(node.id.clone()),
                            reason: format!(
                                "trigger node '{}' is mid-chain (position {pos}); a trigger is \
                                 only translatable as the single leading entry",
                                node.id
                            ),
                        }],
                        preserved_source_meta: meta,
                    };
                }
            }
            Ok("action") => {
                // scan_action already validated; build_step cannot fail now.
                steps.push(build_step(node));
            }
            // unreachable: every other type already produced an Unsupported reason.
            _ => unreachable!("non-linear node type survived the feature scan"),
        }
    }
    if steps.is_empty() {
        return TsTranslation::Unsupported {
            reasons: vec![UnsupportedFeature {
                feature: "no_executable_steps",
                node_or_edge: None,
                reason: "the source contains no action steps after eliding the manual trigger"
                    .into(),
            }],
            preserved_source_meta: meta,
        };
    }

    TsTranslation::Linear {
        definition: StoredWorkflowDefV1 {
            schema_version: WORKFLOW_DEF_SCHEMA_VERSION,
            name: name.to_string(),
            steps,
        },
        source_meta: meta,
    }
}

/// Trigger scan: only a MANUAL trigger is translatable (schedule/event = S10).
fn scan_trigger(node: &TsNode, reasons: &mut Vec<UnsupportedFeature>) {
    for key in NON_MANUAL_TRIGGER_KEYS {
        if node.config.contains_key(*key) {
            reasons.push(UnsupportedFeature {
                feature: "trigger_not_manual",
                node_or_edge: Some(node.id.clone()),
                reason: format!(
                    "trigger node '{}' config has '{key}': schedule/event triggers are S10 \
                     scheduler scope (operator-gated, unbuilt); only a manual trigger is \
                     translatable",
                    node.id
                ),
            });
            return;
        }
    }
    let declared =
        as_str(node.config.get("type")).or_else(|| as_str(node.config.get("triggerType")));
    if let Some(kind) = declared {
        if kind != "manual" {
            reasons.push(UnsupportedFeature {
                feature: "trigger_not_manual",
                node_or_edge: Some(node.id.clone()),
                reason: format!(
                    "trigger node '{}' declares type '{kind}'; only 'manual' is translatable \
                     (schedule/event = S10, operator-gated)",
                    node.id
                ),
            });
        }
    }
}

/// Action scan: callee must canonicalize to a Rust registry action; args must
/// be literal scalars with no expression markers / unsafe keys / exec-only knobs.
fn scan_action(node: &TsNode, reasons: &mut Vec<UnsupportedFeature>) {
    // callee: config.skillId ?? config.ref (faithful to the TS action adapter).
    let Some(callee) =
        as_str(node.config.get("skillId")).or_else(|| as_str(node.config.get("ref")))
    else {
        reasons.push(UnsupportedFeature {
            feature: "action_missing_ref",
            node_or_edge: Some(node.id.clone()),
            reason: format!(
                "action node '{}' has no skillId/ref in config (the TS adapter would reject it \
                 too)",
                node.id
            ),
        });
        return;
    };
    let Some(rust_action) = canonical_rust_name(&callee) else {
        reasons.push(UnsupportedFeature {
            feature: "action_no_rust_executor",
            node_or_edge: Some(node.id.clone()),
            reason: format!(
                "action node '{}' calls '{callee}', which has no Rust ToolRegistry executor \
                 (tool_name_map fail-closed); storing it would misrepresent a TS-only \
                 skill/tool as runnable",
                node.id
            ),
        });
        return;
    };

    match node.config.get("args") {
        None => {}
        Some(Value::Object(args)) => {
            for (key, value) in args {
                if UNSAFE_ARG_KEYS.contains(&key.as_str()) {
                    reasons.push(UnsupportedFeature {
                        feature: "unsafe_param_key",
                        node_or_edge: Some(node.id.clone()),
                        reason: format!(
                            "action node '{}' arg key '{key}' is an unsafe prototype key (the TS \
                             resolver drops it silently; this translator fails closed)",
                            node.id
                        ),
                    });
                    continue;
                }
                if rust_action == "run_command" && EXEC_ONLY_KEYS.contains(&key.as_str()) {
                    reasons.push(UnsupportedFeature {
                        feature: "exec_param_no_rust_surface",
                        node_or_edge: Some(node.id.clone()),
                        reason: format!(
                            "action node '{}' exec arg '{key}' has no Rust run_command surface \
                             (PARAM_SCHEMA_DIFFS); dropping it would change semantics",
                            node.id
                        ),
                    });
                    continue;
                }
                match value {
                    Value::String(s) if s.starts_with('$') => {
                        reasons.push(UnsupportedFeature {
                            feature: "expression_param",
                            node_or_edge: Some(node.id.clone()),
                            reason: format!(
                                "action node '{}' arg '{key}' is a TS runtime expression \
                                 (starts with '$'); the Rust engine has no expression evaluator, \
                                 so passing it literally would silently change semantics",
                                node.id
                            ),
                        });
                    }
                    Value::String(_) | Value::Number(_) | Value::Bool(_) => {}
                    _ => reasons.push(UnsupportedFeature {
                        feature: "non_scalar_param",
                        node_or_edge: Some(node.id.clone()),
                        reason: format!(
                            "action node '{}' arg '{key}' is not a literal scalar \
                             (null/array/object args have no Rust tool-param mapping)",
                            node.id
                        ),
                    }),
                }
            }
        }
        Some(_) => reasons.push(UnsupportedFeature {
            feature: "action_args_not_object",
            node_or_edge: Some(node.id.clone()),
            reason: format!("action node '{}' has a non-object args value", node.id),
        }),
    }
}

/// Build the translated step for a SCANNED-CLEAN action node.
fn build_step(node: &TsNode) -> StoredWorkflowStepV1 {
    let callee = as_str(node.config.get("skillId"))
        .or_else(|| as_str(node.config.get("ref")))
        .expect("scan_action verified the callee");
    let rust_action = canonical_rust_name(&callee).expect("scan_action verified the mapping");
    let mut params: Vec<(String, String)> = Vec::new();
    if let Some(Value::Object(args)) = node.config.get("args") {
        for (key, value) in args {
            // Recorded param-schema diff for `edit` → `edit_file`: TS camelCase →
            // Rust snake_case (tool_name_map::PARAM_SCHEMA_DIFFS).
            let mapped_key = if rust_action == "edit_file" {
                match key.as_str() {
                    "oldText" => "old_text".to_string(),
                    "newText" => "new_text".to_string(),
                    other => other.to_string(),
                }
            } else {
                key.clone()
            };
            let rendered = match value {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => unreachable!("scan_action rejected non-scalar args"),
            };
            params.push((mapped_key, rendered));
        }
    }
    StoredWorkflowStepV1 {
        id: node.id.clone(),
        action: rust_action.to_string(),
        params,
        // The planner floors (mutating/high-risk/sensitive/unclassifiable) decide
        // checkpoints at run time; the translation adds no narrowing of its own.
        force_checkpoint: false,
        evidence_required: false,
    }
}

/// Verify the graph is ONE linear chain covering every node, and return it in
/// execution order. Reports `dag_fan_out` / `dag_fan_in` / `parallel_entries` /
/// `cycle` / `disconnected_parallel` — each an explicit blocker, never flattened.
fn check_linear_topology<'a>(
    nodes: &'a [TsNode],
    edges: &[TsEdge],
    reasons: &mut Vec<UnsupportedFeature>,
) -> Option<Vec<&'a TsNode>> {
    use std::collections::HashMap;
    let mut out: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut indeg: HashMap<&str, usize> = HashMap::new();
    for n in nodes {
        out.entry(n.id.as_str()).or_default();
        indeg.entry(n.id.as_str()).or_insert(0);
    }
    for e in edges {
        let (Some(s), Some(t)) = (e.source.as_deref(), e.target.as_deref()) else {
            continue; // already reported as edge_dangling
        };
        out.entry(s).or_default().push(t);
        *indeg.entry(t).or_insert(0) += 1;
    }

    let before = reasons.len();
    for n in nodes {
        let fan_out = out.get(n.id.as_str()).map_or(0, Vec::len);
        if fan_out > 1 {
            reasons.push(UnsupportedFeature {
                feature: "dag_fan_out",
                node_or_edge: Some(n.id.clone()),
                reason: format!(
                    "node '{}' has {fan_out} outbound edges: DAG fan-out is branching/parallel \
                     topology (LINEAR-ONLY v1); fail-closed, never flattened",
                    n.id
                ),
            });
        }
        let fan_in = *indeg.get(n.id.as_str()).unwrap_or(&0);
        if fan_in > 1 {
            reasons.push(UnsupportedFeature {
                feature: "dag_fan_in",
                node_or_edge: Some(n.id.clone()),
                reason: format!(
                    "node '{}' has {fan_in} inbound edges: DAG fan-in (join) is not part of the \
                     linear subset",
                    n.id
                ),
            });
        }
    }
    let entries: Vec<&TsNode> = nodes
        .iter()
        .filter(|n| *indeg.get(n.id.as_str()).unwrap_or(&0) == 0)
        .collect();
    match entries.len() {
        0 if !nodes.is_empty() => reasons.push(UnsupportedFeature {
            feature: "cycle",
            node_or_edge: None,
            reason: "the graph has no entry node (every node has an inbound edge) — a cycle".into(),
        }),
        n if n > 1 => reasons.push(UnsupportedFeature {
            feature: "parallel_entries",
            node_or_edge: Some(
                entries
                    .iter()
                    .map(|e| e.id.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
            ),
            reason: format!(
                "{n} entry nodes: multiple roots are parallel/disconnected topology \
                 (LINEAR-ONLY v1); fail-closed, never flattened"
            ),
        }),
        _ => {}
    }
    if reasons.len() > before {
        return None;
    }

    // Walk the single chain from the single entry.
    let by_id: HashMap<&str, &TsNode> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut chain: Vec<&TsNode> = Vec::with_capacity(nodes.len());
    let mut visited: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut cursor = entries.first().map(|n| n.id.as_str());
    while let Some(id) = cursor {
        if !visited.insert(id) {
            reasons.push(UnsupportedFeature {
                feature: "cycle",
                node_or_edge: Some(id.to_string()),
                reason: format!("the chain revisits node '{id}' — a cycle"),
            });
            return None;
        }
        chain.push(by_id[id]);
        cursor = out.get(id).and_then(|next| next.first().copied());
    }
    if chain.len() != nodes.len() {
        let unreached: Vec<&str> = nodes
            .iter()
            .map(|n| n.id.as_str())
            .filter(|id| !visited.contains(id))
            .collect();
        reasons.push(UnsupportedFeature {
            feature: "disconnected_parallel",
            node_or_edge: Some(unreached.join(",")),
            reason: format!(
                "{} node(s) are not on the entry chain (disconnected/parallel islands): {}",
                unreached.len(),
                unreached.join(", ")
            ),
        });
        return None;
    }
    Some(chain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn features(t: &TsTranslation) -> Vec<&'static str> {
        match t {
            TsTranslation::Unsupported { reasons, .. } => {
                reasons.iter().map(|r| r.feature).collect()
            }
            TsTranslation::Linear { .. } => vec![],
        }
    }

    fn meta(t: &TsTranslation) -> &TsSourceMeta {
        match t {
            TsTranslation::Unsupported {
                preserved_source_meta,
                ..
            } => preserved_source_meta,
            TsTranslation::Linear { source_meta, .. } => source_meta,
        }
    }

    /// A compiled-v2 wrapper around nodes/edges, mirroring
    /// `FridayCompiledWorkflowGraphV2`.
    fn compiled_v2(nodes: Value, edges: Value) -> Value {
        json!({
            "schemaVersion": "2.0",
            "workflowId": "wf-ts-1",
            "workflowVersionId": "wfv-ts-1",
            "sourceSpecSchemaVersion": "1.0",
            "graph": { "nodes": nodes, "edges": edges },
            "failurePolicy": { "onFailure": "fail_fast", "notifyUser": false },
            "tests": [],
            "checksum": "abc123"
        })
    }

    fn action(id: &str, callee: &str, args: Value) -> Value {
        json!({ "id": id, "type": "tool_call", "config": { "ref": callee, "args": args } })
    }

    fn edge(from: &str, to: &str) -> Value {
        json!({ "id": format!("{from}->{to}"), "sourceNodeId": from, "targetNodeId": to })
    }

    // --- the four prompt-mandated fail-closed panels ---------------------------

    #[test]
    fn dag_fan_out_input_fails_closed_with_honest_reasons() {
        // a → b, a → c : fan-out (DAG). Must be Unsupported, never flattened.
        let g = compiled_v2(
            json!([
                action("a", "read", json!({"path": "x"})),
                action("b", "read", json!({"path": "y"})),
                action("c", "read", json!({"path": "z"})),
            ]),
            json!([edge("a", "b"), edge("a", "c")]),
        );
        let t = translate_ts_published_version(&g, "dag");
        let f = features(&t);
        assert!(f.contains(&"dag_fan_out"), "features: {f:?}");
        // honest reason names the offending node.
        match &t {
            TsTranslation::Unsupported { reasons, .. } => {
                let r = reasons.iter().find(|r| r.feature == "dag_fan_out").unwrap();
                assert_eq!(r.node_or_edge.as_deref(), Some("a"));
                assert!(r.reason.contains("LINEAR-ONLY"), "reason: {}", r.reason);
            }
            _ => panic!("must be Unsupported"),
        }
        // preserved source meta survives (refs-only counts + ids).
        let m = meta(&t);
        assert_eq!(m.node_count, 3);
        assert_eq!(m.edge_count, 2);
        assert_eq!(m.workflow_id.as_deref(), Some("wf-ts-1"));
    }

    #[test]
    fn branch_input_condition_node_and_conditional_edges_fail_closed() {
        // a → cond, cond --true--> b, cond --false--> c : a branch.
        let g = compiled_v2(
            json!([
                action("a", "read", json!({"path": "x"})),
                { "id": "cond", "type": "condition", "config": { "expression": "$a.ok == true" } },
                action("b", "read", json!({"path": "y"})),
                action("c", "read", json!({"path": "z"})),
            ]),
            json!([
                edge("a", "cond"),
                { "id": "e-t", "sourceNodeId": "cond", "targetNodeId": "b", "condition": "true" },
                { "id": "e-f", "sourceNodeId": "cond", "targetNodeId": "c", "condition": "false" },
            ]),
        );
        let t = translate_ts_published_version(&g, "branch");
        let f = features(&t);
        assert!(f.contains(&"branch_condition_node"), "features: {f:?}");
        assert!(f.contains(&"conditional_edge"), "features: {f:?}");
        // ALL blockers are reported, not just the first.
        assert!(f.len() >= 3, "full honest gap list: {f:?}");
    }

    #[test]
    fn parallel_input_two_disconnected_chains_fails_closed() {
        let g = compiled_v2(
            json!([
                action("a", "read", json!({"path": "x"})),
                action("b", "read", json!({"path": "y"})),
                action("p", "read", json!({"path": "z"})),
                action("q", "read", json!({"path": "w"})),
            ]),
            json!([edge("a", "b"), edge("p", "q")]),
        );
        let t = translate_ts_published_version(&g, "parallel");
        let f = features(&t);
        assert!(f.contains(&"parallel_entries"), "features: {f:?}");
        match &t {
            TsTranslation::Unsupported { reasons, .. } => {
                let r = reasons
                    .iter()
                    .find(|r| r.feature == "parallel_entries")
                    .unwrap();
                assert!(r.reason.contains("never flattened"), "reason: {}", r.reason);
            }
            _ => panic!("must be Unsupported"),
        }
    }

    #[test]
    fn unsupported_transform_input_fails_closed() {
        // a transform (data) node mid-chain — TS aliases `transform` → `data`.
        let g = compiled_v2(
            json!([
                action("a", "read", json!({"path": "x"})),
                { "id": "t1", "type": "transform", "config": { "expression": "$a.content" } },
            ]),
            json!([edge("a", "t1")]),
        );
        let t = translate_ts_published_version(&g, "transform");
        let f = features(&t);
        assert!(f.contains(&"transform_node"), "features: {f:?}");
        match &t {
            TsTranslation::Unsupported { reasons, .. } => {
                let r = reasons
                    .iter()
                    .find(|r| r.feature == "transform_node")
                    .unwrap();
                assert_eq!(r.node_or_edge.as_deref(), Some("t1"));
                assert!(
                    r.reason.contains("no transform/expression evaluator"),
                    "reason: {}",
                    r.reason
                );
            }
            _ => panic!("must be Unsupported"),
        }
    }

    // --- the prompt-mandated round-trip panel -----------------------------------

    #[test]
    fn pure_linear_input_round_trips_correctly() {
        // manual trigger → read → write, with TS alias names + scalar args.
        let g = compiled_v2(
            json!([
                { "id": "start", "type": "trigger", "config": { "type": "manual" } },
                action("read-notes", "read", json!({"path": "notes.txt"})),
                action("write-out", "write", json!({"path": "out.txt", "content": "hello"})),
            ]),
            json!([edge("start", "read-notes"), edge("read-notes", "write-out")]),
        );
        let t = translate_ts_published_version(&g, "ship-notes");
        let TsTranslation::Linear {
            definition,
            source_meta,
        } = t
        else {
            panic!("pure-linear source must translate: {t:?}");
        };
        // TS aliases map to canonical Rust actions through tool_name_map.
        assert_eq!(definition.name, "ship-notes");
        assert_eq!(definition.steps.len(), 2);
        assert_eq!(definition.steps[0].id, "read-notes");
        assert_eq!(definition.steps[0].action, "read_file");
        assert_eq!(
            definition.steps[0].params,
            vec![("path".to_string(), "notes.txt".to_string())]
        );
        assert_eq!(definition.steps[1].action, "write_file");
        // the leading manual trigger is EXPLICITLY recorded as elided.
        assert!(source_meta.manual_trigger_elided);
        assert_eq!(source_meta.node_count, 3);
        assert_eq!(source_meta.source_schema_version.as_deref(), Some("2.0"));

        // ROUND TRIP through the stored serde format and into the executable form.
        let json = crate::workflow_def::definition_to_json(&definition).unwrap();
        let back = crate::workflow_def::parse_definition_json(&json).unwrap();
        assert_eq!(back, definition);
        let exec = back.to_executable();
        assert_eq!(exec.steps.len(), 2);
        assert_eq!(exec.steps[0].action, "read_file");
        // run-time honesty is preserved: the mutating write still checkpoints.
        assert!(exec.requires_any_checkpoint());
    }

    #[test]
    fn raw_top_level_nodes_without_graph_wrapper_also_translate() {
        // parseGraphJson accepts raw graphs with top-level nodes/edges; mirror it.
        let g = json!({
            "nodes": [ action("only", "read", json!({"path": "a.txt"})) ],
            "edges": []
        });
        let t = translate_ts_published_version(&g, "raw");
        let TsTranslation::Linear {
            definition,
            source_meta,
        } = t
        else {
            panic!("raw linear graph must translate: {t:?}");
        };
        assert_eq!(definition.steps.len(), 1);
        assert!(!source_meta.manual_trigger_elided);
    }

    // --- per-feature fail-closed panels -------------------------------------------

    #[test]
    fn schedule_trigger_fails_closed_scheduler_is_s10() {
        let g = compiled_v2(
            json!([
                { "id": "cron", "type": "trigger", "config": { "cron": "0 9 * * *", "timezone": "UTC" } },
                action("a", "read", json!({"path": "x"})),
            ]),
            json!([edge("cron", "a")]),
        );
        let f = features(&translate_ts_published_version(&g, "scheduled"));
        assert!(f.contains(&"trigger_not_manual"), "features: {f:?}");

        // declared non-manual type fails closed too.
        let g = compiled_v2(
            json!([
                { "id": "ev", "type": "trigger", "config": { "type": "event" } },
                action("a", "read", json!({"path": "x"})),
            ]),
            json!([edge("ev", "a")]),
        );
        let f = features(&translate_ts_published_version(&g, "evented"));
        assert!(f.contains(&"trigger_not_manual"), "features: {f:?}");
    }

    #[test]
    fn ai_and_approval_nodes_fail_closed() {
        let g = compiled_v2(
            json!([
                action("a", "read", json!({"path": "x"})),
                { "id": "brain", "type": "ai", "config": { "prompt": "summarize" } },
                { "id": "ok", "type": "human_approval", "config": {} },
            ]),
            json!([edge("a", "brain"), edge("brain", "ok")]),
        );
        let f = features(&translate_ts_published_version(&g, "rich"));
        assert!(f.contains(&"ai_node"), "features: {f:?}");
        assert!(f.contains(&"approval_node"), "features: {f:?}");
    }

    #[test]
    fn expression_args_fail_closed_never_passed_literally() {
        // `$steps.read.output` is a TS runtime expression (resolveValue evaluates
        // strings starting with '$'); Rust has no evaluator, so it must BLOCK.
        let g = compiled_v2(
            json!([
                action("a", "read", json!({"path": "x"})),
                action("b", "write", json!({"path": "y", "content": "$a.output"})),
            ]),
            json!([edge("a", "b")]),
        );
        let f = features(&translate_ts_published_version(&g, "expr"));
        assert!(f.contains(&"expression_param"), "features: {f:?}");
    }

    #[test]
    fn non_scalar_and_unsafe_args_fail_closed() {
        let g = compiled_v2(
            json!([action("a", "read", json!({"path": {"nested": "object"}})),]),
            json!([]),
        );
        let f = features(&translate_ts_published_version(&g, "nonscalar"));
        assert!(f.contains(&"non_scalar_param"), "features: {f:?}");

        let g = compiled_v2(
            json!([action("a", "read", json!({"__proto__": "x", "path": "ok"}))]),
            json!([]),
        );
        let f = features(&translate_ts_published_version(&g, "unsafe"));
        assert!(f.contains(&"unsafe_param_key"), "features: {f:?}");
    }

    #[test]
    fn ts_only_skill_call_fails_closed_no_rust_executor() {
        // `web_search` is on TS_ONLY_UNMAPPED — no Rust executor; storing it as a
        // runnable step would be a misrepresentation.
        let g = compiled_v2(
            json!([ { "id": "s", "type": "skill_call", "config": { "skillId": "web_search",
                       "args": { "query": "rust" } } } ]),
            json!([]),
        );
        let t = translate_ts_published_version(&g, "skill");
        let f = features(&t);
        assert!(f.contains(&"action_no_rust_executor"), "features: {f:?}");
        match &t {
            TsTranslation::Unsupported { reasons, .. } => {
                let r = reasons
                    .iter()
                    .find(|r| r.feature == "action_no_rust_executor")
                    .unwrap();
                assert!(r.reason.contains("web_search"), "reason: {}", r.reason);
            }
            _ => panic!("must be Unsupported"),
        }
    }

    #[test]
    fn edit_args_are_renamed_per_recorded_param_schema_diff() {
        let g = compiled_v2(
            json!([action(
                "e",
                "edit",
                json!({"path": "f.txt", "oldText": "a", "newText": "b"})
            )]),
            json!([]),
        );
        let TsTranslation::Linear { definition, .. } = translate_ts_published_version(&g, "edit")
        else {
            panic!("linear edit must translate");
        };
        assert_eq!(definition.steps[0].action, "edit_file");
        let keys: Vec<&str> = definition.steps[0]
            .params
            .iter()
            .map(|(k, _)| k.as_str())
            .collect();
        assert!(keys.contains(&"old_text") && keys.contains(&"new_text"));
        assert!(!keys.contains(&"oldText") && !keys.contains(&"newText"));
    }

    #[test]
    fn exec_only_knobs_fail_closed() {
        let g = compiled_v2(
            json!([action(
                "x",
                "exec",
                json!({"command": "ls", "workdir": "/tmp"})
            )]),
            json!([]),
        );
        let f = features(&translate_ts_published_version(&g, "exec"));
        assert!(f.contains(&"exec_param_no_rust_surface"), "features: {f:?}");

        // plain command-only exec IS linear-translatable (and still gate-governed
        // at run time: run_command is mutating → checkpoint).
        let g = compiled_v2(
            json!([action("x", "exec", json!({"command": "ls"}))]),
            json!([]),
        );
        let TsTranslation::Linear { definition, .. } =
            translate_ts_published_version(&g, "exec-ok")
        else {
            panic!("command-only exec must translate");
        };
        assert_eq!(definition.steps[0].action, "run_command");
        assert!(definition.to_executable().requires_any_checkpoint());
    }

    #[test]
    fn retry_timeout_failure_policy_and_variables_fail_closed() {
        let g = json!({
            "schemaVersion": "2.0",
            "graph": {
                "nodes": [
                    { "id": "a", "type": "action",
                      "config": { "ref": "read", "args": { "path": "x" } },
                      "retryPolicy": { "maxAttempts": 3, "backoff": "exponential",
                                       "baseDelayMs": 100, "maxDelayMs": 1000, "retryOn": [] },
                      "timeoutMs": 5000 }
                ],
                "edges": [],
                "variables": { "env": "prod" }
            },
            "failurePolicy": { "onFailure": "continue_on_error", "notifyUser": true },
            "tests": [], "checksum": ""
        });
        let f = features(&translate_ts_published_version(&g, "knobs"));
        assert!(f.contains(&"step_retry_policy"), "features: {f:?}");
        assert!(f.contains(&"step_timeout"), "features: {f:?}");
        assert!(f.contains(&"failure_policy"), "features: {f:?}");
        assert!(f.contains(&"graph_variables"), "features: {f:?}");

        // single-attempt retry policy is NOT a blocker (semantics identical).
        let g = compiled_v2(
            json!([ { "id": "a", "type": "action",
                      "config": { "ref": "read", "args": { "path": "x" } },
                      "retryPolicy": { "maxAttempts": 1, "backoff": "none",
                                       "baseDelayMs": 0, "maxDelayMs": 0, "retryOn": [] } } ]),
            json!([]),
        );
        assert!(matches!(
            translate_ts_published_version(&g, "one-attempt"),
            TsTranslation::Linear { .. }
        ));
    }

    #[test]
    fn cycle_and_unknown_node_type_fail_closed() {
        let g = compiled_v2(
            json!([
                action("a", "read", json!({"path": "x"})),
                action("b", "read", json!({"path": "y"})),
            ]),
            json!([edge("a", "b"), edge("b", "a")]),
        );
        let f = features(&translate_ts_published_version(&g, "cycle"));
        assert!(
            f.contains(&"cycle") || f.contains(&"dag_fan_in"),
            "features: {f:?}"
        );

        // unknown type is NOT defaulted to action (deliberate divergence from TS).
        let g = compiled_v2(
            json!([ { "id": "w", "type": "webhook_wait", "config": {} } ]),
            json!([]),
        );
        let f = features(&translate_ts_published_version(&g, "unknown"));
        assert!(f.contains(&"unknown_node_type"), "features: {f:?}");
    }

    #[test]
    fn never_partial_one_good_action_plus_one_blocked_node_translates_nothing() {
        let g = compiled_v2(
            json!([
                action("good", "read", json!({"path": "x"})),
                { "id": "bad", "type": "ai", "config": { "prompt": "p" } },
            ]),
            json!([edge("good", "bad")]),
        );
        let t = translate_ts_published_version(&g, "partial");
        assert!(
            matches!(t, TsTranslation::Unsupported { .. }),
            "a partially-supported graph must translate NOTHING (never silent dropping)"
        );
    }

    #[test]
    fn unparseable_and_empty_graphs_fail_closed() {
        let f = features(&translate_ts_published_version(
            &json!("not an object"),
            "x",
        ));
        assert!(f.contains(&"unparseable_graph"), "features: {f:?}");

        let f = features(&translate_ts_published_version(
            &json!({"no_nodes": true}),
            "x",
        ));
        assert!(f.contains(&"unparseable_graph"), "features: {f:?}");

        let g = compiled_v2(json!([]), json!([]));
        let f = features(&translate_ts_published_version(&g, "empty"));
        assert!(f.contains(&"empty_graph"), "features: {f:?}");

        // a trigger-only graph has no executable steps.
        let g = compiled_v2(
            json!([ { "id": "start", "type": "trigger", "config": {} } ]),
            json!([]),
        );
        let f = features(&translate_ts_published_version(&g, "trigger-only"));
        assert!(f.contains(&"no_executable_steps"), "features: {f:?}");
    }

    #[test]
    fn source_meta_is_refs_only_and_serializable() {
        let g = compiled_v2(
            json!([
                { "id": "start", "type": "trigger", "config": { "type": "manual" } },
                action("a", "read", json!({"path": "SUPER-SECRET-PATH.txt"})),
            ]),
            json!([edge("start", "a")]),
        );
        let TsTranslation::Linear { source_meta, .. } = translate_ts_published_version(&g, "meta")
        else {
            panic!("must translate");
        };
        let rendered = serde_json::to_string(&source_meta).unwrap();
        // counts + ids + labels only — never node configs/args.
        assert!(rendered.contains("\"node_count\":2"));
        assert!(rendered.contains("\"trigger\":1"));
        assert!(rendered.contains("\"action\":1"));
        assert!(
            !rendered.contains("SUPER-SECRET-PATH"),
            "source_meta must never carry arg values: {rendered}"
        );
    }
}
