#!/usr/bin/env bun

import { startServer } from "./server";
import { runStdioServer } from "./stdio";

const args = process.argv.slice(2);
const executable = process.argv[1]?.split(/[\\/]/).pop() ?? "";
const stdio =
  args.includes("--stdio") ||
  args.includes("-s") ||
  args[0] === "stdio" ||
  args.includes("--transport=stdio") ||
  (args.includes("--transport") && args[args.indexOf("--transport") + 1] === "stdio") ||
  process.env.MCP_TRANSPORT?.toLowerCase() === "stdio" ||
  executable === "web-search-mcp-stdio";

async function main(): Promise<void> {
  if (stdio) {
    await runStdioServer();
    return;
  }

  const server = startServer();
  const endpoint = new URL("/mcp", server.url).href;

  console.log(`🚀 MCP Server running at ${endpoint}`);
  console.log(`🔑 Example: POST ${endpoint}?kimi-apiKey=YOUR_KEY`);
  console.log(`📚 Supported providers: kimi, zai, volces, tencentmaas, aliyuncs`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
