// An adapter's job is to translate a payload and to be honest about what it could not translate.
// These tests hold it to both, and to the confidence ceiling it declares.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { type PantryEvent } from "../src/pantry/events.ts";
import { foldPantry } from "../src/pantry/fold.ts";
import { buildResolver, loadAliases, normalizeName } from "../src/integrations/aliases.ts";
import { type FridgeStatus, simulatedFridge } from "../src/integrations/simulated_fridge.ts";
import { type PantrySource, runSource } from "../src/integrations/types.ts";
import { loadRecipes } from "../src/recipes.ts";

const NOW = "2026-09-04T12:00:00.000Z";
const reading = JSON.parse(
  readFileSync(new URL("./fixtures/simulated_fridge_reading.json", import.meta.url), "utf8"),
) as FridgeStatus;

const knownIds = new Set(loadRecipes().flatMap((r) => r.ingredients.map((i) => i.id)));
const resolve = buildResolver(loadAliases(), knownIds);
const ctx = { userId: "u1", now: NOW, resolve };

test("normalizeName folds case, accents and separators into one key", () => {
  assert.equal(normalizeName("Bell Peppers"), "bell-peppers");
  assert.equal(normalizeName("  jalapeño  "), "jalapeno");
  assert.equal(normalizeName("Organic_Roma-Tomato!"), "organic-roma-tomato");
  assert.equal(normalizeName("   "), "");
});

test("the resolver uses the alias table, the corpus, and mechanical plurals — in that order", () => {
  assert.equal(resolve("Spring Onions"), "green-onion", "alias table");
  assert.equal(resolve("Tofu"), "tofu", "an id the recipes already use needs no alias");
  assert.equal(resolve("Carrots"), "carrot", "mechanical plural");
  assert.equal(resolve("Cherry Tomatoes"), "cherry-tomato");
  assert.equal(resolve("Potatoes"), "potato");
});

test("a name the resolver does not know returns null instead of a plausible guess", () => {
  assert.equal(resolve("Kimchi"), null);
  assert.equal(resolve("Leftover pasta surprise"), null);
  assert.equal(resolve(""), null);
});

test("the fridge reading becomes corrections, with what it could not map reported separately", () => {
  const { events, unmapped } = runSource(simulatedFridge, reading, ctx);
  assert.deepEqual(events.map((e) => e.ingredient_id), ["tofu", "cherry-tomato", "green-onion", "spinach", "carrot"]);
  assert.ok(events.every((e) => e.type === "correct"), "a snapshot restates lines, it does not add to them");
  assert.deepEqual(
    unmapped.map((u) => u.raw_name).sort(),
    ["Kimchi", "Leftover pasta", "Rice"],
    "an unknown food and an out-of-vocabulary unit both surface rather than vanish",
  );
  assert.match(unmapped.find((u) => u.raw_name === "Kimchi")!.reason, /no canonical ingredient id/);
  // "Rice" resolves fine; it is the unit the fridge reported that we refuse to invent a meaning for.
  assert.match(unmapped.find((u) => u.raw_name === "Rice")!.reason, /unit 'bowl'/);
});

test("a fridge item with no quantity yields an unknown amount, not a count of one", () => {
  const { events } = runSource(simulatedFridge, reading, ctx);
  const spinach = events.find((e) => e.ingredient_id === "spinach")!;
  assert.equal(spinach.qty_milli, null);
  assert.equal(spinach.unit, "pc");
  assert.equal(spinach.expires_on, "2026-09-06");
});

test("everything a fridge reports is inferred, never confirmed", () => {
  const { events } = runSource(simulatedFridge, reading, ctx);
  assert.ok(events.every((e) => e.confidence === "inferred"));
});

test("runSource clamps an adapter that claims more certainty than its ceiling", () => {
  const liar: PantrySource<null> = {
    kind: "simulated",
    maxConfidence: "inferred",
    toEvents: (): { events: PantryEvent[]; unmapped: [] } => ({
      events: [{
        ts: NOW, seq: 0, type: "add", ingredient_id: "tofu", qty_milli: 1000, unit: "pc",
        origin: "simulated", confidence: "confirmed", location: "fridge",
        expires_on: null, external_id: null, source_device: null,
      }],
      unmapped: [],
    }),
  };
  assert.equal(liar.toEvents(null, ctx).events[0].confidence, "confirmed", "the adapter did claim it");
  assert.equal(runSource(liar, null, ctx).events[0].confidence, "inferred", "and runSource took it back");
});

test("the same reading synced twice does not double the pantry", () => {
  const once = runSource(simulatedFridge, reading, ctx).events;
  const first = foldPantry(once, { now: NOW });
  const second = foldPantry([...once, ...once], { now: NOW });
  assert.equal(second.duplicates, once.length);
  assert.deepEqual(second.items, first.items);
});

test("a later reading of the same fridge restates the line rather than stacking on it", () => {
  const monday = runSource(simulatedFridge, reading, ctx).events;
  const tuesday = runSource(
    simulatedFridge,
    {
      ...reading,
      components: {
        main: {
          "samsungce.fridgeFoodList": {
            foodList: {
              timestamp: "2026-09-05T07:00:00.000Z",
              value: [{ name: "Carrots", quantity: 2, unit: "pc" }],
            },
          },
        },
      },
    },
    ctx,
  ).events;
  const { items } = foldPantry([...monday, ...tuesday], { now: "2026-09-05T12:00:00.000Z" });
  const carrot = items.find((i) => i.ingredient_id === "carrot")!;
  assert.equal(carrot.qty, 2, "four carrots on Monday and two on Tuesday means two, not six");
});

test("what the fridge sees and what you say land in the same ledger, and the weaker claim wins", () => {
  const fromFridge = runSource(simulatedFridge, reading, ctx).events;
  const spoken: PantryEvent = {
    ts: "2026-09-04T09:00:00.000Z", seq: 0, type: "add", ingredient_id: "carrot",
    qty_milli: 2000, unit: "pc", origin: "voice", confidence: "confirmed",
    location: "fridge", expires_on: null, external_id: null, source_device: null,
  };
  const { items } = foldPantry([...fromFridge, spoken], { now: NOW });
  const carrot = items.find((i) => i.ingredient_id === "carrot")!;
  assert.deepEqual(carrot.origins, ["simulated", "voice"]);
  assert.equal(carrot.confidence, "inferred");
});
