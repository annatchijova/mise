// Nutrition, but only where it is honest.
//
// The dishonest version of this feature reports calories for a dish. It is easy to build, everybody
// expects it, and it is wrong nearly all the time — because the number it prints is the sum of the
// ingredients it happened to know, and it never says which ones those were.
//
// This corpus makes the problem impossible to hide. It is home cooking out of books, and 284 of its
// roughly 500 ingredient lines are `to_taste`: the recipe does not say how much. No table fixes
// that. So the honest tool here is mostly a **refusal**, and the work is in making the refusal
// useful — saying which ingredients it could account for, which it could not, and *why not*, in the
// two quite different senses of "why not":
//
//   - **the recipe never said how much**, which is a fact about the recipe, and
//   - **we have no figures for it**, which is a fact about our table.
//
// Those want different fixes and must not be blurred into one "coverage" number. A dish where the
// only gap is the parsley is not the same dish as one where the gap is the chickpeas, and a single
// percentage says the same thing about both.
//
// Nothing is ever estimated from a similar ingredient, and no total is produced with a hole in it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Unit, displayName } from "./pantry/events.ts";
import { type Ingredient, type Recipe, dataDir } from "./recipes.ts";

/** Grams per one of a measure, curated per ingredient. Absent means we do not weigh it. */
export type Measures = Partial<Record<Unit, number>>;

export type NutritionRow = {
  id: string;
  /** The state the figures are for. "chickpea" dried and "chickpea" cooked differ threefold. */
  name: string;
  kcal: number | null;
  /** Centigrams per 100 g — hundredths of a gram, as integers, for the same reason the pantry keeps
   *  thousandths: these are summed over and over and must not drift. */
  protein_cg: number | null;
  carb_cg: number | null;
  fat_cg: number | null;
  fibre_cg: number | null;
  /** What 100 ml of it weighs, for the liquids. Null means we do not turn its volume into weight. */
  g_per_100ml: number | null;
  measures: Measures;
  /** Curated: used in amounts too small to count. A judgment about the amount, made by a person,
   *  and never applied to a stated amount that is not a trace one. */
  negligible: boolean;
  source: string;
  note: string | null;
};

export type NutritionTable = {
  version: number;
  updated_on: string;
  author: string;
  basis: string;
  note: string;
  entries: NutritionRow[];
};

export function loadNutrition(file?: string): NutritionTable {
  return JSON.parse(readFileSync(file ?? join(dataDir(), "nutrition.json"), "utf8")) as NutritionTable;
}

export function indexNutrition(table: NutritionTable): Map<string, NutritionRow> {
  return new Map(table.entries.map((e) => [e.id, e]));
}

/** The measures small enough that a curated `negligible` may apply. A stated 200 g of cumin is not a
 *  trace amount however the table describes cumin, and must not be waved through. */
const TRACE_UNITS = new Set<Unit>(["to_taste", "pinch", "tsp", "tbsp"]);

/** Exact, for every substance there is. The same two the ledger allows and for the same reason. */
const EXACT: Partial<Record<Unit, { unit: Unit; factor: number }>> = {
  kg: { unit: "g", factor: 1000 },
  l: { unit: "ml", factor: 1000 },
};

export type WeighResult =
  | { grams: number; how: "weighed" | "measured" }
  | { grams: null; why: "no_amount" | "no_measure" };

/**
 * How many grams of an ingredient a recipe line calls for.
 *
 * `weighed` means the recipe stated a weight or a volume we know the weight of. `measured` means a
 * curated measure did the work — a medium onion is 150 g, a tablespoon of olive oil is 14 g — which
 * is a person's reference figure and is reported as such, never silently mixed in with a weight.
 *
 * Returns null in the two cases that matter, and says which: the recipe gave no amount, or it gave
 * one in a measure this ingredient has no curated weight for. Nothing is interpolated.
 */
export function weigh(line: Ingredient, row: NutritionRow | undefined): WeighResult {
  if (line.qty === null || line.qty === undefined || line.unit === "to_taste") {
    return { grams: null, why: "no_amount" };
  }
  const given = line.unit as Unit;
  const exact = EXACT[given];
  const qty = exact ? line.qty * exact.factor : line.qty;
  const unit: Unit = exact ? exact.unit : given;

  if (unit === "g") return { grams: qty, how: "weighed" };
  if (unit === "ml") {
    if (!row?.g_per_100ml) return { grams: null, why: "no_measure" };
    return { grams: (qty * row.g_per_100ml) / 100, how: "weighed" };
  }
  const per = row?.measures?.[unit];
  if (per === undefined) return { grams: null, why: "no_measure" };
  return { grams: qty * per, how: "measured" };
}

export type Nutrients = { kcal: number; protein_cg: number; carb_cg: number; fat_cg: number; fibre_cg: number };

const ZERO: Nutrients = { kcal: 0, protein_cg: 0, carb_cg: 0, fat_cg: 0, fibre_cg: 0 };

