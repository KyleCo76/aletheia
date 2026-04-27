use std::collections::HashMap;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct InjectionSettings {
    pub trigger: String,
    pub l1_interval: u32,
    pub l2_interval: u32,
    pub history_reminders: bool,
    pub token_budget: u32,
    pub inferred_context_window: u32,
    pub relevance: InjectionRelevance,
    pub weights: InjectionWeights,
    pub recency: InjectionRecency,
}

impl Default for InjectionSettings {
    fn default() -> Self {
        Self {
            trigger: "PreToolUse".into(),
            l1_interval: 10,
            l2_interval: 20,
            history_reminders: true,
            token_budget: 1500,
            inferred_context_window: 20,
            relevance: InjectionRelevance::default(),
            weights: InjectionWeights::default(),
            recency: InjectionRecency::default(),
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct InjectionRelevance {
    pub l1_threshold: f64,
    pub l2_threshold: f64,
    pub l1_token_budget: u32,
    pub l2_token_budget: u32,
}

impl Default for InjectionRelevance {
    fn default() -> Self {
        Self {
            l1_threshold: 0.7,
            l2_threshold: 0.5,
            l1_token_budget: 1000,
            l2_token_budget: 3000,
        }
    }
}

/// CRITICAL CONTRACT C1 (plan IS-6, CR-1, CR-6): this MUST be a
/// `HashMap<String, f64>`, NOT a struct with named fields. V3 KG adds
/// a `graph_proximity` weight key without V2 code change. A typed
/// struct here breaks the V2 → V3 forward-compat contract.
///
/// `#[serde(transparent)]` so the TOML `[injection.weights]` table
/// maps directly to the inner HashMap.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(transparent)]
pub struct InjectionWeights(pub HashMap<String, f64>);

impl Default for InjectionWeights {
    fn default() -> Self {
        let mut m = HashMap::new();
        m.insert("tag_overlap".into(), 0.4);
        m.insert("active_project".into(), 0.3);
        m.insert("critical".into(), 0.2);
        m.insert("recency".into(), 0.1);
        Self(m)
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct InjectionRecency {
    pub half_life_days: f64,
}

impl Default for InjectionRecency {
    fn default() -> Self {
        Self {
            half_life_days: 30.0,
        }
    }
}
