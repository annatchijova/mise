# What cannot be done from here, and exactly what to run when it can

Everything in this repository that could be built without an Amazon developer account, outbound
access to a third party, a real device, or a cloud bill has been built. This file is the other list:
the work that is blocked, what blocks it, what to run the day it is not, and what evidence to record
so that "it works" stops being a claim and becomes a fact somebody checked.

The rule this file exists to protect is the same one the rest of the project follows: **nothing is
described as working until somebody has watched it work.** A hackathon entry that overstates itself
loses on the one question a judge always asks.

Companion files: `docs/IMPORT_SOURCES.md` is the same log for recipe portals; `docs/ROBUSTNESS_REVIEW.md`
records what was reviewed and what is still unverified in block I.

---

## Legend

| Mark | Meaning |
|---|---|
| **blocked** | Cannot be started here. The blocker is named. |
| **partial** | Built and tested against something that is not the real thing. What is real and what is not is stated. |
| **unverified** | Written to a specification we could not read, or against a client we could not reach. |

---

## A · The platform round trip

### A.1 The Alexa AI CLI and a developer account — **blocked**

`alexa-ai configure` needs Login with Amazon and an Amazon developer account. Neither exists in this
environment, and creating one is a human's decision, not a script's.

**What it blocks:** everything downstream — `alexa-ai new mcp`, `addon.json`, `alexa-ai deploy`, the
Web Simulator, the Local Inspector, certification.

**When unblocked:**

```bash
npm i -g <the Alexa AI CLI package named in the toolkit docs>
alexa-ai configure                      # Login with Amazon, developer account
alexa-ai new mcp --locale en-US --mcp-server-url https://<your-app-runner-url>/mcp
# complete addon.json: icons in 6 sizes, privacy and terms URLs
alexa-ai deploy
```

**Evidence to record:** the add-on id, the locale it deployed with, and a screenshot of the Web
Simulator answering `recipe_search`. Until that screenshot exists, the README's "not yet validated
against Alexa+ end to end" stays exactly as it is.

### A.2 The Web Simulator from Argentina — **blocked, and it is the first risk to retire**

`docs/PLAN.md` §12 flags it: the toolkit is US-only and the testing documentation says nothing about
region. This is the single assumption that, if false, changes what the entry can be.

**When unblocked:** open the simulator, ask for a recipe, and record the result — including a
failure. A recorded regional block is worth more than an untested assumption.

### A.3 The Local Inspector readiness report — **blocked**

Needs the CLI (A.1). Run it before every deploy and keep the first report as a baseline, so that a
later regression has something to be a regression from.

### A.4 What context arrives in an MCP session without linking — **blocked**

Locale, timezone, anything else the client passes. The documentation does not enumerate it and we
cannot observe it. The server currently assumes nothing: every date is UTC and every duration is
seconds. If the session turns out to carry a timezone, `dayOf` in `src/pantry/events.ts` and the
planner's `start_date` are the two places that should start using it — and both are one function
each, deliberately.

---

## B · Account linking and state

### B.1 OAuth 2.1 with PKCE, `resource` (RFC 8707) and a PRM document — **blocked**

Needs either Cognito (an AWS account) or a public HTTPS origin to run our own authorization server
against. `docs/PLAN.md` §02 sets a half-hour timebox on the Cognito test and a fallback if it fails.

**What stands in for it today:** `DEMO_USER`, one account that owns everything, and `UCP_TOKEN`, a
shared secret checked against the bearer on the store surface. **Neither is authentication.** Both
are off by default: with `DEMO_USER` empty every account-bound surface answers "link your account",
and without `UCP_TOKEN` the checkout answers 503.

**The specific thing to verify first:** whether Cognito accepts the `resource` parameter and whether
a PRM document served from our domain can point at its metadata. That answer decides Cognito versus
a hand-rolled server, and nothing else in block B can be finished before it.

### B.2 DynamoDB single table — **partial**

Every store here — pantry, cooking sessions, plans, carts, checkout sessions — is an in-memory class
behind an interface written to be the DynamoDB repository's shape (`PantryStore`, `CookStore`,
`PlanStore`, `CartStore`, `CheckoutStore`). The idempotency claim in `MemoryPantryStore` is
deliberately three calls — `claimKey`, `commitKey`, `releaseKey` — because in DynamoDB they are a
conditional put, a conditional update and a conditional delete.

**What is real:** the interfaces, the semantics, and the tests that hold them up.
**What is not:** any of it running against DynamoDB, and therefore any claim about latency.

