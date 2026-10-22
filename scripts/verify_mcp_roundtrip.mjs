import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8090/mcp"));
const client = new Client({ name: "verification-client", version: "1.0.0" });

await client.connect(transport);
console.log("=== Conectado por Streamable HTTP ===");

const tools = await client.listTools();
console.log(`=== tools/list: ${tools.tools.length} herramientas ===`);

console.log("\n=== tools/call: recipe_search (guest) ===");
const r1 = await client.callTool({ name: "recipe_search", arguments: { query: "lentil" } });
console.log("ok, candidatos:", r1.structuredContent?.total, "| isError:", r1.isError ?? false);

console.log("\n=== tools/call: substitute (guest) ===");
const r2 = await client.callTool({ name: "substitute", arguments: { ingredient: "tahini" } });
console.log(JSON.stringify(r2.structuredContent, null, 2).slice(0, 500));

console.log("\n=== tools/call: cook_start SIN cuenta vinculada (debe rechazar) ===");
const r3 = await client.callTool({ name: "cook_start", arguments: { recipe_id: "lentil-chocolate-stew" } });
console.log("isError:", r3.isError);
console.log("texto:", r3.content?.[0]?.text);

console.log("\n=== tools/call: pantry_list SIN cuenta vinculada (debe rechazar) ===");
const r4 = await client.callTool({ name: "pantry_list", arguments: { filter: "all" } });
console.log("isError:", r4.isError);
console.log("texto:", r4.content?.[0]?.text);

console.log("\n=== resources/list (recursos ui:// de MCP Apps) ===");
const resources = await client.listResources();
for (const res of resources.resources) {
  console.log(`- ${res.uri} (${res.mimeType})`);
}

console.log("\n=== resources/read: ui://mise/step-card ===");
const stepCard = resources.resources.find((r) => r.uri.includes("step-card"));
if (stepCard) {
  const content = await client.readResource({ uri: stepCard.uri });
  const text = content.contents?.[0]?.text ?? "";
  console.log(`tamaño: ${text.length} bytes, empieza con: ${text.slice(0, 120)}`);
} else {
  console.log("NO SE ENCONTRÓ el recurso step-card");
}

await client.close();
console.log("\n=== Round trip completo, conexión cerrada limpiamente ===");
