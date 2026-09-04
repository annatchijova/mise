// Mise — MCP server for Alexa+ (block A: recipe_search over the curated recipe data).
// The server has no LLM of its own: every tool is data plus deterministic logic.
//
// Three surfaces share this one process and one URL:
//   POST /mcp             the MCP server Alexa+ talks to
//   GET  /recipes[/:id]   importable recipe pages (schema.org JSON-LD) — the recipe-portal integration
//   GET  /healthz         liveness
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { type Recipe, loadRecipes, searchRecipes } from "./recipes.ts";
import { renderIndexPage, renderRecipePage, toJsonLd } from "./recipe_jsonld.ts";

const recipes: Recipe[] = loadRecipes();
const byId = new Map(recipes.map((r) => [r.id, r]));

const PORT = Number(process.env.PORT ?? 8080);
/** Canonical public origin, used for the @id of an exported recipe. */
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

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
      const result = searchRecipes(recipes, args);
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

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** GET /recipes, /recipes/:id and /recipes/:id.json. Returns false when the path is not ours. */
function serveRecipes(pathname: string, res: import("node:http").ServerResponse): boolean {
  if (pathname === "/recipes" || pathname === "/recipes/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderIndexPage(recipes));
    return true;
  }
  if (!pathname.startsWith("/recipes/")) return false;

  let id = pathname.slice("/recipes/".length);
  const asJson = id.endsWith(".json");
  if (asJson) id = id.slice(0, -".json".length);

  // The id is a lookup key in a map we built ourselves, never a path. The shape check keeps
  // anything else from reaching the log or the 404 body.
  const recipe = KEBAB.test(id) ? byId.get(id) : undefined;
  if (!recipe) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("No such recipe. See /recipes");
    return true;
  }
  if (asJson) {
    res.writeHead(200, { "content-type": "application/ld+json; charset=utf-8" });
    res.end(JSON.stringify(toJsonLd(recipe, { baseUrl: BASE_URL }), null, 2));
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderRecipePage(recipe, { baseUrl: BASE_URL }));
  }
  return true;
}

const httpServer = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", BASE_URL).pathname;

  if (pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "GET" && serveRecipes(pathname, res)) return;

  if (pathname === "/mcp" && req.method === "POST") {
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
  res.end("Use POST /mcp or GET /recipes");
});

httpServer.listen(PORT, () => {
  console.log(`mise MCP server listening on ${BASE_URL}/mcp (${recipes.length} recipes, pages at ${BASE_URL}/recipes)`);
});
