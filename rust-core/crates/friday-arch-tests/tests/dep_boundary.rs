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
        for section in ["dependencies", "build-dependencies"] {
            if let Some(tbl) = value.get(section).and_then(|v| v.as_table()) {
                for k in tbl.keys() {
                    if k.starts_with("friday-") {
                        deps.insert(k.clone());
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

    assert!(
        !ffi_closure.contains("friday-deepseek"),
        "PHONE SECRET LEAK: friday-ffi transitively depends on friday-deepseek; closure = {ffi_closure:?}"
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
