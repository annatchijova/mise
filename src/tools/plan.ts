// `plan_week`: one tool over the planner in src/plan/planner.ts.
//
// Everything interesting happens there. What happens here is the part that matters to the person
// standing in the kitchen: the plan is saved, so "what am I making Thursday" and `cart_from_plan`
// answer the same thing tomorrow, and every meal is read out with the reason the planner gave it
// rather than a reason invented on the way out.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Recipe } from "../recipes.ts";
import { displayName } from "../pantry/events.ts";
import type { PantryItem } from "../pantry/fold.ts";
import type { Resolver } from "../integrations/aliases.ts";
import { planWeek } from "../plan/planner.ts";
import { type PlanDiff, describe, diffPlans, movedChanges, weekdayOf } from "../plan/diff.ts";
import type { PlanStore } from "../plan/store.ts";

export type PlanDeps = {
  recipes: () => Recipe[];
  /** What a shopping line costs, from the same function the basket uses. Optional: without it the
   *  plan simply has no money in it, which is the honest state of a system with no shop. */
  priceOf?: (want: { ingredient_id: string; unit: string; qty: number | null }) => { cents: number } | { reason: string };
  currency?: string;
  plans: PlanStore;
  pantryItems: (userId: string, now: string) => Promise<PantryItem[]>;
  resolve: Resolver;
  userId: () => string | null;
  now: () => string;
};

const weekday = weekdayOf;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Which day of the plan a named weekday is, or null when the week being planned does not reach it. */
function dayNumberOf(name: string, startDate: string, days: number): number | null {
  const wanted = WEEKDAYS.indexOf(name);
  if (wanted === -1) return null;
  const start = new Date(Date.parse(`${startDate}T00:00:00Z`)).getUTCDay();
  const offset = (wanted - start + 7) % 7;
  return offset + 1 <= days ? offset + 1 : null;
}

/** Integer cents to something a person hears. The same shape as the store's, kept here so the
 *  planner's tools do not have to depend on the shop to say a number out loud. */
