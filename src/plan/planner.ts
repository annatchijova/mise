// The weekly plan: an integer score and a scheduling rule, not a model.
//
// Two things make this worth writing rather than asking Alexa+ to improvise. The first is that the
// same pantry has to produce the same plan — same meals, same order, same hash — or nobody can
// reason about why Thursday changed. The second is that "use what is about to go off" is a
// scheduling problem with deadlines, and a language model asked to do it will produce something
// plausible instead of something correct.
//
// So the plan is built in two passes:
//
//   1. **Deadlines.** Every ingredient on hand with a date is a job that must run before it. Taken
//      in order of urgency, each one is assigned the best recipe that uses it, in the *latest* slot
//      that still falls before its date — the textbook greedy for sequencing with deadlines, and the
//      reason the tofu that expires Friday lands on Thursday rather than on Monday, leaving the
//      earlier days free for whatever is tighter. An ingredient with no slot left before its date is
//      not quietly dropped: it comes back in `unplaceable`, which is the system admitting it cannot
//      save that one.
//   2. **The rest.** Remaining slots are filled in day order by score: how much of the recipe is
//      already in the kitchen, how little is missing, how well it fits the time budget, and a
//      penalty for the same protein two meals running.
//
// Every meal carries the reason it is there, in words, from the pass that placed it. The narrator
// reads that reason; it does not invent one.
import { createHash } from "node:crypto";

import type { Recipe } from "../recipes.ts";
import type { PantryItem } from "../pantry/fold.ts";
import { type Unit, canonicalAmount, dayOf, toMilli } from "../pantry/events.ts";

export type MealName = "breakfast" | "lunch" | "dinner";

/** Which categories suit which meal. A preference worth points, never a hard filter: this corpus
 *  has one breakfast recipe, and an empty Tuesday helps nobody. */
const MEAL_CATEGORIES: Record<MealName, string[]> = {
  breakfast: ["breakfast", "bread", "dessert"],
  lunch: ["main", "soup", "side"],
  dinner: ["main", "soup"],
};

export function mealsOfDay(perDay: number): MealName[] {
  if (perDay <= 1) return ["dinner"];
  if (perDay === 2) return ["lunch", "dinner"];
  return ["breakfast", "lunch", "dinner"];
}

export type Availability = {
  ingredient_id: string;
  /** Is there a line for it in the pantry at all. */
  have: boolean;
  /** true / false when the amounts can be compared, null when the pantry's amount is unknown or in
   *  a unit that cannot be compared to the recipe's without guessing a density. */
  enough: boolean | null;
  needed_milli: number | null;
  needed_unit: Unit;
  short_milli: number | null;
};

export type ScoredRecipe = {
  recipe: Recipe;
  score: number;
  have: number;
  missing: string[];
  short: string[];
  expiring_used: { ingredient_id: string; days_to_expiry: number }[];
};

export type PlanMeal = {
  day: number;
  date: string;
  meal: MealName;
  recipe_id: string;
  title: string;
  minutes: number;
  /** What this meal adds to the week's shopping bill: the whole list's cost minus what it would
   *  cost without this meal. Marginal rather than standalone, because one bag of lentils feeds two
   *  dinners and charging both for it would be arithmetic nobody could check. null when there is no
   *  price list, or when what this meal needs is not something the shop sells. */
  cost_cents: number | null;
  /** `expiring` when a deadline put it here, `pantry` when the score did, `thin` when nothing fit
   *  well and this was the best of a bad row. */
  why_code: "expiring" | "pantry" | "thin";
  why: string;
  uses_expiring: { ingredient_id: string; days_to_expiry: number }[];
  missing: string[];
};

export type MissingLine = {
  ingredient_id: string;
  unit: Unit;
  /** null when at least one recipe never said how much. Never a guess. */
  qty: number | null;
  qty_known: boolean;
  for_recipes: string[];
  /** true when the pantry has some but not enough, rather than none at all. */
  topping_up: boolean;
};

