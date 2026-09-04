# Mise — architecture plan (Amazon Developer Hackathon 2026, Alexa+ track)

> English version of the author's planning document. The Spanish original is `docs/PLAN.es.md`; the
> fully formatted source of truth, with diagrams, is `docs/PLAN.es.html`. The integration plan that
> extends this one with block I is `docs/INTEGRATIONS_PLAN.md`.

Amazon Developer Hackathon 2026 · Alexa+ track · architecture and work plan

An MCP add-on for Alexa+ that keeps the pantry by voice, plans the week around what is there and what
is about to expire, guides cooking step by step without losing the thread between sessions,
substitutes with a chef's judgment, and buys what is missing. Working name; change it whenever.

- **Stack:** TypeScript · Node 22
- **Hosting:** AWS (App Runner + DynamoDB)
- **Purchase:** UCP checkout, own demo store
- **Testing:** Web Simulator (no device)
- **Locale:** en-US (English content)

## 01 · What the platform decides for you

Three things from the official documentation that fix the shape of the system before a line is written.

**Alexa+ is the LLM.** The add-on exposes tools over MCP; Alexa+'s reasoning decides when to call
them, extracts entities from what the person said, and narrates the result. Your server has no model
of its own: it is data plus deterministic logic. The rubric rewards "agentic workflows that
orchestrate services autonomously", and that orchestration is done by Alexa+ over your tools — you
provide the right pieces and descriptions that map to distinct intents.

**Buying is not buying on Amazon.** An add-on's checkout follows UCP (Universal Commerce Protocol):
Alexa+ is the agent, not the merchant. Your backend is the merchant of record, the source of prices,
taxes, stock and shipping, and exposes five REST endpoints plus a profile at `/.well-known/ucp`.
There is no documented way for an add-on to buy Amazon Fresh or Whole Foods products. For the
hackathon, "purchase capability" means implementing a store of your own — here, a demo grocery with
real SKUs from the recipes.

**State between sessions is yours, tied to account linking.** Alexa+ keeps the conversational thread
on its side and documents no user identifier for tools without linking. The stable identity comes
from the OAuth 2.1 bearer token (authorization code + PKCE S256, `resource` parameter, PRM document).
Without linking there is no "where was I?". Certification also requires a working guest experience
for whatever does not need an account.

**Latency, two figures in the documentation.** The quickstart says the response must arrive in under
500 ms; the functional requirements say "results within 3 seconds" and show an interim message if the
tool is slow. Design for the hard figure: every tool is a DynamoDB read/write plus pure computation,
with no external call on the response path.

## 02 · Architecture

```
  Alexa+                                 AWS APP RUNNER · 1 CONTAINER · TLS · MIN 1
  NLU · reasoning · voice                ┌──────────────────────────────────────────────┐
  MCP client · registry                  │  MCP server        POST /mcp · Streamable HTTP │
  orchestrator · UI       ── tools/call ─►│                    tools + ui:// resources     │
                                         │                    zod at the edge             │
                          ── UCP REST ──►│  Demo store · UCP  /checkout-sessions          │
                                         │                    /.well-known/ucp            │
                          ── bearer ────►│  OAuth 2.1         /authorize · /token · PKCE  │
                                         │  (account linking) /.well-known/oauth-…        │
                                         └──────────────┬───────────────────────────────┘
                                                        ▼
                                         DynamoDB · single table
                                         USER · PANTRY_EVT · RECIPE · SUBST
                                         COOK · PLAN · SKU · CART · CS
```

One container on App Runner serves the three surfaces under the same TLS URL (App Runner gives HTTPS
out of the box; a custom domain is optional). Min 1 instance removes the cold start during the demo.
There is no LLM on your side.

**Why App Runner and not Lambda.** Streamable HTTP works in stateless mode (each POST returns JSON)
and that fits Lambda, but the Alexa+ MCP client advertises `roots` capabilities and the documentation
does not say whether it opens GET/SSE streams that Lambda handles poorly. An always-warm container
avoids the cold start and the transport doubts for the price of a small service. If you prefer
Lambda, the thing to verify is exactly that: run the Local Inspector against the endpoint and see
whether it asks for stream capabilities.

