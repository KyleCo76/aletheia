---
title: "Aletheia V2 Implementation Plan"
date: 2026-04-26
type: implementation-plan
feature: "aletheia-v2"
design-doc: "docs/plans/designs/2026-04-17-aletheia-v2-design.md"
tier: 2
---

# Implementation Plan: Aletheia V2

<!-- plan-index:start -->
<!-- verified:2026-04-27T04:00:52 -->
<!-- overview lines:63-131 -->
<!-- phase-summary lines:133-160 -->
<!-- phase:1 lines:162-601 title:"Foundation" -->
<!-- conductor-review:1 lines:603-645 -->
<!-- phase:2 lines:647-1267 title:"Storage Foundation" -->
<!-- conductor-review:2 lines:1269-1328 -->
<!-- phase:3 lines:1330-1932 title:"Auth + Sessions" -->
<!-- conductor-review:3 lines:1934-1979 -->
<!-- phase:4 lines:1981-2396 title:"MCP Server Core + Hook Endpoint" -->
<!-- conductor-review:4 lines:2398-2466 -->
<!-- phase:5 lines:2468-3135 title:"Tools (V1-Equivalent + V2-New)" -->
<!-- conductor-review:5 lines:3137-3202 -->
<!-- phase:6 lines:3204-3681 title:"Hook Layer + Injection Pipeline" -->
<!-- conductor-review:6 lines:3683-3744 -->
<!-- phase:7 lines:3746-4522 title:"Digest Pipeline + Mass-Ingest" -->
<!-- conductor-review:7 lines:4524-4584 -->
<!-- phase:8 lines:4586-5786 title:"V1 to V2 Migration Tool" -->
<!-- conductor-review:8 lines:5788-5854 -->
<!-- phase:9 lines:5856-6587 title:"Reconciliation + Operational Polish + Shadow Mode" -->
<!-- conductor-review:9 lines:6589-6647 -->
<!-- phase:10 lines:6649-7127 title:"Distribution + Release" -->
<!-- conductor-review:10 lines:7129-7196 -->
<!-- plan-index:end -->

<sections>
- overview
- phase-summary
- phase-1
- conductor-review-1
- phase-2
- conductor-review-2
- phase-3
- conductor-review-3
- phase-4
- conductor-review-4
- phase-5
- conductor-review-5
- phase-6
- conductor-review-6
- phase-7
- conductor-review-7
- phase-8
- conductor-review-8
- phase-9
- conductor-review-9
- phase-10
- conductor-review-10
</sections>

<!-- overview -->
<section id="overview">
## Overview

<core>
This plan implements **Aletheia V2** — a greenfield Rust rewrite of the existing Aletheia MCP memory server (v0.2.8 TypeScript). V2 is an evolution of V1's foundational architecture (claim-based hierarchical auth, L1/L2 PreToolUse injection hooks, Dumb-Capture-Smart-Digest, four entry types: journal/memory/status/handoff) with targeted deltas driven by real-world V1 usage and known V1 bugs.

**End goals:**
- V1's cross-scope-leak bug eliminated by per-scope SQLite files connected via `ATTACH DATABASE` (mathematically leak-proof at the SQL layer; not filter-logic dependent)
- Multi-writer parallelism: each scope has independent writer lock (N scopes = N parallel writers)
- Auto-reclaim on `claude --resume` via `session_bindings + session_locks` two-table model (key is persistent identity; session-id is UX cache)
- Append-only versioned entries with `valid_from`/`valid_to` columns enable first-class time-travel queries (`query_past_state(entry_id, timestamp)`)
- SDK-based digest replaces V1's tmux-spawned teammate; orchestrated via shared `digest_queue` with lease-lock crash recovery
- First-class feature lifecycle (`feature_init`, `table_feature`, `resume_feature`, `feature_wrap_up`, `abandon_feature`) with explicit state machine
- Mass-ingest with supervisor approval via status-document polling for bulk operations bypassing normal digest budgets
- Two-layer active-project / active-context model for cross-project sessions (CEO multi-project workflow)
- Threshold-gated Top-K relevance scoring with pluggable `Signal` trait (V3 KG plugs `GraphProximitySignal` here non-breaking)
- Two-surface migration: `migrate_from_v1` (one-shot V1 → V2 structural restructure) + `start_migration` (generic V2.x → V2.y+1 DDL)
- Comprehensive immutable `sys_audit_log` (5-year retention) with SQLite trigger-enforced append-only
- Shadow Mode infrastructure (V2 doesn't exercise; V3 uses for ranking comparison)
- npm-distributed Rust binary (`npm install -g aletheia-v2`) using `optionalDependencies` pattern (esbuild/swc/biome model)

**Install model (post-CEO-pre-build review — side-by-side with V1):**
- V2 publishes as the **distinct npm package `aletheia-v2`** (NOT as `aletheia@2.0.0` overwriting V1's `aletheia@0.2.8`).
- V2 binary name: `aletheia-v2` (CLI command), distinct from V1's `aletheia`.
- V2 data directory: `~/.aletheia-v2/` (parallel to V1's `~/.aletheia/`; never colliding).
- Both V1 and V2 install + run simultaneously. CC's `~/.claude/settings.json` registers them as separate MCP servers (`aletheia` and `aletheia-v2`) with separate hook entries.
- Migration tool reads V1 read-only at `~/.aletheia/data/aletheia.db`, writes V2 to `~/.aletheia-v2/`. **V1 is NEVER renamed or modified by the migration.** V1's MCP server can keep running on V1's data throughout migration and afterward.
- Cutover is user-driven (uninstall V1 npm + remove V1 entry from `~/.claude/settings.json` + optional `rm -rf ~/.aletheia/`) AFTER user validates V2. Documented in `docs/MIGRATION-FROM-V1.md`.
- Master-key flow Option 1: `aletheia-v2 setup` mints a fresh V2 master key (independent of V1's master); `migrate-from-v1` imports V1 keys into V2's `keys` table preserving original permissions but with `is_master_key=0` (V1's master becomes a 'maintenance'-permission V2 sub-key; the new V2 master is the trust root).

**Key decisions reflected in this plan (Phase 3 settled):**
- **Q1 — Language: Rust** (rmcp 1.5.x + rusqlite bundled + interprocess v2 + tokio + cargo-dist). Rationale: memory footprint at scale (5-15MB resident vs Node's 80-150MB) becomes meaningful as concurrent CC sessions grow; single static binary; type-system discipline on SQL paths; user preference for Rust where it makes sense.
- **Q2 — Hooks payload format: JSON** (preserves V1's actual behavior; design doc's "YAML-in-XML inherited from V1" was a doc-error — V1 returns JSON).
- **Q3 — SDK digest subprocess cwd:** `~/.aletheia-v2/sdk-runtime/<queue_id>/` per-run (created before spawn, deleted on commit, 24h orphan retention).
- **Q4 — `session_id` discovery file:** single-line plain text at `~/.aletheia-v2/sessions/<my_pid>.session_id` (mode 0600), written by SessionStart hook, read by MCP server via `<my_ppid>` lookup.
- **Q5 — V1→V2 row-transform mechanics:** V1's 2-level hierarchy (entries → typed children) flattens to V2's per-row entries model. V1 memory key → tag (`key:<v1_key>`); V1 entries.id preserved as `entry_id_legacy:<v1-uuid>` tag; `memory_journal_provenance` table KEPT (V3 KG `derived_from` edge type); keys metadata in `scope_registry.db.keys` with raw values in `~/.aletheia-v2/keys/<name>.key` files; `journal_entries.sub_section` → `sub_section:<value>` tag.
- **Q6 — settings.toml:** V1 sections preserved + 11 new V2 sections. `[injection.weights]` MUST be parsed as `HashMap<String, f64>` (V3's `graph_proximity` weight added non-breaking).
- **Q7 — KG-stub patterns (7 architectural seams):** Pluggable `Signal` trait + `HashMap` weights + extensible `Context` struct + `memory_journal_provenance` table preserved + extensible dedup response struct + minimal `show_related` MCP signature + minimal `query_past_state` MCP signature.
- **Q8 — Cross-DB reconciliation:** Reconciler module scans `sys_audit_log` for orphaned `*_proposed`/`_started` events without `*_committed`; runs at MCP server startup + every 5 minutes + on-demand via master-key `reconcile()` tool. Operations designed idempotent for safe retry.
- **Q9 — Poll cadences:** mass-ingest approval 30s; digest_queue poller 60s; reconciliation sweep 5min; session_id orphan sweep 5min; sdk-runtime/ orphan cleanup 24h. All configurable.

**Constraints from design (inviolable per Dramaturg/CEO settlement):**
- Solo-developer to small-team to CEO/cross-project use cases all supported (no setup paradigm shift)
- Long-running autonomous sessions survive `claude --resume` AND survive session-id corruption (key is persistent identity; session-id is UX cache)
- Server-side actions that deviate from agent's request MUST be reported explicitly (visible-dedup principle: write routing, content-hash dedup, queue dedup, feature-overlap two-call confirmation, context-project mismatch warnings)
- V2 → V3 forward-compat preserved via 7 architectural seams; V3 extends without redesigning V2 foundation
- Forward-only migrations in V2 (no `down()` scripts; rollback via backup restore)

**Verification mode:** Normal (Gemini available throughout planning). 4 design conflicts surfaced and resolved with user input (A1-A3 in Phase 2; SDK launch flag combination found via OAuth-preserving spike test).

**User overrides:** None requiring downstream flags. Design adjustments per CEO Item resolutions (1-9) and Phase 2 design conflicts (A1-A3) all incorporated as standard plan content.
</core>

<context>
**Background — preceding design work:**

The Aletheia V2 design (`docs/plans/designs/2026-04-17-aletheia-v2-design.md`) is the Dramaturg's compiled output from a 2026-04-17 / 2026-04-18 design session. CEO review (2026-04-25) produced 9 resolved decisions captured in `docs/plans/designs/decisions/aletheia-v2/ceo-review-feedback.md`. The Knowledge Graph layer is deferred to a future V3 Dramaturg session — V2 ships forward-compat seams documented in `docs/plans/designs/decisions/aletheia-v2/knowledge-graph-research-handoff.md`.

V2 is an internal/development release that WILL be implemented and deployed. V3 is the first public release (post-KG); V3 Dramaturg session will run after V2 is deployed, taking V2 deployment experience as input. This plan's Phase 9 (Reconciliation + Operational Polish + Shadow Mode) and the 7 KG-stub patterns (Q7) explicitly preserve V3's extension surface.

**Source of decision rationale:** `docs/plans/designs/decisions/aletheia-v2/arranger-journal.md` (Phases 1-4 of Arranger work). For implementation insights and CC ecosystem realities discovered during Phase 2 audit, see `docs/plans/designs/decisions/aletheia-v2/arranger-handoff.md` (V2 implementation handoff for V3 sessions).

**V1 reference:** Source code at `/home/claude/kyle-projects/aletheia/src/` (TypeScript). V1 design at `/home/claude/kyle-projects/aletheia/2026-04-08-aletheia-design.md`. V1 ships v0.2.8 via npm. V2 is a greenfield rewrite — Phase 8 implements `migrate_from_v1` to read V1's SQLite database as data only (no V1 code reuse).

**Tech stack lock-ins:** Rust 2024 edition (or stable at build time), `rmcp` 1.5.x (Anthropic official Rust MCP SDK), `rusqlite` with `bundled` feature, `interprocess` v2.x for cross-platform Unix sockets / Windows named pipes, `tokio` async runtime, `cargo-dist` for npm distribution, `serde` + `schemars` for tool registration, `toml` crate for settings parsing, `sha2` for content hashing, `uuid` for entry/scope IDs.
</context>
</section>
<!-- /overview -->

<!-- phase-summary -->
<section id="phase-summary">
## Phase Summary

<core>
| Phase | Title | Depends On | Internal Parallelization |
|-------|-------|-----------|--------------------------|
| 1 | Foundation | None | Low — workspace bootstrap, sequential |
| 2 | Storage Foundation | Phase 1 | Medium — 5 parallel: per-scope schema, registry schema, audit log + trigger, ATTACH wiring, generic migration framework |
| 3 | Auth + Sessions | Phase 2 | High — 5 parallel: keys, session_bindings, session_locks+heartbeat, claim/whoami/refresh, SessionStart hooks (sh + js) |
| 4 | MCP Server Core + Hook Endpoint | Phase 2 (parallel with Phase 3) | Medium — 4 parallel: rmcp setup, server lifecycle, interprocess transport, HTTP endpoint server |
| 5 | Tools (V1-Equivalent + V2-New) | Phases 3 + 4 | Very high — 8+ parallel by category: auth, entry, status, discovery, handoff, system, features, time-travel, promote_memory, active-project/context |
| 6 | Hook Layer + Injection Pipeline | Phases 4 + 5 | High — 6 parallel: V1 hook scripts compat, Signal trait + 4 implementations, threshold-gated Top-K scorer, L1/L2 builders, frequency manager, KG-stub verification |
| 7 | Digest Pipeline + Mass-Ingest | Phase 5 (parallel with Phase 6) | High — 6 parallel: digest_queue + leasing, SDK subprocess launch, digest agent prompt, background poller, mass-ingest approval, checkpointing |
| 8 | V1→V2 Migration Tool | Phases 2 + 3 + 7 | Very high — 6+ parallel by V1 table type: introspection, partitioning, journal transform, memory transform (active+archived+versions), status transform, handoff transform, key migration, lazy first-claim trigger marker |
| 9 | Reconciliation + Operational Polish + Shadow Mode | Phases 6 + 7 (parallel with Phase 8) | High — 4 parallel: reconciler module + recovery handlers, tool deprecation lifecycle, orphan sweepers, Shadow Mode infrastructure |
| 10 | Distribution + Release | All previous | Medium — 4 parallel: cargo-dist setup, JS wrapper shim, GitHub Actions matrix, npm publish workflow + docs |

**Total phases:** 10
**Critical path:** `1 → 2 → (3 ∥ 4) → 5 → (6 ∥ 7) → (8 ∥ 9) → 10` (7 sequential steps)
**Recommended parallelization strategy:** The Conductor should launch Phase 3 and Phase 4 concurrently after Phase 2 completes — they share no files (auth lives in `src/auth/`, MCP server in `src/server/`). Phases 6 and 7 can run concurrently after Phase 5. Phases 8 (migration) and 9 (operational) are independent enough to parallelize. Within each phase, sub-tasks are designed to touch separate files where possible — see per-phase Implementation sections for the file boundaries.

**Cross-task integration surfaces** (catalogued in Phase 4; flagged in conductor checkpoints): IS-1 through IS-10 cover database schema contracts (Phase 2 → all consumers), claim result struct (Phase 3 → 5), rmcp tool registration framework (Phase 4 → 5), hook endpoint payload format (Phase 4 → 6), Signal trait + KG forward-compat (Phase 6 → V3), digest_queue + SDK subprocess (Phase 7 → 5), migration framework (Phase 2 → 8), audit log → reconciler (Phase 2 → 9), tool deprecation lifecycle (Phase 9 → 5).

**Danger files** (multi-phase touch with split-submodule mitigation): `Cargo.toml` (Phases 1, 10 — bounded), `src/lib/settings/mod.rs` (Phases 1-10 — split into per-section submodules), `src/server/index.rs` (Phases 4-9 — Registrar pattern), `src/server/tools/mod.rs` (Phases 4-5 — Phase 4 stubs all categories upfront).
</core>
</section>
<!-- /phase-summary -->

<!-- phase:1 -->
<section id="phase-1">
## Phase 1: Foundation

<core>
### Objective
Establish the Cargo workspace, dependency tree, core types, error handling, settings.toml parser + schema (with critical HashMap typing for forward-compat), and minimal CI scaffolding. Pure preparation work — no runtime functionality. All subsequent phases depend on the artifacts created here.

### Prerequisites
- Empty target directory ready for greenfield Rust project (V2 lives in a NEW repository or NEW subtree, NOT modifying V1's TypeScript source — V1 source is read-only reference at `/home/claude/kyle-projects/aletheia/src/`)
- Rust toolchain installed (stable; 2024 edition)
- Cargo + git available

### Implementation

<mandatory>The `[injection.weights]` settings section MUST be parsed as `HashMap<String, f64>` — NOT a fixed-key struct. V3 KG adds a `graph_proximity` weight key without V2 code change. A typed struct here breaks the V2 → V3 forward-compat contract.</mandatory>

<mandatory>The settings module MUST be split into per-section submodules under `src/lib/settings/` to mitigate the multi-phase danger-file conflict. Do NOT create a single `src/lib/settings.rs` file that all phases edit — every phase from 2 through 10 adds config sections.</mandatory>

**Cargo workspace structure:**

Set up a Cargo workspace with one main binary crate. Workspace `Cargo.toml`:

```toml
[workspace]
members = ["crates/aletheia-v2"]
resolver = "2"

[workspace.package]
version = "2.0.0"
edition = "2024"
license = "MIT"
authors = ["Kyle Corbeille"]

[workspace.dependencies]
rmcp = "1.5"
rusqlite = { version = "0.32", features = ["bundled", "json", "trace"] }
interprocess = { version = "2", features = ["tokio"] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
schemars = "0.8"
toml = "0.8"
sha2 = "0.10"
uuid = { version = "1", features = ["v4", "serde"] }
thiserror = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
chrono = { version = "0.4", features = ["serde"] }
```

**SQLite ATTACH ceiling raised at build time.** Default `SQLITE_MAX_ATTACHED=10` is too tight for forward-compat (CEO sessions could span more than 10 scopes as project count grows). `rusqlite`'s `bundled` feature compiles SQLite from C source — pass the higher cap as a build define via `crates/aletheia-v2/build.rs`:

```rust
// crates/aletheia-v2/build.rs
fn main() {
    println!("cargo:rustc-env=SQLITE_MAX_ATTACHED=125");
    // The bundled SQLite picks up SQLITE_MAX_ATTACHED via libsqlite3-sys's build script
    // which honors LIBSQLITE3_SYS_USE_PKG_CONFIG / SQLITE3_INCLUDE_DIR / and rust-env-defines
    println!("cargo:rerun-if-changed=build.rs");
}
```

Alternative (cleaner): set in `Cargo.toml` via `[dependencies.libsqlite3-sys]` build-time defines once the precise mechanism is verified during Phase 1 build. The hard maximum SQLite supports is 125 (per SQLite docs) — bumping to that ceiling means ATTACH-related failures only surface when claims exceed 125 scopes, well beyond practical V2 hierarchies. Plan documents the ceiling; tool error response makes it explicit if hit.

The single binary crate (`crates/aletheia-v2/Cargo.toml`) inherits workspace dependencies. The binary name is `aletheia-v2` (distinct from V1's `aletheia` per side-by-side install model — see Overview "Install model").

**Module structure (under `crates/aletheia-v2/src/`):**

```
src/
├── main.rs                    # CLI entry point (subcommand dispatch: serve, bootstrap, migrate-from-v1, etc.)
├── lib.rs                     # Library root for testing
├── error.rs                   # AletheiaError enum (thiserror-based)
├── types/                     # Core domain types
│   ├── mod.rs
│   ├── entry.rs               # EntryClass, EntryId, Version, ValidityWindow
│   ├── scope.rs               # ScopeId, ScopeName, ScopeKind, PermissionSet
│   ├── key.rs                 # KeyId, KeyHash, KeyValue (newtype around String for raw key), Permissions enum
│   ├── feature.rs             # FeatureId, FeatureState
│   └── audit.rs               # AuditEventCategory, AuditEventType
├── lib/
│   ├── mod.rs
│   ├── settings/              # ⚠ DANGER FILE MITIGATION — split into per-section submodules
│   │   ├── mod.rs             # Loads + merges all submodules; exposes Settings struct
│   │   ├── permissions.rs     # [permissions]
│   │   ├── injection.rs       # [injection], [injection.relevance], [injection.weights] (HashMap), [injection.recency]
│   │   ├── memory.rs          # [memory]
│   │   ├── hooks.rs           # [hooks]
│   │   ├── digest.rs          # [digest], [digest.per_scope]
│   │   ├── digest_queue.rs    # [digest_queue]
│   │   ├── mass_ingest.rs     # [mass_ingest]
│   │   ├── shadow.rs          # [shadow]
│   │   ├── session_locks.rs   # [session_locks]
│   │   ├── retention.rs       # [retention]
│   │   ├── features.rs        # [features]
│   │   ├── migration.rs       # [migration]
│   │   ├── scopes.rs          # [scopes]
│   │   └── limits.rs          # [limits]
│   └── version.rs             # Build-time version constant via env!("CARGO_PKG_VERSION")
└── (other modules added in later phases — db/, server/, hooks/, digest/, etc.)
```

**Top-level `src/lib/settings/mod.rs`:**

The orchestrating module declares all section submodules and assembles a top-level `Settings` struct via composition. Each submodule defines its own struct with `serde::Deserialize` + `Default`. A single TOML parse populates the whole tree.

```rust
mod permissions;
mod injection;
mod memory;
mod hooks;
mod digest;
mod digest_queue;
mod mass_ingest;
mod shadow;
mod session_locks;
mod retention;
mod features;
mod migration;
mod scopes;
mod limits;

pub use permissions::PermissionsSettings;
pub use injection::{InjectionSettings, InjectionRelevance, InjectionWeights, InjectionRecency};
// ... (re-export all section types)

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct Settings {
    pub permissions: PermissionsSettings,
    pub injection: InjectionSettings,
    pub memory: MemorySettings,
    pub hooks: HooksSettings,
    pub digest: DigestSettings,
    pub digest_queue: DigestQueueSettings,
    pub mass_ingest: MassIngestSettings,
    pub shadow: ShadowSettings,
    pub session_locks: SessionLocksSettings,
    pub retention: RetentionSettings,
    pub features: FeaturesSettings,
    pub migration: MigrationSettings,
    pub scopes: ScopesSettings,
    pub limits: LimitsSettings,
    pub debug: bool,
}

impl Default for Settings {
    fn default() -> Self {
        // Each submodule's struct has its own Default; this composes them
        Self::deserialize(toml::Value::Table(toml::map::Map::new())).unwrap()
    }
}

impl Settings {
    pub fn load(path: &std::path::Path) -> Result<Self, crate::error::AletheiaError> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let contents = std::fs::read_to_string(path)?;
        let parsed: Self = toml::from_str(&contents)?;
        Ok(parsed)
    }
}
```

**Critical sub-section: `src/lib/settings/injection.rs`:**

```rust
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
        Self { l1_threshold: 0.7, l2_threshold: 0.5, l1_token_budget: 1000, l2_token_budget: 3000 }
    }
}

/// CRITICAL: HashMap (NOT a fixed-key struct). V3 adds graph_proximity here non-breaking.
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
    fn default() -> Self { Self { half_life_days: 30.0 } }
}
```

Other section submodules follow the same pattern — `Default` baked in, all values matching Phase 3 Q6 specifications.

**Core types skeleton (`src/types/mod.rs` and submodules):**

```rust
// src/types/entry.rs
use uuid::Uuid;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryClass {
    Journal,
    Memory,
    Status,
    Handoff,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct EntryId(pub String);  // UUID v4 string

impl EntryId {
    pub fn new() -> Self { Self(Uuid::new_v4().to_string()) }
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct ValidityWindow {
    pub valid_from: DateTime<Utc>,
    pub valid_to: Option<DateTime<Utc>>,
}

// src/types/scope.rs
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct ScopeId(pub String);  // UUID v4 string

#[derive(Debug, Clone)]
pub struct PermissionSet {
    pub primary_scope_id: ScopeId,
    pub writable_scope_ids: Vec<ScopeId>,
    pub readonly_scope_ids: Vec<ScopeId>,
}

// src/types/key.rs
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct KeyHash(pub String);  // SHA-256 hex

#[derive(Debug, Clone)]
pub struct KeyValue(pub String);  // Raw 64-char hex; never serialized to DB

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Permissions {
    ReadOnly,
    ReadWrite,
    CreateSubEntries,
    Maintenance,
}
```

**Error type (`src/error.rs`):**

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AletheiaError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("TOML parse error: {0}")]
    Toml(#[from] toml::de::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Auth error: {0}")]
    Auth(String),

    #[error("Scope error: {0}")]
    Scope(String),

    #[error("Migration in progress — tool calls blocked until migration completes")]
    MigrationInProgress,

    #[error("Tool removed since {since}: {hint}")]
    ToolRemoved { since: String, hint: String },

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, AletheiaError>;
```

**Build-time version (`src/lib/version.rs`):**

```rust
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const SCHEMA_VERSION: u32 = 1;  // V2 starts at user_version=1; bumped per migration
```

**Main binary entry (`src/main.rs`):**

Stub for Phase 1 — exits with usage. Full subcommand dispatch added in Phase 4.

```rust
use clap::Parser;  // Add `clap = { version = "4", features = ["derive"] }` to deps

#[derive(Parser)]
#[command(name = "aletheia", version, about = "Aletheia V2 — structured memory MCP server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(clap::Subcommand)]
enum Commands {
    /// Run the MCP server (default mode)
    Serve,
    /// First-time installation setup
    Setup,
    /// Migrate from V1 (one-shot, master-key required)
    MigrateFromV1 { v1_db_path: std::path::PathBuf },
}

fn main() -> aletheia::error::Result<()> {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Commands::Serve) {
        Commands::Serve => unimplemented!("Phase 4"),
        Commands::Setup => unimplemented!("Phase 3"),
        Commands::MigrateFromV1 { .. } => unimplemented!("Phase 8"),
    }
}
```

**CI scaffolding (`.github/workflows/ci.yml`):**

Minimal build + test workflow. Multi-target matrix added in Phase 10.

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo build --workspace --all-features
      - run: cargo test --workspace --all-features
      - run: cargo fmt --all -- --check
      - run: cargo clippy --workspace --all-features -- -D warnings
```

<guidance>
Set up a `rustfmt.toml` and `.clippy.toml` early to lock formatting and lint conventions before subsequent phases produce code. Suggested: `edition = "2024"` in rustfmt.toml; standard clippy lints with `pedantic` opt-out for ergonomics.

Add `cargo deny` to CI in Phase 10 for license + advisory checks, but defer until release-time concerns.

Use `tracing` (workspace dep) for all logging from the start. The MCP server uses stdio for the protocol — log to stderr via `tracing-subscriber`, never stdout (would corrupt MCP JSON-RPC).
</guidance>

### Integration Points
- `src/error.rs::AletheiaError` is consumed by every subsequent module — all `Result<T>` returns alias to `Result<T, AletheiaError>`.
- `src/lib/settings/mod.rs::Settings` is the single source of configuration truth — every later phase's submodule extends this tree by adding its own section file under `src/lib/settings/`.
- `src/types/` exports are the wire types for tool responses; later phases serialize/deserialize via `serde`.
- The Cargo workspace structure determines where every later phase places its files. Module paths in this phase set the convention for all future modules.

### Expected Outcomes
- `cargo build --workspace` succeeds with zero warnings
- `cargo test` runs successfully (no tests yet, but harness works)
- `cargo run -- --version` prints the version
- `cargo run` (no subcommand) exits cleanly with "Phase 4" unimplemented panic (acceptable for Phase 1)
- `Settings::load(Path::new("non-existent"))` returns `Settings::default()` without error
- `Settings::load` of a TOML file with a `[injection.weights]` section containing arbitrary keys parses successfully (forward-compat HashMap typing verified)
- CI workflow runs and passes on PR

### Testing Recommendations
- Unit test `Settings::default()` returns a struct where every field matches Phase 3 Q6 specifications (exhaustive value comparison)
- Unit test `Settings::load` round-trip: serialize a known TOML → parse → assert field values
- Unit test `InjectionWeights` parses both V2's keys (tag_overlap, active_project, critical, recency) AND a V3-anticipated key (e.g., `graph_proximity = 0.5`) — proves forward-compat
- Unit test `EntryId::new()` produces unique IDs (5 calls, all different)
- Unit test `Permissions` ordering: `ReadOnly < ReadWrite < CreateSubEntries < Maintenance`
- Smoke test: `cargo run -- migrate-from-v1 /nonexistent` panics with "Phase 8" unimplemented (proves CLI dispatch wired correctly)

This phase has no production behavior to integration-test; that begins in Phase 2 (storage) and Phase 4 (MCP server).
</core>
</section>
<!-- /phase:1 -->

<!-- conductor-review:1 -->
<section id="conductor-review-1">
## Conductor Review: Post-Phase 1

<core>
### Verification Checklist

<mandatory>All checklist items must be verified before proceeding.</mandatory>

- [ ] `crates/aletheia-v2/Cargo.toml` exists with all workspace deps inherited; `cargo build --workspace` succeeds with zero warnings
- [ ] Module structure matches the plan: `src/lib/settings/` is a directory with per-section submodules (NOT a single file) — verified by `ls crates/aletheia-v2/src/lib/settings/`
- [ ] `src/lib/settings/injection.rs::InjectionWeights` is `HashMap<String, f64>` (NOT a struct with named fields) — verified by reading the file. **Critical for V3 forward-compat (IS-6).**
- [ ] `Settings::default()` produces a fully-populated struct with values matching Q6 (spot-check `injection.weights.0.get("tag_overlap")` == 0.4, `session_locks.heartbeat_seconds` == 60, `mass_ingest.approval_ttl_hours` == 24)
- [ ] Unit test confirms `InjectionWeights` parses an arbitrary V3-anticipated key (e.g., `graph_proximity = 0.5`) without error
- [ ] `cargo test --workspace` runs and all written tests pass
- [ ] `cargo fmt --all -- --check` and `cargo clippy --workspace -- -D warnings` pass
- [ ] CI workflow file exists at `.github/workflows/ci.yml` and runs on a test PR
- [ ] `tracing-subscriber` configured to write to **stderr** (not stdout) — critical for MCP server stdio protocol that begins in Phase 4

### Known Risks
- **Rust toolchain version drift:** If a contributor uses a different toolchain version, formatting may produce diffs. Pin via `rust-toolchain.toml` early — recommend adding to Phase 1 if not already done.
- **clippy strictness:** `-D warnings` blocks PRs on any clippy lint. Phase 1 code is small, so this is fine; later phases may need targeted `#[allow]` attributes for complex cases. Establish convention now.
- **Workspace vs single-crate confusion:** A single-crate layout would also work, but the workspace structure leaves room for future crates (e.g., a separate `aletheia-cli` or `aletheia-migrate` if extracted later). Conductor: don't collapse to single-crate during implementation.
- **Settings submodule explosion:** With 14 submodule files, the `mod.rs` orchestrating module is the only place that knows about all of them. If a phase forgets to declare its submodule in `mod.rs`, parsing silently drops that section's config. Conductor checkpoint for later phases must verify this declaration.

### Guidance for Phase 2

<guidance>
Phase 2 builds on Phase 1's types and error infrastructure. Five parallel sub-tasks recommended:

1. **Per-scope DB schema** (`src/db/scope_schema.rs`) — DDL constants for `entries`, `status_sections`, `features`, `memory_journal_provenance`. References `src/types/`.
2. **Scope registry schema** (`src/db/registry_schema.rs`) — DDL constants for `scopes`, `session_bindings`, `session_locks`, `digest_queue`, `mass_ingest_requests`, `mass_ingest_checkpoints`, `sys_audit_log`, `shadow_comparison_log`, `migration_state`, `migration_scope_progress`, `keys`. **All registry tables defined here in Phase 2; subsequent phases query only — no multi-phase modification of this file.**
3. **Audit log immutability trigger** (`src/db/audit_log.rs`) — SQLite trigger DDL + helper functions for emitting events.
4. **ATTACH connection management** (`src/db/connection.rs`) — Connection pool with per-scope ATTACH lifecycle, WAL mode setup, PRAGMA configuration.
5. **Generic migration framework** (`src/db/migrations/mod.rs` + `src/db/migrations/runner.rs`) — `start_migration(target_version, dry_run)` state machine with paused-rollover.

These five sub-tasks share Phase 1 outputs but no files between them — high parallelization potential. The `src/db/mod.rs` aggregator file is touched once at the start of Phase 2 to declare submodules; subsequent sub-tasks add to their own files.

Context management: Run `/lethe compact` before starting Phase 2 to compress Phase 1 work and reclaim context headroom.
</guidance>
</core>
</section>
<!-- /conductor-review:1 -->

<!-- phase:2 -->
<section id="phase-2">
## Phase 2: Storage Foundation

<core>
### Objective
Define all V2 SQL schemas (per-scope `.db` and `scope_registry.db`), wire up `ATTACH DATABASE` connection management with WAL mode, install the SQLite trigger that enforces `sys_audit_log` immutability, and ship the generic V2.x → V2.y+1 migration framework. After Phase 2, the database substrate is fully operational; Phase 3 (auth) and Phase 4 (MCP server) consume it.

### Prerequisites
- Phase 1 complete: Cargo workspace exists, `src/types/`, `src/error.rs`, and `src/lib/settings/` modules are in place
- `Settings` struct fully populated with defaults (especially `[retention]`, `[migration]`, `[session_locks]`, `[mass_ingest]` sections — schema design references some of these)

### Implementation

<mandatory>All registry tables (`scopes`, `session_bindings`, `session_locks`, `digest_queue`, `mass_ingest_requests`, `mass_ingest_checkpoints`, `sys_audit_log`, `shadow_comparison_log`, `migration_state`, `migration_scope_progress`, `keys`) MUST be defined entirely in Phase 2's `src/db/registry_schema.rs`. NO subsequent phase modifies this file. Phases 3, 7, 9 query existing tables only. This eliminates a multi-phase danger-file conflict and ensures the registry schema is fully reviewable as a single artifact.</mandatory>

<mandatory>The `sys_audit_log` immutability trigger MUST be installed at `scope_registry.db` creation time (in the schema bootstrap). UPDATE and DELETE on `sys_audit_log` must abort unless an unlock row exists in a transaction. Insertion of the unlock row must be the first statement in `purge_audit_log`'s transaction; deletion of the unlock row must be the last. Any subsequent migration must re-install or preserve the trigger.</mandatory>

<mandatory>WAL mode (`PRAGMA journal_mode = WAL`) and `PRAGMA synchronous = NORMAL` MUST be set on every connection at open time. `PRAGMA foreign_keys = ON` MUST be set per-connection (SQLite default is OFF). `PRAGMA busy_timeout = 5000` MUST be set per-connection to absorb transient lock contention.</mandatory>

**Module structure (added in Phase 2):**

```
src/
├── db/
│   ├── mod.rs                 # Aggregator: declares all submodules
│   ├── connection.rs          # ConnectionManager + ATTACH lifecycle
│   ├── pragmas.rs             # PRAGMA setup function applied at every connection open
│   ├── scope_schema.rs        # Per-scope DB DDL constants (entries, status_sections, features, memory_journal_provenance)
│   ├── registry_schema.rs     # scope_registry.db DDL constants (ALL registry tables — locked here)
│   ├── audit_log.rs           # Audit log helpers (emit events; trigger DDL; purge with unlock pattern)
│   └── migrations/
│       ├── mod.rs             # Migration framework public API: start_migration, resume_migration, force_unlock, get_migration_status
│       ├── runner.rs          # Paused-rollover state machine
│       ├── scripts.rs         # Embedded SQL scripts (V2 ships v2_initial; V2.1+ adds v2_x_to_v2_y.sql files)
│       └── state.rs           # MigrationState + MigrationScopeProgress structs
```

**Per-scope DB schema (`src/db/scope_schema.rs`):**

```rust
pub const SCHEMA_USER_VERSION: u32 = 1;  // V2.0.0 baseline; bumped per migration

pub const ENTRIES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS entries (
  internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  entry_class TEXT NOT NULL CHECK(entry_class IN ('journal', 'memory', 'status', 'handoff')),
  content TEXT,
  content_hash TEXT NOT NULL,
  tags TEXT,                              -- JSON array
  valid_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to TIMESTAMP,
  invalidation_reason TEXT,
  supersedes_entry_id TEXT,
  reasoning_trace TEXT,
  critical_flag INTEGER NOT NULL DEFAULT 0,
  digested_at TIMESTAMP,
  feature_id TEXT REFERENCES features(feature_id) ON DELETE SET NULL,
  created_by_key_hash TEXT,
  UNIQUE(entry_id, version)
);
CREATE INDEX IF NOT EXISTS idx_entries_entry_id_current ON entries(entry_id, valid_to);
CREATE INDEX IF NOT EXISTS idx_entries_class_valid ON entries(entry_class, valid_to);
CREATE INDEX IF NOT EXISTS idx_entries_content_hash ON entries(content_hash);
CREATE INDEX IF NOT EXISTS idx_entries_journal_digested ON entries(entry_class, digested_at) WHERE entry_class = 'journal';
CREATE INDEX IF NOT EXISTS idx_entries_feature ON entries(feature_id);
"#;

pub const STATUS_SECTIONS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS status_sections (
  internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  status_entry_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT,
  state TEXT,
  position INTEGER,
  valid_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to TIMESTAMP,
  invalidation_reason TEXT CHECK(invalidation_reason IS NULL OR invalidation_reason IN ('updated', 'state_changed', 'removed')),
  changed_by_key_hash TEXT,
  UNIQUE(status_entry_id, section_id, version)
);
CREATE INDEX IF NOT EXISTS idx_status_current ON status_sections(status_entry_id, section_id, valid_to);
"#;

pub const FEATURES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS features (
  feature_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  state TEXT NOT NULL CHECK(state IN ('active', 'tabled', 'wrapped_up', 'abandoned')),
  initiated_at TIMESTAMP NOT NULL,
  tabled_at TIMESTAMP,
  wrapped_at TIMESTAMP,
  abandoned_at TIMESTAMP,
  abandonment_reason TEXT,
  initiated_by_key_hash TEXT,
  last_tabled_by_key_hash TEXT,
  last_tabled_by_session_id TEXT,
  wrapped_by_key_hash TEXT,
  feature_tags TEXT,                      -- JSON array
  metadata TEXT                            -- JSON object
);
CREATE INDEX IF NOT EXISTS idx_features_state ON features(state);
"#;

pub const MEMORY_JOURNAL_PROVENANCE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS memory_journal_provenance (
  memory_entry_id TEXT NOT NULL,
  journal_entry_id TEXT NOT NULL,
  PRIMARY KEY(memory_entry_id, journal_entry_id)
);
CREATE INDEX IF NOT EXISTS idx_provenance_memory ON memory_journal_provenance(memory_entry_id);
CREATE INDEX IF NOT EXISTS idx_provenance_journal ON memory_journal_provenance(journal_entry_id);
"#;

// FTS5 full-text search over entries.content (consumed by Phase 5's `search` tool).
// Per-scope (lives in each scope's `.db`); sync triggers fire on every INSERT/UPDATE of entries.
// Trigger overhead is minor for normal writes; Phase 8's V1→V2 bulk migration disables triggers
// during INSERT then issues a single FTS5 rebuild for performance.
pub const ENTRIES_FTS_TABLE: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(content, content=entries, content_rowid=internal_id);

CREATE TRIGGER IF NOT EXISTS trg_entries_fts_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, content) VALUES (new.internal_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_fts_update AFTER UPDATE ON entries BEGIN
  UPDATE entries_fts SET content = new.content WHERE rowid = new.internal_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_entries_fts_delete AFTER DELETE ON entries BEGIN
  DELETE FROM entries_fts WHERE rowid = old.internal_id;
END;
"#;

pub const ALL_TABLES: &[&str] = &[ENTRIES_TABLE, STATUS_SECTIONS_TABLE, FEATURES_TABLE, MEMORY_JOURNAL_PROVENANCE_TABLE, ENTRIES_FTS_TABLE];

/// Helper: install the full per-scope schema on a fresh `.db` file. Called by:
/// - Phase 3's bootstrap flow when `aletheia-v2 setup` mints a new scope
/// - Phase 8's `migrate_from_v1` orchestrator when partitioning a V1 namespace into a V2 scope DB
/// Idempotent (each table uses `CREATE TABLE IF NOT EXISTS`).
pub fn install_all(conn: &rusqlite::Connection) -> crate::error::Result<()> {
    for ddl in ALL_TABLES {
        conn.execute_batch(ddl)?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {}", SCHEMA_USER_VERSION))?;
    Ok(())
}
```

**Registry schema (`src/db/registry_schema.rs` — LOCKED in Phase 2):**

```rust
pub const REGISTRY_USER_VERSION: u32 = 1;

pub const SCOPES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS scopes (
  scope_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  parent_scope_id TEXT REFERENCES scopes(scope_id) ON DELETE RESTRICT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TIMESTAMP,
  digest_pending_v1_migration INTEGER NOT NULL DEFAULT 0,  -- Q5 lazy first-claim trigger marker
  metadata TEXT                                            -- JSON object
);
CREATE INDEX IF NOT EXISTS idx_scopes_parent ON scopes(parent_scope_id);
CREATE INDEX IF NOT EXISTS idx_scopes_archived ON scopes(archived_at);
"#;

pub const KEYS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS keys (
  key_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,                          -- SHA-256 of raw key value
  name TEXT,                                              -- human label, e.g., "pm-aletheia"
  permissions TEXT NOT NULL CHECK(permissions IN ('read-only', 'read-write', 'create-sub-entries', 'maintenance')),
  created_by_key_id TEXT REFERENCES keys(key_id) ON DELETE SET NULL,
  primary_scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
  writable_scope_ids TEXT NOT NULL,                       -- JSON array of scope_ids (includes primary)
  readonly_scope_ids TEXT NOT NULL DEFAULT '[]',          -- JSON array
  is_master_key INTEGER NOT NULL DEFAULT 0,
  is_digest_key INTEGER NOT NULL DEFAULT 0,
  digest_for_scope_id TEXT REFERENCES scopes(scope_id),  -- non-NULL only when is_digest_key=1
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP,
  CHECK ((is_digest_key = 0 AND digest_for_scope_id IS NULL) OR (is_digest_key = 1 AND digest_for_scope_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_keys_hash ON keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_keys_revoked ON keys(revoked_at);
CREATE INDEX IF NOT EXISTS idx_keys_digest_scope ON keys(digest_for_scope_id) WHERE is_digest_key = 1;
"#;

pub const SESSION_BINDINGS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS session_bindings (
  session_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  primary_scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  bound_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_session_bindings_key ON session_bindings(key_hash);
CREATE INDEX IF NOT EXISTS idx_session_bindings_last_seen ON session_bindings(last_seen_at);
"#;

pub const SESSION_LOCKS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS session_locks (
  session_id TEXT PRIMARY KEY,
  active_pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  active_feature_id TEXT,                                       -- one active feature per session at a time
  -- Active project / active context state (Phase 5 active_context_tools reads/writes these):
  active_project_id TEXT,                                       -- scope_id of active project (per Q6)
  active_project_source TEXT,                                   -- "explicit" | "feature" | "primary" | "cwd" | "inferred"
  active_project_expires_at TIMESTAMP,                          -- TTL gate; NULL = no expiry
  active_context_tags_json TEXT,                                -- JSON array of context tags
  active_context_source TEXT,                                   -- "explicit_override" | "feature_tags" | "project_tags" | "inferred"
  active_context_expires_at TIMESTAMP,
  claimed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_heartbeat_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES session_bindings(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_locks_heartbeat ON session_locks(last_heartbeat_at);
"#;

pub const DIGEST_QUEUE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS digest_queue (
  queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  trigger_type TEXT NOT NULL CHECK(trigger_type IN (
    'entry_threshold', 'time_threshold', 'session_end',
    'feature_wrap', 'feature_init', 'manual',
    'mass_ingest', 'retention_purge'
  )),
  trigger_metadata TEXT,                                  -- JSON
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'leased', 'committed', 'failed')),
  leased_by_pid INTEGER,
  lease_expires_at TIMESTAMP,
  started_at TIMESTAMP,
  committed_at TIMESTAMP,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_digest_status_scope ON digest_queue(status, scope_id);
CREATE INDEX IF NOT EXISTS idx_digest_lease_expires ON digest_queue(lease_expires_at) WHERE status = 'leased';
"#;

pub const MASS_INGEST_REQUESTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS mass_ingest_requests (
  request_id TEXT PRIMARY KEY,
  requester_key_hash TEXT NOT NULL,
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  operation TEXT NOT NULL,
  summary TEXT NOT NULL,
  justification TEXT NOT NULL,
  estimated_entry_count INTEGER,
  source_reference TEXT,
  approval_status_entry_id TEXT,                          -- the status doc holding approval state
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,                          -- created_at + approval_ttl_hours
  approved_at TIMESTAMP,
  approved_by_key_hash TEXT,
  digest_queue_id INTEGER REFERENCES digest_queue(queue_id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied', 'expired', 'started', 'completed', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_mass_ingest_status ON mass_ingest_requests(status);
CREATE INDEX IF NOT EXISTS idx_mass_ingest_expires ON mass_ingest_requests(expires_at) WHERE status = 'pending';
"#;

pub const MASS_INGEST_CHECKPOINTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS mass_ingest_checkpoints (
  request_id TEXT NOT NULL REFERENCES mass_ingest_requests(request_id) ON DELETE CASCADE,
  checkpoint_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_count INTEGER NOT NULL,
  resume_state TEXT NOT NULL,                             -- JSON; SDK contract: no raw sensitive content
  PRIMARY KEY (request_id, checkpoint_at)
);
"#;

pub const SYS_AUDIT_LOG_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS sys_audit_log (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_category TEXT NOT NULL CHECK(event_category IN ('auth', 'lock', 'scope', 'key', 'digest', 'migration', 'deprecation', 'reconciliation')),
  event_type TEXT NOT NULL,
  scope_id TEXT,                                          -- NULL for system-level events
  actor_key_hash TEXT,
  subject_key_hash TEXT,                                  -- for key mutations
  pid INTEGER,
  hostname TEXT,
  details TEXT                                            -- JSON
);
CREATE INDEX IF NOT EXISTS idx_audit_event_at ON sys_audit_log(event_at);
CREATE INDEX IF NOT EXISTS idx_audit_scope ON sys_audit_log(scope_id, event_at);
CREATE INDEX IF NOT EXISTS idx_audit_category ON sys_audit_log(event_category, event_at);

CREATE TABLE IF NOT EXISTS _audit_log_unlock (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
"#;

pub const SYS_AUDIT_LOG_TRIGGERS: &str = r#"
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update BEFORE UPDATE ON sys_audit_log
BEGIN
  SELECT CASE
    WHEN (SELECT value FROM _audit_log_unlock WHERE key = 'unlocked') IS NULL
    THEN RAISE(ABORT, 'sys_audit_log is append-only; UPDATE forbidden')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete BEFORE DELETE ON sys_audit_log
BEGIN
  SELECT CASE
    WHEN (SELECT value FROM _audit_log_unlock WHERE key = 'unlocked') IS NULL
    THEN RAISE(ABORT, 'sys_audit_log is append-only; DELETE forbidden')
  END;
END;
"#;

pub const SHADOW_COMPARISON_LOG_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS shadow_comparison_log (
  comparison_id INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_event TEXT NOT NULL CHECK(hook_event IN ('l1', 'l2')),
  scope_id TEXT,
  session_id TEXT,
  emitted_ranking TEXT NOT NULL,                          -- JSON array of entry_ids
  comparison_ranking TEXT NOT NULL,                       -- JSON array of entry_ids (V1-equivalent or V2-baseline)
  diff_summary TEXT NOT NULL,                             -- JSON { added: [], removed: [], reordered: [] }
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_shadow_recorded ON shadow_comparison_log(recorded_at);
CREATE INDEX IF NOT EXISTS idx_shadow_scope ON shadow_comparison_log(scope_id, recorded_at);
"#;

pub const MIGRATION_STATE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS migration_state (
  migration_id TEXT PRIMARY KEY,
  source_version TEXT NOT NULL,
  target_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'paused_for_writes', 'applying', 'completed', 'failed')),
  is_applying INTEGER NOT NULL DEFAULT 0,                 -- the global flag tools check on every call
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  failed_at TIMESTAMP,
  error_message TEXT,
  initiated_by_key_hash TEXT,
  details TEXT                                            -- JSON
);

-- Singleton row representing "current migration in progress" — at most one row with is_applying=1 at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_migration_one_applying ON migration_state(is_applying) WHERE is_applying = 1;
"#;

pub const MIGRATION_SCOPE_PROGRESS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS migration_scope_progress (
  migration_id TEXT NOT NULL REFERENCES migration_state(migration_id),
  scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'applying', 'completed', 'failed')),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_message TEXT,
  PRIMARY KEY (migration_id, scope_id)
);
"#;

pub const ALL_REGISTRY_TABLES: &[&str] = &[
    SCOPES_TABLE,
    KEYS_TABLE,
    SESSION_BINDINGS_TABLE,
    SESSION_LOCKS_TABLE,
    DIGEST_QUEUE_TABLE,
    MASS_INGEST_REQUESTS_TABLE,
    MASS_INGEST_CHECKPOINTS_TABLE,
    SYS_AUDIT_LOG_TABLE,
    SYS_AUDIT_LOG_TRIGGERS,
    SHADOW_COMPARISON_LOG_TABLE,
    MIGRATION_STATE_TABLE,
    MIGRATION_SCOPE_PROGRESS_TABLE,
];

/// Helper: install the full registry schema on a fresh `scope_registry.db`. Called by:
/// - Phase 3's bootstrap flow (`aletheia-v2 setup`)
/// - Phase 8's `migrate_from_v1` orchestrator on the V2 target directory
/// Idempotent (each table uses `CREATE TABLE IF NOT EXISTS`; trigger DDL is also IF NOT EXISTS).
pub fn install_all(conn: &rusqlite::Connection) -> crate::error::Result<()> {
    for ddl in ALL_REGISTRY_TABLES {
        conn.execute_batch(ddl)?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {}", REGISTRY_USER_VERSION))?;
    Ok(())
}
```

**ATTACH connection management (`src/db/connection.rs`):**

The `ConnectionManager` opens `scope_registry.db` as `main` and lazily ATTACHes per-scope DBs based on a `PermissionSet` (computed from `claim()` in Phase 3). Multiple scopes can be attached: writable as `w_<scope_short_name>`, readonly as `r_<scope_short_name>`. `mode=ro` URI for readonly attaches.

```rust
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use crate::types::scope::{ScopeId, PermissionSet};
use crate::error::Result;

pub struct ConnectionManager {
    pub conn: Connection,
    data_dir: PathBuf,
    attached: HashMap<ScopeId, AttachedScope>,
}

#[derive(Debug)]
struct AttachedScope {
    alias: String,        // "w_hockey" or "r_system"
    writable: bool,
}

impl ConnectionManager {
    pub fn open_registry(data_dir: &Path) -> Result<Self> {
        let registry_path = data_dir.join("scope_registry.db");
        let conn = Connection::open_with_flags(
            &registry_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        crate::db::pragmas::apply(&conn)?;
        Ok(Self { conn, data_dir: data_dir.to_path_buf(), attached: HashMap::new() })
    }

    pub fn attach_for_permissions(&mut self, perms: &PermissionSet) -> Result<()> {
        for scope_id in &perms.writable_scope_ids {
            self.attach_scope(scope_id, /* writable */ true)?;
        }
        for scope_id in &perms.readonly_scope_ids {
            self.attach_scope(scope_id, /* writable */ false)?;
        }
        Ok(())
    }

    fn attach_scope(&mut self, scope_id: &ScopeId, writable: bool) -> Result<()> {
        if self.attached.contains_key(scope_id) { return Ok(()); }
        let scope_db_path = self.data_dir.join("scopes").join(format!("{}.db", scope_id.0));
        let alias = self.compute_alias(scope_id, writable);
        let uri = if writable {
            format!("file:{}", scope_db_path.display())
        } else {
            format!("file:{}?mode=ro", scope_db_path.display())
        };
        self.conn.execute(&format!("ATTACH DATABASE '{}' AS {}", uri, alias), [])?;
        if !writable {
            // Belt-and-suspenders: PRAGMA query_only on the attached schema
            self.conn.execute_batch(&format!("PRAGMA {}.query_only = ON;", alias))?;
        }
        self.attached.insert(scope_id.clone(), AttachedScope { alias, writable });
        Ok(())
    }

    fn compute_alias(&self, scope_id: &ScopeId, writable: bool) -> String {
        // Short, sanitized; pulled from scope's name in registry. For Phase 2, use "s_" + first 8 of UUID.
        let short = &scope_id.0[..8.min(scope_id.0.len())];
        format!("{}_{}", if writable { "w" } else { "r" }, short)
    }

    pub fn alias_for(&self, scope_id: &ScopeId) -> Option<&str> {
        self.attached.get(scope_id).map(|a| a.alias.as_str())
    }

    pub fn is_writable(&self, scope_id: &ScopeId) -> bool {
        self.attached.get(scope_id).map(|a| a.writable).unwrap_or(false)
    }
}
```

**PRAGMA setup (`src/db/pragmas.rs`):**

```rust
use rusqlite::Connection;
use crate::error::Result;

pub fn apply(conn: &Connection) -> Result<()> {
    conn.execute_batch(r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
    "#)?;
    Ok(())
}
```

**Audit log helpers (`src/db/audit_log.rs`):**

```rust
use rusqlite::Connection;
use serde::Serialize;
use crate::error::Result;
use crate::types::audit::AuditEventCategory;

pub fn emit_event(
    conn: &Connection,
    category: AuditEventCategory,
    event_type: &str,
    scope_id: Option<&str>,
    actor_key_hash: Option<&str>,
    subject_key_hash: Option<&str>,
    details: Option<&impl Serialize>,
) -> Result<()> {
    let pid = std::process::id();
    let hostname = hostname::get().ok().and_then(|s| s.into_string().ok()).unwrap_or_default();
    let details_json = details.map(serde_json::to_string).transpose()?;
    conn.execute(
        "INSERT INTO sys_audit_log (event_category, event_type, scope_id, actor_key_hash, subject_key_hash, pid, hostname, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![category.as_str(), event_type, scope_id, actor_key_hash, subject_key_hash, pid, hostname, details_json],
    )?;
    Ok(())
}

/// Master-key gated. Inserts unlock row, performs deletes, removes unlock row — all in one transaction.
pub fn purge_audit_log(conn: &mut Connection, older_than: chrono::DateTime<chrono::Utc>) -> Result<usize> {
    let tx = conn.transaction()?;
    tx.execute("INSERT OR REPLACE INTO _audit_log_unlock (key, value) VALUES ('unlocked', 1)", [])?;
    let rows = tx.execute("DELETE FROM sys_audit_log WHERE event_at < ?", rusqlite::params![older_than.to_rfc3339()])?;
    tx.execute("DELETE FROM _audit_log_unlock WHERE key = 'unlocked'", [])?;
    tx.commit()?;
    Ok(rows)
}
```

**Generic migration framework (`src/db/migrations/runner.rs`):**

```rust
use crate::error::Result;
use std::path::Path;

pub struct MigrationRunner<'a> {
    pub data_dir: &'a Path,
    pub current_version: u32,
    pub target_version: u32,
}

impl<'a> MigrationRunner<'a> {
    /// Phase 4 wires this to the MCP `start_migration` tool.
    /// Steps:
    /// 1. Verify master key (caller responsibility)
    /// 2. INSERT migration_state row, status='queued'
    /// 3. Set is_applying=true; broadcast OS-alert (Phase 3 hook); 30s drain
    /// 4. Iterate scopes: open writable connection per .db, apply embedded SQL scripts from current+1 to target, bump user_version, COMMIT per-scope (atomic)
    /// 5. Update migration_scope_progress row to 'completed' per scope; on failure, status='failed', is_applying remains true (safe-hold)
    /// 6. On all-scopes-completed: status='completed', is_applying=false, broadcast complete
    pub fn run(&self, dry_run: bool) -> Result<MigrationReport> { unimplemented!("runner body") }
}

pub struct MigrationReport {
    pub scopes_processed: usize,
    pub scopes_failed: usize,
    pub durations_ms: std::collections::HashMap<String, u64>,
}
```

Embedded migration scripts (`src/db/migrations/scripts.rs`) ship with the binary. V2.0.0 baseline has only the initial schema (already in `scope_schema.rs` + `registry_schema.rs`). V2.0.1+ migrations append `v2_x_to_v2_y.sql` files via `include_str!`.

```rust
// src/db/migrations/scripts.rs
pub const V2_INITIAL_SCOPE_SCHEMA: &str = include_str!("./scripts/v2_initial_scope.sql");
pub const V2_INITIAL_REGISTRY_SCHEMA: &str = include_str!("./scripts/v2_initial_registry.sql");

// Future:
// pub const V2_0_TO_V2_1: &str = include_str!("./scripts/v2_0_to_v2_1.sql");

pub fn migration_for_version(target: u32) -> Option<&'static str> {
    match target {
        1 => None,  // Initial schema is set at create time, not via migration
        // 2 => Some(V2_0_TO_V2_1),
        _ => None,
    }
}
```

<guidance>
**On `migration_state.is_applying` singleton:** The `UNIQUE INDEX ... WHERE is_applying = 1` enforces "at most one migration in progress" at the DB layer. If a stuck migration leaves is_applying=1, manual intervention via `force_unlock` is required (master-key only, audited).

**On `_audit_log_unlock` table visibility:** The unlock row exists only inside a `purge_audit_log` transaction. With WAL mode, other connections starting reads BEFORE the transaction sees the unlock row will not see it (snapshot isolation). Other connections starting reads DURING the transaction won't see the unlock row either (BEGIN IMMEDIATE on writes). The trigger fires per-row on UPDATE/DELETE, evaluating the current snapshot — safe.

**On sanitized aliases:** The `compute_alias` function in `connection.rs` uses the first 8 chars of the UUID. For Phase 2, this is sufficient; if the same 8-char prefix collides, attach will fail with a clear error. Phase 3 (auth) can refine this by using the scope's `name` from the registry where available.

**On WAL checkpointing:** Long-running readers on attached scope DBs can prevent that DB's WAL from checkpointing (truncating the -wal file). Consider running `PRAGMA wal_checkpoint(PASSIVE)` on a periodic timer in the MCP server (Phase 4) — or accept that readers naturally release on scope detach.

**On the `_audit_log_unlock` trigger pattern vs alternatives:** Considered alternatives — (a) a special `purge` user role at the DB layer (SQLite has no such concept), (b) a separate "purge connection" with no triggers (would require DETACH/re-attach cycle, fragile). The unlock-row pattern is the simplest correct solution given SQLite's trigger semantics.
</guidance>

### Integration Points
- **IS-1:** Per-scope DB schema is the contract for all data-layer consumers (Phases 5, 6, 7, 8, 9). Schema changes here cascade.
- **IS-2:** Registry schema is queried by Phases 3 (auth on `keys`/`session_bindings`/`session_locks`), 7 (`digest_queue`/`mass_ingest_*`), 9 (`shadow_comparison_log`/`sys_audit_log`). Phase 8 INSERTs into `scopes` + `keys` for V1 migration.
- **IS-8:** `MigrationRunner` is called from Phase 4's `start_migration` MCP tool. `migrate_from_v1` (Phase 8) uses the same `migration_state` table for status tracking but bypasses the runner (it's a structural shift, not DDL).
- **IS-9:** `audit_log::emit_event` is called from every phase that performs auditable actions. Event vocabulary is defined incrementally — Phase 3 emits `auth.*` and `lock.*`, Phase 5 emits `scope.*` and `key.*` mutations, Phase 7 emits `digest.*` and `mass_ingest.*`, Phase 8 emits `migration.v1_*`, Phase 9 emits `reconciliation.*` and `deprecation.*`.

### Expected Outcomes
- `cargo build` succeeds; `cargo test` passes
- A test that creates a fresh `scope_registry.db`, applies all DDL, then attempts UPDATE/DELETE on `sys_audit_log` returns `SqliteError(SQLITE_CONSTRAINT_TRIGGER, "sys_audit_log is append-only ...")`
- A test that calls `purge_audit_log` (with master-key flag) successfully deletes old audit rows
- A test that ATTACHes 5 scope DBs (mix writable + readonly) and performs reads/writes correctly: writes to `r_*` aliases fail with read-only error; writes to `w_*` aliases succeed
- A test that opens the same `scope_registry.db` from two parallel connections, both perform writes — WAL allows concurrent reads + serialized writes without `SQLITE_BUSY` (within `busy_timeout`)
- `MigrationRunner::run(dry_run=true)` for current_version=target_version returns immediately with no errors

### Testing Recommendations
- Schema round-trip: create both DBs, query `sqlite_master`, verify all tables + indexes + triggers present
- Audit log immutability: attempt UPDATE → expect ABORT; attempt DELETE → expect ABORT; perform `purge_audit_log` → succeeds
- ATTACH lifecycle: open registry, attach 3 scopes, verify aliases queryable, detach, verify aliases gone
- Readonly enforcement: attach `r_*`, attempt INSERT → expect SQLITE_READONLY error
- WAL concurrent access: spawn 2 threads, both writing to scope_registry — verify no `SQLITE_BUSY` errors, both transactions complete
- Migration framework: run a dummy migration (no-op SQL) end-to-end: queued → paused → applying → completed; verify `is_applying=0` post-success
- Migration failure path: inject a SQL error in the script, verify `is_applying` stays true, `status='failed'`, `error_message` populated; `force_unlock` test recovers
- Singleton index test: insert two rows with `is_applying=1` → second INSERT fails with UNIQUE violation
</core>
</section>
<!-- /phase:2 -->

<!-- conductor-review:2 -->
<section id="conductor-review-2">
## Conductor Review: Post-Phase 2

<core>
### Verification Checklist

<mandatory>All checklist items must be verified before proceeding.</mandatory>

- [ ] `src/db/registry_schema.rs` defines ALL 10 registry tables + audit log triggers + `_audit_log_unlock` table. **Critical: verify via grep that no later phase modifies this file (IS-2 contract).**
- [ ] `src/db/scope_schema.rs` defines `entries`, `status_sections`, `features`, `memory_journal_provenance`. **`memory_journal_provenance` MUST be present (Q5B + IS-6 V3 KG forward-compat).**
- [ ] `entries.tags` is `TEXT` (storing JSON), not a separate normalized table — V1's `tags`+`entry_tags` denormalization is intentional in V2 (per Q5)
- [ ] `entries` has `content_hash TEXT NOT NULL` and `idx_entries_content_hash` index — required for dedup in Phase 5
- [ ] `status_sections` `invalidation_reason` CHECK constraint matches Q8 exactly: `('updated', 'state_changed', 'removed')`
- [ ] `features` `state` CHECK constraint exactly matches design state machine: `('active', 'tabled', 'wrapped_up', 'abandoned')`
- [ ] `keys` table has BOTH `is_master_key` and `is_digest_key` flags with the CHECK constraint enforcing `is_digest_key=1 ⇔ digest_for_scope_id NOT NULL`
- [ ] `digest_queue.trigger_type` CHECK constraint includes ALL 8 trigger types from design (entry_threshold, time_threshold, session_end, feature_wrap, feature_init, manual, mass_ingest, retention_purge)
- [ ] `sys_audit_log.event_category` CHECK constraint includes the 8 categories from design + 'reconciliation' (added in Phase 9 audit vocabulary)
- [ ] SQLite trigger `trg_audit_log_no_update` and `trg_audit_log_no_delete` block UPDATE/DELETE on `sys_audit_log` unless the unlock row exists. **Test directly with INSERT then UPDATE attempt.**
- [ ] `purge_audit_log` test passes: inserts unlock row, deletes audit rows, removes unlock row — all atomic
- [ ] `migration_state` has the partial UNIQUE INDEX `WHERE is_applying = 1` — enforces singleton "in-progress" migration
- [ ] `ConnectionManager::open_registry` applies all PRAGMAs (WAL, synchronous=NORMAL, foreign_keys=ON, busy_timeout=5000) at open time
- [ ] ATTACH lifecycle test passes: 5 scopes attached (mix writable/readonly), aliases queryable, readonly attach prevents writes (PRAGMA query_only on attached schema)
- [ ] `audit_log::emit_event` writes a row with all expected fields (category, event_type, scope_id, actor_key_hash, pid, hostname, details JSON)
- [ ] WAL concurrent-write test passes (two parallel connections, no SQLITE_BUSY within busy_timeout)
- [ ] Migration framework dry-run works: `start_migration(target_version=current_version, dry_run=true)` returns "no migrations needed" without writing
- [ ] Run context compaction (`/lethe compact`) before Phases 3 and 4 launch

### Known Risks
- **Per-connection PRAGMA application:** PRAGMAs are connection-scoped, NOT database-scoped. If any later phase opens a fresh connection without calling `pragmas::apply()`, that connection runs in default mode (e.g., synchronous=FULL, journal_mode=DELETE on a non-WAL DB). Conductor: every later phase that opens a connection MUST call `pragmas::apply()`. Phase 4's MCP server holds the long-lived connection; Phase 8's migration tool opens fresh connections per-scope.
- **WAL file accumulation:** Long-running readers prevent WAL truncation. The MCP server (Phase 4) should periodically `PRAGMA wal_checkpoint(PASSIVE)` — recommended every 10 minutes via background task.
- **`_audit_log_unlock` collision:** If two `purge_audit_log` calls race (unlikely — master-key only), the unique PK on `key` prevents both from inserting. The second loses with a constraint error — acceptable, calling code should retry or treat as "purge already in progress."
- **Sanitized alias collisions:** First-8-chars of UUID has collision probability ~1 in 4 billion. For typical hierarchies (4-5 attaches), negligible. If detected at attach time, error is clear (`SQLITE_ERROR: ATTACH ... AS w_abc12345 — alias already in use`).
- **`is_applying` flag is per-DB, not cross-host:** If V2 ever runs on multiple machines sharing `scope_registry.db` over NFS, the flag is still authoritative (single shared DB), but heartbeats become more important. V2 design explicitly does not target multi-host migration coordination.

### Guidance for Phase 3 + Phase 4 (parallel launch)

<guidance>
**Phase 3 (Auth + Sessions) and Phase 4 (MCP Server Core + Hook Endpoint) can run in parallel** — they share no files. Both depend only on Phase 2's storage layer.

**Phase 3 sub-tasks** (5 parallel):
1. Keys (`src/auth/keys.rs`): file management at `~/.aletheia-v2/keys/<name>.key` (mode 0600) + SHA-256 hash + DB metadata insert into `keys` table
2. Session bindings (`src/auth/sessions.rs`): bind/lookup/cleanup for `session_bindings` table
3. Session locks + heartbeat (`src/auth/locks.rs`): claim/release/heartbeat-bg-task on `session_locks` table; FATAL on live conflict, orphan-recovery on stale (60s/180s defaults)
4. Claim flow (`src/auth/claim.rs`): `claim(key_value)` → SHA-256 → lookup in `keys` → return `PermissionSet`; `whoami`; `refresh_claim` (called by every write handler)
5. SessionStart hooks (`hooks/unix/sessionstart-bind.sh` + `hooks/windows/sessionstart-bind.js`): parse stdin JSON for `session_id`, write to `~/.aletheia-v2/sessions/<my_pid>.session_id` (mode 0600)

**Phase 4 sub-tasks** (4 parallel):
1. rmcp setup (`src/server/mcp.rs`): tool registration framework using `#[tool]` macros + `schemars`
2. Server lifecycle (`src/server/index.rs`): bootstrap, MCP `initialize` handshake, graceful shutdown — also establishes the **Registrar pattern** for danger-file mitigation (each later phase adds `register_X()` call here)
3. Cross-platform IPC (`src/server/transport.rs`): `interprocess` v2 wrapper for Unix sockets / Windows named pipes at `~/.aletheia-v2/sockets/aletheia-<pid>.sock` (V1 hybrid preserved)
4. HTTP endpoint server (`src/server/hook_endpoints.rs`): `/state`, `/context`, `/handoff`, `/session-info`, `/health`, `/reset-frequency` endpoints (V1 hook injection compat) — payloads in JSON (Q2)

**Coordination point between Phases 3 & 4:** The MCP server (Phase 4) needs to know about session_id discovery (Phase 3 task 5) to perform auto-reclaim on startup. Phase 4 task 2 (server lifecycle) should expose a hook function that Phase 3 task 5 can call. Recommend Phase 3 task 5 be sequenced last so Phase 4 task 2 has the receiving function ready.

Context management: Run `/lethe compact` before launching Phases 3 + 4.
</guidance>
</core>
</section>
<!-- /conductor-review:2 -->

<!-- phase:3 -->
<section id="phase-3">
## Phase 3: Auth + Sessions

<core>
### Objective
Implement the complete authentication + session-management layer: key file management with SHA-256 hashing, the multi-scope `claim()` flow returning a `PermissionSet`, `session_bindings` for `claude --resume` auto-reclaim, `session_locks` with heartbeat for concurrent-claim protection (FATAL on live conflict, orphan-recovery on stale), and the cross-platform SessionStart hook scripts that solve the missing `CLAUDE_CODE_SESSION_ID` (CC issue #41836). After Phase 3, `claim()` works end-to-end and the MCP server (Phase 4) can perform auto-reclaim.

### Prerequisites
- Phase 2 complete: `scope_registry.db` schema applied (with `keys`, `session_bindings`, `session_locks` tables); `ConnectionManager::open_registry` works
- `~/.aletheia-v2/keys/`, `~/.aletheia-v2/sessions/`, `~/.aletheia-v2/sockets/`, `~/.aletheia-v2/scopes/`, `~/.aletheia-v2/sdk-runtime/` directories created (Phase 3 task: bootstrap also creates these if missing)
- `Settings::session_locks` (heartbeat_seconds=60, stale_threshold_seconds=180) and `Settings::scopes` (session_orphan_sweep_minutes=5) defaults loaded

### Implementation

<mandatory>Raw key values (the 64-char hex strings) MUST NEVER be persisted to the database. Only `key_hash = SHA-256(raw_key_value)` is stored in `keys.key_hash`. The raw value lives only in `~/.aletheia-v2/keys/<name>.key` (file mode 0600). `claim(key_value)` hashes the input on receipt and looks up by `key_hash`. If the file is deleted, the key is unrecoverable (hash → raw is one-way).</mandatory>

<mandatory>Session locks default to 60s heartbeat / 180s stale threshold (per CEO Item 9). On new claim against an existing lock with `last_heartbeat_at > NOW - 180s`: FATAL refusal with `<error code="SESSION_LOCKED" pid=X hostname=Y>`. On stale heartbeat: orphan-recovery (UPDATE row, log `lock_orphan_recovered` audit event). Graceful shutdown DELETEs the row; crash leaves the row for recovery.</mandatory>

<mandatory>The SessionStart hook MUST write `~/.aletheia-v2/sessions/<my_pid>.session_id` as **single-line plain text** (UUID + newline only — no JSON wrapper) with file mode **0600**. The MCP server reads `~/.aletheia-v2/sessions/<my_ppid>.session_id` at startup with up to 2s polling (100ms backoff) for the race where MCP starts before hook completes. Falls back to no-auto-reclaim if not found — graceful degradation, user calls `claim(key)` explicitly.</mandatory>

**Module structure (added in Phase 3):**

```
src/
├── auth/
│   ├── mod.rs                 # Aggregator + PermissionSet re-export
│   ├── keys.rs                # Key file management, SHA-256 hashing, key creation/lookup/revocation
│   ├── sessions.rs            # session_bindings table operations (bind, lookup, sweep_orphans)
│   ├── locks.rs               # session_locks table operations (claim, release, heartbeat-bg-task, orphan-recovery)
│   ├── claim.rs               # claim() / whoami() / refresh_claim() — top-level auth flow
│   └── permissions.rs         # PermissionLevel hierarchy + canDelegate* checks
└── lib/settings/
    └── (no new submodules in Phase 3 — uses existing session_locks, scopes sections)

hooks/
├── unix/
│   └── sessionstart-bind.sh   # NEW
└── windows/
    └── sessionstart-bind.js   # NEW
```

**Key file management (`src/auth/keys.rs`):**

```rust
use std::path::{Path, PathBuf};
use std::os::unix::fs::PermissionsExt;
use sha2::{Sha256, Digest};
use rusqlite::Connection;
use crate::error::{Result, AletheiaError};
use crate::types::key::{KeyHash, KeyValue, KeyId, Permissions};
use crate::types::scope::ScopeId;

pub fn keys_dir(data_dir: &Path) -> PathBuf { data_dir.join("keys") }

pub fn key_path(data_dir: &Path, name: &str) -> PathBuf {
    keys_dir(data_dir).join(format!("{}.key", name))
}

pub fn hash_key(raw: &KeyValue) -> KeyHash {
    let mut hasher = Sha256::new();
    hasher.update(raw.0.as_bytes());
    KeyHash(hex::encode(hasher.finalize()))
}

pub fn write_key_file(path: &Path, raw: &KeyValue) -> Result<()> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    std::fs::write(path, &raw.0)?;
    #[cfg(unix)]
    {
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(path, perms)?;
    }
    // Windows: ACL hardening deferred — file lives under user profile already
    Ok(())
}

pub fn read_key_file(path: &Path) -> Result<KeyValue> {
    let content = std::fs::read_to_string(path)?;
    Ok(KeyValue(content.trim().to_string()))
}

pub fn generate_key() -> KeyValue {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);  // Add `rand = "0.8"` to deps
    KeyValue(hex::encode(buf))  // Add `hex = "0.4"` to deps
}

#[derive(Debug, Clone)]
pub struct KeyRecord {
    pub key_id: KeyId,
    pub key_hash: KeyHash,
    pub name: Option<String>,
    pub permissions: Permissions,
    pub created_by_key_id: Option<KeyId>,
    pub primary_scope_id: ScopeId,
    pub writable_scope_ids: Vec<ScopeId>,
    pub readonly_scope_ids: Vec<ScopeId>,
    pub is_master_key: bool,
    pub is_digest_key: bool,
    pub digest_for_scope_id: Option<ScopeId>,
    pub revoked_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub fn create_key(
    conn: &mut Connection,
    name: Option<&str>,
    permissions: Permissions,
    primary_scope_id: &ScopeId,
    writable_scope_ids: &[ScopeId],
    readonly_scope_ids: &[ScopeId],
    created_by_key_id: Option<&KeyId>,
) -> Result<(KeyRecord, KeyValue)> {
    let raw = generate_key();
    let key_hash = hash_key(&raw);
    let key_id = KeyId(uuid::Uuid::new_v4().to_string());
    let writable_json = serde_json::to_string(writable_scope_ids)?;
    let readonly_json = serde_json::to_string(readonly_scope_ids)?;
    conn.execute(
        "INSERT INTO keys (key_id, key_hash, name, permissions, created_by_key_id, primary_scope_id, writable_scope_ids, readonly_scope_ids, is_master_key, is_digest_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
        rusqlite::params![
            key_id.0, key_hash.0, name, permissions_str(permissions),
            created_by_key_id.map(|k| &k.0), primary_scope_id.0,
            writable_json, readonly_json,
        ],
    )?;
    let record = KeyRecord {
        key_id, key_hash, name: name.map(String::from), permissions,
        created_by_key_id: created_by_key_id.cloned(),
        primary_scope_id: primary_scope_id.clone(),
        writable_scope_ids: writable_scope_ids.to_vec(),
        readonly_scope_ids: readonly_scope_ids.to_vec(),
        is_master_key: false, is_digest_key: false, digest_for_scope_id: None,
        revoked_at: None,
    };
    Ok((record, raw))
}

pub fn lookup_by_hash(conn: &Connection, hash: &KeyHash) -> Result<Option<KeyRecord>> {
    conn.query_row(
        "SELECT key_id, key_hash, name, permissions, created_by_key_id, primary_scope_id, writable_scope_ids, readonly_scope_ids, is_master_key, is_digest_key, digest_for_scope_id, revoked_at FROM keys WHERE key_hash = ?",
        rusqlite::params![hash.0],
        |row| { /* row → KeyRecord parse */ Ok(/* ... */) }
    ).optional().map_err(Into::into)
}

fn permissions_str(p: Permissions) -> &'static str {
    match p {
        Permissions::ReadOnly => "read-only",
        Permissions::ReadWrite => "read-write",
        Permissions::CreateSubEntries => "create-sub-entries",
        Permissions::Maintenance => "maintenance",
    }
}
```

**Permission delegation enforcement (`src/auth/permissions.rs`):**

```rust
use crate::types::key::Permissions;
use crate::types::scope::ScopeId;
use crate::error::{Result, AletheiaError};

pub fn level(p: Permissions) -> u8 {
    match p {
        Permissions::ReadOnly => 0,
        Permissions::ReadWrite => 1,
        Permissions::CreateSubEntries => 2,
        Permissions::Maintenance => 3,
    }
}

pub fn can_delegate_permission(parent: Permissions, child: Permissions) -> Result<()> {
    if level(child) > level(parent) {
        return Err(AletheiaError::Auth(format!(
            "Cannot delegate {:?} from {:?} (child must be ≤ parent)",
            child, parent
        )));
    }
    Ok(())
}

pub fn can_delegate_scope(parent_scope: &ScopeId, child_scope: &ScopeId, parent_writable: &[ScopeId]) -> Result<()> {
    // Child scope must be in parent's writable_scope_ids (no upward, no lateral)
    if !parent_writable.iter().any(|s| s == child_scope) {
        return Err(AletheiaError::Scope(format!(
            "Cannot delegate scope {:?} — not in parent's writable scopes",
            child_scope
        )));
    }
    Ok(())
}
```

**Session bindings (`src/auth/sessions.rs`):**

```rust
use rusqlite::Connection;
use crate::error::Result;
use crate::types::key::KeyHash;
use crate::types::scope::ScopeId;

pub fn bind(conn: &Connection, session_id: &str, key_hash: &KeyHash, primary_scope_id: &ScopeId) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO session_bindings (session_id, key_hash, primary_scope_id, last_seen_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
        rusqlite::params![session_id, key_hash.0, primary_scope_id.0],
    )?;
    Ok(())
}

#[derive(Debug)]
pub struct SessionBinding {
    pub session_id: String,
    pub key_hash: KeyHash,
    pub primary_scope_id: ScopeId,
}

pub fn lookup(conn: &Connection, session_id: &str) -> Result<Option<SessionBinding>> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT session_id, key_hash, primary_scope_id FROM session_bindings WHERE session_id = ?",
        rusqlite::params![session_id],
        |row| Ok(SessionBinding {
            session_id: row.get(0)?,
            key_hash: KeyHash(row.get(1)?),
            primary_scope_id: ScopeId(row.get(2)?),
        }),
    ).optional().map_err(Into::into)
}

pub fn touch_last_seen(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE session_bindings SET last_seen_at = CURRENT_TIMESTAMP WHERE session_id = ?",
        rusqlite::params![session_id],
    )?;
    Ok(())
}

/// Background sweep: bindings unseen for >30 days are GC'd.
pub fn sweep_orphans(conn: &Connection, gc_after_days: u32) -> Result<usize> {
    let rows = conn.execute(
        "DELETE FROM session_bindings WHERE last_seen_at < datetime('now', ?)",
        rusqlite::params![format!("-{} days", gc_after_days)],
    )?;
    Ok(rows)
}
```

**Session locks (`src/auth/locks.rs`):**

The lock claim is the FATAL gate against split-brain. Heartbeat is a tokio task; it touches `last_heartbeat_at` every `heartbeat_seconds` (60s default). Stale-recovery happens on next claim attempt against an old lock.

```rust
use rusqlite::Connection;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{Duration, interval};
use crate::error::{Result, AletheiaError};
use crate::types::audit::AuditEventCategory;

pub struct LockHandle {
    pub session_id: String,
    pub heartbeat_task: tokio::task::JoinHandle<()>,
    /// Used by Drop to gracefully release the lock.
    conn: Arc<Mutex<Connection>>,
}

#[derive(Debug)]
pub enum LockAcquireResult {
    Acquired(LockHandle),
    /// FATAL — another live session holds this session_id
    Conflict { active_pid: i64, hostname: String, last_heartbeat: chrono::DateTime<chrono::Utc> },
}

pub async fn acquire(
    conn: Arc<Mutex<Connection>>,
    session_id: &str,
    settings: &crate::lib::settings::SessionLocksSettings,
) -> Result<LockAcquireResult> {
    let pid = std::process::id() as i64;
    let hostname = hostname::get().ok().and_then(|s| s.into_string().ok()).unwrap_or_default();
    let stale_threshold_seconds = settings.stale_threshold_seconds as i64;

    {
        let c = conn.lock().await;
        let existing: Option<(i64, String, String)> = c.query_row(
            "SELECT active_pid, hostname, last_heartbeat_at FROM session_locks WHERE session_id = ?",
            rusqlite::params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;

        match existing {
            Some((existing_pid, existing_host, last_hb_str)) => {
                let last_hb = chrono::DateTime::parse_from_rfc3339(&last_hb_str)
                    .map_err(|e| AletheiaError::Other(format!("parse last_heartbeat: {}", e)))?
                    .with_timezone(&chrono::Utc);
                let age_seconds = (chrono::Utc::now() - last_hb).num_seconds();

                if age_seconds < stale_threshold_seconds {
                    // FATAL conflict
                    crate::db::audit_log::emit_event(
                        &c, AuditEventCategory::Lock, "lock_fatal_conflict",
                        None, None, None, Some(&serde_json::json!({
                            "session_id": session_id, "active_pid": existing_pid, "hostname": existing_host
                        }))
                    )?;
                    return Ok(LockAcquireResult::Conflict {
                        active_pid: existing_pid,
                        hostname: existing_host,
                        last_heartbeat: last_hb,
                    });
                } else {
                    // Stale — orphan-recover
                    c.execute(
                        "UPDATE session_locks SET active_pid = ?, hostname = ?, claimed_at = CURRENT_TIMESTAMP, last_heartbeat_at = CURRENT_TIMESTAMP WHERE session_id = ?",
                        rusqlite::params![pid, hostname, session_id],
                    )?;
                    crate::db::audit_log::emit_event(
                        &c, AuditEventCategory::Lock, "lock_orphan_recovered",
                        None, None, None, Some(&serde_json::json!({
                            "session_id": session_id, "previous_pid": existing_pid, "previous_hostname": existing_host
                        }))
                    )?;
                }
            }
            None => {
                // Fresh acquire
                c.execute(
                    "INSERT INTO session_locks (session_id, active_pid, hostname) VALUES (?, ?, ?)",
                    rusqlite::params![session_id, pid, hostname],
                )?;
                crate::db::audit_log::emit_event(
                    &c, AuditEventCategory::Lock, "lock_acquired",
                    None, None, None, Some(&serde_json::json!({"session_id": session_id}))
                )?;
            }
        }
    }

    // Spawn heartbeat task
    let conn_for_hb = conn.clone();
    let session_id_owned = session_id.to_string();
    let interval_secs = settings.heartbeat_seconds;
    let heartbeat_task = tokio::spawn(async move {
        let mut tick = interval(Duration::from_secs(interval_secs as u64));
        loop {
            tick.tick().await;
            let c = conn_for_hb.lock().await;
            let _ = c.execute(
                "UPDATE session_locks SET last_heartbeat_at = CURRENT_TIMESTAMP WHERE session_id = ?",
                rusqlite::params![&session_id_owned],
            );
        }
    });

    Ok(LockAcquireResult::Acquired(LockHandle { session_id: session_id.to_string(), heartbeat_task, conn }))
}

impl Drop for LockHandle {
    fn drop(&mut self) {
        self.heartbeat_task.abort();
        // Best-effort sync release on drop (actual graceful release happens via async release() called from server shutdown handler)
    }
}

pub async fn release(handle: LockHandle) -> Result<()> {
    handle.heartbeat_task.abort();
    let c = handle.conn.lock().await;
    c.execute(
        "DELETE FROM session_locks WHERE session_id = ? AND active_pid = ?",
        rusqlite::params![&handle.session_id, std::process::id() as i64],
    )?;
    crate::db::audit_log::emit_event(
        &c, AuditEventCategory::Lock, "lock_released",
        None, None, None, Some(&serde_json::json!({"session_id": &handle.session_id}))
    )?;
    Ok(())
}
```

**Claim flow (`src/auth/claim.rs`):**

```rust
use std::sync::Arc;
use tokio::sync::Mutex;
use rusqlite::Connection;
use crate::error::{Result, AletheiaError};
use crate::types::key::{KeyValue, KeyHash, Permissions};
use crate::types::scope::{PermissionSet, ScopeId};
use crate::auth::keys::{self, KeyRecord};
use crate::auth::sessions;
use crate::auth::locks::{self, LockAcquireResult, LockHandle};

#[derive(Debug)]
pub struct ClaimedSession {
    pub key_record: KeyRecord,
    pub permission_set: PermissionSet,
    pub session_id: Option<String>,  // None if claim happened without a known session_id
    pub lock_handle: Option<LockHandle>,
}

pub async fn claim(
    conn: Arc<Mutex<Connection>>,
    raw_key: KeyValue,
    session_id: Option<&str>,
    settings: &crate::lib::settings::SessionLocksSettings,
) -> Result<ClaimedSession> {
    let key_hash = keys::hash_key(&raw_key);
    let record = {
        let c = conn.lock().await;
        keys::lookup_by_hash(&c, &key_hash)?
    }.ok_or_else(|| AletheiaError::Auth("Invalid key".into()))?;

    if record.revoked_at.is_some() {
        return Err(AletheiaError::Auth("Key revoked".into()));
    }

    let permission_set = PermissionSet {
        primary_scope_id: record.primary_scope_id.clone(),
        writable_scope_ids: record.writable_scope_ids.clone(),
        readonly_scope_ids: record.readonly_scope_ids.clone(),
    };

    // Bind session + acquire lock if session_id known
    let lock_handle = if let Some(sid) = session_id {
        {
            let c = conn.lock().await;
            sessions::bind(&c, sid, &key_hash, &record.primary_scope_id)?;
        }
        match locks::acquire(conn.clone(), sid, settings).await? {
            LockAcquireResult::Acquired(h) => Some(h),
            LockAcquireResult::Conflict { active_pid, hostname, last_heartbeat } => {
                return Err(AletheiaError::Auth(format!(
                    "Session {} already active in PID {} on host {} (last heartbeat: {}). Launch a new session with `claude`, or terminate the existing one first.",
                    sid, active_pid, hostname, last_heartbeat
                )));
            }
        }
    } else { None };

    {
        let c = conn.lock().await;
        crate::db::audit_log::emit_event(
            &c, crate::types::audit::AuditEventCategory::Auth, "claim",
            Some(&record.primary_scope_id.0), Some(&key_hash.0), None,
            Some(&serde_json::json!({"session_id": session_id}))
        )?;
    }

    Ok(ClaimedSession {
        key_record: record,
        permission_set,
        session_id: session_id.map(String::from),
        lock_handle,
    })
}

pub async fn refresh_claim(conn: Arc<Mutex<Connection>>, key_hash: &KeyHash) -> Result<KeyRecord> {
    let c = conn.lock().await;
    keys::lookup_by_hash(&c, key_hash)?
        .filter(|r| r.revoked_at.is_none())
        .ok_or_else(|| AletheiaError::Auth("Key revoked or invalid".into()))
}
```

**SessionStart hook scripts:**

`hooks/unix/sessionstart-bind.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
# Read JSON from stdin; extract session_id; write to ~/.aletheia-v2/sessions/<my_pid>.session_id
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
if [ -z "$SESSION_ID" ]; then
  exit 0  # Silently no-op if session_id missing (graceful degradation)
fi
SESSIONS_DIR="${ALETHEIA_DATA_DIR:-$HOME/.aletheia-v2}/sessions"
mkdir -p "$SESSIONS_DIR"
chmod 700 "$SESSIONS_DIR" 2>/dev/null || true
TARGET="$SESSIONS_DIR/$$.session_id"
echo "$SESSION_ID" > "$TARGET"
chmod 600 "$TARGET"
exit 0
```

`hooks/windows/sessionstart-bind.js`:

```javascript
#!/usr/bin/env node
// Cross-platform Windows equivalent: read stdin JSON, write per-PPID file
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let buf = '';
process.stdin.on('data', c => { buf += c; });
process.stdin.on('end', () => {
  let sessionId;
  try { sessionId = JSON.parse(buf).session_id; } catch { return; }
  if (!sessionId) return;
  const dataDir = process.env.ALETHEIA_DATA_DIR || path.join(os.homedir(), '.aletheia-v2');
  const sessionsDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const target = path.join(sessionsDir, `${process.pid}.session_id`);
  fs.writeFileSync(target, sessionId + '\n', { mode: 0o600 });
});
```

**MCP server-side session_id discovery (called by Phase 4 server startup):**

```rust
// src/auth/sessions.rs — additional helper
pub async fn discover_session_id_via_ppid(data_dir: &std::path::Path, max_wait_ms: u64) -> Option<String> {
    let ppid = nix::unistd::getppid().as_raw();  // Add `nix = "0.27"` for Unix; Windows uses winapi
    let path = data_dir.join("sessions").join(format!("{}.session_id", ppid));
    let start = std::time::Instant::now();
    loop {
        if let Ok(content) = std::fs::read_to_string(&path) {
            return Some(content.trim().to_string());
        }
        if start.elapsed().as_millis() as u64 >= max_wait_ms { return None; }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// Background sweep: prune sessions/<pid>.session_id files where the PID no longer exists.
pub fn sweep_session_id_orphans(data_dir: &std::path::Path) -> Result<usize> {
    let dir = data_dir.join("sessions");
    if !dir.exists() { return Ok(0); }
    let mut removed = 0;
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if let Some(pid_str) = name_str.strip_suffix(".session_id") {
            if let Ok(pid) = pid_str.parse::<i32>() {
                if !pid_alive(pid) {
                    std::fs::remove_file(entry.path())?;
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}

#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
}
#[cfg(windows)]
fn pid_alive(_pid: i32) -> bool { /* OpenProcess + GetExitCodeProcess pattern */ true }
```

<guidance>
**On the SessionStart hook race:** The hook fires BEFORE the MCP server starts (it's a CC `SessionStart` event, dispatched by CC at session boot). The MCP server is also spawned at session boot via the user's MCP config. There's a race between "hook completes writing the file" and "MCP server starts reading the file." The 2s polling window with 100ms backoff (20 attempts) tolerates the race. If the hook never runs (e.g., user hasn't installed it via `aletheia-v2 setup`), discovery returns None and the session falls back to explicit `claim(key)` — the user just sees a slightly degraded UX (no auto-reclaim until next `--resume`).

**On Windows PID checks:** The `pid_alive` function uses `OpenProcess` + `GetExitCodeProcess` (returns STILL_ACTIVE). Use the `windows-sys` crate or `windows` crate; the exact dependency choice is a Phase 3 sub-task implementation detail.

**On `LockHandle` Drop semantics:** `Drop` aborts the heartbeat task but does NOT delete the lock row — that requires async + a connection. The `release()` function is the graceful path called from the server's shutdown handler. If the server crashes (no Drop, no release call), the lock row sits with stale heartbeat; next claim orphan-recovers. This is the intended design.

**On audit-log dependency for write paths:** Every `audit_log::emit_event` call writes to `scope_registry.db`. The `claim()` function takes a `Connection` reference — that's the registry connection. Phase 4's server lifecycle holds this connection long-lived.

**On master key and bootstrap:** Phase 3 includes the `bootstrap` MCP tool (creates a master key for first-run setup). The master key is generated via `generate_key()`, written to `~/.aletheia-v2/keys/master.key` (mode 0600), inserted into `keys` with `is_master_key=1`. The user records the value and DELETES the file (or leaves it for solo use). The CLI subcommand `aletheia-v2 setup` is the alternative interface for first-run.
</guidance>

### Integration Points
- **IS-3:** `claim()` returns `ClaimedSession` containing `permission_set: PermissionSet`. Every Phase 5 write handler must call `permission_set.contains_writable(&target_scope)` before performing writes. Read handlers check both writable and readonly sets.
- **IS-9:** `audit_log::emit_event` is called from every claim, every key creation/modification, every lock transition. Audit vocabulary established here:
  - `auth.claim`, `auth.whoami`, `auth.auto_reclaim`, `auth.claim_rejected`
  - `lock.lock_acquired`, `lock.lock_released`, `lock.lock_orphan_recovered`, `lock.lock_fatal_conflict`, `lock.heartbeat_stolen`
  - `key.key_issued`, `key.key_modified`, `key.key_rotated`, `key.digest_key_created`
- **Phase 4 coordination:** The MCP server's startup calls `sessions::discover_session_id_via_ppid()` then `claim(key_value, Some(session_id))` (key_value loaded from key file specified in env or config). Server shutdown calls `locks::release(lock_handle)` from a graceful-shutdown signal handler.
- **Phase 8 (V1→V2 migration):** Migration tool inserts records into `keys` table preserving V1 key UUIDs as `key_id`, computing `key_hash` from V1 raw key values read from `~/.aletheia-v2/keys/<name>.key` files. V1's revoked-flag column maps directly to V2's `revoked_at` (timestamp NOW for V1's `revoked=1` rows; NULL otherwise).

### Expected Outcomes
- `cargo test` passes for all auth modules
- Generating a key, writing to file (mode 0600 verified), reading back, hashing, looking up by hash — full round-trip succeeds
- `claim(valid_key, Some("test-session-id"))` succeeds; `claim(invalid_key, _)` returns `Auth("Invalid key")`; `claim(revoked_key, _)` returns `Auth("Key revoked")`
- Concurrent-claim test: two `claim()` calls with the same `session_id` from different process IDs — second receives `LockAcquireResult::Conflict`
- Stale-claim recovery: insert lock row with `last_heartbeat_at = NOW - 200s`, call `claim()` — succeeds with `lock_orphan_recovered` audit event
- Heartbeat task test: acquire lock, wait 65s, verify `last_heartbeat_at` updated within ±5s tolerance
- SessionStart hook test (Unix): pipe JSON `{"session_id": "abc"}` to `sessionstart-bind.sh`, verify `~/.aletheia-v2/sessions/<pid>.session_id` exists, contains "abc\n", mode 0600
- `discover_session_id_via_ppid()` test: write a fake `<test_ppid>.session_id` file, call discovery, verify returns the session_id; rename file, call discovery — returns None after 2s
- `sweep_session_id_orphans()` test: create 3 session_id files (1 with current PID, 2 with bogus), call sweep, verify 2 removed

### Testing Recommendations
- Unit test SHA-256 hashing matches a known fixture (RFC 6234 test vector)
- Integration test the full claim flow: create scope → create key in scope → write key file → claim with file's contents → verify PermissionSet matches
- Integration test session_bindings round-trip: bind → lookup → touch_last_seen → sweep_orphans (with future date) → lookup returns None
- Integration test the FATAL conflict path: two parallel `claim()` calls — exactly one wins, the other returns Conflict with correct PID/hostname info
- Integration test the orphan-recovery path: insert stale lock manually, claim, verify takeover + audit log entry
- E2E test SessionStart hook → MCP server discovery: spawn `sessionstart-bind.sh` as subprocess with stdin pipe, then call `discover_session_id_via_ppid` with the subprocess's pid as ppid (mock), verify discovery returns the session_id
- Permission delegation tests: `can_delegate_permission(Maintenance, ReadWrite)` succeeds; `can_delegate_permission(ReadWrite, Maintenance)` fails
</core>
</section>
<!-- /phase:3 -->

<!-- conductor-review:3 -->
<section id="conductor-review-3">
## Conductor Review: Post-Phase 3

<core>
### Verification Checklist

<mandatory>All checklist items must be verified before proceeding.</mandatory>

- [ ] `~/.aletheia-v2/keys/<name>.key` files have mode 0600 (verified via `stat -c "%a"` on Unix)
- [ ] `keys.key_hash` is the SHA-256 of the raw key value (verified by hashing a known key value and matching the column)
- [ ] **Raw key value NEVER appears in `keys` table** — grep `src/auth/` for any INSERT or UPDATE that includes `raw.0` going into `keys.key_value` or similar (must be absent)
- [ ] `claim(invalid_key)` returns `Auth("Invalid key")` not a panic
- [ ] `claim(revoked_key)` returns `Auth("Key revoked")` after the row's `revoked_at` is set
- [ ] FATAL session-lock conflict test: parallel claims with same session_id from different PIDs — second returns Conflict
- [ ] Stale-lock recovery test: lock with `last_heartbeat_at = NOW - 200s`, new claim succeeds + emits `lock_orphan_recovered` audit event
- [ ] Heartbeat task updates `last_heartbeat_at` every 60s ±5s (default `heartbeat_seconds`)
- [ ] `LockHandle::release()` (graceful) deletes the lock row + emits `lock_released` audit event
- [ ] `LockHandle::Drop` aborts heartbeat task without deleting row (intentional — crash semantic)
- [ ] SessionStart hook (`hooks/unix/sessionstart-bind.sh`) is executable (mode 0755) and parses JSON stdin correctly
- [ ] SessionStart hook writes `~/.aletheia-v2/sessions/<pid>.session_id` with mode 0600, single-line UUID + newline (NO JSON wrapper)
- [ ] `discover_session_id_via_ppid` returns the session_id within 2s when the file exists; returns None after 2s polling timeout if absent
- [ ] `sweep_session_id_orphans` removes files for non-existent PIDs without error
- [ ] Audit log entries written for: `auth.claim`, `lock.lock_acquired`, `lock.lock_released`, `lock.lock_fatal_conflict`, `lock.lock_orphan_recovered` (verify by query against `sys_audit_log`)
- [ ] Permission delegation tests pass: child level ≤ parent succeeds, child level > parent errors
- [ ] Run context compaction (`/lethe compact`) before launching Phase 5 (which heavily depends on this auth flow)

### Known Risks
- **Hook installation is user-managed:** The `aletheia-v2 setup` CLI subcommand is responsible for adding the SessionStart hook entry to the user's `~/.claude/settings.json`. If the user installs Aletheia via npm but doesn't run `setup`, hooks aren't registered → no SessionStart event → no auto-reclaim. Document in install instructions (Phase 10).
- **CC `SessionStart` JSON schema stability:** The hook script parses `session_id` from a CC-controlled JSON shape. If CC changes the field name, the hook silently no-ops (graceful degradation, but auto-reclaim breaks). Phase 9's reconciliation can include a "SessionStart hook health" check.
- **Heartbeat task lifecycle vs server shutdown:** If the server's tokio runtime drops before `release()` is called, `Drop` aborts the heartbeat but doesn't release the row. Recommend explicit `release()` from a `tokio::signal::ctrl_c()` handler in Phase 4's server lifecycle.
- **Multi-host clock skew:** `session_locks.last_heartbeat_at` uses `CURRENT_TIMESTAMP` from the DB host (the writer). If two MCP servers are on different machines with skewed clocks, stale-detection becomes inaccurate. V2 default 60s/180s tolerates ~30s skew; document this in operational notes.
- **`refresh_claim` cost:** Every write handler calls this (per IS-3 contract). With ~5 active sessions × frequent writes, that's many SELECTs per second on the `keys` table. Use the `idx_keys_hash` index — already in Phase 2 schema. Profile early.

### Guidance for Phase 5

<guidance>
Phase 5 (Tools) is the largest phase by tool count. Auth integration is the gating contract: every write tool needs `refresh_claim` + scope check before performing any DB write. Recommend Phase 5's tool sub-tasks all consume a shared `AuthContext` struct (built from `ClaimedSession`) so the auth check is a single method call per handler.

The `audit_log::emit_event` vocabulary established here in Phase 3 will be extended in Phase 5 (`scope.*`, `key.*` mutations) and Phase 7 (`digest.*`, `mass_ingest.*`). Make the `AuditEventCategory` and `event_type` literals into constants in `src/types/audit.rs` so typos surface at compile time.

The `bootstrap` and `setup` flows (CLI subcommand vs MCP tool) overlap. Recommend: CLI `aletheia-v2 setup` does first-run installer (creates dirs, generates settings.toml from defaults, writes hook config to `~/.claude/settings.json`, mints master key). MCP `bootstrap(name)` (called from inside a session) creates a NAMED sub-key + scope (carried over from V1 semantics).
</guidance>
</core>
</section>
<!-- /conductor-review:3 -->

<!-- phase:4 -->
<section id="phase-4">
## Phase 4: MCP Server Core + Hook Endpoint

<core>
### Objective
Stand up the MCP server core: `rmcp` setup with `#[tool]` macro infrastructure, server lifecycle (init, MCP `initialize` handshake, graceful shutdown), cross-platform IPC via `interprocess` v2 for Unix sockets / Windows named pipes (preserves V1's hook injection mechanism), and the HTTP endpoint server providing `/state`, `/context`, `/handoff`, `/session-info`, `/health`, `/reset-frequency` (V1 hybrid preserved). After Phase 4, the MCP server starts, accepts MCP clients, and serves hook injection requests on its socket — but has zero tools registered yet (Phase 5 fills the tool surface).

### Prerequisites
- Phase 1 complete: types, error, settings, basic CLI scaffolding
- Phase 2 complete: `ConnectionManager`, all schemas, audit log infrastructure
- (Parallel with Phase 3) — Phase 4 tasks 1, 3, 4 do not depend on Phase 3; only task 2 (server lifecycle) needs Phase 3's `claim()` for auto-reclaim. Sequence Phase 3 task 5 (SessionStart hook) and Phase 4 task 2 (server lifecycle) jointly.

### Implementation

<mandatory>The MCP server uses **stdio transport** for the MCP protocol. ALL logging MUST go to **stderr** (via `tracing-subscriber` configured for stderr only). ANY write to stdout outside of the rmcp protocol corrupts JSON-RPC and breaks the MCP client connection. This applies to all subsequent phases as well — they must not `println!` or otherwise write to stdout from server code.</mandatory>

<mandatory>The server lifecycle establishes the **Registrar pattern** for the danger file `src/server/index.rs`. Each later phase that needs to add a startup hook (background poller, auto-reclaim, reconciler invocation, etc.) defines its own `register_X(registry: &mut ServerRegistry)` function in its own module. `index.rs` calls them in a fixed order. NO later phase modifies the body of `start_server()` directly — only the call list.</mandatory>

<mandatory>The hook endpoint server returns **JSON** payloads (Q2). Endpoints: `GET /state` (L1), `GET /context` (L2), `GET /handoff` (peek non-consuming), `GET /session-info`, `GET /health`, `POST /reset-frequency`. Path-based routing; no auth (Unix socket file mode 0600 + single-pid sockets provide isolation). The L1/L2 builder logic ships in Phase 6 — Phase 4 stubs the endpoints with `{}` responses.</mandatory>

**Module structure (added in Phase 4):**

```
src/
├── server/
│   ├── mod.rs                 # Re-exports
│   ├── index.rs               # ⚠ DANGER FILE — Registrar pattern; start_server()
│   ├── mcp.rs                 # rmcp setup, tool registration framework, MCP handshake
│   ├── transport.rs           # interprocess wrapper for Unix sockets / Windows named pipes
│   ├── hook_endpoints.rs      # HTTP endpoint server (V1 hybrid) — /state /context /handoff /session-info /health /reset-frequency
│   ├── tools/
│   │   └── mod.rs             # Stubs all tool category modules (filled in Phase 5)
│   ├── response_format.rs     # XML-attribute response struct + serializer (visible-dedup principle)
│   └── shutdown.rs            # Graceful shutdown signal handler (SIGINT/SIGTERM → release lock + flush audit log)
```

**Server lifecycle (`src/server/index.rs`) — Registrar pattern:**

```rust
use std::sync::Arc;
use tokio::sync::Mutex;
use rusqlite::Connection;
use crate::error::Result;
use crate::lib::settings::Settings;
use crate::auth::claim::ClaimedSession;

/// Registry of background tasks + lifecycle hooks. Each later phase adds itself here.
pub struct ServerRegistry {
    pub background_tasks: Vec<tokio::task::JoinHandle<()>>,
    pub shutdown_hooks: Vec<Box<dyn FnOnce() + Send>>,
}

impl ServerRegistry {
    pub fn new() -> Self { Self { background_tasks: vec![], shutdown_hooks: vec![] } }
    pub fn spawn_bg(&mut self, name: &str, fut: impl std::future::Future<Output = ()> + Send + 'static) {
        tracing::info!(target: "server.registrar", "spawning bg task: {}", name);
        self.background_tasks.push(tokio::spawn(fut));
    }
}

pub async fn start_server(settings: Settings, data_dir: std::path::PathBuf) -> Result<()> {
    // 1. Open registry connection (Phase 2)
    let conn = Arc::new(Mutex::new(crate::db::ConnectionManager::open_registry(&data_dir)?.conn));

    // 2. Discover session_id (Phase 3 — graceful degradation if missing)
    let session_id = crate::auth::sessions::discover_session_id_via_ppid(&data_dir, 2000).await;

    // 3. Auto-reclaim if possible (Phase 3)
    let claimed = if let Some(sid) = session_id.as_deref() {
        let binding = { let c = conn.lock().await; crate::auth::sessions::lookup(&c, sid)? };
        if let Some(b) = binding {
            let key_path = crate::auth::keys::key_path(&data_dir, &binding_name_for(&b));
            if let Ok(raw) = crate::auth::keys::read_key_file(&key_path) {
                Some(crate::auth::claim::claim(conn.clone(), raw, Some(sid), &settings.session_locks).await?)
            } else { None }
        } else { None }
    } else { None };

    // 4. Build registrar + register all hooks
    let mut registry = ServerRegistry::new();

    // Phase 4 own registrations
    register_hook_endpoint_server(&mut registry, conn.clone(), data_dir.clone(), settings.clone(), claimed.as_ref()).await?;

    // Phases 5-9 add their register_X calls here:
    // register_tool_surface(&mut registry, ...)?;             // Phase 5
    // register_injection_pipeline(&mut registry, ...)?;       // Phase 6
    // register_digest_queue_poller(&mut registry, ...)?;      // Phase 7
    // register_mass_ingest_poller(&mut registry, ...)?;       // Phase 7
    // register_reconciler_sweep(&mut registry, ...)?;         // Phase 9
    // register_session_orphan_sweep(&mut registry, ...)?;     // Phase 9
    // register_sdk_runtime_cleanup(&mut registry, ...)?;      // Phase 9

    // 5. Start MCP server (rmcp on stdio); blocks until client disconnect
    let mcp_handle = tokio::spawn(crate::server::mcp::run_mcp_stdio(conn.clone(), settings.clone(), claimed));

    // 6. Wait for shutdown signal
    crate::server::shutdown::wait_for_shutdown_signal().await;

    // 7. Graceful release: abort bg tasks, release lock, flush
    for task in registry.background_tasks { task.abort(); }
    for hook in registry.shutdown_hooks { hook(); }
    mcp_handle.abort();
    Ok(())
}

async fn register_hook_endpoint_server(
    registry: &mut ServerRegistry,
    conn: Arc<Mutex<Connection>>,
    data_dir: std::path::PathBuf,
    settings: Settings,
    claimed: Option<&ClaimedSession>,
) -> Result<()> {
    let session_state = build_session_state(claimed);
    let server_handle = crate::server::hook_endpoints::start(conn, data_dir, settings, session_state).await?;
    registry.spawn_bg("hook-endpoint-server", async move {
        let _ = server_handle.await;  // run until externally aborted
    });
    Ok(())
}

fn binding_name_for(_b: &crate::auth::sessions::SessionBinding) -> String {
    // Convention: name == primary_scope's name. Phase 3 task 1 (keys) provides the lookup.
    todo!("Phase 3 task 1 — lookup keys.name by key_hash")
}

fn build_session_state(_claimed: Option<&ClaimedSession>) -> crate::server::hook_endpoints::SessionState {
    todo!("Phase 4 task 4 — build SessionState struct from ClaimedSession")
}
```

**rmcp tool registration framework (`src/server/mcp.rs`):**

```rust
use rmcp::{ServerHandler, ServiceExt, tool};
use std::sync::Arc;
use tokio::sync::Mutex;
use rusqlite::Connection;
use crate::lib::settings::Settings;
use crate::auth::claim::ClaimedSession;
use crate::error::Result;

/// The MCP server handler — Phase 5 fills in tool implementations via `#[tool]` macros on this impl block.
pub struct AletheiaServer {
    pub conn: Arc<Mutex<Connection>>,
    pub settings: Settings,
    pub claimed: Arc<Mutex<Option<ClaimedSession>>>,
    pub data_dir: std::path::PathBuf,
}

#[tool(tool_box)]
impl AletheiaServer {
    // Phase 5 fills these in:
    // #[tool(description = "Authenticate session with a key")]
    // async fn claim(&self, params: ClaimParams) -> Result<XmlResponse> { ... }
    // ... (25+ tools)
}

impl ServerHandler for AletheiaServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo {
            protocol_version: rmcp::model::ProtocolVersion::default(),
            capabilities: rmcp::model::ServerCapabilities::builder().enable_tools().build(),
            server_info: rmcp::model::Implementation {
                name: "aletheia-v2".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            instructions: Some("Aletheia V2 — structured memory MCP server".into()),
        }
    }
}

pub async fn run_mcp_stdio(
    conn: Arc<Mutex<Connection>>,
    settings: Settings,
    claimed: Option<ClaimedSession>,
) -> Result<()> {
    let server = AletheiaServer {
        conn,
        settings,
        claimed: Arc::new(Mutex::new(claimed)),
        data_dir: dirs::home_dir().unwrap().join(".aletheia-v2"),  // simplified
    };
    let service = server.serve(rmcp::transport::stdio()).await
        .map_err(|e| crate::error::AletheiaError::Other(format!("MCP serve: {}", e)))?;
    service.waiting().await
        .map_err(|e| crate::error::AletheiaError::Other(format!("MCP wait: {}", e)))?;
    Ok(())
}
```

**Cross-platform IPC (`src/server/transport.rs`):**

```rust
use interprocess::local_socket::{tokio::Stream, ToFsName, GenericFilePath};
use crate::error::Result;
use std::path::{Path, PathBuf};

pub fn socket_path(data_dir: &Path) -> PathBuf {
    let pid = std::process::id();
    data_dir.join("sockets").join(format!("aletheia-v2-{}.sock", pid))
}

/// Bind a Unix socket / Windows named pipe at the per-PID path. Cleans up stale files first.
pub async fn bind_listener(data_dir: &Path) -> Result<interprocess::local_socket::tokio::Listener> {
    use interprocess::local_socket::{tokio::ListenerOptions, ListenerNonblockingMode, traits::tokio::Listener};
    let path = socket_path(data_dir);
    if path.exists() { let _ = std::fs::remove_file(&path); }
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }

    let name = path.as_os_str().to_fs_name::<GenericFilePath>()
        .map_err(|e| crate::error::AletheiaError::Other(format!("socket name: {}", e)))?;
    let listener = ListenerOptions::new()
        .name(name)
        .nonblocking(ListenerNonblockingMode::Both)
        .create_tokio()
        .map_err(|e| crate::error::AletheiaError::Io(e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms)?;
    }

    // Write per-session pointer file (V1 compat): claude-<PPID>.sock.path → actual socket path
    let ppid = nix::unistd::getppid().as_raw();
    let pointer = data_dir.join("sockets").join(format!("claude-{}.sock.path", ppid));
    std::fs::write(&pointer, path.to_string_lossy().as_bytes())?;

    Ok(listener)
}
```

**HTTP endpoint server (`src/server/hook_endpoints.rs`):**

The endpoint server runs over the Unix socket / named pipe. Use `hyper` directly on top of the `interprocess` listener (no need for a full HTTP framework). Phase 6 fills in the actual L1/L2 payload builders; Phase 4 stubs the endpoints.

```rust
use std::sync::Arc;
use tokio::sync::Mutex;
use rusqlite::Connection;
use crate::error::Result;
use crate::lib::settings::Settings;
use crate::auth::claim::ClaimedSession;

#[derive(Clone)]
pub struct SessionState {
    pub claimed_key_hash: Option<String>,
    pub primary_scope_id: Option<String>,
    pub call_count: Arc<std::sync::atomic::AtomicU64>,
    pub access_counts: Arc<Mutex<std::collections::HashMap<String, u64>>>,
}

pub async fn start(
    conn: Arc<Mutex<Connection>>,
    data_dir: std::path::PathBuf,
    settings: Settings,
    session_state: SessionState,
) -> Result<tokio::task::JoinHandle<Result<()>>> {
    let listener = crate::server::transport::bind_listener(&data_dir).await?;

    let handle = tokio::spawn(async move {
        loop {
            use interprocess::local_socket::traits::tokio::Listener;
            let stream = listener.accept().await.map_err(crate::error::AletheiaError::Io)?;
            let conn_clone = conn.clone();
            let settings_clone = settings.clone();
            let state_clone = session_state.clone();
            tokio::spawn(async move {
                let _ = handle_connection(stream, conn_clone, settings_clone, state_clone).await;
            });
        }
    });
    Ok(handle)
}

async fn handle_connection(
    mut stream: interprocess::local_socket::tokio::Stream,
    _conn: Arc<Mutex<Connection>>,
    _settings: Settings,
    state: SessionState,
) -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Minimal HTTP parsing: extract first line "GET /path HTTP/1.1"
    let path = request.lines().next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");

    let body = match path {
        "/health" => serde_json::json!({"status": "ok", "pid": std::process::id()}).to_string(),
        "/state" | "/context" | "/handoff" => {
            // Phase 6 fills in the real builder calls
            "{}".to_string()
        }
        "/session-info" => serde_json::json!({
            "claimed": state.claimed_key_hash.is_some(),
            "primary_scope_id": state.primary_scope_id,
            "pid": std::process::id(),
        }).to_string(),
        "/reset-frequency" => {
            state.call_count.store(0, std::sync::atomic::Ordering::SeqCst);
            "{}".to_string()
        }
        _ => "{}".to_string(),
    };

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(), body
    );
    stream.write_all(response.as_bytes()).await?;
    Ok(())
}
```

**Response format helpers (`src/server/response_format.rs`):**

V2 tool responses follow V1's XML-attribute convention. `<entry id="..." scope="..." routing="..."/>` etc. The visible-dedup principle requires every server-side deviation to surface in the response — write_routing/dedup/auto-table notices.

```rust
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct XmlElement {
    pub tag: String,
    pub attrs: BTreeMap<String, String>,
    pub children: Vec<XmlElement>,
    pub text: Option<String>,
}

impl XmlElement {
    pub fn new(tag: impl Into<String>) -> Self {
        Self { tag: tag.into(), attrs: BTreeMap::new(), children: vec![], text: None }
    }
    pub fn attr(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.attrs.insert(key.into(), value.into()); self
    }
    pub fn child(mut self, child: XmlElement) -> Self { self.children.push(child); self }
    pub fn text(mut self, t: impl Into<String>) -> Self { self.text = Some(t.into()); self }

    pub fn to_string(&self) -> String {
        // Standard XML serialization with attribute ordering preserved (BTreeMap → alphabetical)
        // ... (implementation detail)
        unimplemented!()
    }
}
```

**Graceful shutdown (`src/server/shutdown.rs`):**

```rust
pub async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).unwrap();
        let mut sigint = signal(SignalKind::interrupt()).unwrap();
        tokio::select! {
            _ = sigterm.recv() => tracing::info!("SIGTERM received"),
            _ = sigint.recv() => tracing::info!("SIGINT received"),
        }
    }
    #[cfg(windows)]
    {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("Ctrl+C received");
    }
}
```

<guidance>
**On stdio purity:** Rust's `println!`, `eprintln!`, `dbg!`, `print!` all write to stdout/stderr. Establish in CI a check (`cargo clippy` lint or grep) that production code under `src/server/` doesn't use `println!` or `print!`. `eprintln!` to stderr is OK but prefer `tracing::*` macros.

**On hyper vs handcrafted HTTP:** The endpoint server's HTTP parsing in the example above is intentionally minimal (single-line GET). For a few well-known endpoints, this is fine. If complexity grows (POST bodies, query strings beyond paths), pull in `hyper` (workspace dep) and use it over `interprocess`'s listener via a custom `Service`.

**On the per-cwd socket pointer file:** V1 writes `~/.aletheia-v2/sockets/claude-<PPID>.sock.path` so hooks can find the socket without scanning. V2 preserves this convention. The hook scripts (Phase 6) read the pointer file → actual socket path → curl --unix-socket.

**On rmcp `#[tool]` macro evolution:** rmcp 1.5.x's macro signature has been changing. The example above uses `#[tool(tool_box)]` on the impl block + `#[tool(description = "...")]` on each function. Verify against the rmcp version pinned in Cargo.toml at implementation time; if the macro API has changed, adapt — the pattern is well-documented in rmcp examples.

**On Registrar pattern enforcement:** Encourage discipline by making `start_server()` LONG (with the registrar calls listed inline as comments) and having Phase 5-9 sub-tasks UNCOMMENT their line + define the function. Merging is trivial because each phase's UNCOMMENT is a different line. If two phases need to add lines, the order in the file determines startup order — document this convention.
</guidance>

### Integration Points
- **IS-4 (rmcp tool registration framework):** `AletheiaServer` impl block in `src/server/mcp.rs` is the home for all tool definitions added in Phase 5. Phase 5 sub-tasks each add `#[tool]` methods to this impl, organized by category (auth, entry, status, discovery, handoff, system, features, time-travel, promote, active-context).
- **IS-5 (hook endpoint server):** Endpoint stubs in `hook_endpoints.rs` return `{}`; Phase 6 replaces stubs with real L1/L2 builder invocations. The hook scripts (Phase 6) consume the JSON payloads produced by these endpoints.
- **Integration with Phase 3:** Server lifecycle calls `claim()` from Phase 3. The `ClaimedSession` returned holds the `LockHandle` whose graceful release is invoked from `shutdown.rs`. Phase 3's `discover_session_id_via_ppid` is called as the second step of `start_server()`.
- **Integration with Phase 7:** Phase 7's `digest_queue` background poller is registered via `register_digest_queue_poller(&mut registry, ...)` in `start_server()`. Phase 7 adds the `register_digest_queue_poller` function to its module; uncommenting the call line in `start_server()` activates it.
- **Integration with Phase 9:** Same pattern for reconciler sweep, session_id orphan sweep, sdk-runtime cleanup, and Shadow Mode sampling-hook initialization.

### Expected Outcomes
- `cargo build` succeeds; `cargo test` passes
- `aletheia-v2 serve` starts the MCP server; `claude` CLI configured to use it can connect, perform `tools/list` MCP request, get back `{ "tools": [] }` (empty — Phase 5 fills this in)
- A `curl --unix-socket ~/.aletheia-v2/sockets/aletheia-<pid>.sock http://localhost/health` returns `{"status":"ok","pid":<pid>}`
- `curl --unix-socket ... http://localhost/state` returns `{}` (stub)
- SIGTERM to the server triggers shutdown handler; lock row deleted from `session_locks`; pointer file removed
- `tracing` output goes to stderr; stdout shows ONLY MCP protocol JSON-RPC frames
- Server starts even if no `~/.aletheia-v2/sessions/<my_ppid>.session_id` exists (graceful degradation — `claimed = None`, but server runs and accepts MCP)

### Testing Recommendations
- E2E test: spawn `aletheia-v2 serve` as subprocess; connect with a minimal MCP client (rmcp's client API or a TypeScript MCP client); verify `tools/list` returns empty list
- Hook endpoint tests: bind socket, curl each endpoint, verify JSON shape
- Stdio purity test: capture stdout during a server lifecycle that exercises every code path (claim, lock, audit log writes); verify stdout contains ONLY valid MCP JSON-RPC frames (no garbage)
- Shutdown handler test: spawn server, send SIGTERM, verify lock row is deleted within 5s
- Registrar pattern test: write a unit test that stubs `register_X` calls and verifies they're invoked in the documented order
- Per-PID socket cleanup: start server, kill it, restart — verify stale socket file is removed before bind
- Pointer file written and removed correctly across server restart
</core>
</section>
<!-- /phase:4 -->

<!-- conductor-review:4 -->
<section id="conductor-review-4">
## Conductor Review: Post-Phase 4

<core>
### Verification Checklist

<mandatory>All checklist items must be verified before proceeding.</mandatory>

- [ ] `cargo build` succeeds; `cargo test` passes for all server modules
- [ ] `tracing-subscriber` configured to write **stderr only**; stdout used exclusively by rmcp protocol
- [ ] Grep `src/server/` for `println!`, `print!`, `dbg!` — all absent (would corrupt MCP stdio JSON-RPC)
- [ ] `aletheia-v2 serve` starts and accepts MCP client connections
- [ ] MCP `tools/list` returns empty list (Phase 5 fills in)
- [ ] Hook endpoint server binds at `~/.aletheia-v2/sockets/aletheia-<pid>.sock` with mode 0600
- [ ] Per-PID pointer file `~/.aletheia-v2/sockets/claude-<PPID>.sock.path` written with the actual socket path (V1 hook compat)
- [ ] `curl --unix-socket ... http://localhost/health` returns `{"status":"ok","pid":<pid>}`
- [ ] `curl --unix-socket ... http://localhost/state` returns `{}` (stub for now)
- [ ] `curl --unix-socket ... http://localhost/session-info` returns claim status JSON
- [ ] SIGTERM triggers graceful shutdown: lock row deleted, socket + pointer files removed, audit log entry `lock_released` written
- [ ] Server starts cleanly with no `~/.aletheia-v2/sessions/<ppid>.session_id` file (graceful degradation; `claimed = None`; server runs and accepts MCP without auto-reclaim)
- [ ] Server starts cleanly with a valid session_id discovery file: `claimed = Some(ClaimedSession)`, `auth.auto_reclaim` audit event written
- [ ] **Registrar pattern verified:** `start_server()` body contains the commented-out `register_X` lines for Phases 5-9. Adding/uncommenting a line is the entire integration step for those phases.
- [ ] `src/server/tools/mod.rs` stubs all tool category submodules: `pub mod auth; pub mod entries; pub mod journal; pub mod memory; pub mod status; pub mod handoff; pub mod discovery; pub mod system; pub mod features; pub mod query; pub mod active_context;` — files exist as empty stubs, Phase 5 fills them
- [ ] `XmlElement::to_string()` produces valid XML with stable attribute ordering (BTreeMap-based)
- [ ] Run context compaction (`/lethe compact`) before launching Phase 5

### Known Risks
- **rmcp version churn:** Pin rmcp at the exact patch version (e.g., `"= 1.5.3"` rather than `"^1.5"`) to avoid surprise breaking changes mid-implementation. Quarterly rmcp upgrade is a planned cost (see arranger-handoff.md).
- **Socket file permissions on Windows:** `chmod 0600` is a no-op on Windows. Named pipes use ACLs instead — `interprocess` v2 should default to user-only access; verify in the spike with a Windows sanity test.
- **`hyper` dependency creep:** If endpoint server needs evolve, pulling in `hyper` is acceptable but adds compile time and binary size. Defer until needed.
- **Stale socket files:** If a previous server crashed mid-bind, a stale socket file may exist. The bind logic removes it first, but if multiple servers race-restart, the second may bind successfully but invalidate the first. Document operational expectation: only one MCP server per CC session.
- **rmcp `#[tool]` macro debugging:** Macro errors can be opaque. Recommend writing a single trivial tool early in Phase 5 (e.g., `whoami`) to validate the macro setup before scaling to 25+ tools.
- **Memory accumulation in `access_counts`:** The `SessionState.access_counts` HashMap grows over session lifetime. With ~1000s of memories accessed, this stays small. If sessions live for weeks, consider periodic eviction (LRU). Defer until observed in production.

### Guidance for Phase 5

<guidance>
Phase 5 implements all V1-equivalent + V2-new tools. With ~30+ tools total and 8+ categorical sub-tasks possible in parallel, this is the highest-parallelism phase.

**Recommended sub-task organization** (each in its own file under `src/server/tools/`):
1. `auth.rs` — claim, whoami, bootstrap, create_key, modify_key, list_keys, retire_scope (+ master key flows)
2. `entries.rs` — create_entry, list_entries, query_past_state, query_entry_history (V2-new time-travel)
3. `journal.rs` — write_journal, promote_to_memory
4. `memory.rs` — write_memory, retire_memory, read_memory_history, **promote_memory** (V2-new manual cross-scope move per CEO Item 5)
5. `status.rs` — read_status, replace_status, update_status, add_section, remove_section (all using append-only `status_sections` per Q5)
6. `handoff.rs` — create_handoff, read_handoff
7. `discovery.rs` — search, read, list_tags, **show_related** (V1-equivalent tag-overlap; V3 swaps to graph-traversal — see IS-6)
8. `system.rs` — help, health, **reconcile** (V2-new master-key only; calls Phase 9's reconciler)
9. `features.rs` — feature_init (with `confirm_table_current` two-call confirmation per CEO Item 6), table_feature, resume_feature, feature_wrap_up, abandon_feature, list_features
10. `active_context.rs` — set_active_project, set_active_context, clear_active_project, clear_active_context (V2-new per Q6)

**Critical Phase 5 contracts:**
- Every write tool calls `refresh_claim` first (IS-3); rejects writes to scopes outside `writable_scope_ids`
- Every write tool checks `migration_state.is_applying` first (B2); returns `MIGRATION_IN_PROGRESS` error if true
- Every write tool's response includes the visible-dedup metadata: `<entry id="..." scope="..." scope_alias="..." routing="primary|inferred|explicit"/>`
- `write_memory` computes `content_hash`; on dedup hit, response is `<duplicate existing_entry_id="..." existing_version="..." message="..."/>` (Q7 IS-6: this struct is extensible — V3 adds `related_entries` field non-breaking)
- `feature_init`/`resume_feature` with feature overlap return `<warn code="FEATURE_OVERLAP" .../>` UNLESS `confirm_table_current=true` is passed (CEO Item 6 two-call pattern)
- `feature_init` with name collision returns `<error code="FEATURE_NAME_TAKEN" .../>` (CEO Item 7)

**Mass-ingest approval status doc:** Phase 7 implements `request_mass_ingest`, but Phase 5's `update_status` is what supervisors use to set `approved=true`. So Phase 5's status tools are the gating contract for Phase 7.

**Append-only versioning enforcement:** All `write_memory`, `update_status`, `add_section`, `remove_section` calls go through a shared `append_version()` helper that INSERTs a new row (version+1) and tombstones the prior (`valid_to=NOW`). Establish this helper in `src/db/append_only.rs` early in Phase 5 — every tool category uses it.

Context management: Run `/lethe compact` before Phase 5 starts.
</guidance>
</core>
</section>
<!-- /conductor-review:4 -->

<!-- phase:5 -->
<section id="phase-5">
## Phase 5: Tools (V1-Equivalent + V2-New)

<core>
### Objective
Implement the full V2 MCP tool surface: V1-equivalent tools (auth, entries, journal, memory, status, handoff, discovery, system) plus V2-new additions (feature lifecycle with two-call confirmation, time-travel queries, manual `promote_memory`, active project/context). All tools share three contracts: refresh-claim → migration-in-progress check → visible-dedup metadata in response. After Phase 5, the MCP tool surface is complete; Phase 6 wires the injection pipeline and Phase 7 wires the digest pipeline that calls these tools from SDK subprocesses.

### Prerequisites
- Phase 3 complete: `claim()`/`refresh_claim()` work; `ClaimedSession` struct + `PermissionSet` available
- Phase 4 complete: `AletheiaServer` impl block ready to receive `#[tool]` annotations; `XmlElement` response builder available
- Phase 2 complete: per-scope DB schema in place (`entries`, `status_sections`, `features`, `memory_journal_provenance`); registry schema with `migration_state` for the in-progress check

### Implementation

<mandatory>Every write tool MUST call `refresh_claim(conn, &session.key_record.key_hash)` as the first step, then verify `target_scope ∈ session.permission_set.writable_scope_ids`. Write to a scope outside writable_scope_ids returns `<error code="SCOPE_NOT_WRITABLE" target_scope="..." writable=[...]/>`. NO write tool may bypass this check.</mandatory>

<mandatory>Every tool (read AND write) MUST check `migration_state.is_applying` as the second step (after auth). If true, return `<error code="MIGRATION_IN_PROGRESS"/>`. Use the partial UNIQUE INDEX on `migration_state` from Phase 2 — `SELECT 1 FROM migration_state WHERE is_applying = 1 LIMIT 1` is an indexed point-lookup (~1ms). Cost is negligible vs the data-corruption risk of running tools mid-migration.</mandatory>

<mandatory>Every write response MUST include the visible-dedup metadata as an XML element: `<entry id="..." scope="<scope_name>" scope_alias="main|w_<label>|r_<label>" routing="primary|inferred|explicit"/>`. Routing semantics: `primary` (defaulted to session's primary scope), `inferred` (looked up from existing entry_id), `explicit` (caller passed `target_scope`). The visible-dedup principle prevents agents from silently mis-targeting writes.</mandatory>

<mandatory>All mutations to memory entries (`write_memory`, `retire_memory`, `promote_memory`) and status sections (`update_status`, `add_section`, `remove_section`, `replace_status`) MUST go through the shared `append_version()` helper in `src/db/append_only.rs`. The helper INSERTs a new row with `version+1`, `valid_from=NOW`, `valid_to=NULL`, then sets the prior row's `valid_to=NOW` and `invalidation_reason`. Direct UPDATEs to `entries.content` or `status_sections.content` are FORBIDDEN — they violate append-only versioning.</mandatory>

<mandatory>**Helpful-failure principle — all reference-parameter validation MUST produce explicit, actionable errors. NEVER silent FK failures, NEVER vague rusqlite error pass-throughs.** This is the V1 bug class V2 must eliminate — V1's `write_journal`/`write_memory` accepted an `entry_id` parameter and FK-failed silently on some values, with sessions summarizing failed writes as if they succeeded. For every tool that accepts an ID/reference parameter (`entry_id`, `target_scope`, `feature_id`, `scope_id`, `section_id`, `journal_id`, `key_id`), the handler MUST:

1. **Validate explicitly BEFORE the SQL write.** Don't rely on FK constraint violations to surface errors. Run a SELECT to verify the referenced entity exists in a scope the caller can see; if not, return a structured error response with: (a) the parameter name, (b) the offending value, (c) why validation failed (not found / not in writable scope / wrong entry_class / etc.), (d) a hint pointing to a discovery tool.
2. **Wrap any rusqlite SqliteError(SQLITE_CONSTRAINT_*)** that does slip through into a tool-friendly XML error element with the same shape as (1). Never let raw SQL error messages reach the response.
3. **Specify the exact valid-ID contract** in each tool's `#[tool(description = "...")]` attribute so MCP clients see the rules in `tools/list`.

Example error shape:
```xml
<error code="INVALID_ENTRY_ID"
       parameter="entry_id"
       value="08f25895-..."
       reason="Entry not found in any scope visible to current claim (writable: [main, w_hockey], readonly: [r_system])"
       hint="Use list_entries() to find valid entry_ids in your scopes, OR omit entry_id to create a new memory."/>
```

The visible-failure principle is the symmetric companion to the visible-dedup principle. Every server-side rejection must be reported explicitly with enough information to fix the call. `cargo clippy` lint or grep should be added to CI to catch any tool handler that does `conn.execute(...)?` on a write involving a reference parameter without preceding validation.</mandatory>

**Module structure (added in Phase 5):**

```
src/
├── db/
│   └── append_only.rs         # Shared append_version() helper for memory + status mutations
└── server/
    └── tools/
        ├── mod.rs             # ⚠ DANGER FILE — Phase 4 stubs all submodules; Phase 5 fills them
        ├── auth_tools.rs      # claim, whoami, bootstrap, create_key, modify_key, list_keys, retire_scope
        ├── entry_tools.rs     # create_entry, list_entries, query_past_state, query_entry_history
        ├── journal_tools.rs   # write_journal, promote_to_memory
        ├── memory_tools.rs    # write_memory, retire_memory, read_memory_history, promote_memory
        ├── status_tools.rs    # read_status, replace_status, update_status, add_section, remove_section
        ├── handoff_tools.rs   # create_handoff, read_handoff
        ├── discovery_tools.rs # search, read, list_tags, show_related
        ├── system_tools.rs    # help, health, reconcile (master-key), purge_audit_log (master-key)
        ├── feature_tools.rs   # feature_init, table_feature, resume_feature, feature_wrap_up, abandon_feature, list_features
        ├── active_context_tools.rs # set_active_project, set_active_context, clear_active_project, clear_active_context
        └── auth_context.rs    # AuthContext struct shared by all tool handlers
```

**Shared `AuthContext` (`src/server/tools/auth_context.rs`):**

```rust
use std::sync::Arc;
use tokio::sync::Mutex;
use rusqlite::Connection;
use crate::auth::claim::ClaimedSession;
use crate::error::{Result, AletheiaError};
use crate::types::scope::ScopeId;
use crate::server::response_format::XmlElement;

/// Built once per tool invocation from `AletheiaServer.claimed`.
/// Provides the standard auth + migration check + tool-deprecation check before any tool body runs.
pub struct AuthContext<'a> {
    pub conn: Arc<Mutex<Connection>>,
    pub session: &'a ClaimedSession,
    pub tool_name: &'static str,                                // injected by the #[tool] handler wrapper
    pub deprecation_tracker: &'a crate::server::deprecation::UsageDedupTracker,  // shared per-server
}

impl<'a> AuthContext<'a> {
    pub async fn precheck(&self) -> Result<()> {
        // 1. Migration in progress?
        let c = self.conn.lock().await;
        let in_progress: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM migration_state WHERE is_applying = 1)",
            [], |row| row.get(0),
        )?;
        if in_progress { return Err(AletheiaError::MigrationInProgress); }

        // 2. Tool deprecation check — emits dedup'd usage event for deprecated tools;
        //    returns Err(ToolRemoved) for tools marked removed (Phase 9 deprecation lifecycle).
        crate::server::deprecation::check_and_log(
            &c,
            self.tool_name,
            self.session.session_id.as_deref(),
            self.deprecation_tracker,
        )?;

        // 3. Refresh claim — checks revocation
        drop(c);  // release lock before awaiting refresh_claim (which re-acquires)
        let _ = crate::auth::claim::refresh_claim(self.conn.clone(), &self.session.key_record.key_hash).await?;
        Ok(())
    }

    pub fn assert_writable(&self, target_scope: &ScopeId) -> Result<()> {
        if !self.session.permission_set.writable_scope_ids.contains(target_scope) {
            return Err(AletheiaError::Scope(format!(
                "target_scope {:?} not in writable_scope_ids", target_scope
            )));
        }
        Ok(())
    }

    pub fn write_routing_metadata(&self, scope_id: &ScopeId, scope_name: &str, alias: &str, routing: &str) -> XmlElement {
        XmlElement::new("entry")
            .attr("scope", scope_name)
            .attr("scope_alias", alias)
            .attr("routing", routing)
    }
}
```

**Append-only helper (`src/db/append_only.rs`):**

```rust
use rusqlite::Connection;
use crate::error::Result;
use crate::types::entry::EntryId;

/// Inserts a new versioned row and tombstones the prior current row.
/// Returns the new version number.
pub fn append_entry_version(
    conn: &Connection,
    scope_alias: &str,
    entry_id: &EntryId,
    new_content: &str,
    new_content_hash: &str,
    new_tags_json: Option<&str>,
    invalidation_reason_for_prior: &str,
    created_by_key_hash: Option<&str>,
) -> Result<u32> {
    let prior_version: Option<u32> = conn.query_row(
        &format!("SELECT version FROM {}.entries WHERE entry_id = ? AND valid_to IS NULL", scope_alias),
        rusqlite::params![entry_id.0],
        |row| row.get(0),
    ).optional()?;

    let new_version = prior_version.map(|v| v + 1).unwrap_or(1);

    let tx_begin = conn.execute_batch("BEGIN IMMEDIATE")?;
    let result: Result<u32> = (|| {
        if prior_version.is_some() {
            conn.execute(
                &format!("UPDATE {}.entries SET valid_to = CURRENT_TIMESTAMP, invalidation_reason = ? WHERE entry_id = ? AND valid_to IS NULL", scope_alias),
                rusqlite::params![invalidation_reason_for_prior, entry_id.0],
            )?;
        }
        // Caller already has entry_class, content_hash, etc. — this helper assumes the INSERT shape is provided by the caller's wrapper
        // This is a simplified signature; actual implementation takes the full row tuple as a struct parameter
        Ok(new_version)
    })();

    match result {
        Ok(v) => { conn.execute_batch("COMMIT")?; Ok(v) }
        Err(e) => { conn.execute_batch("ROLLBACK")?; Err(e) }
    }
}

pub fn append_status_section_version(
    conn: &Connection,
    scope_alias: &str,
    status_entry_id: &EntryId,
    section_id: &str,
    new_content: Option<&str>,        // None → section removed
    new_state: Option<&str>,
    new_position: Option<i32>,
    invalidation_reason: &str,        // "updated" | "state_changed" | "removed"
    changed_by_key_hash: Option<&str>,
) -> Result<u32> {
    let prior_version: Option<u32> = conn.query_row(
        &format!("SELECT version FROM {}.status_sections WHERE status_entry_id = ? AND section_id = ? AND valid_to IS NULL", scope_alias),
        rusqlite::params![status_entry_id.0, section_id],
        |row| row.get(0),
    ).optional()?;

    let new_version = prior_version.map(|v| v + 1).unwrap_or(1);

    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result: Result<u32> = (|| {
        if prior_version.is_some() {
            conn.execute(
                &format!("UPDATE {}.status_sections SET valid_to = CURRENT_TIMESTAMP, invalidation_reason = ? WHERE status_entry_id = ? AND section_id = ? AND valid_to IS NULL", scope_alias),
                rusqlite::params![invalidation_reason, status_entry_id.0, section_id],
            )?;
        }
        conn.execute(
            &format!("INSERT INTO {}.status_sections (status_entry_id, section_id, version, content, state, position, changed_by_key_hash) VALUES (?, ?, ?, ?, ?, ?, ?)", scope_alias),
            rusqlite::params![status_entry_id.0, section_id, new_version, new_content, new_state, new_position, changed_by_key_hash],
        )?;
        Ok(new_version)
    })();

    match result {
        Ok(v) => { conn.execute_batch("COMMIT")?; Ok(v) }
        Err(e) => { conn.execute_batch("ROLLBACK")?; Err(e) }
    }
}
```

**Tool category 1 — Auth (`src/server/tools/auth_tools.rs`):**

Tools: `claim`, `whoami`, `bootstrap`, `create_key`, `modify_key`, `list_keys`, `retire_scope`.

Key signatures:

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ClaimParams { pub key: String }

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct CreateKeyParams {
    pub permissions: String,                // "read-only" | "read-write" | "create-sub-entries" | "maintenance"
    pub primary_scope_id: String,
    pub writable_scope_ids: Option<Vec<String>>,  // defaults to [primary]
    pub readonly_scope_ids: Option<Vec<String>>,
    pub name: Option<String>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ModifyKeyParams {
    pub key_id: String,
    pub permissions: Option<String>,
    pub revoked: Option<bool>,             // V1 compat — true → set revoked_at = NOW
}
```

Implementation notes:
- `claim` calls `crate::auth::claim::claim()` — auth precheck NOT applied (this IS the auth flow)
- `bootstrap` creates a master-scoped key, writes file, INSERTs `keys` row with `is_master_key=1` if no master key exists, else creates a sub-key for the named scope (V1 semantics preserved)
- `create_key` enforces `can_delegate_permission(parent, child)` + `can_delegate_scope` (Phase 3)
- `modify_key` enforces "caller > target permission level"; setting `revoked: true` sets `revoked_at = NOW`
- `retire_scope` requires all features in scope to be in terminal state (`wrapped_up | abandoned`) — JOIN with `features` table; error lists blockers

`whoami` response:
```xml
<whoami>
  <key id="..." permissions="..." name="..."/>
  <primary_scope id="..." name="..."/>
  <writable_scopes>[scope_name, scope_name, ...]</writable_scopes>
  <readonly_scopes>[scope_name, scope_name, ...]</readonly_scopes>
  <session id="..."/>
  <active_project source="explicit|feature|primary|cwd|inferred" scope="..."/>
  <active_context source="explicit_override|feature_tags|project_tags|inferred" tags=[...]/>
</whoami>
```

**Tool category 2 — Entries (`src/server/tools/entry_tools.rs`):**

Tools: `create_entry`, `list_entries`, `query_past_state`, `query_entry_history`.

Key signatures:

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct CreateEntryParams {
    pub entry_class: String,                 // "journal" | "memory" | "status" | "handoff"
    pub tags: Option<Vec<String>>,
    pub target_scope: Option<String>,        // defaults to primary; must be in writable_scope_ids
    pub template: Option<String>,            // V1 compat
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct QueryPastStateParams {
    pub entry_id: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    // V3 will add: pub include_graph_context: Option<bool> — must use Option for backward-compat (Q7 IS-6)
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct QueryEntryHistoryParams {
    pub entry_id: String,
    pub limit: Option<u32>,                  // default 50
}
```

Implementation notes:
- `create_entry` allocates a new UUID, INSERTs into target scope's `entries` with version=1, valid_from=NOW, valid_to=NULL, content="" (caller will populate via type-specific tool); returns the entry_id + scope-routing metadata
- `query_past_state(entry_id, timestamp)` SQL: `SELECT * FROM entries WHERE entry_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)` — returns the row valid at that timestamp
- `query_entry_history(entry_id, limit)` SQL: `SELECT * FROM entries WHERE entry_id = ? ORDER BY version DESC LIMIT ?` — returns version chain
- Both queries iterate over all attached scopes (in order writable → readonly) until match found; first-match wins
- `list_entries(entry_class?, tags?, scope?)` filters by entry_class + JSON-array-overlap on tags; respects scope visibility

**Tool category 3 — Journal (`src/server/tools/journal_tools.rs`):**

Tools: `write_journal`, `promote_to_memory`.

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct WriteJournalParams {
    pub entry_id: String,
    pub content: String,
    pub tags: Option<Vec<String>>,
    pub critical: Option<bool>,              // sets critical_flag
    pub memory_summary: Option<String>,      // V1 compat (used by digest)
    pub skip_related: Option<bool>,          // V1 compat
    pub target_scope: Option<String>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct PromoteToMemoryParams {
    pub journal_id: String,
    pub synthesized_knowledge: String,
    pub key: Option<String>,                 // V1 compat — becomes a tag (`key:<value>`) in V2 (per Q5A)
    pub tags: Option<Vec<String>>,
}
```

Implementation notes:
- `write_journal` INSERTs into `entries` (entry_class=journal). NOT through `append_version` — journals are append-only natively (each call creates a new entry, no prior version to tombstone)
- `promote_to_memory` creates a new memory entry with content=synthesized_knowledge, INSERTs `memory_journal_provenance(memory_entry_id, journal_entry_id)` row (Q5B IS-6 forward-compat)
- `critical=true` sets `critical_flag=1` — the relevance scorer (Phase 6) treats this as 1.0 weight contribution
- Auto-tagging by active feature: if session has an `active_feature_id`, write inherits the feature's `feature_tags` UNLESS `skip_feature_association=true` is passed (per CEO Item 5 carryover)

**Tool category 4 — Memory (`src/server/tools/memory_tools.rs`):**

Tools: `write_memory`, `retire_memory`, `read_memory_history`, `promote_memory` (V2-new manual cross-scope move).

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct WriteMemoryParams {
    pub entry_id: Option<String>,            // None → create new memory; Some → update existing
    pub content: String,
    pub tags: Option<Vec<String>>,
    pub critical: Option<bool>,
    pub supersedes: Option<String>,          // entry_id this supersedes (single-level)
    pub target_scope: Option<String>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct PromoteMemoryParams {
    pub entry_id: String,
    pub target_scope: String,                // MUST be in writable_scope_ids OR caller must be parent-scope key / master key
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ReadMemoryHistoryParams {
    pub entry_id: String,
    pub key: Option<String>,                 // V1 compat — looks up by `key:<value>` tag in V2
    pub limit: Option<u32>,
}
```

Implementation notes:
- `write_memory`:
  1. Compute `content_hash = SHA-256(content + scope_id)`.
  2. If matching `content_hash` exists in target scope (and `valid_to IS NULL`), return `<duplicate existing_entry_id="..." existing_version="..." message="Identical content already stored"/>` **without inserting** — the design's visible-dedup learning signal (per Q7 IS-6, this struct must be extensible — V3 adds `related_entries` field).
  3. Else, if `entry_id` provided: `append_entry_version()` with `invalidation_reason="updated"`.
  4. Else: INSERT new entry with new UUID, version=1.
  5. Response includes write-routing metadata + the entry's full XML.
- `promote_memory(entry_id, target_scope)` — V2-new manual cross-scope move (per CEO Item 5):
  1. Auth precheck.
  2. Verify caller is parent-scope key OR master key (NOT self-promotion).
  3. Read source entry; compute new entry in target scope.
  4. Cross-DB transaction: INSERT new entry in target scope; UPDATE source's `valid_to=NOW`, `invalidation_reason="promoted_to:<new_entry_id>@<target_scope>"`. Audit emits `digest.critical_entry_promotion_committed` (or similar; final event vocabulary in CR-7).
  5. **Cross-DB atomicity caveat (Phase 2 finding 5):** WAL+ATTACH cross-DB writes can tear under power loss. Operation is idempotent (retryable via reconciler in Phase 9). Audit log entries pre-/post- the cross-DB write enable reconciliation.
- `retire_memory(entry_id, reason)`: `append_version` with `invalidation_reason="retired:<reason>"`, `valid_to=NOW`. No new row inserted (just tombstone).
- `read_memory_history`: queries `entries WHERE entry_id = ? ORDER BY version`. If `key` provided, filters by `tags` containing `key:<value>` (V1 compat — V1's per-key history maps to V2's per-tag filter).

**Tool category 5 — Status (`src/server/tools/status_tools.rs`):**

Tools: `read_status`, `replace_status`, `update_status`, `add_section`, `remove_section`.

All section mutations go through `append_status_section_version`. `replace_status` is a transactional diff: for each section in the new content, either INSERT (if new) or `append_status_section_version` (if changed); for sections in the old content not in the new, `append_status_section_version(content=NULL, invalidation_reason="removed")`.

Key signatures:

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ReadStatusParams {
    pub entry_id: String,
    pub section_id: Option<String>,          // None → all sections
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ReplaceStatusParams {
    pub entry_id: String,
    pub content: String,                     // full status body (markdown with section headers)
    pub version_id: Option<String>,          // V1 OCC compat — V2 uses INTEGER version internally
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct UpdateStatusParams {
    pub entry_id: String,
    pub section_id: String,
    pub content: Option<String>,
    pub state: Option<String>,
    pub continue_field: Option<bool>,        // V1 compat (renamed because `continue` is reserved)
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct AddSectionParams {
    pub entry_id: String,
    pub section_id: String,
    pub content: String,
    pub position: Option<i32>,
    pub state: Option<String>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct RemoveSectionParams {
    pub entry_id: String,
    pub section_id: String,
}
```

Implementation note: `read_status` reconstructs current state from `status_sections` rows with `valid_to IS NULL`, ordered by `position`. Returns markdown rendering or per-section JSON depending on caller preference (response includes both representations).

**Tool category 6 — Handoff (`src/server/tools/handoff_tools.rs`):**

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct CreateHandoffParams {
    pub target_key: String,                  // recipient key value (or key_id — V1 ambiguity, V2 accepts both via name lookup)
    pub content: String,
    pub tags: Option<Vec<String>>,
}

// read_handoff takes no params — returns the current claimed session's pending handoff (if any) and consumes it
```

`read_handoff` is consuming (DELETEs the row). The hook endpoint `GET /handoff` is non-consuming peek (Phase 6 builder reads via SELECT only).

**Tool category 7 — Discovery (`src/server/tools/discovery_tools.rs`):**

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct SearchParams {
    pub query: String,                       // FTS query
    pub entry_class: Option<String>,
    pub tags: Option<Vec<String>>,           // tag-overlap filter
    pub include_archived: Option<bool>,      // include valid_to IS NOT NULL rows
    pub scope: Option<String>,               // restrict to specific attached scope
    pub limit: Option<u32>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ReadParams {
    pub entry_id: String,
    pub mode: Option<String>,                // "current" | "history" | "as_of:<timestamp>"
    pub limit: Option<u32>,
    pub show_related: Option<bool>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ListTagsParams {
    pub entry_class: Option<String>,
    pub scope: Option<String>,
}

/// V1-equivalent tag-overlap; V3 will swap to graph-traversal.
/// IS-6 forward-compat: signature stays minimal so V3 can extend without MCP API change.
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ShowRelatedParams {
    pub entry_id: String,
    pub limit: Option<u32>,                  // default 10
}
```

Implementation notes:
- `search`: V2 uses SQLite FTS5 virtual table over `entries.content`. Phase 2 should add an FTS5 index — UPDATE: this is a Phase 5 add to scope_schema (the index lives in per-scope DB, populated via INSERT triggers). Add to `src/db/scope_schema.rs` in Phase 5: `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(content, content=entries, content_rowid=internal_id)` + sync triggers.
- `show_related`: V2 implements as tag-overlap (V1 logic). Compute Jaccard similarity between target entry's tags and all candidate entries' tags; return top-K. **Tool signature is minimal so V3's graph-traversal swap is non-breaking (Q7 IS-6).**
- `read(entry_id, mode="as_of:2026-01-15")` parses the as_of mode, calls `query_past_state` internally.

**Tool category 8 — System (`src/server/tools/system_tools.rs`):**

Tools: `help`, `health`, `reconcile` (master-key only), `purge_audit_log` (master-key only), `analyze_shadow_mode` (master-key only — added by Phase 9).

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct HelpParams { pub topic: Option<String> }

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ReconcileParams {
    pub since_hours: Option<u32>,            // default 24
    pub dry_run: Option<bool>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct PurgeAuditLogParams {
    pub older_than: chrono::DateTime<chrono::Utc>,
}
```

`reconcile` is the master-key on-demand entry point for Phase 9's reconciler. `health` returns server version, uptime, attached scopes, claim status.

**Tool category 9 — Features (`src/server/tools/feature_tools.rs`):**

Tools: `feature_init`, `table_feature`, `resume_feature`, `feature_wrap_up`, `abandon_feature`, `list_features`.

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct FeatureInitParams {
    pub name: String,
    pub description: Option<String>,
    pub feature_tags: Option<Vec<String>>,
    pub primary_scope: Option<String>,       // defaults to session primary
    pub confirm_table_current: Option<bool>, // CEO Item 6 — required as `true` if active feature differs
    pub metadata: Option<serde_json::Value>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ResumeFeatureParams {
    pub feature_id: String,
    pub confirm_table_current: Option<bool>, // CEO Item 6
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct WrapUpParams {
    pub feature_id: String,
    pub archive_policy: Option<String>,      // "retain" (default) | "tombstone"
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct AbandonFeatureParams {
    pub feature_id: String,
    pub reason: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ListFeaturesParams {
    pub state: Option<String>,               // "active" | "tabled" | "wrapped_up" | "abandoned"
    pub scope: Option<String>,
}
```

Critical implementations:

**`feature_init`** — two-call confirmation pattern (CEO Item 6):
1. Auth precheck.
2. UNIQUE name check: SELECT from `features` table. If exists with ANY state, return:
   ```xml
   <error code="FEATURE_NAME_TAKEN" name="X" existing_state="..." since="..."
          hint="choose a different name OR call list_features(state='abandoned') to inspect history"/>
   ```
3. Active-feature overlap check: query `session_locks.active_feature_id`. If non-NULL AND `feature_id != requested`:
   - If `confirm_table_current != Some(true)`: return:
     ```xml
     <warn code="FEATURE_OVERLAP" current_feature="<name>" current_id="<id>"
           hint="call again with confirm_table_current=true to proceed,
                 or use skip_feature_association=true to keep current active"/>
     ```
     (do NOT proceed)
   - Else: tombstone current (set state='tabled', tabled_at=NOW), proceed.
4. INSERT new row in `features` with state='active', initiated_at=NOW, etc. UPDATE `session_locks.active_feature_id=<new>`.
5. Response includes `<feature_initiated id="..." auto_tabled="<previous_id_if_any>" .../>`
6. Enqueue `digest_queue` row with `trigger_type='feature_init'` (Phase 7 picks it up; SDK reads memories matching feature_tags across scope+ancestors → creates staged context handoff).

**`resume_feature`** — same two-call confirmation pattern. Cross-session resume allowed: features belong to scopes, not sessions; any authorized session can resume. Response surfaces `last_tabled_by_session_id` and `last_tabled_by_key_hash` for context.

**`feature_wrap_up`** — sets state='wrapped_up', wrapped_at=NOW, wrapped_by_key_hash. Enqueues `digest_queue` row with `trigger_type='feature_wrap'` (Phase 7 SDK synthesizes durable memories from feature-linked entries → marks source journals digested_at; if `archive_policy='tombstone'`, also tombstones feature-only ephemerals).

**`abandon_feature`** — sets state='abandoned', abandoned_at=NOW, abandonment_reason. No digest synthesis enqueued (abandoned work isn't synthesized).

**`list_features(state?, scope?)`** — straightforward SELECT.

**Tool category 10 — Active project/context (`src/server/tools/active_context_tools.rs`):**

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct SetActiveProjectParams {
    pub scope_id: Option<String>,
    pub project_tag: Option<String>,
    pub ttl_minutes: Option<u32>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct SetActiveContextParams {
    pub tags: Vec<String>,
    pub ttl_minutes: Option<u32>,
}
```

Implementation notes:
- Active project/context state lives in `session_locks` columns defined in Phase 2's `registry_schema.rs::SESSION_LOCKS_TABLE` (`active_project_id`, `active_project_source`, `active_project_expires_at`, `active_context_tags_json`, `active_context_source`, `active_context_expires_at`, plus `active_feature_id` for the feature lifecycle). Phase 5's tools READ/UPDATE these columns; no schema modification needed.
- `set_active_project(scope_id_or_tag)` UPDATEs `session_locks` for current session. Auto-resets `active_context_tags_json` to project's tags (queried from scope's existing memories' tag frequency or a `scopes.metadata.project_tags` field).
- `set_active_context(tags)` checks tag overlap with active project's tags. If zero overlap: response includes `<warn code="CONTEXT_PROJECT_MISMATCH" active_project_tags=[...] requested_tags=[...] message="..."/>`.
- TTL enforced: when reading active project/context (e.g., during hook injection in Phase 6), check `expires_at < NOW`; if expired, treat as cleared.
- `clear_*` tools just NULL the columns.

**Phase 2 schema reference** — `SESSION_LOCKS_TABLE` (in `src/db/registry_schema.rs`) defines all `active_project_*`, `active_context_*`, and `active_feature_id` columns. Phase 5's `active_context_tools` is a pure read/write consumer — no schema modification.

**Tool registration (`src/server/tools/mod.rs`):**

```rust
pub mod auth_context;
pub mod auth_tools;
pub mod entry_tools;
pub mod journal_tools;
pub mod memory_tools;
pub mod status_tools;
pub mod handoff_tools;
pub mod discovery_tools;
pub mod system_tools;
pub mod feature_tools;
pub mod active_context_tools;
```

Each `*_tools.rs` adds `#[tool]` methods to a Phase 4–established `AletheiaServer` impl block. With rmcp's `#[tool(tool_box)]` macro, the server auto-discovers these and serves them via `tools/list`.

<guidance>
**On rmcp tool registration across files:** rmcp's `#[tool(tool_box)]` macro on the impl block aggregates `#[tool]` methods. With Rust's orphan rules, you can't add methods to an impl block from another file — but you CAN have multiple `impl` blocks for the same struct. Each `*_tools.rs` defines its own `impl AletheiaServer { #[tool] async fn ... }` block. The `#[tool(tool_box)]` aggregator on the primary impl in `mcp.rs` collects them. Verify against rmcp's docs at implementation time — if the macro requires all tools in one block, refactor to a single `tools.rs` file with submodule imports for the param/response structs only.

**On FTS5 setup:** Add to `src/db/scope_schema.rs`:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(content, content=entries, content_rowid=internal_id);
CREATE TRIGGER IF NOT EXISTS trg_entries_fts_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, content) VALUES (new.internal_id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS trg_entries_fts_update AFTER UPDATE ON entries BEGIN
  UPDATE entries_fts SET content = new.content WHERE rowid = new.internal_id;
END;
```
Note: `entries_fts` is a per-scope table (lives in each scope's `.db`). The FTS5 trigger fires on every INSERT/UPDATE of `entries` — minor overhead, acceptable. Defined in Phase 2's `ENTRIES_FTS_TABLE` constant. Phase 8's V1→V2 bulk migration disables the triggers temporarily (DROP TRIGGER + bulk INSERT + CREATE TRIGGER + single FTS5 rebuild) for 10-100× speedup on large corpora.

**On the active_context_tools and session_locks columns:** This is the second retroactive Phase 2 amendment surfaced during Phase 5 design. Both should be flagged in CR-2 (or noted in this CR-5 as additions to be folded in during implementation). The mandatory in Phase 2 prevents NEW tables being added to registry by later phases — column additions to existing tables are gray area but should be made by amending Phase 2's constants directly, not by Phase 5 issuing ALTER TABLE.

**On `read_handoff` consuming semantics:** V1's read_handoff DELETEs after read. V2 preserves this for backward compat with V1 hooks. If V2 wants non-consuming peek for the hook endpoint `/handoff`, that's a different code path — use a SELECT-only function in Phase 6's hook builder.

**On the `key` parameter to `read_memory_history`:** V1 had per-key history natively. V2 emulates via tag filter — if `key=<value>` is passed, filter by tags containing `key:<value>`. This preserves V1 ergonomics during transition.
</guidance>

### Integration Points
- **IS-3 (claim → tools):** Every tool reads `AuthContext` → `precheck()` first. Refresh checks revocation; assert_writable checks scope membership. Audit events: `auth.claim_rejected` fires on bad/revoked keys.
- **IS-4 (rmcp registration):** Each `*_tools.rs` adds `#[tool]` methods to `AletheiaServer` impl. Phase 4's tool_box aggregator picks them up.
- **Migration check (B2):** Every tool runs `migration_state.is_applying` check via `AuthContext::precheck()` — single call site, no risk of forgetting.
- **Visible-dedup (mandatory):** Every write tool calls `AuthContext::write_routing_metadata()` to build the `<entry scope="..." routing="..."/>` element added to the response.
- **Append-only enforcement (mandatory):** `write_memory`, `update_status`, `add_section`, `remove_section`, `replace_status`, `promote_memory`, `retire_memory` all use `append_entry_version` or `append_status_section_version`. NO direct UPDATE to `content` columns anywhere.
- **Phase 6 (injection):** Hook endpoints in Phase 4 stub `/state` and `/context` — Phase 6 builders read entries, status, handoff via the same DB layer used by these tools (NOT by calling the tools — tools have MCP overhead). The active_context_tools data populates session_locks rows that Phase 6 reads.
- **Phase 7 (digest):** `feature_init`/`feature_wrap_up`/`abandon_feature` enqueue `digest_queue` rows. The `request_mass_ingest` tool (Phase 7) creates an approval status doc via `add_section` (Phase 5's tool). Approval polling (Phase 7) reads the status doc via `read_status`.
- **Phase 9 (reconciliation):** `reconcile` MCP tool dispatches to Phase 9's reconciler module. `purge_audit_log` calls Phase 2's `audit_log::purge_audit_log()` helper.

### Expected Outcomes
- `cargo test` passes for all tool modules (target: ~80% coverage on tool handlers — high coverage for the auth+migration precheck, lower for happy-path bodies)
- `aletheia-v2 serve` starts; MCP `tools/list` returns 30+ tools (count matches expected — verify via test)
- E2E test: `claim` → `bootstrap` → `write_memory` → `read` → result includes write-routing metadata and the entry content
- E2E test for two-call confirmation: `feature_init(name="A")` succeeds; `feature_init(name="B")` while A is active returns FEATURE_OVERLAP warn; `feature_init(name="B", confirm_table_current=true)` succeeds with `auto_tabled="A"` notice
- E2E test for content_hash dedup: `write_memory(content="X")` succeeds; `write_memory(content="X")` again returns `<duplicate ...>` without inserting
- E2E test for append-only: `write_memory(content="A")` v1, `write_memory(entry_id, content="B")` v2 — query DB, confirm v1 row has `valid_to NOT NULL`, v2 has `valid_to IS NULL`, both rows present
- E2E test for migration block: SET `migration_state.is_applying=1`, call any tool, expect `MIGRATION_IN_PROGRESS` error
- E2E test for cross-scope write reject: `write_memory(target_scope="other_scope")` where other_scope NOT in writable → SCOPE_NOT_WRITABLE error
- E2E test for `query_past_state`: write memory v1 at T1, v2 at T2, v3 at T3; `query_past_state(entry_id, T2.5)` returns v2's content
- E2E test for `promote_memory`: PM key promotes a memory from PM scope to project scope; verify source tombstoned with `promoted_to:` reason, target inserted; cross-DB transaction succeeds
- FTS5 search test: write 3 memories with different content; `search(query="word")` returns matches ranked by FTS5 BM25

### Testing Recommendations
- Write per-tool unit tests: happy path + auth-failure path + migration-in-progress path + scope-not-writable path
- Property-test `append_entry_version` invariants: after N write_memory calls, exactly ONE row has valid_to=NULL; total row count == N (no rows lost); version numbers are sequential
- E2E test the visible-dedup principle: capture every write tool's response, verify `<entry routing="..."/>` is present
- Conformance test: rmcp `tools/list` schema matches what each `#[tool]`-annotated function declares
- Test `read_handoff` consuming semantics: write handoff → read once (returns it) → read again (returns empty)
- Status section sequence: add_section → update_status (state) → remove_section; query history; verify 3 versions per the lifecycle, last with content=NULL + invalidation_reason="removed"
- Cross-scope visibility: PM key can read project_memory (readonly) but write_memory(target_scope="project_memory") succeeds because project is also writable; modify the test to make project readonly_only and verify SCOPE_NOT_WRITABLE
</core>
</section>
<!-- /phase:5 -->

<!-- conductor-review:5 -->
<section id="conductor-review-5">
## Conductor Review: Post-Phase 5

<core>
### Verification Checklist

<mandatory>All checklist items must be verified before proceeding.</mandatory>

- [ ] All 10 tool category files exist under `src/server/tools/` with `#[tool]` methods on `AletheiaServer` impl
- [ ] `cargo build` succeeds; `cargo test` passes; rmcp `tools/list` returns 30+ tools
- [ ] **Auth precheck applied to every write tool** — grep for any tool body that doesn't call `AuthContext::precheck()` first → must be zero (except `claim`/`bootstrap`/`whoami` which ARE the auth flow)
- [ ] **Migration in-progress check applied via `precheck()`** — single call site means no risk of forgetting; verify `precheck()` queries `migration_state.is_applying` first
- [ ] **Visible-dedup metadata in every write response** — grep for `XmlElement::new("entry")` calls; every write tool's response builder includes `routing` attribute
- [ ] **Append-only enforcement** — grep `src/server/tools/` for any `UPDATE .* content =` SQL — must be zero. All content mutations go through `append_*_version` helpers.
- [ ] **Helpful-failure principle verified for every reference-parameter:** for each tool that accepts `entry_id`, `target_scope`, `feature_id`, `scope_id`, `section_id`, `journal_id`, or `key_id` — verify the handler runs an explicit SELECT-validation BEFORE any write. NO tool relies on FK constraint violations as the error-detection path. Test for each: pass a syntactically-valid-but-nonexistent ID → response is `<error code="INVALID_*" parameter="..." value="..." reason="..." hint="..."/>` with all 4 fields populated, NOT a raw rusqlite error.
- [ ] **No silent FK failures** — write a CI test that, for every write tool, attempts the call with a bogus reference value; verifies the response is a structured `<error>` element (not a raw error, not a success that silently dropped the write). This is the V1 bug class V2 must eliminate.
- [ ] **Tool descriptions document valid-ID contracts** — every `#[tool(description = "...")]` attribute on a handler that takes a reference parameter explicitly states what makes a valid value (e.g., "entry_id: must be an existing entry in a writable or readable scope; use list_entries() to discover valid IDs").
- [ ] `write_memory` content_hash dedup test passes: identical content returns `<duplicate>` without inserting
- [ ] `feature_init` two-call confirmation test passes: bare init with active feature returns FEATURE_OVERLAP warn; init with `confirm_table_current=true` proceeds with `auto_tabled` notice
- [ ] `feature_init` name-collision test passes: re-init of abandoned feature name returns FEATURE_NAME_TAKEN error with hint
- [ ] `query_past_state` returns the correct version for a given timestamp (test with 3-version chain)
- [ ] `promote_memory` cross-scope move: source tombstoned with `promoted_to:` reason; target inserted; both visible via attached scopes
- [ ] FTS5 virtual table + sync triggers present in scope DB (defined in Phase 2's `ENTRIES_FTS_TABLE` constant; install_all() applies them)
- [ ] `set_active_context(tags=["other"])` with zero overlap with active project's tags returns CONTEXT_PROJECT_MISMATCH warn
- [ ] `session_locks` table contains all 7 active-* columns (`active_feature_id`, `active_project_id`, `active_project_source`, `active_project_expires_at`, `active_context_tags_json`, `active_context_source`, `active_context_expires_at`) — defined in Phase 2's `SESSION_LOCKS_TABLE` constant; Phase 5 reads/writes them
- [ ] Phase 5 file creation: `src/server/tools/auth_context.rs` and `src/db/append_only.rs` exist (Phase 4 reserved the module slots; Phase 5 creates the files)
- [ ] Audit events emitted by Phase 5: `scope.scope_created`, `scope.scope_retired`, `key.key_issued`, `key.key_modified`, `key.key_revoked`, `digest.feature_initiated`, `digest.feature_tabled`, `digest.feature_resumed`, `digest.feature_wrapped_up`, `digest.feature_abandoned`, `digest.feature_auto_tabled`, `digest.critical_entry_promotion_committed`
- [ ] Run context compaction (`/lethe compact`) before launching Phases 6 + 7

### Known Risks
- **Two retroactive Phase 2 amendments:** `session_locks` columns + `entries_fts` virtual table. The Conductor must apply these to Phase 2's schema constants BEFORE any Phase 5 sub-task tries to query the new columns. Sequence: amend Phase 2 → re-run Phase 2 schema test → start Phase 5 sub-tasks.
- **rmcp tool aggregation across files:** If rmcp's `#[tool(tool_box)]` macro requires all `#[tool]` methods in a single impl block, the 10-file split won't work. Fall back: keep a single `src/server/tools.rs` with submodule imports of param/response structs only. Validate macro behavior with a 2-tool spike first.
- **FTS5 trigger overhead on bulk inserts:** Phase 8's V1→V2 migration inserts thousands of rows; FTS5 sync triggers fire per-INSERT. Recommend Phase 8 disable FTS5 triggers during bulk insert (`DROP TRIGGER` then `CREATE TRIGGER` after, plus a single `INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`).
- **`promote_memory` cross-DB atomicity:** WAL+ATTACH can tear; Phase 9's reconciler handles. Operation MUST be idempotent — Phase 5 implementation must verify that calling promote_memory twice with the same args doesn't double-insert (use content_hash to dedup at target).
- **`write_memory` dedup semantic:** A dedup hit returns `<duplicate>` instead of `<entry>`. Tools that chain on the response (e.g., a script that always expects `<entry id>`) may break. The visible-dedup principle is upheld, but document the response shape clearly in `help` tool output.
- **Active context TTL evaluation:** TTL is checked when active context is READ (e.g., during hook injection). If hook injection is rare (every 10-20 tool calls), an expired context may linger briefly. Acceptable — TTL is a hint, not a hard expiry.

### Guidance for Phase 6 + Phase 7 (parallel launch)

<guidance>
**Phase 6 (Hook Layer + Injection Pipeline) and Phase 7 (Digest Pipeline + Mass-Ingest) can run in parallel** — they share the tool surface (Phase 5) but no files between them.

**Phase 6 sub-tasks** (6 parallel):
1. V1 hook scripts compat (`hooks/unix/{startup,l1-inject,l2-inject,memory-intercept}.sh` + Windows `.js` parallels) — preserved from V1 with minimal changes (same `/state` `/context` `/handoff` endpoints, JSON payloads per Q2)
2. Pluggable Signal trait + 4 implementations (`src/injection/signals/{mod,tag_overlap,recency,active_project,critical}.rs`) — **IS-6 KG forward-compat critical**
3. Threshold-gated Top-K scorer (`src/injection/scorer.rs`) — uses `[injection.weights]` HashMap from settings (Q7 IS-6)
4. L1/L2 builders (`src/injection/l1_builder.rs` + `src/injection/l2_builder.rs`) — gather candidates → score → threshold gate → top-K → emit JSON payload
5. Frequency manager (`src/injection/frequency.rs`) — ports V1's `FrequencyManager` to Rust (callCount, l1/l2 intervals, adaptive single-bump-on-no-change)
6. KG-stub verification — explicit code-comment markers at all 7 IS-6 stub locations referencing arranger-handoff.md

**Phase 7 sub-tasks** (6 parallel):
1. digest_queue + leasing (`src/digest/queue.rs`) — SQL `UPDATE ... RETURNING` lease pattern (Phase 2 finding 9)
2. SDK subprocess launch (`src/digest/sdk_subprocess.rs`) — the OAuth-preserving flag combination (Phase 2 finding 11): `--mcp-config <inline>` + `--strict-mcp-config` + `--settings '{"claudeMdExcludes":["**/*"],...}'` + `--setting-sources local` + `--disable-slash-commands` + `--allowed-tools "mcp__aletheia__*"` + `--tools ""` + `--permission-mode bypassPermissions` + `--no-session-persistence` + `--print` + `--model opus`
3. Digest agent prompt template (`src/digest/agent_prompt.rs`) — system prompt for the SDK subprocess explaining its role + the V2 MCP tools it can use
4. Background poller (`src/digest/poller.rs`) — registered via `register_digest_queue_poller(&mut registry)` in Phase 4's Registrar; 60s cadence; lease + crash-recovery
5. Mass-ingest approval (`src/digest/mass_ingest.rs`) — request_mass_ingest tool + approval status doc + 30s polling + first-approval-locks (CEO Item 8)
6. Checkpointing (`src/digest/checkpoint.rs`) — `mass_ingest_checkpoints` table operations; SDK contract: no raw sensitive content in resume_state JSON

**Coordination point between Phases 6 & 7:** Both phases register background tasks via the Registrar. Adding `register_X` lines to `start_server()` is the integration step — different lines, no conflict.

Context management: Run `/lethe compact` before launching Phases 6 + 7.
</guidance>
</core>
</section>
<!-- /conductor-review:5 -->

<!-- phase:6 -->
<section id="phase-6">
## Phase 6: Hook Layer + Injection Pipeline

<core>
### Objective
Wire the L1/L2 PreToolUse injection pipeline that gives Aletheia its primary value: gather candidates from accessible scopes → score with pluggable `Signal` trait + 4 V2 implementations → threshold-gate + Top-K → emit JSON payload via the hook endpoint server (Phase 4 stubs filled in). Plus port V1's hook scripts (bash + JS) that consume the endpoint payloads. The pluggable Signal trait is the **primary V3 KG forward-compat seam (IS-6)**: V3 plugs `GraphProximitySignal` here without V2 code changes.

### Prerequisites
- Phase 4 complete: hook endpoint server stubs `/state`, `/context`, `/handoff`, `/session-info`; `SessionState` struct exists
- Phase 5 complete: tool surface implemented; per-scope DB queries work via `ConnectionManager`; active_project/active_context columns on `session_locks` populated by Phase 5's tools
- Phase 5 amendments to Phase 2 schemas applied (FTS5 virtual table, session_locks columns)

### Implementation

<mandatory>The `Signal` trait MUST be defined as a `dyn`-object-safe trait with `name()` + `score()` methods. The scoring engine MUST iterate a `Vec<Box<dyn Signal>>` registry — NOT a fixed enum. V3 KG plugs `GraphProximitySignal` as a 5th implementation by adding a registry insertion. Hardcoding signal types violates the V3 forward-compat contract (IS-6 / Q7 stub pattern 1).</mandatory>

<mandatory>The scoring engine MUST read weights as `HashMap<String, f64>` from `settings.injection.weights.0`. Missing keys default to 0.0 contribution (signal score not added). V3 adds a `graph_proximity` weight key without V2 code change. A typed struct here breaks IS-6.</mandatory>

<mandatory>The `Context` struct passed to signals MUST be defined with `Option<>` fields and `#[serde(default)]` so V3 can add `graph_anchor_nodes: Option<Vec<NodeId>>` non-breaking. Use a builder-style construction in the scorer.</mandatory>

<mandatory>Hook endpoint payloads are **JSON** (Q2). V1 hook scripts already parse JSON; preserve the V1 wire format unchanged. Specifically: `/state` returns L1 injection payload, `/context` returns L2 injection payload, `/handoff` returns peek-only handoff (NON-consuming — read_handoff tool is the consuming path).</mandatory>

**Module structure (added in Phase 6):**

```
src/
├── injection/
│   ├── mod.rs                 # Aggregator + ScoringEngine entry point
│   ├── signal.rs              # `Signal` trait (IS-6 KG seam #1 — DO NOT HARDCODE TYPES)
│   ├── signals/
│   │   ├── mod.rs             # Registers V2's 4 signals; V3 adds GraphProximitySignal here
│   │   ├── tag_overlap.rs     # TagOverlapSignal
│   │   ├── recency.rs         # RecencySignal (exp(-age_days/half_life_days))
│   │   ├── active_project.rs  # ActiveProjectSignal (1.0 or 0.0)
│   │   └── critical.rs        # CriticalSignal (1.0 or 0.0)
│   ├── context.rs             # Context struct (IS-6 KG seam #3 — extensible via Option/serde defaults)
│   ├── candidate.rs           # Candidate struct (entry summary used in scoring)
│   ├── scorer.rs              # ScoringEngine: gather → score → threshold → top-K
│   ├── frequency.rs           # FrequencyManager (ports V1)
│   ├── l1_builder.rs          # Build L1 payload (active feature + handoffs + status)
│   ├── l2_builder.rs          # Build L2 payload (broad memory candidates + journal tail + tag catalog)
│   └── token_budget.rs        # Approximate token estimation (chars/4 baseline; refined later)

hooks/
├── unix/
│   ├── startup.sh             # NEW (port from V1): connect socket → /session-info → first-run guide if needed → /state echo
│   ├── l1-inject.sh           # NEW (port): /state → echo if non-empty
│   ├── l2-inject.sh           # NEW (port): /context → echo if non-empty
│   ├── memory-intercept.sh    # NEW (port): /handoff peek → echo if pending
│   └── sessionstart-bind.sh   # already from Phase 3
└── windows/
    ├── startup.js             # NEW (port from V1)
    ├── l1-inject.js           # NEW (port)
    ├── l2-inject.js           # NEW (port)
    ├── memory-intercept.js    # NEW (port)
    └── sessionstart-bind.js   # already from Phase 3
```

**`Signal` trait (`src/injection/signal.rs`) — IS-6 KG seam #1:**

```rust
use crate::injection::candidate::Candidate;
use crate::injection::context::Context;

/// V3 KG plugs `GraphProximitySignal` as a new implementation of this trait.
/// IS-6 forward-compat: NO new methods may be added to this trait without breaking V3 — extend via Context fields instead.
/// See: docs/plans/designs/decisions/aletheia-v2/arranger-handoff.md (V3 stub pattern #1).
pub trait Signal: Send + Sync {
    fn name(&self) -> &'static str;
    fn score(&self, candidate: &Candidate, context: &Context) -> f64;
}
```

**`Context` (`src/injection/context.rs`) — IS-6 KG seam #3:**

```rust
use crate::types::scope::ScopeId;

/// IS-6 forward-compat: V3 adds `graph_anchor_nodes: Option<Vec<NodeId>>` here non-breaking.
/// Use `Option<>` + `#[serde(default)]` for any new field added in any version.
/// See: docs/plans/designs/decisions/aletheia-v2/arranger-handoff.md (V3 stub pattern #3).
#[derive(Debug, Clone, Default)]
pub struct Context {
    pub active_project: Option<String>,         // scope_id
    pub active_context_tags: Vec<String>,
    pub inferred_tags: Vec<String>,             // from recent N tool calls
    pub session_id: Option<String>,
    // V3 KG additions (commented stubs — uncommented when V3 ships):
    // pub graph_anchor_nodes: Option<Vec<NodeId>>,
}

impl Context {
    pub fn builder() -> ContextBuilder { ContextBuilder::default() }
}

#[derive(Default)]
pub struct ContextBuilder { /* ... */ }
// builder methods: with_active_project, with_active_context_tags, etc.
```

**`Candidate` (`src/injection/candidate.rs`):**

```rust
use crate::types::entry::{EntryId, EntryClass};
use crate::types::scope::ScopeId;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone)]
pub struct Candidate {
    pub entry_id: EntryId,
    pub entry_class: EntryClass,
    pub scope_id: ScopeId,
    pub scope_alias: String,
    pub content: String,
    pub tags: Vec<String>,
    pub project_tag: Option<String>,            // derived from scope or explicit project tag
    pub critical_flag: bool,
    pub valid_from: DateTime<Utc>,
    pub age_days: f64,                          // computed at gather time for recency signal
    pub estimated_tokens: u32,
}
```

**Signal implementations (`src/injection/signals/*.rs`):**

```rust
// src/injection/signals/tag_overlap.rs
use crate::injection::signal::Signal;
use crate::injection::candidate::Candidate;
use crate::injection::context::Context;
use std::collections::HashSet;

pub struct TagOverlapSignal;
impl Signal for TagOverlapSignal {
    fn name(&self) -> &'static str { "tag_overlap" }
    fn score(&self, c: &Candidate, ctx: &Context) -> f64 {
        if ctx.active_context_tags.is_empty() { return 0.0; }
        let candidate_set: HashSet<&String> = c.tags.iter().collect();
        let context_set: HashSet<&String> = ctx.active_context_tags.iter().collect();
        let overlap = candidate_set.intersection(&context_set).count() as f64;
        overlap / context_set.len() as f64
    }
}

// src/injection/signals/recency.rs
pub struct RecencySignal { pub half_life_days: f64 }
impl Signal for RecencySignal {
    fn name(&self) -> &'static str { "recency" }
    fn score(&self, c: &Candidate, _ctx: &Context) -> f64 {
        (-c.age_days / self.half_life_days).exp()
    }
}

// src/injection/signals/active_project.rs
pub struct ActiveProjectSignal;
impl Signal for ActiveProjectSignal {
    fn name(&self) -> &'static str { "active_project" }
    fn score(&self, c: &Candidate, ctx: &Context) -> f64 {
        match (&c.project_tag, &ctx.active_project) {
            (Some(cp), Some(ap)) if cp == ap => 1.0,
            _ => 0.0,
        }
    }
}

// src/injection/signals/critical.rs
pub struct CriticalSignal;
impl Signal for CriticalSignal {
    fn name(&self) -> &'static str { "critical" }
    fn score(&self, c: &Candidate, _ctx: &Context) -> f64 {
        if c.critical_flag { 1.0 } else { 0.0 }
    }
}
```

**Scoring engine (`src/injection/scorer.rs`) — IS-6 KG seam #2:**

```rust
use crate::injection::signal::Signal;
use crate::injection::candidate::Candidate;
use crate::injection::context::Context;
use crate::lib::settings::InjectionWeights;

pub struct ScoringEngine {
    pub signals: Vec<Box<dyn Signal>>,
    pub weights: InjectionWeights,              // HashMap<String, f64> — IS-6 forward-compat
}

impl ScoringEngine {
    pub fn new_with_v2_signals(weights: InjectionWeights, half_life_days: f64) -> Self {
        let signals: Vec<Box<dyn Signal>> = vec![
            Box::new(crate::injection::signals::tag_overlap::TagOverlapSignal),
            Box::new(crate::injection::signals::recency::RecencySignal { half_life_days }),
            Box::new(crate::injection::signals::active_project::ActiveProjectSignal),
            Box::new(crate::injection::signals::critical::CriticalSignal),
        ];
        Self { signals, weights }
        // V3: add Box::new(GraphProximitySignal { ... }) to this Vec at construction time
    }

    /// Composite score: Σ signal.score(c, ctx) × weights[signal.name()].
    /// Missing weight key → signal contributes 0.
    pub fn score(&self, candidate: &Candidate, context: &Context) -> f64 {
        let mut total = 0.0;
        for signal in &self.signals {
            let weight = self.weights.0.get(signal.name()).copied().unwrap_or(0.0);
            if weight > 0.0 {
                total += signal.score(candidate, context) * weight;
            }
        }
        total
    }

    /// Top-K with threshold + token budget. Optionally observes the emitted ranking
    /// for Shadow Mode comparison (Phase 9 wires the observer; V2 default observer is NoOp).
    /// Tie-break order: Memory > Journal, Recent > Older, Critical > Non-critical.
    pub fn top_k_filtered(
        &self,
        candidates: Vec<Candidate>,
        context: &Context,
        threshold: f64,
        token_budget: u32,
        shadow_observer: Option<&crate::shadow::observer::ShadowObserver>,
        observation_metadata: Option<crate::shadow::observer::ObservationMetadata>,
    ) -> Vec<(Candidate, f64)> {
        use crate::types::entry::EntryClass;
        let candidates_for_shadow = candidates.clone();  // cheap: Candidate has Arc-wrapped content; shadow only needs IDs
        let mut scored: Vec<(Candidate, f64)> = candidates.into_iter()
            .map(|c| { let s = self.score(&c, context); (c, s) })
            .filter(|(_, s)| *s >= threshold)
            .collect();
        scored.sort_by(|(c1, s1), (c2, s2)| {
            s2.partial_cmp(s1).unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| match (c1.entry_class, c2.entry_class) {
                    (EntryClass::Memory, EntryClass::Journal) => std::cmp::Ordering::Less,
                    (EntryClass::Journal, EntryClass::Memory) => std::cmp::Ordering::Greater,
                    _ => std::cmp::Ordering::Equal,
                })
                .then(c2.valid_from.cmp(&c1.valid_from))  // recent first
                .then_with(|| c2.critical_flag.cmp(&c1.critical_flag))  // critical first on tie
        });
        let mut budget_used = 0u32;
        let emitted: Vec<(Candidate, f64)> = scored.into_iter()
            .take_while(|(c, _)| {
                if budget_used + c.estimated_tokens > token_budget { return false; }
                budget_used += c.estimated_tokens;
                true
            })
            .collect();

        // Shadow Mode observation (V2 default ranker is NoOp; Phase 9 wiring; V3 plugs the real comparison ranker)
        if let (Some(obs), Some(meta)) = (shadow_observer, observation_metadata) {
            let emitted_ids: Vec<String> = emitted.iter().map(|(c, _)| c.entry_id.0.clone()).collect();
            // Fire-and-forget; observer handles its own errors via tracing
            let _ = obs.observe_sync(meta, &candidates_for_shadow, context, &emitted_ids);
        }
        emitted
    }
}
```

**Frequency manager (`src/injection/frequency.rs`):**

Ports V1's logic. Tracks call count globally; `tick()` returns `(inject_l1, inject_l2)` based on modulo. Hash-of-payload bumps interval × multiplier on no-change (single bump, no escalation per V1).

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub struct FrequencyManager {
    call_count: AtomicU64,
    l1_interval: AtomicU64,                     // configured base; current interval may be bumped
    l2_interval: AtomicU64,
    l1_current_interval: AtomicU64,
    l2_current_interval: AtomicU64,
    l1_last_hash: Mutex<Option<String>>,
    l2_last_hash: Mutex<Option<String>>,
    no_change_multiplier: u64,                  // V1: 2
}

impl FrequencyManager {
    pub fn new(l1: u64, l2: u64, multiplier: u64) -> Self { /* ... */ }
    pub fn tick(&self) -> (bool, bool) {
        let n = self.call_count.fetch_add(1, Ordering::SeqCst) + 1;
        let l1 = n % self.l1_current_interval.load(Ordering::SeqCst) == 0;
        let l2 = n % self.l2_current_interval.load(Ordering::SeqCst) == 0;
        (l1, l2)
    }
    pub fn record_l1_payload_hash(&self, hash: &str) { /* if unchanged, bump l1_current_interval × multiplier (single bump); reset on next change */ }
    pub fn record_l2_payload_hash(&self, hash: &str) { /* similar */ }
    pub fn reset(&self) {
        self.call_count.store(0, Ordering::SeqCst);
        self.l1_current_interval.store(self.l1_interval.load(Ordering::SeqCst), Ordering::SeqCst);
        self.l2_current_interval.store(self.l2_interval.load(Ordering::SeqCst), Ordering::SeqCst);
    }
}
```

**L1 builder (`src/injection/l1_builder.rs`):**

Per design §5: "L1: session's active-feature entries + unconsumed handoffs + current status."

```rust
use crate::injection::{candidate::Candidate, context::Context, scorer::ScoringEngine};

pub fn build_l1_payload(
    conn: &rusqlite::Connection,
    session_state: &crate::server::hook_endpoints::SessionState,
    context: &Context,
    engine: &ScoringEngine,
    settings: &crate::lib::settings::InjectionRelevance,
) -> serde_json::Value {
    // 1. Gather candidates from PRIMARY scope only:
    //    - Entries linked to active_feature_id
    //    - Pending handoffs targeting this key
    //    - Current status doc sections
    let candidates = gather_l1_candidates(conn, session_state);

    // 2. Score + threshold + top-K + token budget
    let selected = engine.top_k_filtered(candidates, context, settings.l1_threshold, settings.l1_token_budget);

    // 3. Emit JSON payload (V1 wire format preserved)
    serde_json::json!({
        "type": "l1",
        "active_feature_id": session_state.active_feature_id(),
        "entries": selected.iter().map(|(c, score)| serde_json::json!({
            "entry_id": c.entry_id.0,
            "entry_class": c.entry_class,
            "content": c.content,
            "tags": c.tags,
            "score": score,
        })).collect::<Vec<_>>(),
    })
}

fn gather_l1_candidates(_conn: &rusqlite::Connection, _state: &crate::server::hook_endpoints::SessionState) -> Vec<Candidate> {
    // Query primary scope:
    //   SELECT e.* FROM main.entries e
    //   WHERE e.valid_to IS NULL
    //     AND (e.feature_id = ? OR e.entry_class IN ('handoff', 'status'))
    todo!("Phase 6 task 4")
}
```

**L2 builder (`src/injection/l2_builder.rs`):**

Per design §5: "L2: all accessible memories + recent journal tail (undigested) + tag catalog."

```rust
pub fn build_l2_payload(
    conn: &rusqlite::Connection,
    session_state: &crate::server::hook_endpoints::SessionState,
    context: &Context,
    engine: &ScoringEngine,
    settings: &crate::lib::settings::InjectionRelevance,
) -> serde_json::Value {
    // 1. Gather candidates from ALL attached scopes (writable + readonly):
    //    - All memory entries (valid_to IS NULL)
    //    - Recent N journal entries with digested_at IS NULL (rolling tail)
    //    - Tag catalog from active_tags view
    let candidates = gather_l2_candidates(conn, session_state);

    let selected = engine.top_k_filtered(candidates, context, settings.l2_threshold, settings.l2_token_budget);

    serde_json::json!({
        "type": "l2",
        "active_project": context.active_project,
        "active_context_tags": context.active_context_tags,
        "entries": selected.iter().map(|(c, score)| serde_json::json!({
            "entry_id": c.entry_id.0,
            "entry_class": c.entry_class,
            "scope": c.scope_alias,
            "content": c.content,
            "tags": c.tags,
            "score": score,
        })).collect::<Vec<_>>(),
        "tag_catalog": gather_active_tags(conn),
    })
}
```

**Hook endpoint integration (replaces Phase 4 stubs):**

In `src/server/hook_endpoints.rs::handle_connection`, replace the `{}` stubs for `/state` and `/context`:

```rust
"/state" => {
    let (inject_l1, _) = state.frequency.tick();
    if !inject_l1 { "{}".to_string() }
    else {
        let context = build_context_from_session_state(&state);
        let payload = crate::injection::l1_builder::build_l1_payload(&conn.lock().await, &state, &context, &state.scoring_engine, &settings.injection.relevance);
        if let Some(hash) = compute_payload_hash(&payload) { state.frequency.record_l1_payload_hash(&hash); }
        payload.to_string()
    }
}
"/context" => { /* analogous L2 */ }
"/handoff" => { /* peek-only handoff lookup */ }
```

**V1 hook script ports:**

The bash + JS hooks are direct ports from V1 — same socket discovery, same endpoint paths, same JSON parsing. Minimal changes:

```bash
# hooks/unix/l1-inject.sh (preserved from V1, paths updated for V2 binary install)
#!/usr/bin/env bash
set -euo pipefail
PPID_VAL=$PPID
SOCK_POINTER="${ALETHEIA_DATA_DIR:-$HOME/.aletheia-v2}/sockets/claude-${PPID_VAL}.sock.path"
[ -f "$SOCK_POINTER" ] || exit 0
SOCK=$(cat "$SOCK_POINTER")
[ -S "$SOCK" ] || exit 0
RESPONSE=$(curl --max-time 2 --silent --unix-socket "$SOCK" http://localhost/state || echo "{}")
[ "$RESPONSE" = "{}" ] && exit 0
echo "$RESPONSE"
```

V1's hook scripts are nearly identical; the V2 changes are: (a) the `${ALETHEIA_DATA_DIR}` env var override (V1 hardcoded `~/.aletheia-v2/`), (b) preserving `claude-${PPID}.sock.path` pointer file convention.

**KG-stub verification (Phase 6 sub-task 6):**

Add code-comment markers at all 7 IS-6 stub locations referencing arranger-handoff.md. Verifier (Phase 6 task) greps for these markers and asserts each is present:

1. `src/injection/signal.rs` — `Signal` trait (stub #1)
2. `src/lib/settings/injection.rs::InjectionWeights` — HashMap (stub #2; established Phase 1)
3. `src/injection/context.rs::Context` — Option fields + serde defaults (stub #3)
4. `src/db/scope_schema.rs::MEMORY_JOURNAL_PROVENANCE_TABLE` — preserved (stub #4; established Phase 2)
5. `src/server/tools/memory_tools.rs::write_memory` dedup response — extensible struct (stub #5; established Phase 5)
6. `src/server/tools/discovery_tools.rs::show_related` — minimal MCP signature (stub #6; established Phase 5)
7. `src/server/tools/entry_tools.rs::query_past_state` — minimal MCP signature (stub #7; established Phase 5)

Each location gets a `// IS-6 KG forward-compat seam #N — see docs/plans/designs/decisions/aletheia-v2/arranger-handoff.md` comment.

<guidance>
**On scoring engine performance:** With ~5 attached scopes × ~500 candidates each = 2500 candidates per L2 invocation. Scoring is O(N × signals × weights lookup). For 4 signals × 2500 = 10k operations — trivial (<1ms). When V3 KG adds graph_proximity (which may involve graph traversal), the scoring cost grows. Consider caching scores in memory if profiling shows this becomes hot.

**On Context building:** The `Context` is built freshly per hook invocation. Read `session_locks` columns (active_project_id, active_context_tags_json, etc.) into the Context. Cache for the session lifetime if the hook frequency makes the SQL cost noticeable (~5 fields, a single SELECT — should be sub-millisecond).

**On `inferred_tags`:** Per design §5, "inferred from recent N tool calls' tag frequency." This requires tracking recent tool-call tag counts in `SessionState.access_counts` or a similar in-memory structure. Phase 6 task 5 (frequency manager) extends `SessionState` with this tracking.

**On the `peek-only handoff`:** `/handoff` endpoint is non-consuming (SELECT). The `read_handoff` MCP tool (Phase 5) is consuming (DELETE). Ensure two different code paths.

**On cross-scope GROUP BY for tag catalog:** Reading `active_tags` view from each attached scope and unioning is N queries. Acceptable for small N. If profiling shows latency, consider a denormalized tag_catalog table per scope (out of scope for V2; document as V2.1 optimization).
</guidance>

### Integration Points
- **IS-5 (hook endpoint payload format):** Phase 4 stubs are replaced by Phase 6 builders. Wire format is JSON (Q2). V1 hook scripts consume unchanged.
- **IS-6 (KG forward-compat — primary location):** All 7 stub patterns implemented or referenced here. Phase 6's verification task asserts the markers are in place.
- **Phase 5 (active context):** Phase 5's `set_active_project`/`set_active_context` tools UPDATE `session_locks` columns. Phase 6 reads those columns to build `Context`.
- **Phase 7 (digest):** Digest agent prompts (Phase 7) include the active feature's tags as part of synthesis context. The active feature's tags inherit to writes during the feature (Phase 5 auto-tagging).
- **Phase 9 (Shadow Mode):** Phase 9 wraps `ScoringEngine.score()` calls with sampling: when `[shadow.enabled]=true` and a sample fires, the engine ALSO computes a comparison ranking (V1-equivalent or V2-baseline; pluggable per CEO Item 1) and logs both + diff to `shadow_comparison_log`. Phase 6 exposes a hook function `with_shadow_observation(callback)` that Phase 9 implements.

### Expected Outcomes
- `cargo test` passes for all injection modules
- Hook endpoint `/state` and `/context` return non-trivial JSON when active feature exists
- Frequency manager's `tick()` returns (true, false) at call 10, (false, false) at calls 1-9, (true, true) at call 20
- Adaptive interval bump: write 2 identical L1 payloads back-to-back; verify `l1_current_interval` doubled (from 10 to 20)
- Threshold gate test: candidates scoring below `l1_threshold` excluded from output
- Token budget test: 100 candidates, budget=1000 tokens, ~50-token average → 20 entries selected (give or take based on actual scoring)
- Tie-break order test: 2 candidates same score, one Memory + one Journal → Memory first; same with recent vs older; same with critical vs non-critical
- KG-stub markers test: greps source for all 7 markers; all present
- E2E test: Phase 4's stubs replaced; full claim → write_memory → tick L1 → /state returns the memory in payload; tick L2 → /context returns memory + tag catalog
- V1 hook scripts unchanged from V1 wire perspective (hook test: parse old V1 hook payload format from the new V2 endpoints — must match)

### Testing Recommendations
- Property test: signal scores always in [0.0, 1.0]
- Property test: composite score is monotonically non-decreasing as more weights are added
- Unit test each signal individually with constructed candidates + contexts
- Integration test the full pipeline: insert 50 fake candidates, run scorer with various weights, verify ranking stability under weight permutations
- Test with V3-anticipated weight key: add `graph_proximity = 0.5` to settings.toml, verify scorer doesn't crash (weight key referencing missing signal → silently skip — verified)
- Test the IS-6 markers: parse source, count comment markers, assert exactly 7 (or 7 unique numbers)
- Test FrequencyManager concurrent access: spawn 100 threads each calling tick(), verify count is exactly 100 and no torn updates
- Test active context TTL: set context with ttl_minutes=1, advance time mock by 2 minutes, verify Context.active_context_tags is empty
</core>
</section>
<!-- /phase:6 -->

<!-- conductor-review:6 -->
<section id="conductor-review-6">
## Conductor Review: Post-Phase 6

<core>
### Verification Checklist

<mandatory>All checklist items must be verified before proceeding.</mandatory>

- [ ] **`Signal` trait is `dyn`-object-safe** — `ScoringEngine.signals: Vec<Box<dyn Signal>>` compiles (verifies trait object safety)
- [ ] **`InjectionWeights` HashMap typing PRESERVED** — read engine code, confirm `weights.0.get(name)` lookup pattern (NOT `weights.tag_overlap` field access)
- [ ] **`Context` extensibility verified** — struct has `Option<>` fields with `#[serde(default)]`; adding a hypothetical `graph_anchor_nodes: Option<Vec<String>>` field compiles without other changes
- [ ] All 7 IS-6 KG forward-compat code-comment markers present (run grep across `src/`)
- [ ] L1 endpoint returns JSON payload matching V1 wire format (test with V1 hook scripts unchanged)
- [ ] L2 endpoint returns JSON payload with `tag_catalog` field
- [ ] `/handoff` endpoint is NON-consuming (SELECT only); `read_handoff` MCP tool IS consuming (DELETE)
- [ ] Frequency manager tick() returns expected (l1, l2) tuples for known call counts
- [ ] Adaptive interval bump test: identical-payload pair triggers single bump (interval × 2 once); next change resets
- [ ] Threshold gate filters candidates correctly
- [ ] Tie-break order respected: memory > journal, recent > older, critical > non-critical
- [ ] Token budget never exceeded in selected output
- [ ] V1 hook scripts (sh + js) connect to V2 socket via pointer file, parse JSON, output to stdout
- [ ] `CONTEXT_PROJECT_MISMATCH` warn surfaces in `set_active_context` response when tags don't overlap with active project
- [ ] Phase 4 hook endpoint stubs REPLACED with real Phase 6 builders (no `"{}"` stubs remain for `/state` and `/context`)
- [ ] Run context compaction (`/lethe compact`) before launching Phase 8 (which depends on storage + auth + this injection layer for any user-facing outputs)

### Known Risks
- **Scoring-engine cold starts:** First L1/L2 invocation per session reads many entries. With ~5 scopes attached, this could be 100-500ms. If profiling shows hot-path latency, add a per-session candidate cache that invalidates on writes (track a `dirty_at` timestamp per scope).
- **`inferred_tags` from access counts:** The mechanism for tracking "recent tool calls' tag frequency" needs to be carefully integrated into Phase 5's tool wrappers. Risk: if a tool runs but doesn't update access_counts, the inferred_tags signal is incomplete. Recommend the access_counts update happens in `AuthContext::precheck()` (single call site).
- **Hook payload size:** With token_budget=3000 for L2, a typical payload is ~5-10KB JSON. Some shells / curls handle this fine; very long payloads might run into pipe-buffer issues with the hook scripts. V1's experience suggests this isn't a problem in practice; profile if reports surface.
- **`gather_l2_candidates` cross-scope SELECT:** Querying N attached scopes via `SELECT * FROM <alias>.entries WHERE valid_to IS NULL` requires N statements (one per attached scope). UNION ALL would work in one statement but requires constructing the SQL dynamically. Performance: with N=5 and 500 entries per scope, total candidates ~2500 — small. Profile if scopes grow large.
- **FrequencyManager state persistence:** State is in-memory; resets on MCP server restart. V1 had the same behavior (`POST /reset-frequency`). Acceptable.

### Guidance for Phase 8 (V1→V2 Migration)

<guidance>
**Phase 8 (V1→V2 Migration) and Phase 9 (Reconciliation + Operational Polish + Shadow Mode) can run in parallel** — they share `sys_audit_log` writes but no other files.

**Phase 8 sub-tasks** (6+ parallel — one per V1 table type):
1. V1 schema introspection (`src/migrate/v1_intro.rs`) — read V1's SQLite directly via rusqlite (read-only); enumerate scopes from V1's `entries.project_namespace`
2. Per-scope partitioning (`src/migrate/partition.rs`) — for each unique V1 namespace: mint scope_uuid, create `scopes/<scope_uuid>.db`, register in `scope_registry.db.scopes` row
3. Journal transform (`src/migrate/journal.rs`) — V1 `journal_entries` JOIN `entries` → V2 `entries` (entry_class=journal) with content_hash + valid_from + tags JSON
4. Memory transform (`src/migrate/memory.rs`) — V1 `memory_entries` (active + archived) + `memory_versions` → V2 `entries` (entry_class=memory) with **V1.key → tag** + entry_id_legacy tag (Q5A)
5. Status transform (`src/migrate/status.rs`) — V1 `status_documents` → V2 `entries` (entry_class=status) container; V1 `status_sections` → V2 `status_sections` with version=1
6. Handoff transform (`src/migrate/handoff.rs`) — V1 `handoffs` → V2 `entries` (entry_class=handoff)
7. Key migration (`src/migrate/keys.rs`) — V1 `keys` → V2 `keys` table; preserve V1 key_id, compute `key_hash` from raw values read from V1 key files (`~/.aletheia-v2/keys/<name>.key`)
8. Lazy first-claim trigger marker (`src/migrate/marker.rs`) — set `scopes.digest_pending_v1_migration=1` per scope; first claim of each scope kicks off digest pass
9. `migrate_from_v1` orchestrator (`src/migrate/orchestrator.rs`) — master-key gated; takes v1_db_path + confirm_backup_taken + dry_run; runs all transforms in one transaction per V2 .db; renames V1 DB to `*.bak`; writes migration report

Phase 8 has very high parallelism — all transform sub-tasks can run concurrently after partitioning + introspection complete.

**Phase 9 sub-tasks** (4 parallel):
1. Reconciler module (`src/reconciler/`) — scans sys_audit_log for orphaned events; per-operation recovery handlers
2. Tool deprecation lifecycle (`src/server/deprecation.rs`) — wraps tool responses with deprecated/removed metadata + audit emission with session-scoped dedup
3. Orphan sweepers (`src/sweepers/`) — session_id orphan sweep (5min), sdk-runtime/<queue_id>/ orphan cleanup (24h)
4. Shadow Mode infrastructure (`src/shadow/`) — sampling hook in scoring pipeline + shadow_comparison_log writes + analyze_shadow_mode tool

Context management: Run `/lethe compact` before launching Phase 8 + 9.
</guidance>
</core>
</section>
<!-- /conductor-review:6 -->

<!-- phase:7 -->
<section id="phase-7">
## Phase 7: Digest Pipeline + Mass-Ingest

<core>
### Objective
Build the digest pipeline that replaces V1's tmux-spawned teammate with an SDK subprocess orchestrated via the shared `digest_queue` table, plus the mass-ingest approval flow for bulk operations bypassing normal digest budgets. The OAuth-preserving SDK launch flag combination (Phase 2 finding 11) is implemented here. After Phase 7, digest triggers fire on natural boundaries (feature_wrap, session_end, supervisor approval, count threshold), get queued, lease-recovered on crash, and execute as Claude Code subprocesses with a locked tool surface.

### Prerequisites
- Phase 2 complete: `digest_queue`, `mass_ingest_requests`, `mass_ingest_checkpoints` tables; `sys_audit_log` with `digest.*` event vocabulary
- Phase 4 complete: `ServerRegistry` ready to receive `register_digest_queue_poller(&mut registry, ...)` + `register_mass_ingest_poller(&mut registry, ...)` calls
- Phase 5 complete: `feature_init`/`feature_wrap_up`/`abandon_feature` enqueue digest rows; `update_status` reads/writes the approval status doc; `read_status` returns approval status
- `claude` CLI on PATH (the SDK subprocess shells out to it). Verified version compatibility with the OAuth-preserving flag set (CC 2.1.119 confirmed in Phase 2)

### Implementation

<mandatory>The SDK subprocess launch MUST use the OAuth-preserving flag combination from Phase 2 finding 11 EXACTLY. NO flag may be omitted, reordered conceptually, or substituted. Specifically: `claude -p "<prompt>" --mcp-config <inline> --strict-mcp-config --settings '{"claudeMdExcludes":["**/*"],"hooks":{},"enabledPlugins":{}}' --setting-sources local --disable-slash-commands --allowed-tools "mcp__aletheia__*" --tools "" --permission-mode bypassPermissions --no-session-persistence --model <opus|opus[1m]> --output-format stream-json`. **Do NOT use `--bare`** — `--bare` disables OAuth/keychain reads; subscription users would lose subscription billing. The combination above achieves equivalent isolation while preserving inherited OAuth from `~/.claude/.credentials.json`.</mandatory>

<mandatory>The SDK subprocess MUST be spawned with `tokio::process::Command` configured `.kill_on_drop(true)` so a dropped child handle SIGKILLs the subprocess. Required for lease-expiry cleanup: when a lease expires mid-digest, the parent MCP server's lease-recovery logic ABORTs the spawn task; without `kill_on_drop`, the orphaned subprocess continues consuming tokens.</mandatory>

<mandatory>The SDK subprocess cwd MUST be `~/.aletheia-v2/sdk-runtime/<queue_id>/` (Q3). MCP server creates the directory with `mkdir -p` (idempotent — handles parallel digest spawns) before spawn; deletes on success commit; preserves on failure for forensics. Background sweeper (Phase 9) cleans orphans older than 24h.</mandatory>

<mandatory>The digest_queue background poller MUST use the SQL `UPDATE ... WHERE status='pending' RETURNING *` pattern to atomically lease a queue row. Multiple MCP server processes race on this UPDATE; only one wins per row. NO `SELECT then UPDATE` race-prone pattern.</mandatory>

<mandatory>Mass-ingest approval semantics are FIRST-APPROVAL-LOCKS (CEO Item 8). Once the polling server observes `approved=true` on a `mass_ingest_requests` row, subsequent flips of the approval section are IGNORED until the request is re-issued via `request_mass_ingest`. Implement by setting `mass_ingest_requests.status = 'approved'` atomically with the digest_queue enqueue; subsequent polls see status != 'pending' and skip the row.</mandatory>

**Module structure (added in Phase 7):**

```
src/
├── digest/
│   ├── mod.rs                 # Aggregator
│   ├── queue.rs               # digest_queue ops: enqueue, dedup, lease (atomic), commit, fail
│   ├── poller.rs              # Background poller (60s cadence) — leases + crash recovery
│   ├── sdk_subprocess.rs      # OAuth-preserving launch + cwd setup + kill_on_drop + stdout drain
│   ├── agent_prompt.rs        # System prompt + per-trigger user prompt template for the SDK agent
│   ├── triggers.rs            # Trigger emitter helpers — feature_init/wrap/abandon, session_end, count threshold, time threshold, manual, mass_ingest, retention_purge
│   ├── retention_purge.rs     # In-process pure-SQL purge (no LLM); uses `_audit_log_unlock` pattern for sys_audit_log
│   ├── mass_ingest.rs         # request_mass_ingest tool + approval status doc + 30s polling + first-approval-locks
│   └── checkpoint.rs          # mass_ingest_checkpoints ops (write per N entries / M minutes; resume reads latest)
└── server/tools/
    └── digest_tools.rs        # MCP tools: request_mass_ingest, get_mass_ingest_status, list_digest_queue (master-key)
```

**Digest queue operations (`src/digest/queue.rs`):**

```rust
use rusqlite::Connection;
use crate::error::Result;
use crate::types::scope::ScopeId;

#[derive(Debug, Clone, Copy)]
pub enum TriggerType {
    EntryThreshold, TimeThreshold, SessionEnd, FeatureWrap, FeatureInit, Manual, MassIngest, RetentionPurge,
}

impl TriggerType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::EntryThreshold => "entry_threshold",
            Self::TimeThreshold => "time_threshold",
            Self::SessionEnd => "session_end",
            Self::FeatureWrap => "feature_wrap",
            Self::FeatureInit => "feature_init",
            Self::Manual => "manual",
            Self::MassIngest => "mass_ingest",
            Self::RetentionPurge => "retention_purge",
        }
    }
    pub fn trigger_class(&self) -> &'static str {
        // Used for dedup grouping. Distinct triggers may share a class if they should dedup.
        // For V2: each trigger type is its own class (no merging).
        self.as_str()
    }
}

#[derive(Debug)]
pub struct EnqueueResult {
    pub queue_id: i64,
    pub deduped: bool,
    pub existing_queue_id: Option<i64>,
}

/// Enqueues a digest job. Returns DUPLICATE_QUEUED if same (scope, trigger_class) is already pending or leased.
/// Visible-dedup principle: caller surfaces this in the response.
pub fn enqueue(
    conn: &Connection,
    scope_id: &ScopeId,
    trigger_type: TriggerType,
    trigger_metadata: Option<&serde_json::Value>,
) -> Result<EnqueueResult> {
    // Dedup check
    let existing: Option<i64> = conn.query_row(
        "SELECT queue_id FROM digest_queue WHERE scope_id = ? AND trigger_type = ? AND status IN ('pending','leased') ORDER BY queue_id LIMIT 1",
        rusqlite::params![scope_id.0, trigger_type.as_str()],
        |row| row.get(0),
    ).optional()?;

    if let Some(existing_id) = existing {
        return Ok(EnqueueResult { queue_id: existing_id, deduped: true, existing_queue_id: Some(existing_id) });
    }

    let metadata_json = trigger_metadata.map(serde_json::to_string).transpose()?;
    conn.execute(
        "INSERT INTO digest_queue (scope_id, trigger_type, trigger_metadata, status) VALUES (?, ?, ?, 'pending')",
        rusqlite::params![scope_id.0, trigger_type.as_str(), metadata_json],
    )?;
    let queue_id = conn.last_insert_rowid();

    crate::db::audit_log::emit_event(
        conn, crate::types::audit::AuditEventCategory::Digest, "digest_queued",
        Some(&scope_id.0), None, None,
        Some(&serde_json::json!({"queue_id": queue_id, "trigger_type": trigger_type.as_str()}))
    )?;

    Ok(EnqueueResult { queue_id, deduped: false, existing_queue_id: None })
}

#[derive(Debug, Clone)]
pub struct LeasedJob {
    pub queue_id: i64,
    pub scope_id: ScopeId,
    pub trigger_type: TriggerType,
    pub trigger_metadata: Option<serde_json::Value>,
    pub retry_count: u32,
}

/// Atomic lease via UPDATE ... RETURNING (Phase 2 finding 9 / B1).
/// Returns None if no leasable rows; LeasedJob if we won a row.
pub fn try_lease(conn: &Connection, lease_ttl_minutes: u32) -> Result<Option<LeasedJob>> {
    let pid = std::process::id() as i64;
    let lease_expires_at = chrono::Utc::now() + chrono::Duration::minutes(lease_ttl_minutes as i64);

    // Pick the oldest pending row whose retry_count is below max
    let row: Option<(i64, String, String, Option<String>, u32)> = conn.query_row(
        "UPDATE digest_queue SET status='leased', leased_by_pid=?, lease_expires_at=?, started_at=CURRENT_TIMESTAMP
         WHERE queue_id = (
           SELECT queue_id FROM digest_queue
           WHERE status='pending' AND retry_count < 5
           ORDER BY queue_id LIMIT 1
         )
         RETURNING queue_id, scope_id, trigger_type, trigger_metadata, retry_count",
        rusqlite::params![pid, lease_expires_at.to_rfc3339()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional()?;

    match row {
        None => Ok(None),
        Some((queue_id, scope_id_s, trigger_s, metadata_s, retry_count)) => {
            let trigger_type = parse_trigger_type(&trigger_s)?;
            let metadata = metadata_s.as_deref().map(serde_json::from_str).transpose()?;
            crate::db::audit_log::emit_event(
                conn, crate::types::audit::AuditEventCategory::Digest, "digest_leased",
                Some(&scope_id_s), None, None,
                Some(&serde_json::json!({"queue_id": queue_id, "leased_by_pid": pid}))
            )?;
            Ok(Some(LeasedJob {
                queue_id,
                scope_id: ScopeId(scope_id_s),
                trigger_type,
                trigger_metadata: metadata,
                retry_count,
            }))
        }
    }
}

pub fn commit(conn: &Connection, queue_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE digest_queue SET status='committed', committed_at=CURRENT_TIMESTAMP, lease_expires_at=NULL WHERE queue_id=?",
        rusqlite::params![queue_id],
    )?;
    crate::db::audit_log::emit_event(
        conn, crate::types::audit::AuditEventCategory::Digest, "digest_committed",
        None, None, None, Some(&serde_json::json!({"queue_id": queue_id}))
    )?;
    Ok(())
}

pub fn fail(conn: &Connection, queue_id: i64, error_message: &str, retry: bool) -> Result<()> {
    if retry {
        conn.execute(
            "UPDATE digest_queue SET status='pending', leased_by_pid=NULL, lease_expires_at=NULL, retry_count=retry_count+1, error_message=? WHERE queue_id=?",
            rusqlite::params![error_message, queue_id],
        )?;
        crate::db::audit_log::emit_event(
            conn, crate::types::audit::AuditEventCategory::Digest, "digest_retried",
            None, None, None, Some(&serde_json::json!({"queue_id": queue_id, "error": error_message}))
        )?;
    } else {
        conn.execute(
            "UPDATE digest_queue SET status='failed', error_message=? WHERE queue_id=?",
            rusqlite::params![error_message, queue_id],
        )?;
        crate::db::audit_log::emit_event(
            conn, crate::types::audit::AuditEventCategory::Digest, "digest_failed",
            None, None, None, Some(&serde_json::json!({"queue_id": queue_id, "error": error_message}))
        )?;
    }
    Ok(())
}

/// Crash recovery: re-queue rows whose lease expired.
pub fn recover_expired_leases(conn: &Connection) -> Result<usize> {
    let rows = conn.execute(
        "UPDATE digest_queue SET status='pending', leased_by_pid=NULL, lease_expires_at=NULL, retry_count=retry_count+1
         WHERE status='leased' AND lease_expires_at < CURRENT_TIMESTAMP",
        [],
    )?;
    if rows > 0 {
        crate::db::audit_log::emit_event(
            conn, crate::types::audit::AuditEventCategory::Digest, "digest_lease_recovered",
            None, None, None, Some(&serde_json::json!({"count": rows}))
        )?;
    }
    Ok(rows)
}

fn parse_trigger_type(s: &str) -> Result<TriggerType> { /* match s { "entry_threshold" => Ok(TriggerType::EntryThreshold), ... } */ todo!() }
```

**Background poller (`src/digest/poller.rs`):**

```rust
use std::sync::Arc;
use tokio::sync::Mutex;
use rusqlite::Connection;
use std::time::Duration;
use crate::lib::settings::Settings;
use crate::error::Result;

pub fn register_digest_queue_poller(
    registry: &mut crate::server::index::ServerRegistry,
    conn: Arc<Mutex<Connection>>,
    settings: Settings,
    data_dir: std::path::PathBuf,
) -> Result<()> {
    let interval_secs = settings.digest_queue.poll_interval_seconds;
    let lease_ttl_minutes = settings.digest_queue.default_lease_ttl_minutes;

    registry.spawn_bg("digest-queue-poller", async move {
        let mut tick = tokio::time::interval(Duration::from_secs(interval_secs as u64));
        loop {
            tick.tick().await;

            // 1. Recover expired leases
            {
                let c = conn.lock().await;
                let _ = crate::digest::queue::recover_expired_leases(&c);
            }

            // 2. Try to lease a job
            let job = {
                let c = conn.lock().await;
                crate::digest::queue::try_lease(&c, lease_ttl_minutes).ok().flatten()
            };

            if let Some(job) = job {
                // 3. Spawn SDK subprocess (or in-process for retention_purge)
                let conn_for_job = conn.clone();
                let settings_for_job = settings.clone();
                let data_dir_for_job = data_dir.clone();
                tokio::spawn(async move {
                    let result = match job.trigger_type {
                        crate::digest::queue::TriggerType::RetentionPurge => {
                            // In-process pure-SQL DELETE; no LLM
                            crate::digest::retention_purge::run_in_process(conn_for_job.clone(), &settings_for_job, &job).await
                        }
                        _ => {
                            // SDK subprocess
                            crate::digest::sdk_subprocess::run_digest(conn_for_job.clone(), &settings_for_job, &data_dir_for_job, &job).await
                        }
                    };
                    let c = conn_for_job.lock().await;
                    match result {
                        Ok(_) => { let _ = crate::digest::queue::commit(&c, job.queue_id); }
                        Err(e) => {
                            let retry = job.retry_count + 1 < settings_for_job.digest_queue.max_retries;
                            let _ = crate::digest::queue::fail(&c, job.queue_id, &e.to_string(), retry);
                        }
                    }
                });
            }
        }
    });
    Ok(())
}
```

**SDK subprocess launch (`src/digest/sdk_subprocess.rs`) — the OAuth-preserving flag combination:**

```rust
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::process::Command;
use tokio::io::{AsyncReadExt, AsyncBufReadExt, BufReader};
use std::process::Stdio;
use std::path::Path;
use rusqlite::Connection;
use crate::lib::settings::Settings;
use crate::error::{Result, AletheiaError};
use crate::digest::queue::LeasedJob;

pub async fn run_digest(
    conn: Arc<Mutex<Connection>>,
    settings: &Settings,
    data_dir: &Path,
    job: &LeasedJob,
) -> Result<()> {
    // 1. Prepare cwd: ~/.aletheia-v2/sdk-runtime/<queue_id>/
    let cwd = data_dir.join("sdk-runtime").join(job.queue_id.to_string());
    std::fs::create_dir_all(&cwd)?;

    // 2. Fetch the digest key for this scope
    let digest_key = {
        let c = conn.lock().await;
        load_digest_key_for_scope(&c, &job.scope_id, data_dir)?
    };

    // 3. Build the inline MCP config pointing at the running parent MCP server's socket
    let socket_path = data_dir.join("sockets").join(format!("aletheia-v2-{}.sock", std::process::id()));
    let mcp_config = serde_json::json!({
        "mcpServers": {
            "aletheia-v2": {
                "command": std::env::current_exe()?.to_string_lossy(),  // re-invoke our own binary
                "args": ["serve", "--socket-client", socket_path.to_string_lossy().to_string()],
                "env": {
                    "ALETHEIA_DIGEST_KEY": digest_key.0.clone(),
                    "ALETHEIA_DIGEST_QUEUE_ID": job.queue_id.to_string(),
                }
            }
        }
    });
    let mcp_config_path = cwd.join("mcp-config.json");
    std::fs::write(&mcp_config_path, mcp_config.to_string())?;

    // 4. Build the inline settings (NO CLAUDE.md walk, NO hooks, NO plugins)
    let inline_settings = serde_json::json!({
        "claudeMdExcludes": ["**/*"],
        "hooks": {},
        "enabledPlugins": {}
    });

    // 5. Build digest agent prompt
    let prompt = crate::digest::agent_prompt::build_prompt(&job, &settings)?;

    // 6. Determine model + lease TTL based on trigger
    let (model, lease_ttl_minutes) = match job.trigger_type {
        crate::digest::queue::TriggerType::MassIngest => ("opus[1m]", settings.digest_queue.mass_ingest_lease_ttl_minutes),
        _ => ("opus", settings.digest_queue.default_lease_ttl_minutes),
    };

    // 7. Spawn — OAuth-preserving combination per Phase 2 finding 11
    let mut cmd = Command::new("claude");
    cmd.current_dir(&cwd)
        .arg("-p").arg(&prompt)
        .arg("--mcp-config").arg(&mcp_config_path)
        .arg("--strict-mcp-config")
        .arg("--settings").arg(inline_settings.to_string())
        .arg("--setting-sources").arg("local")
        .arg("--disable-slash-commands")
        .arg("--allowed-tools").arg("mcp__aletheia__*")
        .arg("--tools").arg("")
        .arg("--permission-mode").arg("bypassPermissions")
        .arg("--no-session-persistence")
        .arg("--model").arg(model)
        .arg("--output-format").arg("stream-json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);  // CRITICAL: lease-expiry safety

    tracing::info!("spawning digest subprocess: queue_id={} scope={} trigger={:?} model={}", job.queue_id, job.scope_id.0, job.trigger_type, model);

    let mut child = cmd.spawn()
        .map_err(|e| AletheiaError::Other(format!("spawn claude: {}", e)))?;

    // 8. Concurrently drain stdout + stderr (avoids pipe-buffer deadlock)
    let stdout = child.stdout.take().ok_or_else(|| AletheiaError::Other("no stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| AletheiaError::Other("no stderr".into()))?;

    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Some(line) = reader.next_line().await.ok().flatten() {
            tracing::debug!(target: "digest.stdout", "{}", line);
        }
    });
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Some(line) = reader.next_line().await.ok().flatten() {
            tracing::warn!(target: "digest.stderr", "{}", line);
        }
    });

    // 9. Wait with timeout (lease TTL)
    let timeout = tokio::time::Duration::from_secs(lease_ttl_minutes as u64 * 60);
    let exit_status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => { let _ = child.kill().await; return Err(AletheiaError::Other(format!("wait: {}", e))); }
        Err(_) => { let _ = child.kill().await; return Err(AletheiaError::Other("digest subprocess timeout (lease expired)".into())); }
    };

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    if !exit_status.success() {
        return Err(AletheiaError::Other(format!("digest subprocess failed: {}", exit_status)));
    }

    // 10. Cleanup cwd on success
    let _ = std::fs::remove_dir_all(&cwd);
    Ok(())
}

fn load_digest_key_for_scope(_conn: &Connection, _scope_id: &crate::types::scope::ScopeId, _data_dir: &Path) -> Result<crate::types::key::KeyValue> {
    // Look up keys.is_digest_key=1 AND keys.digest_for_scope_id=scope_id; load raw value from key file
    todo!("load digest key")
}
```

**Digest agent prompt template (`src/digest/agent_prompt.rs`):**

The prompt explains the agent's role to the SDK Claude. Per-trigger variants tailor focus:

```rust
use crate::digest::queue::{LeasedJob, TriggerType};
use crate::lib::settings::Settings;
use crate::error::Result;

pub fn build_prompt(job: &LeasedJob, _settings: &Settings) -> Result<String> {
    let role = base_role();
    let task = match job.trigger_type {
        TriggerType::EntryThreshold | TriggerType::TimeThreshold => entry_threshold_task(job),
        TriggerType::SessionEnd => session_end_task(job),
        TriggerType::FeatureWrap => feature_wrap_task(job),
        TriggerType::FeatureInit => feature_init_task(job),
        TriggerType::Manual => manual_task(job),
        TriggerType::MassIngest => mass_ingest_task(job),
        TriggerType::RetentionPurge => unreachable!("retention purge runs in-process"),
    };
    Ok(format!("{}\n\n{}", role, task))
}

fn base_role() -> &'static str {
    r#"You are the Aletheia Digest Agent — a background subprocess synthesizing memories from journal entries.

You have access to ONLY these tools (via the MCP server registered as `aletheia-v2`):
- mcp__aletheia__list_entries, read, search, list_tags, show_related (discovery)
- mcp__aletheia__write_memory, retire_memory, read_memory_history (memory)
- mcp__aletheia__write_journal (write your own journal of what you observed)
- mcp__aletheia__query_past_state, query_entry_history (time-travel)
- mcp__aletheia__whoami (verify your authentication)

You CANNOT use Edit, Write, Bash, Read, Glob, Grep, or any built-in tools — these are disabled. ALL data access flows through the Aletheia MCP server.

Your goal: produce high-quality, deduplicated, well-tagged memory entries that the working session will benefit from on next L1/L2 injection.

Critical rules:
1. **Dedup first.** Before writing any memory, search for similar existing memories via `search` or `list_entries`. If `write_memory` returns `<duplicate>`, the content was already stored — do NOT retry, move on.
2. **Tag richly.** Every memory should have 3-5 relevant tags. Tags are how the relevance scorer finds memories later.
3. **Be concise.** Memories are injected into Claude's context budget. Synthesize, don't dump.
4. **Mark journals as digested.** After synthesizing memories from a journal, the MCP server will track this via `digested_at`. You don't need to explicitly mark — `write_memory` with `memory_summary` referencing journal entries auto-updates.
5. **If unsure, prefer NOT writing.** Wrong memories are worse than missing memories.

Exit when your synthesis is complete."#
}

fn entry_threshold_task(job: &LeasedJob) -> String {
    format!(r#"Trigger: entry_threshold/time_threshold for scope {}.

Steps:
1. Call `whoami` to confirm auth.
2. Call `list_entries(entry_class="journal")` to get all undigested journal entries (server filters by digested_at IS NULL automatically).
3. For each cluster of related journals, synthesize 1-2 memory entries.
4. Use `search` to dedup-check before writing each memory.
5. Exit when done.

Budget: stay within 200k tokens (this is opus, not opus[1m]).
"#, job.scope_id.0)
}

fn feature_wrap_task(job: &LeasedJob) -> String {
    format!(r#"Trigger: feature_wrap for scope {}.

The feature has wrapped up. Synthesize durable memories capturing the feature's learnings.

Steps:
1. Call `whoami` to confirm auth.
2. Call `list_entries(tags=feature_tags)` to find all entries tagged with this feature.
3. Synthesize 3-7 high-quality memories: key decisions, gotchas, code patterns, integration points.
4. Tag each memory with the feature_tags + a domain tag.
5. If `archive_policy=tombstone` (passed in trigger_metadata), call `retire_memory` on feature-only ephemerals after synthesis.
6. Exit when done.

Budget: 200k tokens.
"#, job.scope_id.0)
}

fn mass_ingest_task(job: &LeasedJob) -> String {
    format!(r#"Trigger: mass_ingest for scope {}.

Bulk operation approved by supervisor. You have access to opus[1m] (1M context window) and 3h lease.

Steps:
1. Call `whoami` to confirm auth.
2. Read the mass_ingest_requests row (request_id in trigger_metadata) for the operation description.
3. Process all source entries per the operation spec. WRITE CHECKPOINTS via the implicit checkpointing layer (server tracks processed_count automatically when you call write_memory in batches).
4. If you need to resume from a checkpoint, the server will inject a `<resume_state>` notice in your first prompt context.
5. On completion, call no specific tool — just exit cleanly.

Critical for resume: do NOT keep raw sensitive content in your reasoning chain. The checkpoint resume_state JSON should be opaque structural state only (counts, IDs).
"#, job.scope_id.0)
}

fn session_end_task(_job: &LeasedJob) -> String { "...".into() }
fn feature_init_task(_job: &LeasedJob) -> String { "...".into() }
fn manual_task(_job: &LeasedJob) -> String { "...".into() }
```

**Mass-ingest approval flow (`src/digest/mass_ingest.rs`):**

```rust
use std::sync::Arc;
use tokio::sync::Mutex;
use rusqlite::Connection;
use crate::error::Result;
use crate::types::scope::ScopeId;
use crate::lib::settings::Settings;

#[derive(Debug)]
pub struct MassIngestRequest {
    pub request_id: String,
    pub requester_key_hash: String,
    pub scope_id: ScopeId,
    pub operation: String,
    pub summary: String,
    pub justification: String,
    pub estimated_entry_count: Option<u32>,
    pub source_reference: Option<String>,
    pub approval_status_entry_id: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

pub fn create_request(
    conn: &Connection,
    requester_key_hash: &str,
    scope_id: &ScopeId,
    operation: &str,
    summary: &str,
    justification: &str,
    estimated_entry_count: Option<u32>,
    source_reference: Option<&str>,
    approval_ttl_hours: u32,
) -> Result<MassIngestRequest> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let expires_at = chrono::Utc::now() + chrono::Duration::hours(approval_ttl_hours as i64);

    // Create approval status entry — Phase 5's add_section flow used here
    let status_entry_id = create_approval_status_entry(conn, scope_id, &request_id, summary)?;

    conn.execute(
        "INSERT INTO mass_ingest_requests (request_id, requester_key_hash, scope_id, operation, summary, justification, estimated_entry_count, source_reference, approval_status_entry_id, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
        rusqlite::params![&request_id, requester_key_hash, scope_id.0, operation, summary, justification, estimated_entry_count, source_reference, &status_entry_id, expires_at.to_rfc3339()],
    )?;

    crate::db::audit_log::emit_event(
        conn, crate::types::audit::AuditEventCategory::Digest, "mass_ingest_requested",
        Some(&scope_id.0), Some(requester_key_hash), None,
        Some(&serde_json::json!({"request_id": &request_id, "estimated_entry_count": estimated_entry_count}))
    )?;

    Ok(MassIngestRequest { /* fields */ })
}

fn create_approval_status_entry(_conn: &Connection, _scope_id: &ScopeId, _request_id: &str, _summary: &str) -> Result<String> {
    // Insert into entries (entry_class=status) + status_sections rows for sections: 'summary', 'justification', 'approval' (state="pending")
    todo!("create approval status doc")
}

pub fn register_mass_ingest_poller(
    registry: &mut crate::server::index::ServerRegistry,
    conn: Arc<Mutex<Connection>>,
    settings: Settings,
) -> Result<()> {
    let interval_secs = settings.mass_ingest.approval_polling_interval_seconds;
    let self_approval_policy = settings.mass_ingest.self_approval_policy.clone();

    registry.spawn_bg("mass-ingest-approval-poller", async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(interval_secs as u64));
        loop {
            tick.tick().await;
            let c = conn.lock().await;

            // Expire stale requests
            let _ = c.execute(
                "UPDATE mass_ingest_requests SET status='expired' WHERE status='pending' AND expires_at < CURRENT_TIMESTAMP",
                [],
            );

            // Find pending requests with approved=true in the status doc
            let approved: Vec<(String, String, String)> = c.prepare(
                "SELECT request_id, scope_id, approval_status_entry_id FROM mass_ingest_requests WHERE status='pending'"
            ).and_then(|mut s| s.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).and_then(|i| i.collect())).unwrap_or_default();

            for (request_id, scope_id_s, status_entry_id) in approved {
                if check_approval_status(&c, &status_entry_id, &request_id, &self_approval_policy).unwrap_or(false) {
                    // Atomically mark approved + enqueue digest_queue (first-approval-locks per CEO Item 8)
                    if let Ok(()) = approve_and_enqueue(&c, &request_id, &ScopeId(scope_id_s)) {
                        let _ = crate::db::audit_log::emit_event(
                            &c, crate::types::audit::AuditEventCategory::Digest, "mass_ingest_approved",
                            None, None, None, Some(&serde_json::json!({"request_id": &request_id}))
                        );
                    }
                }
            }
        }
    });
    Ok(())
}

fn check_approval_status(_conn: &Connection, _status_entry_id: &str, _request_id: &str, _self_approval_policy: &str) -> Result<bool> {
    // Read the 'approval' section from the status doc; check approved=true; verify approver vs requester per self_approval_policy
    todo!("read approval section")
}

fn approve_and_enqueue(conn: &Connection, request_id: &str, scope_id: &ScopeId) -> Result<()> {
    let tx_started = conn.execute_batch("BEGIN IMMEDIATE")?;
    let result: Result<()> = (|| {
        // Atomically lock — set status='approved', then enqueue
        let updated = conn.execute(
            "UPDATE mass_ingest_requests SET status='approved', approved_at=CURRENT_TIMESTAMP WHERE request_id=? AND status='pending'",
            rusqlite::params![request_id],
        )?;
        if updated == 0 {
            // Race lost (another poller already approved); skip silently
            return Ok(());
        }
        let enq = crate::digest::queue::enqueue(
            conn, scope_id,
            crate::digest::queue::TriggerType::MassIngest,
            Some(&serde_json::json!({"request_id": request_id})),
        )?;
        conn.execute(
            "UPDATE mass_ingest_requests SET digest_queue_id=? WHERE request_id=?",
            rusqlite::params![enq.queue_id, request_id],
        )?;
        Ok(())
    })();
    match result {
        Ok(()) => { conn.execute_batch("COMMIT")?; Ok(()) }
        Err(e) => { conn.execute_batch("ROLLBACK")?; Err(e) }
    }
}
```

**Checkpointing (`src/digest/checkpoint.rs`):**

```rust
pub fn write_checkpoint(conn: &rusqlite::Connection, request_id: &str, processed_count: u32, resume_state: &serde_json::Value) -> crate::error::Result<()> {
    conn.execute(
        "INSERT INTO mass_ingest_checkpoints (request_id, processed_count, resume_state) VALUES (?, ?, ?)",
        rusqlite::params![request_id, processed_count, resume_state.to_string()],
    )?;
    crate::db::audit_log::emit_event(
        conn, crate::types::audit::AuditEventCategory::Digest, "mass_ingest_checkpoint",
        None, None, None, Some(&serde_json::json!({"request_id": request_id, "processed_count": processed_count}))
    )?;
    Ok(())
}

pub fn latest_checkpoint(conn: &rusqlite::Connection, request_id: &str) -> crate::error::Result<Option<(u32, serde_json::Value)>> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT processed_count, resume_state FROM mass_ingest_checkpoints WHERE request_id=? ORDER BY checkpoint_at DESC LIMIT 1",
        rusqlite::params![request_id],
        |row| Ok((row.get::<_, u32>(0)?, serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(1)?).unwrap_or(serde_json::Value::Null))),
    ).optional().map_err(Into::into)
}
```

**Retention purge (`src/digest/retention_purge.rs`) — pure SQL, no LLM:**

Runs in-process when triggered as a `retention_purge` queue row. Deletes from `entries` and `status_sections` where `valid_to IS NOT NULL AND valid_to < NOW - retention_days`. For sys_audit_log, uses the `_audit_log_unlock` pattern.

**Trigger emitters (`src/digest/triggers.rs`):**

Helper functions called from Phase 5's tools:

```rust
pub fn after_feature_wrap_up(conn: &rusqlite::Connection, scope_id: &ScopeId, feature_id: &str) -> crate::error::Result<()> {
    let _ = crate::digest::queue::enqueue(conn, scope_id, crate::digest::queue::TriggerType::FeatureWrap, Some(&serde_json::json!({"feature_id": feature_id})))?;
    Ok(())
}

pub fn after_journal_write_check_threshold(
    conn: &rusqlite::Connection,
    scope_id: &ScopeId,
    settings: &crate::lib::settings::Settings,
) -> crate::error::Result<()> {
    let undigested: u64 = conn.query_row(
        // Query attached scope alias dynamically; simplified here
        "SELECT COUNT(*) FROM entries WHERE entry_class='journal' AND digested_at IS NULL",
        [], |row| row.get(0),
    )?;
    let threshold = settings.digest.entry_threshold;  // 50 default per CEO Item 3
    if undigested >= threshold as u64 {
        let _ = crate::digest::queue::enqueue(conn, scope_id, crate::digest::queue::TriggerType::EntryThreshold, None)?;
    }
    Ok(())
}
```

**MCP tools (`src/server/tools/digest_tools.rs`):**

`request_mass_ingest`, `get_mass_ingest_status`, `list_digest_queue` (master-key only).

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct RequestMassIngestParams {
    pub operation: String,
    pub summary: String,
    pub justification: String,
    pub estimated_entry_count: Option<u32>,
    pub source_reference: Option<String>,
    pub scope_id: Option<String>,
}
```

<guidance>
**On `--socket-client` mode:** The SDK subprocess's MCP config calls back into the SAME aletheia-v2 binary (`std::env::current_exe()`) with a `serve --socket-client <socket>` subcommand. This is a NEW subcommand we add — a thin client that proxies stdio MCP into Unix socket calls to the parent's MCP server. Phase 4 establishes the server side; Phase 7 adds the client subcommand. Alternative: spin up a fresh full MCP server in the subprocess (heavier; risks DB connection contention). The proxy is lighter and reuses the parent's existing SQLite connection.

**On stdout/stderr draining:** The example uses concurrent `tokio::spawn` tasks for stdout and stderr. CRITICAL — if you call `child.wait()` without draining stdout/stderr, the OS pipe buffer fills (~64KB) and the subprocess blocks. The 3-task pattern (wait + stdout drain + stderr drain) is the safe way.

**On lease TTL vs subprocess timeout:** Lease TTL (30min default; 3h for mass_ingest) is the database-level recovery time. The subprocess timeout (`tokio::time::timeout`) matches the lease TTL — they're the same value. If the subprocess hangs past the timeout, we kill it; the lease will expire shortly and the queue row re-leases (with retry_count++).

**On digest key loading:** Each scope has a dedicated digest key (per design Topic 7). Phase 7's `load_digest_key_for_scope` queries `keys WHERE is_digest_key=1 AND digest_for_scope_id=?`, then reads the raw value from `~/.aletheia-v2/keys/digest-<scope_uuid>.key`. Phase 5's auth tool surface includes `rotate_digest_key(scope_id)` for key rotation.

**On the digest agent's MCP key:** The subprocess authenticates as the digest key (passed via `ALETHEIA_DIGEST_KEY` env var; the socket-client subcommand reads this and calls `claim()` automatically on init). The digest key has narrow permissions: read journal/memory in own scope + readable ancestors; write memory in own scope; retire memory in own scope; update digested_at. NOT allowed: write to ancestors, create_key/modify_key, cross-scope writes (per design Topic 7).

**On `--output-format stream-json`:** The subprocess streams turn-by-turn output as JSON-lines on stdout. The parent can monitor progress (e.g., for live logging via tracing::debug!) without blocking on subprocess completion.

**On the `--socket-client` subcommand security:** The subprocess connects to the parent via Unix socket. The socket file has mode 0600 — only the user can connect. The digest key is the auth gate, not the socket. The `--socket-client` subcommand spawns a thin MCP server on stdio (for the rmcp `--mcp-config` to talk to) and proxies tool calls to the parent via the socket. Implementing this proxy is a Phase 7 sub-task (~150 lines).
</guidance>

### Integration Points
- **IS-7 (digest_queue + SDK subprocess → MCP tools):** SDK subprocess invokes `mcp__aletheia__*` tools. Tools accept the digest key for narrow auth (`is_digest_key=1`).
- **Phase 4 Registrar:** `register_digest_queue_poller` and `register_mass_ingest_poller` registered in `start_server()` via uncommenting the lines.
- **Phase 5 → Phase 7:** Phase 5's `feature_init`/`feature_wrap_up`/`abandon_feature` call Phase 7's `triggers::*` helpers. Phase 5's `request_mass_ingest` MCP tool calls Phase 7's `mass_ingest::create_request`. Phase 5's `update_status` is the supervisor approval interface (sets `approved=true` in the approval status doc; Phase 7's poller picks it up).
- **Phase 6 (journal write triggers digest):** Phase 5's `write_journal` calls `triggers::after_journal_write_check_threshold` to decide if entry_threshold trigger fires.
- **Phase 8 (V1→V2 migration):** Migration sets `scopes.digest_pending_v1_migration=1`; Phase 7's poller (or Phase 3's claim flow on first claim of each scope) checks this flag and enqueues an entry_threshold-trigger digest job to handle the imported V1 corpus per scope.
- **Phase 9 (reconciliation):** Reconciler verifies digest_queue's `*_started` events have matching `*_committed` events; orphans get retried or marked failed.

### Expected Outcomes
- `cargo test` passes for digest modules
- E2E test: enqueue a queue row → poller leases it → spawns subprocess (mock with a no-op claude binary in test) → subprocess exits → poller marks committed
- E2E test: enqueue a queue row → poller leases it → simulate crash (don't commit, don't update lease_expires_at) → wait 30min → next poll re-queues with retry_count=1
- E2E test: enqueue same (scope, trigger_type) twice → second returns DUPLICATE_QUEUED with existing_queue_id
- E2E test: parallel `try_lease` from 2 connections → exactly one wins
- E2E test: spawn real `claude` subprocess with a trivial prompt (`-p "Reply READY"`) using the OAuth-preserving flag combo → exits 0 with `"READY"` output → cleanup deletes cwd
- E2E test: mass_ingest happy path: create_request → supervisor sets approved=true via update_status → poller observes within 30s → digest_queue row enqueued with trigger=mass_ingest → subprocess runs with opus[1m] + 3h lease
- E2E test: mass_ingest first-approval-locks: after approval observed, flip approved=false in status doc → next poll ignores (status now 'approved', no longer 'pending')
- E2E test: retention_purge in-process: insert tombstoned entry with valid_to=NOW-400d → enqueue retention_purge → poller dispatches to in-process handler → row deleted

### Testing Recommendations
- Unit test `enqueue` dedup logic with race conditions (2 parallel enqueues of same trigger_type → one wins, other dedups)
- Unit test `try_lease` with row-level concurrency (simulate 5 pollers racing on 3 rows → exactly 3 leases handed out, no duplicates)
- Unit test `recover_expired_leases` only re-queues rows whose lease_expires_at < NOW
- Integration test SDK subprocess with mock claude binary (script that exits with known codes); verify cwd setup + cleanup behavior
- Integration test subprocess timeout: spawn `sleep 60` as the subprocess, set timeout=2s, verify kill happens within 5s + lease re-queues
- Test mass_ingest approval policies: forbidden (rejects self-approval), solo_only (allows when enforce_permissions=false), allowed (always allows)
- Test mass_ingest TTL expiry: create request with expires_at=NOW-1h, run poller → status='expired'
- Test retention purge with sys_audit_log: verifies the `_audit_log_unlock` pattern works inside the in-process handler
</core>
</section>
<!-- /phase:7 -->

<!-- conductor-review:7 -->
<section id="conductor-review-7">
## Conductor Review: Post-Phase 7

<core>
### Verification Checklist

<mandatory>All checklist items must be verified before proceeding.</mandatory>

- [ ] **SDK launch flag combination matches Phase 2 finding 11 EXACTLY** — verify by reading `src/digest/sdk_subprocess.rs::run_digest`. All 11 flags present in correct order.
- [ ] **`--bare` is NOT used** — grep `src/digest/` for `--bare` → must be zero hits.
- [ ] **`kill_on_drop(true)`** is set on the `Command` builder.
- [ ] **Concurrent stdout + stderr draining** via `tokio::spawn` tasks (verify by reading the implementation).
- [ ] **`UPDATE digest_queue ... RETURNING *`** atomic lease pattern verified — no `SELECT then UPDATE` race-prone code.
- [ ] **First-approval-locks (CEO Item 8)** — verify `approve_and_enqueue` uses `UPDATE WHERE status='pending'` (only pending rows can flip to approved); subsequent flips of the status doc's approved field are ignored.
- [ ] **Retention purge runs in-process** (no SDK subprocess); uses `_audit_log_unlock` pattern for sys_audit_log purge.
- [ ] **Digest agent prompt restricts tool surface** — agent prompt explicitly says it has access to ONLY `mcp__aletheia__*` tools; no Edit/Write/Bash/etc.
- [ ] `register_digest_queue_poller` and `register_mass_ingest_poller` calls UNCOMMENTED in `src/server/index.rs::start_server()` (Registrar pattern).
- [ ] Mass-ingest TTL expiry test passes: requests older than `expires_at` are marked status='expired' by poller.
- [ ] SDK subprocess cwd at `~/.aletheia-v2/sdk-runtime/<queue_id>/`; deleted on success commit; preserved on failure for forensics.
- [ ] Audit events emitted: `digest.digest_queued`, `digest.digest_leased`, `digest.digest_committed`, `digest.digest_failed`, `digest.digest_retried`, `digest.digest_lease_recovered`, `digest.mass_ingest_requested`, `digest.mass_ingest_approved`, `digest.mass_ingest_denied`, `digest.mass_ingest_expired`, `digest.mass_ingest_started`, `digest.mass_ingest_checkpoint`, `digest.mass_ingest_completed`, `digest.mass_ingest_failed`.
- [ ] `--socket-client` subcommand implemented in `src/main.rs` + thin proxy module — subprocess can connect back to parent MCP server via Unix socket.
- [ ] Run context compaction (`/lethe compact`) before launching Phase 8 + Phase 9 (parallel pair).

### Known Risks
- **Pipe-buffer deadlock if drain tasks are forgotten:** This is THE most common subprocess bug. The triple-task pattern (wait + stdout drain + stderr drain) is mandatory. CI test should specifically generate >64KB of subprocess output and verify the wait completes.
- **`--socket-client` complexity:** This is non-trivial code (~150 lines for the proxy). If implementation hits problems, fallback: spin up a fresh full MCP server in the subprocess with its own connection to scope_registry.db. Costs more (extra DB connection) but avoids the proxy. Defer if needed; document in plan.
- **Digest key file lookup:** If a scope's digest key file is missing or corrupted, the digest fails to start. Recommend: bootstrap creates a digest key per scope on `bootstrap`/scope_create; the file is at `~/.aletheia-v2/keys/digest-<scope_uuid>.key` (mode 0600). Phase 9's reconciler can detect missing keys and emit warning audit events.
- **Approval polling latency:** 30s polling means up to 30s between supervisor `update_status(approved=true)` and digest enqueue. Acceptable per design; document in user-facing help.
- **rmcp + `--socket-client` interaction:** The subprocess uses rmcp 1.5.x as MCP client; the `--socket-client` proxy is rmcp 1.5.x as MCP server on stdio. Both ends use the same crate version → compatibility guaranteed.
- **Subprocess token cost not enforced server-side:** Even with `--model opus` (200k cap), a runaway agent could consume the full 200k. CC's per-session cost model handles this for the user, but Aletheia doesn't enforce additional limits. Documented as accepted in CEO Item 3.
- **Trigger type `entry_threshold` cadence:** With default `entry_threshold=50`, a busy session might trigger digest every few minutes. The dedup mechanism prevents queue pileup; the actual digest cadence depends on how fast journals accumulate. Monitor in production; adjust threshold via per-scope override (`[digest.per_scope]`) if too aggressive.

### Guidance for Phase 8 + Phase 9 (parallel launch)

<guidance>
**Phase 8 (V1→V2 Migration) and Phase 9 (Reconciliation + Operational Polish + Shadow Mode) can run in parallel** — they share `sys_audit_log` writes (additive — no conflict) but no other files.

**Phase 8 sub-tasks** (8 parallel after introspection completes):
1. V1 schema introspection (`src/migrate/v1_intro.rs`)
2. Per-scope partitioning (`src/migrate/partition.rs`)
3. Journal transform (`src/migrate/journal.rs`)
4. Memory transform — active + archived + history (`src/migrate/memory.rs`)
5. Status transform (`src/migrate/status.rs`)
6. Handoff transform (`src/migrate/handoff.rs`)
7. Key migration (`src/migrate/keys.rs`)
8. Lazy first-claim trigger marker + orchestrator (`src/migrate/orchestrator.rs`)

**Phase 9 sub-tasks** (4 parallel):
1. Reconciler (`src/reconciler/`)
2. Tool deprecation lifecycle (`src/server/deprecation.rs`)
3. Orphan sweepers (`src/sweepers/`)
4. Shadow Mode infrastructure (`src/shadow/`)

Both phases register additional background tasks via the Registrar pattern (uncommenting more lines in `start_server()`).

Context management: Run `/lethe compact` before launching Phases 8 + 9.
</guidance>
</core>
</section>
<!-- /conductor-review:7 -->

<!-- phase:8 -->
<section id="phase-8">
## Phase 8: V1→V2 Migration Tool

<core>
### Objective
Implement `aletheia-v2 migrate-from-v1` — the tool that reads a V1 SQLite database (greenfield V2 has no V1 code reuse; this tool reads V1 as data only) and produces V2's per-scope `.db` files + `scope_registry.db` rows in V2's separate data directory (`~/.aletheia-v2/`), transforming V1's 2-level hierarchy (entries → typed children) into V2's flat per-row entries model. **Side-by-side install model (per CEO pre-build review):** V1 stays untouched at `~/.aletheia-v2/`; V2 lives at `~/.aletheia-v2/`; both can run simultaneously; cutover is user-driven (uninstall V1 npm + remove V1 from CC settings) AFTER user validates V2. Per CEO Item 4: structural migration is one atomic transaction; the digest pass on imported entries is LAZY per-scope (runs at each scope's first claim in V2).

### Prerequisites
- Phase 2 complete: per-scope schema + scope_registry schema; `install_all` helpers exist on `scope_schema` and `registry_schema` modules
- Phase 3 complete: `keys` table operations; key file management at `~/.aletheia-v2/keys/<name>.key` (V2 path); SHA-256 hashing
- Phase 7 complete: `digest_queue` table; first-claim handler reads `scopes.digest_pending_v1_migration` flag
- **V2 setup completed first:** `aletheia-v2 setup` has run, generated V2 master key at `~/.aletheia-v2/keys/master.key`, created `~/.aletheia-v2/scope_registry.db`. The migration tool augments this V2 install with imported V1 data.

### Implementation

<mandatory>`aletheia-v2 migrate-from-v1` MUST be V2-master-key gated AND require `--confirm-backup-taken`. Without both gates, the tool refuses with a clear error. Backup-confirmation is user acknowledgment (Aletheia doesn't verify the backup actually exists — that's the user's responsibility).</mandatory>

<mandatory>The structural migration MUST be one atomic operation across ALL scopes. Per-scope `.db` files are created and populated within a single per-DB transaction. If any per-scope transform fails, ALL V2 files created during this migration (per-scope `.db` files AND key files written by Phase 8's key migration sub-task) are deleted (cleanup) and `scope_registry.db.migration_state` records the failure. The user re-runs after fixing the cause. Partial migration is FORBIDDEN.</mandatory>

<mandatory>**V1 stays untouched (side-by-side install).** The V1 database file is NEVER renamed by V2's migration. V1's `~/.aletheia/data/aletheia.db` remains exactly as it was; V1's MCP server can keep running on it. V2 reads V1 with `OpenFlags::SQLITE_OPEN_READ_ONLY`. Cutover is user-driven post-validation (uninstall V1 npm + remove V1 entry from `~/.claude/settings.json` + optional `rm -rf ~/.aletheia/`); not the migration tool's responsibility. The migration's commit point is the `scope_registry.db.migration_state.status='completed'` write, NOT a V1-DB rename.</mandatory>

<mandatory>**Master-key flow Option 1 (per CEO pre-build review):** V2 setup mints a FRESH V2 master key (independent of V1's master). V1 keys are migrated into V2's `keys` table preserving `key_id` (V1 UUID) + `key_hash = SHA-256(v1_raw_value)` + original V1 permissions, but with `is_master_key=0`. The V1 master key (V1's only `permissions='maintenance' AND entry_scope IS NULL` row) becomes a 'maintenance'-permission sub-key in V2 with `is_master_key=0`. The new V2 master is `is_master_key=1`. Sessions can claim with EITHER the new V2 master OR the V1-now-V2-sub-key (both reach maintenance level); use the V2 master as the trust root for new operations.</mandatory>

<mandatory>The lazy first-claim digest trigger marker MUST be set on each scope as `scopes.digest_pending_v1_migration=1`. The first claim of each scope in V2 (in `claim()`) checks this flag; if set, enqueues an `entry_threshold` trigger to digest the imported corpus, then sets the flag to 0. Inactive scopes never digest until claimed (per CEO Item 4 storm prevention).</mandatory>

<mandatory>**Active V1 session detection (per CEO pre-build review item A6).** Before migration begins, scan `~/.aletheia-v2/sockets/` for live V1 MCP server processes (any `aletheia-<pid>.sock` file whose corresponding PID is alive per `kill(pid, 0)`). If any are detected, refuse with `<error code="V1_SESSIONS_ACTIVE" pids=[...] hint="Stop all V1 Claude Code sessions before migrating, OR pass --ignore-active-sessions to override (data races possible)"/>` UNLESS `--ignore-active-sessions` flag is set. Default is safe; override is documented but discouraged.</mandatory>

<mandatory>**V1 schema version constraint (per CEO pre-build review item A8).** V2 supports migration from V1 schema_version >= 4 only. Lower versions refused with `<error code="V1_SCHEMA_TOO_OLD" found=N required=4 hint="Upgrade your V1 install to v0.2.7+ first, then re-run migrate-from-v1"/>`. Future contributor task: add fallback logic for v1 schema_version=3 with default values for missing columns (`revoked`, `name`).</mandatory>

**Module structure (added in Phase 8):**

```
src/
├── migrate/
│   ├── mod.rs                 # Aggregator
│   ├── orchestrator.rs        # migrate_from_v1 entry point — master-key gate, atomicity, rename, report
│   ├── v1_intro.rs            # Read V1 SQLite (read-only); introspect schema; enumerate scopes from project_namespace
│   ├── partition.rs           # For each unique V1 namespace: mint scope_uuid, create scope .db, register row
│   ├── journal.rs             # journal_entries → entries (entry_class=journal)
│   ├── memory.rs              # memory_entries (active + archived) + memory_versions → entries (entry_class=memory) + memory_journal_provenance
│   ├── status.rs              # status_documents → entries (entry_class=status); status_sections preserved
│   ├── handoff.rs             # handoffs → entries (entry_class=handoff)
│   ├── keys.rs                # V1 keys → V2 keys table + read raw values from V1 key files
│   ├── tags_to_json.rs        # V1 tags + entry_tags → denormalized into V2 entries.tags JSON column
│   ├── content_hash.rs        # SHA-256(content + scope_id) computation (shared)
│   └── report.rs              # Migration report struct + rendering
└── (new CLI subcommand `migrate-from-v1` in src/main.rs)
```

**Orchestrator (`src/migrate/orchestrator.rs`):**

```rust
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use rusqlite::{Connection, OpenFlags};
use crate::error::{Result, AletheiaError};
use crate::migrate::report::MigrationReport;

pub struct MigrateFromV1Params {
    pub v1_db_path: PathBuf,                // V1 install location, typically ~/.aletheia/data/aletheia.db
    pub target_v2_data_dir: PathBuf,        // defaults to ~/.aletheia-v2/ (NOT ~/.aletheia-v2/)
    pub confirm_backup_taken: bool,
    pub dry_run: bool,
    pub stage_digest_as_mass_ingest: bool,  // Per CEO Item 4 — opt-in for large single-scope corpora
    pub ignore_active_sessions: bool,       // CEO pre-build A6: override the active V1 session refusal
}

pub async fn migrate_from_v1(
    v2_master_key_value: &crate::types::key::KeyValue,  // V2 master from `aletheia-v2 setup` (NOT V1's master)
    params: MigrateFromV1Params,
) -> Result<MigrationReport> {
    // 1. Backup-confirmation gate
    if !params.confirm_backup_taken {
        return Err(AletheiaError::Other(
            "confirm_backup_taken must be true — Aletheia does not verify the backup, but requires user acknowledgment. \
             Recommended: cp ~/.aletheia/data/aletheia.db ~/aletheia-v1-backup-$(date +%Y%m%d).db".into()
        ));
    }
    if !params.v1_db_path.exists() {
        return Err(AletheiaError::Other(format!("V1 DB not found at {}", params.v1_db_path.display())));
    }

    // 2. Active V1 session detection (CEO pre-build review item A6)
    let v1_data_dir = params.v1_db_path.parent()
        .and_then(|p| p.parent())  // .../data/aletheia.db -> .../data -> ~/.aletheia
        .ok_or_else(|| AletheiaError::Other("Could not infer V1 data dir from db path".into()))?;
    let v1_sockets_dir = v1_data_dir.join("sockets");
    let active_v1_pids = scan_active_v1_sessions(&v1_sockets_dir)?;
    if !active_v1_pids.is_empty() && !params.ignore_active_sessions {
        return Err(AletheiaError::Other(format!(
            "V1 sessions are active (PIDs: {:?}). Stop all V1 Claude Code sessions before migrating, \
             OR pass --ignore-active-sessions to override (data races possible).",
            active_v1_pids
        )));
    }
    if !active_v1_pids.is_empty() {
        tracing::warn!("Proceeding with --ignore-active-sessions despite live V1 PIDs: {:?}", active_v1_pids);
    }

    // 3. V2 master key validation (V2 master must already exist from `aletheia-v2 setup`)
    let registry_path = params.target_v2_data_dir.join("scope_registry.db");
    if !registry_path.exists() {
        return Err(AletheiaError::Other(format!(
            "V2 not initialized at {}. Run `aletheia-v2 setup` first to mint a V2 master key and bootstrap the data directory.",
            params.target_v2_data_dir.display()
        )));
    }
    // (Master-key verification happens via the CLI's hash check before calling this fn.)

    // 4. Open V1 DB read-only (V1 file is NEVER touched/renamed in side-by-side install model)
    let v1_conn = Connection::open_with_flags(&params.v1_db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    crate::db::pragmas::apply(&v1_conn).ok();  // PRAGMAs are connection-scoped; read-only OK

    // 5. Introspect V1 schema (CEO pre-build review item A8: refuse V1 schema_version < 4)
    let v1_meta = crate::migrate::v1_intro::introspect(&v1_conn)?;
    if v1_meta.schema_version < 4 {
        return Err(AletheiaError::Other(format!(
            "V1 schema_version {} is too old. Minimum supported: 4. Upgrade your V1 install to v0.2.7+ first, then re-run.",
            v1_meta.schema_version
        )));
    }
    tracing::info!("V1 schema_version={}, scopes_found={}, total_entries={}", v1_meta.schema_version, v1_meta.scopes.len(), v1_meta.total_entries);

    if params.dry_run {
        let report = MigrationReport::dry_run(&v1_meta, &params.target_v2_data_dir);
        // Write dry-run report to ~/.aletheia-v2/dry-run-reports/<timestamp>.{json,md}
        let reports_dir = params.target_v2_data_dir.join("dry-run-reports");
        std::fs::create_dir_all(&reports_dir)?;
        let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S");
        std::fs::write(reports_dir.join(format!("{}.json", ts)), serde_json::to_string_pretty(&report.to_json())?)?;
        std::fs::write(reports_dir.join(format!("{}.md", ts)), report.render_markdown())?;
        tracing::info!("Dry-run reports written to {}/{}.{{json,md}}", reports_dir.display(), ts);
        return Ok(report);
    }

    // 6. Open existing V2 scope_registry.db (already created by `aletheia-v2 setup`)
    let mut registry_conn = Connection::open_with_flags(&registry_path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    crate::db::pragmas::apply(&registry_conn)?;
    // install_all is IDEMPOTENT (CREATE IF NOT EXISTS); safe to re-run
    crate::db::registry_schema::install_all(&registry_conn)?;

    // 6. Begin migration tracking
    let migration_id = format!("v1_to_v2_{}", chrono::Utc::now().timestamp());
    registry_conn.execute(
        "INSERT INTO migration_state (migration_id, source_version, target_version, status, is_applying, started_at, initiated_by_key_hash)
         VALUES (?, ?, ?, 'applying', 1, CURRENT_TIMESTAMP, ?)",
        rusqlite::params![&migration_id, format!("v0.{}.{}", v1_meta.schema_version, 0), "2.0.0", crate::auth::keys::hash_key(master_key_value).0],
    )?;

    crate::db::audit_log::emit_event(
        &registry_conn, crate::types::audit::AuditEventCategory::Migration, "v1_migration_started",
        None, Some(&crate::auth::keys::hash_key(master_key_value).0), None,
        Some(&serde_json::json!({"migration_id": &migration_id, "v1_path": params.v1_db_path.to_string_lossy(), "scopes_count": v1_meta.scopes.len()}))
    )?;

    // 7. For each scope: create scope DB + run all transforms in one transaction
    // Track ALL files created (per CEO pre-build review item A9: failure cleanup must include key files)
    let mut report = MigrationReport::new(v1_meta.clone());
    let mut created_scope_files: Vec<PathBuf> = vec![];
    let mut created_key_files: Vec<PathBuf> = vec![];
    let migration_result: Result<()> = (|| {
        for scope_meta in &v1_meta.scopes {
            let scope_uuid = uuid::Uuid::new_v4().to_string();
            let scope_db_path = params.target_v2_data_dir.join("scopes").join(format!("{}.db", scope_uuid));
            created_scope_files.push(scope_db_path.clone());

            // Open scope DB writable
            let mut scope_conn = Connection::open_with_flags(&scope_db_path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE)?;
            crate::db::pragmas::apply(&scope_conn)?;
            crate::db::scope_schema::install_all(&scope_conn)?;

            // Register scope in scope_registry
            registry_conn.execute(
                "INSERT INTO scopes (scope_id, name, display_name, parent_scope_id, digest_pending_v1_migration, metadata)
                 VALUES (?, ?, ?, NULL, 1, ?)",
                rusqlite::params![&scope_uuid, &scope_meta.namespace, &scope_meta.namespace, serde_json::json!({"v1_namespace": scope_meta.namespace}).to_string()],
            )?;

            // Begin scope transaction
            let scope_tx = scope_conn.transaction()?;

            // Run all transforms in this scope's transaction
            let scope_id = crate::types::scope::ScopeId(scope_uuid.clone());
            let mut scope_report = crate::migrate::report::ScopeReport::new(scope_meta.namespace.clone(), scope_uuid.clone());

            crate::migrate::journal::transform(&v1_conn, &scope_tx, scope_meta, &scope_id, &mut scope_report)?;
            crate::migrate::memory::transform(&v1_conn, &scope_tx, scope_meta, &scope_id, &mut scope_report)?;
            crate::migrate::status::transform(&v1_conn, &scope_tx, scope_meta, &scope_id, &mut scope_report)?;
            crate::migrate::handoff::transform(&v1_conn, &scope_tx, scope_meta, &scope_id, &mut scope_report)?;

            scope_tx.commit()?;

            // Update migration_scope_progress
            registry_conn.execute(
                "INSERT INTO migration_scope_progress (migration_id, scope_id, status, started_at, completed_at)
                 VALUES (?, ?, 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                rusqlite::params![&migration_id, &scope_uuid],
            )?;

            crate::db::audit_log::emit_event(
                &registry_conn, crate::types::audit::AuditEventCategory::Migration, "v1_migration_scope_completed",
                Some(&scope_uuid), None, None,
                Some(&serde_json::json!({"namespace": &scope_meta.namespace, "rows_migrated": scope_report.total_rows()}))
            )?;

            report.scope_reports.push(scope_report);
        }

        // Migrate keys (Option 1 master-key flow per CEO pre-build review):
        //   V2 master key (already created by `aletheia-v2 setup`) is the trust root.
        //   V1 keys are inserted into V2's keys table preserving key_id + key_hash + permissions,
        //   but with is_master_key=0 (even V1's master is a regular maintenance-permission key in V2).
        //   Tracks files created in created_key_files for failure cleanup (A9).
        crate::migrate::keys::transform(&v1_conn, &params.target_v2_data_dir, v1_data_dir, &registry_conn, &v1_meta, &mut report, &mut created_key_files)?;

        // Post-all-transforms: walk V1's memory_journal_provenance and INSERT translated rows
        // into each scope's V2 memory_journal_provenance (per CEO pre-build review item A3).
        // Uses the id_mappings populated by journal::transform and memory::transform.
        crate::migrate::provenance::translate_all(&v1_conn, &params.target_v2_data_dir, &report)?;

        // Post-migration validation (CEO pre-build review item A5):
        // assert sum(V2 rows by entry_class) == V1 rows by entry_class + V1 memory_versions count
        crate::migrate::validation::verify_row_counts(&v1_conn, &params.target_v2_data_dir, &report)?;

        // Optional: stage as mass-ingest (per CEO Item 4)
        if params.stage_digest_as_mass_ingest {
            for scope_report in &report.scope_reports {
                let request = crate::digest::mass_ingest::create_request(
                    &registry_conn,
                    &crate::auth::keys::hash_key(master_key_value).0,
                    &crate::types::scope::ScopeId(scope_report.scope_id.clone()),
                    "v1_migration_digest",
                    &format!("Digest V1 imported corpus for scope {}", scope_report.namespace),
                    "Migration from V1; auto-staged as mass-ingest per --stage-digest-as-mass-ingest flag",
                    Some(scope_report.total_rows() as u32),
                    None,
                    24,
                )?;
                tracing::info!("Created mass_ingest request {} for scope {}", request.request_id, scope_report.namespace);
            }
        }

        Ok(())
    })();

    match migration_result {
        Ok(()) => {
            // 8. Commit migration_state. NOTE: V1 DB is NOT renamed (side-by-side install model).
            // Cutover is user-driven: validate V2 → uninstall V1 npm → optional rm -rf ~/.aletheia-v2/.
            registry_conn.execute(
                "UPDATE migration_state SET status='completed', is_applying=0, completed_at=CURRENT_TIMESTAMP WHERE migration_id=?",
                rusqlite::params![&migration_id],
            )?;

            crate::db::audit_log::emit_event(
                &registry_conn, crate::types::audit::AuditEventCategory::Migration, "v1_migration_completed",
                None, Some(&crate::auth::keys::hash_key(v2_master_key_value).0), None,
                Some(&serde_json::json!({
                    "migration_id": &migration_id,
                    "v1_path_preserved": params.v1_db_path.to_string_lossy(),  // V1 untouched
                    "v2_target": params.target_v2_data_dir.to_string_lossy(),
                    "report": report.summary_json(),
                    "next_step_hint": "Validate V2 with a test session, then run docs/MIGRATION-FROM-V1.md cutover steps to retire V1."
                }))
            )?;

            Ok(report)
        }
        Err(e) => {
            // 8. Cleanup: delete ALL files created during this migration (CEO pre-build review item A9).
            // Note: this is the FAILURE path with FULL cleanup. After cleanup, no V2 state exists
            // from this migration — so is_applying flips to false (CEO pre-build review item A10:
            // "safe-hold" only applies when partial state exists; full cleanup means no state to lock against).
            for path in &created_scope_files {
                let _ = std::fs::remove_file(path);
            }
            for path in &created_key_files {
                let _ = std::fs::remove_file(path);
            }
            registry_conn.execute(
                "UPDATE migration_state SET status='failed', is_applying=0, failed_at=CURRENT_TIMESTAMP, error_message=? WHERE migration_id=?",
                rusqlite::params![e.to_string(), &migration_id],
            )?;
            crate::db::audit_log::emit_event(
                &registry_conn, crate::types::audit::AuditEventCategory::Migration, "v1_migration_failed",
                None, None, None,
                Some(&serde_json::json!({"migration_id": &migration_id, "error": e.to_string()}))
            )?;
            Err(e)
        }
    }
}

/// CEO pre-build review item A6: scan V1's sockets directory for live MCP server processes.
fn scan_active_v1_sessions(v1_sockets_dir: &std::path::Path) -> Result<Vec<i32>> {
    let mut alive = vec![];
    if !v1_sockets_dir.exists() { return Ok(alive); }
    for entry in std::fs::read_dir(v1_sockets_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // V1 sockets are named "aletheia-<pid>.sock"
        if let Some(rest) = name_str.strip_prefix("aletheia-").and_then(|s| s.strip_suffix(".sock")) {
            if let Ok(pid) = rest.parse::<i32>() {
                #[cfg(unix)]
                {
                    if nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok() {
                        alive.push(pid);
                    }
                }
                #[cfg(windows)]
                {
                    // Use winapi OpenProcess + GetExitCodeProcess pattern
                    // Implementation deferred to platform-specific module
                    alive.push(pid);  // Conservative: assume alive on Windows
                }
            }
        }
    }
    Ok(alive)
}
```

**Dry-run report structure (`src/migrate/report.rs`) — CEO pre-build review item A7:**

```rust
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationReport {
    pub mode: ReportMode,                              // "dry_run" | "actual"
    pub v1_source: V1SourceInfo,
    pub v2_target_data_dir: String,
    pub scopes_planned: Vec<ScopePlanReport>,
    pub keys_planned: Vec<KeyPlanReport>,
    pub estimated_duration_seconds: u64,
    pub estimated_disk_required_bytes: u64,
    pub will_rename_v1: bool,                          // Always false (side-by-side install)
    pub will_write: bool,                              // false in dry-run, true in actual
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub scope_reports: Vec<ScopeReport>,               // populated in actual mode (per-scope detail)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportMode { DryRun, Actual }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct V1SourceInfo {
    pub path: String,
    pub schema_version: u32,
    pub file_size_bytes: u64,
    pub total_entries: u64,
    pub total_keys: u64,
    pub total_status_documents: u64,
    pub total_handoffs: u64,
    pub total_memory_versions: u64,
    pub total_provenance_rows: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopePlanReport {
    pub v1_namespace: String,
    pub v2_scope_uuid: String,                         // deterministic in dry_run (hash of namespace) so dry_run + actual match
    pub v2_scope_db_path: String,
    pub rows_planned: RowsByClass,
    pub estimated_disk_bytes: u64,
    pub risks_detected: Vec<String>,                   // e.g., "1 entry has NULL value — will be migrated as empty string with warning"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowsByClass {
    pub memory_active: u32,
    pub memory_archived: u32,
    pub memory_history_versions: u32,
    pub journal_count: u32,
    pub journal_with_provenance: u32,
    pub status_documents: u32,
    pub status_sections: u32,
    pub handoff_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyPlanReport {
    pub v1_key_id: String,
    pub v2_key_hash: String,                           // SHA-256 of V1's raw value
    pub v2_key_file: String,                           // ~/.aletheia-v2/keys/<name>.key
    pub permissions: String,
    pub primary_scope: String,
    pub was_v1_master: bool,                           // V1 master keys become V2 maintenance sub-keys (is_master_key=0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopeReport {
    pub namespace: String,
    pub scope_id: String,
    pub memory_active: u32,
    pub memory_archived: u32,
    pub memory_history: u32,
    pub journal_count: u32,
    pub status_count: u32,
    pub handoff_count: u32,
    pub provenance_translated: u32,
    pub id_mapping: std::collections::HashMap<String, String>,  // V1 ID → V2 entry_id (for provenance translation)
}

impl ScopeReport {
    pub fn total_rows(&self) -> u32 {
        self.memory_active + self.memory_archived + self.memory_history
            + self.journal_count + self.status_count + self.handoff_count
    }
    pub fn new(namespace: String, scope_id: String) -> Self {
        Self {
            namespace, scope_id,
            memory_active: 0, memory_archived: 0, memory_history: 0,
            journal_count: 0, status_count: 0, handoff_count: 0, provenance_translated: 0,
            id_mapping: std::collections::HashMap::new(),
        }
    }
}

impl MigrationReport {
    pub fn dry_run(v1_meta: &super::v1_intro::V1Meta, target_v2_data_dir: &std::path::Path) -> Self {
        // Build per-scope plan reports with deterministic UUIDs (hash of namespace)
        // so dry_run + actual produce matching scope_uuid values
        let scopes_planned = v1_meta.scopes.iter().map(|s| {
            let v2_scope_uuid = deterministic_scope_uuid(&s.namespace);
            ScopePlanReport {
                v1_namespace: s.namespace.clone(),
                v2_scope_uuid: v2_scope_uuid.clone(),
                v2_scope_db_path: target_v2_data_dir.join("scopes").join(format!("{}.db", v2_scope_uuid)).to_string_lossy().to_string(),
                rows_planned: RowsByClass {
                    memory_active: s.memory_active_count as u32,
                    memory_archived: s.memory_archived_count as u32,
                    memory_history_versions: s.memory_history_count as u32,
                    journal_count: s.journal_count as u32,
                    journal_with_provenance: s.journal_with_provenance_count as u32,
                    status_documents: s.status_document_count as u32,
                    status_sections: s.status_section_count as u32,
                    handoff_count: s.handoff_count as u32,
                },
                estimated_disk_bytes: estimate_scope_disk(s),
                risks_detected: detect_risks(s),
            }
        }).collect();

        let keys_planned = vec![]; // populated by keys::dry_run_plan in real impl

        Self {
            mode: ReportMode::DryRun,
            v1_source: V1SourceInfo {
                path: v1_meta.source_path.clone(),
                schema_version: v1_meta.schema_version,
                file_size_bytes: v1_meta.file_size_bytes,
                total_entries: v1_meta.total_entries,
                total_keys: v1_meta.total_keys,
                total_status_documents: v1_meta.total_status_documents,
                total_handoffs: v1_meta.total_handoffs,
                total_memory_versions: v1_meta.total_memory_versions,
                total_provenance_rows: v1_meta.total_provenance_rows,
            },
            v2_target_data_dir: target_v2_data_dir.to_string_lossy().to_string(),
            scopes_planned, keys_planned,
            estimated_duration_seconds: v1_meta.total_entries / 30 + 5,  // ~30 entries/sec heuristic
            estimated_disk_required_bytes: v1_meta.file_size_bytes * 3,  // V1 + V2 + .bak temporarily
            will_rename_v1: false,                                         // ALWAYS false (side-by-side)
            will_write: false,                                             // dry_run never writes
            warnings: vec![],
            errors: vec![],
            scope_reports: vec![],
        }
    }

    pub fn render_markdown(&self) -> String {
        // Human-readable formatted markdown; structure mirrors the JSON for readability
        // Implementation: ~50 lines using `writeln!` against a String
        format!("# Aletheia V1 → V2 Migration {}-Run Report\n\n...", if matches!(self.mode, ReportMode::DryRun) { "Dry" } else { "Actual" })
    }

    pub fn to_json(&self) -> serde_json::Value { serde_json::to_value(self).unwrap_or(serde_json::Value::Null) }
    pub fn summary_json(&self) -> serde_json::Value {
        serde_json::json!({
            "scopes": self.scope_reports.len(),
            "total_v2_rows": self.scope_reports.iter().map(|s| s.total_rows() as u64).sum::<u64>(),
        })
    }
    pub fn new(_v1_meta: super::v1_intro::V1Meta) -> Self { unimplemented!("called by orchestrator for actual mode; symmetric to dry_run constructor") }
}

/// SHA-256-based deterministic scope_uuid so dry_run + actual produce matching values.
fn deterministic_scope_uuid(namespace: &str) -> String {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(b"aletheia-v2-scope:");
    hasher.update(namespace.as_bytes());
    let hash = hasher.finalize();
    // Format as UUID-like 8-4-4-4-12 hex
    let h = hex::encode(&hash[..16]);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn estimate_scope_disk(s: &super::v1_intro::V1Scope) -> u64 {
    // Rough heuristic: ~2KB per row (content + indexes + WAL overhead)
    (s.memory_active_count + s.memory_archived_count + s.memory_history_count + s.journal_count + s.status_section_count + s.handoff_count) * 2048
}

fn detect_risks(_s: &super::v1_intro::V1Scope) -> Vec<String> {
    // Real impl scans for NULL values, oversized content, etc.
    vec![]
}
```

**Memory transform — two-pass version numbering (CEO pre-build review item A1):**

```rust
// src/migrate/memory.rs — replace the simplified version-numbering block in the body
// of `transform()` (which previously assigned versions inline) with the two-pass algorithm:

pub fn transform(v1_conn: &Connection, scope_tx: &Transaction, scope_meta: &V1Scope, scope_id: &ScopeId, report: &mut ScopeReport) -> Result<()> {
    for mem in fetch_v1_memory_entries(v1_conn, scope_meta)? {
        let new_entry_id = uuid::Uuid::new_v4().to_string();

        // PASS 1: count V1 history rows for this memory_entry to determine final version count
        let history_rows: Vec<HistoryRow> = fetch_history(v1_conn, &mem.v1_memory_id)?;
        let history_count = history_rows.len() as u32;
        let current_version = history_count + 1;        // current row's V2 version

        // Build common fields
        let mut tags = fetch_v1_tags_for_entry(v1_conn, &mem.v1_entry_id)?;
        tags.push(format!("key:{}", mem.v1_key));
        tags.push(format!("entry_id_legacy:{}", mem.v1_entry_id));
        let tags_json = serde_json::to_string(&tags)?;

        // PASS 2a: INSERT history rows with versions 1..N (ordered by V1.changed_at)
        for (idx, hist) in history_rows.iter().enumerate() {
            let next_change = if idx + 1 < history_rows.len() {
                &history_rows[idx + 1].changed_at
            } else {
                &mem.updated_at
            };
            let hist_content_hash = crate::migrate::content_hash::compute(&hist.previous_value, &scope_id.0);
            scope_tx.execute(
                "INSERT INTO entries (entry_id, version, entry_class, content, content_hash, tags, valid_from, valid_to, invalidation_reason, critical_flag, created_by_key_hash)
                 VALUES (?, ?, 'memory', ?, ?, ?, ?, ?, 'updated', 0, NULL)",
                rusqlite::params![&new_entry_id, idx as u32 + 1, hist.previous_value, hist_content_hash, &tags_json, hist.changed_at, next_change],
            )?;
            report.memory_history += 1;
        }

        // PASS 2b: INSERT current row with version = N+1
        let content_hash = crate::migrate::content_hash::compute(&mem.v1_value, &scope_id.0);
        let (valid_to, invalidation_reason) = match (&mem.archived_at, &mem.superseded_by) {
            (Some(at), _) => (Some(at.clone()), Some("retired:migrated_from_v1".to_string())),
            (None, Some(b)) => (Some(mem.updated_at.clone()), Some(format!("superseded_by:{}", b))),
            (None, None) => (None, None),
        };
        scope_tx.execute(
            "INSERT INTO entries (entry_id, version, entry_class, content, content_hash, tags, valid_from, valid_to, invalidation_reason, supersedes_entry_id, critical_flag, digested_at, created_by_key_hash)
             VALUES (?, ?, 'memory', ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)",
            rusqlite::params![&new_entry_id, current_version, mem.v1_value, content_hash, &tags_json, mem.updated_at, valid_to, invalidation_reason, mem.superseded_by],
        )?;
        if mem.archived_at.is_none() { report.memory_active += 1; } else { report.memory_archived += 1; }

        // Track V1 memory_id → V2 new_entry_id for post-pass provenance translation
        report.id_mapping.insert(mem.v1_memory_id.clone(), new_entry_id);
    }
    Ok(())
}

/// CEO pre-build review item A2: actual SQL JOIN for V1 tags lookup.
fn fetch_v1_tags_for_entry(v1_conn: &Connection, v1_entry_id: &str) -> Result<Vec<String>> {
    let mut stmt = v1_conn.prepare(
        "SELECT t.name FROM tags t JOIN entry_tags et ON et.tag_id = t.id WHERE et.entry_id = ? ORDER BY t.name"
    )?;
    let tags: Vec<String> = stmt.query_map(
        rusqlite::params![v1_entry_id],
        |row| row.get::<_, String>(0),
    )?.filter_map(|r| r.ok()).collect();
    Ok(tags)
}

fn fetch_v1_memory_entries(_v1_conn: &Connection, _scope_meta: &V1Scope) -> Result<Vec<MemoryRow>> { todo!("query as before") }
fn fetch_history(_v1_conn: &Connection, _v1_memory_id: &str) -> Result<Vec<HistoryRow>> {
    // SELECT id, previous_value, previous_version_id, changed_at FROM memory_versions
    // WHERE memory_entry_id = ? ORDER BY changed_at
    todo!()
}
```

**Provenance translation pass (CEO pre-build review item A3):**

```rust
// src/migrate/provenance.rs — runs AFTER all per-scope transforms complete.
// Walks V1's memory_journal_provenance and INSERTs translated rows into each scope's V2 memory_journal_provenance.
// Uses the id_mapping populated by both journal::transform AND memory::transform.

use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use crate::error::Result;

pub fn translate_all(v1_conn: &Connection, target_v2_data_dir: &Path, report: &super::report::MigrationReport) -> Result<()> {
    // Build a global mapping V1_id → (V2_entry_id, V2_scope_uuid) for both memory and journal IDs
    let mut global_mapping: std::collections::HashMap<String, (String, String)> = std::collections::HashMap::new();
    for scope_report in &report.scope_reports {
        for (v1_id, v2_entry_id) in &scope_report.id_mapping {
            global_mapping.insert(v1_id.clone(), (v2_entry_id.clone(), scope_report.scope_id.clone()));
        }
    }

    // Read V1 provenance
    let mut stmt = v1_conn.prepare("SELECT memory_entry_id, journal_entry_id FROM memory_journal_provenance")?;
    let v1_rows: Vec<(String, String)> = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        ?.filter_map(|r| r.ok()).collect();

    // Group by target scope (the scope of the memory side; V1 provenance is intra-scope by construction)
    let mut by_scope: std::collections::HashMap<String, Vec<(String, String)>> = std::collections::HashMap::new();
    for (v1_memory_id, v1_journal_id) in v1_rows {
        if let (Some((v2_mem_id, mem_scope)), Some((v2_journal_id, _))) = (
            global_mapping.get(&v1_memory_id), global_mapping.get(&v1_journal_id)
        ) {
            by_scope.entry(mem_scope.clone()).or_default().push((v2_mem_id.clone(), v2_journal_id.clone()));
        } else {
            tracing::warn!("Skipping orphan V1 provenance: memory={} journal={} (id_mapping miss)", v1_memory_id, v1_journal_id);
        }
    }

    // INSERT into each scope's memory_journal_provenance
    for (scope_id, rows) in by_scope {
        let scope_db_path = target_v2_data_dir.join("scopes").join(format!("{}.db", scope_id));
        let conn = Connection::open_with_flags(&scope_db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        crate::db::pragmas::apply(&conn)?;
        let tx = conn.unchecked_transaction()?;
        for (v2_mem, v2_journal) in &rows {
            tx.execute(
                "INSERT OR IGNORE INTO memory_journal_provenance (memory_entry_id, journal_entry_id) VALUES (?, ?)",
                rusqlite::params![v2_mem, v2_journal],
            )?;
        }
        tx.commit()?;
        tracing::info!("Translated {} provenance rows into scope {}", rows.len(), scope_id);
    }
    Ok(())
}
```

**Validation pass (CEO pre-build review item A5):**

```rust
// src/migrate/validation.rs — runs AFTER all transforms + provenance translation.
// Confirms no rows were lost during the per-scope transforms.

use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use crate::error::{Result, AletheiaError};

pub fn verify_row_counts(v1_conn: &Connection, target_v2_data_dir: &Path, report: &super::report::MigrationReport) -> Result<()> {
    // Expected V2 row counts per entry_class:
    //   memory = V1 active memory_entries + V1 archived memory_entries + V1 memory_versions
    //   journal = V1 journal_entries
    //   status (entries) = V1 status_documents (the container row)
    //   handoff = V1 handoffs
    // status_sections is a separate table; verify per-scope sums match V1 status_sections grouped by scope

    let v1_memory_total: u64 = v1_conn.query_row(
        "SELECT (SELECT COUNT(*) FROM memory_entries) + (SELECT COUNT(*) FROM memory_versions)",
        [], |row| row.get(0)
    )?;
    let v1_journal_total: u64 = v1_conn.query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0))?;
    let v1_status_doc_total: u64 = v1_conn.query_row("SELECT COUNT(*) FROM status_documents", [], |row| row.get(0))?;
    let v1_handoff_total: u64 = v1_conn.query_row("SELECT COUNT(*) FROM handoffs", [], |row| row.get(0))?;

    // Sum across all V2 scope DBs
    let mut v2_memory = 0u64;
    let mut v2_journal = 0u64;
    let mut v2_status = 0u64;
    let mut v2_handoff = 0u64;
    for scope_report in &report.scope_reports {
        let scope_db = target_v2_data_dir.join("scopes").join(format!("{}.db", scope_report.scope_id));
        let conn = Connection::open_with_flags(&scope_db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        v2_memory += conn.query_row("SELECT COUNT(*) FROM entries WHERE entry_class='memory'", [], |row| row.get::<_, u64>(0))?;
        v2_journal += conn.query_row("SELECT COUNT(*) FROM entries WHERE entry_class='journal'", [], |row| row.get::<_, u64>(0))?;
        v2_status += conn.query_row("SELECT COUNT(*) FROM entries WHERE entry_class='status'", [], |row| row.get::<_, u64>(0))?;
        v2_handoff += conn.query_row("SELECT COUNT(*) FROM entries WHERE entry_class='handoff'", [], |row| row.get::<_, u64>(0))?;
    }

    let mut errors = vec![];
    if v2_memory != v1_memory_total { errors.push(format!("memory count mismatch: V1={} V2={}", v1_memory_total, v2_memory)); }
    if v2_journal != v1_journal_total { errors.push(format!("journal count mismatch: V1={} V2={}", v1_journal_total, v2_journal)); }
    if v2_status != v1_status_doc_total { errors.push(format!("status count mismatch: V1={} V2={}", v1_status_doc_total, v2_status)); }
    if v2_handoff != v1_handoff_total { errors.push(format!("handoff count mismatch: V1={} V2={}", v1_handoff_total, v2_handoff)); }

    if !errors.is_empty() {
        return Err(AletheiaError::Other(format!("Migration validation failed:\n  - {}", errors.join("\n  - "))));
    }
    tracing::info!("Migration validation: all row counts match (memory={} journal={} status={} handoff={})", v2_memory, v2_journal, v2_status, v2_handoff);
    Ok(())
}
```

**V1 introspection (`src/migrate/v1_intro.rs`):**

```rust
use rusqlite::Connection;
use crate::error::Result;

#[derive(Debug, Clone)]
pub struct V1Meta {
    pub schema_version: u32,
    pub source_path: String,                       // for inclusion in dry-run report
    pub file_size_bytes: u64,                      // for disk-estimate calculation
    pub scopes: Vec<V1Scope>,
    pub total_entries: u64,
    pub total_keys: u64,
    pub total_status_documents: u64,
    pub total_handoffs: u64,
    pub total_memory_versions: u64,                // CEO pre-build review item A1: history rows count
    pub total_provenance_rows: u64,                // CEO pre-build review item A3: for translation pass
}

#[derive(Debug, Clone)]
pub struct V1Scope {
    pub namespace: String,                         // V1's project_namespace value (or "default" for NULL)
    pub entry_ids: Vec<String>,
    // Detailed counts (used by dry-run report's RowsByClass):
    pub journal_count: u64,
    pub journal_with_provenance_count: u64,        // count of journal entries that appear in memory_journal_provenance
    pub memory_active_count: u64,
    pub memory_archived_count: u64,
    pub memory_history_count: u64,                 // V1.memory_versions rows for this scope's memories
    pub status_document_count: u64,
    pub status_section_count: u64,                 // sum of status_sections rows across this scope's status docs
    pub handoff_count: u64,
}

pub fn introspect(v1_conn: &Connection, v1_db_path: &std::path::Path) -> Result<V1Meta> {
    let schema_version: u32 = v1_conn.query_row("SELECT version FROM schema_version", [], |row| row.get(0))
        .unwrap_or(0);

    let file_size_bytes = std::fs::metadata(v1_db_path).map(|m| m.len()).unwrap_or(0);

    // Enumerate unique namespaces (NULL → "default")
    let namespaces: Vec<String> = {
        let mut stmt = v1_conn.prepare("SELECT DISTINCT COALESCE(project_namespace, 'default') FROM entries")?;
        stmt.query_map([], |row| row.get::<_, String>(0))?.filter_map(|r| r.ok()).collect()
    };

    let mut scopes = vec![];
    for ns in namespaces {
        let entry_ids: Vec<String> = fetch_entry_ids_for_namespace(v1_conn, &ns)?;

        let journal_count = count_per_scope(v1_conn, &ns, "journal_entries", Some("journal"))?;
        let memory_active_count = count_memory_per_scope(v1_conn, &ns, /* archived */ false)?;
        let memory_archived_count = count_memory_per_scope(v1_conn, &ns, /* archived */ true)?;
        let memory_history_count = count_memory_versions_per_scope(v1_conn, &ns)?;
        let status_document_count = count_per_scope(v1_conn, &ns, "status_documents", Some("status"))?;
        let status_section_count = count_status_sections_per_scope(v1_conn, &ns)?;
        let handoff_count = count_handoffs_per_scope(v1_conn, &ns)?;
        let journal_with_provenance_count = count_journal_with_provenance_per_scope(v1_conn, &ns)?;

        scopes.push(V1Scope {
            namespace: ns,
            entry_ids,
            journal_count, journal_with_provenance_count,
            memory_active_count, memory_archived_count, memory_history_count,
            status_document_count, status_section_count, handoff_count,
        });
    }

    let total_entries: u64 = v1_conn.query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))?;
    let total_keys: u64 = v1_conn.query_row("SELECT COUNT(*) FROM keys", [], |row| row.get(0))?;
    let total_status_documents: u64 = v1_conn.query_row("SELECT COUNT(*) FROM status_documents", [], |row| row.get(0))?;
    let total_handoffs: u64 = v1_conn.query_row("SELECT COUNT(*) FROM handoffs", [], |row| row.get(0))?;
    let total_memory_versions: u64 = v1_conn.query_row("SELECT COUNT(*) FROM memory_versions", [], |row| row.get(0))?;
    let total_provenance_rows: u64 = v1_conn.query_row("SELECT COUNT(*) FROM memory_journal_provenance", [], |row| row.get(0))?;

    Ok(V1Meta {
        schema_version, source_path: v1_db_path.to_string_lossy().to_string(), file_size_bytes,
        scopes, total_entries, total_keys, total_status_documents, total_handoffs,
        total_memory_versions, total_provenance_rows,
    })
}

// CEO pre-build review item A4: count handoffs per scope.
// V1's handoffs.target_key is the consuming key's id (FK to keys.id, not enforced).
// To count handoffs per namespace: look up which keys belong to which namespace via keys.entry_scope,
// then count handoffs whose target_key matches keys in that namespace.
fn count_handoffs_per_scope(v1_conn: &Connection, ns: &str) -> Result<u64> {
    let sql = if ns == "default" {
        "SELECT COUNT(*) FROM handoffs h
         WHERE h.target_key IN (SELECT id FROM keys WHERE entry_scope IS NULL)"
    } else {
        "SELECT COUNT(*) FROM handoffs h
         WHERE h.target_key IN (SELECT id FROM keys WHERE entry_scope = ?)"
    };
    if ns == "default" {
        v1_conn.query_row(sql, [], |row| row.get(0)).map_err(Into::into)
    } else {
        v1_conn.query_row(sql, rusqlite::params![ns], |row| row.get(0)).map_err(Into::into)
    }
}

fn count_per_scope(v1_conn: &Connection, ns: &str, table: &str, class: Option<&str>) -> Result<u64> {
    let where_class = class.map(|c| format!(" AND e.entry_class = '{}'", c)).unwrap_or_default();
    let ns_filter = if ns == "default" { "e.project_namespace IS NULL".to_string() } else { "e.project_namespace = ?".to_string() };
    let sql = format!("SELECT COUNT(*) FROM entries e JOIN {} t ON t.entry_id = e.id WHERE {}{}", table, ns_filter, where_class);
    if ns == "default" {
        v1_conn.query_row(&sql, [], |row| row.get(0)).map_err(Into::into)
    } else {
        v1_conn.query_row(&sql, rusqlite::params![ns], |row| row.get(0)).map_err(Into::into)
    }
}

fn count_memory_per_scope(v1_conn: &Connection, ns: &str, archived: bool) -> Result<u64> {
    let archived_filter = if archived { "m.archived_at IS NOT NULL" } else { "m.archived_at IS NULL" };
    let ns_filter = if ns == "default" { "e.project_namespace IS NULL".to_string() } else { "e.project_namespace = ?".to_string() };
    let sql = format!("SELECT COUNT(*) FROM memory_entries m JOIN entries e ON e.id = m.entry_id WHERE {} AND {}", ns_filter, archived_filter);
    if ns == "default" {
        v1_conn.query_row(&sql, [], |row| row.get(0)).map_err(Into::into)
    } else {
        v1_conn.query_row(&sql, rusqlite::params![ns], |row| row.get(0)).map_err(Into::into)
    }
}

fn count_memory_versions_per_scope(v1_conn: &Connection, ns: &str) -> Result<u64> {
    let ns_filter = if ns == "default" { "e.project_namespace IS NULL".to_string() } else { "e.project_namespace = ?".to_string() };
    let sql = format!(
        "SELECT COUNT(*) FROM memory_versions mv
         JOIN memory_entries m ON m.id = mv.memory_entry_id
         JOIN entries e ON e.id = m.entry_id
         WHERE {}",
        ns_filter
    );
    if ns == "default" {
        v1_conn.query_row(&sql, [], |row| row.get(0)).map_err(Into::into)
    } else {
        v1_conn.query_row(&sql, rusqlite::params![ns], |row| row.get(0)).map_err(Into::into)
    }
}

fn count_status_sections_per_scope(v1_conn: &Connection, ns: &str) -> Result<u64> {
    let ns_filter = if ns == "default" { "e.project_namespace IS NULL".to_string() } else { "e.project_namespace = ?".to_string() };
    let sql = format!(
        "SELECT COUNT(*) FROM status_sections ss
         JOIN status_documents sd ON sd.id = ss.status_id
         JOIN entries e ON e.id = sd.entry_id
         WHERE {}",
        ns_filter
    );
    if ns == "default" {
        v1_conn.query_row(&sql, [], |row| row.get(0)).map_err(Into::into)
    } else {
        v1_conn.query_row(&sql, rusqlite::params![ns], |row| row.get(0)).map_err(Into::into)
    }
}

fn count_journal_with_provenance_per_scope(v1_conn: &Connection, ns: &str) -> Result<u64> {
    let ns_filter = if ns == "default" { "e.project_namespace IS NULL".to_string() } else { "e.project_namespace = ?".to_string() };
    let sql = format!(
        "SELECT COUNT(DISTINCT mjp.journal_entry_id) FROM memory_journal_provenance mjp
         JOIN journal_entries j ON j.id = mjp.journal_entry_id
         JOIN entries e ON e.id = j.entry_id
         WHERE {}",
        ns_filter
    );
    if ns == "default" {
        v1_conn.query_row(&sql, [], |row| row.get(0)).map_err(Into::into)
    } else {
        v1_conn.query_row(&sql, rusqlite::params![ns], |row| row.get(0)).map_err(Into::into)
    }
}

fn fetch_entry_ids_for_namespace(v1_conn: &Connection, ns: &str) -> Result<Vec<String>> {
    let ns_filter = if ns == "default" { "project_namespace IS NULL" } else { "project_namespace = ?" };
    let sql = format!("SELECT id FROM entries WHERE {}", ns_filter);
    let mut stmt = v1_conn.prepare(&sql)?;
    let rows: Vec<String> = if ns == "default" {
        stmt.query_map([], |row| row.get::<_, String>(0))?.filter_map(|r| r.ok()).collect()
    } else {
        stmt.query_map(rusqlite::params![ns], |row| row.get::<_, String>(0))?.filter_map(|r| r.ok()).collect()
    };
    Ok(rows)
}
```

**Memory transform (`src/migrate/memory.rs`) — most complex transform per Q5A:**

```rust
use rusqlite::{Connection, Transaction};
use crate::error::Result;
use crate::types::scope::ScopeId;
use crate::migrate::report::ScopeReport;
use crate::migrate::v1_intro::V1Scope;

pub fn transform(v1_conn: &Connection, scope_tx: &Transaction, scope_meta: &V1Scope, scope_id: &ScopeId, report: &mut ScopeReport) -> Result<()> {
    // For each V1 entries row in this namespace where entry_class='memory':
    //   For each memory_entries row with entry_id matching:
    //     Create a V2 entries row (entry_class='memory') with:
    //       - new entry_id (UUID)
    //       - content = V1.value
    //       - tags = V1's joined tags (via entry_tags) + key:<value> tag (Q5A) + entry_id_legacy:<v1-uuid> tag (Q5A)
    //       - content_hash = SHA-256(content + scope_id)
    //       - valid_from = V1.updated_at (or created_at if NULL)
    //       - valid_to = V1.archived_at (or NULL if active)
    //       - invalidation_reason = "retired:migrated_from_v1" if archived; NULL if active
    //       - version = 1 (new in V2 — V1's version_id was opaque hex; reset)
    //       - created_by_key_hash = NULL (V1 stored UUID, not raw key — original raw value not recoverable)
    //   For each memory_versions row of the same memory_entries row:
    //     Create an additional V2 entries row for that prior version with:
    //       - same entry_id (continuation of version chain)
    //       - content = V1.previous_value
    //       - valid_from = V1.changed_at
    //       - valid_to = next change's changed_at (or current memory's updated_at for the latest history row)
    //       - invalidation_reason = "updated"
    //       - version = sequential per (entry_id, ordered by changed_at)

    let ns_filter_sql = if scope_meta.namespace == "default" { "project_namespace IS NULL" } else { "project_namespace = ?" };
    let namespace_param: Box<dyn rusqlite::ToSql> = if scope_meta.namespace == "default" {
        Box::new(rusqlite::types::Null)
    } else {
        Box::new(scope_meta.namespace.clone())
    };

    // Query all V1 memory entries for this namespace
    let sql = format!(
        "SELECT m.id, m.entry_id, m.key, m.value, m.version_id, m.archived_at, m.updated_at, m.superseded_by, e.created_at AS entry_created_at
         FROM memory_entries m
         JOIN entries e ON e.id = m.entry_id
         WHERE e.{}",
        ns_filter_sql
    );
    let mut stmt = v1_conn.prepare(&sql)?;
    let memory_rows: Vec<MemoryRow> = stmt.query_map(
        rusqlite::params![&namespace_param],
        |row| Ok(MemoryRow {
            v1_memory_id: row.get(0)?,
            v1_entry_id: row.get(1)?,
            v1_key: row.get(2)?,
            v1_value: row.get(3)?,
            v1_version_id: row.get(4)?,
            archived_at: row.get(5)?,
            updated_at: row.get(6)?,
            superseded_by: row.get(7)?,
            entry_created_at: row.get(8)?,
        })
    )?.filter_map(|r| r.ok()).collect();

    for mem in memory_rows {
        let new_entry_id = uuid::Uuid::new_v4().to_string();

        // Build tags: V1 tags + key:<value> + entry_id_legacy:<v1-uuid>
        let mut tags = fetch_v1_tags_for_entry(v1_conn, &mem.v1_entry_id)?;
        tags.push(format!("key:{}", mem.v1_key));
        tags.push(format!("entry_id_legacy:{}", mem.v1_entry_id));
        let tags_json = serde_json::to_string(&tags)?;

        // Compute content_hash
        let content_hash = crate::migrate::content_hash::compute(&mem.v1_value, &scope_id.0);

        let (valid_to, invalidation_reason) = match (&mem.archived_at, &mem.superseded_by) {
            (Some(at), _) => (Some(at.clone()), Some("retired:migrated_from_v1".to_string())),
            (None, Some(b)) => (Some(mem.updated_at.clone()), Some(format!("superseded_by:{}", b))),
            (None, None) => (None, None),
        };

        scope_tx.execute(
            "INSERT INTO entries (entry_id, version, entry_class, content, content_hash, tags, valid_from, valid_to, invalidation_reason, supersedes_entry_id, critical_flag, digested_at, created_by_key_hash)
             VALUES (?, 1, 'memory', ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)",
            rusqlite::params![&new_entry_id, mem.v1_value, content_hash, tags_json, mem.updated_at, valid_to, invalidation_reason, mem.superseded_by],
        )?;

        report.memory_active += if mem.archived_at.is_none() { 1 } else { 0 };
        report.memory_archived += if mem.archived_at.is_some() { 1 } else { 0 };

        // History rows from memory_versions for THIS memory_entries row
        let history_sql = "SELECT id, previous_value, previous_version_id, changed_at FROM memory_versions WHERE memory_entry_id = ? ORDER BY changed_at";
        let mut hist_stmt = v1_conn.prepare(history_sql)?;
        let history_rows: Vec<HistoryRow> = hist_stmt.query_map(
            rusqlite::params![&mem.v1_memory_id],
            |row| Ok(HistoryRow {
                previous_value: row.get(1)?,
                previous_version_id: row.get(2)?,
                changed_at: row.get(3)?,
            })
        )?.filter_map(|r| r.ok()).collect();

        for (idx, hist) in history_rows.iter().enumerate() {
            let next_change = if idx + 1 < history_rows.len() { &history_rows[idx + 1].changed_at } else { &mem.updated_at };
            let hist_content_hash = crate::migrate::content_hash::compute(&hist.previous_value, &scope_id.0);
            // Note: Version numbering for history rows: V1's previous_value was BEFORE V1's "current"; in V2 these are versions 1..N where the current row is N+1. We need to UPDATE the current row's version after counting history.
            // Implementation detail: this code path is simplified; a full impl assigns version numbers atomically.
            scope_tx.execute(
                "INSERT INTO entries (entry_id, version, entry_class, content, content_hash, tags, valid_from, valid_to, invalidation_reason, critical_flag, created_by_key_hash)
                 VALUES (?, ?, 'memory', ?, ?, ?, ?, ?, 'updated', 0, NULL)",
                rusqlite::params![&new_entry_id, idx as u32 + 1, hist.previous_value, hist_content_hash, tags_json, hist.changed_at, next_change],
            )?;
            report.memory_history += 1;
        }

        // Provenance: V1 may have memory_journal_provenance rows linking V1 memory ↔ V1 journal.
        // V2 keeps the table (Q5B) — but provenance rows reference NEW entry IDs (post-migration).
        // We need a mapping V1_memory_id → new_v2_entry_id and V1_journal_id → new_v2_entry_id.
        // Build this mapping during the transforms; populate provenance at the end.
        report.id_mapping.insert(mem.v1_memory_id.clone(), new_entry_id.clone());
    }

    Ok(())
}

#[derive(Debug)]
struct MemoryRow { v1_memory_id: String, v1_entry_id: String, v1_key: String, v1_value: String, v1_version_id: String, archived_at: Option<String>, updated_at: String, superseded_by: Option<String>, entry_created_at: String }
struct HistoryRow { previous_value: String, previous_version_id: String, changed_at: String }

fn fetch_v1_tags_for_entry(_v1_conn: &Connection, _v1_entry_id: &str) -> Result<Vec<String>> {
    // SELECT t.name FROM tags t JOIN entry_tags et ON et.tag_id = t.id WHERE et.entry_id = ?
    todo!("Phase 8 — query V1 tags via entry_tags join")
}
```

**Other transforms** (`journal.rs`, `status.rs`, `handoff.rs`) follow the same pattern — read V1 row, build V2 row with new UUID, content_hash, tags JSON; INSERT into scope_tx. Status transform additionally splits V1 status_sections into V2 status_sections rows with `version=1` and `valid_to=NULL`.

**Key migration (`src/migrate/keys.rs`):**

```rust
use rusqlite::Connection;
use crate::error::Result;
use crate::types::key::{KeyHash, KeyValue};
use std::path::Path;

/// CEO pre-build review item A9: takes `&mut Vec<PathBuf>` to track V2 key files written
/// (so failure cleanup in orchestrator can delete them).
/// Master-key flow per CEO pre-build review Option 1: V1 keys (including V1's master)
/// become V2 sub-keys with is_master_key=0; V2 master is the SEPARATE fresh key minted by
/// `aletheia-v2 setup` BEFORE migration runs.
pub fn transform(
    v1_conn: &Connection,
    target_v2_data_dir: &Path,                // V2 install directory (~/.aletheia-v2/)
    v1_data_dir: &Path,                       // V1 install directory (~/.aletheia-v2/) — for reading V1 raw key values
    registry_conn: &Connection,
    v1_meta: &super::v1_intro::V1Meta,
    report: &mut super::report::MigrationReport,
    created_key_files: &mut Vec<std::path::PathBuf>,  // tracks files for failure cleanup
) -> Result<()> {
    // V1 stored raw key values DIRECTLY in DB (sensitive!). V2 stores SHA-256 hashes only.
    // V1 ALSO wrote raw values to ~/.aletheia-v2/keys/<name>.key files at bootstrap; we prefer
    // reading from files where available (matches V2's file-only storage model), falling back
    // to the V1 DB column if a file is missing.
    let v1_keys = {
        let mut stmt = v1_conn.prepare("SELECT id, key_value, permissions, created_by, entry_scope, created_at, COALESCE(revoked, 0), name FROM keys")?;
        stmt.query_map([], |row| Ok(V1Key {
            key_id: row.get(0)?,
            v1_raw_value: row.get::<_, String>(1)?,
            permissions: row.get(2)?,
            created_by: row.get(3)?,
            entry_scope: row.get(4)?,
            created_at: row.get(5)?,
            revoked: row.get::<_, i64>(6)? > 0,
            name: row.get(7)?,
        }))?.filter_map(|r| r.ok()).collect::<Vec<_>>()
    };

    for v1_key in v1_keys {
        // Prefer reading raw value from V1 key file (matches V2's file storage model);
        // fallback to V1 DB column if file missing (some V1 keys may not have files)
        let raw_value = if let Some(name) = &v1_key.name {
            let v1_key_file = v1_data_dir.join("keys").join(format!("{}.key", name));
            if v1_key_file.exists() {
                std::fs::read_to_string(&v1_key_file).map(|s| s.trim().to_string()).unwrap_or(v1_key.v1_raw_value.clone())
            } else {
                v1_key.v1_raw_value.clone()
            }
        } else {
            v1_key.v1_raw_value.clone()
        };

        let key_value = KeyValue(raw_value.clone());
        let key_hash = crate::auth::keys::hash_key(&key_value);

        // Look up scope_uuid for this V1 key's entry_scope
        let primary_scope_id = if let Some(scope_name) = v1_key.entry_scope.as_deref() {
            registry_conn.query_row(
                "SELECT scope_id FROM scopes WHERE name = ?",
                rusqlite::params![scope_name], |row| row.get::<_, String>(0),
            ).unwrap_or_else(|_| {
                // V1 key references a scope that wasn't found in V2's scopes (shouldn't happen if introspection is correct)
                tracing::warn!("V1 key {} references unknown scope '{}'; assigning to 'default' scope", v1_key.key_id, scope_name);
                "default".to_string()
            })
        } else {
            // V1 key with NULL entry_scope = V1's master key OR an unscoped key.
            // Per Option 1 master-key flow: V1's master becomes a V2 sub-key (is_master_key=0)
            // attached to V2's "default" scope (which V2 setup creates if missing).
            registry_conn.query_row(
                "SELECT scope_id FROM scopes WHERE name = 'default'",
                [], |row| row.get::<_, String>(0),
            ).unwrap_or_else(|_| "default".to_string())
        };

        let writable_scope_ids = serde_json::to_string(&vec![&primary_scope_id])?;
        let readonly_scope_ids = "[]".to_string();
        let revoked_at = if v1_key.revoked { Some(chrono::Utc::now().to_rfc3339()) } else { None };

        // CRITICAL Option 1 invariant: is_master_key=0 for ALL migrated V1 keys, even V1's master.
        // V2's master was minted by `aletheia-v2 setup` BEFORE this migration ran (separate key).
        registry_conn.execute(
            "INSERT INTO keys (key_id, key_hash, name, permissions, created_by_key_id, primary_scope_id, writable_scope_ids, readonly_scope_ids, is_master_key, is_digest_key, created_at, revoked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)",
            rusqlite::params![v1_key.key_id, key_hash.0, v1_key.name, v1_key.permissions, v1_key.created_by, primary_scope_id, writable_scope_ids, readonly_scope_ids, v1_key.created_at, revoked_at],
        )?;

        // Write key file at V2 location (~/.aletheia-v2/keys/<name>.key)
        if let Some(name) = &v1_key.name {
            let v2_key_path = target_v2_data_dir.join("keys").join(format!("{}.key", name));
            std::fs::write(&v2_key_path, &raw_value)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&v2_key_path)?.permissions();
                perms.set_mode(0o600);
                std::fs::set_permissions(&v2_key_path, perms)?;
            }
            created_key_files.push(v2_key_path);  // track for failure cleanup (A9)
        }

        report.keys_planned.push(super::report::KeyPlanReport {
            v1_key_id: v1_key.key_id.clone(),
            v2_key_hash: key_hash.0.clone(),
            v2_key_file: v1_key.name.as_ref().map(|n| target_v2_data_dir.join("keys").join(format!("{}.key", n)).to_string_lossy().to_string()).unwrap_or_default(),
            permissions: v1_key.permissions.clone(),
            primary_scope: primary_scope_id,
            was_v1_master: v1_key.entry_scope.is_none() && v1_key.permissions == "maintenance",
        });
    }

    Ok(())
}

struct V1Key { key_id: String, v1_raw_value: String, permissions: String, created_by: Option<String>, entry_scope: Option<String>, created_at: String, revoked: bool, name: Option<String> }
```

**Migration report (`src/migrate/report.rs`):**

Captures per-scope row counts, dropped table data summary, total duration, any rows skipped.

**CLI subcommand integration (`src/main.rs`):**

```rust
Commands::MigrateFromV1 { v1_db_path, target_v2_data_dir, confirm_backup_taken, dry_run, force, stage_digest_as_mass_ingest } => {
    let master_key_path = std::env::var("ALETHEIA_MASTER_KEY_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap().join(".aletheia/keys/master.key"));
    let master_key = crate::auth::keys::read_key_file(&master_key_path)?;
    let params = MigrateFromV1Params { v1_db_path, target_v2_data_dir, confirm_backup_taken, dry_run, force, stage_digest_as_mass_ingest };
    let report = aletheia::migrate::orchestrator::migrate_from_v1(&master_key, params).await?;
    println!("{}", report.render_human_readable());
    Ok(())
}
```

<guidance>
**On version numbering for memory history:** The example pseudocode glosses over a subtle issue. V1's `memory_versions` table holds the PRIOR values; V1's current `memory_entries` row is the LATEST value. In V2's append-only model, all versions are rows in `entries` with sequential version numbers. The cleanest mapping: history rows get versions 1..N (ordered by changed_at); the current row gets version N+1. We need TWO passes: first count history rows, then INSERT current with version=N+1, then INSERT history rows. OR: insert all rows with placeholder version=0, then UPDATE versions atomically post-insert. Phase 8 implementation chooses; recommend two-pass for clarity.

**On lazy first-claim digest trigger:** Phase 3's `claim()` flow (or the MCP server startup) checks `scopes.digest_pending_v1_migration` for the just-claimed scope. If set, enqueues `digest_queue` row with trigger=`entry_threshold` (since trigger=`v1_migration_lazy` isn't a real trigger type). Then sets `digest_pending_v1_migration=0` to prevent re-trigger.

**On `--force` semantics:** If V2 data already exists at target, `--force` allows overwriting. This is destructive — Phase 8 should rename the existing V2 data dir to `<dir>.bak.<timestamp>` before proceeding (preserve user's existing V2 data even with --force). Audit log captures the rename.

**On the FTS5 disable optimization (mentioned in CR-5):** During bulk migration of thousands of entries, the FTS5 sync triggers fire per-INSERT. For Phase 8, recommend wrapping per-scope transforms with `DROP TRIGGER trg_entries_fts_insert; ... migrations ...; CREATE TRIGGER ...; INSERT INTO entries_fts(entries_fts) VALUES('rebuild');`. This converts N trigger-per-row inserts into 1 batch FTS5 rebuild — typically 10-100× faster for large corpora.

**On memory_journal_provenance preservation:** V1 has this table; V2 keeps it (Q5B). The transforms build a `id_mapping` (V1 ID → V2 entry_id) per scope; at the end, walk V1's memory_journal_provenance and INSERT translated rows into the V2 scope's `memory_journal_provenance`. This is a separate sub-task in the orchestrator.
</guidance>

### Integration Points
- **Phase 2 schemas:** Migration uses `crate::db::scope_schema::install_all` and `crate::db::registry_schema::install_all` to create V2 schemas. These functions don't exist yet — Phase 2 should expose them as part of its module. (Retroactive amendment: `install_all(conn)` runs all DDL constants in order.)
- **Phase 3 keys:** Migration uses `crate::auth::keys::hash_key` to compute V2's key_hash from V1's raw key values. V1 stored raw values in DB — V2 stores hashes only. Migration is the ONLY time raw values from V1 are read into V2.
- **Phase 7 first-claim digest:** Lazy trigger marker (`scopes.digest_pending_v1_migration=1`) is checked in `claim()`. Marker set during Phase 8 migration; cleared on first claim.
- **Phase 9 reconciliation:** If Phase 8 migration fails partially (rare — all-scope-atomic), `migration_state.is_applying=1` AND `status='failed'`. Phase 9's reconciler can flag this for admin attention; resolution is `force_unlock` (master-key, audited).

### Expected Outcomes
- `cargo test` passes for migration modules (each transform unit-tested with synthetic V1 data)
- E2E test: produce a synthetic V1 SQLite DB with 10 scopes × 100 entries each (mix of journal/memory/status/handoff); run migrate_from_v1; verify V2 has 10 scope .db files, scope_registry has 10 scopes, total entries match (with memory history expansion accounting for memory_versions rows)
- E2E test: dry-run mode emits the migration report without writing anything
- E2E test: --force semantics: existing V2 dir gets renamed to .bak.<timestamp>; migration proceeds
- E2E test: failure recovery: introduce a SQL error in mid-migration (e.g., corrupt V1 row); verify created scope files are deleted; migration_state row marked failed; V1 DB NOT renamed (still original path)
- E2E test: keys round-trip: V1 key with permissions=read-write + entry_scope=hockey + revoked=0 → V2 keys row with same key_hash + name + scope mapping correct + revoked_at=NULL; V2 key file exists with mode 0600
- E2E test: lazy first-claim trigger: post-migration, claim a scope; verify entry_threshold trigger enqueued; `digest_pending_v1_migration` flipped to 0
- E2E test: V1 DB renamed to `.bak.aletheia-v1-pre-migration` post-success; original path no longer exists; backup file readable

### Testing Recommendations
- Generate synthetic V1 SQLite DBs of varying complexity (small: 1 scope/10 entries; medium: 5 scopes/100 each; large: 20 scopes/1000 each)
- Test each transform in isolation with hand-crafted V1 input
- Test memory history version numbering: V1 with 1 current + 3 history rows → V2 should have 4 entries rows (versions 1-3 = history, version 4 = current); current row's version > all history versions
- Test memory_journal_provenance preservation: V1 with 5 provenance rows → V2 has 5 provenance rows with translated IDs
- Test tag denormalization: V1 entry with 5 tags → V2 entries.tags JSON array contains all 5 tag strings
- Test --stage-digest-as-mass-ingest: post-migration, mass_ingest_requests rows exist for each scope with status=pending
- Test FTS5 trigger disable optimization: time bulk insert with vs without trigger disable; verify the disable path is faster
- Performance test: 10k V1 rows migrate in <30 seconds on a typical dev machine
</core>
</section>
<!-- /phase:8 -->

<!-- conductor-review:8 -->
<section id="conductor-review-8">
## Conductor Review: Post-Phase 8

<core>
### Verification Checklist

<mandatory>All checklist items must be verified before proceeding.</mandatory>

- [ ] `aletheia-v2 migrate-from-v1` is V2-master-key gated (verifies key_hash matches a `is_master_key=1` row in V2 keys; V2 setup must have run first to mint the V2 master)
- [ ] `--confirm-backup-taken` flag is required (refusal error otherwise)
- [ ] **Side-by-side install verified**: V1 DB at `~/.aletheia/data/aletheia.db` is NEVER renamed or modified by V2 migration (read-only access only). After successful migration, V1 DB exists exactly as before. NO `.bak` rename — that was the old single-install model; now removed.
- [ ] V2 install at `~/.aletheia-v2/` already exists (created by `aletheia-v2 setup`); `migrate_from_v1` uses `OPEN_READ_WRITE` (not `CREATE`) on `scope_registry.db`
- [ ] **Active V1 session detection (A6)**: `scan_active_v1_sessions` enumerates `~/.aletheia-v2/sockets/aletheia-*.sock` and filters by `kill(pid, 0)`; refusal returned if any are alive UNLESS `--ignore-active-sessions`
- [ ] **V1 schema_version constraint (A8)**: refusal returned if introspected schema_version < 4 with clear error message
- [ ] Atomicity: introduce a fault mid-migration → verify ALL created V2 scope .db files AND V2 key files are deleted + migration_state row status='failed' AND `is_applying=0` (per A10: full-cleanup case flips flag back)
- [ ] All transforms preserve V1 row counts (verified by `crate::migrate::validation::verify_row_counts` post-migration; per A5)
- [ ] **Memory history version numbering two-pass (A1)**: V1's "1 current + N history" → V2's "1..N+1 versions, N+1 is current". Verify via test with 3-version V1 chain → V2 entries with versions 1, 2, 3, 4 (4 = current; 1-3 = history with sequential changed_at timestamps)
- [ ] **`fetch_v1_tags_for_entry` (A2)**: SQL JOIN `tags JOIN entry_tags ON entry_tags.tag_id = tags.id WHERE entry_tags.entry_id = ?` is used; tags returned in deterministic (alphabetical) order
- [ ] Tags denormalized: V1's normalized tags+entry_tags → V2's entries.tags JSON array per row
- [ ] V1.memory_entries.key → tag `key:<value>` on V2 row (Q5A)
- [ ] V1.entries.id → tag `entry_id_legacy:<v1-uuid>` on V2 row (Q5A)
- [ ] V1.journal_entries.sub_section → tag `sub_section:<value>` on V2 row (Q5D)
- [ ] **Provenance translation pass (A3)**: `crate::migrate::provenance::translate_all` runs after all per-scope transforms; walks V1 `memory_journal_provenance` → INSERTs into each scope's V2 `memory_journal_provenance` using id_mapping; orphan rows logged
- [ ] **Handoff count (A4)**: `count_handoffs_per_scope` JOINs through V1 `keys.entry_scope` to count handoffs per scope (no longer hardcoded 0)
- [ ] V1 keys → V2 keys table with key_hash = SHA-256(raw_value); raw values written to `~/.aletheia-v2/keys/<name>.key` files (mode 0600); key_value column NEVER stored in V2 DB
- [ ] V1 revoked=1 keys → V2 revoked_at=NOW (Phase 8 migration uses NOW since V1 didn't track when revocation happened)
- [ ] **Master-key flow Option 1 verified**: V2 master key (separate from V1 master) was minted by `aletheia-v2 setup` BEFORE migration; ALL V1 keys (including V1's master) inserted into V2 keys with `is_master_key=0`
- [ ] **Failure cleanup includes V2 key files (A9)**: `created_key_files: Vec<PathBuf>` is populated by `keys::transform`; on failure, both `created_scope_files` AND `created_key_files` are deleted
- [ ] Lazy first-claim trigger: `scopes.digest_pending_v1_migration=1` set per scope; claim() checks and enqueues digest_queue trigger=entry_threshold; flag flips to 0 post-enqueue
- [ ] FTS5 bulk-insert optimization in place: per-scope transform DROPs FTS5 triggers + REBUILDs at end (verify performance test shows ≥5× speedup vs trigger-per-row)
- [ ] **Dry-run report schema (A7)**: `MigrationReport::dry_run` produces structured JSON matching the documented schema; both JSON and markdown variants written to `~/.aletheia-v2/dry-run-reports/<timestamp>.{json,md}`
- [ ] **Deterministic scope_uuid in dry-run**: `deterministic_scope_uuid(namespace)` produces SHA-256-derived UUID so dry-run report and actual migration produce matching scope_uuid values
- [ ] Audit events emitted: `migration.v1_migration_started`, `migration.v1_migration_scope_completed`, `migration.v1_migration_completed`, `migration.v1_migration_failed`
- [ ] CLI `aletheia-v2 migrate-from-v1 <path> --confirm-backup-taken` works end-to-end (E2E test against the actual CEO V1 DB per `decisions/aletheia-v2/migration-walkthrough.md`)
- [ ] CLI `aletheia-v2 migrate-from-v1 <path> --dry-run` produces both JSON + markdown reports without writing any per-scope .db or key files
- [ ] Run context compaction (`/lethe compact`) before launching Phase 10

### Known Risks
- **V1's raw key values in DB are sensitive:** V1 stored `key_value` directly in the keys table (Hermes spike findings). During migration, these raw values are read into memory + hashed + the raw value is also written to a V2 key file. If migration fails mid-key-table, the partial V2 key files remain. Phase 8 cleanup logic should ALSO delete V2 key files on failure (currently only deletes scope .db files). **Add to checklist: failure cleanup includes V2 key files.**
- **V1 schemas vary by version:** The introspection assumes V1 schema_version=4 (current). V1 schema_version<4 may have missing columns (e.g., `revoked` was added in migration 4, `name` was added in migration 4). Phase 8 introspection should detect schema_version and handle missing columns gracefully (use default values). Document the minimum supported V1 version explicitly (recommend: V1 schema_version >= 3).
- **Cross-scope content_hash collisions:** Same content in different V1 namespaces will produce DIFFERENT V2 content_hashes (because `SHA-256(content + scope_id)` includes scope). This is by design (per Phase 2 — each scope is independent). Verify no test accidentally checks "same content = same hash across scopes" (would fail).
- **V1 memory_entries with NULL `value`:** V1 may have edge cases with NULL or empty values. Handle as empty string in V2; log warning per row.
- **V1 entries with NULL project_namespace:** Mapped to a synthetic "default" scope. If users have many entries in NULL namespace, the "default" scope will be very large. Acceptable; document for users.
- **V1 status_documents.undo_content:** Dropped during transform (V2 uses append-only versioning). Document the loss; one-line entry in migration report.
- **V1 status_documents.version_id:** Opaque hex value used by V1 for OCC. V2 uses INTEGER version. Migration drops version_id; V2's version starts at 1.
- **Performance on huge corpora:** 100k+ entries may take >5 minutes. Provide progress output to stdout (`tracing::info!` at scope boundaries works). Document expected duration in user-facing help.
- **Disk space during migration:** V1 + V2 + .bak temporarily occupy 3× the data. Document; recommend pre-migration disk-space check.

### Guidance for Phase 9 + Phase 10

<guidance>
**Phase 9 (Reconciliation + Operational Polish + Shadow Mode) and Phase 10 (Distribution + Release)** can largely run in parallel. Phase 9 is implementation work; Phase 10 is release packaging that needs all implementation complete.

**Phase 9 sub-tasks** (4 parallel) covered in CR-7 above.

**Phase 10 sub-tasks** (4 parallel):
1. cargo-dist setup (`Cargo.toml` workspace metadata + `dist-workspace.toml` config)
2. JS wrapper shim (`packages/aletheia-v2/index.js` with stdio inherit + signal forwarding)
3. GitHub Actions multi-target matrix (`.github/workflows/release.yml`)
4. npm publish workflow + documentation (README, install instructions, V1 → V2 migration guide for end users)

Context management: Run `/lethe compact` before launching Phases 9 + 10.
</guidance>
</core>
</section>
<!-- /conductor-review:8 -->

<!-- phase:9 -->
<section id="phase-9">
## Phase 9: Reconciliation + Operational Polish + Shadow Mode

<core>
### Objective
Build the operational layer that makes V2 production-ready: cross-DB reconciliation (Q8) recovers orphaned operations from `sys_audit_log` scans; tool deprecation lifecycle wraps tool responses with deprecated/removed metadata + dedup'd usage tracking; orphan sweepers prune session_id files and sdk-runtime/ directories; **Shadow Mode infrastructure** (CEO Item 1) — V2 ships the plumbing but does NOT ship the V1 ranking pure function (V3 plugs the comparison signal at V3-build time). After Phase 9, V2 is operationally complete; only distribution (Phase 10) remains.

### Prerequisites
- Phase 2 complete: `sys_audit_log`, `shadow_comparison_log`, `_audit_log_unlock` tables; audit log emission helpers
- Phase 6 complete: `ScoringEngine` exists with hookable observation point; `Signal` trait defined
- Phase 7 complete: digest pipeline + audit event vocabulary including `*_proposed`/`_started`/`_committed`/`_completed` patterns
- Phase 4's Registrar pattern: ready to receive `register_reconciler_sweep`, `register_session_orphan_sweep`, `register_sdk_runtime_cleanup`, `register_shadow_mode_observer`

### Implementation

<mandatory>The reconciler MUST scan `sys_audit_log` for `*_proposed` / `_started` events without matching `*_committed` / `*_completed` events within the configured window (24h default). For each orphan: dispatch to a per-operation-type recovery handler. Operations MUST be idempotent — re-running an already-completed promotion or a finished feature_wrap_up MUST be a no-op (verified via content_hash dedup at target).</mandatory>

<mandatory>Tool deprecation lifecycle MUST track usage with **session-scoped dedup**: at most one `tool_deprecated_usage` audit event per `(session_id, tool_name)` per day. This prevents log flooding from agents that call a deprecated tool many times per session. The dedup table is in-memory (cleared on MCP server restart — re-floods on restart are acceptable).</mandatory>

<mandatory>Shadow Mode V2 ships the **infrastructure** only — `shadow_comparison_log` schema, sampling hook in scoring pipeline, `analyze_shadow_mode` MCP tool, pluggable signal interface for the comparison ranker. Per CEO Item 1, V2 does NOT ship the `v1_rank` pure function — it's pulled in at V3-build time as the comparison-signal-plugin. The `v1_rank` slot uses a `Box<dyn ShadowComparisonRanker>` trait object; V2 ships a `NoOpComparisonRanker` that returns `None` (no comparison performed). V3 ships a `BaselineComparisonRanker` implementation.</mandatory>

**Module structure (added in Phase 9):**

```
src/
├── reconciler/
│   ├── mod.rs                 # Aggregator + entry point
│   ├── scanner.rs             # sys_audit_log orphan-event scanner (24h window default)
│   ├── handlers/
│   │   ├── mod.rs
│   │   ├── promote_memory.rs  # Cross-DB recovery for promote_memory orphans
│   │   ├── feature_wrap.rs    # Re-run synthesis for feature_wrap orphans (idempotent via content_hash)
│   │   ├── migration.rs       # V1 / generic migration orphan handling (mostly: surface to admin, no auto-recovery)
│   │   └── digest.rs          # digest_queue lease orphan check (Phase 7 already handles via lease TTL; reconciler verifies)
│   └── sweep.rs               # Background reconciliation sweep (5min cadence)
├── server/
│   └── deprecation.rs         # Tool deprecation lifecycle: deprecated/removed states + response wrapping + dedup'd usage tracking
├── sweepers/
│   ├── mod.rs
│   ├── session_orphans.rs     # Prune ~/.aletheia-v2/sessions/<dead_pid>.session_id files (5min cadence)
│   └── sdk_runtime.rs         # Prune ~/.aletheia-v2/sdk-runtime/<queue_id>/ directories older than 24h
└── shadow/
    ├── mod.rs                 # Aggregator
    ├── comparison_ranker.rs   # `ShadowComparisonRanker` trait + NoOpComparisonRanker (V2 default)
    ├── sampler.rs             # Sampling decision (per `[shadow.sampling_rate]`)
    ├── observer.rs            # Wraps ScoringEngine score calls with comparison logging
    ├── log.rs                 # shadow_comparison_log writes
    └── analysis.rs            # analyze_shadow_mode MCP tool implementation (master-key only)
```

**Reconciler scanner (`src/reconciler/scanner.rs`):**

```rust
use rusqlite::Connection;
use crate::error::Result;
use chrono::{DateTime, Utc, Duration};

#[derive(Debug, Clone)]
pub struct OrphanEvent {
    pub event_type: String,                  // e.g., "critical_entry_promotion_proposed"
    pub event_at: DateTime<Utc>,
    pub scope_id: Option<String>,
    pub actor_key_hash: Option<String>,
    pub details: serde_json::Value,
}

#[derive(Debug)]
pub struct OrphanReport {
    pub promote_memory_orphans: Vec<OrphanEvent>,
    pub feature_wrap_orphans: Vec<OrphanEvent>,
    pub migration_orphans: Vec<OrphanEvent>,
    pub digest_lease_orphans: Vec<OrphanEvent>,
}

pub fn scan(conn: &Connection, since_hours: u32) -> Result<OrphanReport> {
    let since = (Utc::now() - Duration::hours(since_hours as i64)).to_rfc3339();
    let mut report = OrphanReport {
        promote_memory_orphans: vec![],
        feature_wrap_orphans: vec![],
        migration_orphans: vec![],
        digest_lease_orphans: vec![],
    };

    // promote_memory: *_proposed without matching *_committed/*_denied
    let promote_orphans: Vec<OrphanEvent> = collect_orphans_pair(
        conn, &since,
        "critical_entry_promotion_proposed",
        &["critical_entry_promotion_committed", "critical_entry_promotion_denied"],
        |details| details.get("entry_id").and_then(|v| v.as_str()).map(String::from),
    )?;
    report.promote_memory_orphans = promote_orphans;

    // feature_wrap: feature_wrapped_up without matching digest_committed for the corresponding queue
    let wrap_orphans: Vec<OrphanEvent> = collect_orphans_pair(
        conn, &since,
        "feature_wrapped_up",
        &["digest_committed"],
        |details| details.get("queue_id").and_then(|v| v.as_i64()).map(|i| i.to_string()),
    )?;
    report.feature_wrap_orphans = wrap_orphans;

    // migration: *_started without matching *_completed/*_failed
    report.migration_orphans = collect_orphans_pair(
        conn, &since,
        "v1_migration_started",
        &["v1_migration_completed", "v1_migration_failed"],
        |_| None,
    )?;

    // digest_queue lease orphans (rows where status='leased' AND lease_expires_at < NOW)
    // Phase 7's `recover_expired_leases` already handles this; reconciler just verifies + logs
    let leased_count: u64 = conn.query_row(
        "SELECT COUNT(*) FROM digest_queue WHERE status='leased' AND lease_expires_at < CURRENT_TIMESTAMP",
        [], |row| row.get(0),
    )?;
    if leased_count > 0 {
        report.digest_lease_orphans.push(OrphanEvent {
            event_type: "digest_lease_expired".into(),
            event_at: Utc::now(),
            scope_id: None,
            actor_key_hash: None,
            details: serde_json::json!({"count": leased_count}),
        });
    }

    Ok(report)
}

fn collect_orphans_pair(
    conn: &Connection,
    since: &str,
    proposed_type: &str,
    completed_types: &[&str],
    correlation_key: impl Fn(&serde_json::Value) -> Option<String>,
) -> Result<Vec<OrphanEvent>> {
    // Find proposed events
    let mut stmt = conn.prepare(
        "SELECT event_at, scope_id, actor_key_hash, details FROM sys_audit_log WHERE event_type=? AND event_at > ? ORDER BY event_at"
    )?;
    let proposed: Vec<OrphanEvent> = stmt.query_map(
        rusqlite::params![proposed_type, since],
        |row| Ok(OrphanEvent {
            event_type: proposed_type.to_string(),
            event_at: chrono::DateTime::parse_from_rfc3339(&row.get::<_, String>(0)?).unwrap_or_default().with_timezone(&Utc),
            scope_id: row.get(1)?,
            actor_key_hash: row.get(2)?,
            details: row.get::<_, Option<String>>(3)?.as_deref().map(serde_json::from_str).transpose().ok().flatten().unwrap_or(serde_json::Value::Null),
        })
    )?.filter_map(|r| r.ok()).collect();

    // For each proposed, check if any completed event with matching correlation key exists
    let mut orphans = vec![];
    for prop in proposed {
        let key = correlation_key(&prop.details);
        let placeholders: Vec<&str> = completed_types.iter().map(|_| "?").collect();
        let placeholders_str = placeholders.join(",");
        let mut completion_check = conn.prepare(&format!(
            "SELECT COUNT(*) FROM sys_audit_log WHERE event_type IN ({}) AND event_at > ?",
            placeholders_str
        ))?;
        let mut params: Vec<&dyn rusqlite::ToSql> = completed_types.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        params.push(&prop.event_at as &dyn rusqlite::ToSql);
        let count: u64 = completion_check.query_row(&params[..], |row| row.get(0))?;
        if count == 0 {
            orphans.push(prop);
        }
    }
    Ok(orphans)
}
```

**Recovery handlers (`src/reconciler/handlers/promote_memory.rs`):**

```rust
use crate::reconciler::scanner::OrphanEvent;
use crate::error::Result;
use rusqlite::Connection;

pub fn recover(conn: &Connection, orphan: &OrphanEvent) -> Result<RecoveryAction> {
    // Per Phase 5 promote_memory: tombstones source + inserts target.
    // Recovery: check both states.
    let entry_id = orphan.details.get("entry_id").and_then(|v| v.as_str()).ok_or_else(|| crate::error::AletheiaError::Other("missing entry_id".into()))?;
    let target_scope = orphan.details.get("target_scope").and_then(|v| v.as_str()).ok_or_else(|| crate::error::AletheiaError::Other("missing target_scope".into()))?;
    let new_entry_id = orphan.details.get("new_entry_id").and_then(|v| v.as_str()).ok_or_else(|| crate::error::AletheiaError::Other("missing new_entry_id".into()))?;

    // Source tombstoned? Check valid_to NOT NULL on source entry
    let source_tombstoned: bool = check_source_tombstoned(conn, entry_id, &orphan.scope_id)?;
    let target_inserted: bool = check_target_inserted(conn, new_entry_id, target_scope)?;

    match (source_tombstoned, target_inserted) {
        (true, true) => {
            // Both done — back-fill the missing committed event
            crate::db::audit_log::emit_event(
                conn, crate::types::audit::AuditEventCategory::Reconciliation, "reconciliation_backfilled_promotion_committed",
                orphan.scope_id.as_deref(), None, None,
                Some(&serde_json::json!({"entry_id": entry_id, "new_entry_id": new_entry_id, "target_scope": target_scope}))
            )?;
            Ok(RecoveryAction::BackfilledCommitted)
        }
        (false, true) => {
            // Target inserted but source not tombstoned — complete the tombstone
            tombstone_source(conn, entry_id, &orphan.scope_id, new_entry_id, target_scope)?;
            crate::db::audit_log::emit_event(
                conn, crate::types::audit::AuditEventCategory::Reconciliation, "reconciliation_completed_promotion_tombstone",
                orphan.scope_id.as_deref(), None, None,
                Some(&serde_json::json!({"entry_id": entry_id}))
            )?;
            Ok(RecoveryAction::CompletedSourceTombstone)
        }
        (true, false) => {
            // Source tombstoned but target missing — INSERT target (idempotent via content_hash)
            insert_target(conn, entry_id, &orphan.scope_id, new_entry_id, target_scope)?;
            crate::db::audit_log::emit_event(
                conn, crate::types::audit::AuditEventCategory::Reconciliation, "reconciliation_completed_promotion_target_insert",
                orphan.scope_id.as_deref(), None, None,
                Some(&serde_json::json!({"entry_id": entry_id}))
            )?;
            Ok(RecoveryAction::CompletedTargetInsert)
        }
        (false, false) => {
            // Neither happened — promotion was approved but never executed (likely process died between approval and start)
            // Conservative: leave as-is, surface to admin via warning audit event
            crate::db::audit_log::emit_event(
                conn, crate::types::audit::AuditEventCategory::Reconciliation, "reconciliation_orphan_unresolved",
                orphan.scope_id.as_deref(), None, None,
                Some(&serde_json::json!({"orphan_event": &orphan.event_type, "entry_id": entry_id, "guidance": "Re-run promote_memory manually if intent stands"}))
            )?;
            Ok(RecoveryAction::SurfacedToAdmin)
        }
    }
}

/// Source row in source scope is tombstoned iff its valid_to is non-NULL with reason matching `promoted_to:<new_entry_id>@*`.
/// Implementation queries the source scope (attached as e.g. `w_<short>`) via the alias
/// resolved from the audit-log event's `scope_id` field through `ConnectionManager::alias_for`.
fn check_source_tombstoned(conn: &Connection, entry_id: &str, scope_id: &Option<String>) -> Result<bool> {
    let alias = scope_alias_for(scope_id.as_deref())?;
    let q = format!(
        "SELECT EXISTS(
            SELECT 1 FROM {alias}.entries
            WHERE entry_id = ? AND valid_to IS NOT NULL
              AND invalidation_reason LIKE 'promoted_to:%'
         )",
        alias = alias
    );
    conn.query_row(&q, rusqlite::params![entry_id], |row| row.get(0)).map_err(Into::into)
}

/// Target row in target scope exists iff a current (valid_to IS NULL) row with the new_entry_id is present.
fn check_target_inserted(conn: &Connection, new_entry_id: &str, target_scope: &str) -> Result<bool> {
    let alias = scope_alias_for(Some(target_scope))?;
    let q = format!(
        "SELECT EXISTS(SELECT 1 FROM {alias}.entries WHERE entry_id = ? AND valid_to IS NULL)",
        alias = alias
    );
    conn.query_row(&q, rusqlite::params![new_entry_id], |row| row.get(0)).map_err(Into::into)
}

/// Idempotent: sets source's valid_to + invalidation_reason if not already set.
fn tombstone_source(conn: &Connection, entry_id: &str, scope_id: &Option<String>, new_entry_id: &str, target_scope: &str) -> Result<()> {
    let alias = scope_alias_for(scope_id.as_deref())?;
    let reason = format!("promoted_to:{}@{}", new_entry_id, target_scope);
    let sql = format!(
        "UPDATE {alias}.entries
         SET valid_to = CURRENT_TIMESTAMP, invalidation_reason = ?
         WHERE entry_id = ? AND valid_to IS NULL",
        alias = alias
    );
    conn.execute(&sql, rusqlite::params![reason, entry_id])?;
    Ok(())
}

/// Idempotent: copies source content + tags to target scope as a new entry; uses INSERT OR IGNORE
/// against the content_hash unique-by-active constraint to avoid double-insert if reconciler re-runs.
fn insert_target(conn: &Connection, source_entry_id: &str, source_scope: &Option<String>, new_entry_id: &str, target_scope: &str) -> Result<()> {
    let src_alias = scope_alias_for(source_scope.as_deref())?;
    let tgt_alias = scope_alias_for(Some(target_scope))?;

    // Read source row (could be the live row pre-tombstone or the tombstoned row depending on prior partial state)
    let src_row: Option<(String, String, String, i32)> = conn.query_row(
        &format!("SELECT content, tags, COALESCE(reasoning_trace, ''), critical_flag FROM {alias}.entries
                  WHERE entry_id = ? ORDER BY version DESC LIMIT 1", alias = src_alias),
        rusqlite::params![source_entry_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional()?;

    let (content, tags, reasoning_trace, critical_flag) = src_row.ok_or_else(|| {
        crate::error::AletheiaError::Other(format!("Source entry {} not found in scope alias {}", source_entry_id, src_alias))
    })?;

    let content_hash = {
        use sha2::{Sha256, Digest};
        let mut h = Sha256::new();
        h.update(content.as_bytes());
        h.update(target_scope.as_bytes());
        hex::encode(h.finalize())
    };

    // INSERT OR IGNORE on content_hash for idempotency (if reconciler ran already, target row exists)
    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO {alias}.entries
             (entry_id, version, entry_class, content, content_hash, tags, supersedes_entry_id, reasoning_trace, critical_flag)
             VALUES (?, 1, 'memory', ?, ?, ?, ?, NULLIF(?, ''), ?)",
            alias = tgt_alias
        ),
        rusqlite::params![new_entry_id, content, content_hash, tags, source_entry_id, reasoning_trace, critical_flag],
    )?;
    Ok(())
}

/// Resolve scope_id (from audit log) to its attached-DB alias on the current connection.
/// Returns "main" for the primary scope, "w_<short>" / "r_<short>" for attached scopes.
/// If the scope is not currently attached on this connection, the reconciler must skip
/// this orphan (cannot recover scopes outside the current session's claim visibility);
/// returns Err in that case so the caller can log + skip.
fn scope_alias_for(scope_id: Option<&str>) -> Result<&'static str> {
    // Real implementation: takes a `&ConnectionManager` and looks up via its `alias_for(ScopeId)` method.
    // For the reconciler running at startup, this requires the master key's full claim attached.
    // Sketch — actual signature in the implementation includes the ConnectionManager reference.
    match scope_id { Some(_) => Ok("main"), None => Ok("main") }
}

#[derive(Debug)]
pub enum RecoveryAction {
    BackfilledCommitted,
    CompletedSourceTombstone,
    CompletedTargetInsert,
    SurfacedToAdmin,
}
```

**Background reconciliation sweep (`src/reconciler/sweep.rs`):**

```rust
use std::sync::Arc;
use tokio::sync::Mutex;
use rusqlite::Connection;
use std::time::Duration;
use crate::lib::settings::Settings;
use crate::error::Result;

pub fn register_reconciler_sweep(
    registry: &mut crate::server::index::ServerRegistry,
    conn: Arc<Mutex<Connection>>,
    settings: Settings,
) -> Result<()> {
    let interval_minutes = settings.scopes.reconciliation_interval_minutes;
    let since_hours = 24;  // Default scan window

    registry.spawn_bg("reconciler-sweep", async move {
        let mut tick = tokio::time::interval(Duration::from_secs(interval_minutes as u64 * 60));
        // Skip first tick (immediate startup is handled by `run_at_startup` separately)
        tick.tick().await;
        loop {
            tick.tick().await;
            let c = conn.lock().await;
            let report = match crate::reconciler::scanner::scan(&c, since_hours) {
                Ok(r) => r,
                Err(e) => { tracing::error!("reconciler scan failed: {}", e); continue; }
            };

            for orphan in &report.promote_memory_orphans {
                let _ = crate::reconciler::handlers::promote_memory::recover(&c, orphan);
            }
            for orphan in &report.feature_wrap_orphans {
                let _ = crate::reconciler::handlers::feature_wrap::recover(&c, orphan);
            }
            // migration orphans surface to admin only — no auto-recovery (admin must run resume_migration or force_unlock)
            for orphan in &report.migration_orphans {
                let _ = crate::db::audit_log::emit_event(
                    &c, crate::types::audit::AuditEventCategory::Reconciliation, "reconciliation_migration_orphan_surfaced",
                    orphan.scope_id.as_deref(), None, None,
                    Some(&serde_json::json!({"event_type": &orphan.event_type, "guidance": "Run resume_migration or force_unlock"}))
                );
            }
            // digest_queue lease orphans handled by Phase 7's poller; reconciler logs only
        }
    });
    Ok(())
}

/// Called once at MCP server startup before the periodic sweep starts.
pub async fn run_at_startup(conn: Arc<Mutex<Connection>>, since_hours: u32) -> Result<()> {
    let c = conn.lock().await;
    let report = crate::reconciler::scanner::scan(&c, since_hours)?;
    tracing::info!(target: "reconciler", "startup scan: {} promote orphans, {} wrap orphans, {} migration orphans, {} digest lease orphans",
        report.promote_memory_orphans.len(), report.feature_wrap_orphans.len(), report.migration_orphans.len(), report.digest_lease_orphans.len());
    // Recovery happens in the periodic sweep; startup is observation only (avoids cascading work in startup hot path)
    Ok(())
}
```

**Tool deprecation lifecycle (`src/server/deprecation.rs`):**

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone)]
pub struct DeprecationMetadata {
    pub deprecated: bool,
    pub deprecated_since: Option<String>,
    pub removal_planned_for: Option<String>,
    pub migration_hint: Option<String>,
    pub removed: bool,
    pub removal_since: Option<String>,
}

/// Static registry of tool deprecation state. V2 ships with all tools active; V2.x+ adds entries here.
pub fn deprecation_state(tool_name: &str) -> DeprecationMetadata {
    // V2.0.0: no deprecated tools yet. Return active.
    // Future: match tool_name against a static map populated as tools are deprecated/removed.
    DeprecationMetadata { deprecated: false, deprecated_since: None, removal_planned_for: None, migration_hint: None, removed: false, removal_since: None }
}

/// Session-scoped dedup: at most one tool_deprecated_usage event per (session_id, tool_name) per day.
/// In-memory; cleared on MCP server restart.
pub struct UsageDedupTracker {
    seen: Mutex<HashMap<(String, String, String), ()>>,  // (session_id, tool_name, date_yyyy_mm_dd) → ()
}

impl UsageDedupTracker {
    pub fn new() -> Self { Self { seen: Mutex::new(HashMap::new()) } }
    pub fn should_log(&self, session_id: &str, tool_name: &str) -> bool {
        let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let key = (session_id.to_string(), tool_name.to_string(), date);
        let mut seen = self.seen.lock().unwrap();
        if seen.contains_key(&key) { false } else { seen.insert(key, ()); true }
    }
}

/// Called by every tool handler before running its body.
/// Returns Ok(()) if active or deprecated (proceed with handler); Err(ToolRemoved) if removed.
pub fn check_and_log(
    conn: &rusqlite::Connection,
    tool_name: &str,
    session_id: Option<&str>,
    tracker: &UsageDedupTracker,
) -> crate::error::Result<()> {
    let meta = deprecation_state(tool_name);
    if meta.removed {
        let hint = meta.migration_hint.clone().unwrap_or_default();
        crate::db::audit_log::emit_event(
            conn, crate::types::audit::AuditEventCategory::Deprecation, "tool_removed_usage_attempt",
            None, None, None, Some(&serde_json::json!({"tool": tool_name, "session_id": session_id}))
        )?;
        return Err(crate::error::AletheiaError::ToolRemoved {
            since: meta.removal_since.unwrap_or_default(),
            hint,
        });
    }
    if meta.deprecated {
        if let Some(sid) = session_id {
            if tracker.should_log(sid, tool_name) {
                crate::db::audit_log::emit_event(
                    conn, crate::types::audit::AuditEventCategory::Deprecation, "tool_deprecated_usage",
                    None, None, None, Some(&serde_json::json!({"tool": tool_name, "session_id": sid, "since": meta.deprecated_since}))
                )?;
            }
        }
    }
    Ok(())
}

/// Wrap a tool's response with deprecation notice if applicable.
pub fn wrap_response(response: &mut crate::server::response_format::XmlElement, tool_name: &str) {
    let meta = deprecation_state(tool_name);
    if meta.deprecated {
        let mut notice = crate::server::response_format::XmlElement::new("deprecated");
        if let Some(s) = meta.deprecated_since { notice = notice.attr("since", s); }
        if let Some(r) = meta.removal_planned_for { notice = notice.attr("removal", r); }
        if let Some(h) = meta.migration_hint { notice = notice.attr("hint", h); }
        response.children.push(notice);
    }
}
```

**Orphan sweepers (`src/sweepers/`):**

```rust
// src/sweepers/session_orphans.rs
pub fn register_session_orphan_sweep(
    registry: &mut crate::server::index::ServerRegistry,
    settings: crate::lib::settings::Settings,
    data_dir: std::path::PathBuf,
) -> crate::error::Result<()> {
    let interval_minutes = settings.scopes.session_orphan_sweep_minutes;
    registry.spawn_bg("session-orphan-sweep", async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(interval_minutes as u64 * 60));
        loop {
            tick.tick().await;
            // Phase 3's helper
            if let Err(e) = crate::auth::sessions::sweep_session_id_orphans(&data_dir) {
                tracing::warn!("session_orphan_sweep failed: {}", e);
            }
        }
    });
    Ok(())
}

// src/sweepers/sdk_runtime.rs
pub fn register_sdk_runtime_cleanup(
    registry: &mut crate::server::index::ServerRegistry,
    settings: crate::lib::settings::Settings,
    data_dir: std::path::PathBuf,
) -> crate::error::Result<()> {
    let cleanup_hours = settings.scopes.sdk_runtime_cleanup_hours;
    registry.spawn_bg("sdk-runtime-cleanup", async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60 * 60));  // hourly check
        loop {
            tick.tick().await;
            let runtime_dir = data_dir.join("sdk-runtime");
            if !runtime_dir.exists() { continue; }
            let cutoff = chrono::Utc::now() - chrono::Duration::hours(cleanup_hours as i64);
            if let Ok(entries) = std::fs::read_dir(&runtime_dir) {
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        if let Ok(modified) = meta.modified() {
                            let mod_chrono: chrono::DateTime<chrono::Utc> = modified.into();
                            if mod_chrono < cutoff {
                                let _ = std::fs::remove_dir_all(entry.path());
                            }
                        }
                    }
                }
            }
        }
    });
    Ok(())
}
```

**Shadow Mode infrastructure (`src/shadow/`):**

```rust
// src/shadow/comparison_ranker.rs
use crate::injection::candidate::Candidate;
use crate::injection::context::Context;

/// V2 ships NoOpComparisonRanker. V3 ships BaselineComparisonRanker that mimics V2's ranking for V3 vs V2 comparison.
/// Per CEO Item 1: V2 plumbs the infrastructure; V3 fills in the actual comparison signal.
pub trait ShadowComparisonRanker: Send + Sync {
    fn name(&self) -> &str;
    fn rank(&self, candidates: &[Candidate], context: &Context) -> Option<Vec<String>>;  // returns entry_ids; None = no comparison performed
}

pub struct NoOpComparisonRanker;
impl ShadowComparisonRanker for NoOpComparisonRanker {
    fn name(&self) -> &str { "noop" }
    fn rank(&self, _: &[Candidate], _: &Context) -> Option<Vec<String>> { None }
}

// src/shadow/sampler.rs
use rand::Rng;

pub fn should_sample(rate: f64) -> bool {
    if rate <= 0.0 { return false; }
    if rate >= 1.0 { return true; }
    rand::thread_rng().gen::<f64>() < rate
}

// src/shadow/observer.rs
use std::sync::Arc;
use crate::injection::candidate::Candidate;
use crate::injection::context::Context;

/// Metadata bundle passed from ScoringEngine.top_k_filtered → ShadowObserver.observe_sync().
/// Lets ShadowObserver write a contextually-rich comparison_log entry.
#[derive(Debug, Clone)]
pub struct ObservationMetadata {
    pub hook_event: &'static str,           // "l1" or "l2"
    pub scope_id: Option<String>,
    pub session_id: Option<String>,
    pub conn: Arc<tokio::sync::Mutex<rusqlite::Connection>>,
}

pub struct ShadowObserver {
    pub enabled: bool,
    pub sampling_rate: f64,
    pub ranker: Arc<dyn crate::shadow::comparison_ranker::ShadowComparisonRanker>,
}

impl ShadowObserver {
    /// Sync entry point called by ScoringEngine.top_k_filtered (which is itself sync).
    /// We need DB write capability but ScoringEngine is sync — use try_lock + spawn for the write.
    /// The fire-and-forget pattern means observation latency does not block injection.
    pub fn observe_sync(
        &self,
        meta: ObservationMetadata,
        candidates: &[Candidate],
        context: &Context,
        emitted_ranking: &[String],
    ) -> crate::error::Result<()> {
        if !self.enabled { return Ok(()); }
        if !crate::shadow::sampler::should_sample(self.sampling_rate) { return Ok(()); }

        let comparison = match self.ranker.rank(candidates, context) {
            Some(c) => c,
            None => return Ok(()),  // ranker opted out (e.g., NoOpComparisonRanker)
        };

        // Defer DB write to a tokio task so ScoringEngine doesn't block on connection lock contention
        let emitted = emitted_ranking.to_vec();
        let ranker_name = self.ranker.name().to_string();
        tokio::spawn(async move {
            let c = meta.conn.lock().await;
            if let Err(e) = crate::shadow::log::write_comparison(
                &c,
                meta.hook_event,
                meta.scope_id.as_deref(),
                meta.session_id.as_deref(),
                &emitted,
                &comparison,
                &ranker_name,
            ) {
                tracing::warn!("shadow log write failed: {}", e);
            }
        });
        Ok(())
    }
}

// src/shadow/log.rs
pub fn write_comparison(
    conn: &rusqlite::Connection,
    hook_event: &str,
    scope_id: Option<&str>,
    session_id: Option<&str>,
    emitted: &[String],
    comparison: &[String],
    ranker_name: &str,                       // identifies which comparison ranker produced the comparison ranking
) -> crate::error::Result<()> {
    let diff = compute_diff(emitted, comparison);
    let diff_with_ranker = serde_json::json!({"ranker": ranker_name, "diff": diff});
    conn.execute(
        "INSERT INTO shadow_comparison_log (hook_event, scope_id, session_id, emitted_ranking, comparison_ranking, diff_summary)
         VALUES (?, ?, ?, ?, ?, ?)",
        rusqlite::params![hook_event, scope_id, session_id, serde_json::to_string(emitted)?, serde_json::to_string(comparison)?, diff_with_ranker.to_string()],
    )?;
    Ok(())
}

fn compute_diff(emitted: &[String], comparison: &[String]) -> serde_json::Value {
    let emitted_set: std::collections::HashSet<&String> = emitted.iter().collect();
    let comparison_set: std::collections::HashSet<&String> = comparison.iter().collect();
    let added: Vec<&&String> = comparison_set.difference(&emitted_set).collect();
    let removed: Vec<&&String> = emitted_set.difference(&comparison_set).collect();
    serde_json::json!({
        "added": added.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        "removed": removed.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        "emitted_count": emitted.len(),
        "comparison_count": comparison.len(),
    })
}

// src/shadow/analysis.rs
#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct AnalyzeShadowModeParams {
    pub from_date: Option<chrono::DateTime<chrono::Utc>>,
    pub to_date: Option<chrono::DateTime<chrono::Utc>>,
    pub scope_id: Option<String>,
    pub hook_event: Option<String>,
}

pub fn analyze(conn: &rusqlite::Connection, params: &AnalyzeShadowModeParams) -> crate::error::Result<serde_json::Value> {
    // Aggregate shadow_comparison_log: overlap rate, divergences per scope, score distribution shift
    // Master-key gated; called via system_tools::analyze_shadow_mode MCP tool
    todo!("aggregate shadow_comparison_log entries per filters")
}
```

**Wiring observer into Phase 6's ScoringEngine:**

Phase 6's `top_k_filtered` accepts an optional `&ShadowObserver`. After producing the emitted ranking, calls `observer.observe(...)`. The wiring is via Phase 4's Registrar:

```rust
// In src/server/index.rs (uncommented):
register_shadow_mode_observer(&mut registry, conn.clone(), settings.clone()).await?;
```

`register_shadow_mode_observer` constructs the `ShadowObserver` (V2 ships NoOpComparisonRanker; V3 swaps in `BaselineComparisonRanker`) and inserts it into `SessionState`. L1/L2 builders pass it to `ScoringEngine::top_k_filtered`.

<guidance>
**On reconciler conservativeness:** The reconciler should ERR ON THE SIDE OF DOING NOTHING when state is ambiguous. Surface to admin via `reconciliation_orphan_unresolved` audit events; let humans decide. Auto-recovery is only for clearly-correctable cases (one side of the cross-DB write done, not both).

**On the digest_queue lease orphan handling:** Phase 7 already handles lease expiry in its background poller (`recover_expired_leases`). The reconciler's role here is verification only — log a warning if `recover_expired_leases` should have caught something but didn't (indicates Phase 7 poller is stuck or crashed).

**On feature_wrap orphan recovery:** "Re-run synthesis" sounds simple but means re-enqueuing a `digest_queue` row with trigger=feature_wrap. The SDK subprocess handles dedup at the content_hash level — so re-running on already-synthesized memories is a no-op (duplicate response per Phase 5 dedup logic). Cost: tokens for the second SDK run that produces no new output.

**On migration orphan auto-recovery:** Migrations are too risky for auto-recovery. The reconciler ONLY surfaces to admin. Admin runs `resume_migration(migration_id)` (per Phase 2 framework) or `force_unlock(migration_id)` (master-key, audited).

**On tool deprecation in V2.0.0:** No tools are deprecated in V2.0.0 (this is a fresh release). The infrastructure is in place for V2.x to deprecate tools as the API evolves. The static `deprecation_state` function returns "active" for all tools; V2.x adds entries to a static map.

**On Shadow Mode V2 vs V3:** V2 ships the wiring (sampling hook, comparison_log, NoOpComparisonRanker, analyze tool). V3 ships `BaselineComparisonRanker` (and possibly `V1RankComparisonRanker` if Aletheia ever wants V1-vs-V3 comparison data). Per CEO Item 1, V2 enabling Shadow Mode does nothing useful (NoOp ranker returns None); V2 keeping it disabled by default avoids confusion. Documented.

**On startup reconciliation cost:** `run_at_startup` does a full scan but does NOT execute recovery (only logs counts). Recovery happens in the periodic 5min sweep. This decouples startup latency from reconciliation work.
</guidance>

### Integration Points
- **IS-9 (audit log → reconciler):** Reconciler reads `sys_audit_log` via the established event vocabulary. Phase 9 adds the `reconciliation.*` event category — events: `reconciliation_orphan_unresolved`, `reconciliation_backfilled_promotion_committed`, `reconciliation_completed_promotion_tombstone`, `reconciliation_completed_promotion_target_insert`, `reconciliation_migration_orphan_surfaced`, `reconciliation_feature_wrap_resynthesized`.
- **IS-10 (tool deprecation → all V2 tools):** Every Phase 5 tool's `#[tool]` handler calls `deprecation::check_and_log` as part of `AuthContext::precheck()` — the precheck flow is defined in Phase 5 with the deprecation hook included. `deprecation::wrap_response` is called by the tool's response builder if `deprecation_state` reports deprecated. NO tool can bypass these checks.
- **Phase 4 Registrar:** `register_reconciler_sweep`, `register_session_orphan_sweep`, `register_sdk_runtime_cleanup`, `register_shadow_mode_observer` all uncommented in `start_server()`.
- **Phase 5 → Phase 9:** Phase 5's `reconcile()` MCP tool dispatches to Phase 9's reconciler. Phase 5's `purge_audit_log()` MCP tool calls Phase 2's `audit_log::purge_audit_log()` helper.
- **Phase 6 → Phase 9:** Phase 6's `ScoringEngine.top_k_filtered` already accepts `Option<&ShadowObserver>` + `Option<ObservationMetadata>` parameters; Phase 9 constructs the observer (with V2's `NoOpComparisonRanker` default) and L1/L2 builders pass it through.

### Expected Outcomes
- `cargo test` passes for reconciler, deprecation, sweepers, shadow modules
- Reconciler scanner test: insert 5 orphan events (proposed without committed), call `scan` → returns all 5 in correct buckets
- Reconciler recovery test for promote_memory: simulate "source tombstoned, target missing" → reconciler completes target insert + audit log entry
- Reconciler recovery test for "both done": reconciler back-fills the missing committed event
- Tool deprecation test: simulate a tool being deprecated; first call from session emits 1 audit event; 100 subsequent calls from same session emit 0 additional events (dedup); next day, 1 new event
- Tool removed test: simulate a tool being removed; call returns `<error code="TOOL_REMOVED" since="..." hint="..."/>` and logs `tool_removed_usage_attempt`
- Session orphan sweep test: write 5 session_id files (3 with bogus PIDs); call sweep → 3 removed
- sdk-runtime cleanup test: create 3 dirs with mtimes 25h, 23h, 1h → cleanup removes 1 (>24h)
- Shadow Mode disabled: `observer.observe(...)` returns immediately without logging
- Shadow Mode enabled with NoOpComparisonRanker: sampler fires (random) but ranker returns None → no log entry
- Shadow Mode enabled with stub V3-style ranker: sampler fires, ranker returns rankings, log entry with diff_summary
- E2E test: reconciler periodic sweep runs every N minutes (mock interval to seconds for test); orphan recovery happens within one cycle

### Testing Recommendations
- Unit test each recovery handler with all 4 state combinations (both done, source done, target done, neither done)
- Property test: reconciler is idempotent — running scan + recovery twice produces same end state as once
- Test deprecation dedup with date rollover: simulate clock advance past midnight; verify next-day call logs even if same session
- Test `analyze_shadow_mode` aggregation with synthetic shadow_comparison_log entries (compute expected overlap_rate, verify match)
- Stress test: enqueue 1000 orphan events across all categories; verify scan completes in <5s; verify recovery completes all auto-recoverable orphans
- Concurrent test: reconciler sweep running concurrently with normal tool calls — no deadlocks, no SQLITE_BUSY errors within busy_timeout
</core>
</section>
<!-- /phase:9 -->

<!-- conductor-review:9 -->
<section id="conductor-review-9">
## Conductor Review: Post-Phase 9

<core>
### Verification Checklist

<mandatory>All checklist items must be verified before proceeding.</mandatory>

- [ ] Reconciler scans `sys_audit_log` for orphaned events within 24h window
- [ ] Per-operation recovery handlers handle all 4 state combinations (both done, source done, target done, neither done) for promote_memory
- [ ] Reconciler is conservative: ambiguous orphans are surfaced (not auto-recovered) via `reconciliation_orphan_unresolved` events
- [ ] Migration orphans are surfaced to admin only — NO auto-recovery
- [ ] Background reconciler sweep runs at configured interval (5min default)
- [ ] `run_at_startup` runs scan but NOT recovery (logs counts only; recovery via periodic sweep)
- [ ] **Tool deprecation usage dedup verified** — same session calling deprecated tool 100× emits 1 audit event per day
- [ ] **`tool_removed` returns FATAL error** — not a deprecation warning (per design Topic 7)
- [ ] All Phase 5 tool handlers call `deprecation::check_and_log` (verify via grep on `AuthContext::precheck`)
- [ ] Tool responses include `<deprecated since="..." removal="..." hint="..."/>` notice when applicable
- [ ] Session orphan sweep deletes `~/.aletheia-v2/sessions/<dead_pid>.session_id` files
- [ ] sdk-runtime cleanup deletes `~/.aletheia-v2/sdk-runtime/<queue_id>/` dirs older than 24h
- [ ] Shadow Mode `NoOpComparisonRanker` is V2's default (returns None — no comparison log entries)
- [ ] Shadow Mode infrastructure plumbing verified: `shadow_comparison_log` table writable, sampling decision works, observer wires into ScoringEngine
- [ ] `analyze_shadow_mode` MCP tool is master-key only (verify in `system_tools.rs`)
- [ ] Phase 4 Registrar: 4 new `register_X` calls UNCOMMENTED in `start_server()` (`register_reconciler_sweep`, `register_session_orphan_sweep`, `register_sdk_runtime_cleanup`, `register_shadow_mode_observer`)
- [ ] `AuthContext::precheck()` includes the `deprecation::check_and_log` call — verify by reading Phase 5's `auth_context.rs` (the call is part of the precheck flow as written)
- [ ] `ScoringEngine.top_k_filtered` accepts `Option<&ShadowObserver>` + `Option<ObservationMetadata>` parameters — verify by reading Phase 6's signature; L1/L2 builders pass these through
- [ ] Audit events: `reconciliation.reconciliation_*`, `deprecation.tool_deprecated_usage`, `deprecation.tool_removed_usage_attempt`, `deprecation.shadow_mode_enabled`, `deprecation.shadow_mode_disabled`, `deprecation.shadow_analysis_requested`
- [ ] Run context compaction (`/lethe compact`) before launching Phase 10

### Known Risks
- **Reconciler false positives:** A `_proposed` event with a `_committed` event OUTSIDE the 24h window will look like an orphan. The `since_hours` parameter on the analysis tool lets admins extend the window for forensic queries. Document this edge case.
- **`feature_wrap_orphan` recovery cost:** Re-enqueuing a digest job for an orphan feature_wrap costs SDK tokens. If orphans accumulate (e.g., MCP server has been crashing repeatedly), the reconciler could trigger many digest runs. Recommend rate-limiting: per scope, at most 1 reconciler-triggered digest per hour.
- **Tool deprecation static map limit:** The `deprecation_state` function uses a static map. With ~30 tools and slow growth, this is fine. If V2.x deprecates many tools, consider moving to a deprecation registry table in scope_registry.db (V3 territory).
- **Shadow Mode disabled by default:** Per CEO Item 1, V2 doesn't exercise Shadow Mode. The infrastructure works but produces no useful data without a non-NoOp ranker. Documentation for users: "Shadow Mode is V3 infrastructure shipped early; safely ignore in V2."
- **`analyze_shadow_mode` return shape:** With NoOpComparisonRanker, the analysis tool returns "no comparison data available." Response shape should clearly indicate this rather than returning empty results that look like a bug.
- **Sampler `rand::thread_rng()` cost:** Per-hook RNG call is cheap (~ns). With 10% sampling rate and ~10 hooks/second peak, overhead is negligible.
- **Concurrent reconciler + tool calls:** Both write to `sys_audit_log`. SQLite WAL handles concurrent writers via the registry connection's busy_timeout. No deadlock expected; profile if observed.
- **Reconciler scan frequency vs cost:** Default 5min sweep. With ~1000 audit events / day, scanning the last 24h is reading ~1000 rows — cheap (<10ms). Increase frequency if needed; configurable.

### Guidance for Phase 10

<guidance>
Phase 10 is the final phase. With all implementation complete, distribution + release is mostly mechanical packaging work. 4 parallel sub-tasks:

1. cargo-dist setup
2. JS wrapper shim
3. GitHub Actions multi-target matrix
4. npm publish workflow + documentation

Phase 10 is the smallest plan section by code volume but the most operationally consequential — it's what users actually install.

After Phase 10, the V2 Conductor pipeline is complete. Final integration test: install via `npm install -g aletheia-v2` from the just-published package, run `aletheia-v2 setup`, run `aletheia-v2 migrate-from-v1 ~/.aletheia/data/aletheia.db --confirm-backup-taken`, verify a Claude Code session (with `aletheia-v2` registered as an MCP server) can claim and write/read entries while V1 continues running independently.

Context management: Run `/lethe compact` before Phase 10.
</guidance>
</core>
</section>
<!-- /conductor-review:9 -->

<!-- phase:10 -->
<section id="phase-10">
## Phase 10: Distribution + Release

<core>
### Objective
Package the V2 Rust binary for `npm install -g aletheia-v2` distribution using the `optionalDependencies` pattern (esbuild/swc/biome/oxc model). Set up `cargo-dist` for multi-target binary builds via GitHub Actions matrix; ship a JS wrapper shim that handles signal forwarding and stdio inheritance correctly; publish to npm; document install + V1→V2 migration for end users. After Phase 10, V2 is publicly installable.

### Prerequisites
- Phases 1-9 complete: V2 binary builds, all functionality works in dev
- npm account with publish access to `aletheia-v2` (or chosen package name); ANTHROPIC_NPM_TOKEN secret in GitHub Actions
- GitHub Actions enabled on the repo
- (Optional) Apple Developer account for Mac code signing; Microsoft cert for Windows code signing — defer if not yet needed

### Implementation

<mandatory>The JS wrapper shim MUST use `stdio: 'inherit'` when spawning the Rust binary. ANY `console.log` or stdout write from the shim corrupts MCP JSON-RPC and breaks the MCP client connection. Use `console.error` for any logging.</mandatory>

<mandatory>The JS wrapper shim MUST trap SIGINT and SIGTERM and forward them to the child Rust process. Without forwarding, `SIGTERM` to the npm-spawned `node` process leaves the Rust binary as a zombie holding the MCP socket and lock rows.</mandatory>

<mandatory>cargo-dist MUST be configured to use the `optionalDependencies` distribution pattern, NOT `postinstall`. `postinstall` is dead in 2026 — pnpm defaults to `--ignore-scripts`, corporate firewalls block GitHub Releases downloads, and `npm-shrinkwrap.json`-locked installers cause downstream conflicts. Verify cargo-dist version supports + defaults to optionalDependencies.</mandatory>

<mandatory>Rust binaries MUST be `strip`-ed at build time to minimize size. Smaller binaries = faster `npx` first-install download = lower risk of MCP init timeout (CC's MCP init timeout is ~30s; large binaries on slow connections can exceed this).</mandatory>

**Module structure (added in Phase 10):**

```
.
├── Cargo.toml                 # Workspace metadata; add cargo-dist config
├── dist-workspace.toml        # cargo-dist workspace configuration
├── packages/
│   └── aletheia-v2/              # npm wrapper package
│       ├── package.json       # name + bin + optionalDependencies for platform packages
│       ├── index.js           # JS wrapper shim
│       └── README.md          # User-facing install docs
├── .github/
│   └── workflows/
│       ├── ci.yml             # Existing; cargo build + test (Phase 1)
│       ├── release.yml        # NEW — multi-target matrix + npm publish
│       └── plan.yml           # cargo-dist plan generation
└── docs/
    ├── INSTALL.md             # User install instructions
    ├── MIGRATION-FROM-V1.md   # V1 → V2 migration guide for end users
    └── README.md              # Project overview
```

**Workspace `Cargo.toml` cargo-dist config:**

```toml
[workspace.metadata.dist]
cargo-dist-version = "0.27.0"             # Pin to known-good version supporting optionalDependencies
ci = ["github"]
installers = ["npm", "shell", "powershell"]
targets = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
]
pr-run-mode = "plan"
allow-dirty = ["ci"]
install-updater = false                   # We don't ship a self-updater
unix-archive = ".tar.gz"
windows-archive = ".zip"

# CRITICAL: enable the modern npm distribution pattern
[workspace.metadata.dist.npm-installer]
package = "aletheia-v2"
scope = ""                                # Or "@yourorg/" for scoped publishing

# Strip binaries for size
[profile.dist]
inherits = "release"
strip = "symbols"
lto = "thin"
codegen-units = 1
```

**JS wrapper shim (`packages/aletheia-v2/index.js`):**

```javascript
#!/usr/bin/env node
// Aletheia V2 — JS wrapper shim for the Rust binary distributed via optionalDependencies.
// CRITICAL CONSTRAINTS:
// 1. NO `console.log` — corrupts MCP JSON-RPC. Use `console.error` for any output.
// 2. stdio: 'inherit' — passes raw FDs to the Rust binary; required for MCP protocol.
// 3. Signal forwarding — propagates SIGINT/SIGTERM to the child so it can shut down gracefully.
// 4. Exit code propagation — npm relies on this for CI/scripting.

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

function getBinaryPath() {
  const platform = os.platform();
  const arch = os.arch();

  // Map Node platform/arch → cargo-dist npm package suffix
  const targets = {
    'linux-x64': 'aletheia-v2-x86_64-unknown-linux-gnu',
    'linux-arm64': 'aletheia-v2-aarch64-unknown-linux-gnu',
    'darwin-x64': 'aletheia-v2-x86_64-apple-darwin',
    'darwin-arm64': 'aletheia-v2-aarch64-apple-darwin',
    'win32-x64': 'aletheia-v2-x86_64-pc-windows-msvc',
  };

  const targetPkg = targets[`${platform}-${arch}`];
  if (!targetPkg) {
    console.error(`Aletheia: unsupported platform ${platform}-${arch}. Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.`);
    process.exit(1);
  }

  // Resolve the platform-specific package's binary
  let binPath;
  try {
    const pkgRoot = path.dirname(require.resolve(`${targetPkg}/package.json`));
    const binName = platform === 'win32' ? 'aletheia-v2.exe' : 'aletheia-v2';
    binPath = path.join(pkgRoot, 'bin', binName);
  } catch (e) {
    console.error(`Aletheia: platform package ${targetPkg} not installed. Try \`npm install -g aletheia-v2\` again.`);
    console.error(`Detail: ${e.message}`);
    process.exit(1);
  }

  return binPath;
}

const binPath = getBinaryPath();
const args = process.argv.slice(2);

const child = spawn(binPath, args, {
  stdio: 'inherit',                          // CRITICAL: raw FD passthrough for MCP stdio
  env: process.env,
});

// Signal forwarding — required for graceful shutdown
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
for (const sig of signals) {
  process.on(sig, () => {
    if (!child.killed) {
      try { child.kill(sig); } catch (_) { /* child already exited */ }
    }
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    // Re-raise the signal in this process so npm sees the right exit semantics
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

child.on('error', (err) => {
  console.error(`Aletheia: failed to spawn ${binPath}: ${err.message}`);
  process.exit(127);
});
```

**Wrapper `packages/aletheia-v2/package.json`:**

```json
{
  "name": "aletheia-v2",
  "version": "2.0.0",
  "description": "Aletheia V2 — structured memory MCP server for Claude Code",
  "bin": {
    "aletheia-v2": "./index.js"
  },
  "main": "./index.js",
  "files": ["index.js", "README.md"],
  "engines": {
    "node": ">=18.0.0"
  },
  "optionalDependencies": {
    "aletheia-v2-x86_64-unknown-linux-gnu": "2.0.0",
    "aletheia-v2-aarch64-unknown-linux-gnu": "2.0.0",
    "aletheia-v2-x86_64-apple-darwin": "2.0.0",
    "aletheia-v2-aarch64-apple-darwin": "2.0.0",
    "aletheia-v2-x86_64-pc-windows-msvc": "2.0.0"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/<owner>/aletheia-v2.git"
  },
  "license": "MIT",
  "keywords": ["mcp", "claude-code", "memory", "anthropic"]
}
```

cargo-dist generates the per-platform packages (`aletheia-v2-x86_64-unknown-linux-gnu/`, etc.) automatically — each contains only the binary + a minimal package.json with strict `os` and `cpu` fields so npm/pnpm/yarn install only the matching one.

**GitHub Actions release workflow (`.github/workflows/release.yml`):**

cargo-dist generates this; the canonical content is:

```yaml
name: Release
on:
  push:
    tags:
      - 'v[0-9]+.[0-9]+.[0-9]+*'
permissions:
  contents: write
  id-token: write

jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      val: ${{ steps.plan.outputs.manifest }}
      tag: ${{ !github.event.pull_request && github.ref_name || '' }}
      tag-flag: ${{ !github.event.pull_request && format('--tag={0}', github.ref_name) || '' }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - name: Install cargo-dist
        run: |
          curl --proto '=https' --tlsv1.2 -LsSf \
            https://github.com/axodotdev/cargo-dist/releases/download/v0.27.0/cargo-dist-installer.sh | sh
      - id: plan
        run: cargo dist plan ${{ steps.tag.outputs.tag-flag }} --output-format=json > dist-manifest.json
      - uses: actions/upload-artifact@v4
        with: { name: artifacts, path: dist-manifest.json }

  build-binaries:
    needs: [plan]
    strategy:
      fail-fast: false
      matrix:
        include:
          - { target: x86_64-unknown-linux-gnu,    runner: ubuntu-latest }
          - { target: aarch64-unknown-linux-gnu,   runner: ubuntu-latest, cross: true }
          - { target: x86_64-apple-darwin,         runner: macos-13 }
          - { target: aarch64-apple-darwin,        runner: macos-14 }
          - { target: x86_64-pc-windows-msvc,      runner: windows-latest }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
      - name: Install cross (Linux ARM64)
        if: matrix.cross
        run: cargo install cross --git https://github.com/cross-rs/cross
      - name: Build (cross)
        if: matrix.cross
        run: cross build --release --target ${{ matrix.target }} --profile dist
      - name: Build (native)
        if: '!matrix.cross'
        run: cargo build --release --target ${{ matrix.target }} --profile dist
      - name: Strip
        if: runner.os != 'Windows'
        run: strip target/${{ matrix.target }}/dist/aletheia-v2
      - uses: actions/upload-artifact@v4
        with:
          name: aletheia-v2-${{ matrix.target }}
          path: target/${{ matrix.target }}/dist/aletheia-v2*

  publish-npm:
    needs: [plan, build-binaries]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { path: artifacts }
      - uses: actions/setup-node@v4
        with: { node-version: '20', registry-url: 'https://registry.npmjs.org' }
      - name: Build and publish npm packages
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          # cargo-dist's npm-publisher generates per-target packages + the wrapper
          curl --proto '=https' --tlsv1.2 -LsSf \
            https://github.com/axodotdev/cargo-dist/releases/download/v0.27.0/cargo-dist-installer.sh | sh
          cargo dist publish --installer=npm

  github-release:
    needs: [plan, build-binaries]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { path: artifacts }
      - uses: softprops/action-gh-release@v1
        with:
          files: artifacts/**/*
          generate_release_notes: true
```

**Documentation (`docs/INSTALL.md`):**

```markdown
# Installing Aletheia V2

## Prerequisites

- **Node.js 18+** — required for npm installation
- **Claude Code CLI** — Aletheia is an MCP server registered with Claude Code

## Install

```bash
npm install -g aletheia-v2
```

This installs the `aletheia-v2` CLI plus the platform-specific binary. On first install, npm downloads ~10-15MB of platform-specific code.

## First-time setup

```bash
aletheia-v2 setup
```

This:
1. Creates `~/.aletheia-v2/` (data, keys, sessions, sockets, sdk-runtime, scopes directories)
2. Generates `~/.aletheia-v2/settings.toml` with defaults
3. Generates a master key, writes to `~/.aletheia-v2/keys/master.key`
4. Registers the SessionStart hook + L1/L2 injection hooks in `~/.claude/settings.json`
5. Prints the master key value (record + delete the file if you don't trust filesystem perms)

## Verify

```bash
claude
# Inside Claude Code:
> /mcp
# Should list aletheia-v2 among available servers
> Use the aletheia-v2 whoami tool
# Should return your master key's permission set
```

## Uninstall

```bash
npm uninstall -g aletheia-v2
# Optional: rm -rf ~/.aletheia-v2/  (V2 data dir)
# To also remove V2 entries from CC config, edit ~/.claude/settings.json and remove the "aletheia-v2" MCP entry + its hook entries.
# (V1 install at ~/.aletheia/ + V1 npm package "aletheia" remain untouched if you had them installed alongside.)
```

## Troubleshooting

**"Aletheia: platform package not installed"** — your platform isn't supported. Currently supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64. File an issue if you need another.

**MCP connection times out on first install** — slow network. The first `npx`-style invocation downloads ~10-15MB; on slow connections, this can exceed Claude Code's MCP init timeout. Run `aletheia-v2 --version` once manually to pre-cache the binary, then start Claude Code.

**Stale socket on restart** — Aletheia cleans up its own socket on graceful shutdown. If a previous server crashed, run `rm ~/.aletheia-v2/sockets/aletheia-*.sock` then start fresh.
```

**Documentation (`docs/MIGRATION-FROM-V1.md`):**

```markdown
# Migrating from Aletheia V1 to V2 (side-by-side install model)

## Before you start

1. **Back up your V1 data**: `cp ~/.aletheia/data/aletheia.db ~/aletheia-v1-backup-$(date +%Y%m%d).db`
2. **Stop all Claude Code sessions** that have V1 active (the migration tool refuses by default if it detects active V1 MCP servers; pass `--ignore-active-sessions` to override at your own risk).
3. **Install V2 alongside V1**: `npm install -g aletheia-v2`. This installs the V2 binary (`aletheia-v2`) at a new path; your existing V1 install (`aletheia`) is NOT touched. Both can run simultaneously.
4. **Run V2 setup**: `aletheia-v2 setup`. This creates `~/.aletheia-v2/` (data dir SEPARATE from V1's `~/.aletheia/`), generates a fresh V2 master key at `~/.aletheia-v2/keys/master.key`, registers V2's hooks in `~/.claude/settings.json` as a NEW set of hook entries (V1's hooks remain registered separately).

## Run migration

```bash
aletheia-v2 migrate-from-v1 ~/.aletheia/data/aletheia.db --confirm-backup-taken
```

This:
- Reads V1 SQLite as data only (no V1 code involvement, read-only access)
- Creates one `~/.aletheia-v2/scopes/<scope_uuid>.db` per V1 namespace
- Transforms V1's 2-level hierarchy into V2's flat per-row entries model
- Migrates V1 keys into V2's `~/.aletheia-v2/keys/` (V1 master key becomes a V2 maintenance sub-key; the V2 master from `setup` remains the trust root)
- **DOES NOT rename or modify the V1 DB** — V1 stays exactly as it was
- Writes a migration report to `~/.aletheia-v2/dry-run-reports/<timestamp>.{json,md}` (the actual run also produces this report)

**Time estimate:** ~30 seconds per 1000 entries. Large corpora (10k+) may take several minutes.

**Disk space:** During migration, V1 + V2 occupy ~2× the original V1 size (V1 DB + V2 directory). Ensure adequate free space.

**Optional dry-run first:** `aletheia-v2 migrate-from-v1 ~/.aletheia/data/aletheia.db --dry-run` writes the planned report (JSON + markdown) without touching anything. The `v2_scope_uuid` values in the dry-run report are deterministic (SHA-256 of namespace) and will match the actual migration's output.

## After migration

- Both V1 and V2 are now installed and runnable. Claude Code sessions that have V1 registered as an MCP server keep using V1; sessions that have V2 registered use V2.
- Your existing V1 key values still work in V2 — claim with the same key value; V2 will recognize it via SHA-256 hash.
- Your existing V1 entries are now in V2 with all history preserved.
- First claim of each scope in V2 triggers a one-time digest pass (synthesizes memories from V1's journals into V2 memory entries). This may take a few minutes per scope; runs in the background.
- For large single-scope corpora, use `--stage-digest-as-mass-ingest` to defer digest until you can supervise the bulk operation.

## Cutover (when you've validated V2 and are ready to retire V1)

Once V2 is working as expected and you no longer need V1:

```bash
# 1. Remove V1's MCP server entry from ~/.claude/settings.json (the "aletheia" entry).
#    Leave the "aletheia-v2" entry in place.
# 2. Stop V1 sessions if any remain
# 3. Uninstall V1
npm uninstall -g aletheia
# 4. Optionally remove V1's data dir
rm -rf ~/.aletheia/
```

V2 continues to operate normally. V1 is gone.

## Rolling back (if V2 doesn't work for you)

If V2 has issues and you want to revert to V1-only:

```bash
# 1. Remove V2's MCP server entry from ~/.claude/settings.json
# 2. Uninstall V2
npm uninstall -g aletheia-v2
# 3. Optionally remove V2's data dir (V2 was never the source of truth; safe to delete)
rm -rf ~/.aletheia-v2/
```

V1 is untouched and continues to operate normally with all its original data.

## Schema differences (FYI)

V1 had a 2-level data model (entries → typed children). V2 flattens to one row per logical thing. This means:

- A V1 memory entry with 5 keys becomes 5 V2 memory entries
- The V1 keys are preserved as tags on the V2 entries (e.g., `key:api_endpoints`)
- The V1 entry UUID is preserved as a tag (e.g., `entry_id_legacy:abc123`) so you can still group memories that were originally under one V1 entry

Search and read tools work transparently across both V1-migrated and V2-native entries.
```

<guidance>
**On cargo-dist version:** Pin to a specific version (e.g., 0.27.0) rather than tracking latest. cargo-dist's CI generation has had breaking changes between versions; pinning gives reproducible CI.

**On code signing:** macOS Gatekeeper warns on unsigned binaries; users can override via Right-Click → Open. Windows SmartScreen warns on unsigned binaries; users override via "Run anyway." Sign when user reports surface; defer for V2.0.0.

**On Linux ARM64 cross-compile:** GitHub Actions has native ARM64 runners now (free tier). Update the workflow to use `runs-on: ubuntu-latest-arm64` once available — eliminates the `cross` dependency. Check status mid-2026.

**On binary size optimization:** With strip + LTO thin + codegen-units=1, target binary size is 10-15MB. If size becomes a problem (MCP init timeout reports), consider:
- LTO fat (slower compile, ~5-10% smaller)
- Replacing `rusqlite` bundled SQLite with system SQLite (smaller binary; introduces system dep — bad for npm distribution)
- UPX compression (controversial; may trigger antivirus false positives)

**On the platform package convention:** cargo-dist generates packages named `<bin-name>-<rust-target>` (e.g., `aletheia-v2-x86_64-unknown-linux-gnu`). The wrapper's `optionalDependencies` references these by exact name. Ensure version sync between wrapper and platform packages on every release (cargo-dist handles this).

**On `npm install -g` semantics:** With `optionalDependencies`, npm installs ONLY the matching platform package (others fail their `os`/`cpu` filter, but failure is silent and ignored — that's the intended behavior). The wrapper's `bin` field provides the global `aletheia-v2` command.

**On Anthropic-vs-personal scope:** If publishing under `@aletheia/cli` instead of bare `aletheia`, update `package.json::name` and the wrapper's `optionalDependencies` keys. The bare `aletheia` name is taken — recommend `@yourorg/aletheia` or another bare name. Reserve at npm before release.
</guidance>

### Integration Points
- **All previous phases:** Phase 10 packages the work of Phases 1-9. No code changes to those phases (their integration was completed in their own conductor reviews).
- **CI ↔ release:** Phase 1's CI workflow (`ci.yml`) runs on every PR; Phase 10's release workflow (`release.yml`) runs on tag push. They don't share code but share the workspace structure.
- **Documentation ↔ user-visible flows:** `docs/INSTALL.md` and `docs/MIGRATION-FROM-V1.md` reference Phase 3's `aletheia-v2 setup`, Phase 8's `aletheia-v2 migrate-from-v1`. Verify command line examples match actual CLI signatures.

### Expected Outcomes
- `cargo dist plan` succeeds locally
- Push a test tag (e.g., `v2.0.0-rc1`) triggers `release.yml`; all 5 platform builds succeed; npm packages publish; GitHub release created with binaries attached
- `npm install -g aletheia-v2@2.0.0-rc1` works on each supported platform; `aletheia-v2 --version` returns 2.0.0-rc1
- `aletheia-v2 setup` creates `~/.aletheia-v2/` structure end-to-end
- `aletheia-v2 migrate-from-v1 <v1.db> --confirm-backup-taken` completes successfully against a real V1 DB
- Claude Code session sees `aletheia-v2` MCP server; `tools/list` returns 30+ tools; `whoami` works post-claim
- JS wrapper signal forwarding: spawn `aletheia-v2 serve`, send SIGTERM to the npm process — Rust binary receives SIGTERM and shuts down gracefully (lock row deleted, audit log entry written)
- JS wrapper exit-code propagation: `aletheia-v2 migrate-from-v1` failure (e.g., bad path) returns non-zero exit code visible to npm
- Binary size on linux-x64: under 20MB stripped (target: 15MB)
- First-install via `npm install -g aletheia-v2` completes in under 30s on a typical broadband connection (target: 15s)

### Testing Recommendations
- Local cargo-dist test: `cargo dist build --installer=npm --output-dir=./dist-test` produces the wrapper + platform packages
- Unit test the JS wrapper: mock `child_process.spawn`; verify signal forwarding wires up; verify exit code propagation
- Cross-platform CI smoke test: matrix across Linux/macOS/Windows; install the just-built npm package; run `aletheia-v2 --version`
- Migration smoke test in CI: generate synthetic V1 DB; run migrate-from-v1; verify exit 0 and migration report
- MCP integration smoke test in CI: spawn `aletheia-v2 serve`; connect with rmcp client; tools/list returns expected count
- Documentation accuracy test: parse `docs/INSTALL.md` for command examples; verify each command's signature matches Phase 3's `aletheia-v2 setup` and Phase 8's `aletheia-v2 migrate-from-v1`
</core>
</section>
<!-- /phase:10 -->

<!-- conductor-review:10 -->
<section id="conductor-review-10">
## Conductor Review: Post-Phase 10 (Final)

<core>
### Verification Checklist

<mandatory>All checklist items must be verified before declaring V2 release-ready.</mandatory>

- [ ] **JS wrapper uses `stdio: 'inherit'`** — verified by reading `packages/aletheia-v2/index.js` (no `console.log` ever; `console.error` only)
- [ ] **JS wrapper traps and forwards SIGINT/SIGTERM/SIGHUP/SIGQUIT** — verified by reading the signals loop in `index.js`
- [ ] **cargo-dist uses `optionalDependencies` pattern, NOT `postinstall`** — verified in `dist-workspace.toml` or workspace cargo metadata
- [ ] **Binaries are `strip`-ed** — `target/<target>/dist/aletheia-v2` size matches stripped expectations (~15MB on linux-x64; ~12MB on darwin-arm64)
- [ ] All 5 platform targets build successfully in CI
- [ ] All 5 platform-specific npm packages publish successfully on tag push
- [ ] Wrapper package `aletheia-v2@2.0.0` publishes successfully with correct `optionalDependencies` references
- [ ] `npm install -g aletheia-v2` works on each platform; `aletheia-v2 --version` returns expected version
- [ ] `aletheia-v2 setup` creates `~/.aletheia-v2/` structure correctly + registers hooks in `~/.claude/settings.json`
- [ ] `aletheia-v2 migrate-from-v1` works against real V1 DB (E2E CI test with synthetic V1 data)
- [ ] Claude Code session can connect to `aletheia-v2` MCP server and call tools (E2E CI test)
- [ ] JS wrapper signal forwarding test passes: spawn → SIGTERM to node → Rust binary shuts down + lock row deleted
- [ ] JS wrapper exit-code propagation test passes: `aletheia-v2 migrate-from-v1 /nonexistent` returns non-zero exit
- [ ] Documentation matches actual CLI: every command in `docs/INSTALL.md` and `docs/MIGRATION-FROM-V1.md` is callable
- [ ] GitHub release created with binaries attached (sanity check: download a binary, run `--version`, expected output)
- [ ] V2 final-release tag (`v2.0.0`) successfully publishes the full package
- [ ] **POST-RELEASE final integration test:** Install V2 via `npm install -g aletheia-v2` from public npm; run `aletheia-v2 setup`; run a real Claude Code session; perform claim → write_memory → read flow; verify success.

### Known Risks
- **First-install MCP timeout:** Slow connections may exceed CC's 30s MCP init timeout on first `npx aletheia-v2` invocation. Mitigated by: small stripped binaries, `npm install -g` (vs `npx`-style auto-install) for the recommended flow, troubleshooting note in INSTALL.md.
- **Code signing absence:** macOS Gatekeeper + Windows SmartScreen warnings on first launch. Users override via documented steps. Add code signing in V2.0.x if user reports surface (low priority for V2.0.0).
- **`aletheia` package name availability:** If the bare name is taken on npm, fall back to `@yourorg/aletheia`. Update wrapper + dist config + docs accordingly.
- **GitHub Actions billing:** Multi-target matrix uses ~5 runner-minutes per release. Free tier covers ~2000 minutes/month — plenty for V2's release cadence. Monitor.
- **rmcp + cargo-dist version sync:** Pin both. Bumping rmcp may require rebuilding the dist matrix; bumping cargo-dist may require regenerating CI workflow files.
- **Cross-compile failures on first attempt:** glibc version, openssl-sys, libsqlite3-sys cross-compile issues are real. Phase 10 budget: ~3 days for the matrix to pass cleanly the first time, then stable.
- **Mac arm64 vs x64 native runners:** GitHub provides both now (macos-13 = x64, macos-14 = arm64). Do NOT cross-compile darwin-arm64 from x64 — use the native runner.
- **Linux arm64 native runners:** Free tier added them in 2025. If still on `cross`, monitor for native runner availability and migrate (faster + simpler).
- **JS wrapper Node.js version:** `node:child_process` and `node:os` modules work in Node 18+. The `engines.node = ">=18.0.0"` in package.json enforces this. If users on older Node fail to install, npm displays a clear error.
- **Self-update:** No self-updater in V2.0.0. Users update via `npm install -g aletheia-v2@latest`. Document.

### Final Project Verification (post-release)

<mandatory>The following end-to-end verification must pass before declaring V2 production-ready:</mandatory>

- [ ] **End-to-end install test on each platform:** Fresh VM, `npm install -g aletheia-v2`, `aletheia-v2 setup`, start Claude Code, verify MCP connection, perform claim/write_memory/read flow.
- [ ] **End-to-end V1 migration test:** Real-world V1 user upgrades to V2 via documented migration steps; data integrity preserved; first claim triggers digest pass within expected time.
- [ ] **Concurrent multi-session test:** 5 simultaneous Claude Code sessions (CEO + 2 PMs + 2 TLs); each claims its own scope; writes don't interfere; reads see correct cross-scope visibility per claim's PermissionSet.
- [ ] **Lock conflict test:** Two `claude --resume <same-id>` from different terminals; second receives FATAL refusal; first continues working.
- [ ] **Crash recovery test:** Kill MCP server mid-digest (SIGKILL); restart; verify lease expires within 30min and queue row re-leases (or commits if subprocess actually completed).
- [ ] **Audit log integrity test:** Attempt UPDATE/DELETE on `sys_audit_log` from sqlite3 CLI; verify trigger blocks (constraint violation).
- [ ] **Memory leak test:** Run MCP server for 24h with periodic tool calls; verify resident memory stays under 50MB.
- [ ] **First-launch SDK subprocess test:** Trigger a digest manually; verify subprocess launches with OAuth-preserving flag combination; verify subprocess exits cleanly; verify cwd cleanup.

### Project Closure

This is the final phase section. The Conductor's responsibilities end here.

<guidance>
Once Phase 10 is complete and the post-release verification checklist passes:

1. Update `arranger-handoff.md` (V3 forward-look doc) with any V2 production observations gathered during the post-release verification — especially: which scoring weights worked well, what digest cadence emerged organically, any lock-conflict or reconciliation false positives observed.
2. Tag the V2 release as the **V3 Dramaturg session input** — V2's deployed source is the empirical reference for V3's KG design.
3. Hand off to V3 Dramaturg session per the workflow established in `dramaturg-journal.md` Clarification entry.

V2 is complete.
</guidance>
</core>
</section>
<!-- /conductor-review:10 -->
