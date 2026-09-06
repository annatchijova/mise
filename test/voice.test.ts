// What the person said becomes confirmed events; what we cannot place is said back, not guessed.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildResolver, loadAliases } from "../src/integrations/aliases.ts";
import { foldPantry } from "../src/pantry/fold.ts";
import { voiceEvents } from "../src/pantry/voice.ts";
import { loadRecipes } from "../src/recipes.ts";

const NOW = "2026-09-04T12:00:00.000Z";
const resolve = buildResolver(loadAliases(), new Set(loadRecipes().flatMap((r) => r.ingredients.map((i) => i.id))));
const ctx = { now: NOW, resolve };

test("the opening line of the video becomes three confirmed events", () => {
  const { events, rejected } = voiceEvents(
    [
      { name: "onions", qty: 2 },
      { name: "red lentils", qty: 0.5, unit: "kg" },
      { name: "tofu", expires: "2026-09-05", location: "fridge" },
    ],
    "add",
    ctx,
  );
  assert.deepEqual(rejected, []);
  assert.deepEqual(events.map((e) => [e.ingredient_id, e.qty_milli, e.unit, e.confidence, e.origin, e.location]), [
    ["onion", 2000, "pc", "confirmed", "voice", "pantry"],
    // Half a kilo is kept as 500 g: kilos and litres are exact multiples, so the ledger holds one
    // line for lentils instead of two that never meet. See canonicalAmount in pantry/events.ts.
    ["red-lentil", 500_000, "g", "confirmed", "voice", "pantry"],
    ["tofu", null, "pc", "confirmed", "voice", "fridge"],
  ]);
  assert.equal(events[2].expires_on, "2026-09-05");
  const { items } = foldPantry(events, { now: NOW });
  assert.equal(items[0].ingredient_id, "tofu", "what expires first comes first");
  assert.equal(items[0].qty_known, false, "the person did not say how much tofu");
});

test("kilos and litres are folded into grams and millilitres; nothing else is converted", () => {
  const { events } = voiceEvents(
    [
      { name: "red lentils", qty: 2, unit: "kg" },
      { name: "soy milk", qty: 1, unit: "l" },
      { name: "flour", qty: 2, unit: "cup" },
    ],
    "add",
    ctx,
  );
  assert.deepEqual(events.map((e) => [e.qty_milli, e.unit]), [
    [2_000_000, "g"],
    [1_000_000, "ml"],
    // A cup of flour is not a number of grams without knowing the flour. Guessing the density is
    // exactly the invention this ledger refuses, so cups stay cups.
    [2_000, "cup"],
  ]);
});

test("an ingredient we do not know is said back, never guessed", () => {
  const { events, rejected } = voiceEvents([{ name: "kimchi", qty: 1 }], "add", ctx);
  assert.equal(events.length, 0);
  assert.equal(rejected[0].name, "kimchi");
  assert.match(rejected[0].reason, /don't know/);
});

test("a bad amount, unit or date rejects that item only", () => {
  const { events, rejected } = voiceEvents(
    [
      { name: "onion", qty: -1 },
      { name: "onion", qty: 1, unit: "bowl" },
      { name: "onion", qty: 1, expires: "Friday" },
      { name: "onion", qty: 0.0001 },
      { name: "carrot", qty: 3 },
    ],
    "add",
    ctx,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].ingredient_id, "carrot");
  assert.equal(rejected.length, 4);
  assert.match(rejected[2].reason, /Friday/);
});

test("consume subtracts from what voice added, and remove needs no amount", () => {
  const added = voiceEvents([{ name: "carrots", qty: 4 }], "add", ctx).events;
  const used = voiceEvents([{ name: "carrot", qty: 1 }], "consume", { ...ctx, now: "2026-09-04T13:00:00.000Z" }).events;
  assert.equal(foldPantry([...added, ...used], { now: NOW }).items[0].qty, 3);
  const gone = voiceEvents([{ name: "carrot" }], "remove", { ...ctx, now: "2026-09-04T14:00:00.000Z" }).events;
  assert.equal(gone[0].type, "remove");
  assert.deepEqual(foldPantry([...added, ...used, ...gone], { now: NOW }).items, []);
});

test("correct restates what the fridge inferred, and the person's word wins", () => {
  const fridge = { ...voiceEvents([{ name: "tofu", qty: 1 }], "add", ctx).events[0], origin: "simulated" as const, confidence: "inferred" as const };
  const said = voiceEvents([{ name: "tofu", qty: 2 }], "correct", { ...ctx, now: "2026-09-04T13:00:00.000Z" }).events;
  const [item] = foldPantry([fridge, ...said], { now: NOW }).items;
  assert.equal(item.qty, 2);
  assert.equal(item.confidence, "confirmed");
  assert.deepEqual(item.origins, ["voice"]);
});
