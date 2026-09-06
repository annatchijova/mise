// Multiplying every amount by the servings is right for the lentils and a lie about the salt. These
// tests hold up the arithmetic — integers in, integers out, and scaling up then back down has to
// land where it started — and the part that is not arithmetic at all: past double, the limit is the
// pan, and that is said rather than folded into a number.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { loadRecipes } from "../src/recipes.ts";
import { LINEAR, buildScaling, loadScaling, scaleDamped, scalingWarnings } from "../src/cook/scaling.ts";
import { consumptionEvents, finish, misePlace, startSession } from "../src/cook/session.ts";

const table = loadScaling();
const scaling = buildScaling(table);
const recipes = loadRecipes();
const stew = recipes.find((r) => r.id === "broad-bean-red-lentil-stew")!;
const T0 = "2026-09-05T18:00:00.000Z";

test("what should multiply, multiplies", () => {
  // Broad beans are the body of the dish; twice the people is twice the beans.
  const doubled = misePlace(stew, 12, scaling);
  assert.equal(doubled.find((m) => m.ingredient_id === "broad-bean")?.qty, 1000, "500 g for six is a kilo for twelve");
  assert.equal(doubled.find((m) => m.ingredient_id === "broad-bean")?.damped, false);
});

test("seasoning goes up by less, and says so", () => {
  const rule = scaling("salt", "spice", "season");
  // Doubling the recipe with half-rate damping: 100 g becomes 150, not 200.
  assert.equal(scaleDamped(100_000, 12, 6, rule), 150_000);
  assert.equal(rule.match, "ingredient", "salt has a row of its own");
  assert.match(rule.note ?? "", /half the rate/);
});

test("an ingredient with no row of its own falls back to its role and technique", () => {
  const rule = scaling("cumin", "spice", "season");
  assert.equal(rule.match, "role+technique");
  assert.deepEqual([...rule.damping], [1, 2]);
});

test("an ingredient no row covers at all multiplies straight, exactly as it did before the table", () => {
  const rule = scaling("red-lentil", "protein", "simmer");
  assert.equal(rule.match, "default");
  assert.deepEqual([...rule.damping], [...LINEAR.damping]);
  assert.equal(scaleDamped(250_000, 18, 6, rule), 750_000);
});

test("the arithmetic stays in integers and never drifts", () => {
  const rule = scaling("salt", "spice", "season");
  for (const base of [1, 7, 333, 100_000, 999_999]) {
    for (const servings of [1, 2, 3, 5, 12]) {
      const out = scaleDamped(base, servings, 6, rule);
      assert.ok(Number.isInteger(out), `${base} × ${servings}/6 came out as ${out}`);
      assert.ok(out >= 0, `${base} × ${servings}/6 came out negative`);
    }
  }
});

test("scaling by nothing changes nothing, whatever the damping says", () => {
  for (const id of ["salt", "broad-bean", "red-lentil", "bay-leaf"]) {
    const rule = scaling(id, "spice", "season");
    assert.equal(scaleDamped(123_456, 6, 6, rule), 123_456, `${id} moved when the servings did not`);
  }
});

test("a linear amount scaled up and back down lands exactly where it started", () => {
  const rule = scaling("broad-bean", "protein", "simmer");
  const up = scaleDamped(500_000, 12, 6, rule);
  assert.equal(scaleDamped(up, 6, 12, rule), 500_000);
});

test("past double, the pan is the limit and it is said rather than counted", () => {
  const warnings = scalingWarnings(
    stew.ingredients.map((i) => ({ id: i.id, role: i.role, technique: i.technique })),
    18, 6, scaling,
  );
  assert.ok(warnings.length > 0, "tripling a stew that browns earns a warning");
  assert.ok(warnings.some((w) => /batches/.test(w.text)));
  // Six things that all brown earn one warning about the pan, not six.
  assert.equal(new Set(warnings.map((w) => w.text)).size, warnings.length);
});

test("cooking for the number the recipe was written for earns no warnings at all", () => {
  assert.deepEqual(scalingWarnings(stew.ingredients.map((i) => ({ id: i.id, role: i.role, technique: i.technique })), 6, 6, scaling), []);
  assert.deepEqual(scalingWarnings(stew.ingredients.map((i) => ({ id: i.id, role: i.role, technique: i.technique })), 3, 6, scaling), [], "cooking less is not a pan problem");
});

test("the pantry loses what the cook was told to use, not a different number", () => {
  const session = finish(startSession({ id: "s", userId: "u", recipe: stew, servings: 12, now: T0 }), stew, T0);
  const mise = misePlace(stew, 12, scaling);
  const { events } = consumptionEvents(session, stew, T0, scaling);
  for (const e of events) {
    const told = mise.find((m) => m.ingredient_id === e.ingredient_id);
    if (!told || told.qty === null || e.qty_milli === null) continue;
    // Both sides go through canonicalAmount, so compare in the deduction's own unit.
    const factor = e.unit === "g" && told.unit === "kg" ? 1000 : e.unit === "ml" && told.unit === "l" ? 1000 : 1;
    assert.equal(e.qty_milli, Math.round(told.qty * 1000) * factor, `${e.ingredient_id}: told ${told.qty} ${told.unit}, took ${e.qty_milli} milli-${e.unit}`);
  }
});

test("without a table nothing is damped, which is what the code did before it existed", () => {
  const plain = misePlace(stew, 12);
  assert.ok(plain.every((m) => !m.damped));
  assert.equal(plain.find((m) => m.ingredient_id === "broad-bean")?.qty, 1000);
});

test("an amount the book never gave is not reported as damped, because there was nothing to damp", () => {
  const mise = misePlace(stew, 18, scaling);
  const water = mise.find((m) => m.ingredient_id === "water")!;
  assert.equal(water.qty, null, "the book never says how much water");
  assert.equal(water.damped, false, "and saying it did not scale straight would be noise dressed as care");
  assert.equal(water.scaling_note, null);
  assert.ok(mise.filter((m) => m.damped).every((m) => m.qty !== null));
});

test("no row claims an amount grows faster than the number of people", () => {
  for (const e of table.entries) {
    const [num, den] = e.damping;
    assert.ok(num <= den, `${e.ingredient ?? e.role ?? e.technique}: damping ${num}/${den} is above 1`);
    assert.ok(den > 0 && num >= 0);
  }
});
