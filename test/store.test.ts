// The store is the only part of this system that takes somebody's money, so these tests are about
// the ways a checkout goes wrong rather than the ways it goes right: a price taken from the request,
// a retry that charges twice, an instrument that belongs to somebody else, a total that disagrees
// with its own lines.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { foldPantry } from "../src/pantry/fold.ts";
import { MemoryPantryStore } from "../src/pantry/store.ts";
import { allergensOf, indexCatalog, loadCatalog, money, packsFor, taxCents, totalsFor } from "../src/store/catalog.ts";
import { cartFromWanted, editCart } from "../src/store/cart.ts";
import { MemoryCheckoutStore, type UcpDeps, handleUcp, instrumentsFor, ucpProfile } from "../src/store/ucp.ts";

const catalog = loadCatalog();
const index = indexCatalog(catalog);
const NOW = "2026-09-07T09:00:00.000Z";

function deps(over: Partial<UcpDeps> = {}): UcpDeps {
  let n = 0;
  return {
    catalog: loadCatalog(), // a fresh copy each time: Complete decrements stock in place
    index: indexCatalog(loadCatalog()),
    sessions: new MemoryCheckoutStore(),
    pantry: new MemoryPantryStore(),
    userFor: (bearer) => (bearer === "token-a" ? "user-a" : bearer === "token-b" ? "user-b" : null),
    now: () => NOW,
    newId: (prefix) => `${prefix}_${String(++n).padStart(32, "0")}`,
    baseUrl: "https://example.test",
    ...over,
  };
}

const call = (d: UcpDeps, method: string, path: string, body: unknown, headers: Record<string, string | undefined> = {}) =>
  handleUcp(d, { method, path, body: body === undefined ? "" : JSON.stringify(body), headers: { authorization: "Bearer token-a", ...headers } });

type Session = { id: string; status: string; totals: { subtotal_cents: number; tax_cents: number; shipping_cents: number; total_cents: number }; payment_methods: { id: string }[]; messages: { code: string; presentation: string; content: string }[]; order: { id: string } | null; line_items: { sku_id: string; quantity: number }[] };

const ADDRESS = { fulfillment: { address: { name: "A", line1: "1 Calle", city: "BA", country: "AR" } } };

async function readyToPay(d: UcpDeps, items: { sku_id: string; quantity: number }[]) {
  const created = (await call(d, "POST", "/checkout-sessions", { line_items: items }, { "idempotency-key": "c1" }))!.body as Session;
  const updated = (await call(d, "PUT", `/checkout-sessions/${created.id}`, ADDRESS, { "idempotency-key": "u1" }))!.body as Session;
  return updated;
}

test("the price comes from the catalog, whatever the request claims it is", async () => {
  const d = deps();
  const sku = d.catalog.skus.find((s) => s.id === "sku-tofu-400g")!;
  const res = await call(d, "POST", "/checkout-sessions", {
    line_items: [{ sku_id: "sku-tofu-400g", quantity: 1, unit_price_cents: 1, total_cents: 1 }],
  }, { "idempotency-key": "k" });
  const session = res!.body as Session & { line_items: { unit_price_cents: number }[] };
  assert.equal(session.line_items[0].unit_price_cents, sku.price_cents);
  assert.equal(session.totals.subtotal_cents, sku.price_cents);
});

test("the same Idempotency-Key with a different body is a 409, not a second order", async () => {
  const d = deps();
  const first = await call(d, "POST", "/checkout-sessions", { line_items: [{ sku_id: "sku-tofu-400g", quantity: 1 }] }, { "idempotency-key": "same" });
  assert.equal(first!.status, 200);
  const replay = await call(d, "POST", "/checkout-sessions", { line_items: [{ sku_id: "sku-tofu-400g", quantity: 1 }] }, { "idempotency-key": "same" });
  assert.equal(replay!.status, 200);
  assert.equal((replay!.body as { replayed: boolean }).replayed, true, "an identical retry is a replay, not new work");
  const conflict = await call(d, "POST", "/checkout-sessions", { line_items: [{ sku_id: "sku-tofu-400g", quantity: 2 }] }, { "idempotency-key": "same" });
  assert.equal(conflict!.status, 409);
});