**OAuth: Cognito or your own server.** Alexa+ requires OAuth 2.1 with PKCE, the `resource` parameter
(RFC 8707) pointing at the MCP server's canonical URI, and a PRM document; it supports neither Dynamic
Client Registration nor OIDC. Cognito covers authorization code + PKCE and scores in the AWS
mini-challenge, but you must verify that it accepts `resource` and that the PRM served from your
domain points correctly at its metadata. The alternative is a minimal OAuth 2.1 server inside the
same container (oidc-provider or hand-made): more code, full control, and it is your turf. Decide
after a half-hour linking test with Cognito.

## 03 · Data model

One DynamoDB table with composite keys. What matters is not the schema but three decisions of shape.

**The pantry is a ledger, not an inventory.** Every change is an append-only event (add, consume,
remove, correct) with an origin (voice, recipe_deduction, checkout). The current state is a fold over
the events, and each item carries a confidence level: `confirmed` when the person said it, `inferred`
when a cooked recipe deduced it, `stale` after N days without confirmation. The tool never presents an
inferred quantity as certainty; Alexa+ narrates it with that reservation because the
structuredContent marks it.

**A recipe is a state machine, not a text.** Ordered steps with estimated duration, dependencies and
parallel timers; ingredients with a role (fat, acid, binder, umami, protein, aromatic) and not just a
name. The role is what makes substituting with judgment possible.

**Substitutions are a table you curate, versioned.** Key: ingredient + role + technique (must it
emulsify? brown? bind cold?). Value: alternatives with a ratio and a warning. Alexa+ does not invent
substitutions; it chooses among the ones you wrote. That is the product argument nobody else in the
hackathon can make.

| Entity | PK / SK | Fields that matter |
|---|---|---|
| User | `USER#id / PROFILE` | restrictions (vegan fixed; allergies), people at home, typical time per meal, units (g/ml) |
| Pantry event | `USER#id / PANTRY#ts#ulid` | type, ingredient_id, qty+unit, origin, expires_on (if stated), confidence |
| Recipe | `RECIPE#id / V#n` | title, yield, steps[{order, text, dur_s, timer?, depends_on[]}], ingredients[{id, role, qty, unit, technique}] |
| Substitution | `SUBST#ingredient / ROLE#technique` | alternatives[{ingredient, ratio, warning}], version, author |
| Cooking session | `USER#id / COOK#recipe#started` | state, current_step, active timers, deviations[{step, what_changed}], transition log |
| Weekly plan | `USER#id / PLAN#week` | meals[{day, recipe, why: uses_X_that_expires}], missing[], plan hash |
| SKU (store) | `SKU#id / META` | title, price in cents, stock, maps_to_ingredient |
| Cart / checkout | `USER#id / CART · CS#id / STATE` | line_items, totals, UCP status, expires_at (6 h), idempotency keys (24 h) |

## 04 · MCP tools

Each tool maps to a distinct intent (certification requirement: clear descriptions, with synonyms,
promising no more than delivered). Inputs validated with zod at the edge; output always in
structuredContent, and where there is UI, `_meta.ui.resourceUri`. Tools that need an account declare
it and return a well-formed MCP error without linking; guest tools work on their own.

| Tool | Input | Returns | Account |
|---|---|---|---|
| `pantry_update` | items[{name, qty, unit, expires?}], mode: add\|consume\|correct | resulting state of those items with confidence | yes |
| `pantry_list` | filter: all\|expiring_soon\|low | items + confidence + days to expiry · UI: pantry view | yes |
| `recipe_search` | query?, use_ingredients?[], max_minutes? | candidates with % of ingredients already on hand | no |
| `plan_week` | days, meals_per_day, time_budget_min, avoid?[] | plan + per-meal rationale + consolidated missing items · UI: grid | yes |
| `substitute` | ingredient, recipe_id?, step? | curated alternatives with ratio and warning | no |
| `cook_start` | recipe_id, servings? | session created, step 1, mise en place · UI: step card | yes |
| `cook_next` | completed_hint? | next step; if the hint does not match the current step, records a deviation and says so | yes |
| `cook_where_am_i` | — | active or paused session, step, timers, elapsed time | yes |
| `cook_note` | note (e.g. "used chickpeas instead of lentils") | deviation recorded; adjusts the pantry deduction on close | yes |
| `cook_pause` / `cook_finish` | — | resumable pause · on finish: consume ingredients (inferred events) | yes |
| `cart_from_plan` | plan_id?, days?[] | cart with store SKUs, price, what could not be mapped · UI: cart | yes |
| `cart_edit` | add[] / remove[] / qty changes | updated cart | yes |