export type PlanCost = {
  /** What the shopping list costs at the shop's prices, in integer cents. */
  shopping_cents: number;
  /** Lines the shop could not price, each with the reason. The total above excludes them, so it is
   *  a floor and not an estimate — reported rather than folded into a number that would be wrong. */
  unpriced: { ingredient_id: string; reason: string }[];
  budget_cents: number | null;
  /** How far past the ceiling the plan came out, or null when it did not. Never silently met. */
  over_by_cents: number | null;
};

export type PlanResult = {
  plan_id: string;
  start_date: string;
  days: number;
  meals_per_day: number;
  time_budget_min: number | null;
  meals: PlanMeal[];
  missing: MissingLine[];
  /** Food that will go off before any slot could use it, and why. */
  unplaceable: { ingredient_id: string; days_to_expiry: number; reason: string }[];
  /** Slots nothing could fill, with the reason. An empty Wednesday stated plainly beats a bad one. */
  unfilled: { day: number; date: string; meal: MealName; reason: string }[];
  plan_hash: string;
  pantry_as_of: string;
  /** null when no price list was supplied. */
  cost: PlanCost | null;
  /** The per-day limits actually applied, after the global one is filled in. */
  day_budgets: { day: number; minutes: number }[];
};

export type PlanInput = {
  recipes: Recipe[];
  pantry: PantryItem[];
  now: string;
  days: number;
  meals_per_day: number;
  time_budget_min?: number | null;
  /** Per-day limits, for the day somebody gets home at nine. They override the weekly one for that
   *  day and are a hard filter like it: a limit that bends is not a limit. */
  day_budgets?: { day: number; minutes: number }[];
  /** Ingredient ids to keep out of the week. */
  avoid?: string[];
  start_date?: string;
  /** What a line of the shopping list costs in integer cents, or why it cannot be priced. Injected
   *  rather than imported so the planner stays independent of the store — and so the plan's figure
   *  and the basket's are computed by the same function. */
  priceOf?: (want: { ingredient_id: string; unit: Unit; qty: number | null }) => { cents: number } | { reason: string };
  /** A ceiling on what the week's shopping may cost. A preference the scorer leans on, never a
   *  promise: if the plan comes out over, it says so rather than pretending. */
  budget_cents?: number | null;
};

// --- the pantry, as the planner needs it ------------------------------------------------------

export type OnHand = {
  /** Amount per unit, so a comparison never crosses units it cannot cross. */
  byUnit: Map<Unit, { milli: number | null }>;
  days_to_expiry: number | null;
  /** Whether that date is one somebody stated or one the shelf-life table worked out. It changes
   *  nothing about the scheduling and everything about the sentence the plan gives back. */
  expiry_source: "stated" | "estimated" | "unknown";
};

function indexPantry(items: PantryItem[]): Map<string, OnHand> {
  const map = new Map<string, OnHand>();
  for (const i of items) {
    const entry = map.get(i.ingredient_id) ?? { byUnit: new Map<Unit, { milli: number | null }>(), days_to_expiry: null, expiry_source: "unknown" as OnHand["expiry_source"] };
    const prior = entry.byUnit.get(i.unit);
    const milli = i.qty === null ? null : Math.round(i.qty * 1000);
    // Two lines of the same ingredient and unit in different places add up; one unknown makes the
    // total unknown, the same rule the fold itself follows.
    entry.byUnit.set(i.unit, {
      milli: prior === undefined ? milli : prior.milli === null || milli === null ? null : prior.milli + milli,
    });
    if (i.days_to_expiry !== null) {
      const tighter = entry.days_to_expiry === null || i.days_to_expiry < entry.days_to_expiry;
      if (tighter) {
        entry.days_to_expiry = i.days_to_expiry;
        entry.expiry_source = i.expiry_source;
      } else if (i.days_to_expiry === entry.days_to_expiry && i.expiry_source === "stated") {
        // Same date from two lines: the one somebody actually stated is the one to cite.
        entry.expiry_source = "stated";
      }
    }
    map.set(i.ingredient_id, entry);
  }
  return map;
}

