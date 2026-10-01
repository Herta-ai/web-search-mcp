#!/usr/bin/env bun

import { startServer } from "./server";

const server = startServer();
const endpoint = new URL("/mcp", server.url).href;

console.log(`🚀 MCP Server running at ${endpoint}`);
console.log(`🔑 Example: POST ${endpoint}?kimi-apiKey=YOUR_KEY`);
console.log(`📚 Supported providers: kimi, zai, volces, tencentmaas, aliyuncs`);
