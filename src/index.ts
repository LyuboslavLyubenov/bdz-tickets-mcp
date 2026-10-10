import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCatalogTools, registerSearchTool } from "./tools/search.ts";
import { registerQuoteTool, registerSeatMapTool } from "./tools/purchase-read.ts";
import { registerCreateTicketTool, registerPaymentTools } from "./tools/purchase-write.ts";
import { registerLibraryTools } from "./tools/library.ts";

const server = new McpServer({ name: "bdz-tickets", version: "0.1.0" });

registerCatalogTools(server);
registerSearchTool(server);
registerSeatMapTool(server);
registerQuoteTool(server);
registerCreateTicketTool(server);
registerPaymentTools(server);
registerLibraryTools(server);

await server.connect(new StdioServerTransport());
// Keep the process alive; log to stderr only (stdout is the MCP transport).
console.error("bdz-tickets MCP server running (stdio)");
