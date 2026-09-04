// The ingest door: who may speak, whether we have heard this before, and what lands in the ledger.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildResolver, loadAliases } from "../src/integrations/aliases.ts";
import { type BarcodePayload, barcodeSource, candidateNames, parsePackage } from "../src/integrations/barcode.ts";
import { IDEMPOTENCY_HEADER, SIGNATURE_HEADER, type ConnectedSource, ingest, sign, verify } from "../src/integrations/ingest.ts";
import { simulatedFridge } from "../src/integrations/simulated_fridge.ts";
import { type PantrySource, runSource } from "../src/integrations/types.ts";
import { foldPantry } from "../src/pantry/fold.ts";
import { MemoryPantryStore } from "../src/pantry/store.ts";
import { loadRecipes } from "../src/recipes.ts";

const NOW = "2026-09-04T12:00:00.000Z";
const resolve = buildResolver(loadAliases(), new Set(loadRecipes().flatMap((r) => r.ingredients.map((i) => i.id))));
const reading = readFileSync(new URL("./fixtures/simulated_fridge_reading.json", import.meta.url), "utf8");
const offTofu = JSON.parse(readFileSync(new URL("./fixtures/off_product_tofu.json", import.meta.url), "utf8"));

const fridge: ConnectedSource = { id: "src-fridge", userId: "anna", kind: "simulated", secret: "s3cret", label: "Kitchen fridge" };
const scanner: ConnectedSource = { id: "src-scan", userId: "anna", kind: "barcode", secret: "other", label: "Phone scanner" };

function deps(store = new MemoryPantryStore()) {
  return {
    store,
    resolve,
    adapters: { simulated: simulatedFridge as PantrySource<unknown>, barcode: barcodeSource as PantrySource<unknown> },
    findSource: (id: string) => [fridge, scanner].find((s) => s.id === id),
    now: () => NOW,
  };
}

function headers(secret: string, body: string, key = "k-1") {
  return { [SIGNATURE_HEADER]: sign(secret, body), [IDEMPOTENCY_HEADER]: key };
}

test("signatures verify in constant time and reject anything else", () => {
  assert.equal(verify("s", "body", sign("s", "body")), true);
  assert.equal(verify("s", "body", sign("wrong", "body")), false);
  assert.equal(verify("s", "body", sign("s", "other body")), false);
  assert.equal(verify("s", "body", undefined), false);
  assert.equal(verify("s", "body", "sha256=abc"), false, "a shorter forgery is not compared byte by byte");
});

test("a valid signed delivery lands in the ledger with the source's origin and ceiling", async () => {
  const store = new MemoryPantryStore();
  const res = await ingest(deps(store), { sourceId: fridge.id, body: reading, headers: headers(fridge.secret, reading) });
  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, 5);
  assert.deepEqual(res.body.unmapped!.map((u) => u.raw_name).sort(), ["Kimchi", "Leftover pasta", "Rice"]);
  const events = await store.events("anna");
  assert.equal(events.length, 5);
  assert.ok(events.every((e) => e.origin === "simulated" && e.confidence === "inferred"));
});

test("a bad signature reads nothing and writes nothing", async () => {
  const store = new MemoryPantryStore();
  const res = await ingest(deps(store), { sourceId: fridge.id, body: reading, headers: headers("wrong", reading) });
  assert.equal(res.status, 401);
  assert.deepEqual(await store.events("anna"), []);
});

test("an unknown source is a 404 before any signature work", async () => {
  const res = await ingest(deps(), { sourceId: "nope", body: reading, headers: headers("x", reading) });
  assert.equal(res.status, 404);
});

test("a missing Idempotency-Key is refused: retries without one cannot be told apart", async () => {
  const res = await ingest(deps(), { sourceId: fridge.id, body: reading, headers: { [SIGNATURE_HEADER]: sign(fridge.secret, reading) } });
  assert.equal(res.status, 400);
});

test("the same delivery twice is accepted twice and stored once", async () => {
  const store = new MemoryPantryStore();
  const d = deps(store);
  const first = await ingest(d, { sourceId: fridge.id, body: reading, headers: headers(fridge.secret, reading, "k-7") });
  const second = await ingest(d, { sourceId: fridge.id, body: reading, headers: headers(fridge.secret, reading, "k-7") });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(second.body.replay, true);
  assert.equal(second.body.accepted, 0);
  assert.equal((await store.events("anna")).length, 5, "the replay appended nothing");
});

test("a reused key with a different body is a conflict, not a silent overwrite", async () => {
  const d = deps();
  const other = reading.replace("Carrots", "Parsnips");
  await ingest(d, { sourceId: fridge.id, body: reading, headers: headers(fridge.secret, reading, "k-9") });
  const res = await ingest(d, { sourceId: fridge.id, body: other, headers: headers(fridge.secret, other, "k-9") });
  assert.equal(res.status, 409);
});

test("a body that is not JSON is a 400 after the signature check, not a crash", async () => {
  const body = "not json";
  const res = await ingest(deps(), { sourceId: fridge.id, body, headers: headers(fridge.secret, body) });
  assert.equal(res.status, 400);
});

