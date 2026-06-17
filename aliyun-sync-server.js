#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const port = Number(process.env.PORT || 3000);
const stateFile = path.resolve(process.env.STATE_FILE || "./data/athlete-manager-state.json");
const apiKey = String(process.env.SYNC_KEY || "").trim();

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  return JSON.parse(text);
}

async function loadState() {
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return { athletes: [], updatedAt: "" };
  }
}

async function saveState(nextState) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(nextState, null, 2), "utf8");
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS"
  });
  res.end(JSON.stringify(data));
}

function checkKey(req) {
  if (!apiKey) return true;
  const incoming = String(req.headers["x-api-key"] || "").trim();
  return incoming === apiKey;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS"
    });
    res.end();
    return;
  }

  if (!checkKey(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.url === "/" && req.method === "GET") {
    const state = await loadState();
    sendJson(res, 200, { state });
    return;
  }

  if (req.url === "/" && (req.method === "POST" || req.method === "PUT")) {
    try {
      const body = await readJsonBody(req);
      const nextState = body && body.state ? body.state : body;
      if (!nextState || typeof nextState !== "object") {
        sendJson(res, 400, { error: "invalid_state" });
        return;
      }
      const saved = {
        ...nextState,
        updatedAt: body?.updatedAt || nextState.updatedAt || new Date().toISOString()
      };
      await saveState(saved);
      sendJson(res, 200, { ok: true, state: saved });
    } catch (error) {
      sendJson(res, 400, { error: error?.message || "bad_request" });
    }
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

server.listen(port, () => {
  console.log(`Aliyun sync server listening on http://0.0.0.0:${port}`);
  console.log(`State file: ${stateFile}`);
});
