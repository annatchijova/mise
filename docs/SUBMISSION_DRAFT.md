# Devpost submission draft — Build, Ship, Shape 2026

Working draft of the fields Devpost asks for, so copy-paste at submission time is quick. Nothing
here has been pasted into the form yet. Sections marked **TODO** depend on steps that need the
Alexa+ developer account or an AWS account and are listed in [BLOCKED.md](BLOCKED.md).

---

## Track and mini challenges

- **Primary track:** Alexa+ — self-hosted MCP server, spec 2025-11-25+, Streamable HTTP. The repo
  calls the real `@modelcontextprotocol/sdk`, not a mention in a README; `src/server.ts` is the
  entry point.
- **AWS Builder — discarded.** The published rule names Bedrock, AgentCore, Strands SDK, Kiro Crew,
  and SageMaker as qualifying services. Mise uses none of them, and the architecture deliberately
  keeps every decision out of a model's hands (`README_TECHNICAL.md`, "LLM out of the decision
  path") — bolting on a Bedrock call with no real job to do would contradict the thing the project
  argues for. Decided not to chase this one.
- **Open Source — in progress.** `docs/PLAN.md` §09 assumed the main repo being public and
  Apache-2.0 satisfies this mini-challenge. **It does not** — the current rule asks for a
  *separate, additional* open-source project or contribution (a branch, fork, or PR to a public
  repo) made during the hackathon window, with its own URL, repo URL, GitHub username, and
  description. Decided to pursue it for real: see the PR candidates being evaluated below rather
  than in `BLOCKED.md`, since this one does not depend on the Alexa+ or AWS accounts.

## Open Source mini-challenge — PR candidates

(filled in as candidates are found and attempted)

## Project page

One-page pitch, built from the repo's own evidence (the honesty examples, the plan-hash demo, the
test/review-queue counts): https://annatchijova.github.io/mise/ — source is the `gh-pages` branch
of this repo (`index.html`). Worth pasting into the Devpost description alongside the video once
the latter exists.

## Project text description

**What it does.** Mise is a pantry and cooking companion for Alexa+. It tracks what is at home
across voice reports, a simulated connected fridge, and barcode scans; plans a week of meals around
what is already on hand and what is about to turn; walks a recipe step by step with a resumable
cooking session; substitutes an ingredient from a chef-curated table when something runs out; and
prepares a grocery cart with checkout for what is missing.

**How it works.** Alexa+ is the only model in the system — it holds the conversation and chooses
which tool to call. Every decision that matters (what is in the pantry, what to cook, what a
substitution costs, what a recipe's nutrition floor is) is computed by deterministic server logic
and curated data tables before Alexa+ ever sees it; the model narrates a result, it never produces
one. `plan_week` returns a hash so the same pantry and the same week reproduce the same plan,
byte for byte. When the data has no answer — an unmapped ingredient, an uncounted amount, a missing
nutrition figure — the server says so instead of filling the gap with something plausible.

**What's genuinely new this window vs. pre-existing.** TODO — fill in once the submission window's
exact start date is confirmed against the repo's commit history (`git log`), per the "pre-existing
project" disclosure requirement.

## Product feedback (required — one entry per tool/API/SDK used)

Draft now from what's already been exercised; the Alexa AI CLI / Web Simulator / App Runner entries
need the actual run before they can be anything but a prediction.

### `@modelcontextprotocol/sdk` (MCP server, Streamable HTTP)
- **Used for:** the entire tool surface — `recipe_search`, `pantry_*`, `plan_week`, `cook_*`,
  `substitute`, `zero_waste`, the UCP store tools, and the four MCP Apps views.
- **Worked well:** TODO — note specifically what made the stateless Streamable HTTP transport easy
  or hard to get right in `src/server.ts`.
- **Needs work:** TODO.
- **Onboarding:** TODO.
- **Would build with it again:** TODO.

### `@modelcontextprotocol/ext-apps`
- **Used for:** the four in-session UI views (pantry card, weekly grid, step card with timer,
  checkout), bundled inline per view.
- **Worked well / needs work / onboarding:** TODO — the honest note already on record in
  `BLOCKED.md` §F.2 is that the bundled runtime adds ~300 KB per view; worth repeating here with a
  number once measured.

### Alexa AI CLI / `alexa-ai configure` / Web Simulator — **TODO, write after first real run**
- The thing to record first: whether the Web Simulator worked from outside the US at all
  (`docs/BLOCKED.md` §A.2 flags this as the single biggest unknown in the whole plan). Whatever
  happens — it works, it's region-locked, the docs were unclear — that is itself the feedback.

### AWS App Runner / Cognito / DynamoDB — **TODO, only if the deploy happens**

## Feature requests (optional)

Draft candidates, pending real friction:
- Region coverage for the Web Simulator should be stated plainly in the toolkit docs rather than
  left silent — **important**, it currently forces a blind first attempt instead of a planned one.
- Whether an MCP session carries locale/timezone context without account linking is undocumented
  (`docs/BLOCKED.md` §A.4) — **nice-to-have**, the server already degrades safely (UTC, seconds) in
  its absence.

## Friction log (optional, up to 10% judging bonus)

Format per entry: task attempted → steps → expected vs. actual → severity → workaround → actionable
suggestion. Draft the ones already backed by real research; add real ones as the remaining blockers
in `BLOCKED.md` get resolved this week.

1. **Task:** confirm whether the Alexa+ Web Simulator is usable from outside the US before
   committing the demo video plan to it.
   **Steps:** read the toolkit documentation for a region restriction statement.
   **Expected:** a stated supported-regions list.
   **Actual:** no region statement found in the docs read so far.
   **Severity:** high — it decides whether the whole video plan (`docs/DEMO_SCRIPT.md`) survives
   contact with the real tool.
   **Workaround:** none yet; this is exactly the first thing to test once the developer account
   exists.
   **Suggestion:** state supported regions for the Web Simulator explicitly in the CLI/toolkit docs.

2. **Task:** TODO — add once the Alexa AI CLI has actually been run.

3. **Task:** TODO — add once `alexa-ai deploy` / App Runner has actually been attempted.
