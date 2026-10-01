#!/usr/bin/env bun

import { runStdioServer } from "./stdio";

void runStdioServer().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
