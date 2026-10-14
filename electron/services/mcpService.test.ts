import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

vi.mock("./config", () => ({
  ConfigService: {
    getInstance: () => ({ get: () => "private-test-token", set: vi.fn() }),
  },
}));
vi.mock("./chatService", () => ({ chatService: {} }));
vi.mock("./weBotRegistry", () => ({ getWeBotService: () => null }));
vi.mock("./snsService", () => ({ snsService: {} }));
vi.mock("./analyticsService", () => ({ analyticsService: {} }));
vi.mock("./groupAnalyticsService", () => ({ groupAnalyticsService: {} }));

import { mcpService } from "./mcpService";

describe("MCP HTTP session and origin rejection", () => {
  let url: string;
  beforeAll(async () => {
    const reservation = net.createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    expect((await mcpService.start(port, "127.0.0.1")).success).toBe(true);
    url = `http://127.0.0.1:${port}/mcp`;
  });
  afterAll(async () => {
    await mcpService.stop();
  });

  it.each(["POST", "GET", "DELETE"])(
    "returns 404 for an unknown session on %s",
    async (method) => {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: "Bearer private-test-token",
          "mcp-session-id": "expired-session",
          Accept: "application/json, text/event-stream",
        },
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(404);
      await response.text();
    },
  );

  it("rejects a foreign browser Origin even with a valid token", async () => {
    const response = await fetch(url, {
      headers: {
        Authorization: "Bearer private-test-token",
        Origin: "https://untrusted.example",
        Accept: "text/event-stream",
      },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(403);
    await response.text();
  });

  it("requires a session ID when terminating a session", async () => {
    const response = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: "Bearer private-test-token" },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(400);
    await response.text();
  });

  it("returns 404 after a real client terminates its initialized session", async () => {
    const client = new Client({
      name: "private-session-test",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: "Bearer private-test-token" } },
    });
    try {
      await client.connect(transport);
      const id = transport.sessionId;
      expect(id).toBeTruthy();
      await transport.terminateSession();
      const response = await fetch(url, {
        headers: {
          Authorization: "Bearer private-test-token",
          "mcp-session-id": id!,
          Accept: "text/event-stream",
        },
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(404);
      await response.text();
    } finally {
      await client.close();
    }
  });

  it("accepts its own Origin before applying session validation", async () => {
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer private-test-token",
        Origin: new URL(url).origin,
      },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(400);
    await response.text();
  });
});
