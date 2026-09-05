// The six cooking tools.
//
// They live in their own module rather than inside `buildServer` for one reason: everything they do
// that matters is in `src/cook/session.ts`, and these registrations should stay thin enough that
// somebody reading them can see that. Each handler resolves the account, loads the session, calls
// one pure transition, saves the result, and turns it into a sentence. No decision is taken here.
//
// The division of labour with Alexa+ is the same as everywhere else: it hears "I already did the
// onions" and passes the words through; the server decides, deterministically and conservatively,
// which step that was — or decides it cannot tell, and says so.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Recipe } from "../recipes.ts";
import { displayName } from "../pantry/events.ts";
import type { PantryStore } from "../pantry/store.ts";
import type { Resolver } from "../integrations/aliases.ts";
import {
  type CookSession, type SessionView, type TimerView,
  advance, consumptionEvents, finish, misePlace, note, orderedSteps, pause, startSession, view,
} from "../cook/session.ts";
import type { CookStore } from "../cook/store.ts";
import { postMortem, spanText } from "../cook/postmortem.ts";
import { type Scaling, scalingWarnings } from "../cook/scaling.ts";

export type CookDeps = {
  recipeById: (id: string) => Recipe | undefined;
  sessions: CookStore;
  pantry: PantryStore;
  resolve: Resolver;
  /** The linked account, or null while there is none. */
  userId: () => string | null;
  now: () => string;
  newId: () => string;
  /** How amounts behave when the servings change. Optional: without it everything multiplies
   *  straight, which is what this did before there was a table. */
  scaling?: Scaling;
};

const NEEDS_ACCOUNT = "This needs a linked account, because it has to remember where you were. Link Mise in the Alexa app and ask again.";

function mcpError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/** Seconds as a person would say them. Not rounded to zero: "under a minute" is information. */
function durationText(s: number): string {
  if (s <= 0) return "no time at all";
  if (s < 60) return `${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h} hour${h === 1 ? "" : "s"}${rest ? ` ${rest} minutes` : ""}`;
}

/** What to say about the clocks that are running, if anything. */
function timerSentence(timers: TimerView[]): string {
  const live = timers.filter((t) => t.state !== "stopped");
  if (live.length === 0) return "";
  return ` ${live
    .map((t) => {
      const what = `step ${t.step}`;
      if (t.state === "done") return `The timer on ${what} is up${t.overdue_s > 0 ? `, ${durationText(t.overdue_s)} ago` : ""}.`;
      if (t.state === "paused") return `The timer on ${what} is holding at ${durationText(t.remaining_s)} left.`;
      return `${durationText(t.remaining_s)} left on ${what}.`;
    })
    .join(" ")}`;
}

function stepSentence(v: SessionView): string {
  if (v.step === null) return "";
  const dur = v.step.dur_s > 0 ? ` About ${durationText(v.step.dur_s)}.` : "";
  const hedge = v.step.dur_source === "estimated" ? " That time is my estimate, not the book's." : "";
  return `Step ${v.step.order} of ${v.step.of}: ${v.step.text}${dur}${hedge}`;
}

/** The shape every cook tool returns, so the four views can rely on one contract. */
const SESSION_SCHEMA = {
  session: z
    .object({
      session_id: z.string(),
      recipe_id: z.string(),
      state: z.enum(["mise_en_place", "cooking", "paused", "finished", "abandoned"]),
      servings: z.number().int(),
      step: z
        .object({
          order: z.number().int(), of: z.number().int(), text: z.string(), text_es: z.string(),
          dur_s: z.number().int(), dur_source: z.string(), timer: z.boolean(), depends_on: z.array(z.number().int()),
        })
        .nullable(),
      completed_steps: z.array(z.number().int()),
      remaining_steps: z.array(z.number().int()),
      timers: z.array(
        z.object({
          step: z.number().int(), label: z.string(), duration_s: z.number().int(),
          elapsed_s: z.number().int(), remaining_s: z.number().int(), overdue_s: z.number().int(),
          state: z.enum(["running", "paused", "done", "stopped"]),
        }),
      ),
      deviations: z.array(z.object({ at: z.string(), step: z.number().int(), kind: z.string(), what: z.string() })),
      substitutions: z.array(z.object({ at: z.string(), step: z.number().int(), instead_of: z.string(), used: z.string() })),
      started_at: z.string(), updated_at: z.string(), elapsed_s: z.number().int(),
    })
    .nullable(),
};