function availability(recipe: Recipe, onHand: Map<string, OnHand>): Availability[] {
  return recipe.ingredients.map((i) => {
    const needed = i.qty === null ? null : canonicalAmount(toMilli(i.qty), i.unit as Unit);
    const unit = (needed?.unit ?? i.unit) as Unit;
    const entry = onHand.get(i.id);
    if (!entry) return { ingredient_id: i.id, have: false, enough: false, needed_milli: needed?.qty_milli ?? null, needed_unit: unit, short_milli: needed?.qty_milli ?? null };
    const line = entry.byUnit.get(unit);
    if (line === undefined) {
      // We have the ingredient, but measured in something this recipe's amount cannot be compared
      // to. Having it counts; whether it is enough is genuinely unknown.
      return { ingredient_id: i.id, have: true, enough: null, needed_milli: needed?.qty_milli ?? null, needed_unit: unit, short_milli: null };
    }
    if (line.milli === null || needed?.qty_milli == null) {
      return { ingredient_id: i.id, have: true, enough: null, needed_milli: needed?.qty_milli ?? null, needed_unit: unit, short_milli: null };
    }
    const short = needed.qty_milli - line.milli;
    return {
      ingredient_id: i.id,
      have: true,
      enough: short <= 0,
      needed_milli: needed.qty_milli,
      needed_unit: unit,
      short_milli: short > 0 ? short : null,
    };
  });
}

// --- scoring --------------------------------------------------------------------------------

/** Points for using something that is about to go off. Highest the day before it expires, and
 *  never zero while it is still usable, so the planner always prefers rescuing food to not. */
export function urgencyPoints(daysToExpiry: number): number {
  if (daysToExpiry < 0) return 0;
  return Math.max(20, 100 - 10 * daysToExpiry);
}

/** Coverage is scored as a percentage rather than a count, and that is not a detail. Scored per
 *  ingredient, a four-ingredient recipe you own none of beats a fourteen-ingredient one you already
 *  have half of, because it collects fewer penalties — which is the exact opposite of the point.
 *  A percentage is scale-free: half a dish is half a dish whether it has four ingredients or forty. */
const COVERAGE_MAX = 100;
/** A long shopping list is a nudge, never a veto: capped so it cannot outweigh coverage or urgency. */
const MISSING_PENALTY = 4;
const MISSING_PENALTY_CAP = 40;
const SHORT_PENALTY = 5;
const CATEGORY_FIT = 30;
const REPEAT_PROTEIN_PENALTY = 60;
/** One point per dollar its own shopping would cost, capped so money can never outweigh rescuing
 *  food that is about to go off. Applied only when somebody actually set a ceiling: quietly
 *  preferring cheap meals when nobody asked about money is a behaviour change nobody requested. */
const COST_PENALTY_CAP = 60;

export function primaryProtein(recipe: Recipe): string | null {
  return recipe.ingredients.find((i) => i.role === "protein")?.id ?? null;
}

