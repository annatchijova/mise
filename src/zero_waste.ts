// Suggestions are opportunities, never evidence that food was used or waste avoided.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { dataDir, type Recipe } from "./recipes.ts";
import type { PantryItem } from "./pantry/fold.ts";

const bilingual = z.object({ en: z.string().min(1), es: z.string().min(1) });
const lessonSchema = z.object({ technique: z.string().min(1), title: bilingual, practice: bilingual, presentation: bilingual });
const tableSchema = z.object({ version: z.number().int().positive(), status: z.string().min(1), lessons: z.array(lessonSchema) });
export type Lessons = z.infer<typeof tableSchema>;

export function loadZeroWasteLessons(): Lessons {
  const table = tableSchema.parse(JSON.parse(readFileSync(join(dataDir(), "zero_waste.json"), "utf8")));
  if (new Set(table.lessons.map((l) => l.technique)).size !== table.lessons.length) throw new Error("Duplicate zero-waste technique");
  return table;
}

/** True for a pantry line no suggestion should ever be built on. */
function usable(i: PantryItem): boolean {
  return i.freshness !== "expired" && i.confidence !== "stale" && (!i.qty_known || (i.qty ?? 0) > 0);
}

export function zeroWaste(
  recipes: Recipe[],
  items: PantryItem[],
  lessons: Lessons,
  input: { locale?: "en" | "es"; limit?: number; max_minutes?: number } = {},
) {
  const locale = input.locale ?? "en";
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  const eligible = items.filter(usable);
  const byId = new Map<string, PantryItem[]>();
  for (const item of eligible) byId.set(item.ingredient_id, [...(byId.get(item.ingredient_id) ?? []), item]);

  const candidates = recipes
    .filter((r) => input.max_minutes === undefined || r.minutes <= input.max_minutes)
    .map((r) => {
      const ids = [...new Set(r.ingredients.map((i) => i.id))].sort(compare);
      const used = ids.filter((id) => byId.has(id));
      const urgent = used.filter((id) => byId.get(id)!.some((i) => i.freshness === "urgent" || i.freshness === "soon"));
      const techniques = new Set(r.ingredients.filter((i) => used.includes(i.id)).map((i) => i.technique));
      const learning = lessons.lessons
        .filter((l) => techniques.has(l.technique))
        .sort((a, b) => compare(a.technique, b.technique))
        .map((l) => ({ technique: l.technique, title: l.title[locale], practice: l.practice[locale], presentation: l.presentation[locale] }));
      return {
        recipe_id: r.id,
        title: locale === "es" ? r.title_es : r.title,
        minutes: r.minutes,
        use_first: urgent,
        on_hand: used,
        missing: ids.filter((id) => !byId.has(id)),
        // Presence by canonical id is not sufficient quantity, nor a unit conversion.
        needs_confirmation: used.filter((id) => byId.get(id)!.some((i) => i.confidence !== "confirmed" || !i.qty_known || i.freshness === "unknown")),
        pantry_evidence: used
          .flatMap((id) => byId.get(id)!)
          .sort((a, b) => compare(`${a.ingredient_id}|${a.unit}|${a.location}`, `${b.ingredient_id}|${b.unit}|${b.location}`)),
        coverage_percent: ids.length ? Math.floor((100 * used.length) / ids.length) : 0,
        learning,
        reason:
          locale === "es"
            ? `${urgent.length} ingredientes próximos a vencer; ${used.length} de ${ids.length} ingredientes presentes.`
            : `${urgent.length} ingredients due soon; ${used.length} of ${ids.length} ingredients present.`,
      };
    })
    .filter((c) => c.on_hand.length > 0)
    .sort((a, b) => b.use_first.length - a.use_first.length || b.coverage_percent - a.coverage_percent || a.minutes - b.minutes || compare(a.recipe_id, b.recipe_id));

  const notes =
    locale === "es"
      ? {
          quantity: "La presencia no garantiza cantidad suficiente. Revisá cantidades y unidades de la receta antes de cocinar o comprar.",
          economy: "Revisá primero lo disponible y después la lista de faltantes para decidir qué comprar. No se calculó ahorro monetario.",
          ecology: "Aprovechar lo disponible es el objetivo. Una propuesta no prueba desperdicio evitado ni reducción de emisiones.",
          safety: "Se excluyen registros vencidos o desactualizados. Las fechas registradas no garantizan que un alimento sea seguro; no uses alimentos deteriorados.",
        }
      : {
          quantity: "Presence does not guarantee enough quantity. Check recipe amounts and units before cooking or shopping.",
          economy: "Check what is available before deciding which missing ingredients to buy. No monetary saving was calculated.",
          ecology: "Using available food is the goal. A suggestion does not prove avoided waste or reduced emissions.",
          safety: "Expired or stale records are excluded. Recorded dates do not establish food safety; do not use spoiled food.",
        };

  return {
    lesson_version: lessons.version,
    lesson_status: lessons.status,
    candidates: candidates.slice(0, Math.max(1, Math.min(10, input.limit ?? 3))),
    total: candidates.length,
    excluded: items
      .filter((i) => i.freshness === "expired" || i.confidence === "stale")
      .map((i) => ({ ingredient_id: i.ingredient_id, unit: i.unit, location: i.location, reason: i.freshness === "expired" ? "expired" : "stale" }))
      .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))),
    notes,
  };
}
