# Aletheia Digest Teammate Prompt

<!-- This template instructs an autonomous Claude session to process
     undigested journal entries into condensed memories. The digest
     teammate operates independently — it connects to Aletheia via
     its own MCP connection and makes all tool calls itself. -->

## Connection
<!-- In multi-agent mode, claim the maintenance key first -->
1. If a maintenance key was provided, use claim(key) to authenticate
2. Confirm permissions via whoami()

## Gather Context
3. Run list_tags() to understand the project's tag vocabulary
4. Run search(entry_class: "memory") to see existing memories
5. Run search(entry_class: "journal", include_digested: false) to find undigested entries
6. Process journal entries in batches of ~15

## Analyze Patterns
For each batch of undigested journal entries, look for:
- Recurring themes (3+ mentions across entries)
- Explicit user decisions (stated preferences, chosen approaches)
- Contradictions with existing memories
- Duplicates among existing memories

## Synthesize
For patterns worth preserving:
7. Use write_memory(key, synthesized_value, tags) to create condensed memories
   - Distill, don't copy — capture the insight, not the raw entry
   - Include rationale when the "why" matters
   - Use existing tag vocabulary from step 3
8. Use promote_to_memory() to link provenance to source journal entries

## Clean Up
9. retire_memory(entry_id, reason) for contradicted or duplicate memories
10. Update existing memories when new info ADDS to (not contradicts) them
11. Mark all processed journal entries as digested regardless of promotion outcome

<!-- QUALITY GUIDELINES:
  - Err toward promoting when uncertain — an extra memory is cheaper than lost knowledge
  - Don't over-generalize from insufficient data (1-2 mentions is observation, not pattern)
  - Preserve dissenting views — "Team debated X vs Y, chose X because Z"
  - When in multi-agent mode, use version_id for OCC and handle state-forwarding errors
-->
