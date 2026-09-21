import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

describe("Sophia HTTP Server (Streamable HTTP + SSE)", () => {
  const TEST_PORT = 19876;
  let serverProcess;

  test("Démarrage du serveur HTTP sur port dédié", async () => {
    serverProcess = spawn("node", ["dist/index.js", "--http"], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Attendre que le serveur démarre
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Serveur HTTP non démarré dans les temps")), 5000);
      serverProcess.stderr.on("data", (data) => {
        if (data.toString().includes("Serveur HTTP actif")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      serverProcess.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  test("GET /health renvoie 200 avec les endpoints Streamable HTTP et SSE", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "healthy");
    assert.equal(body.server, "mcp-server-sophia");
    assert.ok(body.transports.includes("StreamableHTTP"));
    assert.ok(body.transports.includes("SSE"));
    assert.equal(body.endpoints.mcp, "/mcp");
    assert.equal(body.endpoints.sse, "/sse");
  });

  test("Streamable HTTP : POST /mcp initialize handshake", async () => {
    const initPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    };

    const res = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initPayload),
    });

    assert.equal(res.status, 200);
    const sessionId = res.headers.get("mcp-session-id");
    assert.ok(sessionId, "mcp-session-id doit être présent dans les en-têtes");

    const text = await res.text();
    assert.ok(text.includes("mcp-server-sophia"));
  });

  test("Streamable HTTP : POST /sse initialize handshake (compatibilité Antigravity serverUrl)", async () => {
    const initPayload = {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "antigravity-test", version: "1.0.0" },
      },
    };

    const res = await fetch(`http://localhost:${TEST_PORT}/sse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initPayload),
    });

    assert.equal(res.status, 200);
    const sessionId = res.headers.get("mcp-session-id");
    assert.ok(sessionId, "mcp-session-id doit être généré pour POST /sse");
    const text = await res.text();
    assert.ok(text.includes("mcp-server-sophia"));
  });

  test("Legacy SSE : GET /sse émet un événement endpoint", async () => {
    const sseResponse = await new Promise((resolve, reject) => {
      const req = http.request(
        `http://localhost:${TEST_PORT}/sse`,
        { method: "GET", headers: { Accept: "text/event-stream" } },
        (res) => {
          assert.equal(res.statusCode, 200);
          res.on("data", (chunk) => {
            const str = chunk.toString();
            if (str.includes("event: endpoint")) {
              req.destroy();
              resolve(str);
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });

    assert.ok(sseResponse.includes("data: /messages?sessionId="));
  });

  test("Arrêt propre du serveur HTTP de test", async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
    }
  });
});
