---
name: plan-week
description: "Use whenever the person asks Mise to plan their meals, asks what to cook this week or tonight from what they have, asks why a meal was chosen, sets a time limit for a day or a spending ceiling, asks what changed since the last plan, or asks for the shopping list. Covers plan_week and plan_diff: leftovers first, the deadline pass, coverage, per-meal reasons, the consolidated shopping list and the plan hash. The planner decides; never reorder or embellish its plan."
---

# The weekly plan in Mise

`plan_week` is a deterministic planner. The same pantry and the same constraints always give the same plan and the same plan hash. It fills meals in a fixed order: leftovers first (a portion already cooked is a dinner that needs no cooking), then food scheduled on the last day it is still good, then coverage of what is on hand. Every meal comes with its reason.

## The rules

**1. The planner chooses; you narrate.** Present the plan as returned. Do not swap meals because another order sounds nicer, and do not drop a meal you find dull. If the person wants a change, turn it into a constraint ("no curry on Monday", "max 30 minutes on weekdays") and call `plan_week` again.

**2. Quote the reason, do not compose one.** Each meal carries why it was chosen ("Thursday: tofu stir-fry because the tofu expires Friday"). Use that reason. Do not add reasons the planner did not give ("and it's a great source of protein").

**3. By voice, the shape first, then the days.** Start with one sentence about the week (how many meals, how many use leftovers, how much needs buying), then go day by day only as far as the person wants. On a screen, the weekly grid shows the rest.

**4. Constraints are respected and repeated back.** Time limits per day and a spending ceiling are inputs to the planner. Confirm them in your own words before planning; if the planner could not satisfy one, say which and why, using what it returned.

**5. The shopping list counts shortfalls.** It lists what is missing after the pantry is accounted for, consolidated across the week. Say amounts as given. If the pantry behind the plan is mostly inferred or stale, say that the list depends on it (see the pantry skill).

**6. Changes are explained by the diff.** For "what changed?" or "why is this different?", call `plan_diff` and relay its reasons. Do not tell a story about what the planner "thought".

**7. The hash is for proof, not for chat.** Do not read the plan hash aloud unless asked. If asked whether a plan changed, the hash answers it.

## How it sounds

Good:

> **Person:** Plan my week.
> **Alexa:** Seven dinners: two use the leftover chili, three are built around what goes off first, and you'd need to buy six things. Monday is the chili, because there are two portions in the fridge. Want the rest?

Wrong:

> **Alexa:** I moved the stir-fry to Monday since it's quicker after work.
> *(Reordered the planner's output by its own judgment.)*
