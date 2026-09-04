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
import type { PlanStore } from "../plan/store.ts";

export type PlanDeps = {
  recipes: () => Recipe[];
  plans: PlanStore;
  pantryItems: (userId: string, now: string) => Promise<PantryItem[]>;
  resolve: Resolver;
  userId: () => string | null;
  now: () => string;
};

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function weekday(date: string): string {
  return WEEKDAY[new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay()];
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

      const plan = planWeek({
        recipes: deps.recipes(),
        pantry,
        now,
        days: args.days,
        meals_per_day: args.meals_per_day ?? 1,
        time_budget_min: args.time_budget_min ?? null,
        avoid,
        start_date: args.start_date,
      });
      await deps.plans.put(userId, plan);

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

      return {
        structuredContent: { ...plan, meals, unresolved_avoid: unresolvedAvoid },
        content: [{ type: "text", text: `${lines.join(" ")}${shop}${lost}${gaps}${ignored}` }],
      };
    },
  );
}