### B.3 The 500 ms budget — **unverified**

Every tool is a read plus pure computation with no external call on the response path, which is what
the budget requires. Nobody has measured it under App Runner with DynamoDB behind it.

**When unblocked:** measure `recipe_search`, `pantry_list`, `plan_week` and `cook_next` at p50 and
p99 against a warmed instance, and put the numbers in the README. `plan_week` is the one to watch: it
scores every recipe against every slot.

---

## C · Hosting

### C.1 App Runner, min 1 instance, TLS — **blocked**

Needs an AWS account and a card. The `Dockerfile` builds and the server starts; nothing has ever run
in the cloud.

**When unblocked:** deploy, set `BASE_URL` to the public origin (recipe `@id`s and the same-origin
check on `/sim/fridge` both read it), and confirm the TLS policy is 1.3 as the checkout reference
requires.

### C.2 Whether the Alexa+ MCP client opens GET/SSE streams — **blocked**

This is the question that decides App Runner versus Lambda (`docs/PLAN.md` §02). The transport here
is stateless Streamable HTTP: one server and one transport per POST. If the client asks for stream
capabilities, that is the code to change, and it is in one place at the bottom of `src/server.ts`.

**When unblocked:** run the Local Inspector against the endpoint and read what it negotiates.

---

## D · The store and UCP

### D.1 Conformance with the UCP specification — **unverified, and the profile says so**

`src/store/ucp.ts` follows the summary of UCP in `docs/PLAN.md` §06: five endpoints plus a profile,
200 with the session state, `messages[]` for commercial errors, `Idempotency-Key` with 409 on a
reused key and a different body, `Cache-Control: no-store`, a six hour TTL, and the
`stored_payment_method` handler. It has never been checked field by field against the specification
and has never spoken to a real client, because neither was reachable. The profile at
`/.well-known/ucp` carries a `disclaimer` field saying exactly that, so nobody integrates against it
by accident.

**When unblocked:** read the checkout integration reference with the code open beside it and correct
the field names. The behaviour — where the money comes from, what is idempotent, what gets disclosed
— is the part worth keeping; the wire format is the part to check.

### D.2 Whether the Web Simulator can exercise checkout end to end — **blocked**

`docs/PLAN.md` §06 flags this as something to verify early, because the answer decides how the video
is shot. If the simulator cannot, plan B is the Local Inspector or a reference MCP client against the
UCP endpoints, said out loud in the video rather than edited around.

### D.3 Amazon Pay and the network token — **out of scope on purpose**

The demo uses `stored_payment_method` with fictional instruments precisely to avoid the Amazon Pay
onboarding. This is a decision, not a blocker, and it should stay one.

---

## E · The connected sources

### E.1 A real SmartThings fridge — **blocked**

Outbound access to SmartThings is not available here, and neither is a fridge. The adapter is
honestly named `simulated`, and the ingest door it posts through is the same signed, idempotent one a
real device would use — which is the part that was worth building blind.

**When unblocked:** point a real device at `POST /ingest/sim-fridge` with a signature, and record in
`docs/IMPORT_SOURCES.md` what the payload actually looked like. The `samsungce.fridgeFoodList` shape
in `test/fixtures/simulated_fridge_reading.json` came from documentation, not from a fridge.

### E.2 Open Food Facts lookups — **partial**

`makeOffLookup` fetches a product record for a scanned barcode, with a timeout, off the response
path. It has never been run against the live service; the tests use a recorded fixture.

**When unblocked:** scan five real barcodes, including one the database does not know, and confirm
the unknown one lands as `unmapped` rather than as a guess.

### E.3 Recipe portals — **blocked, logged separately**

See `docs/IMPORT_SOURCES.md`, which keeps an evidence table that is deliberately empty until somebody
runs the importer against a real page.

---

## F · The MCP Apps views

### F.1 The host handshake — **unverified**

The four views use the real `@modelcontextprotocol/ext-apps` App, bundled inline, rather than a
hand-rolled postMessage bridge, precisely because this is the part that cannot be checked by running
it here. What is tested is everything else: that each view is one self-contained document with no
network of its own, that nothing untrusted reaches the page unescaped, and that no view recomputes a
number the server decided.

**When unblocked:** open each view in the simulator and check three things — that it renders at all,
that the "next step" button's tool call reaches the server, and that the iframe resizes. The
`autoResize` option is on; nobody has seen it work.

### F.2 The 300 KB inline runtime — **a known cost, not a bug**

