# Ideas worth considering next

Suggestions beyond `docs/PLAN.md` and `docs/INTEGRATIONS_PLAN.md`. Nothing here is committed to;
this is the list to argue with.

> **Eleven of these have since been built**, and are marked **done** below with what actually landed:
> the plan diff (1.1), the kitchen confidence figure (1.2), the stale-item audit (1.3), per-day time
> budgets (1.4) with cost per meal and a spending ceiling (1.5), the shelf-life table (2.3), and the
> cooking post-mortem (2.1), two cooks (2.2), what does not scale (2.4), leftovers (2.5), and the
> tables and shopping list as open data (3.1, 3.2). Where building one taught something the proposal
> had wrong, that is written down rather than quietly corrected.

Every entry answers the same three questions, because they are the ones that killed the ideas that
are not on the list:

- **What it buys** — for the person cooking, or for the judge watching.
- **What it costs** — roughly, in the units this project actually spends: curated data, engine code,
  demo time.
- **Does it hold the line** — the server has no model of its own, nothing is inferred and presented
  as certain, and every decision that matters is deterministic. An idea that needs an LLM on the
  server is not a smaller version of this project; it is a different one.

Ordered by how much they give back for what they take.

---

## 1 · Cheap, and visible in the first minute of the video

### 1.1 The plan diff — "Thursday moved, and here is why"

> **Done.** `src/plan/diff.ts` and the `plan_diff` tool; `plan_week` also hands back a one-line summary so the demo works in a single turn. One thing the proposal did not anticipate: a slot has to be keyed on a **date** and not a day number, or replanning on Tuesday reports every day as changed. And quoting the planner's reason only works if every reason is a clause that reads after "because", which took a pass over the planner's wording.

Replanning already produces a new `plan_hash` and a per-meal reason. Diffing two plans by slot and
reading out only what changed — *"Thursday moved to Friday because you ate the tofu on Wednesday"* —
turns the hash from an engineering detail into the thing the person actually feels.

**Buys:** the single best demonstration that the plan is a computed object rather than a suggestion.
A judge who sees a plan explain its own change understands the whole architecture in five seconds.
**Costs:** one pure function over two `PlanResult`s, plus a sentence builder. An afternoon.
**Holds the line:** entirely. It is a diff.

### 1.2 A kitchen confidence figure

> **Done.** `confidenceOf` in `src/pantry/audit.ts`, on `pantry_list`, the pantry page and the MCP Apps view. The figure is stricter than the proposal implied — it counts only lines that are confirmed *and* have an amount somebody counted — because a flattering number would be no use. The demo pantry scores 33%.

One number on the pantry view: how much of what you have is `confirmed`, how much is `inferred`, how
much has gone `stale`. The honesty model is currently a badge per row; this makes it a fact about
the kitchen.

**Buys:** the project's whole argument, in a number, on screen, for free.
**Costs:** a reduce over the fold and a line of CSS.
**Holds the line:** it *is* the line.

### 1.3 The stale-item audit

> **Done.** `pantry_audit`. It writes the questions and changes nothing; the answers come back through `pantry_update`. Reasons compound, and food past a date somebody gave is asked about differently from food past one the shelf-life table estimated.

The fold already marks an item `stale` after N days without confirmation. A tool that asks about the
five stalest — *"do you still have the miso?"* — closes the loop the confidence model opens. Right
now the system knows it is unsure and never does anything about it.

**Buys:** the answer to "so what?" about confidence levels. Also the most natural recurring reason to
open the add-on at all.
**Costs:** one tool, reusing `pantry_update` underneath. A day.
**Holds the line:** yes. It asks rather than assumes, which is the point.

### 1.4 Per-day time budgets

> **Done.** `plan_week` takes `day_limits`, resolved from the weekday somebody said against the week being planned; a day the week does not reach is reported rather than dropped.

`plan_week` takes one `time_budget_min` for the week. Real weeks are not like that: *"Wednesday I get
home at nine."* The planner's slots already carry a day; giving each a budget is a change to one
filter.

**Buys:** the plan stops being a toy. This is the most common reason a meal planner gets abandoned.
**Costs:** a few lines in `planWeek`, a slightly richer input schema, a sentence for Alexa+ to parse
into it.
**Holds the line:** yes.

### 1.5 Cost per serving, and a weekly budget

> **Done.** The plan carries what its shopping costs, priced by the same function the basket uses. A meal's cost is **marginal** — the week's bill minus what it would be without that meal — because one bag of lentils feeds two dinners. A ceiling leans the scorer towards cheaper meals, capped so money can never outweigh rescuing food, and says so when the plan still comes out over.

The catalog prices everything. A plan can carry what it would cost to fill its gaps, per meal and per
week, and the planner can take *"under forty dollars"* as another integer constraint.

**Buys:** the second most common reason people plan meals at all, and it makes the demo store load
bearing rather than decorative.
**Costs:** the money is already integer cents; this is a sum, plus one more term in the scorer.
**Holds the line:** yes — as long as the number is described as what the *missing* items cost, not
as what dinner costs, which nobody can know.

