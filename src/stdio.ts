import {
  createDefaultRegistry,
  type ProviderRegistry,
} from "./registry";
import {
  processMessage,
  PROTOCOL_VERSION,
  type JsonRpcRequest,
} from "./server";

/** Options for the MCP stdio transport. */
export interface StdioServerOptions {
  /** Provider registry to use. Defaults to all built-in providers. */
  registry?: ProviderRegistry;
  /** URL-style provider parameters. Values from the environment are added when absent. */
  urlParams?: URLSearchParams;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  /** Input stream. Defaults to process.stdin. Useful for embedding and tests. */
  input?: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>;
  /** Output sink. Defaults to process.stdout. Useful for embedding and tests. */
  output?: (message: string) => void | Promise<void>;
}

/** A running stdio server. Its promise settles when the input stream closes. */
export interface StdioServer {
  readonly finished: Promise<void>;
  close(): void;
}

function camelToSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
}

function parameterEnvironmentNames(parameter: string): string[] {
  const snake = camelToSnake(parameter.replace(/-/g, "_")).toUpperCase();
  const compact = snake.replace(/_/g, "");
  return [
    parameter,
    parameter.toUpperCase(),
    snake,
    compact,
    `MCP_${snake}`,
    `WEB_SEARCH_MCP_${snake}`,
  ];
}

/**
 * Build the URL-style parameters used by providers from process environment.
 *
 * For example, `KIMI_API_KEY` maps to the existing `kimi-apiKey` parameter.
 * Exact parameter names and compact spellings such as `KIMI_APIKEY` are also
 * accepted for compatibility with shell configurations.
 */
export function createStdioUrlParams(
  registry: ProviderRegistry = createDefaultRegistry(),
  environment: Record<string, string | undefined> = process.env,
): URLSearchParams {
  const params = new URLSearchParams();
  const parameterNames = new Set<string>();

  for (const provider of registry.getProviders()) {
    for (const parameter of [
      ...provider.requiredParams,
      ...provider.optionalParams.map((item) => `${provider.name}-${item.name}`),
    ]) {
      parameterNames.add(parameter);
    }
  }

  for (const parameter of parameterNames) {
    for (const environmentName of parameterEnvironmentNames(parameter)) {
      const value = environment[environmentName];
      if (value !== undefined && value.trim().length > 0) {
        params.set(parameter, value);
        break;
      }
    }
  }

  // `DEFAULT_SEARCH` is not owned by a provider, but is used by the alias
  // tool exposed by ProviderRegistry.
  for (const environmentName of [
    "default-search",
    "DEFAULT_SEARCH",
    "MCP_DEFAULT_SEARCH",
    "WEB_SEARCH_MCP_DEFAULT_SEARCH",
  ]) {
    const value = environment[environmentName];
    if (value !== undefined && value.trim().length > 0) {
      params.set("default-search", value);
      break;
    }
  }

  return params;
}

function asText(chunk: Uint8Array | string, decoder: TextDecoder): string {
  return typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
}

function parseRequest(line: string): JsonRpcRequest {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP message must be a JSON object");
  }
  return value as JsonRpcRequest;
}

/**
 * Start an MCP JSON-RPC server over stdin/stdout.
 *
 * Messages use the MCP stdio framing format: one JSON object per line. Logs
 * from the server and providers are written to stderr so stdout stays valid
 * JSON-RPC for MCP clients.
 */
export function startStdioServer(options: StdioServerOptions = {}): StdioServer {
  const registry = options.registry ?? createDefaultRegistry();
  const urlParams = new URLSearchParams(options.urlParams);
  const environmentParams = createStdioUrlParams(registry);
  for (const [name, value] of environmentParams) {
    if (!urlParams.has(name)) urlParams.set(name, value);
  }
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  const serverName = options.serverName ?? "web-search-mcp";
  const serverVersion = options.serverVersion ?? "0.1.0";
  const input = options.input ?? process.stdin;
  const output = options.output ?? ((message: string) => process.stdout.write(`${message}\n`));
  let closed = false;

  const finished = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();

    const handleLine = async (line: string): Promise<void> => {
      const trimmed = line.trim();
      if (!trimmed || closed) return;

      let response: Record<string, unknown> | null;
      try {
        const request = parseRequest(trimmed);
        response = await processMessage(
          request,
          urlParams,
          registry,
          undefined,
          protocolVersion,
          serverName,
          serverVersion,
        );
      } catch (error) {
        console.error("Error processing stdio message:", error);
        response = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      if (response) await output(JSON.stringify(response));
    };

    for await (const chunk of input) {
      if (closed) break;
      buffer += asText(chunk, decoder);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        await handleLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) await handleLine(buffer);
  })();

  return {
    finished,
    close() {
      closed = true;
    },
  };
}

/** Run stdio until stdin closes. Convenient for CLI entry points. */
export async function runStdioServer(
  options: StdioServerOptions = {},
): Promise<void> {
  await startStdioServer(options).finished;
}

export default runStdioServer;
