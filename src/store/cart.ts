// The cart: a shopping list that has been priced.
//
// It is deliberately not a total — the totals belong to the checkout session, computed server-side
// at Create, because that is where UCP says they are decided and because a cart that quotes tax is a
// cart that will one day quote it wrong. What lives here is what to buy, how many packs of it, at
// what price each, and — just as important — what could not be turned into something the shop sells.
import { readFileSync, writeFileSync } from "node:fs";

import type { Unit } from "../pantry/events.ts";
import { type Allergen, type SkuIndex, lineTotal, packsFor } from "./catalog.ts";

export type CartLine = {
  sku_id: string;
  title: string;
  ingredient_id: string;
  /** Packs, not grams. The shop sells packs. */
  packs: number;
  unit_price_cents: number;
  line_total_cents: number;
  /** What those packs actually cover, which is usually more than the recipe needed. */
  covers_qty: number;
  covers_unit: Unit;
  allergens: Allergen[];
  /** One pack, chosen because the recipe never said how much. Worth saying out loud. */
  assumed_pack: boolean;
};

export type UnmappedLine = {
  ingredient_id: string;
  qty: number | null;
  unit: Unit;
  reason: string;
};

export type Cart = {
  cart_id: string;
  user_id: string;
  plan_id: string | null;
  currency: string;
  lines: CartLine[];
  unmapped: UnmappedLine[];
  subtotal_cents: number;
  updated_at: string;
};

export type WantedLine = { ingredient_id: string; qty: number | null; unit: Unit };

function recalc(cart: Cart): Cart {
  const lines = [...cart.lines].sort((a, b) => a.ingredient_id.localeCompare(b.ingredient_id) || a.sku_id.localeCompare(b.sku_id));
  return { ...cart, lines, subtotal_cents: lines.reduce((sum, l) => sum + l.line_total_cents, 0) };
}

function lineFor(index: SkuIndex, want: WantedLine): CartLine | UnmappedLine {
  const candidates = index.byIngredient.get(want.ingredient_id) ?? [];
  if (candidates.length === 0) return { ...want, reason: "the shop does not stock it" };

  const reasons: string[] = [];
  for (const sku of candidates) {
    const count = packsFor(sku, want.qty === null ? null : Math.round(want.qty * 1000), want.unit);
    if (!count.ok) { reasons.push(count.reason); continue; }
    if (sku.stock < count.packs) { reasons.push(`only ${sku.stock} of ${sku.title} left`); continue; }
    return {
      sku_id: sku.id,
      title: sku.title,
      ingredient_id: sku.ingredient_id,
      packs: count.packs,
      unit_price_cents: sku.price_cents,
      line_total_cents: lineTotal(sku, count.packs),
      covers_qty: count.covers_milli / 1000,
      covers_unit: count.unit,
      allergens: sku.allergens,
      assumed_pack: count.assumed_pack,
    };
  }
  return { ...want, reason: reasons[0] ?? "no SKU fits" };
}

export function isUnmapped(line: CartLine | UnmappedLine): line is UnmappedLine {
  return "reason" in line;
}

/** Build a cart from a shopping list. Nothing is dropped: what cannot be bought is reported. */
export function cartFromWanted(
  index: SkuIndex,
  wanted: WantedLine[],
  meta: { cart_id: string; user_id: string; plan_id: string | null; currency: string; now: string },
): Cart {
  const lines: CartLine[] = [];
  const unmapped: UnmappedLine[] = [];
  for (const want of wanted) {
    const line = lineFor(index, want);
    if (isUnmapped(line)) { unmapped.push(line); continue; }
    // Two recipes wanting the same SKU are one line with more packs, not two lines.
    const existing = lines.find((l) => l.sku_id === line.sku_id);
    if (existing) {
      existing.packs += line.packs;
      existing.line_total_cents = existing.unit_price_cents * existing.packs;
      existing.covers_qty += line.covers_qty;
    } else lines.push(line);
  }
  return recalc({
    cart_id: meta.cart_id, user_id: meta.user_id, plan_id: meta.plan_id, currency: meta.currency,
    lines, unmapped: unmapped.sort((a, b) => a.ingredient_id.localeCompare(b.ingredient_id)),
    subtotal_cents: 0, updated_at: meta.now,
  });
}

