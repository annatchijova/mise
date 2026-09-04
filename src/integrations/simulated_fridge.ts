// A connected fridge, as a pantry source.
//
// HONESTY NOTE, and it is the point of this file. We do not have a Family Hub. The payload type
// below mirrors the *shape* of a SmartThings device-status response — `components.main.<capability>
// .<attribute>.value` — but the capability id and the food-list item fields are NOT verified against
// a real device; the public SmartThings docs we could reach do not pin them down. So this adapter is
// named `simulated`, it is what the demo drives, and block I.0 of docs/INTEGRATIONS_PLAN.md is the
// half-day with a real token that turns it into `smartthings`. When that happens, only
// FRIDGE_FOOD_LIST and the field names below should need to change — the event mapping is the same.
//
// A snapshot is a set of corrections, not additions. A fridge reports what it currently sees, so
// each item is an absolute restatement of that line. The consequence is worth stating plainly: a
// snapshot cannot say "the tomatoes are gone", only "here is what I see". Something that vanishes
// from the fridge ages out through `stale` in the fold; it is never removed on the fridge's say-so.
//
// Everything a device sends is validated here, at the boundary, because the ledger is append-only
// and a bad timestamp that gets in would break every later read of this pantry.
import { type PantryEvent, type Unit, isIsoDate, isIsoTimestamp, milliOrNull } from "../pantry/events.ts";
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

export const simulatedFridge: PantrySource<FridgeStatus> = {
  kind: "simulated",
  // A fridge observes; it does not confirm. Everything it reports is inferred, and `runSource`
  // enforces that even if a future version of this mapping forgets.
  maxConfidence: "inferred",

  toEvents(payload: FridgeStatus, ctx: SourceContext): SourceReading {
    const events: PantryEvent[] = [];
    const unmapped: UnmappedItem[] = [];
    const deviceId = typeof payload?.deviceId === "string" && payload.deviceId.trim() ? payload.deviceId.trim() : null;
    if (!deviceId) return { events, unmapped: [{ raw_name: "", reason: "the report carries no deviceId" }] };

    const list = payload?.components?.main?.[FRIDGE_FOOD_LIST]?.foodList;
    const items = Array.isArray(list?.value) ? list.value : [];
    // The reading's own timestamp is what makes redelivery idempotent; fall back to the fold clock
    // only when the device omitted it. A timestamp that is present but not a timestamp rejects the
    // whole reading: it would poison every event in it.
    const readingTs = list?.timestamp === undefined || list.timestamp === null || list.timestamp === "" ? ctx.now : list.timestamp;
    if (!isIsoTimestamp(readingTs)) {
      return { events, unmapped: [{ raw_name: String(readingTs), reason: "the reading's timestamp is not an ISO 8601 timestamp; the whole reading was rejected" }] };
    }

    items.forEach((item, index) => {
      const raw = typeof item?.name === "string" ? item.name.trim() : "";
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
        unmapped.push({ raw_name: raw, reason: `unit '${String(item.unit)}' is outside the vocabulary` });
        return;
      }
      // A date the device got wrong is dropped, and said so: the item is still real, its date is not.
      let expires: string | null = null;
      if (item.expireDate !== undefined && item.expireDate !== null && item.expireDate !== "") {
        if (isIsoDate(item.expireDate)) expires = item.expireDate;
        else unmapped.push({ raw_name: raw, reason: `expireDate '${String(item.expireDate)}' is not a YYYY-MM-DD date; the item was kept without a date` });
      }
      events.push({
        ts: readingTs,
        seq: index,
        type: "correct",
        ingredient_id: id,
        // A missing or unusable quantity stays null: "there is tofu", not "there is one tofu".
        qty_milli: milliOrNull(item.quantity),
        unit,
        origin: "simulated",
        confidence: "inferred",
        location: typeof item.location === "string" && item.location.trim() ? item.location.trim() : "fridge",
        expires_on: expires,
        // The index is part of the id: a fridge that lists two packages of the same food reports two
        // lines, and both must survive the fold's dedupe.
        external_id: `${deviceId}:${readingTs}:${index}:${normalizeName(raw)}`,
        source_device: deviceId,
      });
    });

    return { events, unmapped };
  },
};