export function scoreRecipe(
  recipe: Recipe,
  onHand: Map<string, OnHand>,
  opts: {
    meal: MealName; windowDays: number; previousProtein: string | null; dayIndex: number;
    /** Ingredients a deadline has already found a meal for. They are rescued; scoring them urgent a
     *  second time would pull the same food into two meals and undo the "latest usable slot" rule. */
    claimed?: Set<string>;
    /** Set only when a spending ceiling was given. See COST_PENALTY_CAP. */
    priceOf?: PlanInput["priceOf"];
  },
): ScoredRecipe {
  const avail = availability(recipe, onHand);
  let score = 0;
  let have = 0;
  const missing: string[] = [];
  const short: string[] = [];
  const expiring: { ingredient_id: string; days_to_expiry: number }[] = [];

  for (const a of avail) {
    if (!a.have) {
      missing.push(a.ingredient_id);
      continue;
    }
    have++;
    if (a.enough === false) {
      short.push(a.ingredient_id);
      score -= SHORT_PENALTY;
    }
    const d = onHand.get(a.ingredient_id)?.days_to_expiry ?? null;
    // Only food that would still be good on the day of this meal earns urgency points.
    if (d !== null && d >= 0 && d <= opts.windowDays && opts.dayIndex <= d + 1 && !opts.claimed?.has(a.ingredient_id)) {
      score += urgencyPoints(d);
      expiring.push({ ingredient_id: a.ingredient_id, days_to_expiry: d });
    }
  }

  score += avail.length === 0 ? 0 : Math.floor((COVERAGE_MAX * have) / avail.length);
  score -= Math.min(MISSING_PENALTY_CAP, MISSING_PENALTY * missing.length);
  if (opts.priceOf) {
    // What this dish alone would add to a shopping list. Standalone rather than marginal, because
    // at scoring time there is no list yet — a proxy, and only ever a nudge.
    let cents = 0;
    for (const a of avail) {
      if (a.have && a.enough !== false) continue;
      const answer = opts.priceOf({ ingredient_id: a.ingredient_id, unit: a.needed_unit, qty: a.needed_milli === null ? null : a.needed_milli / 1000 });
      if ("cents" in answer) cents += answer.cents;
    }
    score -= Math.min(COST_PENALTY_CAP, Math.floor(cents / 100));
  }
  if (MEAL_CATEGORIES[opts.meal].includes(recipe.category)) score += CATEGORY_FIT;
  // A shorter dish wins a tie; the time budget itself is a hard filter applied by the caller.
  score -= Math.floor(recipe.minutes / 10);
  if (opts.previousProtein !== null && primaryProtein(recipe) === opts.previousProtein) score -= REPEAT_PROTEIN_PENALTY;

  expiring.sort((a, b) => a.days_to_expiry - b.days_to_expiry || a.ingredient_id.localeCompare(b.ingredient_id));
  return { recipe, score, have, missing: [...missing].sort(), short: [...short].sort(), expiring_used: expiring };
}

/**
 * The reason a deadline put a meal where it did.
 *
 * A stated date is quoted; a shelf-life estimate is hedged, because it is one, and the hedge is the
 * difference between advice and a claim. Every `why` in a plan — this one and the two the fill pass
 * writes — is a clause that reads correctly after the word "because", so the diff can quote it
 * without rewriting it. A reason that has to be reworded to be said is a reason somebody else wrote.
 */
export function whyExpiring(ingredientId: string, days: number, source: "stated" | "estimated" | "unknown"): string {
  const name = ingredientId.replace(/-/g, " ");
  if (source === "estimated") {
    const when = days === 0 ? "is about done" : days === 1 ? "has about a day left" : `has roughly ${days} days left`;
    return `it uses the ${name}, which ${when} by the shelf-life table — nobody gave it a date`;
  }
  const when = days === 0 ? "goes off today" : days === 1 ? "goes off tomorrow" : `has ${days} days left`;
  return `it uses the ${name}, which ${when}`;
}

// --- the plan -------------------------------------------------------------------------------

type Slot = { day: number; date: string; meal: MealName; filled: PlanMeal | null };

function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