function moneyOf(cents: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${symbol}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** One line saying how the week differs from the last one, for `plan_week` to hand back without
 *  anybody having to ask for a diff. */
function changeSummary(diff: PlanDiff): string {
  const changes = movedChanges(diff);
  if (diff.identical) return "Same week as last time, down to the hash.";
  if (changes.length === 0) return "The meals are the same; only the shopping list moved.";
  const first = describe(changes[0]);
  const rest = changes.length - 1;
  return `${first}${rest > 0 ? ` And ${rest} other change${rest === 1 ? "" : "s"}; ask what changed for the rest.` : ""}`;
}

export function registerPlanTools(server: McpServer, deps: PlanDeps): void {
  server.registerTool(
    "plan_week",
    {
      title: "Plan the week's meals",
      description:
        "Build a meal plan from what is already in the kitchen, using what expires soonest first. Use when the customer asks to plan meals, asks what to cook this week, asks for dinners for the next few days, or asks what to do with what they have. Pass the time they have per meal when they say it, and anything they do not want to eat. Every meal comes back with the reason it is there, and the shopping list is consolidated across the week. Needs a linked account.",
      inputSchema: {
        days: z.number().int().min(1).max(14).describe("How many days to plan"),
        meals_per_day: z.number().int().min(1).max(3).optional().describe("1 = dinner, 2 = lunch and dinner, 3 = all three. Default 1"),
        time_budget_min: z.number().int().positive().optional().describe("Longest a meal may take, in minutes"),
        avoid: z.array(z.string()).optional().describe("Ingredients to keep out of the week, as the customer said them"),
        start_date: z.string().optional().describe("YYYY-MM-DD if they named a start; today otherwise"),
        day_limits: z.array(z.object({
          weekday: z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]).optional().describe("The day they named"),
          day: z.number().int().positive().optional().describe("Or the day's number in the plan, counting from 1"),
          minutes: z.number().int().positive().describe("Longest a meal may take that day"),
        })).optional().describe("Limits for particular days: 'Wednesday I get home late, twenty minutes'"),
        max_spend: z.number().positive().optional().describe("A ceiling on what the week's shopping may cost, in whole currency units (40 means forty dollars)"),
      },
      outputSchema: {
        plan_id: z.string(),
        plan_hash: z.string(),
        start_date: z.string(),
        days: z.number().int(),
        meals_per_day: z.number().int(),
        time_budget_min: z.number().int().nullable(),
        meals: z.array(
          z.object({
            day: z.number().int(), date: z.string(), weekday: z.string(), meal: z.string(),
            recipe_id: z.string(), title: z.string(), minutes: z.number().int(),
            why_code: z.enum(["expiring", "pantry", "thin"]), why: z.string(),
            uses_expiring: z.array(z.object({ ingredient_id: z.string(), days_to_expiry: z.number().int() })),
            missing: z.array(z.string()),
          }),
        ),
        missing: z.array(
          z.object({
            ingredient_id: z.string(), unit: z.string(), qty: z.number().nullable(), qty_known: z.boolean(),
            for_recipes: z.array(z.string()), topping_up: z.boolean(),
          }),
        ),
        /** Food that will go off before any meal could use it. The plan saying what it could not save. */
        unplaceable: z.array(z.object({ ingredient_id: z.string(), days_to_expiry: z.number().int(), reason: z.string() })),
        unfilled: z.array(z.object({ day: z.number().int(), date: z.string(), meal: z.string(), reason: z.string() })),
        /** Names the customer gave in `avoid` that we do not keep, so nothing is silently ignored. */
        unresolved_avoid: z.array(z.string()),
        pantry_as_of: z.string(),
        /** What the shopping list costs at the shop's prices, and what it could not price. null when
         *  there is no price list at all. */
        cost: z.object({
          shopping_cents: z.number().int(),
          shopping: z.string(),
          /** Lines the shop could not price, and why. The total is a floor, not an estimate. */
          unpriced: z.array(z.object({ ingredient_id: z.string(), reason: z.string() })),
          budget_cents: z.number().int().nullable(),
          over_by_cents: z.number().int().nullable(),
        }).nullable(),
        day_budgets: z.array(z.object({ day: z.number().int(), minutes: z.number().int() })),
        /** Day limits the customer named that fall outside the week being planned. */
        unused_day_limits: z.array(z.string()),
        /** The plan this one replaces, when there was one, and how it differs. */
        previous_plan_id: z.string().nullable(),
        changed_since_previous: z.string().nullable(),
        changes_since_previous: z.number().int().nullable(),
      },
      _meta: { ui: { resourceUri: "ui://mise/week-grid" } },
    },
    async (args) => {
      const userId = deps.userId();
      if (!userId) {
        return { isError: true, content: [{ type: "text", text: "Planning needs a linked account, because it plans around your pantry. Link Mise in the Alexa app and ask again." }] };
      }
      const now = deps.now();
      const pantry = await deps.pantryItems(userId, now);

      // An "avoid" we cannot resolve is reported, never dropped: silently planning a week around
      // something the person said to leave out is the worst failure this tool has.
      const avoid: string[] = [];
      const unresolvedAvoid: string[] = [];
      for (const raw of args.avoid ?? []) {
        const id = deps.resolve(raw);
        if (id) avoid.push(id);
        else unresolvedAvoid.push(raw);
      }

      // "Wednesday I get home late" arrives as a weekday, not as a day number. Which day of the
      // plan that is depends on when the plan starts, so it is resolved here, and a day the week
      // does not contain is reported rather than dropped.
      const start = args.start_date ?? now.slice(0, 10);
      const dayBudgets: { day: number; minutes: number }[] = [];
      const unusedDayLimits: string[] = [];
      for (const limit of args.day_limits ?? []) {
        const day = limit.day ?? (limit.weekday ? dayNumberOf(limit.weekday, start, args.days) : null);
        if (day === null || day < 1 || day > args.days) {
          unusedDayLimits.push(`${limit.weekday ?? `day ${limit.day ?? "?"}`} is not in the week being planned`);
          continue;
        }
        dayBudgets.push({ day, minutes: limit.minutes });
      }

      // Whole currency units in, integer cents kept. The one conversion, at the boundary.
      const budgetCents = args.max_spend === undefined ? null : Math.round(args.max_spend * 100);

      const plan = planWeek({
        recipes: deps.recipes(),
        pantry,
        now,
        days: args.days,
        meals_per_day: args.meals_per_day ?? 1,
        time_budget_min: args.time_budget_min ?? null,
        day_budgets: dayBudgets,
        avoid,
        start_date: args.start_date,
        priceOf: deps.priceOf,
        budget_cents: budgetCents,
      });
      // The plan this one replaces, read before it is stored. Replanning and being told nothing
      // changed but Thursday is the difference between a plan and a suggestion.
      const previous = await deps.plans.current(userId);
      await deps.plans.put(userId, plan);
      const diff = previous ? diffPlans(previous, plan) : null;

      const meals = plan.meals.map((m) => ({ ...m, weekday: weekday(m.date) }));
      const lines = meals.map((m) => `${weekday(m.date)}: ${m.title}, ${m.minutes} minutes — ${m.why}.`);
      const shop = plan.missing.length === 0
        ? " Nothing to buy."
        : ` To buy: ${plan.missing
            .slice(0, 12)
            .map((l) => `${l.qty_known && l.qty !== null ? `${l.qty}${l.unit === "pc" ? " " : ` ${l.unit} `}` : ""}${displayName(l.ingredient_id)}${l.topping_up ? " (you have some, not enough)" : ""}`)
            .join(", ")}${plan.missing.length > 12 ? `, and ${plan.missing.length - 12} more` : ""}.`;
      const lost = plan.unplaceable.length
        ? ` I could not find a meal for ${plan.unplaceable.map((u) => displayName(u.ingredient_id)).join(", ")} before ${plan.unplaceable.length === 1 ? "it goes" : "they go"} off.`
        : "";
      const gaps = plan.unfilled.length ? ` ${plan.unfilled.length} slot${plan.unfilled.length === 1 ? "" : "s"} left empty: ${plan.unfilled[0].reason}.` : "";
      const ignored = unresolvedAvoid.length ? ` I do not keep ${unresolvedAvoid.join(" or ")}, so I could not plan around ${unresolvedAvoid.length === 1 ? "it" : "them"}.` : "";
      const skippedLimits = unusedDayLimits.length ? ` I could not use ${unusedDayLimits.length} of the day limits: ${unusedDayLimits.join("; ")}.` : "";

      const currency = deps.currency ?? "USD";
      const priced = plan.cost === null ? "" : (() => {
        const total = ` The shopping comes to ${moneyOf(plan.cost.shopping_cents, currency)}`;
        const floor = plan.cost.unpriced.length
          ? `, and that is a floor: ${plan.cost.unpriced.length} line${plan.cost.unpriced.length === 1 ? "" : "s"} could not be priced — ${plan.cost.unpriced.slice(0, 3).map((u) => `${displayName(u.ingredient_id)}, because ${u.reason}`).join("; ")}.`
          : ".";
        const over = plan.cost.over_by_cents === null
          ? plan.cost.budget_cents === null ? "" : ` That is inside the ${moneyOf(plan.cost.budget_cents, currency)} you set.`
          : ` That is ${moneyOf(plan.cost.over_by_cents, currency)} over the ${moneyOf(plan.cost.budget_cents ?? 0, currency)} you set. I leaned the week towards cheaper meals and it still came out over.`;
        return `${total}${floor}${over}`;
      })();

      const since = diff === null ? "" : ` ${changeSummary(diff)}`;

      return {
        structuredContent: {
          ...plan, meals, unresolved_avoid: unresolvedAvoid,
          cost: plan.cost === null ? null : { ...plan.cost, shopping: moneyOf(plan.cost.shopping_cents, currency) },
          unused_day_limits: unusedDayLimits,
          previous_plan_id: previous?.plan_id ?? null,
          changed_since_previous: diff === null ? null : changeSummary(diff),
          changes_since_previous: diff === null ? null : movedChanges(diff).length,
        },
        content: [{ type: "text", text: `${lines.join(" ")}${shop}${priced}${lost}${gaps}${ignored}${skippedLimits}${since}` }],
      };
    },
  );

  server.registerTool(
    "plan_diff",
    {
      title: "What changed in the plan",
      description:
        "Say what is different between the current meal plan and the one before it, and why each meal moved. Use when the customer asks what changed, why a day is different, why they are not making what they thought, or what happened to the plan. Every reason is the one the planner recorded when it built the new week; nothing is invented about why the kitchen changed. Needs a linked account and two plans.",
      inputSchema: {
        from_plan_id: z.string().optional().describe("The older plan; the one before the current otherwise"),
        to_plan_id: z.string().optional().describe("The newer plan; the current one otherwise"),
      },
      outputSchema: {
        identical: z.boolean(),
        from: z.object({ plan_id: z.string(), plan_hash: z.string(), start_date: z.string(), days: z.number().int(), meals_per_day: z.number().int() }).nullable(),
        to: z.object({ plan_id: z.string(), plan_hash: z.string(), start_date: z.string(), days: z.number().int(), meals_per_day: z.number().int() }).nullable(),
        changes: z.array(z.object({ kind: z.enum(["moved", "replaced", "added", "dropped", "unchanged"]), sentence: z.string() })),
        /** What was asked for differently. Facts about the two requests, not guesses about the kitchen. */
        input_changes: z.array(z.string()),
        urgency_changes: z.array(z.object({ ingredient_id: z.string(), days_to_expiry: z.number().int().nullable(), now_urgent: z.boolean() })),
        shopping_added: z.array(z.string()),
        shopping_removed: z.array(z.string()),
      },
      _meta: { ui: { resourceUri: "ui://mise/week-grid" } },
    },
    async (args) => {
      const userId = deps.userId();
      if (!userId) return { isError: true, content: [{ type: "text", text: "This needs a linked account. Link Mise in the Alexa app and ask again." }] };

      const recent = await deps.plans.recent(userId, 2);
      const to = args.to_plan_id ? await deps.plans.get(userId, args.to_plan_id) : recent.at(-1) ?? null;
      const from = args.from_plan_id ? await deps.plans.get(userId, args.from_plan_id) : recent.length >= 2 ? recent[recent.length - 2] : null;
      if (!to || !from) {
        const text = to
          ? "There is only one plan so far, so there is nothing to compare it to yet."
          : "There is no plan yet. Ask me to plan the week first.";
        return {
          structuredContent: { identical: true, from: null, to: null, changes: [], input_changes: [], urgency_changes: [], shopping_added: [], shopping_removed: [] },
          content: [{ type: "text", text }],
        };
      }

      const diff = diffPlans(from, to);
      const changes = movedChanges(diff);
      const asked = diff.input_changes.length ? ` You asked for ${diff.input_changes.join(", and ")}.` : "";
      const urgent = diff.urgency_changes.filter((u) => u.now_urgent);
      const gone = diff.urgency_changes.filter((u) => !u.now_urgent);
      // Two facts, stated as facts. Why the kitchen changed is not something either plan witnessed.
      const deadlines = [
        urgent.length ? `${urgent.map((u) => displayName(u.ingredient_id)).join(", ")} ${urgent.length === 1 ? "is" : "are"} on a deadline now and ${urgent.length === 1 ? "was" : "were"} not before.` : "",
        gone.length ? `${gone.map((u) => displayName(u.ingredient_id)).join(", ")} ${gone.length === 1 ? "is" : "are"} no longer on a deadline.` : "",
      ].filter(Boolean).map((line) => line.charAt(0).toUpperCase() + line.slice(1)).join(" ");
      const shopping = diff.shopping.added.length
        ? ` ${diff.shopping.added.length} new thing${diff.shopping.added.length === 1 ? "" : "s"} on the shopping list: ${diff.shopping.added.slice(0, 6).map((l) => displayName(l.ingredient_id)).join(", ")}.`
        : "";

      const text = diff.identical
        ? "Nothing changed. Same meals, same order, same hash."
        : `${changes.length === 0 ? "The meals are the same; only the shopping list moved." : changes.map(describe).join(" ")}${asked}${deadlines ? ` ${deadlines}` : ""}${shopping}`;

      return {
        structuredContent: {
          identical: diff.identical,
          from: diff.from,
          to: diff.to,
          changes: changes.map((c) => ({ kind: c.kind, sentence: describe(c) })),
          input_changes: diff.input_changes,
          urgency_changes: diff.urgency_changes,
          shopping_added: diff.shopping.added.map((l) => l.ingredient_id),
          shopping_removed: diff.shopping.removed.map((l) => l.ingredient_id),
        },
        content: [{ type: "text", text }],
      };
    },
  );
}
