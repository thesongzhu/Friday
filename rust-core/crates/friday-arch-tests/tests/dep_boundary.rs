//! Architecture invariant (gate 21 §1/§3): the phone FFI crate (`friday-ffi`)
//! must NOT depend — directly or transitively — on the provider-secret-bearing
//! `friday-deepseek` crate. This is what makes "no provider secret on phone" a
//! compile-time property.
//!
//! This is a fast source-level guard over the workspace manifests. The
//! authoritative runtime evidence is `cargo tree -p friday-ffi` (captured in
//! the evidence ledger), which shows the resolved dependency graph.
//!
//! Scope label: this asserts the *dependency boundary* is correct. It is NOT a
//! claim that the DeepSeek route itself is implemented (that is Unit 3).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <root>/crates/friday-arch-tests
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap() // crates
        .parent()
        .unwrap() // rust-core (workspace root)
        .to_path_buf()
}

/// crate name -> set of internal (`friday-*`) deps it declares (normal + build
/// deps; dev-deps are excluded because they do not ship in the artifact).
fn internal_dep_graph(root: &Path) -> BTreeMap<String, BTreeSet<String>> {
    let crates_dir = root.join("crates");
    let mut graph = BTreeMap::new();
    for entry in std::fs::read_dir(&crates_dir).unwrap() {
        let manifest = entry.unwrap().path().join("Cargo.toml");
        if !manifest.exists() {
            continue;
        }
        let text = std::fs::read_to_string(&manifest).unwrap();
        let value: toml::Value = toml::from_str(&text).unwrap();
        let name = value["package"]["name"].as_str().unwrap().to_string();
        let mut deps = BTreeSet::new();
        // Collect friday-* deps from a dependency table, resolving the REAL crate
        // name via the `package` field so a renamed dep
        // (`x = { package = "friday-deepseek" }`) cannot evade the boundary check.
        let mut scan = |tbl: &toml::value::Table| {
            for (k, v) in tbl {
                let dep_name = v
                    .as_table()
                    .and_then(|t| t.get("package"))
                    .and_then(|p| p.as_str())
                    .unwrap_or(k.as_str());
                if dep_name.starts_with("friday-") {
                    deps.insert(dep_name.to_string());
                }
            }
        };
        for section in ["dependencies", "build-dependencies"] {
            if let Some(tbl) = value.get(section).and_then(|v| v.as_table()) {
                scan(tbl);
            }
        }
        // Also scan platform-specific [target.'cfg(...)'.dependencies] tables — a
        // secret-bearing dep hidden behind a target cfg would otherwise be missed.
        if let Some(targets) = value.get("target").and_then(|v| v.as_table()) {
            for (_cfg, t) in targets {
                for section in ["dependencies", "build-dependencies"] {
                    if let Some(tbl) = t.get(section).and_then(|v| v.as_table()) {
                        scan(tbl);
                    }
                }
            }
        }
        graph.insert(name, deps);
    }
    graph
}

/// Transitive set of internal crates reachable from `start` (excluding `start`).
fn closure(graph: &BTreeMap<String, BTreeSet<String>>, start: &str) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut stack = vec![start.to_string()];
    while let Some(c) = stack.pop() {
        if let Some(deps) = graph.get(&c) {
            for d in deps {
                if seen.insert(d.clone()) {
                    stack.push(d.clone());
                }
            }
        }
    }
    seen
}