export function planWeek(input: PlanInput): PlanResult {
  const days = Math.max(1, Math.min(14, Math.floor(input.days)));
  const perDay = Math.max(1, Math.min(3, Math.floor(input.meals_per_day)));
  const start = input.start_date ?? dayOf(input.now);
  const budget = input.time_budget_min ?? null;
  const avoid = new Set(input.avoid ?? []);
  const onHand = indexPantry(input.pantry);

  const meals = mealsOfDay(perDay);
  const slots: Slot[] = [];
  for (let d = 1; d <= days; d++) {
    for (const meal of meals) slots.push({ day: d, date: addDays(start, d - 1), meal, filled: null });
  }

  // Time limits. The weekly one is the default and a per-day one overrides it, because a week is
  // not uniform: Wednesday is the day somebody gets home at nine. Both are hard filters — a limit
  // that bends is not a limit — so they are applied per slot rather than once over the corpus.
  const perDayBudget = new Map<number, number>();
  for (const b of input.day_budgets ?? []) {
    if (Number.isInteger(b.day) && b.day >= 1 && b.day <= days && Number.isInteger(b.minutes) && b.minutes > 0) {
      perDayBudget.set(b.day, b.minutes);
    }
  }
  const budgetFor = (day: number): number | null => perDayBudget.get(day) ?? budget;
  const dayBudgets = Array.from({ length: days }, (_, i) => ({ day: i + 1, minutes: budgetFor(i + 1) }))
    .filter((b): b is { day: number; minutes: number } => b.minutes !== null);

  // A recipe carrying something to avoid is not a candidate anywhere, and no recipe appears twice.
  const eligible = input.recipes.filter((r) => !r.ingredients.some((i) => avoid.has(i.id)));
  const used = new Set<string>();
  const fitsSlot = (r: Recipe, day: number): boolean => {
    const limit = budgetFor(day);
    return limit === null || r.minutes <= limit;
  };

  const proteinBefore = (index: number): string | null => {
    for (let i = index - 1; i >= 0; i--) {
      const f = slots[i].filled;
      if (f) return primaryProtein(input.recipes.find((r) => r.id === f.recipe_id)!);
    }
    return null;
  };

  const claimed = new Set<string>();
  const costBias = input.budget_cents !== null && input.budget_cents !== undefined ? input.priceOf : undefined;

  const best = (slotIndex: number): ScoredRecipe | null => {
    const slot = slots[slotIndex];
    const previous = proteinBefore(slotIndex);
    const scored = eligible
      .filter((r) => !used.has(r.id) && fitsSlot(r, slot.day))
      .map((r) => scoreRecipe(r, onHand, { meal: slot.meal, windowDays: days, previousProtein: previous, dayIndex: slot.day, claimed, priceOf: costBias }))
      // Ties broken by id, so two machines with the same pantry produce the same week.
      .sort((a, b) => b.score - a.score || a.recipe.minutes - b.recipe.minutes || a.recipe.id.localeCompare(b.recipe.id));
    return scored[0] ?? null;
  };

  const unplaceable: PlanResult["unplaceable"] = [];

  // --- pass 1: deadlines ---------------------------------------------------------------------
  const urgent = [...onHand.entries()]
    .filter(([, v]) => v.days_to_expiry !== null && v.days_to_expiry <= days)
    .map(([id, v]) => ({ id, days: v.days_to_expiry!, source: v.expiry_source }))
    .sort((a, b) => a.days - b.days || a.id.localeCompare(b.id));

  for (const item of urgent) {
    // Already rescued by an earlier deadline's meal — one dish can save two things.
    if (claimed.has(item.id)) continue;
    if (item.days < 0) {
      unplaceable.push({ ingredient_id: item.id, days_to_expiry: item.days, reason: "already past its date when the week starts" });
      continue;
    }
    // The last day this can still be eaten, inside the window.
    const deadlineDay = Math.min(days, item.days + 1);
    const candidates = slots
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => s.filled === null && s.day <= deadlineDay)
      // Latest first: leave the early days for anything with a tighter date.
      .sort((a, b) => b.s.day - a.s.day || b.index - a.index);
    if (candidates.length === 0) {
      unplaceable.push({ ingredient_id: item.id, days_to_expiry: item.days, reason: "no meal left before its date" });
      continue;
    }

    let placed = false;
    for (const { s, index } of candidates) {
      const previous = proteinBefore(index);
      const scored = eligible
        .filter((r) => !used.has(r.id) && fitsSlot(r, s.day) && r.ingredients.some((i) => i.id === item.id))
        .map((r) => scoreRecipe(r, onHand, { meal: s.meal, windowDays: days, previousProtein: previous, dayIndex: s.day, claimed, priceOf: costBias }))
        .sort((a, b) => b.score - a.score || a.recipe.minutes - b.recipe.minutes || a.recipe.id.localeCompare(b.recipe.id));
      const pick = scored[0];
      if (!pick) break; // no recipe uses this at all; a later slot will not change that
      used.add(pick.recipe.id);
      // Everything this meal rescues is spoken for, not only the item that triggered it.
      for (const e of pick.expiring_used) claimed.add(e.ingredient_id);
      s.filled = {
        day: s.day, date: s.date, meal: s.meal,
        recipe_id: pick.recipe.id, title: pick.recipe.title, minutes: pick.recipe.minutes,
        cost_cents: null,
        why_code: "expiring",
        why: whyExpiring(item.id, item.days, item.source),
        uses_expiring: pick.expiring_used,
        missing: pick.missing,
      };
      placed = true;
      break;
    }
    if (!placed) {
      unplaceable.push({ ingredient_id: item.id, days_to_expiry: item.days, reason: "no recipe here uses it" });
    }
  }

  // --- pass 2: fill the rest ------------------------------------------------------------------
  const unfilled: PlanResult["unfilled"] = [];
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (slot.filled !== null) continue;
    const pick = best(index);
    if (!pick) {
      const limit = budgetFor(slot.day);
      unfilled.push({
        day: slot.day, date: slot.date, meal: slot.meal,
        reason: limit === null
          ? "nothing left that has not already been planned this week"
          : `nothing left under ${limit} minutes that has not already been planned this week`,
      });
      continue;
    }
    used.add(pick.recipe.id);
    const thin = pick.have === 0;
    slot.filled = {
      day: slot.day, date: slot.date, meal: slot.meal,
      recipe_id: pick.recipe.id, title: pick.recipe.title, minutes: pick.recipe.minutes,
      cost_cents: null,
      why_code: thin ? "thin" : "pantry",
      why: thin
        ? "nothing in the kitchen fits this slot, so this is a shopping night"
        : `${pick.have} of its ${pick.recipe.ingredients.length} ingredients ${pick.have === 1 ? "is" : "are"} already here${pick.missing.length ? `, ${pick.missing.length} to buy` : ""}`,
      uses_expiring: pick.expiring_used,
      missing: pick.missing,
    };
  }

  // --- the shopping list -----------------------------------------------------------------------
  const byId = new Map(input.recipes.map((r) => [r.id, r]));
  const placed = slots.map((s) => s.filled).filter((m): m is PlanMeal => m !== null);
  const missing = shoppingList(placed.map((m) => m.recipe_id), byId, onHand);

  // --- what it costs ---------------------------------------------------------------------------
  // Leave-one-out, because one bag of lentils feeds two dinners: a meal's cost is what the week's
  // bill drops by without it, not what its own ingredients would cost bought alone.
  let cost: PlanCost | null = null;
  if (input.priceOf) {
    const priceOf = input.priceOf;
    const priceList = (lines: MissingLine[]) => {
      let total = 0;
      const unpriced: { ingredient_id: string; reason: string }[] = [];
      for (const l of lines) {
        const answer = priceOf({ ingredient_id: l.ingredient_id, unit: l.unit, qty: l.qty });
        if ("cents" in answer) total += answer.cents;
        else unpriced.push({ ingredient_id: l.ingredient_id, reason: answer.reason });
      }
      return { total, unpriced };
    };
    const whole = priceList(missing);
    for (const meal of placed) {
      const without = shoppingList(placed.filter((m) => m !== meal).map((m) => m.recipe_id), byId, onHand);
      meal.cost_cents = whole.total - priceList(without).total;
    }
    const ceiling = input.budget_cents ?? null;
    cost = {
      shopping_cents: whole.total,
      unpriced: whole.unpriced.sort((a, b) => a.ingredient_id.localeCompare(b.ingredient_id)),
      budget_cents: ceiling,
      over_by_cents: ceiling !== null && whole.total > ceiling ? whole.total - ceiling : null,
    };
  }

  const plan_hash = hashPlan({
    start, days, perDay, budget, avoid: [...avoid].sort(), meals: placed,
    dayBudgets: dayBudgets.map((b) => `${b.day}:${b.minutes}`),
    budgetCents: input.budget_cents ?? null,
  });

  return {
    plan_id: `plan-${start}-${plan_hash.slice(0, 8)}`,
    start_date: start,
    days,
    meals_per_day: perDay,
    time_budget_min: budget,
    meals: placed,
    missing,
    unplaceable: unplaceable.sort((a, b) => a.days_to_expiry - b.days_to_expiry || a.ingredient_id.localeCompare(b.ingredient_id)),
    unfilled,
    plan_hash,
    pantry_as_of: input.now,
    cost,
    day_budgets: dayBudgets,
  };
}