Each view carries the bundled SDK. If the client turns out to mind, the shape to change is obvious —
one shared resource the views import — but that is not worth doing before somebody has seen a view
render.

---

### F.3 Telling somebody a look is due — **blocked, and the tool is written around it**

The corpus has a four-to-six week sauerkraut, a three-day brine and a twenty-four hour marinade.
`cook_checked` knows when each wants looking at, because a person wrote the plan down in
`data/long_steps.json` — but **this server cannot ring**. An MCP server answers when it is called; it
has no way to wake Alexa+ up, and nothing in the MCP transport gives it one. A reminder, on this
side, is something you have to ask for.

That is a real limitation and the narration is written so as not to paper over it. The sentence says
*"next look in about 24 hours"* and never *"I will remind you"*, and there is a test asserting exactly
that — it fails the build if the wording ever drifts into a promise the server cannot keep.

**When unblocked:** Alexa Reminders are the right home for this, set on the customer's side at the
moment `cook_start` runs, with the schedule this already computes. That needs a skill with the
Reminders permission and a developer account, which is A.1.

---

## G · Delivery

### G.1 Privacy policy and terms at public URLs — **blocked**

Certification requires them at real URLs. `addon.json` needs them and the demo store's refund policy
page (`/store/refund-policy`) is the pattern to follow: say plainly that it is a demonstration rather
than promising terms nobody will honour.

### G.2 The video — **blocked on A.2**

The script is in `docs/PLAN.md` §11. Every line of it is now backed by a tool that runs: the opening
pantry line, the weekly grid with its reasons, the step card with a timer, "where was I?" a day
later, and the checkout with an allergen disclosure writing back to the pantry. What is missing is a
simulator to record it in.

---

## H · The tables somebody has to check

### H.1 The shelf-life numbers — **partial, and this is the one to read twice**

`data/shelf_life.json` says how long 120 foods keep. The numbers come from ordinary kitchen practice
and nobody has measured any of them. They are used only to *schedule* — to put the spinach on
Tuesday rather than Friday — and they are labelled `estimated` everywhere they travel, so the system
never tells anybody their food is safe. But this is the one table in the repository where being
wrong could matter to somebody's stomach rather than to their dinner.

**Before this is shown to anybody as advice**, a cook should read the file end to end, and the
short-lived rows — anything under a week — deserve a second opinion. The garlic-oil row in
particular is there because garlic under oil at room temperature is a real botulism risk; it should
be checked by somebody who knows, not kept because it sounded right.

"Read it end to end" is the correct instruction and is also the one nobody follows, so there is now
an order to work in: `python3 scripts/review_queue.py` ranks every curated row across all five tables
by what it would cost if that row were wrong — reach measured by running the real lookups over the
real corpus, consequence, and a curated `caution` flag for the rows where wrong is a safety matter
rather than a dinner one. It does not rank by how likely a row is to be wrong, because nobody can
compute that. The garlic-oil row now carries `caution` and comes first by a distance. See
`docs/REVIEW_QUEUE.md`.

### H.2 The substitution table's advice — **partial**

Same shape, lower stakes: 90 rows of one cook's judgment. The ratios and warnings are the author's
own and have not been tested by anybody else. `scripts/review_queue.py` gives them an order too, and
here it can be exact: it walks the real lookup chain over the corpus and credits the row that
actually answered, so "this row answers 58 ingredient lines" is a count and not an estimate. Six of
the 90 rows answer nothing at all. Every row is attributable — `author` and `version` at
the top of the file, and the version travels in every `substitute` response — which is the
mechanism for arguing with a row rather than a claim that no row is wrong.

## What is *not* blocked, and is done

Kept here so the two lists can be read together. Every item below runs, has tests that can fail, and
is exercised end to end by `npm run check`:

- the pantry ledger, its fold, and the confidence levels;
- `recipe_search`, `pantry_update`, `pantry_list`;
- the signed ingest door, the simulated fridge, the barcode adapter, the account web;
- recipe exchange by JSON-LD in both directions;
- the substitution table and `substitute`, with its fallback chain and its coverage report;
- the cooking state machine and all six `cook_*` tools, including the deduction on close;
- the weekly planner, `plan_week`, and the plan hash;
- the demo store, `cart_from_plan`, `cart_edit`, and the whole UCP checkout up to the pantry write;
- the four MCP Apps views;
- the shelf-life table, and the estimated expiry the fold derives from it;
- `plan_diff`, per-day time limits, and what a week's shopping costs;
- the kitchen confidence figure and `pantry_audit`;
- `cook_review`, the post-mortem over the session's own transition log.
