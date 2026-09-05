// The tables, served as data anybody can use.
//
// The recipes have been leaving the building as `schema.org/Recipe` JSON-LD since block I. The three
// curated tables never had a door at all, and they are the more unusual artefact: nobody publishes a
// machine-readable table of *(ingredient, role, technique) → alternatives with ratios and failure
// modes*, or of what does not multiply when you double a recipe. They are worth more outside this
// repository than inside it.
//
// Two rules for what goes out. **Everything published carries its provenance** — version, the date
// it was last touched, who wrote it, the licence, and a link to the contract that describes it — so
// a copy of the file is still attributable to somebody a year from now. And **the caveats travel
// with the data**: the shelf-life document says in its own body that the numbers are estimates
// nobody measured, because that warning being in `docs/BLOCKED.md` is no use at all to a person who
// downloaded the JSON.
import type { PlanResult } from "./plan/planner.ts";
import type { Cart } from "./store/cart.ts";

export const DATA_LICENSE = "Apache-2.0";

export type Published = {
  path: string;
  title: string;
  /** What it is, for the index page and for anybody deciding whether to fetch it. */
  summary: string;
  /** The contract that describes the shape, relative to the repository root. */
  schema_doc: string;
  /** Said in the document itself, not only in the docs. */
  caveat: string | null;
};

export const PUBLISHED: Published[] = [
  {
    path: "/data/substitutions.json",
    title: "Substitution table",
    summary:
      "What to use instead of what, keyed on (ingredient, role, technique), with an integer ratio, what changes, and what breaks. Rows with no alternatives are answers too.",
    schema_doc: "docs/SUBSTITUTION_SCHEMA.md",
    caveat:
      "This is one cook's judgment, not a consensus. Every ratio and every warning is the author's own and has not been tested by anybody else. The version field moves whenever a row's advice changes, so a disagreement can be about a specific version of a specific row.",
  },
  {
    path: "/data/shelf-life.json",
    title: "Shelf-life table",
    summary: "How long each food keeps, by where it is kept. Used to schedule, never to certify.",
    schema_doc: "docs/SHELF_LIFE_SCHEMA.md",
    caveat:
      "Every number here is an estimate from ordinary kitchen practice and NOBODY HAS MEASURED ANY OF THEM. They are safe to schedule around and they are not a food safety authority: do not use them to decide whether something is safe to eat. The short rows — anything under a week — deserve a second opinion before you rely on them, and the garlic-in-oil row is there because garlic under oil at room temperature is a real botulism risk rather than because the number is precise.",
  },
  {
    path: "/data/scaling.json",
    title: "Scaling table",
    summary:
      "What happens to an amount when the servings change: seasoning scales at less than the full rate, leavening oddly, and some techniques are limited by the pan rather than by the recipe.",
    schema_doc: "docs/SCALING_SCHEMA.md",
    caveat:
      "Damping is a proportion somebody chose, not a measurement. It is deliberately conservative — the aim is a doubled pot that needs correcting upwards rather than one nobody can eat.",
  },
];

export type PublishOptions = { baseUrl: string; repository?: string };

/**
 * Wrap a table for publication.
 *
 * The table's own fields are passed through untouched — a consumer diffing against the file in the
 * repository should see the same rows — with a `_published` block added and the internal `_comment`
 * removed, since it is a note to whoever edits the file rather than to whoever reads it.
 */
export function publish(table: Record<string, unknown>, meta: Published, opts: PublishOptions): unknown {
  const { _comment, ...rest } = table as Record<string, unknown> & { _comment?: string };
  void _comment;
  return {
    _published: {
      title: meta.title,
      summary: meta.summary,
      license: DATA_LICENSE,
      canonical_url: `${opts.baseUrl}${meta.path}`,
      schema: meta.schema_doc,
      repository: opts.repository ?? null,
      // The warning goes in the payload, because a caveat that lives only in a repository somebody
      // did not clone has not been given to them.
      caveat: meta.caveat,
      retrieved_at: new Date().toISOString(),
    },
    ...rest,
  };
}

/** Integer cents to the decimal string schema.org expects. Formatting, not arithmetic. */
function priceOf(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * The week's shopping as a `schema.org/ItemList`.
 *
 * The same trick the recipes use, in the other direction: a grocery app that imports a list can
 * import ours, and somebody who does not want the demo store still gets something useful out of the
 * planner.
 *
 * What the shop could not supply is **in the list**, as an item with no offer and the reason in its
 * description. A shopping list that silently drops the pumpkin is worse than no shopping list, and
 * that is as true of the exported one as of the spoken one.
 */
export function shoppingListJsonLd(plan: PlanResult, cart: Cart, opts: { baseUrl: string }): unknown {
  const elements: unknown[] = [];
  let position = 0;

  for (const line of cart.lines) {
    position += 1;
    elements.push({
      "@type": "ListItem",
      position,
      item: {
        "@type": "Product",
        name: line.title,
        sku: line.sku_id,
        ...(line.allergens.length > 0 ? { description: `Contains ${line.allergens.join(", ")}.` } : {}),
        offers: {
          "@type": "Offer",
          price: priceOf(line.unit_price_cents),
          priceCurrency: cart.currency,
          eligibleQuantity: { "@type": "QuantitativeValue", value: line.packs, unitText: "pack" },
        },
      },
    });
  }

  for (const line of cart.unmapped) {
    position += 1;
    elements.push({
      "@type": "ListItem",
      position,
      item: {
        "@type": "Product",
        name: line.ingredient_id.replace(/-/g, " "),
        description: `Not available from this shop: ${line.reason}.`,
        ...(line.qty !== null ? { additionalProperty: { "@type": "PropertyValue", name: "quantity", value: line.qty, unitText: line.unit } } : {}),
      },
    });
  }

  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Shopping list for the week of ${plan.start_date}`,
    description:
      `Built from what was already in the kitchen. ${cart.unmapped.length} item${cart.unmapped.length === 1 ? "" : "s"} could not be supplied by the shop and ${cart.unmapped.length === 1 ? "is" : "are"} listed without an offer rather than dropped.`,
    numberOfItems: elements.length,
    itemListOrder: "https://schema.org/ItemListUnordered",
    identifier: plan.plan_id,
    url: `${opts.baseUrl}/recipes`,
    itemListElement: elements,
  };
}
