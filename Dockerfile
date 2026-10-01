FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build:binary

FROM oven/bun:1-alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist/web-search-mcp /app/server
CMD ["./server"]
