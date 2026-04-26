# CEO Review Feedback — Aletheia V2 Design

**Date:** 2026-04-25 (CEO review of 2026-04-17 Dramaturg output)
**Companion docs:**
- Design: `docs/plans/designs/2026-04-17-aletheia-v2-design.md`
- Decision journal: `docs/plans/designs/decisions/aletheia-v2/dramaturg-journal.md`
- KG handoff (V3): `docs/plans/designs/decisions/aletheia-v2/knowledge-graph-research-handoff.md`
- Kyle's responses: `/home/claude/kyle-response.md`

## Purpose

This document captures the full review back-and-forth between CEO and Kyle
on the V2 Dramaturg output, so the Arranger session can read both the
original concerns AND the resolved decisions side-by-side. Some
resolutions (e.g., the two-call confirmation pattern for feature overlap)
only make sense in light of the original concern.

**For Arranger:** Items 1-9 below are numbered to match
`STATUS.json:aletheia_v2_review_resolved_decisions`. Each has CEO's
original critique, Kyle's response, and the resolved decision. Items
marked RESOLVED are design changes the Arranger should fold in before
implementation planning. Strengths section is for Arranger to know what's
working — don't break it.

---

## Strengths (preserve in implementation)

These are architectural choices CEO flagged as strong; Arranger should
treat them as load-bearing and avoid weakening them during planning.

- **Scope isolation via `ATTACH DATABASE` is elegant architectural change,
  not a patch.** Eliminates V1's leak-bug failure class rather than
  defending against it. Multi-writer parallelism is a free side effect.
- **Append-only versioning math is right.** Tombstoning + validity windows
  + `query_past_state` form a coherent triplet (any two imply the third).
  Status sections get the per-section append-only treatment so V1's
  cost profile is preserved.
- **Session_bindings vs session_locks split is crisp.** Long-lived
  credential binding vs short-lived concurrent-use lock. "Key is identity,
  session-id is UX convenience" is the right mental model for recovery.
- **SDK subprocess tool-surface lock (`mcp__aletheia__*` only)** is the
  correct security boundary.
- **Visible-dedup principle carried throughout** — write routing,
  content-hash, queue dedup, auto-table all surface notices. Transparency
  by default is rare and valuable; preserve everywhere.
- **V3-extension framing as "recommended continuity, not locked
  contract"** gives V3 latitude without forcing premature commitment.

---

## Item 1 — Shadow Mode framing (RESOLVED)

### CEO original concern
> V2 deployment status — contradiction between your statement and the docs.
> You told me V2 "will not be deployed or shipped and is merely a stepping
> stone." But the design doc and KG handoff both say V2 **is** deployed
> ("V3 Dramaturg session, which will run with V2 deployed as a reference
> implementation"; "V2 gets built + deployed"; "V3 inherits V2's
> **deployed** foundation"). Which is correct: (a) V2 is fully deployed
> (replaces v0.2.8 on running installations) and V3 observes it under real
> multi-agent load, or (b) V2 is built to functional state but never
> swapped in; V3 Dramaturg is purely paper-based?
>
> This affects V2's polish requirements (Shadow Mode's value, test
> coverage depth, production-grade audit retention). If (b), Shadow Mode
> in particular becomes low-ROI since there's no real user traffic to
> sample.

### Kyle's response
> Yes, this was added by the Dramaturg at the last minute and I figured I
> would correct with the start of Arranger (or have you correct if there
> was a lot of feedback, which there seems to be). I thought the
> shadow-mode would apply to the V3 work as well, so shadow-mode could be
> ran with the final V3 implementation. Shadow-mode was part of the design
> before I mentioned the deploy point that made this confusion so I
> figured it was just a minor note that I could overwrite during
> review/Arranger.

### Resolved decision
**Build Shadow Mode infrastructure in V2; V2 itself may not exercise it.**
V3 uses the infrastructure to compare V3 ranking vs V2 baseline ranking
once V3 ships. V2's own V1-vs-V2 shadow comparison is optional — only
meaningful if V2 carries production traffic. If it doesn't, skip the
V1→V2 comparison entirely; the infrastructure stays unused-but-ready for
V3.