test("a state-changing call without an Idempotency-Key is refused outright", async () => {
  const d = deps();
  const res = await call(d, "POST", "/checkout-sessions", { line_items: [] }, {});
  assert.equal(res!.status, 400);
  assert.equal((res!.body as { error: string }).error, "idempotency_key_required");
});

test("completing twice adds the shopping to the pantry once", async () => {
  const d = deps();
  const session = await readyToPay(d, [{ sku_id: "sku-red-lentil-500g", quantity: 2 }]);
  const pay = { payment_method_id: session.payment_methods[0].id };
  const first = await call(d, "POST", `/checkout-sessions/${session.id}/complete`, pay, { "idempotency-key": "p1" });
  assert.equal((first!.body as Session).status, "completed");
  // The retry a flaky network produces: same key, same body.
  await call(d, "POST", `/checkout-sessions/${session.id}/complete`, pay, { "idempotency-key": "p1" });
  const events = await d.pantry.events("user-a");
  const { items } = foldPantry(events, { now: NOW });
  const lentils = items.find((i) => i.ingredient_id === "red-lentil")!;
  assert.equal(lentils.qty, 1000, "two 500 g bags, once");
  assert.equal(lentils.confidence, "confirmed", "a receipt is evidence: the shop knows what it put in the box");
});

test("a payment instrument from somebody else's session is refused", async () => {
  const d = deps();
  const session = await readyToPay(d, [{ sku_id: "sku-tofu-400g", quantity: 1 }]);
  const theirs = instrumentsFor("user-b")[0].id;
  const res = await call(d, "POST", `/checkout-sessions/${session.id}/complete`, { payment_method_id: theirs }, { "idempotency-key": "x" });
  const body = res!.body as Session;
  assert.equal(body.status, "ready_for_complete", "still unpaid");
  assert.ok(body.messages.some((m) => m.code === "payment_method_invalid"));
});

test("another customer's session is indistinguishable from one that never existed", async () => {
  const d = deps();
  const session = await readyToPay(d, [{ sku_id: "sku-tofu-400g", quantity: 1 }]);
  const res = await handleUcp(d, { method: "GET", path: `/checkout-sessions/${session.id}`, body: "", headers: { authorization: "Bearer token-b" } });
  assert.equal(res!.status, 404);
});

test("no bearer token, no checkout", async () => {
  const d = deps();
  const res = await handleUcp(d, { method: "GET", path: "/checkout-sessions/cs_whatever", body: "", headers: {} });
  assert.equal(res!.status, 401);
});

test("a checkout with nowhere to ship to cannot be completed", async () => {
  const d = deps();
  const created = (await call(d, "POST", "/checkout-sessions", { line_items: [{ sku_id: "sku-tofu-400g", quantity: 1 }] }, { "idempotency-key": "c" }))!.body as Session;
  const res = await call(d, "POST", `/checkout-sessions/${created.id}/complete`, { payment_method_id: created.payment_methods[0].id }, { "idempotency-key": "p" });
  const body = res!.body as Session;
  assert.ok(body.messages.some((m) => m.code === "not_ready"));
  assert.equal(body.status, "incomplete");
});

test("a session past its six hours cannot be paid", async () => {
  const d = deps();
  const session = await readyToPay(d, [{ sku_id: "sku-tofu-400g", quantity: 1 }]);
  const later = { ...d, now: () => "2026-09-07T16:00:00.000Z" };
  const res = await call(later, "POST", `/checkout-sessions/${session.id}/complete`, { payment_method_id: session.payment_methods[0].id }, { "idempotency-key": "p" });
  assert.ok((res!.body as Session).messages.some((m) => m.code === "not_completable"));
});

test("allergens are disclosed from the items actually in the basket", async () => {
  const d = deps();
  const session = await readyToPay(d, [{ sku_id: "sku-sesame-oil-250ml", quantity: 1 }, { sku_id: "sku-red-lentil-500g", quantity: 1 }]);
  const disclosure = session.messages.find((m) => m.presentation === "disclosure")!;
  assert.match(disclosure.content, /sesame/);
  assert.ok(!/nuts/.test(disclosure.content), "nothing is disclosed that is not in the basket");
});

test("stock comes off the shelf when the order is paid, and never below zero", async () => {
  const d = deps();
  const sku = d.index.byId.get("sku-merken-60g")!;
  const before = sku.stock;
  const session = await readyToPay(d, [{ sku_id: sku.id, quantity: 3 }]);
  await call(d, "POST", `/checkout-sessions/${session.id}/complete`, { payment_method_id: session.payment_methods[0].id }, { "idempotency-key": "p" });
  assert.equal(d.index.byId.get(sku.id)!.stock, before - 3);
});

