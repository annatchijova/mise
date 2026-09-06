// `cart_from_plan` and `cart_edit`: the two tools between the week's plan and the checkout.
//
// Checkout itself is not a tool. Alexa+ drives the UCP surface directly when the person says they
// want to buy; what these tools do is leave a cart sitting there with the right SKU ids in it, so
// that `line_items` has something true to carry. Everything either tool says about what could not
// be bought is said out loud, because a shopping list that silently drops the pumpkin is worse than
// no shopping list.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { displayName, type Unit } from "../pantry/events.ts";
import type { Resolver } from "../integrations/aliases.ts";
import type { PlanStore } from "../plan/store.ts";
import { type Catalog, type SkuIndex, money } from "../store/catalog.ts";
import { type CartStore, type WantedLine, cartFromWanted, editCart } from "../store/cart.ts";
import { shoppingListJsonLd } from "../open_data.ts";

export type CartDeps = {
  catalog: Catalog;
  index: SkuIndex;
  carts: CartStore;
  plans: PlanStore;
  resolve: Resolver;
  userId: () => string | null;
  now: () => string;
  newId: () => string;
  /** The public origin, for the exported list's own links. */
  baseUrl: string;
};

const NEEDS_ACCOUNT = "The cart hangs off your account. Link Mise in the Alexa app and ask again.";

const CART_SCHEMA = {
  cart: z
    .object({
      cart_id: z.string(),
      plan_id: z.string().nullable(),
      currency: z.string(),
      lines: z.array(
        z.object({
          sku_id: z.string(), title: z.string(), ingredient_id: z.string(), packs: z.number().int(),
          unit_price_cents: z.number().int(), line_total_cents: z.number().int(),
          covers_qty: z.number(), covers_unit: z.string(), allergens: z.array(z.string()),
          assumed_pack: z.boolean(),
        }),
      ),
      /** What the shopping list wanted that this shop cannot sell, with the reason. */
      unmapped: z.array(z.object({ ingredient_id: z.string(), qty: z.number().nullable(), unit: z.string(), reason: z.string() })),
      subtotal_cents: z.number().int(),
      updated_at: z.string(),
    })
    .nullable(),
  subtotal: z.string(),
};

