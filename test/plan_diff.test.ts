// The diff exists so a plan can explain its own change. These tests hold up the two things that
// makes true: a recipe that moved is reported once as a move rather than twice as a drop and an
// add, and every reason given is one the planner itself recorded — the diff never explains the
// kitchen, because neither plan watched it.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { loadRecipes } from "../src/recipes.ts";
import type { PantryItem } from "../src/pantry/fold.ts";
import { planWeek } from "../src/plan/planner.ts";
import { describe, diffPlans, movedChanges } from "../src/plan/diff.ts";

const recipes = loadRecipes();
const NOW = "2026-09-07T09:00:00.000Z"; // a Monday

function have(ingredient_id: string, over: Partial<PantryItem> = {}): PantryItem {
  return {
    ingredient_id, unit: "g", location: "pantry", qty: 1000, qty_known: true,
    confidence: "confirmed", age_days: 0,
    expires_on: null, expiry_estimated_on: null, expiry_source: "unknown", expiry_note: null, expiry_match: null,
    days_to_expiry: null, freshness: "unknown", origins: ["voice"], last_event_ts: NOW,
    ...over,
  };
}

const base = { recipes, now: NOW, days: 4, meals_per_day: 1 };
const tofu = (days: number) => have("tofu", { unit: "pc", qty: 2, days_to_expiry: days, expires_on: "2026-09-11", expiry_source: "stated" as const });

test("the same plan twice is identical, and says so rather than listing four unchanged days", () => {
  const pantry = [tofu(4), have("onion", { unit: "pc", qty: 4 })];
  const diff = diffPlans(planWeek({ ...base, pantry }), planWeek({ ...base, pantry }));
  assert.equal(diff.identical, true);
  assert.equal(movedChanges(diff).length, 0);
});

/** Two plans built by hand, so a move is a move and not whatever the scorer happened to do. */
function planOf(meals: { day: number; date: string; recipe_id: string; why?: string }[], over: Record<string, unknown> = {}) {
  return {
    plan_id: `plan-${meals.map((m) => m.recipe_id).join("-")}`,
    start_date: "2026-09-07",
    days: 3,
    meals_per_day: 1,
    time_budget_min: null,
    meals: meals.map((m) => ({
      day: m.day, date: m.date, meal: "dinner" as const,
      recipe_id: m.recipe_id, title: m.recipe_id, minutes: 30,
      why_code: "pantry" as const, why: m.why ?? "is what the kitchen had",
      uses_expiring: [], missing: [], cost_cents: null, from_leftovers: false,
    })),
    missing: [], unplaceable: [], unfilled: [], cost: null, day_budgets: [],
    plan_hash: meals.map((m) => `${m.date}=${m.recipe_id}`).join("|"),
    pantry_as_of: NOW,
    ...over,
  };
}

test("a recipe that changed day is one move, not a drop and an add", () => {
  const before = planOf([
    { day: 1, date: "2026-09-07", recipe_id: "gnocchi" },
    { day: 2, date: "2026-09-08", recipe_id: "borscht" },
  ]);
  const after = planOf([
    { day: 1, date: "2026-09-07", recipe_id: "borscht", why: "uses the beetroot, which goes off tomorrow" },
    { day: 2, date: "2026-09-08", recipe_id: "gnocchi" },
  ]);
  const changes = movedChanges(diffPlans(before, after));
  assert.equal(changes.length, 2, "two recipes swapped days: two moves and nothing else");
  assert.ok(changes.every((c) => c.kind === "moved"), `got ${changes.map((c) => c.kind).join(", ")}`);
  const borscht = changes.find((c) => c.kind === "moved" && c.recipe_id === "borscht")!;
  assert.equal(borscht.kind === "moved" && borscht.from_date, "2026-09-08");
  assert.equal(borscht.kind === "moved" && borscht.to_date, "2026-09-07");
});

test("a recipe that left the week is dropped, and one that arrived is added", () => {
  const before = planOf([{ day: 1, date: "2026-09-07", recipe_id: "gnocchi" }]);
  const after = planOf([{ day: 1, date: "2026-09-07", recipe_id: "borscht" }]);
  const changes = movedChanges(diffPlans(before, after));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "replaced", "one slot changing hands is a replacement, not a drop plus an add");
});

