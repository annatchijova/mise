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
  advance, check, consumptionEvents, currentStepFor, finish, lastCheckOf, leftoverEvent, misePlace, note, orderedSteps, pause, startSession, view,
} from "../cook/session.ts";
import type { CookStore } from "../cook/store.ts";
import { postMortem, spanText } from "../cook/postmortem.ts";
import { type Scaling, scalingWarnings } from "../cook/scaling.ts";
import { assignmentsByStep, scheduleSteps } from "../cook/schedule.ts";
import { type SwapStore, recordSwap } from "../cook/swap_log.ts";
import {
  type CheckSchedule,
  type LongStepPlan,
  checkSentence,
  scheduleFor,
} from "../cook/check_ins.ts";

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
  /** Where swaps people actually made are queued for a curator. Optional; without it they are still
   *  in the session's own log, which is where they matter to the cook. */
  swaps?: SwapStore;
  /** Does the substitution table already suggest this swap? Decides candidate versus confirmation.
   *  Injected so the cook tools stay independent of the table's shape. */
  tableSuggests?: (instead_of: string, used: string, role: string | null, technique: string | null) => boolean;
  /** The curated plan for looking in on a long step, or undefined when nobody has written one.
   *  Optional: without it a long step simply gets no check-ins, which is what happened before. */
  longStep?: (recipeId: string, step: number) => LongStepPlan | undefined;
};

/** The check-in schedule for a step, when there is a plan and a running timer to hang it on. Null
 *  when the step is short, has no timer, or nobody has written a plan — three different silences that
 *  all mean "say nothing", which is why they collapse here and nowhere else. */
function scheduleOn(
  deps: CookDeps,
  session: CookSession,
  recipe: Recipe,
  step: number,
  now: string,
): CheckSchedule | null {
  if (!deps.longStep || !step) return null;
  const plan = deps.longStep(recipe.id, step);
  if (!plan) return null;
  const timer = session.timers.find((t) => t.step === step);
  const s = recipe.steps.find((x) => x.order === step);
  if (!s?.dur_s) return null;
  return scheduleFor(plan, timer?.started_at ?? session.started_at, s.dur_s, now, lastCheckOf(session, step));
}

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

