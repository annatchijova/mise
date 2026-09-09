// The fold: an event log becomes the pantry you can ask about.
//
// Deterministic by construction — the same events and the same `now` produce the same items in the
// same order, with the same integer quantities. Three honesty rules are enforced here rather than
// left to the narrator:
//
//   1. An unknown quantity stays unknown. If any contributing event carried no number, the total is
//      `qty: null, qty_known: false`. It is never rendered as zero and never guessed.
//   2. A total is only as certain as its least certain part (see `weaker`).
//   3. `stale` is derived from the clock, not stored. An item nobody has confirmed in N days says so.
import {
  type Confidence, type Location, type PantryEvent, type Unit,
  dayOf, daysBetween, fromMilli, isIsoDate, isIsoTimestamp, weaker,
} from "./events.ts";

export type Freshness = "expired" | "urgent" | "soon" | "fresh" | "unknown";

export type PantryItem = {
  ingredient_id: string;
  unit: Unit;
  location: Location;
  /** null when the amount is genuinely unknown. Callers must not substitute a number. */
  qty: number | null;
  qty_known: boolean;
  confidence: Confidence;
  /** Days since the newest event that still contributes to this line. */
  age_days: number;
  expires_on: string | null;
  days_to_expiry: number | null;
  freshness: Freshness;
  origins: string[];
  last_event_ts: string;
};

export type FoldOptions = {
  /** Clock for the fold. ISO 8601. */
  now: string;
  /** After this many days without a confirming event, an item is reported as `stale`. */
  staleAfterDays?: number;
  /** Expiry buckets, in days. Defaults: urgent within 1, soon within 3. */
  urgentWithinDays?: number;
  soonWithinDays?: number;
};

export type FoldResult = {
  items: PantryItem[];
  /** Events skipped because their external_id had already been folded. Idempotency, made visible. */
  duplicates: number;
  /** Events skipped because their timestamp or expiry date is not a valid ISO value. Adapters
   *  validate at the boundary, so this should stay zero; when it does not, the pantry still answers
   *  and says how many events it could not use, instead of failing every read on one bad record. */
  invalid: number;
};

type Bucket = {
  ingredient_id: string;
  unit: Unit;
  location: Location;
  milli: number;
  known: boolean;
  present: boolean;
  confidence: Confidence;
  expires_on: string | null;
  origins: Set<string>;
  last_ts: string;
};

/** One line of the pantry is one (ingredient, unit, location). Units are never converted into each
 *  other: 2 cups of flour and 500 g of flour are two honest lines, not one invented sum. */
function key(e: { ingredient_id: string; unit: Unit; location: Location }): string {
  return [e.ingredient_id, e.unit, e.location].join("|");
}

function freshnessOf(days: number | null, urgent: number, soon: number): Freshness {
  if (days === null) return "unknown";
  if (days < 0) return "expired";
  if (days <= urgent) return "urgent";
  if (days <= soon) return "soon";
  return "fresh";
}

/** Reset a line to "we know nothing about this yet". */
function reset(e: PantryEvent): Bucket {
  return {
    ingredient_id: e.ingredient_id, unit: e.unit, location: e.location,
    milli: 0, known: true, present: false,
    confidence: e.confidence,
    expires_on: null, origins: new Set<string>(), last_ts: e.ts,
  };
}

