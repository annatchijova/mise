// Simulated Alexa+ experience, per the hackathon's own Alexa+ track guidance
// (amazonappdev2026.devpost.com/resources): "simulate an Alexa+ experience
// using your preferred agentic tool via a web app." This process plays the
// role Alexa+ plays in production: it is the only place an LLM touches
// anything. The Mise MCP server (src/server.ts) stays exactly as deterministic
// as it is in production — this file never talks to Mise's internals, only
// to its public MCP endpoint, the same way Alexa+ would.
//
// Flow per turn: Gemini reads the conversation + the server's real tool
// schemas (fetched live via tools/list, not hand-copied) and decides whether
// to call a tool. If it does, the tool is called for real over Streamable
// HTTP. The tool's result goes back to Gemini, which narrates it. If the
// result names a ui:// resource, that resource is read for real and handed
// to the browser to render in an iframe — the same MCP Apps resource Alexa+
// itself would render.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

const MISE_URL = process.env.MISE_URL ?? "http://localhost:8091/mcp";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest";
const PORT = Number(process.env.SIMULATOR_PORT ?? 8095);

if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is required.");
  process.exit(1);
}

// --- MCP client: one long-lived connection to the real Mise server ---

const mcpClient = new Client({ name: "alexa-plus-simulator", version: "1.0.0" });
await mcpClient.connect(new StreamableHTTPClientTransport(new URL(MISE_URL)));
console.log(`Connected to Mise MCP server at ${MISE_URL}`);

const toolList = await mcpClient.listTools();
console.log(`Loaded ${toolList.tools.length} real tool schemas from Mise.`);

/** Strip JSON Schema keywords Gemini's function-calling does not accept. */
function sanitizeSchema(schema) {
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "additionalProperties" || key === "exclusiveMinimum" || key === "exclusiveMaximum") {
      continue;
    }
    out[key] = sanitizeSchema(value);
  }
  return out;
}

const functionDeclarations = toolList.tools.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: sanitizeSchema(t.inputSchema),
}));

/** The MCP Apps hint lives on the tool's definition (tools/list), not on each
 *  call's result — a client is meant to know ahead of time which tools have a
 *  view. Build name -> resourceUri once, from the real tool list. */
const toolUiMap = new Map(
  toolList.tools
    .filter((t) => t._meta?.ui?.resourceUri)
    .map((t) => [t.name, t._meta.ui.resourceUri]),
);
console.log(`Tools with a declared UI view: ${[...toolUiMap.keys()].join(", ")}`);

// --- Gemini call ---

async function callGemini(contents) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const payload = {
    systemInstruction: {
      parts: [
        {
          text: `You are playing the role Alexa+ plays for the Mise add-on: you are the only
reasoning layer. The Mise server you call is fully deterministic — it decides every
fact (what is in the pantry, what a recipe costs, whether a step is valid), you only
extract intent from what the person said, call the right tool with the right
arguments, and narrate the server's own answer out loud. Never invent a pantry item,
a price, a quantity, or a recipe step that the tool result did not give you. If a
tool result says something is uncertain (confidence: inferred or stale, or a null
amount), say that uncertainty out loud rather than stating it as a fact. Speak in
short, natural spoken sentences, the way a voice assistant would — not as a bulleted
list. If the person's request needs more than one tool call in sequence, make them
in order.`,
        },
      ],
    },
    contents,
    tools: [{ functionDeclarations }],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini error ${res.status}: ${detail}`);
  }
  return res.json();
}

// --- One turn: loop between Gemini and real MCP tool calls ---

async function runTurn(history) {
  const contents = [...history];
  const toolCallLog = [];
  let uiResource = null;

  for (let step = 0; step < 4; step++) {
    const data = await callGemini(contents);
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const functionCallPart = parts.find((p) => p.functionCall);

    if (!functionCallPart) {
      const text = parts.map((p) => p.text ?? "").join(" ").trim();
      return { text: text || "(no response)", toolCallLog, uiResource };
    }

    const { name, args } = functionCallPart.functionCall;
    contents.push({ role: "model", parts: [functionCallPart] });

    let toolResult;
    try {
      toolResult = await mcpClient.callTool({ name, arguments: args ?? {} });
    } catch (err) {
      toolResult = { isError: true, content: [{ type: "text", text: String(err) }] };
    }

    const narratedText = toolResult.content?.find((c) => c.type === "text")?.text ?? "";
    const resourceUri = toolUiMap.get(name);
    toolCallLog.push({ name, args, isError: toolResult.isError ?? false, narratedText });

    if (resourceUri && !toolResult.isError) {
      try {
        const resourceContent = await mcpClient.readResource({ uri: resourceUri });
        uiResource = {
          uri: resourceUri,
          html: resourceContent.contents?.[0]?.text ?? null,
          toolCall: { name, args: args ?? {}, result: toolResult },
        };
      } catch {
        // Rendering the view is polish; a failure here must not break narration.
      }
    }

    contents.push({
      role: "user",
      parts: [
        {
          functionResponse: {
            name,
            response: {
              structuredContent: toolResult.structuredContent ?? null,
              narratedText,
              isError: toolResult.isError ?? false,
            },
          },
        },
      ],
    });
  }

  return {
    text: "I made a few tool calls but ran out of steps before finishing — tell me again, more simply?",
    toolCallLog,
    uiResource,
  };
}

// --- Minimal HTTP server: static files + /api/chat ---

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  // The real MCP Apps bridge (simulator/bridge-src.mjs) proxies tool calls a
  // view makes (e.g. a step card's "next" button) through here, onto the one
  // real MCP connection this process holds.
  if (req.method === "POST" && req.url === "/api/tool-call") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { name, arguments: args } = JSON.parse(body);
        const result = await mcpClient.callTool({ name, arguments: args ?? {} });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { history } = JSON.parse(body);
        const result = await runTurn(history);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  const path = req.url === "/" ? "/index.html" : req.url;
  try {
    const file = await readFile(join(PUBLIC_DIR, path));
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`Simulated Alexa+ experience at http://localhost:${PORT}`);
});
