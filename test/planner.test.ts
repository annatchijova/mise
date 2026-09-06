// The planner's one promise is that the same pantry produces the same week. These tests hold that
// promise up, and hold up the three claims the plan makes to the person: the tofu really is on
// Thursday because it expires Friday, the shopping list really is what is missing, and food that
// cannot be saved is named rather than quietly dropped.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { loadRecipes } from "../src/recipes.ts";
import type { PantryItem } from "../src/pantry/fold.ts";
import { hashPlan, planWeek, primaryProtein, urgencyPoints } from "../src/plan/planner.ts";

const recipes = loadRecipes();
const NOW = "2026-09-07T09:00:00.000Z"; // a Monday

/** A pantry line, with the fields the planner actually reads. */
function have(ingredient_id: string, over: Partial<PantryItem> = {}): PantryItem {
  return {
    ingredient_id,
    unit: "g",
    location: "pantry",
    qty: 1000,
    qty_known: true,
    confidence: "confirmed",
    age_days: 0,
    expires_on: null,
    expiry_estimated_on: null,
    expiry_source: "unknown",
    expiry_note: null,
    expiry_match: null,
    days_to_expiry: null,
    freshness: "unknown",
    origins: ["voice"],
    last_event_ts: NOW,
    ...over,
  };
}

const base = { recipes, now: NOW, days: 4, meals_per_day: 1 };

test("the same pantry produces the same week, down to the hash", () => {
  const pantry = [have("tofu", { unit: "pc", qty: 2, days_to_expiry: 3, expires_on: "2026-09-11" }), have("onion", { unit: "pc", qty: 3 })];
  const a = planWeek({ ...base, pantry });
  const b = planWeek({ ...base, pantry: [...pantry].reverse() });
  assert.equal(b.plan_hash, a.plan_hash, "the order the pantry came back in is not part of the plan");
  assert.deepEqual(b.meals.map((m) => m.recipe_id), a.meals.map((m) => m.recipe_id));
});

test("a different week is a different hash", () => {
  const pantry = [have("tofu", { unit: "pc", qty: 2 })];
  const four = planWeek({ ...base, pantry });
  const five = planWeek({ ...base, pantry, days: 5 });
  assert.notEqual(five.plan_hash, four.plan_hash);
});

test("what expires soonest is scheduled on the last day it is still good, not the first", () => {
  // Tofu expires Friday. Planning Monday through Thursday, Thursday is the last usable slot.
  const pantry = [
    have("tofu", { unit: "pc", qty: 2, days_to_expiry: 4, expires_on: "2026-09-11" }),
    have("onion", { unit: "pc", qty: 4 }),
    have("garlic", { unit: "clove", qty: 6 }),
  ];
  const plan = planWeek({ ...base, pantry });
  const tofuMeal = plan.meals.find((m) => m.uses_expiring.some((e) => e.ingredient_id === "tofu"));
  assert.ok(tofuMeal, "something in the week uses the tofu");
  assert.equal(tofuMeal.day, 4, "the last day before it goes off, leaving the early days free");
  assert.equal(tofuMeal.why_code, "expiring");
  assert.match(tofuMeal.why, /tofu/);
});

test("two things going off get the tighter deadline first", () => {
  const pantry = [
    have("tofu", { unit: "pc", qty: 2, days_to_expiry: 3, expires_on: "2026-09-10" }),
    have("spinach", { unit: "bunch", qty: 1, days_to_expiry: 0, expires_on: "2026-09-07" }),
  ];
  const plan = planWeek({ ...base, pantry });
  const spinach = plan.meals.find((m) => m.uses_expiring.some((e) => e.ingredient_id === "spinach"));
  const tofu = plan.meals.find((m) => m.uses_expiring.some((e) => e.ingredient_id === "tofu"));
  assert.ok(spinach && tofu);
  assert.ok(spinach.day <= tofu.day, "the spinach that goes off today is not scheduled after the tofu");
  assert.equal(spinach.day, 1, "and it is eaten today, because today is all it has");
});

test("food that cannot be saved is named, not silently dropped", () => {
  const pantry = [have("kaffir-lime-leaf", { unit: "pc", qty: 2, days_to_expiry: -1, expires_on: "2026-09-06" })];
  const plan = planWeek({ ...base, pantry });
  const lost = plan.unplaceable.find((u) => u.ingredient_id === "kaffir-lime-leaf");
  assert.ok(lost, "the plan says what it could not place");
  assert.match(lost.reason, /past its date/);
});