export function foldPantry(events: PantryEvent[], opts: FoldOptions): FoldResult {
  const staleAfter = opts.staleAfterDays ?? 7;
  const urgent = opts.urgentWithinDays ?? 1;
  const soon = opts.soonWithinDays ?? 3;
  const today = dayOf(opts.now);

  // Stable total order. Two producers can share a timestamp; (ts, seq, external_id, ingredient)
  // breaks every tie the same way on every machine.
  const ordered = [...events].sort(
    (a, b) =>
      a.ts.localeCompare(b.ts) ||
      a.seq - b.seq ||
      (a.external_id ?? "").localeCompare(b.external_id ?? "") ||
      a.ingredient_id.localeCompare(b.ingredient_id),
  );

  const seen = new Set<string>();
  const buckets = new Map<string, Bucket>();
  let duplicates = 0;
  let invalid = 0;

  for (const e of ordered) {
    if (!isIsoTimestamp(e.ts) || (e.expires_on !== null && !isIsoDate(e.expires_on))) {
      invalid++;
      continue;
    }
    if (e.external_id !== null) {
      // A fridge that reports the same reading twice, or a webhook delivered twice, must not double
      // the pantry. Same guarantee as the UCP Idempotency-Key, one layer down.
      if (seen.has(e.external_id)) { duplicates++; continue; }
      seen.add(e.external_id);
    }
    const k = key(e);
    let b = buckets.get(k);
    if (!b) { b = reset(e); buckets.set(k, b); }

    if (e.type === "remove") {
      // The item is gone. Not "zero of it" — gone, along with everything we believed about it.
      const fresh = reset(e);
      fresh.origins.add(e.origin);
      buckets.set(k, fresh);
      continue;
    }

    if (e.type === "correct") {
      // An absolute restatement by whoever is correcting. It supersedes this line's history.
      const fresh = reset(e);
      fresh.present = true;
      fresh.known = e.qty_milli !== null;
      fresh.milli = e.qty_milli ?? 0;
      fresh.confidence = e.confidence;
      fresh.expires_on = e.expires_on;
      fresh.origins.add(e.origin);
      fresh.last_ts = e.ts;
      buckets.set(k, fresh);
      continue;
    }

    // A new purchase after a known depletion starts a new batch. Partial consumption and
    // unknown quantities keep their history: neither proves the old food is gone.
    if (e.type === "add" && b.present && b.known && b.milli === 0 && b.unit !== "to_taste") {
      b = reset(e);
      buckets.set(k, b);
    }

    // add / consume
    b.present = true;
    b.origins.add(e.origin);
    b.last_ts = e.ts;
    b.confidence = weaker(b.confidence, e.confidence);
    if (e.qty_milli === null || !b.known) {
      // Honest degradation: once any part of the total is unknown, the total is unknown.
      b.known = false;
      b.milli = 0;
    } else {
      b.milli += e.type === "add" ? e.qty_milli : -e.qty_milli;
      if (b.milli < 0) b.milli = 0;
    }
    if (e.expires_on !== null) {
      b.expires_on = b.expires_on === null || e.expires_on < b.expires_on ? e.expires_on : b.expires_on;
    }
  }

  const items: PantryItem[] = [];
  for (const b of buckets.values()) {
    if (!b.present) continue;
    if (b.known && b.milli === 0 && b.unit !== "to_taste") continue; // used up
    const age = daysBetween(dayOf(b.last_ts), today);
    const confidence: Confidence = age >= staleAfter ? "stale" : b.confidence;
    const daysToExpiry = b.expires_on === null ? null : daysBetween(today, b.expires_on);
    items.push({
      ingredient_id: b.ingredient_id,
      unit: b.unit,
      location: b.location,
      qty: b.known ? fromMilli(b.milli) : null,
      qty_known: b.known,
      confidence,
      age_days: age,
      expires_on: b.expires_on,
      days_to_expiry: daysToExpiry,
      freshness: freshnessOf(daysToExpiry, urgent, soon),
      origins: [...b.origins].sort(),
      last_event_ts: b.last_ts,
    });
  }

  // What is about to go off comes first; the rest alphabetically. Nothing depends on insertion order.
  const rank: Record<Freshness, number> = { expired: 0, urgent: 1, soon: 2, fresh: 3, unknown: 4 };
  items.sort(
    (a, b) =>
      rank[a.freshness] - rank[b.freshness] ||
      (a.days_to_expiry ?? 9999) - (b.days_to_expiry ?? 9999) ||
      a.ingredient_id.localeCompare(b.ingredient_id) ||
      a.location.localeCompare(b.location) ||
      a.unit.localeCompare(b.unit),
  );
  return { items, duplicates, invalid };
}