test("idempotency keys are scoped per user and source, so two sources may reuse a key", async () => {
  const store = new MemoryPantryStore();
  assert.equal(await store.rememberKey("anna:a", "k", "h1"), "new");
  assert.equal(await store.rememberKey("anna:b", "k", "h2"), "new");
  assert.equal(await store.rememberKey("anna:a", "k", "h1"), "replay");
  assert.equal(await store.rememberKey("anna:a", "k", "h9"), "conflict");
});

test("the store mirrors to a file and reloads it", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mise-store-"));
  try {
    const file = join(dir, "pantry.json");
    const a = new MemoryPantryStore(file);
    await ingest(deps(a), { sourceId: fridge.id, body: reading, headers: headers(fridge.secret, reading) });
    const b = new MemoryPantryStore(file);
    assert.equal((await b.events("anna")).length, 5);
    assert.equal(await b.rememberKey("anna:src-fridge", "k-1", "x"), "conflict", "keys survive the restart too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- barcode ---------------------------------------------------------------------------------

test("a package size is read only in the plain forms printed on labels", () => {
  assert.deepEqual(parsePackage("400 g"), [400000, "g"]);
  assert.deepEqual(parsePackage("1 L"), [1000, "l"]);
  assert.deepEqual(parsePackage("0,5 kg"), [500, "kg"]);
  assert.equal(parsePackage("6 x 33 cl"), null, "a multipack is not a single quantity");
  assert.equal(parsePackage("family size"), null);
  assert.equal(parsePackage(undefined), null);
});

test("candidate names go from the product name to the most specific category first", () => {
  assert.deepEqual(candidateNames(offTofu.product), ["Firm Tofu", "tofu", "legumes and their products", "plant based foods", "plant based foods and beverages"]);
});

test("a scanned product with a known count becomes a confirmed add with the package math done", () => {
  const payload: BarcodePayload = {
    scan: { ean: "0000000000017", scanned_at: "2026-09-04T09:30:00.000Z", packages: 2, location: "fridge", expires_on: "2026-09-20" },
    product: offTofu.product,
  };
  const { events, unmapped } = runSource(barcodeSource, payload, { userId: "anna", now: NOW, resolve });
  assert.equal(unmapped.length, 0);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.ingredient_id, "tofu");
  assert.equal(e.confidence, "confirmed", "a person held the package");
  assert.equal(e.qty_milli, 800000, "2 x 400 g");
  assert.equal(e.unit, "g");
  assert.equal(e.location, "fridge");
  assert.equal(e.expires_on, "2026-09-20");
  assert.equal(e.external_id, "barcode:0000000000017:2026-09-04T09:30:00.000Z");
});

test("a scan without a package count does not assume one package", () => {
  const payload: BarcodePayload = { scan: { ean: "0000000000017", scanned_at: NOW }, product: offTofu.product };
  const [e] = runSource(barcodeSource, payload, { userId: "anna", now: NOW, resolve }).events;
  assert.equal(e.qty_milli, null);
  assert.equal(e.unit, "g", "the unit is still known from the label, the amount is not");
});

test("a lookup failure or an unresolvable product is surfaced, never guessed", () => {
  const ctx = { userId: "anna", now: NOW, resolve };
  const missing = runSource(barcodeSource, { scan: { ean: "123", scanned_at: NOW }, product: null }, ctx);
  assert.equal(missing.events.length, 0);
  assert.match(missing.unmapped[0].reason, /not found|failed/);

  const weird = runSource(barcodeSource, {
    scan: { ean: "456", scanned_at: NOW },
    product: { product_name: "Fermented Shark", categories_tags: ["en:seafood", "en:fermented-fish"] },
  }, ctx);
  assert.equal(weird.events.length, 0);
  assert.match(weird.unmapped[0].reason, /Fermented Shark/);
});

test("a scanned package and a fridge reading of the same food fold to one honest line each", async () => {
  const store = new MemoryPantryStore();
  const d = deps(store);
  await ingest(d, { sourceId: fridge.id, body: reading, headers: headers(fridge.secret, reading, "f-1") });
  const scanBody = JSON.stringify({ scan: { ean: "0000000000017", scanned_at: "2026-09-04T09:30:00.000Z", packages: 1, location: "fridge" }, product: offTofu.product });
  await ingest(d, { sourceId: scanner.id, body: scanBody, headers: headers(scanner.secret, scanBody, "s-1") });
  const { items } = foldPantry(await store.events("anna"), { now: NOW });
  const tofu = items.filter((i) => i.ingredient_id === "tofu");
  // The fridge counted "1 pc" and the scan weighed "400 g": two units, two lines, no invented sum.
  assert.equal(tofu.length, 2);
  assert.deepEqual(tofu.map((t) => [t.unit, t.confidence, t.origins]).sort(), [["g", "confirmed", ["barcode"]], ["pc", "inferred", ["simulated"]]]);
});