---

## 2 · Structural: things only this architecture can do

### 2.1 The cooking post-mortem

> **Done.** `cook_review` over `src/cook/postmortem.ts`. The proposal's "why was it salty" example needed one change to the ledger to work at all: the transition log now records which step each call marked done, so a step ticked off twice is a fact rather than a reconstruction. Everything the proposal warned about is enforced — no observation asserts anything about the food, and there is a test that says so.

The session already records every transition with what the person said, every deviation, and every
timer. Nothing reads it back. *"Why was it salty?"* → *"you salted at step 3 and again at step 7"*.
*"Why did it take two hours?"* → *"the pot sat for fifty minutes between step 4 and step 5"*.

**Buys:** something no recipe app does, because no recipe app is a state machine. It is also the
strongest possible answer to "what is the add-on for, after the first week?"
**Costs:** a read-only tool over the transition log and a handful of curated question patterns. The
data is all there; this is presentation.
**Holds the line:** completely — it is the log, read out. The temptation to have a model *interpret*
the log is exactly the temptation to refuse.

### 2.2 Two cooks, one dinner

> **Done.** `src/cook/schedule.ts` and `cooks` on `cook_start`. The proposal called it a week of work and was about right, but the shape it predicted was wrong in one place: the session's current step had to stop being *stored* and start being derived, because with two people there is no single answer to store. That change turned out to be an improvement on its own. It also surfaced a real bug — the second cook's first word ticked off a step they had never been given — and the honest result is that on this corpus two cooks help with only eleven of forty-nine recipes; the rest say so instead of pretending.

Steps carry `depends_on` and timers already run in parallel. Given two people, the machine can
partition the independent steps into two tracks and keep both. *"My partner is helping"* → two step
cards, one session, one dinner that lands at the same time.

**Buys:** a genuinely novel feature, and a demo moment.
**Costs:** real work — a scheduler over the dependency graph, a second cursor in the session, and a
UI question the plan has not thought about. A week, honestly.
**Holds the line:** yes. Topological order over a graph somebody wrote is the most deterministic
thing here.

### 2.3 A shelf-life table

> **Done.** 149 rows in `data/shelf_life.json`, derived at fold time and carried as `expiry_source` all the way to the sentence. The risk the proposal flagged — that a table estimate could fold into `confirmed` — is handled structurally rather than by care: nothing is stored, the fields are separate, and the hedge is chosen from the field rather than remembered.

The pantry only knows an expiry when a person or a package states one. A curated table — ingredient
by location, `tofu / fridge / opened: about 4 days` — would let it say something useful about the
other ninety percent. Same shape as `data/substitutions.json`: hand-written, versioned, and the
number is marked as **from a table**, never as a date anybody gave.

**Buys:** the planner's deadline pass currently sees almost nothing, because almost nothing carries a
date. This is what makes the best feature in the system actually fire.
**Costs:** the data. Maybe 120 rows to cover the corpus, plus a `freshness` origin so the fold can
keep the distinction between "you said Friday" and "the table says about four days".
**Holds the line:** only if the distinction is kept everywhere — a table estimate must never fold
into `confirmed`. That is a real risk and worth stating in the schema before writing a row.

### 2.4 What does not scale

> **Done.** 21 rows in `data/scaling.json`, with damping as a pair of integers so nothing drifts. The proposal's estimate of two days was right. The part it did not anticipate is that half the table is not a number at all: past double, the limit is the pan, and that has to be said rather than folded into an amount.

`misePlace` scales every quantity by servings. Cooking does not work that way: salt scales
sub-linearly, leavening scales oddly, baking times barely scale at all, and a pan has a size. A
curated table keyed on `(role, technique)` — *"do not scale linearly past double; the pan sets the
limit"* — would make the scaling honest.

**Buys:** chef judgment as data, which is this project's whole differentiator, applied to a second
place.
**Costs:** a small table and a warning channel in `cook_start`. Two days.
**Holds the line:** yes, and it is the same pattern that already works.

### 2.5 Leftovers as a first-class thing

> **Done.** `cook_finish` takes `leftover_portions` and the planner fills slots with them before it looks at any recipe. The design question the proposal flagged — a dish is not an ingredient — was settled with an id namespace (`leftover-<recipe>`) and one new unit, `portion`, which is the only unit here that measures a dish. Nothing is bought or cooked for a meal that already exists, and portions with no meal left before their date are named rather than wasted quietly.

Cooking six servings when two people eat produces four servings of something with a date on it.
`cook_finish` could offer to record it: a pantry `add` of a *dish*, `inferred`, with a shelf life,
which the planner then treats as a meal that needs no cooking.

**Buys:** the loop most people actually live in, and it makes the deduction on close feel like
bookkeeping rather than subtraction.
**Costs:** dishes are not ingredients — either a second entity or an ingredient id namespace
(`dish:lentil-stew`). Design work before code.
**Holds the line:** yes.

