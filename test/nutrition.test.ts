// The dishonest version of this feature is easy: sum what you know and print a number. These tests
// are almost all about the ways this one refuses to do that — and about the one weaker claim it will
// make instead, which is a floor rather than a guess.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  type NutritionRow,
  type NutritionTable,
  indexNutrition,
  ingredientSentence,
  loadNutrition,
  nutritionOf,
  nutritionSentence,
  weigh,
} from "../src/nutrition.ts";
import { type Ingredient, type Recipe, loadRecipes } from "../src/recipes.ts";

const TABLE = loadNutrition();
const INDEX = indexNutrition(TABLE);

const ing = (over: Partial<Ingredient> = {}): Ingredient => ({
  id: "chickpea", name_es: "garbanzos", note: null, role: "protein", technique: "simmer",
  qty: 100, unit: "g", qty_source: "stated", ...over,
});

const dish = (ingredients: Ingredient[], serves = 2): Recipe => ({
  id: "test-dish", title: "Test", title_es: "Prueba",
  source: { book: "none", locator: "-", original_text: "-" },
  category: "main", diet: { vegan: true, gluten_free: true, notes: [] },
  minutes: 30, minutes_source: "stated", serves, serves_source: "stated",
  ingredients, steps: [], review: {},
});

const report = (ingredients: Ingredient[], serves = 2, servings?: number) =>
  nutritionOf(dish(ingredients, serves), INDEX, TABLE, servings);

// --- weighing -----------------------------------------------------------------------------------

test("a stated weight is weighed, and a kilo is a thousand grams", () => {
  assert.deepEqual(weigh(ing({ qty: 250, unit: "g" }), INDEX.get("chickpea")), { grams: 250, how: "weighed" });
  assert.deepEqual(weigh(ing({ qty: 2, unit: "kg" }), INDEX.get("chickpea")), { grams: 2000, how: "weighed" });
});

test("a volume is weighed only for a liquid we know the weight of", () => {
  assert.deepEqual(weigh(ing({ id: "olive-oil", qty: 100, unit: "ml" }), INDEX.get("olive-oil")), { grams: 92, how: "weighed" });
  // A solid measured in millilitres has no density here, and one is not invented.
  assert.deepEqual(weigh(ing({ id: "chickpea", qty: 100, unit: "ml" }), INDEX.get("chickpea")), { grams: null, why: "no_measure" });
});

test("a curated measure says so, so a reference figure is never mixed in with a weight", () => {
  const w = weigh(ing({ id: "onion", qty: 2, unit: "pc" }), INDEX.get("onion"));
  assert.deepEqual(w, { grams: 300, how: "measured" }, "a medium onion is 150 g, which is somebody's judgment");
});

test("the two ways of not knowing are kept apart, because different people fix them", () => {
  // One is a fact about the recipe. The other is a fact about our table.
  assert.deepEqual(weigh(ing({ qty: null, unit: "to_taste" }), INDEX.get("chickpea")), { grams: null, why: "no_amount" });
  assert.deepEqual(weigh(ing({ id: "tofu", qty: 1, unit: "pc" }), INDEX.get("tofu")), { grams: null, why: "no_measure" });
});

test("an ingredient with no row is never estimated from one that looks similar", () => {
  assert.equal(INDEX.get("cashew-cream"), undefined, "a prepared food whose figures depend on the brand");
  const r = report([ing({ id: "cashew-cream", qty: 200, unit: "g" })]);
  assert.deepEqual(r.gaps.map((g) => g.reason), ["no_data"]);
  assert.equal(r.per_serving, null);
});

// --- the refusal --------------------------------------------------------------------------------

test("one gap is enough to withhold a total: a threshold would only be a smaller lie", () => {
  const r = report([ing({ qty: 400, unit: "g" }), ing({ id: "cashew-cream", qty: null, unit: "to_taste" })]);
  assert.equal(r.per_serving, null, "no total with a hole in it");
  assert.equal(r.total, null);
  assert.equal(r.covered, 1);
  assert.equal(r.of, 2);
});

test("what it can account for is offered as a floor, which is a fact rather than a guess", () => {
  const r = report([ing({ qty: 400, unit: "g" }), ing({ id: "pine-mushroom", qty: null, unit: "to_taste" })]);
  assert.ok(r.at_least, "the floor survives the refusal");
  assert.equal(r.at_least?.kcal, Math.round((364 * 4) / 2), "400 g of chickpeas over two servings");
  assert.match(nutritionSentence(r), /At least .* and I mean at least/);
  assert.match(nutritionSentence(r), /can only add to it/);
});

test("the floor never exceeds the total, on a dish where both exist", () => {
  const whole = [ing({ qty: 400, unit: "g" }), ing({ id: "olive-oil", qty: 2, unit: "tbsp" })];
  const full = report(whole);
  const partial = report([...whole, ing({ id: "pine-mushroom", qty: null, unit: "to_taste" })]);
  assert.ok(full.per_serving);
  assert.ok(partial.at_least);
  assert.equal(full.per_serving?.kcal, partial.at_least?.kcal, "the gap adds nothing to what is known");
  assert.ok((partial.at_least?.kcal ?? 0) <= (full.per_serving?.kcal ?? 0));
});

test("nothing counted at all means no figure, not a floor of zero", () => {
  const r = report([ing({ qty: null, unit: "to_taste" }), ing({ id: "onion", qty: null, unit: "to_taste" })]);
  assert.equal(r.at_least, null, "zero calories is a claim, and a wrong one");
  assert.match(nutritionSentence(r), /cannot put a figure on that one/);
});

// --- the two exemptions, which are different in kind ---------------------------------------------

