// What happens to an amount when the number of people changes.
//
// `misePlace` used to multiply every quantity by servings over serves, which is right for the
// lentils and a lie about the salt. Double a stew and you want roughly one and a half times the
// seasoning, not twice; triple a batter and you need a second tin rather than a deeper one, and the
// recipe's baking time stops describing it altogether.
//
// So scaling is a curated table, the same shape as the substitution and shelf-life tables: somebody
// wrote each row, the lookup widens from the ingredient to the role to the technique, and the
// arithmetic is integer.
//
// **Damping is a pair of integers, and the maths stays in milli-units.** A row's `damping` says how
// much of the change to apply: `[1,1]` is straight multiplication, `[1,2]` applies half the change,
// `[0,1]` would not scale at all. Written out, the rule is
//
//     scaled = base + (base × (servings − serves) × k_num) ÷ (serves × k_den)
//
// which is exactly "multiply, but only k of the way", rounded once at the end. No floats, so a
// doubled recipe and a halved one are exact inverses of each other where the damping is linear.
//
// The other half of the table is the part that cannot be expressed as a number at all: a warning
// that fires past a factor, because past double the limit is the pan and not the recipe. Those are
// carried out of the table and said out loud rather than folded into an amount.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dataDir } from "../recipes.ts";

export type ScalingEntry = {
  /** A named ingredient, or null on a wider row. */
  ingredient: string | null;
  role: string | null;
  technique: string | null;
  /** [numerator, denominator]: how much of the change in servings to apply. [1,1] is linear. */
  damping: readonly [number, number];
  note: string;
  /** The factor past which the warning applies, or null when the row has no warning. */
  warn_above: number | null;
  warning: string | null;
};

export type ScalingTable = {
  version: number;
  updated_on: string;
  author: string;
  entries: ScalingEntry[];
};

export type ScalingMatch = "ingredient" | "role+technique" | "role" | "technique" | "default";

export type ScalingRule = {
  damping: readonly [number, number];
  note: string | null;
  warn_above: number | null;
  warning: string | null;
  match: ScalingMatch;
};

/** Straight multiplication, which is what most things do and what the code did before this table. */
export const LINEAR: ScalingRule = { damping: [1, 1], note: null, warn_above: null, warning: null, match: "default" };

/** Given what an ingredient is and what is being done to it, how its amount behaves. */
export type Scaling = (ingredientId: string, role: string, technique: string) => ScalingRule;

export function scalingFile(): string {
  return process.env.SCALING_FILE ?? join(dataDir(), "scaling.json");
}

export function loadScaling(file: string = scalingFile()): ScalingTable {
  const raw = JSON.parse(readFileSync(file, "utf8")) as ScalingTable;
  const entries = [...raw.entries].sort(
    (a, b) =>
      (a.ingredient ?? "").localeCompare(b.ingredient ?? "") ||
      (a.role ?? "").localeCompare(b.role ?? "") ||
      (a.technique ?? "").localeCompare(b.technique ?? ""),
  );
  return { ...raw, entries };
}

function keyOf(ingredient: string | null, role: string | null, technique: string | null): string {
  return `${ingredient ?? "*"}|${role ?? "*"}|${technique ?? "*"}`;
}

export function buildScaling(table: ScalingTable): Scaling {
  const index = new Map<string, ScalingEntry>();
  for (const e of table.entries) index.set(keyOf(e.ingredient, e.role, e.technique), e);

  return (ingredientId: string, role: string, technique: string): ScalingRule => {
    const chain: [string, ScalingMatch][] = [
      [keyOf(ingredientId, null, null), "ingredient"],
      [keyOf(null, role, technique), "role+technique"],
      [keyOf(null, role, null), "role"],
      [keyOf(null, null, technique), "technique"],
    ];
    for (const [key, match] of chain) {
      const hit = index.get(key);
      if (hit) return { damping: hit.damping, note: hit.note, warn_above: hit.warn_above, warning: hit.warning, match };
    }
    return LINEAR;
  };
}

/**
 * Scale an amount from `serves` to `servings`, damped by the rule.
 *
 * Integer milli-units throughout, rounded exactly once. With linear damping this is the old
 * `scaleMilli` to the unit, which is what keeps the change safe: everything that used to multiply
 * still multiplies, and only the rows somebody wrote behave differently.
 */
export function scaleDamped(baseMilli: number, servings: number, serves: number, rule: ScalingRule): number {
  if (serves <= 0 || servings === serves) return baseMilli;
  const [num, den] = rule.damping;
  if (num === den) return Math.round((baseMilli * servings) / serves);
  // base + the change, taken k of the way. The whole expression is evaluated over integers and
  // rounded once, so scaling up and back down cannot drift.
  return Math.round(baseMilli + (baseMilli * (servings - serves) * num) / (serves * den));
}

export type ScalingWarning = {
  /** The ingredient or step the warning came from, for the caller to name. */
  ingredient_id: string;
  technique: string;
  factor_num: number;
  factor_den: number;
  text: string;
};

/**
 * The warnings a given scale-up earns, deduplicated by their text.
 *
 * A recipe with six things that all fry earns one warning about the pan, not six. These are said
 * out loud at `cook_start` rather than folded into any amount, because "use two tins" is not a
 * quantity and pretending it is would be the wrong kind of tidy.
 */
export function scalingWarnings(
  ingredients: { id: string; role: string; technique: string }[],
  servings: number,
  serves: number,
  scaling: Scaling,
): ScalingWarning[] {
  if (serves <= 0 || servings <= serves) return [];
  const seen = new Map<string, ScalingWarning>();
  for (const i of ingredients) {
    const rule = scaling(i.id, i.role, i.technique);
    if (rule.warning === null || rule.warn_above === null) continue;
    // The factor is a ratio, compared without dividing: servings/serves > warn_above.
    if (servings <= rule.warn_above * serves) continue;
    if (!seen.has(rule.warning)) {
      seen.set(rule.warning, { ingredient_id: i.id, technique: i.technique, factor_num: servings, factor_den: serves, text: rule.warning });
    }
  }
  return [...seen.values()].sort((a, b) => a.text.localeCompare(b.text));
}