/** What `grams` of a row contributes. Integer-rounded once, at the end, per ingredient. */
function contribution(row: NutritionRow, grams: number): Nutrients {
  const scale = grams / 100;
  return {
    kcal: Math.round((row.kcal ?? 0) * scale),
    protein_cg: Math.round((row.protein_cg ?? 0) * scale),
    carb_cg: Math.round((row.carb_cg ?? 0) * scale),
    fat_cg: Math.round((row.fat_cg ?? 0) * scale),
    fibre_cg: Math.round((row.fibre_cg ?? 0) * scale),
  };
}

export type Counted = {
  ingredient_id: string;
  /** The state the figures are for, so "chickpea, dried" is not read as a bowl of cooked ones. */
  as: string;
  grams: number;
  how: "weighed" | "measured";
  nutrients: Nutrients;
};

/** Why an ingredient is not in the total. The two reasons are kept apart on purpose: one is a fact
 *  about the recipe and one is a fact about our table, and they are fixed by different people. */
export type Gap = {
  ingredient_id: string;
  reason: "no_amount" | "no_measure" | "no_data";
  /** What the recipe did say, when it said anything: "2 cups", "a slice". */
  stated: string | null;
};

export type NutritionReport = {
  recipe_id: string;
  servings: number;
  table_version: number;
  /** The per-serving total, or null when there is a hole in it. Never a total with a gap inside. */
  per_serving: Nutrients | null;
  total: Nutrients | null;
  /** What the ingredients we *could* account for come to, per serving. Present whenever anything was
   *  counted, including when there is no total — and it is not a smaller guess, it is a different
   *  and weaker claim that happens to be provable: every ingredient contributes a non-negative
   *  amount, so the dish cannot come to less than this. "At least" is a fact. "About" would not be. */
  at_least: Nutrients | null;
  counted: Counted[];
  gaps: Gap[];
  /** Trace ingredients a curator decided contribute nothing, listed so the decision is visible. */
  ignored_as_trace: string[];
  /** Ingredients that contribute nothing at any amount — water, in this corpus. Kept apart from the
   *  trace list because the reason is different in kind: a trace ingredient is somebody's judgment
   *  about how much gets used, and this is arithmetic. Not knowing how much water is in a soup
   *  cannot stop us adding the soup up, and it should not be allowed to. */
  contribute_nothing: string[];
  /** How many of the recipe's ingredients are in the total, ignoring the trace ones. */
  covered: number;
  of: number;
};

function stated(line: Ingredient): string | null {
  if (line.unit === "to_taste") return "to taste";
  if (line.qty === null || line.qty === undefined) return null;
  return `${line.qty} ${line.unit}`;
}

/**
 * What is in a dish, as far as anybody actually knows.
 *
 * The rule for producing a total is deliberately absolute: **every ingredient that is not curated as
 * a trace amount must be counted, or there is no total.** Not "most of them", not "enough of them" —
 * a threshold is just a smaller lie, and the person reading a calorie figure has no way to see which
 * side of it their dinner fell on. Either the number covers the food or it is not offered.
 */
export function nutritionOf(
  recipe: Recipe,
  index: Map<string, NutritionRow>,
  table: NutritionTable,
  servings?: number,
): NutritionReport {
  const portions = servings && servings > 0 ? servings : recipe.serves;
  const scale = portions / recipe.serves;

  const counted: Counted[] = [];
  const gaps: Gap[] = [];
  const trace: string[] = [];
  const nothing: string[] = [];
  let sum = { ...ZERO };

  for (const line of recipe.ingredients) {
    const row = index.get(line.id);

    // A trace ingredient is skipped only when the recipe measures it as one. Somebody writing 200 g
    // of cumin means it, and the table's judgment about a pinch does not cover them.
    if (row?.negligible) {
      if (TRACE_UNITS.has(line.unit as Unit)) {
        trace.push(line.id);
        continue;
      }
      gaps.push({ ingredient_id: line.id, reason: "no_data", stated: stated(line) });
      continue;
    }
    if (!row) {
      gaps.push({ ingredient_id: line.id, reason: "no_data", stated: stated(line) });
      continue;
    }

    // Zero of everything, at every amount. Water is the whole of this case in this corpus, and the
    // point is that it is not a judgment we are making: no quantity of a thing with no energy and no
    // macronutrients can change what the dish adds up to, so an unstated amount of it is not a hole.
    if (!row.kcal && !row.protein_cg && !row.carb_cg && !row.fat_cg && !row.fibre_cg) {
      nothing.push(line.id);
      continue;
    }

    const w = weigh(line, row);
    if (w.grams === null) {
      gaps.push({ ingredient_id: line.id, reason: w.why, stated: stated(line) });
      continue;
    }
    const grams = w.grams * scale;
    const nutrients = contribution(row, grams);
    counted.push({ ingredient_id: line.id, as: row.name, grams: Math.round(grams), how: w.how, nutrients });
    sum = {
      kcal: sum.kcal + nutrients.kcal,
      protein_cg: sum.protein_cg + nutrients.protein_cg,
      carb_cg: sum.carb_cg + nutrients.carb_cg,
      fat_cg: sum.fat_cg + nutrients.fat_cg,
      fibre_cg: sum.fibre_cg + nutrients.fibre_cg,
    };
  }

  const whole = gaps.length === 0 && counted.length > 0;

  const share = (n: Nutrients): Nutrients => ({
    kcal: Math.round(n.kcal / portions),
    protein_cg: Math.round(n.protein_cg / portions),
    carb_cg: Math.round(n.carb_cg / portions),
    fat_cg: Math.round(n.fat_cg / portions),
    fibre_cg: Math.round(n.fibre_cg / portions),
  });

  return {
    recipe_id: recipe.id,
    servings: portions,
    table_version: table.version,
    per_serving: whole ? share(sum) : null,
    total: whole ? sum : null,
    at_least: counted.length ? share(sum) : null,
    counted,
    gaps,
    ignored_as_trace: trace,
    contribute_nothing: nothing,
    covered: counted.length,
    of: counted.length + gaps.length,
  };
}

