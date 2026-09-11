import { strict as assert } from "node:assert";
import { test } from "node:test";

import { type Recipe, loadRecipes } from "../src/recipes.ts";
import type { PantryItem } from "../src/pantry/fold.ts";
import { loadRegrowTips, loadZeroWasteLessons, zeroWaste } from "../src/zero_waste.ts";

const lessons = loadZeroWasteLessons();
const regrowTips = loadRegrowTips();
const recipes = loadRecipes();

function item(id: string, overrides: Partial<PantryItem> = {}): PantryItem {
  return {
    ingredient_id: id, unit: "g", location: "fridge", qty: 1, qty_known: true,
    confidence: "confirmed", age_days: 0, expires_on: "2026-09-05",
    expiry_estimated_on: null, expiry_source: "stated", expiry_note: null, expiry_match: null,
    days_to_expiry: 1, freshness: "urgent", origins: ["voice"],
    last_event_ts: "2026-09-04T12:00:00Z", ...overrides,
  };
}

function recipe(id: string, ingredients: string[]): Recipe {
  const base = recipes[0]!;
  return { ...base, id, title_es: id, minutes: 10, ingredients: ingredients.map((ingId) => ({ ...base.ingredients[0]!, id: ingId, technique: "brown" })) };
}

test("urgency wins before coverage; stable recipe ties do not depend on input order", () => {
  const rs = [recipe("z", ["tofu", "onion"]), recipe("a", ["tofu", "onion"]), recipe("full", ["rice"])];
  const pantry = [item("tofu"), item("rice", { freshness: "fresh", days_to_expiry: 10 })];
  const result = zeroWaste(rs, pantry, lessons, regrowTips);
  assert.deepEqual(result.candidates.map((c) => c.recipe_id), ["a", "z", "full"]);
  assert.deepEqual(result, zeroWaste([...rs].reverse(), [...pantry].reverse(), lessons, regrowTips));
  assert.deepEqual(result.candidates[0]!.missing, ["onion"]);
});

test("expired and stale records cannot support a suggestion, even alongside a usable line", () => {
  const rs = [recipe("tofu", ["tofu"]), recipe("rice", ["rice"])];
  const pantry = [item("tofu", { freshness: "expired" }), item("rice", { confidence: "stale" })];
  assert.equal(zeroWaste(rs, pantry, lessons, regrowTips).total, 0);
  const result = zeroWaste(rs, [...pantry, item("tofu", { location: "freezer" })], lessons, regrowTips);
  assert.equal(result.total, 1);
  assert.equal(result.excluded.length, 2);
  assert.equal(result.candidates[0]!.pantry_evidence.length, 1);
});

test("unknown amounts and inferred evidence stay visible; presence never implies enough", () => {
  const result = zeroWaste([recipe("a", ["tofu"])], [item("tofu", { qty: null, qty_known: false, confidence: "inferred" })], lessons, regrowTips, { locale: "es" });
  assert.deepEqual(result.candidates[0]!.needs_confirmation, ["tofu"]);
  assert.equal(result.candidates[0]!.pantry_evidence[0]!.qty, null);
  assert.match(result.notes.quantity, /no garantiza cantidad/);
  assert.match(result.notes.ecology, /no prueba desperdicio/);
});

test("lessons are selected from the recipe technique and localized; no invented fallback", () => {
  const r = recipe("a", ["tofu"]);
  const es = zeroWaste([r], [item("tofu")], lessons, regrowTips, { locale: "es" });
  assert.equal(es.candidates[0]!.learning[0]!.title, "Construí contraste");
  r.ingredients[0]!.technique = "unsupported";
  assert.deepEqual(zeroWaste([r], [item("tofu")], lessons, regrowTips).candidates[0]!.learning, []);
});

test("regrow tips are offered for urgent ingredients that have one, independent of the recipe's technique", () => {
  const r = recipe("soup", ["celery", "tofu"]);
  const urgent = zeroWaste([r], [item("celery"), item("tofu")], lessons, regrowTips, { locale: "es" });
  assert.equal(urgent.candidates[0]!.regrow.length, 1);
  assert.equal(urgent.candidates[0]!.regrow[0]!.ingredient_id, "celery");
  assert.match(urgent.candidates[0]!.regrow[0]!.tip, /agua poco profunda/);

  // Fresh, not about to expire: no regrow nudge — the tip is for what is about to be lost, not everything.
  const fresh = zeroWaste([r], [item("celery", { freshness: "fresh", days_to_expiry: 10 }), item("tofu")], lessons, regrowTips);
  assert.deepEqual(fresh.candidates[0]!.regrow, []);

  // An ingredient with no curated tip (tofu) never invents one.
  const r2 = recipe("tofu-only", ["tofu"]);
  assert.deepEqual(zeroWaste([r2], [item("tofu")], lessons, regrowTips).candidates[0]!.regrow, []);
});

test("empty pantry, time limits, and the real recipe corpus are bounded and read-only", () => {
  assert.equal(zeroWaste(recipes, [], lessons, regrowTips).total, 0);
  const pantry = [item("tofu")];
  const before = JSON.stringify(pantry);
  const result = zeroWaste(recipes, pantry, lessons, regrowTips, { max_minutes: 30, limit: 2 });
  assert.ok(result.candidates.length <= 2);
  for (const c of result.candidates) {
    assert.ok(c.minutes <= 30);
    assert.ok(recipes.some((r) => r.id === c.recipe_id));
  }
  assert.equal(JSON.stringify(pantry), before);
});
