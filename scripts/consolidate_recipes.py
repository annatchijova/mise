#!/usr/bin/env python3
"""Consolidate per-book structured recipes into data/. Stdlib only. Dry-run unless --apply.

Reads  work/recipes/<book>/{recipes.json,inventory.json}
Writes data/recipes/<id>.json (sorted keys, one file per recipe) and data/inventory.md (full catalogue)

Re-validates the UNION (catches cross-book duplicate ids), audits near-duplicate ingredient ids,
and prints the stats the weekly planner cares about (ingredient overlap, category mix, time spread).
"""
import json, os, re, sys, glob
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from validate_recipes import check  # same rules, one source of truth

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "work", "recipes")
OUT_DIR = os.path.join(ROOT, "data", "recipes")
OUT_INV = os.path.join(ROOT, "data", "inventory.md")
SAVORY = {"main", "side", "soup"}

def norm(ingredient_id):
    """collapse plural/hyphen noise to spot near-duplicates: 'chickpeas' ~ 'chickpea', 'red-lentils' ~ 'red-lentil'"""
    s = ingredient_id.replace("-", "")
    return re.sub(r"(es|s)$", "", s)

def main(apply):
    books = sorted(d for d in os.listdir(WORK) if os.path.isdir(os.path.join(WORK, d)))
    recipes, inventory = [], {}
    for b in books:
        rp, ip = os.path.join(WORK, b, "recipes.json"), os.path.join(WORK, b, "inventory.json")
        if os.path.exists(rp):
            for r in json.load(open(rp, encoding="utf-8")):
                r.setdefault("source", {})["book"] = r["source"].get("book") or b
                recipes.append(r)
        if os.path.exists(ip):
            inventory[b] = json.load(open(ip, encoding="utf-8"))
    print(f"books: {books}")
    print(f"recipes read: {len(recipes)}   inventory entries: {sum(len(v) for v in inventory.values())}")

    # 0. canonical ingredient ids: apply the versioned alias table (data/ingredient_aliases.json)
    apath = os.path.join(ROOT, "data", "ingredient_aliases.json")
    aliases = {k: v for k, v in json.load(open(apath, encoding="utf-8")).items() if not k.startswith("_")} if os.path.exists(apath) else {}
    remapped = Counter()
    for r in recipes:
        for ing in r["ingredients"]:
            if ing["id"] in aliases and aliases[ing["id"]] != ing["id"]:
                remapped[f"{ing['id']} -> {aliases[ing['id']]}"] += 1; ing["id"] = aliases[ing["id"]]
    print(f"aliases applied: {sum(remapped.values())} " + (", ".join(f"{k}({n})" for k, n in sorted(remapped.items())) if remapped else ""))

    # 1. re-validate the union
    errors, warnings, ids = [], [], set()
    for r in recipes: check(r, errors, warnings, ids)
    print(f"union validation: errors={len(errors)} warnings={len(warnings)}")
    for e in errors: print("  ERROR", e)

    # 2. ingredient id audit
    ing_count = Counter(i["id"] for r in recipes for i in r["ingredients"])
    groups = defaultdict(set)
    for i in ing_count: groups[norm(i)].add(i)
    near = {k: v for k, v in groups.items() if len(v) > 1}
    print(f"distinct ingredient ids: {len(ing_count)}   near-duplicate groups: {len(near)}")
    for k, v in sorted(near.items()): print("  NEAR-DUP", sorted(v))

    # 3. planner stats
    cats = Counter(r["category"] for r in recipes)
    savory = sum(v for k, v in cats.items() if k in SAVORY)
    mins = sorted(r["minutes"] for r in recipes)
    quick = sum(1 for m in mins if m < 30); medium = sum(1 for m in mins if 30 <= m <= 60); long_ = sum(1 for m in mins if m > 60)
    review = sum(1 for r in recipes if r["review"].get("needs_review"))
    per_book = Counter(r["source"]["book"] for r in recipes)
    print(f"per book: {dict(per_book)}")
    print(f"categories: {dict(cats)}   savory share: {savory}/{len(recipes)}")
    print(f"time spread: quick<30={quick} medium30-60={medium} long>60={long_}")
    print(f"needs_review: {review}/{len(recipes)}")
    shared = [(i, n) for i, n in ing_count.most_common() if n >= 3]
    print(f"ingredients shared by >=3 recipes ({len(shared)}): " + ", ".join(f"{i}({n})" for i, n in shared[:25]))
    # recipes with no ingredient shared with any other recipe = isolated for the planner
    lonely = [r["id"] for r in recipes if all(ing_count[i["id"]] == 1 for i in r["ingredients"])]
    print(f"isolated recipes (share no ingredient): {len(lonely)} {lonely}")

    if errors:
        print("\nNOT applying: fix union errors first."); return 1
    if not apply:
        print("\nDRY RUN. Re-run with --apply to write data/recipes/ and data/inventory.md"); return 0

    # 4. write
    os.makedirs(OUT_DIR, exist_ok=True)
    for old in glob.glob(os.path.join(OUT_DIR, "*.json")): os.remove(old)
    for r in sorted(recipes, key=lambda x: x["id"]):
        with open(os.path.join(OUT_DIR, f"{r['id']}.json"), "w", encoding="utf-8") as f:
            json.dump(r, f, ensure_ascii=False, indent=2, sort_keys=True); f.write("\n")
    lines = ["# Recipe inventory", "", "Every recipe found in the source books. ✓ = structured into `data/recipes/`.", ""]
    for b in books:
        entries = inventory.get(b, [])
        sel = sum(1 for e in entries if e.get("selected"))
        lines += [f"## {b}  ({len(entries)} found, {sel} structured)", "", "| ✓ | title | category | vegan | note |", "|---|---|---|---|---|"]
        for e in entries:
            mark = "✓" if e.get("selected") else ""
            lines.append(f"| {mark} | {e.get('title_es','')} | {e.get('category','')} | {e.get('vegan','')} | {e.get('reason','')} |")
        lines.append("")
    with open(OUT_INV, "w", encoding="utf-8") as f: f.write("\n".join(lines))
    print(f"\nwrote {len(recipes)} files to data/recipes/ and data/inventory.md")
    return 0

if __name__ == "__main__":
    sys.exit(main("--apply" in sys.argv))
