# `data/long_steps.json`

What to look at during a step long enough that nobody sits through it.

The corpus has a four-to-six week sauerkraut, a three-day cucumber brine and a twenty-four hour
marinade. A cooking session that survives days already works — it is a ledger, not a process — but
nothing in it ever said *go and look at the cabbage*, and a single alarm six weeks out would be
useless. The whole skill of a ferment is what you do on the way through it.

## Two things this refuses to do

**It does not work out a cadence.** How often to look at a ferment is culinary knowledge. Deriving
"every three days" from a duration would be arithmetic wearing an expert's coat, and it would be
wrong in both directions: a two-hour ketchup wants stirring far more often than a fortnight of
sauerkraut wants opening. The cadence and the things to look at are curated, per step, by a person.

**It does not read the step's text.** The corpus's steps carry no technique field, and deciding "this
looks like a ferment" from the words is exactly the inference this project is arranged against. Rows
are keyed on `(recipe_id, step)`.

That key does not generalise, and that is the honest cost: a new long step gets no check-ins until
somebody writes them. The validator reports which steps are waiting, so the gap is visible rather
than silent.

## Three silences, never conflated

| | |
|---|---|
| **`scheduled`** | a plan with a cadence and things to look at |
| **`nothing_to_check`** | somebody decided this step wants leaving alone, and the row says why |
| **`no_plan`** | nobody has written one yet |

The second and third look identical from the outside and are completely different. Ten of the
corpus's eighteen long steps are the second kind — a mousse setting in the fridge, a bag of ceviche
the recipe explicitly tells you not to open — and a row asserting "there is nothing to check here" is
a decision worth recording. The validator enforces that such a row carries no `look_for` lines: a row
that asserts nothing must not also look like advice.

## A row

```json
{
  "recipe_id": "sauerkraut",
  "step": 11,
  "kind": "ferment",
  "first_check_s": 86400,
  "check_every_s": 259200,
  "look_for": [
    "The cabbage should still be under its brine. Push it back down if it has risen.",
    "Take any mould off the edges. The recipe says not to worry about it and that it will not get far.",
    "From four weeks on, taste it. It is ready when you like it, not when the clock says so."
  ],
  "note": "Four to six weeks, and the recipe itself says to taste at four..."
}
```

`look_for` is the valuable half. It is carried through to the person untouched, in the words it was
written in, and the best lines in the table are the ones that come from the recipe itself — the
sauerkraut's own text says not to worry about mould at the edges, so the plan says it too.

`kind` is curated, never read out of the step's text. It is there for grouping and for a curator
scanning the table, not for the lookup.

## The schedule is derived, never stored

Check-in times are computed from the step's start, its duration and the clock, for the same reason
`stale` is: a stored copy gives the system two answers to one question.

**A look answers everything scheduled up to it.** Somebody who missed four looks catches up with one
— you cannot look at a jar four times at once — so the last recorded look marks every earlier slot
done. Being behind is said as *how late*, not as a number of outstanding things:

> A look is overdue on this — the plan wanted one 10 days ago.

rather than "4 looks are due", which asks a person for four things they cannot do. A reminder that
nags about work nobody can perform is a reminder that gets ignored.

## What this cannot do

**It cannot ring.** An MCP server answers when it is called and has no way to wake Alexa+ up. So the
narration says *"next look in about 24 hours"* and never *"I will remind you"* — and a test asserts
that, so the build fails if the wording ever drifts into a promise the server cannot keep. See
`docs/BLOCKED.md` §F.3.

## What the validator enforces

- Every row points at a step that **exists**. A renamed recipe or a re-ordered step orphans a plan
  silently, and this is the only table here where that is possible.
- A cadence with nothing to look at is a reminder with no content, and fails.
- A row saying there is nothing to check must carry no `look_for` lines, and must still say why.
- The first look cannot fall after the step is over.
- **Coverage**, as a warning: which steps of an hour or more have no plan. Currently 18 of 18.
