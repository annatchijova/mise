// A connected fridge, as a pantry source.
//
// HONESTY NOTE, and it is the point of this file. We do not have a Family Hub. The payload type
// below mirrors the *shape* of a SmartThings device-status response — `components.main.<capability>
// .<attribute>.value` — but the capability id and the food-list item fields are NOT verified against
// a real device; the public SmartThings docs we could reach do not pin them down. So this adapter is
// named `simulated`, it is what the demo drives, and block I.0 of docs/PLAN_INTEGRACIONES.es.md is
// the half-day with a real token that turns it into `smartthings`. When that happens, only
// FRIDGE_FOOD_LIST and the field names below should need to change — the event mapping is the same.
//
// A snapshot is a set of corrections, not additions. A fridge reports what it currently sees, so
// each item is an absolute restatement of that line. The consequence is worth stating plainly: a
// snapshot cannot say "the tomatoes are gone", only "here is what I see". Something that vanishes
// from the fridge ages out through `stale` in the fold; it is never removed on the fridge's say-so.
import { type PantryEvent, type Unit } from "../pantry/events.ts";
import { type PantrySource, type SourceContext, type SourceReading, type UnmappedItem } from "./types.ts";
import { normalizeName } from "./aliases.ts";

/** Unverified: the capability id a Family Hub actually exposes has to be confirmed against a device. */
export const FRIDGE_FOOD_LIST = "samsungce.fridgeFoodList";

export type FridgeFoodItem = {
  name: string;
  quantity?: number | null;
  unit?: string | null;
  /** YYYY-MM-DD. Absent whenever the fridge has no date for the item, which is most of the time. */
  expireDate?: string | null;
  location?: string | null;
};

export type FridgeStatus = {
  deviceId: string;
  components: {
    main: {
      [capability: string]: {
        foodList?: { value: FridgeFoodItem[] | null; timestamp: string };
      };
    };
  };
};

const UNITS = new Set<Unit>([
  "g", "kg", "ml", "l", "tsp", "tbsp", "cup", "pc",
  "clove", "pinch", "slice", "bunch", "can", "sachet", "to_taste",
]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function milliOf(quantity: number | null | undefined): number | null {
  if (quantity === null || quantity === undefined) return null;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const milli = Math.round(quantity * 1000);
  return Math.abs(milli / 1000 - quantity) > 1e-9 ? null : milli;
}

export const simulatedFridge: PantrySource<FridgeStatus> = {
  kind: "simulated",
  // A fridge observes; it does not confirm. Everything it reports is inferred, and `runSource`
  // enforces that even if a future version of this mapping forgets.
  maxConfidence: "inferred",

  toEvents(payload: FridgeStatus, ctx: SourceContext): SourceReading {
    const events: PantryEvent[] = [];
    const unmapped: UnmappedItem[] = [];
    const list = payload?.components?.main?.[FRIDGE_FOOD_LIST]?.foodList;
    const items = list?.value ?? [];
    // The reading's own timestamp is what makes redelivery idempotent; fall back to the fold clock
    // only when the device omitted it.
    const readingTs = list?.timestamp ?? ctx.now;

    items.forEach((item, index) => {
      const raw = (item?.name ?? "").trim();
      if (raw === "") {
        unmapped.push({ raw_name: "", reason: "the fridge reported an item with no name" });
        return;
      }
      const id = ctx.resolve(raw);
      if (id === null) {
        unmapped.push({ raw_name: raw, reason: "no canonical ingredient id for this name" });
        return;
      }
      const unit = (item.unit ?? "pc") as Unit;
      if (!UNITS.has(unit)) {
        unmapped.push({ raw_name: raw, reason: `unit '${item.unit}' is outside the vocabulary` });
        return;
      }
      const expires = item.expireDate && DATE.test(item.expireDate) ? item.expireDate : null;
      events.push({
        ts: readingTs,
        seq: index,
        type: "correct",
        ingredient_id: id,
        // A missing or unusable quantity stays null: "there is tofu", not "there is one tofu".
        qty_milli: milliOf(item.quantity),
        unit,
        origin: "simulated",
        confidence: "inferred",
        location: item.location?.trim() || "fridge",
        expires_on: expires,
        external_id: `${payload.deviceId}:${readingTs}:${normalizeName(raw)}`,
        source_device: payload.deviceId,
      });
    });

    return { events, unmapped };
  },
};
