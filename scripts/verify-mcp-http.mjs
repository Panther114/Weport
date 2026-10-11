// Packaged MCP acceptance: private profile, isolated loopback port, no account
// data or external communication. Tokens stay inside the private temp profile.
// Exercises auth, malformed JSON, parallel clients, tool argument validation,
// session rejection and browser Origin policy. Does not prove real history reads.
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import net from "node:net";
const root = resolve(process.cwd());
const require = createRequire(join(root, "package.json"));
const { resolveLayout } = require(
  join(root, "scripts/verify-packaged-native.cjs"),
);
const out = resolve(process.argv[2] || ".ui-probe/mcp-http");
mkdirSync(out, { recursive: true });
const { _electron } = require("playwright-core");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const server = net.createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const token = randomBytes(32).toString("hex");
const profile = mkdtempSync(join(tmpdir(), "weport-mcp-qa-"));
writeFileSync(
  profile + "/Weport-config.json",
  JSON.stringify({
    mcpEnabled: true,
    mcpHost: "127.0.0.1",
    mcpPort: port,
    mcpToken: token,
    httpApiEnabled: false,
    dbPath: "",
    myWxid: "",
    messagePushEnabled: false,
    launchAtStartup: false,
  }),
);
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const result = { port, cases: [] };
const clients = [];
let app;
const check = (name, ok, detail) => {
  result.cases.push({ name, ok, detail });
  if (!ok) throw new Error(name + " failed");
};
try {
  app = await _electron.launch({
    executablePath: resolveLayout(join(root, "release")).appExe,
    args: ["--background", `--user-data-dir=${profile}`],
    env: {
      ...process.env,
      WEPORT_PROBE_OFFSCREEN: "1",
      WEPORT_NATIVE_GLASS: "0",
    },
    timeout: 60000,
  });
  await app.evaluate(async ({ app }) => {
    await app.whenReady();
    while (!app.listenerCount("activate"))
      await new Promise((r) => setTimeout(r, 25));
    app.emit("activate");
  });
  const page = await app.firstWindow();
  await page.locator(".rail-item").first().waitFor({ timeout: 30000 });
  const state = await page.evaluate(() => window.electronAPI.mcp.getStatus());
  check("isolated MCP starts", state.running && state.port === port, {
    running: state.running,
    port: state.port,
  });
  for (const [name, headers, body] of [
    ["missing auth", {}, "{}"],
    ["wrong token", { Authorization: "Bearer invalid" }, "{}"],
    ["malformed JSON", { Authorization: `Bearer ${token}` }, "{"],
  ]) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    await response.text();
    check(name, response.status === (name === "malformed JSON" ? 400 : 401), {
      status: response.status,
    });
  }
  for (let n = 0; n < 2; n++) {
    const client = new Client({ name: `private-qa-${n}`, version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const list = await client.listTools();
    check(
      `client ${n} independent initialization`,
      list.tools.some((t) => t.name === "list_sessions"),
      { tools: list.tools.length },
    );
  }
  const replies = await Promise.all(
    clients.map((c) =>
      c.callTool({ name: "list_sessions", arguments: { limit: 2 } }),
    ),
  );
  check(
    "two concurrent no-account calls",
    replies.every((r) =>
      r.content?.some(
        (c) => c.type === "text" && JSON.parse(c.text).success === false,
      ),
    ),
    { responses: replies.length },
  );
  const invalid = await clients[0]
    .callTool({ name: "list_sessions", arguments: { limit: 0 } })
    .catch((e) => ({ isError: true, error: e.message }));
  check("invalid tool arguments rejected", invalid.isError === true);
  await clients[0].close();
  const remaining = await clients[1].listTools();
  check("second session survives first close", remaining.tools.length > 0);
  const windows = await app.evaluate(({ BrowserWindow }) => ({
    positions: BrowserWindow.getAllWindows().map((w) => w.getPosition()),
    focused: !!BrowserWindow.getFocusedWindow(),
  }));
  check(
    "offscreen and unfocused",
    !windows.focused && windows.positions.every((p) => p[0] < -3000),
  );
  for (const method of ["POST", "GET", "DELETE"]) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "mcp-session-id": "expired-private-qa-session",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      ...(method === "POST"
        ? {
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 99,
              method: "tools/list",
            }),
          }
        : {}),
      signal: AbortSignal.timeout(10000),
    });
    await response.text();
    result.cases.push({
      name: "unknown session " + method,
      ok: response.status === 404,
      detail: { status: response.status },
    });
  }
  const foreign = await fetch(url, {
    headers: {
      Authorization: "Bearer " + token,
      Origin: "https://untrusted.example",
      Accept: "text/event-stream",
    },
    signal: AbortSignal.timeout(10000),
  });
  await foreign.text();
  result.cases.push({
    name: "foreign Origin rejected",
    ok: foreign.status === 403,
    detail: { status: foreign.status },
  });
  console.log(JSON.stringify(result));
  if (result.cases.some((c) => !c.ok))
    throw new Error("Packaged MCP checks failed");
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (app) await app.close();
  writeFileSync(join(out, "results.json"), JSON.stringify(result, null, 2));
}
