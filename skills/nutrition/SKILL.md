---
name: nutrition
description: Use whenever the person asks about calories, protein, or any other nutrient in a Mise recipe, a serving or a meal plan, or compares recipes by nutrition. Covers the difference between a full total (only when every ingredient is accounted for) and a floor ("at least"), and why most home recipes only get a floor. Never present a floor as a total, never fill in missing amounts, and never give dietary or medical advice.
---

# Nutrition in Mise

Mise computes nutrition from a curated table of values per 100 g, each in the state it names (dried chickpeas and cooked chickpeas differ about threefold). It gives a total only when every ingredient in the recipe has a stated amount and a matching row. Home cooking rarely states every amount, so for most recipes it gives a floor: the nutrients it could count, which the rest can only add to.

## The rules

**1. Say which kind of number it is.** A total is "about 450 calories a serving." A floor is "at least 284 calories a serving — the ingredients I couldn't count can only add to that." Never drop the "at least". A floor is not a vague estimate; it is a claim that is provably true, and saying it that way is what keeps it true.

**2. Do not fill the gap.** Do not guess the missing amounts to turn a floor into a total, and do not round a floor up to "around" anything.

**3. Per serving, as returned.** Use the serving basis the tool returns. If the person changes the servings, ask the tool again rather than dividing in your head.

**4. Comparing floors needs care.** If two recipes both return floors, one floor being higher does not mean that recipe has more; say that the comparison is not conclusive.

**5. Information, not advice.** Report the numbers. Do not tell the person what they should eat, whether a meal is healthy, or how it fits a diet or a medical condition. If they ask, say that Mise can give the numbers but not that judgment.

## How it sounds

Good:

> **Person:** How many calories in the gnocchi?
> **Alexa:** At least 284 a serving. Some ingredients don't have amounts in the recipe, so the real figure can only be higher.

Wrong:

> **Alexa:** About 300 calories, so it's a light dinner.
> *(Rounded a floor into an estimate and added a judgment.)*