export function registerCookTools(server: McpServer, deps: CookDeps): void {
  const uiStepCard = { ui: { resourceUri: "ui://mise/step-card" } };

  /** Load the active session together with its recipe, or say why neither is there. */
  async function activeWithRecipe(userId: string): Promise<{ session: CookSession; recipe: Recipe } | string> {
    const session = await deps.sessions.active(userId);
    if (!session) return "Nothing is on the go right now. Tell me what you want to cook and I'll start it.";
    const recipe = deps.recipeById(session.recipe_id);
    if (!recipe) return `The session points at a recipe I no longer have (${session.recipe_id}). I would rather stop than improvise a step.`;
    return { session, recipe };
  }

  /** Finishing is the one transition with a consequence outside the session: it writes to the
   *  pantry. Every event is inferred and carries the session id, so a repeated call folds to the
   *  same pantry instead of eating the lentils twice. */
  async function close(session: CookSession, recipe: Recipe, now: string) {
    const already = session.state === "finished";
    const finished = finish(session, recipe, now);
    await deps.sessions.put(finished);
    if (already) return { session: finished, deducted: [], skipped: [] as { ingredient_id: string; reason: string }[] };
    const { events, skipped } = consumptionEvents(finished, recipe, now, deps.scaling);
    await deps.pantry.append(finished.user_id, events);
    return {
      session: finished,
      deducted: events.map((e) => ({ ingredient_id: e.ingredient_id, qty: e.qty_milli === null ? null : e.qty_milli / 1000, unit: e.unit })),
      skipped,
    };
  }

  server.registerTool(
    "cook_start",
    {
      title: "Start cooking",
      description:
        "Begin cooking a recipe: read out the mise en place and hold the place from step to step. Use when the customer says they want to cook something now, says 'let's make the lentils', or asks you to walk them through a recipe. Pass servings when they say how many people. If they are already cooking something else, this says so instead of dropping it. Needs a linked account.",
      inputSchema: {
        recipe_id: z.string().describe("The recipe id, from recipe_search"),
        servings: z.number().int().positive().optional().describe("How many people, when they said"),
        abandon_other: z.boolean().optional().describe("Only after the customer has confirmed they are giving up on the session already in progress"),
      },
      outputSchema: {
        ...SESSION_SCHEMA,
        started: z.boolean(),
        /** True when they were already cooking this and we simply handed the place back. */
        resumed: z.boolean(),
        blocked_by: z.object({ session_id: z.string(), recipe_id: z.string(), step: z.number().int() }).nullable(),
        mise_en_place: z.array(
          z.object({
            ingredient_id: z.string(), qty: z.number().nullable(), unit: z.string(),
            note: z.string().nullable(), qty_source: z.string(), role: z.string(),
            /** The amount was scaled at less than the full rate. Say so, or it reads as a mistake. */
            damped: z.boolean(), scaling_note: z.string().nullable(),
          }),
        ),
        /** What scaling this far up does that no amount can express — the pan, the tin, the bowl. */
        scaling_warnings: z.array(z.string()),
      },
      _meta: uiStepCard,
    },
    async (args) => {
      const userId = deps.userId();
      if (!userId) return mcpError(NEEDS_ACCOUNT);
      const recipe = deps.recipeById(args.recipe_id);
      if (!recipe) return mcpError(`I do not have a recipe with the id ${args.recipe_id}. Search first and give me the id it returns.`);
      const now = deps.now();

      const existing = await deps.sessions.active(userId);
      if (existing && existing.recipe_id === recipe.id) {
        const v = view(existing, recipe, now);
        return {
          structuredContent: { session: v, started: false, resumed: true, blocked_by: null, mise_en_place: misePlace(recipe, existing.servings, deps.scaling), scaling_warnings: [] },
          content: [{ type: "text", text: `You are already cooking this. ${stepSentence(v) || "You are still on the mise en place."}${timerSentence(v.timers)}` }],
        };
      }
      if (existing && !args.abandon_other) {
        const other = deps.recipeById(existing.recipe_id);
        return {
          structuredContent: {
            session: view(existing, other ?? recipe, now),
            started: false, resumed: false,
            blocked_by: { session_id: existing.id, recipe_id: existing.recipe_id, step: existing.current_step },
            mise_en_place: [],
            scaling_warnings: [],
          },
          content: [{
            type: "text",
            text: `There is already a session going: ${other?.title ?? existing.recipe_id}, at step ${existing.current_step}. Do you want to leave that one and start ${recipe.title}?`,
          }],
        };
      }
      if (existing && args.abandon_other) {
        const other = deps.recipeById(existing.recipe_id);
        await deps.sessions.put(finish({ ...existing, state: "cooking" }, other ?? recipe, now));
      }

      const session = startSession({ id: deps.newId(), userId, recipe, servings: args.servings, now });
      await deps.sessions.put(session);
      const mise = misePlace(recipe, session.servings, deps.scaling);
      const warnings = deps.scaling
        ? scalingWarnings(recipe.ingredients.map((i) => ({ id: i.id, role: i.role, technique: i.technique })), session.servings, recipe.serves, deps.scaling)
        : [];
      const v = view(session, recipe, now);
      const first = orderedSteps(recipe)[0];
      const list = mise
        .map((m) => `${m.qty === null ? "" : `${m.qty}${m.unit === "pc" ? " " : ` ${m.unit} `}`}${displayName(m.ingredient_id)}${m.qty === null ? " (the book does not say how much)" : ""}`)
        .join(", ");
      const dampedItems = mise.filter((m) => m.damped);
      const scaled = session.servings !== recipe.serves
        ? ` Scaled from ${recipe.serves} to ${session.servings}.${dampedItems.length ? ` The ${dampedItems.map((m) => displayName(m.ingredient_id)).join(", ")} did not scale straight — seasoning compounds, so it goes up by less than the rest.` : ""}`
        : "";
      const pan = warnings.length ? ` ${warnings.map((w) => w.text).join(" ")}` : "";
      const text = `${recipe.title}, ${session.servings} serving${session.servings === 1 ? "" : "s"}.${scaled}${pan} Get out: ${list}. When you are ready, say next and we start with: ${first?.text ?? "the first step"}`;
      return {
        structuredContent: { session: v, started: true, resumed: false, blocked_by: null, mise_en_place: mise, scaling_warnings: warnings.map((w) => w.text) },
        content: [{ type: "text", text }],
      };
    },
  );

  server.registerTool(
    "cook_next",
    {
      title: "Next cooking step",
      description:
        "Move the cooking session on to the next step. Use when the customer says they finished a step, asks what is next, or says done, ready, ok, next. Pass what they said as completed_hint when they named what they did ('I already did the onions') — if that turns out to be a different step it is recorded as a deviation, not treated as a mistake. Needs a linked account.",
      inputSchema: {
        completed_hint: z.string().optional().describe("What the customer said they finished, in their words"),
      },
      outputSchema: {
        ...SESSION_SCHEMA,
        finished: z.boolean(),
        /** Set when the hint pointed at a step other than the current one. */
        deviation: z.object({ at: z.string(), step: z.number().int(), kind: z.string(), what: z.string() }).nullable(),
        /** True when the hint was heard but could not be pinned to one step. Ask; do not guess. */
        unmatched_hint: z.boolean(),
        deducted: z.array(z.object({ ingredient_id: z.string(), qty: z.number().nullable(), unit: z.string() })),
        skipped: z.array(z.object({ ingredient_id: z.string(), reason: z.string() })),
      },
      _meta: uiStepCard,
    },
    async (args) => {
      const userId = deps.userId();
      if (!userId) return mcpError(NEEDS_ACCOUNT);
      const found = await activeWithRecipe(userId);
      if (typeof found === "string") return mcpError(found);
      const now = deps.now();

      const result = advance(found.session, found.recipe, { now, completed_hint: args.completed_hint });
      await deps.sessions.put(result.session);

      if (result.finished) {
        const closed = await close(result.session, found.recipe, now);
        const v = view(closed.session, found.recipe, now);
        const left = closed.skipped.length ? ` I left ${closed.skipped.map((s) => displayName(s.ingredient_id)).join(", ")} out of the count — measured to taste.` : "";
        return {
          structuredContent: { session: v, finished: true, deviation: result.deviation, unmatched_hint: result.unmatched_hint, deducted: closed.deducted, skipped: closed.skipped },
          content: [{ type: "text", text: `That was the last step — ${found.recipe.title} is done. I have taken what it used out of the pantry, marked as my own reckoning rather than yours.${left}` }],
        };
      }

      const v = view(result.session, found.recipe, now);
      const aside = result.unmatched_hint
        ? " I could not tell which step you meant, so I have written it down and left the order alone."
        : result.deviation
          ? ` Noted that you did step ${result.deviation.what.match(/step (\d+)/)?.[1] ?? "another one"} already.`
          : "";
      return {
        structuredContent: { session: v, finished: false, deviation: result.deviation, unmatched_hint: result.unmatched_hint, deducted: [], skipped: [] },
        content: [{ type: "text", text: `${aside}${aside ? " " : ""}${stepSentence(v)}${timerSentence(v.timers)}`.trim() }],
      };
    },
  );

  server.registerTool(
    "cook_where_am_i",
    {
      title: "Where was I",
      description:
        "Say where the cooking session stands: which step, which timers, how long it has been. Use when the customer comes back after a break and asks where they were, what step they are on, how long is left, or what they were doing. Answers across sessions and devices. Needs a linked account.",
      inputSchema: {},
      outputSchema: { ...SESSION_SCHEMA, recipe_title: z.string().nullable() },
      _meta: uiStepCard,
    },
    async () => {
      const userId = deps.userId();
      if (!userId) return mcpError(NEEDS_ACCOUNT);
      const found = await activeWithRecipe(userId);
      if (typeof found === "string") {
        return { structuredContent: { session: null, recipe_title: null }, content: [{ type: "text", text: found }] };
      }
      const now = deps.now();
      const v = view(found.session, found.recipe, now);
      const away = ` It has been ${durationText(v.elapsed_s)} since you started.`;
      const where = v.state === "paused" ? "You paused" : v.state === "mise_en_place" ? "You had not started the steps yet" : "You are";
      const text = `${where} on ${found.recipe.title}. ${stepSentence(v)}${timerSentence(v.timers)}${away}`;
      return { structuredContent: { session: v, recipe_title: found.recipe.title }, content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "cook_note",
    {
      title: "Note something about the cooking",
      description:
        "Record something the customer says about what they are cooking — a change they made, a swap, a remark. Use when they say they used something else, changed an amount, or want you to remember something ('I used chickpeas instead of lentils', 'I doubled the garlic'). When they named a swap, pass both ingredients so the pantry count at the end follows what they actually used. Needs a linked account.",
      inputSchema: {
        note: z.string().describe("What they said, in their words"),
        used: z.string().optional().describe("The ingredient they actually used, when they named a swap"),
        instead_of: z.string().optional().describe("The ingredient the recipe asked for, when they named a swap"),
      },
      outputSchema: {
        ...SESSION_SCHEMA,
        deviation: z.object({ at: z.string(), step: z.number().int(), kind: z.string(), what: z.string() }),
        substitution: z.object({ instead_of: z.string(), used: z.string() }).nullable(),
        unresolved: z.array(z.string()),
      },
    },
    async (args) => {
      const userId = deps.userId();
      if (!userId) return mcpError(NEEDS_ACCOUNT);
      const found = await activeWithRecipe(userId);
      if (typeof found === "string") return mcpError(found);
      const now = deps.now();

      // A swap only becomes a swap when both names resolve to ingredients we keep. Half a swap
      // would deduct the wrong thing, so it degrades to a plain note and says which name failed.
      const used = args.used ? deps.resolve(args.used) : null;
      const insteadOf = args.instead_of ? deps.resolve(args.instead_of) : null;
      const unresolved = [
        ...(args.used && !used ? [args.used] : []),
        ...(args.instead_of && !insteadOf ? [args.instead_of] : []),
      ];
      const swap = used && insteadOf ? { used, instead_of: insteadOf } : null;

      const { session, deviation } = note(found.session, { now, note: args.note, used: swap?.used, instead_of: swap?.instead_of });
      await deps.sessions.put(session);
      const v = view(session, found.recipe, now);
      const said = swap
        ? `Noted: ${displayName(swap.used)} instead of ${displayName(swap.instead_of)}. I will count that against the ${displayName(swap.used)} when you finish, and leave the ${displayName(swap.instead_of)} alone.`
        : unresolved.length
          ? `Written down. I do not keep ${unresolved.join(" or ")}, so I have left the pantry count as the recipe has it.`
          : "Written down.";
      return {
        structuredContent: { session: v, deviation, substitution: swap, unresolved },
        content: [{ type: "text", text: said }],
      };
    },
  );

  server.registerTool(
    "cook_pause",
    {
      title: "Pause the cooking",
      description:
        "Stop the clock on the cooking session and keep the place. Use when the customer says pause, hold on, stop for now, or that they have to go. Nothing is lost: the timers hold where they are and 'where was I' brings it all back later, on any device. Needs a linked account.",
      inputSchema: {},
      outputSchema: SESSION_SCHEMA,
    },
    async () => {
      const userId = deps.userId();
      if (!userId) return mcpError(NEEDS_ACCOUNT);
      const found = await activeWithRecipe(userId);
      if (typeof found === "string") return mcpError(found);
      const now = deps.now();
      const paused = pause(found.session, now);
      await deps.sessions.put(paused);
      const v = view(paused, found.recipe, now);
      const held = v.timers.filter((t) => t.state === "paused");
      const text = `Paused at step ${v.step?.order ?? 0}.${held.length ? ` ${held.length === 1 ? "The timer is" : "The timers are"} holding.` : ""} Ask where you were whenever you come back.`;
      return { structuredContent: { session: v }, content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "cook_review",
    {
      title: "What happened while cooking",
      description:
        "Read back what actually happened during a cook: how long each step really took, where the time went, what was done out of order, what was swapped. Use when the customer asks why something took so long, why it turned out the way it did, what they changed, or how the cooking went. It answers from the session's own record and says plainly which questions that record cannot answer. Reads only. Needs a linked account.",
      inputSchema: {
        session_id: z.string().optional().describe("A particular cook; the most recent one otherwise"),
      },
      outputSchema: {
        session_id: z.string().nullable(),
        recipe_id: z.string().nullable(),
        title: z.string().nullable(),
        state: z.string().nullable(),
        total: z.string().nullable(),
        total_s: z.number().int().nullable(),
        cooking_s: z.number().int().nullable(),
        paused_s: z.number().int().nullable(),
        estimated_s: z.number().int().nullable(),
        steps: z.array(
          z.object({
            order: z.number().int(), text: z.string(),
            started_at: z.string().nullable(), finished_at: z.string().nullable(),
            actual_s: z.number().int().nullable(), estimated_s: z.number().int(), dur_source: z.string(),
            over_by_s: z.number().int().nullable(), completions: z.number().int(),
          }),
        ),
        repeated_steps: z.array(z.number().int()),
        deviations: z.array(z.object({ at: z.string(), step: z.number().int(), kind: z.string(), what: z.string() })),
        substitutions: z.array(z.object({ at: z.string(), step: z.number().int(), instead_of: z.string(), used: z.string() })),
        /** Sentences derived from recorded times and transitions, and from nothing else. */
        observations: z.array(z.string()),
        /** What the record did not witness, with the reason. The honest half of the answer. */
        cannot_say: z.array(z.string()),
      },
    },
    async (args) => {
      const userId = deps.userId();
      if (!userId) return mcpError(NEEDS_ACCOUNT);
      const history = await deps.sessions.history(userId);
      const session = args.session_id ? history.find((s) => s.id === args.session_id) ?? null : history[0] ?? null;
      const empty = {
        session_id: null, recipe_id: null, title: null, state: null, total: null,
        total_s: null, cooking_s: null, paused_s: null, estimated_s: null,
        steps: [], repeated_steps: [], deviations: [], substitutions: [], observations: [], cannot_say: [],
      };
      if (!session) {
        return { structuredContent: empty, content: [{ type: "text", text: "There is no cook on record to look back at yet." }] };
      }
      const recipe = deps.recipeById(session.recipe_id);
      if (!recipe) {
        return { structuredContent: empty, content: [{ type: "text", text: `That session cooked ${session.recipe_id}, which I no longer have, so I cannot line the steps up against it.` }] };
      }

      const review = postMortem(session, recipe, deps.now());
      const spoken = `${review.title}. ${review.observations.join(" ")} What I cannot tell you: ${review.cannot_say[0]}`;
      return {
        structuredContent: {
          session_id: review.session_id, recipe_id: review.recipe_id, title: review.title, state: review.state,
          total: spanText(review.total_s),
          total_s: review.total_s, cooking_s: review.cooking_s, paused_s: review.paused_s, estimated_s: review.estimated_s,
          steps: review.steps, repeated_steps: review.repeated_steps,
          deviations: review.deviations, substitutions: review.substitutions,
          observations: review.observations, cannot_say: review.cannot_say,
        },
        content: [{ type: "text", text: spoken }],
      };
    },
  );

  server.registerTool(
    "cook_finish",
    {
      title: "Finish the cooking",
      description:
        "Close the cooking session and take what it used out of the pantry. Use when the customer says they are done, it is finished, they are eating, or they want to stop early. Amounts come off as inferred, never as something the customer confirmed, and anything measured to taste is left alone. Needs a linked account.",
      inputSchema: {},
      outputSchema: {
        ...SESSION_SCHEMA,
        deducted: z.array(z.object({ ingredient_id: z.string(), qty: z.number().nullable(), unit: z.string() })),
        skipped: z.array(z.object({ ingredient_id: z.string(), reason: z.string() })),
        unfinished_steps: z.array(z.number().int()),
      },
    },
    async () => {
      const userId = deps.userId();
      if (!userId) return mcpError(NEEDS_ACCOUNT);
      const found = await activeWithRecipe(userId);
      if (typeof found === "string") return mcpError(found);
      const now = deps.now();
      const unfinished = orderedSteps(found.recipe).map((s) => s.order).filter((o) => !found.session.completed_steps.includes(o));
      const closed = await close(found.session, found.recipe, now);
      const v = view(closed.session, found.recipe, now);

      const counted = closed.deducted.filter((d) => d.qty !== null).length;
      const unknown = closed.deducted.length - counted;
      const early = unfinished.length > 1 ? ` You stopped with ${unfinished.length} steps unticked; I have closed it anyway.` : "";
      const vague = unknown ? ` ${unknown} of them had no amount in the book, so those lines now read as "some, amount unknown" rather than a number I made up.` : "";
      const taste = closed.skipped.length ? ` ${closed.skipped.length} more were measured to taste and I have not touched them.` : "";
      const text = `${found.recipe.title}, done.${early} I have taken ${closed.deducted.length} ingredient${closed.deducted.length === 1 ? "" : "s"} off the pantry as my own reckoning.${vague}${taste}`;
      return {
        structuredContent: { session: v, deducted: closed.deducted, skipped: closed.skipped, unfinished_steps: unfinished },
        content: [{ type: "text", text }],
      };
    },
  );
}
