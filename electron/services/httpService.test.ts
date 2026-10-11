import { afterAll, beforeAll, expect, it, vi } from "vitest";
import net from "node:net";
import http from "node:http";
vi.mock("./config", () => ({
  ConfigService: {
    getInstance: () => ({ get: () => "private-url-test", set: vi.fn() }),
  },
}));
vi.mock("./chatService", () => ({ chatService: {} }));
vi.mock("./weBotRegistry", () => ({ getWeBotService: () => null }));
vi.mock("./snsService", () => ({ snsService: {} }));
vi.mock("./analyticsService", () => ({ analyticsService: {} }));
vi.mock("./groupAnalyticsService", () => ({ groupAnalyticsService: {} }));
import { httpService } from "./httpService";
import { mcpService } from "./mcpService";
const services = [httpService, mcpService];
const ports: number[] = [];
beforeAll(async () => {
  for (const service of services) {
    const socket = net.createServer();
    await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((r) => socket.close(() => r()));
    expect((await service.start(port, "127.0.0.1")).success).toBe(true);
    ports.push(port);
  }
});
afterAll(async () => {
  for (const service of services) await service.stop();
});
it.each([0, 1])(
  "server %i rejects a malformed URL without hanging or an unhandled rejection",
  async (index) => {
    const port = ports[index];
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "http://[",
          headers: { Authorization: "Bearer private-url-test" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.setTimeout(1000, () => req.destroy(new Error("Request hung")));
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
  },
);