**Implication for Arranger:** Plumb the shadow-mode tables, sampling
hooks, and parallel-ranking call site in V2. Do not require V2 to ship
the V1 ranking pure function (`v1_rank`) if V2 is not deployed for
production traffic — make it a pluggable signal pulled in at V3-build
time instead.

---

## Item 2 — Install mechanism: standalone npm vs CC plugin (RESOLVED)

### CEO original concern
> Standalone npm vs CC plugin install decision is flagged as an open
> question. This is a priority call — it affects the global data directory
> layout, the update/upgrade UX, how MCP registration works, and whether
> `migrate_from_v1` runs through an npm install flow or plugin reinstall.
> Arranger shouldn't guess. You or Arranger decides up front.

### Kyle's response
> What is your take on this? Is there any benefit to making it a plugin vs
> mcp server or is it that it would need to be both? The plugin point is
> an artifact from when we were trying to decide on data storage location
> that I wanted to discuss further with you or Arranger.

### CEO's recommendation (resolved)
The framing "plugin vs MCP" was misleading — both deliver an MCP server.
The actual question is **packaging/distribution**:

- **Plugin** = Claude Code installation UX is built-in; MCP registration
  is automatic; data dir under plugin's allowed location; user runs
  `/plugin install aletheia`.
- **Standalone npm** = Works with any MCP client (not just CC); cleaner
  uninstall; existing v0.2.8 is npm.

### Resolved decision
**Standalone npm install for V2.** CC plugin is a future parallel
install path, not a V2 commitment.

Rationale: (a) existing v0.2.8 is already npm — no install paradigm
shift, less migration risk; (b) any MCP client can use it, not just CC;
(c) CC plugin API is still evolving — committing to it now risks rework.

**Implication for Arranger:** Ship V2 as `npm install -g aletheia`. Data
dir at `~/.aletheia/` (V1 precedent). Document plugin install as a future
option but don't design for it in V2. Architecture in V2 design §1 is
already location-agnostic, so adding plugin support later is non-breaking.

---

## Item 3 — SDK subprocess cold-start cost (RESOLVED)

### CEO original concern
> The design says "per-dispatch spawn is the V2 design assumption; latency
> + cold-start token cost may warrant a daemon. Revisit empirically after
> deployment if problems surface." If triggers fire frequently
> (entry_threshold, session_end), every dispatch = fresh `claude`
> invocation with model load, MCP init, CLAUDE.md read. That's multiple
> seconds and meaningful tokens per invocation. Worth benchmarking in the
> first implementation milestone, not as a post-deploy optimization. If
> cold-start dominates, the daemon alternative is a non-trivial design
> pivot and you want to know before the SDK contract locks. Recommend
> Arranger includes a benchmark gate.

### Kyle's response
> My concern with the daemon approach is that we would then need to worry
> about context usage and that it's session history would clutter the next
> task and would cost more token usage by loading the unwanted session
> history. The fresh launch is a pro, the launch time should be minimal,
> can be run by PM/TLs after their work has been approved in most cases
> when they are otherwise instructed to sit idle. For the auto-trigger
> points where there are N number of un-digested entries that is a valid
> point and may be worth expanding the number of un-digested entries
> allowed to accommodate for larger features.

### Resolved decision
**Stay with fresh-launch SDK subprocess. Add framing in design that
digest triggers prefer "natural boundary" events; the count threshold
(N undigested entries) is a safety net, not the primary trigger.**

Rationale: triggers fire at logical boundaries (feature_wrap,
session_end, supervisor approval) when the supervising session is
already paused — cold-start cost is bounded and amortized. The
count-threshold trigger is a backstop to avoid forever-undigested
backlogs; it should be tunable upward to accommodate larger feature
contexts (e.g., default 50 → configurable, with sane bounds).

