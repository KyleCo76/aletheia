# Knowledge Graph Research Handoff — From Aletheia V2 Design Session to Next Dramaturg Session

## Purpose

Aletheia V2's Vision Expansion phase (2026-04-17) included a staged Gemini brainstorm (search → synthesis → brainstorm) that surfaced significant research on knowledge-graph architectures for LLM-agent memory. During that session, Kyle and the Dramaturg decided to **defer the KG layer to a future dedicated design session** rather than include it in V2. Reasoning: KG complexity couples with every other V2 delta (migration, scope isolation, bootstrap, relevance scoring, supersedes, digest). Including it bloats scope and risks design incoherence.

**Updated 2026-04-18:** Kyle's implementation plan is (1) Arranger produces V2 implementation plan from the V2 design; (2) V2 gets built + deployed; (3) V3 Dramaturg session runs **after** V2 is deployed, with V2 as a reference implementation. V3 inherits V2's deployed foundation and extends it with the KG layer designed in the V3 session.

*(Earlier session framing had V2 as design-only with a V1 → V3 direct jump; that framing is superseded. See the "Clarification: V2 Implementation Path" entry in `dramaturg-journal.md` for the full statement.)*

This document captures what Stages 1–3 surfaced about KG architectures so the next Dramaturg session starts with a research head-start rather than re-litigating from zero.

## V2 Session Context

- Dramaturg journal (V2): `kyle-projects/aletheia/docs/plans/designs/decisions/aletheia-v2/dramaturg-journal.md`
- V2 design doc (on completion): `kyle-projects/aletheia/docs/plans/designs/2026-04-17-aletheia-v2-design.md`
- V1 reference design: `kyle-projects/aletheia/2026-04-08-aletheia-design.md`
- V1 reference journal: `kyle-projects/aletheia/aletheia-dramaturg-journal.md`
- Staged brainstorming technique doc: `kyle-projects/skills-work/elevated-stage/dramaturg/docs/working/2026-04-17-staged-brainstorming-technique.md`

## Inventory of KG-Relevant Systems (from Stage 1)

### Pure knowledge graph for agent memory

- **Graphiti** (Zep AI) — dedicated Python library for temporal KG for agents. First-class validity windows as edges. Runs over Neo4j. Not MCP-native.
- **Mem0g** (mem0ai) — Mem0's graph mode. Hybrid graph + vector. Stitches "who did what, when, and with whom" natively alongside semantic match.
- **Microsoft GraphRAG** — LLM-extracted KG. Strength: answering *global* dataset questions (not just needle-in-haystack retrieval).
- **Neo4j GenAI / GraphRAG** — Cypher backend for multi-hop enterprise queries.
- **LightRAG** (HKU) — fast single-pass indexing. Hybrid graph + vector. Major cost/latency reduction vs multi-pass extraction.
- **HippoRAG** (OSU / Penn State) — KG with personalized PageRank for relationship spreading. Neurobiology-inspired activation model.
- **FalkorDB + mem0-falkordb** — low-latency KG. Auto-isolates each user into dedicated graphs (the `mem0_alice` pattern).
- **Cognee** — hybrid (graph + vector + relational). Deterministic ingestion pipelines explicitly designed to eliminate entity duplication.

### MCP-native KG

- **@modelcontextprotocol/server-memory** — official reference implementation. Local KG. Thin (no auth, no temporal, no hierarchy). Useful as a protocol-shape reference.

### Related patterns that inform KG decisions (not KG themselves)

- **Generative Agents memory stream** (Stanford) — episodic → reflection → semantic. Academic precedent for the "digest synthesis produces graph structure" pattern. Validates V1/V2's Dumb-Capture-Smart-Digest approach.
- **Zep** (temporal KG for conversational agents) — sidecar-based conflict resolution. Validity windows as first-class.
- **TiM (Think-in-Memory)** — store reasoning paths alongside interaction logs. Not graph-specific but pairs well with a KG where thought-nodes can link to action-nodes.

## Principles Distilled for V3's KG Layer

### Must-have

1. **Temporal validity as first-class graph edges** (Graphiti)
   - `valid_from` and `valid_to` on edges, not just metadata
   - `supersedes` becomes an edge type, not a deletion flag
   - Enables "what was true at T?" time-travel queries
   - **V2 already commits to `valid_from`/`valid_to` columns on entries** — V3's KG edges must use the same pattern for schema consistency

2. **Deterministic ingestion pipeline** (Cognee)
   - Entity extraction normalizes or hashes representations before node creation
   - LLM-generated entities pass dedup check before insertion
   - Prevents "Claude" / "Claude AI" / "Claude Code" becoming 3 separate nodes
   - Applies to both first-upgrade bootstrap and ongoing digest synthesis

