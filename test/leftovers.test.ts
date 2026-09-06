// Six servings, two people, four portions in the fridge. That is the loop most people actually live
// in, and until now the system deducted the lentils and forgot the dinner. These tests hold up the
// two halves: a portion is a line in the same ledger with the same reservations, and the planner
// will fill a slot with it rather than cooking something else and letting it go off.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { loadRecipes } from "../src/recipes.ts";
import { foldPantry, type PantryItem } from "../src/pantry/fold.ts";
import { buildShelfLife, isLeftover, loadShelfLife, recipeOfLeftover, rolesFromRecipes } from "../src/pantry/shelf_life.ts";
import { finish, leftoverEvent, leftoverId, startSession } from "../src/cook/session.ts";
import { planWeek } from "../src/plan/planner.ts";

const recipes = loadRecipes();
const stew = recipes.find((r) => r.id === "broad-bean-red-lentil-stew")!;
const roles = rolesFromRecipes(recipes);
const shelfLife = buildShelfLife(loadShelfLife(), (id) => roles.get(id) ?? null);
const NOW = "2026-09-07T09:00:00.000Z";

function line(ingredient_id: string, over: Partial<PantryItem> = {}): PantryItem {
  return {
    ingredient_id, unit: "portion", location: "fridge", qty: 4, qty_known: true,
    confidence: "inferred", age_days: 0,
    expires_on: null, expiry_estimated_on: null, expiry_source: "unknown", expiry_note: null, expiry_match: null,
    days_to_expiry: null, freshness: "unknown", origins: ["recipe_deduction"], last_event_ts: NOW,
    ...over,
  };
}

test("a leftover id can never be mistaken for an ingredient", () => {
  assert.equal(leftoverId("vegan-gnocchi"), "leftover-vegan-gnocchi");
  assert.ok(isLeftover("leftover-vegan-gnocchi"));
  assert.ok(!isLeftover("lemon"));
  assert.equal(recipeOfLeftover(leftoverId("vegan-gnocchi")), "vegan-gnocchi");
});

test("what goes in the fridge is inferred, because nobody counted what is in a portion", () => {
  const s = finish(startSession({ id: "s", userId: "u", recipe: stew, now: NOW }), stew, NOW);
  const event = leftoverEvent(s, stew, 4, NOW)!;
  assert.equal(event.ingredient_id, "leftover-broad-bean-red-lentil-stew");
  assert.equal(event.unit, "portion");
  assert.equal(event.qty_milli, 4000);
  assert.equal(event.confidence, "inferred");
  assert.equal(event.origin, "recipe_deduction");
  assert.equal(event.expires_on, null, "no date is invented; the shelf-life table answers for it");
});

test("nothing is recorded when nothing was put away", () => {
  const s = startSession({ id: "s", userId: "u", recipe: stew, now: NOW });
  assert.equal(leftoverEvent(s, stew, 0, NOW), null);
  assert.equal(leftoverEvent(s, stew, -2, NOW), null);
});

test("every leftover keeps the same way, and the table says so as an estimate", () => {
  const answer = shelfLife("leftover-broad-bean-red-lentil-stew", "fridge")!;
  assert.equal(answer.days, 4);
  assert.match(answer.note ?? "", /shallow container/);
  // Through the fold, where the label that keeps it honest is applied.
  const s = finish(startSession({ id: "s", userId: "u", recipe: stew, now: NOW }), stew, NOW);
  const { items } = foldPantry([leftoverEvent(s, stew, 4, NOW)!], { now: NOW, shelfLife });
  const kept = items.find((i) => isLeftover(i.ingredient_id))!;
  assert.equal(kept.expiry_source, "estimated");
  assert.equal(kept.days_to_expiry, 4);
});

test("cooked food left on the counter is a day, and the row says what to do instead of reasoning about it", () => {
  const answer = shelfLife("leftover-anything", "pantry")!;
  assert.equal(answer.days, 1);
  assert.match(answer.note ?? "", /throw it away rather than reasoning about it/);
});

// --- the planner --------------------------------------------------------------------------------

const base = { recipes, now: NOW, days: 4, meals_per_day: 1 };

test("a portion in the fridge fills a slot, and nothing is cooked or bought for it", () => {
  const plan = planWeek({ ...base, pantry: [line(leftoverId("vegan-gnocchi"), { qty: 1, days_to_expiry: 3 })] });
  const meal = plan.meals.find((m) => m.from_leftovers);
  assert.ok(meal, "the dinner that already exists is used");
  assert.equal(meal.why_code, "leftovers");
  assert.equal(meal.cost_cents, 0);
  assert.match(meal.title, /from the fridge/);
  assert.match(meal.why, /a portion of it in the fridge/);
  assert.ok(!plan.missing.some((l) => l.for_recipes.includes("vegan-gnocchi")), "nothing is shopped for a meal already cooked");
});

test("four portions are four dinners, not one enormous one", () => {
  const plan = planWeek({ ...base, days: 5, pantry: [line(leftoverId("vegan-gnocchi"), { qty: 4, days_to_expiry: 4 })] });
  assert.equal(plan.meals.filter((m) => m.from_leftovers).length, 4);
  assert.equal(plan.meals.length, 5, "and the fifth night is cooked");
});

test("leftovers go on the last day they are still good, like anything else with a date", () => {
  const plan = planWeek({ ...base, pantry: [line(leftoverId("vegan-gnocchi"), { qty: 1, days_to_expiry: 2 })] });
  const meal = plan.meals.find((m) => m.from_leftovers)!;
  assert.equal(meal.day, 3, "two days left means day three is the last one");
});

test("more portions than there are meals is said, not silently wasted", () => {
  const plan = planWeek({ ...base, days: 2, pantry: [line(leftoverId("vegan-gnocchi"), { qty: 5, days_to_expiry: 4 })] });
  const lost = plan.unplaceable.find((u) => isLeftover(u.ingredient_id));
  assert.ok(lost, "the portions with no meal left are named");
  assert.match(lost.reason, /3 portions with no meal left/);
});

test("the recipe is not cooked again in a week you are already eating it", () => {
  const plan = planWeek({ ...base, days: 4, pantry: [line(leftoverId("vegan-gnocchi"), { qty: 1, days_to_expiry: 3 })] });
  const cooked = plan.meals.filter((m) => !m.from_leftovers).map((m) => m.recipe_id);
  assert.ok(!cooked.includes("vegan-gnocchi"));
});

test("a leftover line is never treated as an ingredient to cook with", () => {
  const plan = planWeek({ ...base, pantry: [line(leftoverId("vegan-gnocchi"), { qty: 1, days_to_expiry: 1 })] });
  for (const m of plan.meals.filter((x) => !x.from_leftovers)) {
    assert.ok(!m.uses_expiring.some((e) => isLeftover(e.ingredient_id)), `${m.recipe_id} claims to cook with leftovers`);
  }
});

test("a portion already past its best is reported rather than served", () => {
  const plan = planWeek({
    ...base,
    pantry: [line(leftoverId("vegan-gnocchi"), { qty: 2, days_to_expiry: -1, expiry_source: "estimated" })],
  });
  assert.equal(plan.meals.filter((m) => m.from_leftovers).length, 0);
  const lost = plan.unplaceable.find((u) => isLeftover(u.ingredient_id))!;
  assert.match(lost.reason, /past its best already/);
});
