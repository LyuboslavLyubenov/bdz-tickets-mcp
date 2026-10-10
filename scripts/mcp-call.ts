/**
 * Spawns the MCP server over stdio and exercises its tools end-to-end.
 * Usage: bun scripts/mcp-call.ts <toolName> [jsonArgs]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const toolName = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const transport = new StdioClientTransport({
  command: "bun",
  args: ["src/index.ts"],
  cwd: new URL("..", import.meta.url).pathname,
});
const client = new Client({ name: "bdz-tickets-verify", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
if (!toolName) {
  console.log("TOOLS:", tools.tools.map((t) => t.name).sort().join(", "));
} else {
  const result = await client.callTool({ name: toolName, arguments: args });
  console.log(JSON.stringify(result, null, 2));
}
await client.close();
process.exit(0);