test("an order for more than the shelf holds is trimmed and said out loud", async () => {
  const d = deps();
  const sku = d.index.byId.get("sku-merken-60g")!;
  const res = await call(d, "POST", "/checkout-sessions", { line_items: [{ sku_id: sku.id, quantity: sku.stock + 5 }] }, { "idempotency-key": "k" });
  const body = res!.body as Session;
  assert.equal(body.line_items[0].quantity, sku.stock);
  assert.ok(body.messages.some((m) => m.code === "out_of_stock"));
});

test("totals are integer cents and add up to their own lines", () => {
  const totals = totalsFor(2642, catalog.store);
  assert.equal(totals.tax_cents, taxCents(2642, catalog.store.tax_rate_bps));
  assert.equal(totals.total_cents, totals.subtotal_cents + totals.tax_cents + totals.shipping_cents);
  for (const v of Object.values(totals)) assert.ok(Number.isInteger(v), `${v} is not an integer number of cents`);
  assert.equal(totalsFor(9999, catalog.store).shipping_cents, 0, "past the threshold, delivery is free");
  assert.equal(money(3466), "$34.66");
  assert.equal(money(5), "$0.05");
});

test("an amount nobody stated buys one pack; an amount stated in the wrong unit buys nothing", () => {
  const flour = index.byId.get("sku-flour-0000-1kg")!;
  const unknown = packsFor(flour, null, "to_taste");
  assert.equal(unknown.ok && unknown.packs, 1);
  assert.equal(unknown.ok && unknown.assumed_pack, true, "one bag was a decision, and it says so");
  const cups = packsFor(flour, 2000, "cup");
  assert.equal(cups.ok, false, "two cups against a kilo bag needs a density, and we do not guess one");
  const grams = packsFor(flour, 1_500_000, "g");
  assert.equal(grams.ok && grams.packs, 2, "1.5 kg wanted, 1 kg bags, rounded up");
});

test("a cart merges two recipes wanting the same item and reports what the shop cannot sell", () => {
  const cart = cartFromWanted(
    index,
    [
      { ingredient_id: "onion", qty: 2, unit: "pc" },
      { ingredient_id: "onion", qty: 3, unit: "pc" },
      { ingredient_id: "flour-0000", qty: 2, unit: "cup" },
      { ingredient_id: "kaffir-lime-leaf", qty: 4, unit: "pc" },
    ],
    { cart_id: "cart-1", user_id: "user-a", plan_id: null, currency: "USD", now: NOW },
  );
  const onions = cart.lines.find((l) => l.ingredient_id === "onion")!;
  assert.equal(onions.packs, 5, "one line, five onions");
  assert.equal(cart.subtotal_cents, onions.line_total_cents);
  assert.deepEqual(cart.unmapped.map((u) => u.ingredient_id), ["flour-0000", "kaffir-lime-leaf"]);
  assert.match(cart.unmapped[1].reason, /does not stock/);
});

test("editing a cart cannot put more in it than the shop has", () => {
  const empty = cartFromWanted(index, [], { cart_id: "c", user_id: "u", plan_id: null, currency: "USD", now: NOW });
  const sku = index.byId.get("sku-merken-60g")!;
  const { cart, rejected } = editCart(empty, index, { add: [{ sku_id: sku.id, packs: sku.stock + 1 }] }, NOW);
  assert.equal(cart.lines.length, 0);
  assert.match(rejected[0].reason, /only \d+ left/);
});

test("the profile says what it is and does not claim to be conformance-tested", () => {
  const profile = ucpProfile(deps()) as { version: string; capabilities: string[]; disclaimer: string };
  assert.equal(profile.capabilities[0], "dev.ucp.shopping.checkout");
  assert.match(profile.disclaimer, /[Nn]ot conformance-tested/);
});

test("every allergen the catalog declares is one the disclosure knows how to group", () => {
  const vocabulary = new Set(["gluten", "soy", "sesame", "nuts", "peanut", "mustard", "sulphites", "celery"]);
  for (const a of allergensOf(catalog.skus)) assert.ok(vocabulary.has(a), `${a} is outside the vocabulary`);
});