3. **Single-pass indexing for bootstrap** (LightRAG)
   - Multi-pass LLM extraction on a large V1 corpus is prohibitively slow/expensive
   - Pattern: local NLP chunker (TF-IDF, regex for strict nouns) first, then **single** LLM pass for edge labeling
   - Bootstrap completes in seconds/minutes, not hours

4. **Physical partitioning for scope isolation** (FalkorDB `mem0_alice`)
   - V2 commits to ATTACH DATABASE per-scope SQLite files with readonly-attach for inheritance
   - V3's KG must respect these boundaries — either separate graph tables per attached DB, or separate graph DB instances per scope, or a scope-keyed graph store with query-time enforcement matching V2's partition guarantees
   - The KG layer CANNOT undo V2's partition model; it must live within it

### Should-have

5. **Personalized PageRank-style relationship spreading** (HippoRAG)
   - For multi-hop reasoning and relationship-based retrieval
   - Useful for "find memories connected to current task via 2-hop chains"
   - Value peaks as graph density grows — consider deferring beyond V3.0 if ingestion volume is low at first

6. **Sidecar / subprocess conflict resolution** (Zep)
   - KG writes that collide should not block the working agent
   - V2 already commits to MCP server spawning detached SDK digest subprocess — KG writes fit this pipeline
   - V3 should use the same subprocess for KG edge-creation and node-merge operations

7. **Global vs local question answering** (Microsoft GraphRAG)
   - L2 broad-scope injection could benefit from "summarize the project" (global) queries answered against the graph
   - V3's L2 hook could optionally run a GraphRAG-style global query for broad-scope injection payloads when relevant

### Anti-patterns to avoid

- **LLM-only entity extraction without dedup check** — guaranteed entity duplication; observed across multiple inventoried systems
- **Graph DB without temporal semantics** — loses the supersedes/archival story V2 sets up
- **Separate KG as a second source of truth** — must integrate with V2's OCC, digest pipeline, and retirement lifecycle, not replicate them

## V2 Architectural Decisions the KG Session MUST Respect

These are **locked in V2's design**; V3/KG cannot revisit them without renegotiating the V2 foundation with Kyle:

1. **ATTACH DATABASE scope partitioning** — per-scope SQLite files, readonly-attach for inheritance. KG storage and queries must fit this model.
2. **Temporal columns on entries** — `valid_from` / `valid_to` (NULL `valid_to` = currently valid). KG edges use the same temporal pattern.
3. **SDK digest orchestration** — MCP server spawns detached child process for synthesis; tracks PID; heartbeat + lease-lock coordination. KG write operations flow through this pipeline.
4. **`content_hash` deduplication at tool boundary** — entries have content-hash indexing. KG entity extraction participates in or extends this dedup.
5. **Claim-based hierarchical auth** — downward-only scoping, mutable sub-keys. KG queries respect the caller's scope.
6. **`sys_audit_log` immutable trail** — permission changes, scope transitions logged. KG permission changes use same mechanism.
7. **Tool deprecation lifecycle** — MCP tools marked `deprecated: true` with forward-migration strings. Any V2 tool KG replaces uses this mechanism cleanly.
8. **Threshold-gated Top-K relevance framework** — pluggable scoring interface. V3's graph-proximity signal becomes one score contributor alongside tag-overlap, recency, active-project weight.

## V2 Items Deferred Pending KG Decisions

These V2 items were intentionally left partial because KG outcomes shape their final form:

1. **L1/L2 relevance scoring algorithm** — V2 commits to *threshold-gated Top-K with configurable per-hook threshold* and a pluggable scoring interface. The actual scoring function is V3 territory — with graph signal available, scoring blends tag-overlap, recency, active-project weight, AND graph-proximity.

2. **Tag-rationalization vs KG bootstrap** — V2 initially scoped a tag-rationalization pass for V1 migration. Since V2 will not be built (V1 → V3 jump), this likely becomes the **KG bootstrap** directly in V3 — one pass, not two. The KG session should decide this.

3. **Entity resolution / tag merging** — V2 defers to V3. With KG, this becomes node-merging via Levenshtein + LLM validation as a background SDK task.

4. **`show_related` semantic evolution** — V2 inherits V1's tag-overlap threshold. V3 may offer graph-proximity alternative alongside tag-overlap.

5. **Multi-hop / transitive relatedness queries** — V2 has none; V3/KG enables these as first-class.

