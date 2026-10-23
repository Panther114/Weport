// Packaged MCP acceptance: private profile, isolated loopback port, no account
// data or external communication. Tokens stay inside the private temp profile.
// Exercises auth, malformed JSON, parallel clients, tool argument validation,
// session rejection and browser Origin policy. Does not prove real history reads.
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import net from "node:net";
import http from "node:http";
const root = resolve(process.cwd());
const require = createRequire(join(root, "package.json"));
const { resolveLayout } = require(
  join(root, "scripts/verify-packaged-native.cjs"),
);
const layout = resolveLayout(join(root, "release"));
const installedLinuxExe = process.argv[3];
if (installedLinuxExe && process.platform !== "linux") throw new Error("Installed sandbox acceptance requires Linux");
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
const apiReservation = net.createServer();
await new Promise((r) => apiReservation.listen(0, "127.0.0.1", r));
const apiPort = apiReservation.address().port;
await new Promise((r) => apiReservation.close(r));
const profile = mkdtempSync(join(tmpdir(), "weport-mcp-qa-"));
writeFileSync(
  profile + "/Weport-config.json",
  JSON.stringify({
    mcpEnabled: true,
    mcpHost: "127.0.0.1",
    mcpPort: port,
    mcpToken: token,
    httpApiEnabled: true,
    httpApiHost: "127.0.0.1",
    httpApiPort: apiPort,
    httpApiToken: token,
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
  if (!ok) throw new Error(name + " failed: " + JSON.stringify(detail));
};
try {
  app = await _electron.launch({
    executablePath: installedLinuxExe || layout.appExe,
    chromiumSandbox: Boolean(installedLinuxExe),
    args: ["--background", `--user-data-dir=${profile}`],
    env: {
      ...process.env,
      WEPORT_PROBE_OFFSCREEN: "1",
      WEPORT_PROBE_HIDDEN_ONLY: "1",
      WEPORT_NATIVE_GLASS: "0",
    },
    timeout: 60000,
  });
  await app.evaluate(async ({ app, BrowserWindow }) => {
    await app.whenReady();
    while (!app.listenerCount("activate"))
      await new Promise((r) => setTimeout(r, 25));
    const proto = BrowserWindow.prototype;
    const inactive = proto.showInactive,
      position = proto.setPosition,
      hide = proto.hide;
    const present = function () {
      position.call(this, -4000, 0);
      return hide.call(this);
    };
    proto.show = present;
    proto.showInactive = present;
    proto.maximize = function () {
      position.call(this, -4000, 0);
    };
    proto.focus = function () {};
    app.emit("activate");
  });
  const page = await app.firstWindow();
  await page.locator(".rail-item").first().waitFor({ timeout: 30000 });
  if (installedLinuxExe) {
    const renderer = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      return { pid: window.webContents.getOSProcessId(), sandbox: window.webContents.getLastWebPreferences().sandbox, args: process.argv };
    });
    const status = readFileSync(`/proc/${renderer.pid}/status`, "utf8");
    check("installed Linux renderer sandbox enabled", renderer.sandbox === true && !renderer.args.includes("--no-sandbox")
      && /^NoNewPrivs:\s+1$/m.test(status) && /^Seccomp:\s+2$/m.test(status), { sandbox: renderer.sandbox, noNewPrivs: /^NoNewPrivs:\s+1$/m.test(status), seccomp: /^Seccomp:\s+2$/m.test(status) });
  }
  await page.waitForFunction(
    async () => (await window.electronAPI.mcp.getStatus()).running,
    null,
    { timeout: 30000 },
  );
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
    windows: BrowserWindow.getAllWindows().map((w) => ({
      position: w.getPosition(),
      visible: w.isVisible(),
    })),
    focused: !!BrowserWindow.getFocusedWindow(),
  }));
  check(
    "offscreen and unfocused",
    !windows.focused &&
      windows.windows.every((w) => !w.visible || w.position[0] < -3000),
    windows,
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
  for (const endpointPort of [port, apiPort]) {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: endpointPort,
          path: "http://[",
          headers: { Authorization: "Bearer " + token },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.setTimeout(10000, () =>
        req.destroy(new Error("Malformed URL request hung")),
      );
      req.on("error", reject);
      req.end();
    });
    check(
      endpointPort === port ? "MCP malformed URL" : "HTTP API malformed URL",
      status === 400,
      { status },
    );
  }
  const healthUrl = `http://127.0.0.1:${apiPort}/api/health`;
  const denied = await fetch(healthUrl, { signal: AbortSignal.timeout(10000) });
  await denied.text();
  check("HTTP API authentication", denied.status === 401, {
    status: denied.status,
  });
  const health = await fetch(healthUrl, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(10000),
  });
  const healthBody = await health.json();
  check(
    "HTTP API health after malformed request",
    health.status === 200 && healthBody.success && healthBody.running,
  );
  // Exercise renderer -> main -> WCDB subprocess using only an invalid fixture.
  const fixture = join(profile, "native-fixture");
  const storage = join(fixture, "qa_account", "db_storage", "session");
  mkdirSync(storage, { recursive: true });
  writeFileSync(join(storage, "session.db"), Buffer.alloc(4096));
  const native = await page.evaluate(async (fixture) => {
    const api = window.electronAPI;
    const connection = await api.wcdb.testConnection(
      fixture,
      "00".repeat(32),
      "qa_account",
    );
    const diagnostic = await api.diagnostics.collect({ full: false });
    return {
      connection,
      checks: diagnostic.checks.filter((c) => c.id.startsWith("engine.")),
    };
  }, fixture);
  const host = native.checks.find((c) => c.id === "engine.host");
  const init = native.checks.find((c) => c.id === "engine.init");
  const dll = native.checks.find((c) => c.id === "engine.dll");
  check(
    "real app WCDB IPC initializes and rejects invalid fixture",
    native.connection.success === false &&
      typeof native.connection.error === "string" &&
      host?.raw?.includes("ready=true") &&
      init?.state === "ok" &&
      dll?.state === "ok",
    {
      rejected: native.connection.success === false,
      host: host?.state,
      init: init?.state,
      dll: dll?.state,
    },
  );
  const staleExportPath = join(profile, "stale-account-annotations.json");
  const annotations = await page.evaluate(async (path) => {
    const api = window.electronAPI;
    await api.config.set("myWxid", "qa_annotations_a");
    const own = await api.annotations.mutate({ op: "fav.add", payload: { sessionId: "qa_contact", localId: "", ts: 0 } }, { accountId: "qa_annotations_a" });
    await api.config.set("myWxid", "qa_annotations_b");
    const rejected = async (operation) => {
      try { await operation(); return false; } catch { return true; }
    };
    const staleListRejected = await rejected(() => api.annotations.list({ accountId: "qa_annotations_a" }));
    const staleWriteRejected = await rejected(() => api.annotations.mutate({ op: "fav.add", payload: { sessionId: "qa_foreign", localId: "", ts: 0 } }, { accountId: "qa_annotations_a" }));
    const staleExportRejected = await rejected(() => api.annotations.export({ format: "json", path }, { accountId: "qa_annotations_a" }));
    const other = await api.annotations.list({ accountId: "qa_annotations_b" });
    await api.config.set("myWxid", "qa_annotations_a");
    const restored = await api.annotations.list({ accountId: "qa_annotations_a" });
    return { ownCount: own.favorites.length, otherCount: other.favorites.length, restoredCount: restored.favorites.length, staleListRejected, staleWriteRejected, staleExportRejected };
  }, staleExportPath);
  check("annotation stores remain account scoped", annotations.ownCount === 1 && annotations.otherCount === 0 && annotations.restoredCount === 1);
  check("stale annotation read rejected", annotations.staleListRejected);
  check("stale annotation mutation rejected", annotations.staleWriteRejected);
  check("stale annotation export rejected without writing", annotations.staleExportRejected && !existsSync(staleExportPath));
  if (process.platform === "darwin") {
    execFileSync(
      "codesign",
      ["--verify", "--deep", "--strict", dirname(layout.appContents)],
      { stdio: "pipe" },
    );
    check("macOS bundle seal survives runtime host deployment", true);
  }
  console.log(JSON.stringify(result));
  if (result.cases.some((c) => !c.ok))
    throw new Error("Packaged MCP checks failed");
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (app) await app.close();
  writeFileSync(join(out, "results.json"), JSON.stringify(result, null, 2));
}
