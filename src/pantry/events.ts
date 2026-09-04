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