test("every reason in the diff is a sentence the planner wrote, not one the diff composed", () => {
  const before = planWeek({ ...base, pantry: [have("onion", { unit: "pc", qty: 4 })] });
  const after = planWeek({ ...base, pantry: [tofu(4), have("onion", { unit: "pc", qty: 4 })] });
  const diff = diffPlans(before, after);
  const reasons = movedChanges(diff)
    .map((c) => ("because" in c ? c.because : null))
    .filter((r): r is string => r !== null);
  const plannerReasons = new Set(after.meals.map((m) => m.why));
  for (const r of reasons) assert.ok(plannerReasons.has(r), `"${r}" is not one of the plan's own reasons`);
});

test("a slot is a date and a meal, so replanning a day later does not report every day as changed", () => {
  const pantry = [have("onion", { unit: "pc", qty: 4 }), have("potato", { unit: "pc", qty: 5 })];
  const monday = planWeek({ ...base, pantry, days: 5, start_date: "2026-09-07" });
  const tuesday = planWeek({ ...base, pantry, days: 4, start_date: "2026-09-08" });
  const diff = diffPlans(monday, tuesday);
  // Tuesday through Friday exist in both. Whatever else moved, Monday is dropped exactly once.
  const dropped = diff.changes.filter((c) => c.kind === "dropped");
  assert.ok(dropped.every((c) => c.date === "2026-09-07"), "only the day that left the window is dropped");
  assert.ok(diff.input_changes.some((c) => /starts on 2026-09-08/.test(c)));
});

test("asking for a different week is reported as something you asked for, not as something that happened", () => {
  const pantry = [have("onion", { unit: "pc", qty: 4 })];
  const short = planWeek({ ...base, pantry, time_budget_min: 60 });
  const shorter = planWeek({ ...base, pantry, time_budget_min: 20 });
  const diff = diffPlans(short, shorter);
  assert.deepEqual(diff.input_changes, ["20 minutes a meal instead of 60"]);
});

test("food that is on a deadline now and was not before is named", () => {
  const pantry = [have("onion", { unit: "pc", qty: 4 })];
  const before = planWeek({ ...base, pantry });
  const after = planWeek({ ...base, pantry: [...pantry, tofu(3)] });
  const diff = diffPlans(before, after);
  const tofuChange = diff.urgency_changes.find((u) => u.ingredient_id === "tofu");
  assert.ok(tofuChange, "the tofu's new deadline is reported");
  assert.equal(tofuChange.now_urgent, true);
});

test("the shopping list's own diff is part of it", () => {
  const before = planWeek({ ...base, days: 1, pantry: [], recipes: recipes.filter((r) => r.id === "vegan-gnocchi") });
  const after = planWeek({ ...base, days: 1, pantry: [have("potato", { unit: "pc", qty: 4 })], recipes: recipes.filter((r) => r.id === "vegan-gnocchi") });
  const diff = diffPlans(before, after);
  assert.ok(diff.shopping.removed.some((l) => l.ingredient_id === "potato"), "the potatoes came off the list");
  assert.equal(diff.shopping.added.length, 0);
});

test("every reason a plan writes reads correctly after the word 'because'", () => {
  // The diff quotes the planner rather than rewording it, which only works if the planner writes
  // clauses. A reason that has to be reworded to be said is a reason somebody else wrote.
  const plan = planWeek({ ...base, pantry: [tofu(2), have("onion", { unit: "pc", qty: 4 })] });
  for (const m of plan.meals) {
    const sentence = `Thursday is ${m.title}, because ${m.why}.`;
    assert.ok(!/because it \d/.test(sentence), `"${sentence}" does not parse`);
    assert.ok(!/because uses/.test(sentence), `"${sentence}" does not parse`);
  }
});

test("every change turns into one readable sentence", () => {
  const before = planWeek({ ...base, pantry: [have("onion", { unit: "pc", qty: 4 })] });
  const after = planWeek({ ...base, pantry: [tofu(4), have("onion", { unit: "pc", qty: 4 })] });
  for (const c of movedChanges(diffPlans(before, after))) {
    const sentence = describe(c);
    assert.ok(sentence.endsWith("."), `"${sentence}" is not a sentence`);
    assert.ok(sentence.length > 20, `"${sentence}" says nothing`);
    assert.ok(!/undefined|NaN|\[object/.test(sentence), `"${sentence}" leaked a value`);
  }
});
