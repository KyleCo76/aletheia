// Shared query-predicate builder for search functions. Converts a
// user-facing search string into a SQL WHERE fragment that matches
// on the literal phrase AND on each meaningful token from the
// phrase — letting callers pass descriptive English like "load the
// bootstrap info" and still find a memory named "bootstrap-info".
//
// Design notes:
// - Exact-phrase LIKE match is preserved unconditionally so
//   callers who search with a literal phrase that IS in the corpus
//   still hit. Single-word queries (tokens === [query]) behave
//   identically to the pre-v0.2.1 LIKE path.
// - Tokens shorter than 3 chars and a small English stop-word list
//   are filtered out so queries like "a of to in" do not OR-match
//   every row in the table.
// - Produces ONE (col LIKE ? OR col LIKE ? ...) group, suitable to
//   AND into an existing WHERE clause.

const STOP_WORDS = new Set([
  'the', 'and', 'but', 'for', 'nor', 'yet', 'with', 'from',
  'this', 'that', 'these', 'those', 'its', 'their', 'our', 'your',
  'was', 'were', 'are', 'has', 'have', 'had', 'not', 'can', 'will',
  'into', 'onto', 'upon', 'over', 'under', 'about', 'after', 'before',
]);

export function buildSearchPredicate(
  query: string,
  columns: string[],
): { sql: string; bindings: string[] } {
  const terms = new Set<string>();
  // Always try the literal query first so exact-phrase matches still
  // work and single-word queries see no behavior change.
  terms.add(query);

  const lowered = query.toLowerCase();
  for (const raw of lowered.split(/\s+/)) {
    if (raw.length < 3) continue;
    if (STOP_WORDS.has(raw)) continue;
    terms.add(raw);
  }

  const clauses: string[] = [];
  const bindings: string[] = [];
  for (const term of terms) {
    for (const col of columns) {
      clauses.push(`${col} LIKE ?`);
      bindings.push(`%${term}%`);
    }
  }

  return { sql: `(${clauses.join(' OR ')})`, bindings };
}
