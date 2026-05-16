/**
 * LLM Router -- tier escalation ladder.
 *
 * Declarative ladder of escalation tiers. The entry for tier `T` is the
 * ordered list of tiers to try when `T` has no qualifying models. Extending
 * the tier set is one edit here; the balanced policy selector reads
 * `higherTiers(t)` verbatim.
 */

export type Tier = "economy" | "standard" | "frontier";

const ESCALATION: Record<Tier, Tier[]> = {
  economy: ["standard", "frontier"],
  standard: ["frontier"],
  frontier: [],
};

/** Return the tiers to try above `tier`, in order. Empty if `tier` is the top. */
export function higherTiers(tier: string): Tier[] {
  return tier in ESCALATION ? ESCALATION[tier as Tier] : [];
}