const REASON: Record<Gap["reason"], string> = {
  no_amount: "the recipe does not say how much",
  no_measure: "the recipe measures it in a way I cannot turn into a weight",
  no_data: "I have no figures for it",
};

function grams(cg: number): string {
  return `${(cg / 100).toFixed(cg % 100 === 0 ? 0 : 1)} g`;
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The report as something Alexa+ can say.
 *
 * When there is a total it comes with what it is a total *of*. When there is not, the sentence is
 * the point of the whole feature: it says how much of the dish is unaccounted for and which two
 * kinds of unaccounted it is, so the person knows whether the answer is missing or unknowable.
 */
export function nutritionSentence(r: NutritionReport): string {
  if (r.of === 0) return "That recipe lists no ingredients, so there is nothing to add up.";

  if (r.per_serving) {
    const measured = r.counted.filter((c) => c.how === "measured");
    const caveat = measured.length
      ? ` Some of that rests on standard measures rather than weights — ${listOf(measured.map((c) => displayName(c.ingredient_id)))}.`
      : "";
    const traced = r.ignored_as_trace.length
      ? ` The seasoning is not counted: ${listOf(r.ignored_as_trace.map(displayName))}.`
      : "";
    return (
      `About ${r.per_serving.kcal} calories a serving, at ${r.servings} servings: ` +
      `${grams(r.per_serving.protein_cg)} of protein, ${grams(r.per_serving.carb_cg)} of carbohydrate, ` +
      `${grams(r.per_serving.fat_cg)} of fat and ${grams(r.per_serving.fibre_cg)} of fibre. ` +
      `That covers all ${r.of} of the ingredients.${caveat}${traced}`
    );
  }

  const noAmount = r.gaps.filter((g) => g.reason === "no_amount").map((g) => displayName(g.ingredient_id));
  const noData = r.gaps.filter((g) => g.reason === "no_data").map((g) => displayName(g.ingredient_id));
  const noMeasure = r.gaps.filter((g) => g.reason === "no_measure").map((g) => displayName(g.ingredient_id));

  const parts: string[] = [];
  if (noAmount.length) parts.push(`the recipe does not say how much ${listOf(noAmount)} to use`);
  if (noMeasure.length) parts.push(`I cannot turn the ${listOf(noMeasure)} into a weight`);
  if (noData.length) parts.push(`I have no figures for ${listOf(noData)}`);

  if (r.covered === 0 || !r.at_least) {
    return `I cannot put a figure on that one: ${listOf(parts)}.`;
  }

  // The floor. Not a hedged version of the total — a different claim, and one that is actually true:
  // the ingredients we could weigh come to this much, and the ones we could not can only add.
  const measured = r.counted.filter((c) => c.how === "measured");
  const caveat = measured.length
    ? ` The ${listOf(measured.map((c) => displayName(c.ingredient_id)))} in that ${measured.length === 1 ? "rests" : "rest"} on a standard measure rather than a weight.`
    : "";
  return (
    `At least ${r.at_least.kcal} calories a serving, and I mean at least: that is the ` +
    `${r.covered} of ${r.of} ingredients I can account for — ${grams(r.at_least.protein_cg)} of protein, ` +
    `${grams(r.at_least.carb_cg)} of carbohydrate, ${grams(r.at_least.fat_cg)} of fat and ` +
    `${grams(r.at_least.fibre_cg)} of fibre — and the rest can only add to it. ` +
    `I stop short of a total because ${listOf(parts)}.${caveat}`
  );
}

/** What one ingredient is, per 100 g. Always answerable when we have a row, and always honest about
 *  the state the figures are for — which is the whole difficulty with beans. */
export function ingredientSentence(row: NutritionRow): string {
  if (row.negligible) {
    return `${row.name} is used in amounts too small to count, so I leave it out of a total rather than pretend to weigh it.`;
  }
  const note = row.note ? ` ${row.note}` : "";
  return (
    `100 g of ${row.name} is about ${row.kcal} calories: ${grams(row.protein_cg ?? 0)} of protein, ` +
    `${grams(row.carb_cg ?? 0)} of carbohydrate, ${grams(row.fat_cg ?? 0)} of fat and ` +
    `${grams(row.fibre_cg ?? 0)} of fibre.${note}`
  );
}