test("a trace ingredient is skipped only when the recipe measures it as one", () => {
  const pinch = report([ing({ qty: 400, unit: "g" }), ing({ id: "cumin", qty: null, unit: "to_taste" })]);
  assert.deepEqual(pinch.ignored_as_trace, ["cumin"]);
  assert.ok(pinch.per_serving, "a pinch of cumin does not stop a dish being added up");

  // Somebody writing 200 g of cumin means it, and a curator's judgment about a pinch does not cover them.
  const lots = report([ing({ qty: 400, unit: "g" }), ing({ id: "cumin", qty: 200, unit: "g" })]);
  assert.equal(lots.per_serving, null);
  assert.deepEqual(lots.gaps.map((g) => g.ingredient_id), ["cumin"]);
});

test("an ingredient that is zero at every amount cannot block a total, and that is arithmetic", () => {
  // Water and salt. Not knowing how much water is in a soup cannot stop us adding the soup up: no
  // quantity of a thing with no energy and no macronutrients changes what the dish comes to.
  const r = report([ing({ qty: 400, unit: "g" }), ing({ id: "water", qty: null, unit: "to_taste" }), ing({ id: "salt", qty: 5, unit: "g" })]);
  assert.deepEqual(r.contribute_nothing.sort(), ["salt", "water"]);
  assert.ok(r.per_serving, "a total survives them");
  assert.deepEqual(r.gaps, []);
});

test("the trace list and the zero list are separate, because the reasons are not the same kind", () => {
  // One is somebody's judgment about how much gets used; the other is arithmetic. Blurring them
  // would hide which of the two a reader is being asked to trust.
  const r = report([ing({ qty: 400, unit: "g" }), ing({ id: "cumin", qty: null, unit: "to_taste" }), ing({ id: "water", qty: null, unit: "to_taste" })]);
  assert.deepEqual(r.ignored_as_trace, ["cumin"]);
  assert.deepEqual(r.contribute_nothing, ["water"]);
});

// --- scaling and arithmetic -----------------------------------------------------------------------

test("asking for more servings scales the food, not the figure per serving", () => {
  const two = report([ing({ qty: 400, unit: "g" })], 2);
  const four = report([ing({ qty: 400, unit: "g" })], 2, 4);
  assert.equal(two.per_serving?.kcal, four.per_serving?.kcal, "twice the food over twice the plates");
  assert.equal((four.total?.kcal ?? 0), (two.total?.kcal ?? 0) * 2);
});

test("every reported number is an integer, because these get summed", () => {
  const r = report([ing({ qty: 333, unit: "g" }), ing({ id: "olive-oil", qty: 1, unit: "tbsp" })], 3);
  for (const [k, v] of Object.entries(r.per_serving ?? {})) {
    assert.ok(Number.isInteger(v), `${k} is ${v}`);
  }
  for (const c of r.counted) assert.ok(Number.isInteger(c.grams));
});

// --- what it says -------------------------------------------------------------------------------

test("a total says what it is a total of, and names what rests on a measure", () => {
  const said = nutritionSentence(report([ing({ qty: 400, unit: "g" }), ing({ id: "onion", qty: 1, unit: "pc" })]));
  assert.match(said, /covers all 2 of the ingredients/);
  assert.match(said, /standard measures rather than weights/);
  assert.match(said, /onion/);
});

test("a refusal says which kind of not-knowing it is, in the person's terms", () => {
  const said = nutritionSentence(report([
    ing({ qty: 400, unit: "g" }),
    ing({ id: "tomato", qty: null, unit: "to_taste" }),
    ing({ id: "pine-mushroom", qty: 50, unit: "g" }),
    ing({ id: "tofu", qty: 1, unit: "pc" }),
  ]));
  assert.match(said, /does not say how much tomato/);
  assert.match(said, /no figures for pine mushroom/);
  assert.match(said, /cannot turn the tofu into a weight/);
});

test("a single ingredient is always answerable, and says what state the figures are for", () => {
  const chickpea = INDEX.get("chickpea") as NutritionRow;
  const said = ingredientSentence(chickpea);
  assert.match(said, /100 g of chickpea is about 364 calories/);
  assert.match(said, /Dried, as bought/, "cooked chickpeas are a different number and it says so");
  assert.match(ingredientSentence(INDEX.get("cumin") as NutritionRow), /too small to count/);
});

// --- the table itself -----------------------------------------------------------------------------

test("the table is incomplete on purpose, and the corpus proves the refusal fires", () => {
  // If every recipe could be totalled, the interesting half of this feature would never be seen.
  const recipes = loadRecipes();
  const reports = recipes.map((r) => nutritionOf(r, INDEX, TABLE));
  const totals = reports.filter((r) => r.per_serving).length;
  const floors = reports.filter((r) => !r.per_serving && r.at_least).length;
  assert.ok(totals >= 1, "at least one recipe is fully quantified");
  assert.ok(totals < recipes.length / 2, "and most are not, which is the truth about home cooking");
  assert.ok(floors > recipes.length / 3, "but a floor is still worth having for most of them");
});

test("every figure the table carries is an integer", () => {
  for (const e of (TABLE as NutritionTable).entries) {
    for (const f of ["kcal", "protein_cg", "carb_cg", "fat_cg", "fibre_cg", "g_per_100ml"] as const) {
      const v = e[f];
      assert.ok(v === null || Number.isInteger(v), `${e.id}.${f} is ${v}`);
    }
    for (const [unit, per] of Object.entries(e.measures)) {
      assert.ok(Number.isInteger(per) && (per as number) > 0, `${e.id}.measures.${unit} is ${per}`);
    }
  }
});