#[test]
fn ffi_dependency_closure_excludes_deepseek() {
    let graph = internal_dep_graph(&workspace_root());
    assert!(
        graph.contains_key("friday-ffi"),
        "friday-ffi crate not found"
    );
    assert!(
        graph.contains_key("friday-deepseek"),
        "friday-deepseek crate not found"
    );

    let ffi_closure = closure(&graph, "friday-ffi");

    // Hub-only, provider-secret-bearing crates must never reach the phone.
    // friday-anthropic (S7, the Claude/Anthropic route) is secret-bearing exactly like
    // friday-deepseek and must stay out of the phone FFI graph too.
    for hub_only in ["friday-deepseek", "friday-anthropic", "friday-providers"] {
        assert!(graph.contains_key(hub_only), "{hub_only} crate not found");
        assert!(
            !ffi_closure.contains(hub_only),
            "PHONE SECRET LEAK: friday-ffi transitively depends on {hub_only}; closure = {ffi_closure:?}"
        );
    }

    // friday-fs is Hub-only for a *filesystem-privilege* reason (distinct from
    // the provider-secret reason above): it is the agent-loop ToolExecutor's
    // real file read/write/edit surface (the hardened workspace-root-contained
    // safe-open). The phone must never get this open primitive, so friday-fs
    // must not be in the ffi dependency closure.
    assert!(graph.contains_key("friday-fs"), "friday-fs crate not found");
    assert!(
        !ffi_closure.contains("friday-fs"),
        "PHONE FS-PRIVILEGE LEAK: friday-ffi transitively depends on friday-fs; closure = {ffi_closure:?}"
    );

    // friday-hub is the Hub composition root: it links the provider-secret crates
    // AND Hub-only logic (the agent loop, memory-recall cognition + its `regex`
    // dep). The phone never recalls and must never link the Hub — keeping
    // friday-hub out of the ffi closure also keeps `regex` off the phone.
    assert!(
        graph.contains_key("friday-hub"),
        "friday-hub crate not found"
    );
    assert!(
        !ffi_closure.contains("friday-hub"),
        "PHONE HUB LEAK: friday-ffi transitively depends on friday-hub (composition root + secret/recall logic); closure = {ffi_closure:?}"
    );

    // Sanity: the phone crate does link the phone-side crates it actually uses.
    for expected in ["friday-core", "friday-storage", "friday-crypto"] {
        assert!(
            ffi_closure.contains(expected),
            "friday-ffi closure unexpectedly missing {expected}: {ffi_closure:?}"
        );
    }
}

#[test]
fn deepseek_does_not_depend_on_ffi_either() {
    // The secret-bearing crate must not pull in the phone surface.
    let graph = internal_dep_graph(&workspace_root());
    let ds_closure = closure(&graph, "friday-deepseek");
    assert!(
        !ds_closure.contains("friday-ffi"),
        "friday-deepseek must not depend on friday-ffi; closure = {ds_closure:?}"
    );
}

#[test]
fn hub_is_the_secret_bearing_composition_root_and_phone_is_not() {
    // PR-6 boundary (file 52 §3 must-nail #1): the Hub runtime is where provider
    // secrets live, so `friday-hub`'s closure INCLUDES the secret-bearing crates;
    // `friday-ffi` (phone) must still EXCLUDE them. This is the compile-time
    // "secrets on the Hub, never on the phone" property for the new crate.
    let graph = internal_dep_graph(&workspace_root());
    assert!(
        graph.contains_key("friday-hub"),
        "friday-hub crate not found"
    );

    let hub_closure = closure(&graph, "friday-hub");
    for secret in ["friday-deepseek", "friday-anthropic", "friday-providers"] {
        assert!(
            hub_closure.contains(secret),
            "friday-hub closure must include the secret-bearing {secret}: {hub_closure:?}"
        );
    }
    // The Hub composes the substrate it drives.
    for expected in ["friday-core", "friday-crypto", "friday-storage"] {
        assert!(
            hub_closure.contains(expected),
            "friday-hub closure unexpectedly missing {expected}: {hub_closure:?}"
        );
    }
    // And the phone STILL cannot reach the secret crates (re-asserted with hub present).
    let ffi_closure = closure(&graph, "friday-ffi");
    for secret in [
        "friday-deepseek",
        "friday-anthropic",
        "friday-providers",
        "friday-hub",
    ] {
        assert!(
            !ffi_closure.contains(secret),
            "PHONE SECRET LEAK: friday-ffi depends on {secret}; closure = {ffi_closure:?}"
        );
    }
}

#[test]
fn anthropic_does_not_depend_on_ffi_either() {
    // S7: the secret-bearing Claude crate must not pull in the phone surface
    // (mirrors `deepseek_does_not_depend_on_ffi_either`).
    let graph = internal_dep_graph(&workspace_root());
    let an_closure = closure(&graph, "friday-anthropic");
    assert!(
        !an_closure.contains("friday-ffi"),
        "friday-anthropic must not depend on friday-ffi; closure = {an_closure:?}"
    );
}
