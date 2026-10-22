# Video narration — read this, don't improvise it

A literal, copy-paste script for the ≤3:00 Devpost video (`docs/PLAN.md` §10 sets the 3-minute cap;
`docs/DEMO_SCRIPT.md` has the full beat-by-beat reasoning and is the source this was compressed from —
read that first if a beat here needs more context on *why* it's in). This file is meant to be read
straight into the recording, line by line. Two kinds of line:

- **SAY (to Mise):** — speak this into the simulator, exactly as written. These are what Alexa+ hears.
- **NARRATE:** — your own voice, over the screen, explaining nothing technical. Say it like you're
  telling a friend what just happened in your kitchen, not presenting a feature.

Timestamps are targets, not a metronome — if a beat runs long, cut from the closing, not the middle.

---

## 0:00 – 0:20 — Open on the kitchen, not the code

**NARRATE:**
> I cook. Creative reuse is most of what I do in a kitchen — what's about to turn, what's left in the
> pan, what two things in the fridge have never met but should. And even a chef runs out of ideas some
> nights. This is Mise: a pantry and cooking companion for Alexa+, built so it never once makes
> something up to sound helpful.

## 0:20 – 0:45 — The pantry, and the word "roughly"

**SAY:** "What have I got?"

**NARRATE:**
> Notice it doesn't flatten the answer. Spinach is *roughly* four days by its own reckoning. Milk is
> expiring tomorrow because I told it so. The tomato — it just says the amount is unknown. It would be
> so easy to guess a number there. It doesn't.

## 0:45 – 1:25 — The week, and the hash

**SAY:** "Plan my dinners through Thursday, forty minutes max."

**NARRATE:**
> Each night comes with its own reason — this one's Thursday because the spinach goes off that day.
> And here's the part I actually care about: run this twice on the same pantry, and it hands back the
> exact same plan, byte for byte. Say the hash out loud if there's room. A model that plans your week
> gives you a different week every time and can't tell you why. This can hand you a receipt.

**SAY:** "We're out on Thursday."

**NARRATE:**
> Move one thing, and the plan explains what shifted and why — in the same terms, not a shrug.

## 1:25 – 2:05 — Cooking, and the two refusals

**SAY:** "Let's make the lentil stew, for four."

**NARRATE:**
> The card is a checklist a person can actually shop from — *about 330 grams*, not 333.333.

**SAY:** "I'm out of tahini, what can I use instead?"

**NARRATE:**
> It swaps from a table a cook actually wrote — sunflower seed butter, a ratio, a warning about what
> changes in the flavor. Now ask it about something that table doesn't cover.

**SAY:** "I'm out of broad beans too."

**NARRATE:**
> "I have nothing curated for broad bean — tell me what it was doing in the dish, and I can answer."
> That silence is the whole point. It would rather say nothing than invent a substitution that could
> ruin your dinner — or worse.

## 2:05 – 2:25 — Leftovers, with a name

**SAY:** "The tofu expires tomorrow and the lettuce looks rough. What can I do?"

**NARRATE:**
> It doesn't search "a tofu recipe." It looks at what's already in here, ranks by what's about to
> turn, and pairs it with an actual technique — not "cook better," something concrete. This is the
> creative-reuse instinct I started with, just handed back to me when I'm out of ideas myself.

## 2:25 – 2:45 — The floor, not the hedge

**SAY:** "How many calories is that?"

**NARRATE:**
> "At least 284 a serving — that's five of six ingredients I can account for, and I have no figures
> for the plant milk powder, so I stop there." Every other assistant gives you a confident number.
> This one tells you exactly where its knowledge runs out, and stands behind the part that's real.

## 2:45 – 3:00 — Close

**NARRATE:**
> Alexa+ is the only thing in this system that talks. Everything it says comes from a deterministic
> server that decided first and never guesses — the pantry, the plan, the substitution, the number.
> The technical case for that — how it's enforced, what's tested, what's still open — is all in the
> README. This is Mise.

---

## If the video is still running long

Cut, in this order, before touching the opener or the closer:

1. The "We're out on Thursday" re-plan line inside beat 2 (saves ~15s).
2. The "broad beans too" refusal in beat 3 — keep only the tahini substitution, drop the "nothing
   curated" follow-up (saves ~10s, but this is the second-best beat in the whole script; cut it last).
3. Shorten the pantry beat's narration to one sentence instead of three.

Do not cut the opener or the closer. The opener is the only place the human story lives; the closer is
the only place that points a judge who wants the technical depth at where it actually is.

## Before recording, not after — pantry state to seed

Checked live against the running server (2026-10-22): the current pantry's top `zero_waste` candidate
is mushroom pate, not the tofu/lettuce pairing beat 4 depends on — there's no tofu or lettuce in the
pantry right now that's actually about to turn. Seed it with `pantry_update` (tofu near its expiry
date, lettuce marked confirmed and close to its shelf-life limit) before recording, and re-run
`zero_waste` with no arguments to confirm it actually surfaces that pairing before this beat goes on
camera — don't assume the gh-pages page's example state still matches the live server.
