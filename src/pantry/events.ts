// The pantry ledger: what an event is, and the vocabularies it draws on.
//
// The pantry is an append-only ledger, not an inventory. Every integration in
// docs/PLAN_INTEGRACIONES.es.md — a fridge, a barcode scanner, a receipt app, a checkout — is a
// producer of these events and nothing more. None of them is an MCP tool, because none of them may
// sit on the Alexa+ response path.
//
// Quantities are integer thousandths of the unit (`qty_milli`). Floats never enter the ledger: a
// pantry is summed over and over, and 0.1 + 0.2 must not drift. Conversion happens at the boundary.

export type Unit =
  | "g" | "kg" | "ml" | "l" | "tsp" | "tbsp" | "cup" | "pc"
  | "clove" | "pinch" | "slice" | "bunch" | "can" | "sachet" | "to_taste";

/** Where the event came from. Adding an integration means adding an origin, never a new code path. */
export type Origin =
  | "voice" | "recipe_deduction" | "checkout" | "smartthings" | "barcode" | "receipt" | "import" | "simulated";

/** What an event may assert. `stale` is never stored — it is derived by the fold from the clock. */
export type StoredConfidence = "confirmed" | "inferred";
export type Confidence = StoredConfidence | "stale";

/** "fridge" | "freezer" | "pantry" | "other:<free text>" — the second fridge in the garage, the cabin. */
export type Location = string;

export type EventType = "add" | "consume" | "remove" | "correct";

export type PantryEvent = {
  /** ISO 8601 UTC. */
  ts: string;
  /** Tiebreaker within the same timestamp; ordering is (ts, seq). Keeps the fold deterministic. */
  seq: number;
  type: EventType;
  ingredient_id: string;
  /** Integer thousandths of `unit`. null means "some, amount unknown" — never zero, never guessed. */
  qty_milli: number | null;
  unit: Unit;
  origin: Origin;
  confidence: StoredConfidence;
  location: Location;
  /** YYYY-MM-DD, only when a source actually stated it. */
  expires_on: string | null;
  /** Stable id from the producing system; a repeat delivery with the same one is ignored. */
  external_id: string | null;
  source_device: string | null;
};

export const MILLI = 1000;

/** Units that are exactly a thousand of another unit. Nothing else belongs here: a cup of flour is
 *  not a number of grams without knowing the flour, and guessing the density is exactly the kind of
 *  invention the ledger refuses. */
const EXACT_MULTIPLES: Partial<Record<Unit, { unit: Unit; factor: number }>> = {
  kg: { unit: "g", factor: 1000 },
  l: { unit: "ml", factor: 1000 },
};

/**
 * Put an amount into the unit the ledger keeps it in.
 *
 * The fold keys a line on (ingredient, unit, location) and never converts, because most conversions
 * would be a guess. Two of them are not: a kilogram is a thousand grams and a litre is a thousand
 * millilitres, exactly, for every substance there is. Left unconverted, half a kilo of lentils and
 * the 250 g a recipe takes out are two lines that never meet, and cooking silently stops reducing
 * the pantry. So the conversion happens once, here, at the boundary where an amount becomes an
 * event — never inside the fold, which must stay a pure function of what it was given.
 */
export function canonicalAmount(qtyMilli: number | null, unit: Unit): { qty_milli: number | null; unit: Unit } {
  const conv = EXACT_MULTIPLES[unit];
  if (!conv) return { qty_milli: qtyMilli, unit };
  return { qty_milli: qtyMilli === null ? null : qtyMilli * conv.factor, unit: conv.unit };
}

/** Boundary conversion: a human quantity to integer milli-units. Rejects anything that would
 *  silently lose precision, because a pantry that rounds is a pantry that lies. */
export function toMilli(qty: number | null): number | null {
  if (qty === null) return null;
  if (!Number.isFinite(qty)) throw new RangeError(`quantity is not finite: ${qty}`);
  const milli = Math.round(qty * MILLI);
  if (Math.abs(milli / MILLI - qty) > 1e-9) throw new RangeError(`quantity needs more than milli precision: ${qty}`);
  return milli;
}

export function fromMilli(milli: number | null): number | null {
  return milli === null ? null : milli / MILLI;
}

/** Boundary conversion for a value a device reported: anything that is not a finite positive number
 *  representable in milli-units becomes null ("some, amount unknown"). Adapters use this; `toMilli`
 *  is for our own input, where imprecision is a bug rather than a fact about the source. */
export function milliOrNull(qty: unknown): number | null {
  if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) return null;
  const milli = Math.round(qty * MILLI);
  return Math.abs(milli / MILLI - qty) > 1e-9 ? null : milli;
}

/** An ISO 8601 timestamp with a date part and a time part that Date.parse accepts. The date-part
 *  check keeps "today", "1725000000" and a bare date from passing as timestamps. */
export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

/** A real YYYY-MM-DD calendar date. Round-trips through Date so that 2026-13-45 is rejected, not
 *  merely shaped correctly. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/** Canonical id to a readable English name: "flour-0000" -> "flour 0000". */
export function displayName(id: string): string {
  return id.replace(/-/g, " ");
}

const CONFIDENCE_RANK: Record<Confidence, number> = { confirmed: 3, inferred: 2, stale: 1 };

/** The weaker of two confidences. Mixing a confirmed and an inferred event yields inferred:
 *  a total is only as certain as its least certain part. */
export function weaker(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/** Whole days from `from` to `to`, both YYYY-MM-DD, as an integer. Negative means already past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new RangeError(`not a YYYY-MM-DD date: ${from} / ${to}`);
  return Math.round((b - a) / 86_400_000);
}

/** The UTC calendar day an ISO timestamp falls on. */
export function dayOf(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new RangeError(`not an ISO timestamp: ${iso}`);
  return new Date(t).toISOString().slice(0, 10);
}
