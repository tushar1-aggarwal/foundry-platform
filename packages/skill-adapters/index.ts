/**
 * Skill adapter registry. Adding a new harness:
 *   1. Implement the `HarnessAdapter` contract in a sibling file.
 *   2. Import + push into the array below.
 * No other code changes required - the CLI / sync / detection layers
 * consume the registry generically.
 */

import type { HarnessAdapter } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { cursorAdapter } from "./cursor.js";
import { codexAdapter } from "./codex.js";

export const registry: HarnessAdapter[] = [claudeAdapter, cursorAdapter, codexAdapter];

/**
 * Lookup helper. Returns the adapter whose `harnessId` matches, or
 * `undefined` if none. Callers should error out clearly on undefined
 * (a typo or unsupported harness in config) rather than silently
 * falling through.
 */
export function findAdapter(harnessId: string): HarnessAdapter | undefined {
  return registry.find((a) => a.harnessId === harnessId);
}

export type { HarnessAdapter, LocalSkill, CanonicalSkill, SupportingFile, WrittenFile } from "./types.js";
