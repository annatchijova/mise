# The demo, in order

The video is blocked on the Web Simulator (`docs/BLOCKED.md` §A.2 and §G.2), so this is the script
written down while it is still fresh — a running order, what to say over each beat, and why that beat
is in and not another one.

The whole thing is arranged around a single claim: **Alexa+ is the LLM, and this server never
guesses.** Every beat is chosen because it is a moment where guessing would have been easier and the
system refused. Anything that only demonstrates that the code works is out.

---

## 1 · The pantry, and the word "roughly" (0:00 – 0:35)

> *"What have I got?"*

The answer distinguishes what you said from what a device reported from what was worked out from your
cooking, and it says which is which, out loud, in the sentence. Two things to point at:

- **"roughly four days by my reckoning"** against **"expiring tomorrow"** — an estimate from the
  shelf-life table and a date somebody actually gave never merge into one number.
- **"some tomato, amount unknown"** — `null` is a real answer. A pantry that fills that in with a
  plausible amount is a pantry that lies, and it lies in exactly the way nobody can detect.

## 2 · The week, and the hash (0:35 – 1:20)

> *"Plan my week."*

Each night comes with the planner's own reason: *because it uses the spinach, which goes off on
Thursday.* Then the beat this whole section exists for, and it is worth fifteen slow seconds:

> **Say the plan hash out loud.** Then say what it means: the same pantry and the same week produce
> the same plan, byte for byte, every time. Run it twice on camera if there is room.

That is the shortest available demonstration of the thesis. A model that plans your week gives a
different week each time you ask and cannot tell you why either one happened. This can hand you a
hash, and if the hash matches, the reasoning matched. Fifteen seconds on that is worth more than
another feature.

Then move one thing — *"we're out on Thursday"* — and re-plan. The diff explains itself in the same
terms: what moved, and which constraint moved it.

## 3 · Cooking, and the two refusals (1:20 – 2:20)

> *"Let's make the lentil stew, for four."*

Three beats, in this order:

1. **The card.** The mise en place is a checklist, not a list read aloud, and every amount is one a
   person can actually fetch — *about 330 g*, not 333.333 g. Show the large-print toggle here: one
   step, high contrast, nothing else. It is an accessibility win and it films beautifully.
2. **"I'm out of broad beans."** The substitution comes from a table a cook wrote, with a ratio and
   what changes. Then ask for something the table does not cover and let it say so: *"I have nothing
   curated for that."* **The silence is the demo.**
3. **"I used butter beans instead."** It records the swap, deducts against what was really used —
   and the swap goes into a queue for a curator rather than into the table. Say that out loud: the
   table grows when a person edits it, and at no other moment.

## 4 · The thing nobody else shows (2:20 – 2:50)

> *"How many calories is that?"*

> *"At least 284 a serving, and I mean at least: that is the five of six ingredients I can account
> for, and the rest can only add to it. I stop short of a total because I have no figures for the
> plant milk powder."*

This is the beat to slow down on. Every other assistant answers this question with a number. This one
explains that the recipe does not state its amounts — most home cooking does not — and gives the one
claim that is actually provable instead. **A floor is not a hedge. It is a different and stronger
kind of statement**, and it is available precisely because nothing here is willing to guess.

## 5 · Six weeks later (2:50 – 3:10)

> *"How's the sauerkraut?"*

Because a session is a ledger and not a process, it is still there. It says what to look at — the
cabbage under the brine, the mould at the edges the recipe itself says not to worry about — from a
plan a person wrote for that step.

Say what it cannot do, in the video: it cannot ring you. It answers when asked. Naming a limitation
on camera costs eight seconds and buys the credibility of everything else in the three minutes.

## 6 · The shop (3:10 – 3:30)

Cart from the plan, allergens disclosed, checkout, and the pantry already knows. Keep it brisk — it
is the least surprising part of the demo, and its job is to close the loop rather than to impress.

---

## What is deliberately not in the video

- **The integrations.** A fridge that is simulated should not be filmed as though it is a fridge.
- **The UCP checkout's conformance.** It is written to a summary of a specification nobody here could
  read, the profile says so, and the video should not imply otherwise.
- **Anything that only shows the code working.** A demo of a system whose entire argument is honesty
  cannot afford a single shot that overstates what it does.
