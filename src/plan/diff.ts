// Why the week changed.
//
// The plan already carries a hash and a reason per meal. What it never had was the subtraction:
// somebody eats the tofu on Wednesday, asks for the week again, and gets a different Thursday with
// no account of why. A plan that cannot explain its own change is back to being a suggestion.
//
// This file is a pure diff over two `PlanResult`s and it is deliberately incurious. It reports what
// the two objects witness — a slot that changed hands, a recipe that moved, an ingredient that is on
// a deadline now and was not before, a line that appeared on the shopping list — and it quotes the
// planner's own sentence for the reason. It never reasons about *why* the pantry changed, because
// neither plan knows that, and a plausible story about a kitchen nobody watched is exactly the kind
// of thing this project refuses to produce.
import type { MissingLine, PlanMeal, PlanResult } from "./planner.ts";

export type SlotChange =
  | { kind: "unchanged"; day: number; date: string; meal: string; recipe_id: string; title: string }
  | { kind: "replaced"; day: number; date: string; meal: string; from: MealRef; to: MealRef; because: string }
  | { kind: "moved"; recipe_id: string; title: string; from_day: number; to_day: number; from_date: string; to_date: string; meal: string; because: string }
  | { kind: "added"; day: number; date: string; meal: string; to: MealRef; because: string }
  | { kind: "dropped"; day: number; date: string; meal: string; from: MealRef };

export type MealRef = { recipe_id: string; title: string; why: string; why_code: string };

export type UrgencyChange = { ingredient_id: string; days_to_expiry: number | null; now_urgent: boolean };

export type PlanDiff = {
  from: PlanRef;
  to: PlanRef;
  /** Same meals in the same slots. The hash settles it; the changes list is empty. */
  identical: boolean;
  changes: SlotChange[];
  /** What was asked for differently. Facts about the two requests, not inferences. */
  input_changes: string[];
  /** Food that is on a deadline in one plan and not the other. */
  urgency_changes: UrgencyChange[];
  shopping: { added: MissingLine[]; removed: MissingLine[] };
};

export type PlanRef = { plan_id: string; plan_hash: string; start_date: string; days: number; meals_per_day: number };

function ref(plan: PlanResult): PlanRef {
  return { plan_id: plan.plan_id, plan_hash: plan.plan_hash, start_date: plan.start_date, days: plan.days, meals_per_day: plan.meals_per_day };
}

function mealRef(m: PlanMeal): MealRef {
  return { recipe_id: m.recipe_id, title: m.title, why: m.why, why_code: m.why_code };
}

/** A slot is a calendar day and a meal, not a day number. Replanning on Wednesday shifts every day
 *  number by one, and "Thursday" has to keep meaning Thursday or the diff is nonsense. */
const slotKey = (m: { date: string; meal: string }) => `${m.date}/${m.meal}`;

/**
 * What changed between two plans.
 *
 * Slots are matched on (date, meal). A recipe that appears in both plans at different slots is
 * reported once, as a move, rather than twice as a drop and an add — that is the difference between
 * "Thursday moved to Friday" and a paragraph nobody can follow.
 */
