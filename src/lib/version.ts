// Single source of truth for the CLI / package version, isolated
// in its own module so it can be imported without dragging in
// the side effects of cli.ts (which auto-runs main() on import).
//
// Bumped in lockstep with package.json and src/server/index.ts
// during the release chore commit. Keep all three in sync.
export const VERSION = '0.2.6';
