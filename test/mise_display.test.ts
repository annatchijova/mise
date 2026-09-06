// A checklist is unforgiving in a way a sentence is not: "1.333 red onion" reads as a rounding error
// on a card in a way it does not when it goes past in speech. These tests cover the amount a person
// is given to act on — and the one property that makes rounding it safe at all, which is that the
// pantry never reads it.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { amountParts, amountText, plural } from "../src/pantry/events.ts";
import { consumptionEvents, cookableQty, misePlace, startSession, view } from "../src/cook/session.ts";
import { loadRecipes } from "../src/recipes.ts";

const NOW = "2026-09-06T12:00:00.000Z";
const recipes = loadRecipes();
const stew = recipes.find((r) => r.id === "broad-bean-red-lentil-stew")!;

test("nobody weighs 333.333 g, so a weight is rounded to something a kitchen can produce", () => {
  assert.equal(cookableQty(333.333, "g"), 330);
  assert.equal(cookableQty(37.4, "g"), 35);
  assert.equal(cookableQty(7.2, "g"), 7, "small amounts stay fine-grained, because there it matters");
  assert.equal(cookableQty(1250, "ml"), 1250);
});

test("a third of an onion is not a thing to fetch", () => {
  assert.equal(cookableQty(1.333, "pc"), 1);
  assert.equal(cookableQty(2.6, "pc"), 3);
  assert.equal(cookableQty(0.4, "pc"), 1, "a real amount is never rounded away to nothing");
});

test("spoons come in halves and quarters, because kitchens have those", () => {
  assert.equal(cookableQty(1.6, "tsp"), 1.5);
  assert.equal(cookableQty(0.3, "tbsp"), 0.25);
});

test("a unit nobody counts in is left exactly as it was", () => {
  assert.equal(cookableQty(2.5, "to_taste"), 2.5);
  assert.equal(cookableQty(null, "g"), null);
});

test("two onions are onions, and three slices of pumpkin are slices of it", () => {
  assert.equal(amountText(2, "pc", "onion"), "2 onions");
  assert.equal(amountText(1, "pc", "onion"), "1 onion");
  assert.equal(amountText(3, "slice", "pumpkin"), "3 slices of pumpkin");
  assert.equal(amountText(2, "clove", "garlic"), "2 cloves of garlic");
  assert.equal(amountText(330, "g", "broad-bean"), "330 g broad bean");
});

test("the plurals the corpus actually needs", () => {
  assert.equal(plural("potato", 2), "potatoes");
  assert.equal(plural("tomato", 2), "tomatoes");
  assert.equal(plural("squash", 2), "squashes");
  assert.equal(plural("berry", 2), "berries");
  assert.equal(plural("onion", 2), "onions");
  assert.equal(plural("onion", 1), "onion", "one of a thing is that thing");
});

test("the words are split so a card can set them apart, and join back to the sentence", () => {
  const parts = amountParts(3, "slice", "pumpkin");
  assert.deepEqual(parts, { amount: "3 slices of", name: "pumpkin" });
  assert.equal(`${parts.amount} ${parts.name}`, amountText(3, "slice", "pumpkin"));
});

// --- the property that makes rounding safe ---------------------------------------------------------

test("rounding what a person is told never changes what the pantry loses", () => {
  // The whole reason the display may round at all. The deduction does its own arithmetic in whole
  // thousandths from the recipe, and reads neither `display_qty` nor `qty`.
  const session = startSession({ id: "s", userId: "u", recipe: stew, servings: 4, now: NOW, cooks: 1, assignments: {} });
  const mise = misePlace(stew, 4);
  const broadBean = mise.find((m) => m.ingredient_id === "broad-bean")!;
  assert.equal(broadBean.display_qty, 330, "the person is told a number they can weigh");
  assert.ok(Math.abs((broadBean.qty ?? 0) - 333.333) < 0.001, "and the exact one is still there");

  const deduction = consumptionEvents(session, stew, NOW);
  const event = deduction.events.find((e) => e.ingredient_id === "broad-bean")!;
  assert.equal(event.qty_milli, 333_333, "the ledger keeps the exact thousandths, not the rounded ones");
});

test("an amount that did not move is not called 'about'", () => {
  const mise = misePlace(stew, stew.serves);
  const exact = mise.filter((m) => m.qty !== null && !m.rounded);
  assert.ok(exact.length > 0, "at the recipe's own servings most amounts are already whole");
  for (const m of exact) assert.doesNotMatch(m.display_amount, /about/);
  for (const m of mise.filter((x) => x.rounded)) assert.match(m.display_amount, /^about /);
});

// --- what the view carries ---------------------------------------------------------------------

test("the card is given the mise only while it is the mise en place", () => {
  const session = startSession({ id: "s", userId: "u", recipe: stew, servings: 4, now: NOW, cooks: 1, assignments: {} });
  assert.ok(view(session, stew, NOW).mise?.length, "a list to tick off, while there is one to tick");

  const cooking = { ...session, state: "cooking" as const, completed_steps: [] };
  assert.equal(view(cooking, stew, NOW).mise, null, "and no list once nobody is looking at it");
});

test("the card is told where the recipe came from", () => {
  const session = startSession({ id: "s", userId: "u", recipe: stew, servings: 4, now: NOW, cooks: 1, assignments: {} });
  const v = view(session, stew, NOW);
  assert.equal(v.recipe_title, stew.title);
  assert.equal(v.source.book, stew.source.book);
  assert.ok(v.source.locator.length > 0);
  assert.ok(!("original_text" in v.source), "the original Spanish belongs on a recipe card, not a step card");
});

test("every recipe in the corpus can say where it came from", () => {
  for (const r of recipes) {
    assert.ok(r.source.book, `${r.id} has no book`);
    assert.ok(r.source.locator, `${r.id} has no locator`);
  }
});