/** "1", "1 and 3", "1, 3 and 5". A list a person would say. */
function listOf(numbers: number[]): string {
  if (numbers.length <= 1) return numbers.join("");
  return `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
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
      cooks: z.number().int(),
      /** When there is work left for this cook but none of it can start, the steps in the way. */
      waiting_for: z.array(z.number().int()),
      /** Everybody's place at once. One entry when one person is cooking. */
      tracks: z.array(z.object({ cook: z.number().int(), step: z.number().int(), waiting_for: z.array(z.number().int()) })),
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
  async function close(session: CookSession, recipe: Recipe, now: string, leftoverPortions = 0) {
    const already = session.state === "finished";
    const finished = finish(session, recipe, now);
    await deps.sessions.put(finished);
    if (already) return { session: finished, deducted: [], skipped: [] as { ingredient_id: string; reason: string }[], leftovers: 0 };
    const { events, skipped } = consumptionEvents(finished, recipe, now, deps.scaling);
    // What was cooked and not eaten is a line in the same ledger, with the same reservations: the
    // person said how many portions, nobody counted what is in them.
    const kept = leftoverEvent(finished, recipe, leftoverPortions, now);
    await deps.pantry.append(finished.user_id, kept ? [...events, kept] : events);
    return {
      session: finished,
      deducted: events.map((e) => ({ ingredient_id: e.ingredient_id, qty: e.qty_milli === null ? null : e.qty_milli / 1000, unit: e.unit })),
      skipped,
      leftovers: kept ? (kept.qty_milli ?? 0) / 1000 : 0,
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
        cooks: z.number().int().min(1).max(4).optional().describe("How many people are cooking, when they say somebody is helping. One otherwise"),
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
        /** Who does what, when more than one person is cooking. null for one cook. */
        schedule: z
          .object({
            cooks: z.number().int(),
            steps_by_cook: z.array(z.object({ cook: z.number().int(), steps: z.array(z.number().int()) })),
            makespan_s: z.number().int(),
            solo_s: z.number().int(),
            saved_s: z.number().int(),
            /** True when nothing can be done in parallel and the second pair of hands has nowhere to stand. */
            no_benefit: z.boolean(),
          })
          .nullable(),
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
          structuredContent: { session: v, started: false, resumed: true, blocked_by: null, mise_en_place: misePlace(recipe, existing.servings, deps.scaling), scaling_warnings: [], schedule: null },
          content: [{ type: "text", text: `You are already cooking this. ${stepSentence(v) || "You are still on the mise en place."}${timerSentence(v.timers)}` }],
        };
      }
      if (existing && !args.abandon_other) {
        const other = deps.recipeById(existing.recipe_id);
        return {
          structuredContent: {
            session: view(existing, other ?? recipe, now),
            started: false, resumed: false,
            blocked_by: { session_id: existing.id, recipe_id: existing.recipe_id, step: currentStepFor(existing, other ?? recipe, 1).current_step },
            mise_en_place: [],
            scaling_warnings: [],
            schedule: null,
          },
          content: [{
            type: "text",
            text: `There is already a session going: ${other?.title ?? existing.recipe_id}, at step ${currentStepFor(existing, other ?? recipe, 1).current_step}. Do you want to leave that one and start ${recipe.title}?`,
          }],
        };
      }
      if (existing && args.abandon_other) {
        const other = deps.recipeById(existing.recipe_id);
        await deps.sessions.put(finish({ ...existing, state: "cooking" }, other ?? recipe, now));
      }

      // Who does what comes from the scheduler; the session takes it as given and never schedules.
      // What it decides is who, not when — the session still records what people actually did.
      const asked = Math.max(1, Math.min(4, Math.floor(args.cooks ?? 1)));
      const schedule = asked > 1 ? scheduleSteps(recipe, asked) : null;
      // A recipe that is one long chain cannot be split, and handing somebody alternate steps they
      // can never start would be worse than telling them there is nothing to do. So it stays one
      // job, and the sentence below says why.
      const cooks = schedule === null || schedule.no_benefit ? 1 : asked;
      const session = startSession({
        id: deps.newId(), userId, recipe, servings: args.servings, now,
        cooks,
        assignments: cooks > 1 && schedule ? assignmentsByStep(schedule) : {},
      });
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
      const byCook = schedule === null ? [] : Array.from({ length: schedule.cooks }, (_, i) => ({
        cook: i + 1,
        steps: schedule.assignments.filter((a) => a.cook === i + 1).map((a) => a.step).sort((x, y) => x - y),
      }));
      const split = schedule === null
        ? ""
        : schedule.no_benefit
          ? ` There is nothing here two people can do at once — every step waits on the one before it — so I have kept it as one job. A second pair of hands is better spent on the washing up.`
          : ` Two of you: ${byCook.map((c) => `cook ${c.cook} takes step${c.steps.length === 1 ? "" : "s"} ${c.steps.join(", ")}`).join("; ")}. About ${durationText(schedule.makespan_s)} together against ${durationText(schedule.solo_s)} alone.`;

      const text = `${recipe.title}, ${session.servings} serving${session.servings === 1 ? "" : "s"}.${scaled}${pan}${split} Get out: ${list}. When you are ready, say next and we start with: ${first?.text ?? "the first step"}`;
      return {
        structuredContent: {
          session: v, started: true, resumed: false, blocked_by: null, mise_en_place: mise,
          scaling_warnings: warnings.map((w) => w.text),
          schedule: schedule === null ? null : {
            cooks: schedule.cooks, steps_by_cook: byCook,
            makespan_s: schedule.makespan_s, solo_s: schedule.solo_s, saved_s: schedule.saved_s, no_benefit: schedule.no_benefit,
          },
        },
        content: [{ type: "text", text }],
      };
    },
  );

  server.registerTool(
    "cook_next",
    {
      title: "Next cooking step",
      description:
        "Move the cooking session on to the next step. Use when the customer says they finished a step, asks what is next, or says done, ready, ok, next. Pass what they said as completed_hint when they named what they did ('I already did the onions') — if that turns out to be a different step it is recorded as a deviation, not treated as a mistake. When two people are cooking, pass which of them is speaking; each has their own place in the recipe and may have to wait for the other. Needs a linked account.",
      inputSchema: {
        completed_hint: z.string().optional().describe("What the customer said they finished, in their words"),
        cook: z.number().int().min(1).max(4).optional().describe("Which cook is speaking, when more than one is cooking. One otherwise"),
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

      const result = advance(found.session, found.recipe, { now, completed_hint: args.completed_hint, cook: args.cook });
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

      const v = view(result.session, found.recipe, now, result.cook);
      const aside = result.unmatched_hint
        ? " I could not tell which step you meant, so I have written it down and left the order alone."
        : result.deviation
          ? ` Noted that you did step ${result.deviation.what.match(/step (\d+)/)?.[1] ?? "another one"} already.`
          : "";
      // A cook with nothing to start is waiting on somebody else, and saying so is the whole reason
      // the second track exists. It is not an error and it is not the end of their evening.
      const held = result.step === null && result.waiting_for.length > 0
        ? `Nothing for you yet: step${result.waiting_for.length === 1 ? "" : "s"} ${listOf(result.waiting_for)} ${result.waiting_for.length === 1 ? "has" : "have"} to be done first, and ${result.waiting_for.length === 1 ? "it is" : "they are"} not yours.`
        : result.step === null
          ? "That is everything on your side. The rest is somebody else's."
          : "";
      return {
        structuredContent: { session: v, finished: false, deviation: result.deviation, unmatched_hint: result.unmatched_hint, deducted: [], skipped: [] },
        content: [{ type: "text", text: `${aside}${aside ? " " : ""}${held || stepSentence(v)}${timerSentence(v.timers)}`.trim() }],
      };
    },
  );

  server.registerTool(
    "cook_where_am_i",
    {
      title: "Where was I",
      description:
        "Say where the cooking session stands: which step, which timers, how long it has been. Use when the customer comes back after a break and asks where they were, what step they are on, how long is left, or what they were doing. Answers across sessions and devices. When two people are cooking, pass which of them is asking. Needs a linked account.",
      inputSchema: {
        cook: z.number().int().min(1).max(4).optional().describe("Which cook is asking, when more than one is cooking"),
      },
      outputSchema: { ...SESSION_SCHEMA, recipe_title: z.string().nullable() },
      _meta: uiStepCard,
    },
    async (args) => {
      const userId = deps.userId();
      if (!userId) return mcpError(NEEDS_ACCOUNT);
      const found = await activeWithRecipe(userId);
      if (typeof found === "string") {
        return { structuredContent: { session: null, recipe_title: null }, content: [{ type: "text", text: found }] };
      }
      const now = deps.now();
      const v = view(found.session, found.recipe, now, args.cook ?? 1);
      const away = ` It has been ${durationText(v.elapsed_s)} since you started.`;
      const where = v.state === "paused" ? "You paused" : v.state === "mise_en_place" ? "You had not started the steps yet" : "You are";
      const mine = v.step === null && v.waiting_for.length > 0
        ? `Nothing for you until step${v.waiting_for.length === 1 ? "" : "s"} ${listOf(v.waiting_for)} ${v.waiting_for.length === 1 ? "is" : "are"} done.`
        : stepSentence(v);
      const others = v.cooks > 1
        ? ` ${v.tracks.filter((t) => t.cook !== (args.cook ?? 1)).map((t) => `Cook ${t.cook} is ${t.step === 0 ? (t.waiting_for.length ? `waiting on step ${listOf(t.waiting_for)}` : "finished") : `on step ${t.step}`}.`).join(" ")}`
        : "";
      // A long step is the one case where "where was I" has something to do rather than just report.
      // It goes here because this is where somebody coming back after a day actually asks.
      const schedule = scheduleOn(deps, found.session, found.recipe, v.step?.order ?? 0, now);
      const look = schedule?.kind === "scheduled" && schedule.overdue.length
        ? ` ${checkSentence(schedule, now)}`
        : "";
      const text = `${where} on ${found.recipe.title}. ${mine}${timerSentence(v.timers)}${others}${away}${look}`;
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
        cook: z.number().int().min(1).max(4).optional().describe("Which cook is speaking, when more than one is cooking"),
      },
      outputSchema: {
        ...SESSION_SCHEMA,
        deviation: z.object({ at: z.string(), step: z.number().int(), kind: z.string(), what: z.string() }),
        substitution: z.object({ instead_of: z.string(), used: z.string() }).nullable(),
        unresolved: z.array(z.string()),
        /** Whether this swap went into the curator's queue as something new, or as evidence for a
         *  row that already exists. Never changes what `substitute` will say. */
        queued_as: z.enum(["candidate", "confirmation"]).nullable(),
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

      const { session, deviation } = note(found.session, found.recipe, { now, note: args.note, used: swap?.used, instead_of: swap?.instead_of, cook: args.cook });
      await deps.sessions.put(session);

      // A swap somebody actually made is evidence a curator would want. It goes into a queue and
      // never into the table: `substitute` reads data/substitutions.json and nothing else, and the
      // table grows when a person edits that file and at no other moment.
      let queued: "candidate" | "confirmation" | null = null;
      // The queue takes a named swap whether or not the names resolve, which is the opposite of what
      // the pantry does and is deliberate. A swap we could not resolve is the one a curator most
      // wants: an ingredient with no id is either an alias nobody wrote or a food the table has
      // never heard of, and both are answered by a person reading the queue.
      if (args.used && args.instead_of && deps.swaps) {
        const verbatim = (t: string) => t.trim().toLowerCase();
        const insteadKey = insteadOf ?? verbatim(args.instead_of);
        const usedKey = used ?? verbatim(args.used);
        const inRecipe = insteadOf ? found.recipe.ingredients.find((i) => i.id === insteadOf) : undefined;
        const role = inRecipe?.role ?? null;
        const technique = inRecipe?.technique ?? null;
        // The table cannot have suggested something we have no id for, so an unresolved swap is a
        // candidate by construction rather than by a lookup that would always miss.
        queued =
          insteadOf && used && deps.tableSuggests?.(insteadOf, used, role, technique) ? "confirmation" : "candidate";
        try {
          deps.swaps.write(recordSwap(deps.swaps.read(), {
            instead_of: insteadKey, used: usedKey, role, technique, unresolved, kind: queued,
            at: now, session_id: session.id, recipe_id: found.recipe.id, note: args.note,
          }));
        } catch (err) {
          // A note we could not file is not a cooking error. The session already has the swap.
          console.error("could not queue the swap for review:", err);
          queued = null;
        }
      }
      const v = view(session, found.recipe, now, args.cook ?? 1);
      const said = swap
        ? `Noted: ${displayName(swap.used)} instead of ${displayName(swap.instead_of)}. I will count that against the ${displayName(swap.used)} when you finish, and leave the ${displayName(swap.instead_of)} alone.`
        : unresolved.length
          ? `Written down. I do not keep ${unresolved.join(" or ")}, so I have left the pantry count as the recipe has it.`
          : "Written down.";
      return {
        structuredContent: { session: v, deviation, substitution: swap, unresolved, queued_as: queued },
        content: [{ type: "text", text: said }],
      };
    },
  );

  server.registerTool(
    "cook_checked",
    {
      title: "Look in on something that takes days",
      description:
        "Say what to look at during a long wait — a ferment, a brine, a long marinade — and record that the customer has looked, so it stops asking. Use when they ask whether they need to do anything to something that is resting, what to check on it, when to look again, or when they tell you they have just looked at it. Every answer comes from a plan a cook wrote for that step; when nobody has written one it says so instead of inventing a schedule. Needs a linked account.",
      inputSchema: {
        looked: z.boolean().optional().describe("True when they are telling you they have just looked at it"),
        note: z.string().optional().describe("What they saw, in their words"),
        cook: z.number().int().min(1).max(4).optional().describe("Which cook is asking, when more than one is cooking"),
      },
      outputSchema: {
        ...SESSION_SCHEMA,
        step: z.number().int().nullable(),
        /** Which of the three silences this is, when there is nothing to say. Never conflated: a
         *  curated "nothing to check" is a decision, and a missing plan is a gap. */
        plan: z.enum(["scheduled", "nothing_to_check", "no_plan", "not_a_long_step"]),
        look_for: z.array(z.string()),
        overdue: z.number().int(),
        next_check_at: z.string().nullable(),
        recorded: z.boolean(),
      },
    },
    async (args) => {
      const userId = deps.userId();
      if (!userId) return mcpError(NEEDS_ACCOUNT);
      const found = await activeWithRecipe(userId);
      if (typeof found === "string") return mcpError(found);
      const now = deps.now();
      const cook = args.cook ?? 1;
      const step = currentStepFor(found.session, found.recipe, cook).current_step;

      let session = found.session;
      let recorded = false;
      if (args.looked) {
        const done = check(session, found.recipe, { now, step, note: args.note ?? null, cook });
        session = done.session;
        await deps.sessions.put(session);
        recorded = true;
      }

      const schedule = scheduleOn(deps, session, found.recipe, step, now);
      const v = view(session, found.recipe, now, cook);
      const base = {
        session: v, step: step || null,
        look_for: schedule?.kind === "scheduled" ? schedule.plan.look_for : [],
        overdue: schedule?.kind === "scheduled" ? schedule.overdue.length : 0,
        next_check_at: schedule?.kind === "scheduled" ? (schedule.next?.at ?? null) : null,
        recorded,
      };

      if (!schedule) {
        const text = recorded
          ? "Noted. That step is not one that wants watching, but I have written it down."
          : "That step is not a long wait, so there is nothing to look in on. Ask me again when something is resting.";
        return { structuredContent: { ...base, plan: "not_a_long_step" as const }, content: [{ type: "text", text }] };
      }
      if (schedule.kind === "no_plan") {
        const text = `That step is a long one, but nobody has written down what to look at during it. I would rather tell you that than make up a schedule for your ${found.recipe.title.toLowerCase()}.`;
        return { structuredContent: { ...base, plan: "no_plan" as const }, content: [{ type: "text", text }] };
      }

      const said = checkSentence(schedule, now) ?? "";
      const head = recorded ? "Noted, and I will stop asking. " : "";
      return {
        structuredContent: { ...base, plan: schedule.kind },
        content: [{ type: "text", text: `${head}${said}` }],
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
        "Close the cooking session and take what it used out of the pantry. Use when the customer says they are done, it is finished, they are eating, or they want to stop early. Pass leftover_portions when they say how much is going in the fridge — it becomes a meal the weekly plan can use, with about four days on it. Amounts come off as inferred, never as something the customer confirmed, and anything measured to taste is left alone. Needs a linked account.",
      inputSchema: {
        leftover_portions: z.number().int().min(0).max(50).optional().describe("How many servings are being put away rather than eaten, when they say"),
      },
      outputSchema: {
        ...SESSION_SCHEMA,
        deducted: z.array(z.object({ ingredient_id: z.string(), qty: z.number().nullable(), unit: z.string() })),
        skipped: z.array(z.object({ ingredient_id: z.string(), reason: z.string() })),
        unfinished_steps: z.array(z.number().int()),
        /** Portions put away, now a line in the pantry the planner can fill a slot with. */
        leftover_portions: z.number(),
      },
    },
    async (args) => {
      const userId = deps.userId();
      if (!userId) return mcpError(NEEDS_ACCOUNT);
      const found = await activeWithRecipe(userId);
      if (typeof found === "string") return mcpError(found);
      const now = deps.now();
      const unfinished = orderedSteps(found.recipe).map((s) => s.order).filter((o) => !found.session.completed_steps.includes(o));
      const closed = await close(found.session, found.recipe, now, args.leftover_portions ?? 0);
      const v = view(closed.session, found.recipe, now);

      const counted = closed.deducted.filter((d) => d.qty !== null).length;
      const unknown = closed.deducted.length - counted;
      const early = unfinished.length > 1 ? ` You stopped with ${unfinished.length} steps unticked; I have closed it anyway.` : "";
      const vague = unknown ? ` ${unknown} of them had no amount in the book, so those lines now read as "some, amount unknown" rather than a number I made up.` : "";
      const taste = closed.skipped.length ? ` ${closed.skipped.length} more were measured to taste and I have not touched them.` : "";
      const kept = closed.leftovers > 0
        ? ` ${closed.leftovers} portion${closed.leftovers === 1 ? "" : "s"} in the fridge, about four days by the shelf-life table — I will offer ${closed.leftovers === 1 ? "it" : "them"} back when you next plan the week.`
        : "";
      const text = `${found.recipe.title}, done.${early} I have taken ${closed.deducted.length} ingredient${closed.deducted.length === 1 ? "" : "s"} off the pantry as my own reckoning.${vague}${taste}${kept}`;
      return {
        structuredContent: { session: v, deducted: closed.deducted, skipped: closed.skipped, unfinished_steps: unfinished, leftover_portions: closed.leftovers },
        content: [{ type: "text", text }],
      };
    },
  );
}