**Implication for Arranger:** Document the trigger-priority order in
the digest pipeline section (§4): natural boundary > supervisor approval
> count threshold > time threshold. Make `entry_threshold` (count) and
`time_threshold` configurable per scope in `settings.toml`. Cold-start
cost does NOT need a benchmark gate — Kyle's reasoning makes it
acceptable as-is.

---

## Item 4 — Post-migration digest storm (RESOLVED)

### CEO original concern
> `migrate_from_v1` sets all imported entries to `digested_at=NULL`. First
> V2 session after migration faces a digest pass over the entire V1 corpus
> — potentially hundreds of entries across many scopes, all needing SDK
> subprocesses. Currently the CEO scope alone has dozens of memories. If
> migration triggers a digest-storm on first session, you could burn
> significant tokens and time before the system is usable. The migration
> report should explicitly recommend running mass-ingest for the first
> post-migration digest pass (1M context, 3h lease), and `migrate_from_v1`
> should probably offer `--stage-digest-as-mass-ingest` flag that
> auto-creates the mass-ingest request on your behalf.

### Kyle's response
> My goal for the initial migration is that it is done per-session. So
> when launching CEO, it can run its migration and then the PM/TLs are
> only migrated when launched. This should help the initial storm by
> limiting it to only the CEO and then to only active projects as they
> are resumed. Would this mitigate your concerns?

### Resolved decision
**Structural migration is one-shot for ALL scopes; the digest pass on
imported entries is LAZY and PER-SCOPE — runs at each scope's first
claim in V2.**

Rationale: A truly per-session structural migration creates split-brain
risk (V1 DB partially extracted while other scopes still live in it).
Splitting the work into "structural=atomic, digest=lazy" gives Kyle the
storm-limiting effect he wanted (only the active scope digests at first
claim) without compromising data consistency.

Concretely:
- `migrate_from_v1` extracts ALL V1 scopes into per-scope V2 .db files
  in one transaction. This is the structural migration. Single-shot,
  master-key gated.
- Each per-scope .db is left with `digested_at=NULL` on all migrated
  entries.
- On first claim of each scope in V2, that scope kicks off its own
  digest pass (default lease 30min, normal model). CEO claims first →
  CEO scope digests. PM-Hockey claims later → pm-hockey scope digests.
- Inactive scopes never digest until claimed.

**Implication for Arranger:** Update §6 (Migration Framework). Specify
that `migrate_from_v1` writes a "digest pending" marker per scope and
the first-claim handler reads this marker to enqueue the digest job.
Mass-ingest mode is NOT required for default migration but remains
available via `--stage-digest-as-mass-ingest` for users with large
single-scope corpora.

---

## Item 5 — Critical-entry scope-review during digest (RESOLVED)

