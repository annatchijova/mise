# Friction log — Build, Ship, Shape 2026

Five entries, ordered by how much they actually changed what this submission could be. Each one is
backed by evidence already in this repo — `docs/BLOCKED.md` has the full investigation for every
entry here; this file is the judge-facing summary in the format the submission form asks for.

Format per entry: task attempted → steps → expected vs. actual → severity → workaround → actionable
suggestion.

---

## 1. The Alexa AI CLI's AWS trust boundary (critical — blocked the entire certification path)

**Task:** configure the Alexa AI CLI (`alexa-ai configure`) and deploy a real add-on against the
Alexa+ MCP toolkit.

**Steps:** created an Amazon developer account (pre-existing, classic ASK console, 0 skills), created
a fresh AWS IAM user with an explicit `sts:AssumeRole` allow policy, and attempted the CLI's
authentication flow.

**Expected:** the CLI assumes Amazon's shared `AddOn3PDeveloperToolsRead` role and proceeds to
`alexa-ai new mcp` / `alexa-ai deploy`.

**Actual:** `sts:AssumeRole` against that shared role fails with AccessDenied. On AWS's side this
error reads identically whether the cause is a missing permission on our side or a trust policy that
does not yet include this account — there is no way to tell which from the error alone. No
self-service remediation was found anywhere in the classic console's Settings (Skill Access
Management, User Management, My IDs).

**Severity:** critical. This one error blocks everything downstream of it: `alexa-ai new mcp`,
`addon.json` generation, `alexa-ai deploy`, the hosted Web Simulator, the Local Inspector, and
certification — the entire path the toolkit documentation describes as the way to build an Alexa+
add-on.

**Workaround:** pivoted to the hackathon's own documented alternative (named on
`amazonappdev2026.devpost.com/resources`): a self-built web app simulating the Alexa+ experience,
using a real MCP client against the real server (`simulator/` in this repo). This is why this
submission's MCP integration is verified against a real client rather than against Alexa+'s own
hosted simulator.

**Suggested improvement:** when `sts:AssumeRole` fails during onboarding, distinguish — in the error
message itself, not just in support channels — between "your IAM policy is missing a permission" and
"your account is not yet in the trust policy." Right now a developer has no way to know which problem
they actually have, or whether it will resolve itself.

---

## 2. MCP Apps host-side initialization timing (a real bug, found and fixed building `simulator/`)

**Task:** connect an MCP Apps view (the real `@modelcontextprotocol/ext-apps` `App` class, already
running inside each of Mise's four views) to a host implementation and render live tool-call data.

**Steps:** built a host bridge using the real `AppBridge` class, mounted it after the view's iframe
fired its `load` event (the natural-looking place to do it), and sent the view's tool result through
`sendToolResult`.

**Expected:** the view connects and renders the data.

**Actual:** the view's `App.connect()` sends its first `ui/initialize` message the instant its inline
script runs — during iframe document parsing, well before a `"load"` event ever fires. A host that
attaches its message listener after `onload` silently loses that first message. The view sits there
with no data and no error — a genuinely hard failure mode to diagnose from the outside, since nothing
throws and nothing logs.

**Severity:** high for anyone implementing a host from scratch, as this submission did. Low for
anyone only ever running inside an existing, already-correct host (Alexa+'s own).

**Workaround:** attach the host's `PostMessageTransport` listener before assigning the iframe's
`srcdoc`, not after. Fixed and verified in `simulator/public/index.html`'s `showView()` — see the
commit history on that file for the before/after.

**Suggested improvement:** document this ordering requirement explicitly in the host-implementation
guide, or better, make `AppBridge.connect()` itself tolerant of a slightly-late listener (e.g. by
having the view retry its initial message once if it gets no response within a short window).

---

## 3. Alexa+ Web Simulator region availability (high — decided the whole demo strategy)

**Task:** determine, before planning the demo video around it, whether the Alexa+ Web Simulator is
usable from outside the United States.

**Steps:** read the available toolkit and testing documentation for a stated region requirement.

**Expected:** a clear supported-regions statement, one way or the other.

**Actual:** no region statement was found anywhere in the docs read. Combined with friction #1, this
was never actually resolved either way — the account never got far enough to test it directly.

**Severity:** high. This single unknown is why the entire demo plan was built around a self-hosted
simulator rather than around Alexa+'s own hosted one (see #1's workaround).

**Workaround:** none available from outside the blocked account; addressed structurally by not
depending on the Web Simulator at all.

**Suggested improvement:** state supported regions for the Web Simulator plainly in the toolkit docs
— a hackathon participant outside the US should know this on day one, not discover it as a side
effect of a separate, unrelated blocker.

---

## 4. AWS Bedrock: the Anthropic "use case details" gate (medium)

**Task:** use an Anthropic Claude model on Bedrock as the conversational layer for `simulator/`, to
also qualify for the AWS Builder mini-challenge.

**Steps:** requested model access for an Anthropic model on a fresh AWS account, resolved an initial
on-demand throughput error by switching to the inference-profile-prefixed model ID (e.g.
`us.anthropic.claude-haiku-4-5-20251001-v1:0`, found via `aws bedrock list-inference-profiles`), then
attempted an actual `converse` call.

**Expected:** the call succeeds once the correct inference-profile ID is used.

**Actual:** `ResourceNotFoundException: Model use case details have not been submitted` — a separate,
undocumented-at-point-of-error gate specific to Anthropic models on Bedrock, with no clear
self-service path to resolve it quickly.

**Severity:** medium. It didn't block the submission (Mise's own server has no LLM in its decision
path by design), but it did block the AWS Builder mini-challenge path through the most natural model
choice for a hackathon with a 10-day-old AWS account.

**Workaround:** tried Amazon's own Nova models instead (see #5); ultimately decided not to pursue the
AWS Builder mini-challenge at all, since bolting on a Bedrock call with no genuine job to do would
contradict the architecture this project argues for (`README_TECHNICAL.md`, "LLM out of the decision
path").

**Suggested improvement:** surface the "use case details" requirement — and a path to submit it — at
model-access-request time, not only as a runtime error on first real call.

---

## 5. AWS Bedrock: fresh-account daily token throttling on Nova (medium)

**Task:** use Amazon Nova (`nova-2-lite`, then `nova-micro`) on Bedrock as the fallback after #4.

**Steps:** requested and received model access, then attempted real `converse` calls.

**Expected:** calls succeed within whatever reasonable rate limit a hackathon-scale workload needs.

**Actual:** `ThrottlingException: Too many tokens per day` on both models tried — an account-wide
daily quota that a freshly created AWS account hits almost immediately, with no documented
self-service increase path found in the time available.

**Severity:** medium. Combined with #4, this is what ultimately decided not to use Bedrock in
`simulator/` at all — it now uses the Gemini API instead, a decision made explicitly, not by default.

**Workaround:** none found within the hackathon's timeframe; switched providers.

**Suggested improvement:** either raise the default daily token quota for new accounts specifically
during named hackathon windows, or document the request-increase path somewhere a participant would
actually find it before hitting the wall.
