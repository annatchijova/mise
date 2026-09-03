#!/usr/bin/env python3
"""Curation report for the author: what was estimated, unspecified, or flagged. Stdlib only.

Usage: review_report.py [recipes dir] [output.md]   (defaults: data/recipes  data/REVIEW.md)
Reads what the validator accepted and makes the honest gaps visible in one page, grouped by theme.
"""
import json, os, re, sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data", "recipes")
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "data", "REVIEW.md")

recipes = []
for f in sorted(os.listdir(src)):
    if not f.endswith(".json") or f == "inventory.json": continue
    d = json.load(open(os.path.join(src, f), encoding="utf-8"))
    for r in (d if isinstance(d, list) else [d]):
        if isinstance(r, dict) and "steps" in r: recipes.append(r)

THEMES = [("durations estimated", r"dur|duration|time|minut|tiempo|estimated|wait"),
          ("serves unspecified", r"serves|porcion|rinde|yield"),
          ("quantity unspecified", r"quant|qty|cantidad|a gusto|unspecified|ratio|parte"),
          ("step omitted by the book", r"omit|not (given|instructed|mentioned|stated)|never (uses|used|mentioned)|implied|missing step|no cooking|no shaping"),
          ("reading / typo interpretation", r"typo|read as|interpret|baratas|ambig|range|lower bound|minimum|midpoint"),
          ("vegan judgment", r"vegan|label|honey|miel|carne|yogur|titan|brewer"),
          ("title / locator", r"title|untitled|heading|locator")]

theme_count = Counter(); theme_examples = defaultdict(list)
for r in recipes:
    for reason in r.get("review", {}).get("reasons", []):
        hit = False
        for name, rx in THEMES:
            if re.search(rx, reason, re.I):
                theme_count[name] += 1; hit = True
                if len(theme_examples[name]) < 3: theme_examples[name].append(f"`{r['id']}`: {reason}")
                break
        if not hit:
            theme_count["other"] += 1
            if len(theme_examples["other"]) < 5: theme_examples["other"].append(f"`{r['id']}`: {reason}")

qty_null = Counter(); dur_est = Counter(); stated_dur = 0; total_steps = 0
for r in recipes:
    qty_null[r["id"]] = sum(1 for i in r["ingredients"] if i.get("qty_source") == "unspecified")
    for s in r["steps"]:
        total_steps += 1
        if s.get("dur_source") == "stated": stated_dur += 1
by_book = Counter(r["source"]["book"] for r in recipes)
also = [(r["id"], r["source"].get("also_in")) for r in recipes if r["source"].get("also_in")]
cats = Counter(r["category"] for r in recipes)
mins = [r["minutes"] for r in recipes]
quick = sum(1 for m in mins if m < 30); med = sum(1 for m in mins if 30 <= m <= 60); long_ = sum(1 for m in mins if m > 60)

L = ["# Curation review", "",
     f"{len(recipes)} recipes structured from the author's cookbooks. Everything below was **accepted by the validator**; this page makes the honest gaps visible so a human can confirm or correct them. Nothing here was invented to fill a gap.", "",
     "## At a glance", "",
     f"- per book: " + ", ".join(f"{b} {n}" for b, n in sorted(by_book.items())),
     f"- categories: " + ", ".join(f"{c} {n}" for c, n in cats.most_common()),
     f"- cooking time (incl. unattended waits): quick <30 min {quick} · 30–60 {med} · >60 {long_}",
     f"- step durations stated by the book: {stated_dur}/{total_steps} — the rest are estimates, marked as such",
     f"- ingredients with no quantity in the book: {sum(qty_null.values())} across {sum(1 for v in qty_null.values() if v)} recipes",
     f"- dishes found in more than one book (kept once, both sources recorded): {len(also)}", ""]
if also: L += ["  " + ", ".join(f"`{i}` (+{'/'.join(b)})" for i, b in also), ""]
L += ["## What needs a human eye, by theme", ""]
for name, _ in THEMES + [("other", None)]:
    if theme_count[name]:
        L += [f"### {name} — {theme_count[name]}", ""] + [f"- {e}" for e in theme_examples[name]] + [""]
L += ["## Recipes with unquantified ingredients", "", "| recipe | unspecified qty |", "|---|---|"]
L += [f"| `{k}` | {v} |" for k, v in sorted(qty_null.items(), key=lambda x: -x[1]) if v]
L += ["", "## Open questions for the author", "",
      "- **Titán** (levadura de cerveza en copos): one book maps it to `nutritional-yeast` with a note, another marks the dish `unsure`. Same product, two treatments — which is right?",
      "- Cooking-time skew: many recipes are long because `minutes` includes rests, ferments and overnight waits. For the weekly planner, should elapsed time or active time drive scheduling?",
      "- The book's vegan stock is literally named `caldo \"carne\"`; kept verbatim, id `vegetable-broth`. Confirm.", ""]
open(out, "w", encoding="utf-8").write("\n".join(L))
print(f"review report: {len(recipes)} recipes -> {out}")
