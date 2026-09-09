// The demo grocery's catalog, and the arithmetic of turning a shopping list into things you can buy.
//
// Two rules govern this file. **Money is integer cents, always.** A price that is a float is a price
// that eventually disagrees with itself, and a checkout that disagrees with itself about a total is
// not a checkout. **The catalog is the only source of prices.** A UCP Create call arrives with line
// items chosen by an agent; the amounts come from here, never from the request, or the store is one
// crafted payload away from selling everything for a cent.
//
// The mapping from an ingredient to a SKU is where honesty costs something. A recipe wanting 250 g
// of lentils maps cleanly onto a 500 g bag. A recipe wanting two cups of flour does not map onto a
// kilo bag without inventing a density, and a recipe wanting four slices of pumpkin does not map
// onto a whole pumpkin without inventing a pumpkin. Those come back as unmapped, with the reason,
// and the cart says so out loud — which is exactly what docs/PLAN.md asks the cart to report.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Unit, canonicalAmount, toMilli } from "../pantry/events.ts";
import { dataDir } from "../recipes.ts";

export type Allergen = "gluten" | "soy" | "sesame" | "nuts" | "peanut" | "mustard" | "sulphites" | "celery";

export type Sku = {
  id: string;
  title: string;
  ingredient_id: string;
  pack: { qty: number; unit: Unit };
  price_cents: number;
  stock: number;
  allergens: Allergen[];
};

export type StoreProfile = {
  name: string;
  merchant_of_record: string;
  refund_policy_url: string;
  /** Basis points, so 850 is 8.5%. Integer, like everything else about money here. */
  tax_rate_bps: number;
  shipping_cents: number;
  free_shipping_over_cents: number;
};

export type Catalog = {
  version: number;
  updated_on: string;
  currency: string;
  store: StoreProfile;
  skus: Sku[];
};

export function catalogFile(): string {
  return process.env.CATALOG_FILE ?? join(dataDir(), "catalog.json");
}

export function loadCatalog(file: string = catalogFile()): Catalog {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Catalog;
  return { ...raw, skus: [...raw.skus].sort((a, b) => a.id.localeCompare(b.id)) };
}

export type SkuIndex = { byId: Map<string, Sku>; byIngredient: Map<string, Sku[]> };

export function indexCatalog(catalog: Catalog): SkuIndex {
  const byId = new Map<string, Sku>();
  const byIngredient = new Map<string, Sku[]>();
  for (const sku of catalog.skus) {
    byId.set(sku.id, sku);
    const list = byIngredient.get(sku.ingredient_id) ?? [];
    list.push(sku);
    byIngredient.set(sku.ingredient_id, list);
  }
  // Cheapest first, then by id: the store's suggestion is stable and defensible.
  for (const list of byIngredient.values()) list.sort((a, b) => a.price_cents - b.price_cents || a.id.localeCompare(b.id));
  return { byId, byIngredient };
}

/** The pack in the ledger's units, so a comparison never crosses a unit it cannot cross. */
export function packMilli(sku: Sku): { qty_milli: number | null; unit: Unit } {
  return canonicalAmount(toMilli(sku.pack.qty), sku.pack.unit);
}

export type PackCount =
  | {
      ok: true; packs: number; covers_milli: number; unit: Unit;
      /** true when nobody said how much, so one pack was a decision rather than a calculation. */
      assumed_pack: boolean;
    }
  | { ok: false; reason: string };

/**
 * How many packs cover the amount wanted.
 *
 * Rounds up, because half a bag is not a thing the shop sells.
 *
 * The order of the two checks below is the whole design. **An amount nobody stated is answered with
 * one pack, whatever the units say.** Half the recipes in this book season "to taste", and a
 * shopping list that refuses to buy the curry powder because a jar is measured in grams and the
 * recipe is measured in willingness would be useless. One jar is the honest answer, and
 * `assumed_pack` says the number was a decision rather than a calculation.
 *
 * **An amount that was stated, in a unit the pack cannot be compared to, is refused.** Two cups of
 * flour against a one kilo bag needs a density, and guessing one to make a tidier basket is the
 * error this whole codebase is arranged against.
 */
export function packsFor(sku: Sku, wantedMilli: number | null, wantedUnit: Unit): PackCount {
  const pack = packMilli(sku);
  const wanted = canonicalAmount(wantedMilli, wantedUnit);
  if (pack.qty_milli === null || pack.qty_milli <= 0) return { ok: false, reason: "the SKU has no usable pack size" };
  if (wanted.qty_milli === null) {
    return { ok: true, packs: 1, covers_milli: pack.qty_milli, unit: pack.unit, assumed_pack: true };
  }
  if (pack.unit !== wanted.unit) {
    return {
      ok: false,
      reason: `the recipe wants ${wanted.qty_milli / 1000} ${wanted.unit} and the shop sells it by the ${pack.unit}; converting would mean guessing`,
    };
  }
  const packs = Math.max(1, Math.ceil(wanted.qty_milli / pack.qty_milli));
  return { ok: true, packs, covers_milli: packs * pack.qty_milli, unit: pack.unit, assumed_pack: false };
}

// --- money -----------------------------------------------------------------------------------

export function lineTotal(sku: Sku, packs: number): number {
  return sku.price_cents * packs;
}

/** Tax from basis points, rounded half up once, on the subtotal — never per line, which is how a
 *  receipt ends up a cent away from its own lines. */
export function taxCents(subtotalCents: number, rateBps: number): number {
  return Math.round((subtotalCents * rateBps) / 10_000);
}

export function shippingCents(subtotalCents: number, store: StoreProfile): number {
  if (subtotalCents === 0) return 0;
  return subtotalCents >= store.free_shipping_over_cents ? 0 : store.shipping_cents;
}

export type Totals = { subtotal_cents: number; tax_cents: number; shipping_cents: number; total_cents: number };

export function totalsFor(subtotal: number, store: StoreProfile): Totals {
  const tax = taxCents(subtotal, store.tax_rate_bps);
  const ship = shippingCents(subtotal, store);
  return { subtotal_cents: subtotal, tax_cents: tax, shipping_cents: ship, total_cents: subtotal + tax + ship };
}

/** Cents as a person reads them. Integer in, string out; no float in between. */
export function money(cents: number, currency = "USD"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${sign}${symbol}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Every allergen in a set of SKUs, sorted. What the checkout has to disclose. */
export function allergensOf(skus: Sku[]): Allergen[] {
  return [...new Set(skus.flatMap((s) => s.allergens))].sort();
}