6. **Dedup response enrichment with graph-linked neighbors** — V2's `write_memory` returns `<duplicate existing_entry_id="..." existing_version="..." message="..."/>` when `content_hash` matches an existing active memory. V3 should enhance this to also include graph-linked neighbors of the duplicate: `<duplicate existing_entry_id="..." related_entries="[<id>, <id>, ...]"/>`. Kyle's framing: **a dedup hit is a learning signal — the working Claude didn't read existing memories thoroughly**; pointing to the duplicate *plus its graph neighborhood* surfaces the context Claude missed. V2 dedup is informational; V3 dedup becomes educational.

## Specific Open Questions for the KG Session

1. **Graph store choice.** SQLite tables (flexible, same file, same partition model) vs embedded graph DB (purpose-built) vs external Neo4j/FalkorDB (heavier, better multi-hop perf). Given V2's SQLite commitment, SQLite-based KG (adjacency tables with recursive CTE traversal) is the default assumption but should be formally evaluated against perf needs.

2. **Node/edge schema.** What's a node — an entry, an extracted entity, both? What's an edge — `supersedes`, `relates_to`, `contains`, `temporal_follows`, `derived_from`? Does the KG overlay on the existing entry tables or replace/augment them?

3. **Extraction pipeline.** Local NLP pre-pass + single LLM edge-labeling pass (LightRAG pattern) vs full LLM extraction (slower, richer). Cost/latency tradeoff matters heavily for V1 corpus bootstrap.

4. **Query surface.** New MCP tools (`query_graph`, `find_related_via_graph`, `query_past_state`) vs extending existing tools with graph-mode parameters. V2 already commits to `query_past_state` from the tombstoning decision — KG gives it richer semantics.

5. **Relationship with tags.** Does a tag become a node? Remain its own concept alongside the graph? Mem0g blends them; Graphiti keeps them separate. Mixed model risks duplicated semantics.

6. **Injection signal.** When L1/L2 hooks fire, does the graph-proximity signal come from a live graph traversal, a precomputed relevance cache, or a periodic batch job?

7. **Cross-scope graph queries.** ATTACH DATABASE makes per-scope isolation clean for storage. But queries like "memories in my scope that relate to an entity in the parent scope" need careful design — graph traversal across attached DBs must honor scope boundaries without leaking.

8. **V2 → V3 migration path.** Since V2 *is* being implemented before V3, the KG session designs a V2 → V3 DDL migration (via the generic `start_migration` framework from V2 Topic 4), not a V1 → V3 direct path. The V1 → V2 structural migration will already have run when the KG session starts. V3's migration is additive DDL: new KG tables, new columns on existing tables, KG bootstrap over the V2 corpus to populate initial graph from existing entries.

## Recommendations to the Next Dramaturg Session

1. **Start by re-reading V1 design, V1 journal, V2 journal, V2 design doc, this handoff — and inspecting the deployed V2 implementation.** All design artifacts live in the `kyle-projects/aletheia/docs/plans/designs/` tree. V2 design doc is the immediate predecessor; V2 source + operational observations are the empirical ground truth. The V3 session's advantage over this one is that V2 will be running — pay attention to which V2 patterns held up under real multi-agent load, which needed tuning, and what emergent behaviors the design didn't anticipate. Those observations should shape KG decisions more than any purely-paper analysis.

2. **Skip Stage 1 inventory.** This doc captures the KG-relevant subset. Move to a Stage 2-equivalent (comparative synthesis on the KG-relevant systems with full breadth already collapsed). Kyle's staged-brainstorming technique is documented at `kyle-projects/skills-work/elevated-stage/dramaturg/docs/working/2026-04-17-staged-brainstorming-technique.md`.

3. **Consider dispatching a fresh-eyes teammate** (per `kyle-projects/skills-work/elevated-stage/dramaturg/docs/working/2026-04-08-fresh-eyes-review-pattern.md`) once the KG design is drafted. Independent review is especially valuable given KG is V3's biggest delta.

4. **Ground all decisions against V2's locked items** listed above. Violations of those require renegotiating the V2 foundation with Kyle, not a unilateral override.

5. **Scope isolation, temporal columns, SDK digest, content-hash dedup, threshold-gated relevance are load-bearing V2 dependencies.** Design the KG to fit within them, not the other way around.

6. **V2 → V3 migration design is the V3 session's responsibility.** V1 → V2 migration will have already run at V2 deployment time (via V2's `migrate_from_v1`). V3's migration is a V2.x → V3.0 DDL migration via the generic `start_migration` framework from V2 Topic 4 — additive KG schema + KG bootstrap over the deployed V2 corpus. Much simpler than a V1 → V3 direct jump would have been.

## Status

**Written:** 2026-04-17
**Source:** Aletheia V2 Dramaturg session — Phase 3 Vision Expansion, Stages 1–3 of Gemini staged brainstorm
**Maintainer:** Current V2 Dramaturg session. Updates welcome from future sessions as research evolves.