### CEO original concern
> The digest SDK proposes "promote critical entry to higher scope when
> appropriate." But what criteria does the subprocess use?
> "Project-applicable vs session-specific" is fuzzy judgment. Without
> concrete signals (e.g., "promote if tags match ancestor-scope tag
> catalog above threshold X"), different digest runs will make
> inconsistent decisions on similar entries. Either lock the criteria
> into the V2 spec or defer the auto-promotion behavior entirely and
> make it a V3-with-KG feature where graph signals give it real traction.

### Kyle's response
> This is good point! Maybe we have the supervisor's digest agent review
> the lower session's critical entries instead of the session's digest
> agent. Keeps the same work-load for the digest agents, just migrates
> the critical entries from self to child sessions. Although on second
> thought, a PM with 2 TLs would have double the critical entry review,
> but critical entries should be minimal comparatively.

### CEO pushback (resolved)
The supervisor-digest framing doesn't fix the underlying problem: "should
this critical entry be at a higher scope?" is fuzzy criteria, regardless
of *which* digest agent evaluates it. Cross-scope coupling adds privacy
concerns (supervisor reads child's critical entries before promotion).

### Resolved decision
**Defer auto-promotion to V3, where graph signals make criteria concrete
(entity overlap, multi-hop neighbor density). For V2, ship a manual
`promote_memory(entry_id, target_scope)` tool only.**

Rationale: V2 manual promotion handles the rare cases where a user
explicitly wants to elevate; V3 with KG can do this automatically and
consistently because it has actual relational signal to work with, not
heuristic guessing.

**Implication for Arranger:** Remove the "Critical-entry scope-review"
sub-section from V2 design §4 (or mark it deferred to V3). Add a new
MCP tool `promote_memory(entry_id, target_scope)` to V2 design §3 — same
authorization as cross-scope writes (parent-scope key or master key, not
self-promotion). Update the KG handoff doc to note that auto-promotion
is one of the V3 design responsibilities.

---

## Item 6 — Auto-table on feature overlap (RESOLVED)

### CEO original concern
> `feature_init` or `resume_feature` with different active feature → auto-
> table current. This is opinionated UX. Could be annoying if a session
> is juggling two features legitimately. The mitigation is explicit
> `skip_feature_association=true` per-call, but the auto-table is still
> the default. Worth confirming this is the intent — maybe it's better
> to prompt/confirm rather than silently auto-table.

### Kyle's response
> I'm not opposed to a confirmation prompt, but it must not be a user
> prompt, can CC have an in-line, agent-directed approval like that?

### CEO recommendation (resolved)
There's no "session pauses and waits for in-context user-style approval"
mechanism in CC. But MCP tool response shape achieves the same: the
first call returns a warning instead of auto-tabling, and the agent
decides whether to retry with explicit `confirm_table_current=true`.

```
feature_init(name="X")
  → <warn code="FEATURE_OVERLAP" current_feature="Y"
        hint="call again with confirm_table_current=true to proceed,
              or use skip_feature_association=true to keep current active"/>

feature_init(name="X", confirm_table_current=true)
  → <feature_initiated id="..." auto_tabled="Y" .../>
```

Agent reads first response, decides, calls again. No silent auto-table,
no user prompt.

### Resolved decision
**Replace silent auto-table with two-call confirmation pattern.** First
call returns warn with hint; agent decides; second call proceeds with
`confirm_table_current=true` or alternatively uses
`skip_feature_association=true`.

**Implication for Arranger:** Update V2 design §4 (Feature Lifecycle).
Remove the silent auto-table behavior. Add the warn-response shape and
the `confirm_table_current` parameter to `feature_init` and
`resume_feature` schemas. Document the two-call pattern in tool-surface
docs.

---

## Item 7 — Feature name uniqueness across terminal state (RESOLVED)

### CEO original concern
> `UNIQUE(name)` in `features` table means an abandoned feature
> permanently reserves its name — can't re-init a feature with the same
> name later. Probably intentional for history consistency, but worth
> confirming vs. "name unique among non-terminal features."

### Kyle's response
> Keep the UNIQUE(name), but should warn appropriately on collisions

### Resolved decision
**Keep UNIQUE(name) constraint. On collision, the response surfaces a
helpful hint:**
```
<error code="FEATURE_NAME_TAKEN" name="X" existing_state="abandoned"
       since="2026-04-12"
       hint="choose a different name OR call list_features(state='abandoned') to inspect history"/>
```

**Implication for Arranger:** Standard UNIQUE constraint enforcement.
The error response shape is non-trivial — Arranger should specify it in
V2 design §4 alongside the existing feature-overlap warn shape (same
section, same response-template family).

---

## Item 8 — Mass-ingest approval change-of-mind (RESOLVED)

### CEO original concern
> Supervisor writes `approved: true`, server polls at ~30s, picks it up.
> If supervisor flips `approved: false` within that window, behavior is
> ambiguous. Design says "no post-approval cancellation," which implicitly
> means "first approval wins." Worth making explicit in the
> `update_status` semantics: once `approved: true` is observed, subsequent
> flips are ignored until request is re-issued.

### Kyle's response
> This has been flagged multiple times and I don't really foresee it as an
> issue, this is meant as an autonomous system and I haven't noticed CC
> ever double-back on a decision like that, especially not in that short
> of time. I feel the implementation of another gate to get a second
> confirmation adds too much overhead for this "catch-a-mistake" scenario

### Resolved decision
**First-approval-locks behavior is correct as-is. Document explicitly so
Arranger doesn't accidentally implement poll-and-revise semantics.**

Add one line in V2 design §4: "Once `approved: true` is observed by the
polling server on a `mass_ingest_requests` row, subsequent flips of the
approval section are ignored until the request is re-issued via
`request_mass_ingest`."

**Implication for Arranger:** Trivial — just document the existing
implicit behavior. No additional gate, no re-poll machinery, no second
confirmation. Server reads `approved: true` once; record locks; serve
the digest.

---

## Item 9 — Heartbeat default cadence (RESOLVED)

### CEO original Arranger flag
> Default heartbeat cadence (30s / 90s stale threshold) is tight for IO
> hiccups. Configurable is right; consider whether the default should be
> 60s/180s for real-world resilience with 30s as "aggressive" option.

### Kyle's response
> The default heartbeat is a solid point, let's include that in the
> feedback to change to 60s/180s for better resilience

### Resolved decision
**Change `session_locks` heartbeat default from 30s/90s to 60s/180s.**
30s remains available as an "aggressive" config option for users who
need tighter concurrent-claim detection.

**Implication for Arranger:** Trivial. Update V2 design §3 and the
default values in `settings.toml`. Document the trade-off in the
`session_locks` schema comment: lower cadence = faster split-brain
detection but more sensitive to IO/clock hiccups; higher cadence =
better resilience to transient stalls but longer fatal-claim window.

---

## Out-of-scope flags (Arranger verifies during implementation)

These are implementation details CEO flagged that need verification
during the Arranger pass but are not design-level decisions:

- **`session_id` env var / MCP handshake field source** — Claude Code
  internal; brittle if it changes. Verify the exact source field and the
  behavior when the value is missing/malformed. Negative test required.
- **`claudeMdExcludes` schema** — verify current CC harness supports it
  and the syntax is exact.
- **SQLite trigger syntax for audit-log immutability** — SQLite versions
  differ in trigger DDL. Pin the minimum version and validate.
- **Permission-prompt behavior for SDK subprocess** — the
  `--allowed-tools "mcp__aletheia__*"` + per-cwd `.aletheia/sdk-agent/`
  combo is asserted to avoid all prompts. Given the Hermes spike-fail
  finding (closed 2026-04-17), validate this with the same rigor — a
  small spike test early in implementation. **Important:** the Hermes
  spike found that Claude Code CLI enforces `.claude/` path protection
  downstream of both SDK callbacks AND shell hooks. If the SDK digest
  subprocess writes to any `.claude/` paths, those writes will trigger
  prompts that bypass tool-allowlist. Audit the digest's actual write
  surface.

---

## Summary — what Arranger should do

1. **Fold 9 resolved decisions into V2 design before producing the
   implementation plan.** Each item above lists "Implication for Arranger"
   with the specific design-doc edit needed.

2. **Preserve strengths.** ATTACH-DATABASE partitioning, append-only
   versioning, session-binding/lock split, MCP-only digest tool surface,
   visible-dedup principle, V3-extension framing.

3. **Verify implementation flags** during the Arranger pass — these are
   not design-level decisions but they affect feasibility and need
   spike-tests where flagged (especially the SDK-subprocess permission-
   prompt question, given the Hermes precedent).

4. **Use kyle-response.md and this doc together** — kyle-response.md is
   Kyle's responses; this doc adds CEO's original critique and resolved
   decisions so the rationale is fully captured.

---

## Source-of-truth pointers

- **Resolved decisions list (terse):** `/home/claude/STATUS.json` →
  `aletheia_v2_review_resolved_decisions`
- **Resolved decisions in Aletheia memory:** entry id
  `69f31364-a08a-4c02-b809-76fbedf06341` (critical, auto-injected via L1)
- **Aletheia journal entry with full content:** entry id
  `beaecb43-0352-4fe7-9e61-3de3743f5374`
- **Recovery reference:** `/home/claude/SESSION-RECOVERY.md` → "Resolved
  decisions from Dramaturg review" section
