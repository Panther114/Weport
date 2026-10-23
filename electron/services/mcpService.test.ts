import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const retrieval = vi.hoisted(() => vi.fn());
const account = vi.hoisted(() => ({ value: 'fixture-account' }));
vi.mock('./searchRetrieval', () => ({ retrieveIndexedMessages: retrieval }));

vi.mock("./config", () => ({
  ConfigService: {
    getInstance: () => ({ get: () => "private-test-token", getMyWxidCleaned: () => account.value, set: vi.fn() }),
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

  it.each([undefined, "Bearer incorrect-token"])(
    "rejects missing or incorrect authentication (%s)",
    async (authorization) => {
      const response = await fetch(url, {
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          Accept: "text/event-stream",
        },
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(401);
      await response.text();
    },
  );

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

  it('uses shared indexed retrieval and discloses coverage and index errors to administrator clients', async () => {
    const client = new Client({ name: 'indexed-admin-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: 'Bearer private-test-token' } },
    });
    try {
      await client.connect(transport);
      const hit = { sessionId: 'fixture-chat', localId: '9007199254740993', db: 'shard.db', table: 'Msg_fixture' };
      retrieval.mockResolvedValueOnce({ hits: [hit], total: 1, cursor: null, truncated: false, elapsedMs: 1,
        coverage: { complete: false, stale: true, failedTables: ['Msg_failed'] } });
      const result = await client.callTool({ name: 'search_messages', arguments: { keyword: '项目 deadline', sessionId: 'fixture-chat', limit: 12 } });
      const value = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(retrieval).toHaveBeenLastCalledWith({ text: '项目 deadline', limit: 12, scope: { sessionIds: ['fixture-chat'] } });
      expect(value).toMatchObject({ success: true, hits: [hit], messages: [hit], coverage: { complete: false, stale: true, failedTables: ['Msg_failed'] } });
      retrieval.mockResolvedValueOnce({ hits: [], total: 0, cursor: null, elapsedMs: 0, truncated: false, error: 'Build the index first' });
      const unavailable = await client.callTool({ name: 'search_messages', arguments: { keyword: '项目' } });
      expect(JSON.parse((unavailable.content as Array<{ text: string }>)[0].text)).toMatchObject({ success: false, error: 'Build the index first', messages: [] });
      retrieval.mockImplementationOnce(async () => { account.value = 'another-account'; return { hits: [hit] }; });
      const changed = await client.callTool({ name: 'search_messages', arguments: { keyword: '项目' } });
      expect(JSON.parse((changed.content as Array<{ text: string }>)[0].text)).toEqual({ success: false, error: 'Account changed during search.', messages: [] });
    } finally { account.value = 'fixture-account'; await client.close(); }
  });
});