### 2.6 Swaps that grow the table, by review and not by inference

When somebody records a swap with `cook_note` that the substitution table does not have, stage it as
a candidate row under `data/imports/` — exactly the way an imported recipe is staged for a human to
finish. The table then grows out of what real people actually did, and never out of what a model
guessed they meant.

**Buys:** a curated table's one weakness is that it stops growing. This fixes that without giving up
the reason it is trustworthy.
**Costs:** a staging writer and a review script. `scripts/review_report.py` is the pattern.
**Holds the line:** yes, and it is a good demonstration of *how* to stay on the right side of it.

---

## 3 · Reach: making the work useful outside the demo

### 3.1 Publish the substitution table as open data

> **Done.** `/data` publishes all three tables under Apache-2.0 with their provenance, and — the part the proposal did not think of — with their caveats **in the payload**, because a warning that lives in a repository somebody did not clone has not been given to them.

The recipes are already served as importable JSON-LD. The substitution table is the more unusual
artefact: nobody publishes a machine-readable table of *(ingredient, role, technique) → alternatives
with ratios and failure modes*. Serving it at a stable URL, versioned, Apache-2.0, is the strongest
possible entry in the Open Source mini-challenge.

**Buys:** the mini-challenge, and something that outlives the hackathon.
**Costs:** an endpoint and a schema document, both of which exist.
**Holds the line:** yes.

### 3.2 The shopping list as an open format

> **Done.** A `schema.org/ItemList` inside the `cart_from_plan` response, so it reaches the person who asked and nobody else. What the shop could not supply is in the list without an offer and with the reason, which is the same rule the spoken list follows.

The same trick, in the other direction: serve the week's missing items as a `schema.org/ItemList`
that any grocery app can import. It makes the project useful to somebody who does not want the demo
store, and it costs almost nothing next to `src/recipe_jsonld.ts`.

### 3.3 A text receipt as an ingest source

`Origin` already has a `receipt` member with no adapter behind it. Photographing a receipt is out of
scope, but pasting the text of an emailed one is not, and supermarket line items are exactly the kind
of noisy names `data/source_aliases.json` exists to handle.

**Buys:** a third real source into the ledger, and the honest failure mode is already built — an
unmapped line is reported, never guessed.
**Costs:** a parser and a lot of alias rows.
**Holds the line:** yes, as long as it stays a table and not a matcher.

### 3.4 Nutrition, but only where it is honest

Open Food Facts carries nutrition for barcoded products. The dishonest version reports calories for a
dish. The honest version reports what it actually knows — *"this covers eleven of the fourteen
ingredients; the rest have no data"* — and refuses a total when the coverage is poor.

**Buys:** the most requested feature in this category, done in a way nobody else does.
**Costs:** moderate, and mostly spent on the refusal logic rather than the arithmetic.
**Holds the line:** only in that form. A number with unstated gaps in it is the exact failure this
project is arranged against.

---

## 4 · Small things that make the demo better

- **A "check on it" reminder for long timers.** The corpus has a three-day ferment and a
  twenty-four-hour marinade. A session that survives days already works; nothing tells you to look.
- **A large-print step mode.** One step, high contrast, no chrome. It is an accessibility win and it
  films beautifully.
- **The mise en place as a checklist, not a sentence.** Nine ingredients read aloud is a lot; nine
  ticked off on the step card is a kitchen.
- **Say the plan hash out loud once, in the video.** Fifteen seconds explaining that the same pantry
  gives the same week is worth more than another feature.
- **A recipe's provenance on the card.** Every recipe here carries the book, the locator and the
  original Spanish. Showing it costs nothing and answers "where did these come from" before it is
  asked.

---

## 5 · Deliberately not doing

Kept here because each one will be suggested by somebody, and the answer should be written down once.

- **An LLM on the server.** `docs/PLAN.md` §12 already settles it: Alexa+ extracts entities, and a
  model on this side breaks both the latency budget and the argument. The temptation arrives disguised
  as something small — parsing a free-form ingredient, "just" interpreting a note — and it should be
  refused in that form too.
- **Fuzzy ingredient matching.** A wrong ingredient id silently rewrites the weekly plan. The alias
  table is bigger than a matcher would be and that is the correct trade.
- **Inferring quantities.** "About a cup, probably" is how a pantry starts lying. `null` means unknown
  and the fold is built around keeping it that way.
- **Auto-ordering without confirmation.** The loop closing is the product argument; closing it
  *without asking* is a different product, and a worse one.
- **Converting cups to grams.** It needs a density per ingredient. If somebody wants it, the answer is
  a curated density table with an explicit source per row — the same shape as everything else here —
  and not a constant.
- **A second recipe corpus scraped from the web.** The recipes here come from the author's own books,
  with the original text kept verbatim beside every translation. That provenance is the reason the
  data can be published at all.
