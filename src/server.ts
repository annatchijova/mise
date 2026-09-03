// Mise — MCP server for Alexa+ (block A: one tool, in-memory data, Streamable HTTP).
// The server has no LLM of its own: every tool is data plus deterministic logic.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Shapes follow docs/RECIPE_SCHEMA.md (only the fields the tools read).
type Ingredient = { id: string; role: string; technique: string; qty: number | null; unit: string; qty_source: string };
type Step = { order: number; text: string; dur_s: number; timer: boolean; depends_on?: number[] };
type Recipe = {
  id: string; title: string; category: string; minutes: number; serves: number;
  ingredients: Ingredient[]; steps: Step[]; review?: { needs_review?: boolean };
};

/** Load every recipe file in RECIPES_DIR (default data/recipes). Each *.json may hold one recipe or an array;
 *  anything without id+ingredients+steps (e.g. an inventory file) is ignored. Sorted by id: deterministic. */
function loadRecipes(): Recipe[] {
  const dir = process.env.RECIPES_DIR ?? join(fileURLToPath(new URL("..", import.meta.url)), "data", "recipes");
  const out: Recipe[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
      if (r && typeof r.id === "string" && Array.isArray(r.ingredients) && Array.isArray(r.steps)) out.push(r as Recipe);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
const recipes: Recipe[] = loadRecipes();

const PORT = Number(process.env.PORT ?? 8080);

/** Deterministic recipe search: integer scoring, stable ordering, no floats. */
export function searchRecipes(input: { query?: string; use_ingredients?: string[]; max_minutes?: number }) {
  const q = (input.query ?? "").trim().toLowerCase();
  const wanted = (input.use_ingredients ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const candidates = recipes
    .filter((r) => input.max_minutes === undefined || r.minutes <= input.max_minutes)
    .filter((r) => q === "" || r.title.toLowerCase().includes(q) || r.ingredients.some((i) => i.id.includes(q)))
    .map((r) => {
      const have = wanted.filter((w) => r.ingredients.some((i) => i.id === w || i.id.includes(w))).length;
      // percent of the recipe's ingredients already on hand, as an integer
      const pct = r.ingredients.length === 0 ? 0 : Math.floor((have * 100) / r.ingredients.length);
      const missing = [...new Set(r.ingredients.filter((i) => !wanted.some((w) => i.id === w || i.id.includes(w))).map((i) => i.id))];
      return { id: r.id, title: r.title, category: r.category, minutes: r.minutes, serves: r.serves, have_pct: pct, missing };
    })
    .sort((a, b) => b.have_pct - a.have_pct || a.minutes - b.minutes || a.title.localeCompare(b.title));
  return { candidates, total: candidates.length };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "mise", version: "0.1.0" });

  server.registerTool(
    "recipe_search",
    {
      title: "Search recipes",
      description:
        "Find recipes. Use when the customer asks what to cook, wants ideas, asks for a dish by name or ingredient, or asks what they can make with what they have. Returns candidates ranked by how many of the given ingredients are already on hand. Works without a linked account.",
      inputSchema: {
        query: z.string().optional().describe("Free text: a dish name or an ingredient"),
        use_ingredients: z.array(z.string()).optional().describe("Ingredients the customer already has"),
        max_minutes: z.number().int().positive().optional().describe("Maximum total cooking time in minutes"),
      },
      outputSchema: {
        candidates: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            category: z.string(),
            minutes: z.number().int(),
            serves: z.number().int(),
            have_pct: z.number().int(),
            missing: z.array(z.string()),
          }),
        ),
        total: z.number().int(),
      },
    },
    async (args) => {
      const result = searchRecipes(args);
      const spoken =
        result.total === 0
          ? "I could not find a recipe that fits."
          : `${result.total} option${result.total === 1 ? "" : "s"}: ` +
            result.candidates.map((c) => `${c.title} (${c.minutes} min, ${c.have_pct}% on hand)`).join("; ") + ".";
      return { structuredContent: result, content: [{ type: "text", text: spoken }] };
    },
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.url === "/mcp" && req.method === "POST") {
    // Stateless Streamable HTTP: one server + transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }
  res.writeHead(405, { "content-type": "text/plain" });
  res.end("Use POST /mcp");
});

httpServer.listen(PORT, () => {
  console.log(`mise MCP server listening on http://localhost:${PORT}/mcp (${recipes.length} recipes)`);
});