test("the time budget is a wall, not a preference", () => {
  const plan = planWeek({ ...base, pantry: [have("onion", { unit: "pc", qty: 3 })], time_budget_min: 20 });
  for (const m of plan.meals) assert.ok(m.minutes <= 20, `${m.recipe_id} takes ${m.minutes} minutes`);
});

test("an ingredient the customer said to avoid appears in no meal of the week", () => {
  const plan = planWeek({ ...base, pantry: [have("onion", { unit: "pc", qty: 5 })], days: 6, avoid: ["onion"] });
  const byId = new Map(recipes.map((r) => [r.id, r]));
  for (const m of plan.meals) {
    assert.ok(!byId.get(m.recipe_id)!.ingredients.some((i) => i.id === "onion"), `${m.recipe_id} has onion in it`);
  }
});

test("no recipe is planned twice in the same week", () => {
  const plan = planWeek({ ...base, pantry: [have("onion", { unit: "pc", qty: 5 })], days: 10, meals_per_day: 2 });
  const ids = plan.meals.map((m) => m.recipe_id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the same protein does not land in two meals running", () => {
  const plan = planWeek({ ...base, pantry: [have("red-lentil", { qty: 2000 }), have("onion", { unit: "pc", qty: 6 })], days: 6 });
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const proteins = plan.meals.map((m) => primaryProtein(byId.get(m.recipe_id)!));
  for (let i = 1; i < proteins.length; i++) {
    if (proteins[i] === null) continue;
    assert.notEqual(proteins[i], proteins[i - 1], `${proteins[i]} twice running, on days ${i} and ${i + 1}`);
  }
});

test("the shopping list counts what is short, not only what is absent", () => {
  // 100 g of red lentils against a recipe that wants 250: the difference is what goes on the list.
  const plan = planWeek({
    ...base,
    days: 1,
    pantry: [have("red-lentil", { qty: 100 })],
    recipes: recipes.filter((r) => r.id === "broad-bean-red-lentil-stew"),
  });
  const lentils = plan.missing.find((l) => l.ingredient_id === "red-lentil");
  assert.ok(lentils, "a shortfall is still a shopping item");
  assert.equal(lentils.topping_up, true, "and it is marked as a top-up, not a purchase from nothing");
  assert.equal(lentils.qty, 150, "250 needed minus the 100 already there");
});

test("an amount no recipe ever stated leaves the shopping line honest instead of guessed", () => {
  const plan = planWeek({ ...base, days: 1, pantry: [], recipes: recipes.filter((r) => r.id === "broad-bean-red-lentil-stew") });
  const water = plan.missing.find((l) => l.ingredient_id === "water");
  assert.ok(water);
  assert.equal(water.qty_known, false);
  assert.equal(water.qty, null, "the list says 'water', not a number nobody wrote down");
});

test("urgency points rise as the date gets closer and never reach zero while the food is good", () => {
  assert.ok(urgencyPoints(0) > urgencyPoints(3));
  assert.ok(urgencyPoints(30) > 0, "food a month out still counts for something");
  assert.equal(urgencyPoints(-1), 0, "food already past its date counts for nothing");
});

test("the hash covers the inputs, not only the meals", () => {
  const meals = [{ day: 1, meal: "dinner", recipe_id: "vegan-gnocchi" }];
  const a = hashPlan({ start: "2026-09-07", days: 4, perDay: 1, budget: 40, avoid: [], meals });
  const b = hashPlan({ start: "2026-09-07", days: 4, perDay: 1, budget: 30, avoid: [], meals });
  assert.notEqual(a, b, "the same meals asked for under a different budget are a different plan");
});

test("an empty pantry still produces a week, and says the meals are shopping nights", () => {
  const plan = planWeek({ ...base, pantry: [] });
  assert.equal(plan.meals.length, 4);
  assert.ok(plan.missing.length > 0);
  assert.ok(plan.meals.every((m) => m.why.length > 0), "every meal carries a reason, even a thin one");
});

test("a week longer than the recipe book leaves the extra slots empty and says why", () => {
  const three = recipes.slice(0, 3);
  const plan = planWeek({ ...base, recipes: three, pantry: [], days: 5 });
  assert.equal(plan.meals.length, 3);
  assert.equal(plan.unfilled.length, 2);
  assert.match(plan.unfilled[0].reason, /already been planned/);
});

// --- per-day limits and money -------------------------------------------------------------------

test("a day with its own limit gets a meal under that limit, and the rest keep the weekly one", () => {
  const plan = planWeek({
    ...base, days: 4, pantry: [have("onion", { unit: "pc", qty: 5 })],
    time_budget_min: 60,
    day_budgets: [{ day: 3, minutes: 15 }],
  });
  const wednesday = plan.meals.find((m) => m.day === 3);
  assert.ok(wednesday, "the tight day is still filled");
  assert.ok(wednesday.minutes <= 15, `${wednesday.recipe_id} takes ${wednesday.minutes} minutes on a 15 minute day`);
  for (const m of plan.meals) assert.ok(m.minutes <= (m.day === 3 ? 15 : 60), `${m.recipe_id} on day ${m.day}`);
  assert.deepEqual(plan.day_budgets.find((b) => b.day === 3), { day: 3, minutes: 15 });
});

test("a day limit nothing fits leaves that day empty and quotes the limit that emptied it", () => {
  const plan = planWeek({
    ...base, days: 2, pantry: [],
    recipes: recipes.filter((r) => r.minutes >= 40),
    day_budgets: [{ day: 2, minutes: 5 }],
  });
  const gap = plan.unfilled.find((u) => u.day === 2);
  assert.ok(gap, "the day nothing fits is reported, not silently filled with something too long");
  assert.match(gap.reason, /under 5 minutes/);
});

test("the plan hash covers the per-day limits, so two different weeks cannot share one", () => {
  const pantry = [have("onion", { unit: "pc", qty: 5 })];
  const flat = planWeek({ ...base, pantry, time_budget_min: 60 });
  const tight = planWeek({ ...base, pantry, time_budget_min: 60, day_budgets: [{ day: 2, minutes: 15 }] });
  assert.notEqual(tight.plan_hash, flat.plan_hash);
});

test("a meal's cost is what the week's bill drops by without it, not what its ingredients cost alone", () => {
  // Two dinners that both want lentils. One bag covers both, so the second one is not charged for it.
  const priceOf = (want: { ingredient_id: string; qty: number | null }) =>
    want.ingredient_id === "red-lentil" ? { cents: 289 } : { cents: 100 };
  const plan = planWeek({
    ...base, days: 2, pantry: [],
    recipes: recipes.filter((r) => r.ingredients.some((i) => i.id === "red-lentil")).slice(0, 2),
    priceOf,
  });
  assert.ok(plan.cost !== null);
  const charged = plan.meals.reduce((sum, m) => sum + (m.cost_cents ?? 0), 0);
  assert.ok(charged <= plan.cost.shopping_cents, "the marginal costs cannot add up to more than the bill");
});

test("what the shop cannot price is named with the reason, and left out of the total", () => {
  const priceOf = (want: { ingredient_id: string }) =>
    want.ingredient_id === "water" ? { reason: "the shop does not stock it" } : { cents: 200 };
  const plan = planWeek({ ...base, days: 1, pantry: [], recipes: recipes.filter((r) => r.id === "broad-bean-red-lentil-stew"), priceOf });
  assert.ok(plan.cost !== null);
  const water = plan.cost.unpriced.find((u) => u.ingredient_id === "water");
  assert.ok(water, "an unpriceable line is named");
  assert.equal(water.reason, "the shop does not stock it", "with the shop's own reason, not a shrug");
  assert.equal(plan.cost.shopping_cents % 200, 0, "and it contributes nothing to the total");
});

test("a plan that comes out over its ceiling says so rather than pretending it met it", () => {
  const plan = planWeek({
    ...base, days: 2, pantry: [], recipes: recipes.slice(0, 6),
    priceOf: () => ({ cents: 1000 }),
    budget_cents: 500,
  });
  assert.ok(plan.cost !== null);
  assert.ok(plan.cost.over_by_cents !== null && plan.cost.over_by_cents > 0, "the overrun is stated");
  assert.equal(plan.cost.shopping_cents - plan.cost.budget_cents!, plan.cost.over_by_cents);
});

test("with no price list there is simply no money in the plan", () => {
  const plan = planWeek({ ...base, pantry: [] });
  assert.equal(plan.cost, null);
  for (const m of plan.meals) assert.equal(m.cost_cents, null);
});
