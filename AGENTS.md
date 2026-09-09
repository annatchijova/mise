# AGENTS.md — working rules for this repo

Mise is deterministic data-plus-logic behind an MCP server; Alexa+ is the only model in the loop, and
it never decides anything the server itself should decide. These rules are a short, mise-specific
selection from a larger house discipline (`~/SKILLS`, 74 skills) — picked because this codebase
already lives by them; keep it that way rather than reintroducing what it deliberately avoids.

## 1. Nothing invented, ever

Every curated table (`data/substitutions.json`, `data/shelf_life.json`, `data/nutrition.json`,
`data/scaling.json`, `data/zero_waste.json`, `data/catalog.json`) is a human's judgment, versioned,
with its own `status`/provenance field. Code reads from these tables — it does not compute a
substitution, an expiry estimate, a calorie count or a technique lesson on the fly. If a lookup misses,
say so out loud (`"I have nothing curated for X"`); do not interpolate, average, or guess a plausible
value. Extending a table is a data change, reviewed like one — not a code fallback.

## 2. Confidence and provenance travel with the value, not beside it

`confirmed` / `inferred` / `stale` (pantry), `stated` / `estimated` / `unspecified` (recipes),
`stated` / `estimated` / `unknown` (expiry). A value's certainty is a field on the value, checked at
every read, not a comment or a convention the caller has to remember. When you add a new source of
truth, give it the same discipline: an explicit label for how sure the system is, and a spoken
sentence that names the label when it matters ("the fridge reported it", "not confirmed lately").

## 3. Unknown stays unknown — never rendered as zero, never guessed

If any event contributing to a total carries no number, the total is `null` with a `_known: false`
flag beside it, not `0`. A missing amount, an unmeasurable unit, or an ingredient with no nutrition
row is a named gap (`gaps`, `missing`, `contribute_nothing`), never silently dropped from a sum. See
`src/pantry/fold.ts` rule 1 and `src/nutrition.ts`'s "at least" floor for the pattern to match.

## 4. No claim the data cannot support

Do not compute or state a monetary saving, an emissions reduction, or an "avoided waste" figure —
`zero_waste`'s own notes say why: a suggestion is an opportunity, not evidence that food was used or
waste avoided. Do not claim a percentage without a fixed, reproducible denominator (compare how
Domain-B-style corpus figures are handled elsewhere in this house's other projects). Do not describe
something as "verified" or "tested end to end" until it has actually run against the real target —
`docs/BLOCKED.md` is where "not yet verified" is supposed to live, not silence.

## 5. The event log is append-only; nothing is corrected in place

Pantry state is a fold over events (`src/pantry/fold.ts`), not a mutable record. A correction is a new
`correct` event that supersedes history for that line; a removal is a new `remove` event, not a
deletion. Same events + same clock ⇒ same output, byte for byte, regardless of input order — if a
change makes fold order-dependent, that is a regression, not a detail. Restocking after a line hits
zero starts a fresh batch (expiry, confidence, origin) rather than inheriting the depleted one's
history; partial or unknown-quantity consumption is not a depletion and must not reset anything.

## 6. Every tool is data plus deterministic logic

The server has no model of its own (see the top of `src/server.ts`). Alexa+ decides which tool to
call and narrates the result; it does not touch scoring, ranking, or what counts as a match. If you
are tempted to have the server ask a model for something a table or a pure function could answer
instead, that is the wrong direction — push logic into `src/`, not into the prompt.

## 7. Tests fail loudly, on purpose

A test exists to break when the rule it names is dropped, not to document that the code once worked.
Before adding a feature, know which existing test would catch its regression; if none would, write one
that fails without your change and passes with it. `npm run check` (typecheck + tests + data
validators) must pass clean before anything is proposed as done — a green run with a validator warning
buried in the output is not clean, read the warnings.

## 8. Git discipline

Tag a restore point before a risky session (`git tag -a "pre-session-$(date +%Y%m%d-%H%M%S)"`).
`merge`, never `rebase` — history only grows, it is never rewritten. Before claiming "committed" or
"pushed", run `git status --short` and `git log --oneline -5` and report what they actually say.
Before applying a patch generated in another session (Codex, a cloud agent, an older local branch),
`git apply --check` it first — if it does not apply clean, the codebase moved since the patch was
written; re-derive the change against the current files rather than forcing it.

## 9. Read `docs/` before assuming a gap

`docs/BLOCKED.md` (what is not verified end to end and why), `docs/IDEAS.md` (what could come next,
and what was deliberately ruled out — do not re-propose something already ruled out without a new
reason), `docs/*_SCHEMA.md` (the contract for each curated table). A decision already made and
recorded is not a blank slate for the next session to redecide from scratch.
