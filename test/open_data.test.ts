// What leaves the building has to carry its provenance and its reservations, because a caveat that
// lives only in a repository somebody did not clone has not been given to them. These tests hold
// that up, and hold up the one rule the exported shopping list shares with the spoken one: what the
// shop could not supply is in the list, not dropped from it.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { DATA_LICENSE, PUBLISHED, publish, shoppingListJsonLd } from "../src/open_data.ts";
import { loadSubstitutions } from "../src/substitutions.ts";
import { loadShelfLife } from "../src/pantry/shelf_life.ts";
import { loadScaling } from "../src/cook/scaling.ts";
import { indexCatalog, loadCatalog } from "../src/store/catalog.ts";
import { cartFromWanted } from "../src/store/cart.ts";
import { planWeek } from "../src/plan/planner.ts";
import { loadRecipes } from "../src/recipes.ts";

const OPTS = { baseUrl: "https://mise.test", repository: "https://example.test/repo" };
const tables: Record<string, Record<string, unknown>> = {
  "/data/substitutions.json": loadSubstitutions() as unknown as Record<string, unknown>,
  "/data/shelf-life.json": loadShelfLife() as unknown as Record<string, unknown>,
  "/data/scaling.json": loadScaling() as unknown as Record<string, unknown>,
};

test("every published table exists, and every table published has a document to publish", () => {
  for (const meta of PUBLISHED) assert.ok(tables[meta.path], `${meta.path} has no table behind it`);
  assert.equal(Object.keys(tables).length, PUBLISHED.length);
});

test("what goes out carries who wrote it, when, under what licence, and against what contract", () => {
  for (const meta of PUBLISHED) {
    const doc = publish(tables[meta.path], meta, OPTS) as { _published: Record<string, unknown>; version: number; author: string };
    assert.equal(doc._published.license, DATA_LICENSE);
    assert.equal(doc._published.canonical_url, `${OPTS.baseUrl}${meta.path}`);
    assert.equal(doc._published.repository, OPTS.repository);
    assert.match(String(doc._published.schema), /^docs\/.+\.md$/);
    assert.ok(typeof doc.version === "number", `${meta.path} lost its version on the way out`);
    assert.ok(typeof doc.author === "string", `${meta.path} lost its author on the way out`);
  }
});

test("the caveat is in the payload, not only in the repository", () => {
  for (const meta of PUBLISHED) {
    const doc = publish(tables[meta.path], meta, OPTS) as { _published: { caveat: string | null } };
    assert.ok(doc._published.caveat && doc._published.caveat.length > 40, `${meta.path} goes out with no reservations attached`);
  }
  const shelf = PUBLISHED.find((p) => p.path === "/data/shelf-life.json")!;
  assert.match(shelf.caveat ?? "", /NOBODY HAS MEASURED/, "the one table where being wrong could matter says so loudly");
  assert.match(shelf.caveat ?? "", /not a food safety authority/i);
});

test("the rows go out exactly as they are in the repository, minus the note to whoever edits them", () => {
  for (const meta of PUBLISHED) {
    const table = tables[meta.path] as { entries: unknown[] };
    const doc = publish(tables[meta.path], meta, OPTS) as { entries: unknown[]; _comment?: string };
    assert.equal(doc._comment, undefined, "the editor's note is not part of the data");
    assert.deepEqual(doc.entries, table.entries, `${meta.path} was altered on the way out`);
  }
});

// --- the shopping list --------------------------------------------------------------------------

const recipes = loadRecipes();
const catalog = loadCatalog();
const index = indexCatalog(catalog);
const NOW = "2026-09-07T09:00:00.000Z";

function listFor(wanted: { ingredient_id: string; qty: number | null; unit: "g" | "pc" | "ml" }[]) {
  const plan = planWeek({ recipes, pantry: [], now: NOW, days: 1, meals_per_day: 1 });
  const cart = cartFromWanted(index, wanted, { cart_id: "c", user_id: "u", plan_id: plan.plan_id, currency: "USD", now: NOW });
  return { plan, cart, list: shoppingListJsonLd(plan, cart, OPTS) as Record<string, any> };
}

test("the list is a schema.org ItemList any grocery app can read", () => {
  const { list } = listFor([{ ingredient_id: "onion", qty: 3, unit: "pc" }]);
  assert.equal(list["@context"], "https://schema.org");
  assert.equal(list["@type"], "ItemList");
  assert.equal(list.itemListElement[0]["@type"], "ListItem");
  assert.equal(list.itemListElement[0].item["@type"], "Product");
  assert.equal(list.numberOfItems, list.itemListElement.length);
});

test("prices come out as decimal strings from integer cents, and never as arithmetic", () => {
  const { list } = listFor([{ ingredient_id: "onion", qty: 3, unit: "pc" }]);
  const offer = list.itemListElement[0].item.offers;
  assert.equal(offer.priceCurrency, "USD");
  assert.match(offer.price, /^\d+\.\d{2}$/, `"${offer.price}" is not a price`);
  const sku = catalog.skus.find((s) => s.id === list.itemListElement[0].item.sku)!;
  assert.equal(offer.price, `${Math.floor(sku.price_cents / 100)}.${String(sku.price_cents % 100).padStart(2, "0")}`);
});

test("what the shop cannot supply is in the list without an offer, with the reason", () => {
  const { list } = listFor([
    { ingredient_id: "onion", qty: 2, unit: "pc" },
    { ingredient_id: "kaffir-lime-leaf", qty: 4, unit: "pc" },
  ]);
  const orphan = list.itemListElement.find((e: any) => /kaffir/.test(e.item.name));
  assert.ok(orphan, "a shopping list that silently drops the pumpkin is worse than no shopping list");
  assert.equal(orphan.item.offers, undefined, "no offer, because there is nothing to offer");
  assert.match(orphan.item.description, /Not available from this shop/);
  assert.match(list.description, /could not be supplied/);
});

test("positions are unique and start at one, including the items nobody can sell", () => {
  const { list } = listFor([
    { ingredient_id: "onion", qty: 2, unit: "pc" },
    { ingredient_id: "carrot", qty: 2, unit: "pc" },
    { ingredient_id: "kaffir-lime-leaf", qty: 1, unit: "pc" },
  ]);
  const positions = list.itemListElement.map((e: any) => e.position);
  assert.deepEqual(positions, positions.map((_: number, i: number) => i + 1));
});

test("an allergen the shop declared travels with the item", () => {
  const { list } = listFor([{ ingredient_id: "sesame-oil", qty: 100, unit: "ml" }]);
  const item = list.itemListElement[0].item;
  assert.match(item.description ?? "", /sesame/);
});

test("the list names the plan it came from, so a printed one can be traced back", () => {
  const { plan, list } = listFor([{ ingredient_id: "onion", qty: 1, unit: "pc" }]);
  assert.equal(list.identifier, plan.plan_id);
  assert.match(list.name, new RegExp(plan.start_date));
});