export type CartEdit = {
  /** SKU ids to add, or ingredient names already resolved to ids by the caller. */
  add?: { sku_id: string; packs?: number }[];
  remove?: string[];
  set_packs?: { sku_id: string; packs: number }[];
};

export type EditResult = { cart: Cart; rejected: { sku_id: string; reason: string }[] };

export function editCart(cart: Cart, index: SkuIndex, edit: CartEdit, now: string): EditResult {
  const lines = cart.lines.map((l) => ({ ...l }));
  const rejected: EditResult["rejected"] = [];

  for (const add of edit.add ?? []) {
    const sku = index.byId.get(add.sku_id);
    if (!sku) { rejected.push({ sku_id: add.sku_id, reason: "no such item in the shop" }); continue; }
    const packs = Math.max(1, Math.floor(add.packs ?? 1));
    const existing = lines.find((l) => l.sku_id === sku.id);
    const total = (existing?.packs ?? 0) + packs;
    if (total > sku.stock) { rejected.push({ sku_id: sku.id, reason: `only ${sku.stock} left` }); continue; }
    if (existing) {
      existing.packs = total;
      existing.line_total_cents = existing.unit_price_cents * total;
    } else {
      const pack = packsFor(sku, null, sku.pack.unit);
      lines.push({
        sku_id: sku.id, title: sku.title, ingredient_id: sku.ingredient_id, packs,
        unit_price_cents: sku.price_cents, line_total_cents: sku.price_cents * packs,
        covers_qty: (pack.ok ? pack.covers_milli : 0) * packs / 1000,
        covers_unit: pack.ok ? pack.unit : sku.pack.unit,
        allergens: sku.allergens,
        assumed_pack: false,
      });
    }
  }

  for (const skuId of edit.remove ?? []) {
    const at = lines.findIndex((l) => l.sku_id === skuId);
    if (at === -1) { rejected.push({ sku_id: skuId, reason: "it was not in the cart" }); continue; }
    lines.splice(at, 1);
  }

  for (const set of edit.set_packs ?? []) {
    const line = lines.find((l) => l.sku_id === set.sku_id);
    if (!line) { rejected.push({ sku_id: set.sku_id, reason: "it was not in the cart" }); continue; }
    const sku = index.byId.get(set.sku_id)!;
    const packs = Math.floor(set.packs);
    if (packs <= 0) { lines.splice(lines.indexOf(line), 1); continue; }
    if (packs > sku.stock) { rejected.push({ sku_id: set.sku_id, reason: `only ${sku.stock} left` }); continue; }
    line.packs = packs;
    line.line_total_cents = line.unit_price_cents * packs;
  }

  return { cart: recalc({ ...cart, lines, updated_at: now }), rejected };
}

// --- where carts live --------------------------------------------------------------------------

export type CartStore = {
  current(userId: string): Promise<Cart | null>;
  get(userId: string, cartId: string): Promise<Cart | null>;
  put(cart: Cart): Promise<void>;
};

export class MemoryCartStore implements CartStore {
  private byUser = new Map<string, Cart[]>();
  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (file) this.load();
  }

  async current(userId: string): Promise<Cart | null> {
    return (this.byUser.get(userId) ?? []).at(-1) ?? null;
  }

  async get(userId: string, cartId: string): Promise<Cart | null> {
    return (this.byUser.get(userId) ?? []).find((c) => c.cart_id === cartId) ?? null;
  }

  async put(cart: Cart): Promise<void> {
    const list = (this.byUser.get(cart.user_id) ?? []).filter((c) => c.cart_id !== cart.cart_id);
    list.push(cart);
    this.byUser.set(cart.user_id, list);
    this.persist();
  }

  snapshot(): Record<string, Cart[]> {
    return Object.fromEntries([...this.byUser].map(([u, c]) => [u, [...c]]));
  }

  private persist(): void {
    if (!this.file) return;
    writeFileSync(this.file, JSON.stringify(this.snapshot(), null, 2), "utf8");
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file!, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const [u, carts] of Object.entries(JSON.parse(raw) as Record<string, Cart[]>)) this.byUser.set(u, carts);
  }
}