export function registerCartTools(server: McpServer, deps: CartDeps): void {
  const uiCart = { ui: { resourceUri: "ui://mise/cart" } };

  server.registerTool(
    "cart_from_plan",
    {
      title: "Fill the basket from the plan",
      description:
        "Turn the week's shopping list into a basket of things the shop actually sells. Use when the customer says to order what is missing, to buy the ingredients, or to shop for the plan. Give days when they only want part of the week ('just for Thursday'). Says which items the shop cannot supply and why, rather than quietly leaving them out. Needs a linked account and a plan made first.",
      inputSchema: {
        plan_id: z.string().optional().describe("A specific plan; the most recent one otherwise"),
        days: z.array(z.number().int().positive()).optional().describe("Day numbers from the plan, when they only want some of the week"),
      },
      outputSchema: {
        ...CART_SCHEMA,
        plan_id: z.string().nullable(),
        for_days: z.array(z.number().int()),
        /** The same list as a schema.org ItemList, so a grocery app that imports a list can import
         *  this one. What the shop could not supply is in it, without an offer and with the reason. */
        item_list: z.unknown(),
      },
      _meta: uiCart,
    },
    async (args) => {
      const userId = deps.userId();
      if (!userId) return { isError: true, content: [{ type: "text", text: NEEDS_ACCOUNT }] };
      const plan = args.plan_id ? await deps.plans.get(userId, args.plan_id) : await deps.plans.current(userId);
      if (!plan) {
        return { isError: true, content: [{ type: "text", text: "There is no plan to shop for yet. Ask me to plan the week first." }] };
      }

      const days = args.days && args.days.length > 0 ? [...new Set(args.days)].sort((a, b) => a - b) : plan.meals.map((m) => m.day);
      const dayRecipes = new Set(plan.meals.filter((m) => days.includes(m.day)).map((m) => m.recipe_id));
      const wanted: WantedLine[] = plan.missing
        .filter((l) => l.for_recipes.some((r) => dayRecipes.has(r)))
        .map((l) => ({ ingredient_id: l.ingredient_id, qty: l.qty, unit: l.unit as Unit }));

      const cart = cartFromWanted(deps.index, wanted, {
        cart_id: deps.newId(), user_id: userId, plan_id: plan.plan_id, currency: deps.catalog.currency, now: deps.now(),
      });
      await deps.carts.put(cart);

      const list = cart.lines.map((l) => `${l.packs > 1 ? `${l.packs} × ` : ""}${l.title}${l.assumed_pack ? " (one, because the recipe does not say how much)" : ""}`).join(", ");
      const cannot = cart.unmapped.length
        ? ` I could not buy ${cart.unmapped.map((u) => `${displayName(u.ingredient_id)} (${u.reason})`).join(", ")}.`
        : "";
      const text = cart.lines.length === 0
        ? `Nothing to buy for ${days.length === plan.meals.length ? "the plan" : `${days.length} of the days`}.${cannot}`
        : `${cart.lines.length} item${cart.lines.length === 1 ? "" : "s"}, ${money(cart.subtotal_cents, cart.currency)} before tax and delivery: ${list}.${cannot}`;

      return {
        structuredContent: {
          cart, subtotal: money(cart.subtotal_cents, cart.currency), plan_id: plan.plan_id, for_days: days,
          item_list: shoppingListJsonLd(plan, cart, { baseUrl: deps.baseUrl }),
        },
        content: [{ type: "text", text }],
      };
    },
  );

  server.registerTool(
    "cart_edit",
    {
      title: "Change the basket",
      description:
        "Add to, remove from, or change the amounts in the basket. Use when the customer says to add something, take something out, or that they want more or fewer of an item. Items can be named as food ('add two bags of lentils') or by the shop's item id. Says back anything it could not do and why. Needs a linked account.",
      inputSchema: {
        add: z.array(z.object({
          item: z.string().describe("A food name or a shop item id"),
          packs: z.number().int().positive().optional().describe("How many packs; one otherwise"),
        })).optional(),
        remove: z.array(z.string()).optional().describe("Food names or shop item ids to take out"),
        set_packs: z.array(z.object({ item: z.string(), packs: z.number().int().min(0) })).optional().describe("Set an exact number of packs; zero removes it"),
      },
      outputSchema: {
        ...CART_SCHEMA,
        rejected: z.array(z.object({ item: z.string(), reason: z.string() })),
      },
      _meta: uiCart,
    },
    async (args) => {
      const userId = deps.userId();
      if (!userId) return { isError: true, content: [{ type: "text", text: NEEDS_ACCOUNT }] };
      const cart = await deps.carts.current(userId);
      if (!cart) {
        return { isError: true, content: [{ type: "text", text: "There is no basket yet. Ask me to shop for the plan first, or tell me what to put in one." }] };
      }

      const rejected: { item: string; reason: string }[] = [];
      /** A shop item id, or the cheapest SKU for a food the customer named. */
      const toSku = (item: string): string | null => {
        if (deps.index.byId.has(item)) return item;
        const ingredient = deps.resolve(item);
        if (!ingredient) { rejected.push({ item, reason: "I do not know that food" }); return null; }
        const skus = deps.index.byIngredient.get(ingredient);
        if (!skus || skus.length === 0) { rejected.push({ item, reason: "the shop does not stock it" }); return null; }
        return skus[0].id;
      };

      const add: { sku_id: string; packs?: number }[] = [];
      for (const a of args.add ?? []) {
        const sku = toSku(a.item);
        if (sku !== null) add.push({ sku_id: sku, packs: a.packs });
      }
      const remove = (args.remove ?? []).map(toSku).filter((s): s is string => s !== null);
      const setPacks = (args.set_packs ?? []).map((s) => ({ sku_id: toSku(s.item), packs: s.packs })).filter((s): s is { sku_id: string; packs: number } => s.sku_id !== null);

      const result = editCart(cart, deps.index, { add, remove, set_packs: setPacks }, deps.now());
      await deps.carts.put(result.cart);
      for (const r of result.rejected) rejected.push({ item: deps.index.byId.get(r.sku_id)?.title ?? r.sku_id, reason: r.reason });

      const said = result.cart.lines.length === 0
        ? "The basket is empty now."
        : `${result.cart.lines.length} item${result.cart.lines.length === 1 ? "" : "s"}, ${money(result.cart.subtotal_cents, result.cart.currency)} before tax and delivery.`;
      const no = rejected.length ? ` I could not do ${rejected.map((r) => `${r.item} (${r.reason})`).join(", ")}.` : "";

      return {
        structuredContent: { cart: result.cart, subtotal: money(result.cart.subtotal_cents, result.cart.currency), rejected },
        content: [{ type: "text", text: `${said}${no}` }],
      };
    },
  );
}