Checkout is not a tool: Alexa+ triggers it through the UCP surface when the person says they want to
buy. Your `cart_from_plan` tool leaves the cart ready with the SKU ids that later travel in
`line_items`.

Example definition (official TS SDK):

```ts
server.registerTool("cook_next", {
  title: "Next cooking step",
  description: "Advance the active cooking session to the next step. Use when the customer says they finished a step, asks what's next, or says 'done', 'ready', 'ok next'.",
  inputSchema: { completed_hint: z.string().optional() },
  _meta: { ui: { resourceUri: "ui://mise/step-card" } }
}, async ({ completed_hint }, extra) => {
  const user = requireLinkedUser(extra);                 // from the bearer token
  const next = await cook.advance(user, completed_hint); // deterministic, <50 ms
  return { structuredContent: next, content: [{ type: "text", text: next.spoken }] };
});
```

## 05 · The three deterministic engines

**Cooking session**

```
idle ──cook_start──► mise en place ──cook_next──► at step n ──pause──► paused
                                                    │  ▲                 │
                                  cook_next (n+1)   │  └── where_am_i / next
                                  cook_note (deviation)
                                                    ▼
                                             last step ──► finished ──► consume events (inferred)
```

Every transition is recorded with its input (what the person said, what step the system expected).
"I already added the onion" when the current step was another breaks nothing: it is recorded as a
deviation and the pantry deduction honors it on close.

**Weekly planner**

