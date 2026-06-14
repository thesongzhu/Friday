//! element_cache — the snapshot-derived element-id cache.
//!
//! A `snapshot` assigns a stable `element_id` to each addressable node (see
//! [`crate::dom_lite::DomNode`]). A later `act` can target an element by that id instead of
//! a fresh CSS selector — but only ids from a PRIOR snapshot are valid. This cache is the
//! lookup table: a snapshot populates it (per session/tab scope), an `act:click
//! elementId=…` resolves through it to the node's selector (or fails closed if the id was
//! never snapshotted / is stale).
//!
//! Pure in-memory map — no I/O. Scoped by a `scope` key (the handler passes
//! `sessionId:tabId` so two tabs don't collide).

use std::collections::HashMap;

use crate::dom_lite::DomNode;

/// A snapshot-derived element-id → node cache, keyed by a scope string (typically the
/// resolved `sessionId:tabId`). Populating a scope REPLACES its prior contents (a fresh
/// snapshot invalidates stale ids for that scope — matching the oracle, where a new
/// snapshot supersedes the previous element handles).
#[derive(Clone, Debug, Default)]
pub struct ElementCache {
    /// scope → (element_id → node)
    by_scope: HashMap<String, HashMap<String, DomNode>>,
}

impl ElementCache {
    /// A fresh, empty cache.
    #[must_use]
    pub fn new() -> Self {
        ElementCache {
            by_scope: HashMap::new(),
        }
    }

    /// Populate a scope from a snapshot's nodes, REPLACING any prior entries for that
    /// scope (a new snapshot invalidates stale element ids).
    pub fn populate(&mut self, scope: &str, nodes: &[DomNode]) {
        let map = nodes
            .iter()
            .map(|n| (n.element_id.clone(), n.clone()))
            .collect();
        self.by_scope.insert(scope.to_string(), map);
    }

    /// Resolve a cached element id within a scope to its node (e.g. for an `act` target).
    /// Returns `None` if the scope was never snapshotted or the id is stale/unknown
    /// (fail-closed: the handler then rejects the act rather than guessing).
    #[must_use]
    pub fn resolve<'a>(&'a self, scope: &str, element_id: &str) -> Option<&'a DomNode> {
        self.by_scope.get(scope)?.get(element_id)
    }

    /// Whether a scope has a populated snapshot.
    #[must_use]
    pub fn has_scope(&self, scope: &str) -> bool {
        self.by_scope.contains_key(scope)
    }

    /// Number of cached elements in a scope (0 if the scope is absent).
    #[must_use]
    pub fn len_in_scope(&self, scope: &str) -> usize {
        self.by_scope.get(scope).map_or(0, HashMap::len)
    }

    /// Drop a scope's cache (e.g. when its tab/session closes).
    pub fn clear_scope(&mut self, scope: &str) {
        self.by_scope.remove(scope);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, selector: &str) -> DomNode {
        DomNode {
            element_id: id.to_string(),
            role: "button".to_string(),
            name: None,
            selector: Some(selector.to_string()),
        }
    }

    #[test]
    fn unknown_id_resolves_to_none_fail_closed() {
        let cache = ElementCache::new();
        assert!(cache.resolve("s1:tab-1", "el-1").is_none());
        assert!(!cache.has_scope("s1:tab-1"));
    }

    #[test]
    fn populate_then_resolve() {
        let mut cache = ElementCache::new();
        cache.populate("s1:tab-1", &[node("el-1", "#a"), node("el-2", "#b")]);
        assert!(cache.has_scope("s1:tab-1"));
        assert_eq!(cache.len_in_scope("s1:tab-1"), 2);
        let resolved = cache.resolve("s1:tab-1", "el-2").expect("el-2 present");
        assert_eq!(resolved.selector.as_deref(), Some("#b"));
        // An id from another scope is not visible.
        assert!(cache.resolve("s9:tab-9", "el-1").is_none());
    }

    #[test]
    fn re_snapshot_replaces_stale_ids() {
        let mut cache = ElementCache::new();
        cache.populate("s1", &[node("el-1", "#a")]);
        // A fresh snapshot of the same scope supersedes the old ids.
        cache.populate("s1", &[node("el-9", "#z")]);
        assert!(
            cache.resolve("s1", "el-1").is_none(),
            "stale id must be gone"
        );
        assert!(cache.resolve("s1", "el-9").is_some());
        assert_eq!(cache.len_in_scope("s1"), 1);
    }

    #[test]
    fn clear_scope_drops_the_cache() {
        let mut cache = ElementCache::new();
        cache.populate("s1", &[node("el-1", "#a")]);
        cache.clear_scope("s1");
        assert!(!cache.has_scope("s1"));
        assert_eq!(cache.len_in_scope("s1"), 0);
    }
}