/** The consolidated shopping list for a set of recipes. Pulled out of `planWeek` so that costing a
 *  plan without one of its meals is the same computation rather than a second one that could drift. */
function shoppingList(recipeIds: string[], byId: Map<string, Recipe>, onHand: Map<string, OnHand>): MissingLine[] {
  const missingMap = new Map<string, MissingLine>();
  for (const id of recipeIds) {
    const recipe = byId.get(id);
    if (!recipe) continue;
    for (const a of availability(recipe, onHand)) {
      const needsBuying = !a.have || a.enough === false;
      if (!needsBuying) continue;
      const key = `${a.ingredient_id}|${a.needed_unit}`;
      const wanted = !a.have ? a.needed_milli : a.short_milli;
      const line = missingMap.get(key) ?? {
        ingredient_id: a.ingredient_id, unit: a.needed_unit, qty: 0, qty_known: true, for_recipes: [], topping_up: a.have,
      };
      if (wanted === null) line.qty_known = false;
      else if (line.qty_known) line.qty = (line.qty ?? 0) + wanted / 1000;
      if (!line.for_recipes.includes(recipe.id)) line.for_recipes.push(recipe.id);
      line.topping_up = line.topping_up && a.have;
      missingMap.set(key, line);
    }
  }
  return [...missingMap.values()]
    .map((l) => ({ ...l, qty: l.qty_known ? l.qty : null, for_recipes: [...l.for_recipes].sort() }))
    .sort((a, b) => a.ingredient_id.localeCompare(b.ingredient_id) || a.unit.localeCompare(b.unit));
}

/**
 * The house signature.
 *
 * Over the inputs that shaped the plan and the meals that came out — nothing else, and nothing that
 * moves on its own. Two runs over the same pantry produce the same hash; a different plan with the
 * same hash is a bug worth finding. It gives Alexa+ something concrete to quote and gives a bug
 * report something to be about.
 */
export function hashPlan(parts: {
  start: string; days: number; perDay: number; budget: number | null; avoid: string[];
  meals: { day: number; meal: string; recipe_id: string }[];
  dayBudgets?: string[];
  budgetCents?: number | null;
}): string {
  const canonical = [
    `start=${parts.start}`,
    `days=${parts.days}`,
    `per_day=${parts.perDay}`,
    `budget=${parts.budget ?? "none"}`,
    `day_budgets=${(parts.dayBudgets ?? []).join(",")}`,
    `budget_cents=${parts.budgetCents ?? "none"}`,
    `avoid=${parts.avoid.join(",")}`,
    ...parts.meals.map((m) => `${m.day}/${m.meal}=${m.recipe_id}`),
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
