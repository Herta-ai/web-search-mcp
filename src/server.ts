import { createDefaultRegistry, type ProviderRegistry } from "./registry";

export const PROTOCOL_VERSION = "2026-07-28";
export const DEFAULT_PORT = 3000;
export const DEFAULT_PATH = "/mcp";

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  _meta?: unknown;
}

export interface ServerOptions {
  /** Port to listen on. Defaults to PORT or 3000. */
  port?: number | string;
  hostname?: string;
  /** MCP endpoint path. Defaults to /mcp. */
  path?: string;
  idleTimeout?: number;
  registry?: ProviderRegistry;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  corsHeaders?: Record<string, string>;
}

/** The small part of Bun's server object that applications commonly use. */
export interface McpServer {
  readonly url: URL;
  readonly port: number | undefined;
  readonly hostname: string | undefined;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

const defaultCorsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Authorization",
  "Access-Control-Expose-Headers":
    "Mcp-Protocol-Version, Mcp-Method, Mcp-Name",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Process one JSON-RPC MCP message without starting a server. */
export async function processMessage(
  message: JsonRpcRequest,
  urlParams: URLSearchParams,
  registry: ProviderRegistry,
  reqHeaders?: Headers,
  protocolVersion = PROTOCOL_VERSION,
  serverName = "web-search-mcp",
  serverVersion = "0.1.0",
): Promise<Record<string, unknown> | null> {
  const method = message.method || reqHeaders?.get("mcp-method");
  const params = message.params ?? {};
  const id = message.id ?? null;

  if (message._meta) {
    console.log(`[MCP Metadata] Received _meta:`, message._meta);
  }

  if (method === "server/discover" || method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: serverName, version: serverVersion },
      },
    };
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "subscriptions/listen") {
    return {
      jsonrpc: "2.0",
      id,
      result: { status: "listening", subscriptions: ["toolsListChanged"] },
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: registry.getAvailableTools(urlParams) },
    };
  }

  if (method === "tools/call") {
    const name =
      (typeof params.name === "string" ? params.name : undefined) ??
      reqHeaders?.get("mcp-name");
    const args =
      typeof params.arguments === "object" && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : undefined;
    const query = typeof args?.query === "string" ? args.query.trim() : "";

    try {
      if (!name) {
        throw new Error("Missing tool name in params or Mcp-Name header");
      }
      if (!query) {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "请输入搜索关键词" }] },
        };
      }

      const result = await registry.callTool(name, query, urlParams);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: errorMessage(error) },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method '${method ?? ""}' not found` },
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      ...(body === null ? {} : { "Content-Type": "application/json" }),
    },
  });
}

/** Create a Fetch-compatible MCP handler for Bun, tests, or adapters. */
export function createRequestHandler(
  options: ServerOptions = {},
): (request: Request) => Promise<Response> {
  const registry = options.registry ?? createDefaultRegistry();
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  const endpoint = options.path ?? DEFAULT_PATH;
  const headers = { ...defaultCorsHeaders, ...options.corsHeaders };
  const serverName = options.serverName ?? "web-search-mcp";
  const serverVersion = options.serverVersion ?? "0.1.0";

  return async (request) => {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    if (url.pathname !== endpoint) {
      return new Response("Not Found", { status: 404, headers });
    }

    if (request.method === "GET") {
      return new Response(
        "Subscription stream not supported directly via GET. Use POST for Streamable HTTP.",
        { status: 405, headers: { ...headers, "Mcp-Protocol-Version": protocolVersion } },
      );
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { ...headers, Allow: "GET, POST, OPTIONS" },
      });
    }

    try {
      const headerMethod = request.headers.get("mcp-method");
      const headerName = request.headers.get("mcp-name");
      const textBody = await request.text();
      const body: JsonRpcRequest = textBody.trim()
        ? (JSON.parse(textBody) as JsonRpcRequest)
        : {};

      if (headerMethod && !body.method) body.method = headerMethod;
      if (headerName) {
        body.params = body.params ?? {};
        if (!body.params.name) body.params.name = headerName;
      }

      if (
        body.method === "subscriptions/listen" &&
        request.headers.get("accept")?.includes("text/event-stream")
      ) {
        return new Response(
          'event: ready\ndata: {"status":"listening"}\n\n',
          {
            status: 200,
            headers: {
              ...headers,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Mcp-Protocol-Version": protocolVersion,
            },
          },
        );
      }

      const response = await processMessage(
        body,
        url.searchParams,
        registry,
        request.headers,
        protocolVersion,
        serverName,
        serverVersion,
      );

      if (!response) {
        return new Response(null, {
          status: 202,
          headers: { ...headers, "Mcp-Protocol-Version": protocolVersion },
        });
      }

      return jsonResponse(response, 200, {
        ...headers,
        "Mcp-Protocol-Version": protocolVersion,
      });
    } catch (error) {
      console.error("Error processing message:", error);
      return new Response("Invalid JSON or Processing Error", {
        status: 400,
        headers: { ...headers, "Mcp-Protocol-Version": protocolVersion },
      });
    }
  };
}

function defaultPort(): number {
  const value = Number(process.env.PORT);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PORT;
}

/** Start the MCP server explicitly. Importing this module has no side effects. */
export function startServer(options: ServerOptions = {}): McpServer {
  const handler = createRequestHandler(options);
  const serverOptions: Parameters<typeof Bun.serve>[0] = {
    port: options.port ?? defaultPort(),
    idleTimeout: options.idleTimeout ?? 0,
    fetch: handler,
  };
  if (options.hostname) serverOptions.hostname = options.hostname;
  return Bun.serve(serverOptions);
}

/** Alias for consumers that prefer `server()` as their startup API. */
export const server = startServer;

export default startServer;