An integer, deterministic score, not a model. For each slot (day, meal) the candidate recipes are
scored: use ingredients that expire soon (high weight, decreasing with days left), minimize missing
items, respect the slot's available time, penalize repeating the same protein in consecutive meals
and the same recipe in the week. Greedy assignment per slot ordered by expiry urgency; the same pantry
state produces the same plan. The plan comes out with its per-meal rationale ("Thursday: tofu
stir-fry because the tofu expires Friday") and a plan hash — the house signature, and it gives Alexa+
something concrete to narrate instead of justifying on its own.

**Substitutions**

Exact lookup by (ingredient, role, technique), falling back to (ingredient, role) and finally (role).
You write every entry: ratio, what changes in texture or flavor, and when it does not work ("aquafaba
does not bind when hot"). For the demo, 30–50 entries covering the ingredients of the 8–12 recipes
are enough. The repo versions them as data, not code.

## 06 · Purchase: the demo store and UCP

Alexa+ starts the session with the cart items and the buyer context; your backend always answers
HTTP 200 with the UCP state and uses `messages[]` for commercial errors. The payment method chosen for
the demo is `com.amazon.payments.stored_payment_method`: "saved" instruments in your store (fictional
cards) that you return in Create and validate in Complete against the token's user. It avoids the
Amazon Pay onboarding that requires the network token.

| Endpoint | Who calls | What you do |
|---|---|---|
| `GET /.well-known/ucp` | discovery | profile with version 2026-04-08, capability `dev.ucp.shopping.checkout`, handler `stored_payment_method` |
| `POST /checkout-sessions` | Alexa+ (Create) | validate SKUs and stock, prices from your catalog (never from the request), totals in cents, payment instruments, refund policy link, `expires_at` +6 h |
| `GET /checkout-sessions/{id}` | Alexa+ (recovery) | current state, `Cache-Control: no-store` |
| `PUT /checkout-sessions/{id}` | Alexa+ (Update) | address/selections → recompute shipping and tax, move to `ready_for_complete` |
| `POST /checkout-sessions/{id}/complete` | Alexa+ (Complete) | validate that `payment_method_id` belongs to the user and that you returned it in Create; decrement stock; emit `add` events to the pantry with origin `checkout` |
| `POST /checkout-sessions/{id}/cancel` | optional | state transition |

- Headers on every call: `Authorization: Bearer`, `Idempotency-Key` on state-changing ones (same key
  with a different body → 409), `UCP-Agent`, `Request-Id`.
- TLS 1.3 minimum — App Runner supports it; confirm the domain's TLS policy.
- Messages with `presentation: "disclosure"` for allergens: as a chef, showing "contains sesame" at
  checkout is a detail a judge notices.
- Closing the loop is the product argument: completing the purchase writes to the pantry, and the
  next `plan_week` already sees it.

Verify early: whether the Web Simulator lets you exercise checkout end to end without certification.
The testing documentation does not say. If not, the video shows checkout with the Local Inspector or
a reference MCP client against the UCP endpoints, and explains it.

## 07 · Account, state and the guest experience

With linking: the bearer token identifies the user, and all state (pantry, plan, cooking session,
cart) hangs off that id. Without linking: `recipe_search` and `substitute` work the same, and the
rest answers with a message inviting the person to link the account, with no dead end. Alexa+ carries
the conversation's context; your server carries the person's context. That division is what makes
"where was I?" work a day later, on another device, in another conversation.

## 08 · MCP Apps: the four views

Alexa+ supports the MCP Apps extension: a `ui://…` resource with bundled HTML that the client renders
in an isolated iframe and that communicates over JSON-RPC on postMessage using
`@modelcontextprotocol/ext-apps`. Without a declared UI, Alexa+ uses the "data only" flow and builds
its own visuals from structuredContent — so the views are polish, not a blocker. Value order for the
demo:

- Step card (`cook_start`, `cook_next`): current step, large; timer; this step's ingredients; a
  "next" button that calls `cook_next` from the UI.
- Weekly grid (`plan_week`): days × meals, each cell with its reason; missing items below with a
  button that calls `cart_from_plan`.
- Cart (`cart_from_plan`): items, prices, what could not be mapped to a SKU.
- Pantry (`pantry_list`): items with a confidence badge and days to expiry — the place where it shows
  that the system does not pretend to know what it does not know.

You have the frontend solved; the only different thing here is the sandbox: no external network from
the iframe, everything inline, and actions that trigger tools ask for the user's approval by design of
the protocol.

## 09 · How it covers the rubric

| What the rubric calls "creative" | Where it lives in Mise |
|---|---|
| Agentic workflow orchestrating services autonomously | pantry → planner → cart → checkout → pantry, with Alexa+ chaining tools without the person naming any |
| Context-aware add-on keeping state across sessions | resumable cooking session; pantry ledger with confidence; persisted plan |
| Purchase capabilities | full UCP with a stored payment method and allergen disclosure |
| Media / MCP Apps support | four MCP Apps views; step card with a timer |
| Agent Skills | the add-on registers through the toolkit's guided flow |
| What the rubric calls "obvious" and must be avoided | no tool is a wrapper of someone else's API; no answer is a one-turn Q&A |

With an Apache-2.0 license and a public repo, the project also enters the Open Source mini-challenge,
and hosted on AWS it enters AWS Builder. The rules allow one track prize plus one mini-challenge prize
per project.

## 10 · Work inventory

Everything to be done, grouped by area and in the order that reduces risk fastest. No dates: you
organize that. First close a minimal round trip with the platform; only then is content worth
building.

**A · Access and skeleton** — first, de-risks the platform
- Install the Alexa AI CLI, `alexa-ai configure` (Login with Amazon) with the developer account
- Public Apache-2.0 repo, TypeScript, `@modelcontextprotocol/sdk`, zod, esbuild; Dockerfile
- MCP server with a single tool (`recipe_search` over in-memory data), Streamable HTTP at `/mcp`
- Deploy to App Runner (min 1 instance) or expose with cloudflared for the first test
- `alexa-ai new mcp --locale en-US --mcp-server-url …`, complete `addon.json` (icons in 6 sizes,
  provisional privacy/terms URLs), `alexa-ai deploy`
- Round trip in the Web Simulator: ask for a recipe and see the answer. Nothing more until here
- Run the Local Inspector and save the readiness report as a baseline

**B · Account and state**
- Half-hour test: Cognito with PKCE + `resource` + PRM. If it does not close, a minimal OAuth 2.1
  server in the container
- Account linking in the add-on; extract the user id from the bearer in a single middleware
- DynamoDB single table, repository access; pantry ledger with fold and confidence levels
- Guest path: account-free tools work; the others return a well-formed MCP error

**C · Chef content** — your advantage, start in parallel with A
- Recipe format as data (JSON/YAML): steps with duration, timers, dependencies; ingredients with role
  and technique
- 8–12 vegan recipes written in that format, in English, chosen so they share ingredients and
  exercise substitutions
- Substitution table: 30–50 entries with ratio and warning, versioned
- Store catalog: ~40 SKUs covering the recipes, prices in cents, stock, allergens

**D · Tools and engines**
- `pantry_update`, `pantry_list` over the ledger
- Cooking state machine: `cook_start/next/where_am_i/note/pause/finish`; transition log; deduction on
  close
- `substitute` with lookup by (ingredient, role, technique) and fallbacks
- Planner: integer scoring, greedy by urgency, per-slot rationale, plan hash; `plan_week`
- `cart_from_plan`, `cart_edit` with ingredient → SKU mapping and the unmapped list
- Tool descriptions with synonyms; short ≤123 characters, full ≤4000; 3–4 invocation examples ≤200
  characters each

**E · Store and UCP**
- `/.well-known/ucp`; the five checkout endpoints; idempotency with 409; no-store; 6 h TTL
- `stored_payment_method` handler with fictional instruments bound to the user; validation in Complete
- Simple but server-side tax and shipping; allergen disclosure in `messages[]`
- Complete writes events to the pantry with origin `checkout`
- Verify whether the Web Simulator exercises checkout; if not, plan B for the video

**F · MCP Apps views**
- Set up `@modelcontextprotocol/ext-apps`; `ui://mise/*` resources bundled inline
- Step card with timer and next button → then weekly grid → cart → pantry

**G · Tests**
- Unit tests that can fail: ledger fold, valid and invalid session transitions, plan determinism
  (same input → same hash), UCP idempotency (same key, different body → 409)
- Local Inspector green before every deploy; recorded Web Simulator sessions for the script's lines

**H · Delivery**
- Real privacy policy and terms at public URLs; refund policy for the demo store
- README with setup, architecture, and what is deterministic vs. what Alexa+ does
- Video ≤3 min (script below) recorded in the Web Simulator with the device screen view
- Devpost form: Alexa+ track, AWS Builder and Open Source mini-challenges

## 11 · Video script (3 minutes)

One story, no technology explained until the end. Each segment shows a rubric capability without
naming it.

- **0:00** "I've got two onions, half a kilo of red lentils, and the tofu expires Friday." Pantry by
  voice. The view shows the tofu with days to expiry and everything marked confirmed.
- **0:30** "Plan my dinners through Thursday, forty minutes max." Weekly grid. The tofu lands on
  Thursday and the cell says why. Consolidated missing items below.
- **1:00** "Let's cook tonight's lentils." … "Done with the onions." … "I'm out of tahini." Step card
  with timer; substitution with ratio and warning from the chef's table.
- **1:40** "Pause." — cut — "Where was I?" Resumes at step 5 with the timer where it stopped. State
  across sessions, without explaining it.
- **2:10** "Order what's missing for Thursday." Cart → checkout with a saved card → "contains sesame"
  disclosure → receipt. The pantry already shows what was bought.
- **2:45** Closing card: what the server decides (everything that counts) and what Alexa+ does
  (understand and narrate). Fifteen seconds of architecture, no more.

## 12 · Risks and pending verifications

- **verify** Web Simulator availability from Argentina with a developer account: the toolkit is
  US-only and the testing documentation says nothing about region. It is the first thing tested in
  block A.
- **verify** End-to-end checkout in the simulator without certification.
- **verify** Cognito with `resource` (RFC 8707) and PRM; if not, own OAuth.
- **verify** Whether the Alexa+ MCP client opens GET streams besides POST (decides Lambda vs.
  container).
- **verify** What context arrives in the MCP session without linking (locale, timezone) — the
  documentation does not enumerate it.
- **decision** All content in English: the add-on is created with locale en-US and the video is
  requested in English.
- **decision** No LLM of our own on the server. If at some point you are tempted to add one (say, to
  parse free-form ingredients), the answer is no: Alexa+ already extracts entities, and adding a model
  breaks both the latency and the argument.

## 13 · Sources

Alexa+ MCP Toolkit Overview · MCP QuickStart · Client and App Lifecycle · Functional Requirements ·
Checkout Integration Reference (UCP) · Test Your MCP Add-ons · MCP Apps (official extension) ·
Hackathon rules