export function diffPlans(from: PlanResult, to: PlanResult): PlanDiff {
  const fromBySlot = new Map(from.meals.map((m) => [slotKey(m), m]));
  const toBySlot = new Map(to.meals.map((m) => [slotKey(m), m]));
  const fromByRecipe = new Map(from.meals.map((m) => [m.recipe_id, m]));
  const toByRecipe = new Map(to.meals.map((m) => [m.recipe_id, m]));

  const changes: SlotChange[] = [];
  const reportedMoves = new Set<string>();

  // A recipe in both plans, in a different slot, is one move rather than a drop and an add.
  for (const m of to.meals) {
    const before = fromByRecipe.get(m.recipe_id);
    if (!before || slotKey(before) === slotKey(m)) continue;
    reportedMoves.add(m.recipe_id);
    changes.push({
      kind: "moved",
      recipe_id: m.recipe_id,
      title: m.title,
      from_day: before.day,
      to_day: m.day,
      from_date: before.date,
      to_date: m.date,
      meal: m.meal,
      // The planner's own sentence for where it ended up. Nothing is composed here.
      because: m.why,
    });
  }

  const slots = [...new Set([...fromBySlot.keys(), ...toBySlot.keys()])].sort();

  for (const key of slots) {
    const before = fromBySlot.get(key);
    const after = toBySlot.get(key);
    if (before && after) {
      if (before.recipe_id === after.recipe_id) {
        changes.push({ kind: "unchanged", day: after.day, date: after.date, meal: after.meal, recipe_id: after.recipe_id, title: after.title });
      } else if (!(reportedMoves.has(after.recipe_id) && reportedMoves.has(before.recipe_id))) {
        changes.push({ kind: "replaced", day: after.day, date: after.date, meal: after.meal, from: mealRef(before), to: mealRef(after), because: after.why });
      }
      continue;
    }
    if (after && !reportedMoves.has(after.recipe_id)) {
      changes.push({ kind: "added", day: after.day, date: after.date, meal: after.meal, to: mealRef(after), because: after.why });
      continue;
    }
    if (before && !toByRecipe.has(before.recipe_id)) {
      changes.push({ kind: "dropped", day: before.day, date: before.date, meal: before.meal, from: mealRef(before) });
    }
  }

  // What was asked for. These are facts about the two requests and need no interpretation.
  const input_changes: string[] = [];
  if (from.start_date !== to.start_date) input_changes.push(`the week now starts on ${to.start_date} instead of ${from.start_date}`);
  if (from.days !== to.days) input_changes.push(`${to.days} days instead of ${from.days}`);
  if (from.meals_per_day !== to.meals_per_day) input_changes.push(`${to.meals_per_day} meals a day instead of ${from.meals_per_day}`);
  if (from.time_budget_min !== to.time_budget_min) {
    input_changes.push(
      to.time_budget_min === null
        ? "no time limit any more"
        : from.time_budget_min === null
          ? `a ${to.time_budget_min} minute limit, where there was none`
          : `${to.time_budget_min} minutes a meal instead of ${from.time_budget_min}`,
    );
  }

  // Food on a deadline in one plan and not the other. Read off `uses_expiring`, which the planner
  // filled in; nothing here decides what is urgent.
  const urgencyOf = (plan: PlanResult) => {
    const map = new Map<string, number>();
    for (const m of plan.meals) for (const e of m.uses_expiring) map.set(e.ingredient_id, e.days_to_expiry);
    for (const u of plan.unplaceable) map.set(u.ingredient_id, u.days_to_expiry);
    return map;
  };
  const before = urgencyOf(from);
  const after = urgencyOf(to);
  const urgency_changes: UrgencyChange[] = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (before.has(id) === after.has(id)) continue;
    urgency_changes.push({ ingredient_id: id, days_to_expiry: after.get(id) ?? null, now_urgent: after.has(id) });
  }

  const lineKey = (l: MissingLine) => `${l.ingredient_id}|${l.unit}`;
  const fromShopping = new Map(from.missing.map((l) => [lineKey(l), l]));
  const toShopping = new Map(to.missing.map((l) => [lineKey(l), l]));
  const shopping = {
    added: to.missing.filter((l) => !fromShopping.has(lineKey(l))),
    removed: from.missing.filter((l) => !toShopping.has(lineKey(l))),
  };

  return {
    from: ref(from),
    to: ref(to),
    identical: from.plan_hash === to.plan_hash,
    changes,
    input_changes,
    urgency_changes,
    shopping,
  };
}

/** The changes that are worth saying out loud, in the order a person would want them. */
export function movedChanges(diff: PlanDiff): SlotChange[] {
  const rank: Record<SlotChange["kind"], number> = { moved: 0, replaced: 1, added: 2, dropped: 3, unchanged: 4 };
  return diff.changes.filter((c) => c.kind !== "unchanged").sort((a, b) => rank[a.kind] - rank[b.kind]);
}

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function weekdayOf(date: string): string {
  return WEEKDAY[new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay()];
}

/** One sentence per change, in the planner's own words. */
export function describe(change: SlotChange): string {
  switch (change.kind) {
    case "unchanged":
      return `${change.title} is still on ${change.meal}.`;
    case "moved":
      return `${change.title} moved from ${weekdayOf(change.from_date)} to ${weekdayOf(change.to_date)}, because ${change.because}.`;
    case "replaced":
      return `${weekdayOf(change.date)} was ${change.from.title} and is now ${change.to.title}, because ${change.because}.`;
    case "added":
      return `${weekdayOf(change.date)} has ${change.to.title} now, where nothing was planned, because ${change.because}.`;
    case "dropped":
      return `${weekdayOf(change.date)} has nothing planned any more; it was ${change.from.title}.`;
  }
}
