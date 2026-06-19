#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const port = Number(process.env.PORT || 3000);
const stateFile = path.resolve(process.env.STATE_FILE || "./data/athlete-manager-state.json");
const apiKey = String(process.env.SYNC_KEY || "").trim();
const htmlFile = path.resolve(process.env.HTML_FILE || "/root/athlete-manager.html");

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

function mergeListById(remoteList, localList) {
  const merged = new Map();
  for (const item of Array.isArray(remoteList) ? remoteList : []) {
    if (item?.id) merged.set(item.id, structuredClone(item));
  }
  for (const item of Array.isArray(localList) ? localList : []) {
    if (!item?.id) continue;
    const previous = merged.get(item.id);
    merged.set(item.id, previous ? { ...previous, ...structuredClone(item) } : structuredClone(item));
  }
  return [...merged.values()];
}

function mergeAthlete(remoteAthlete, localAthlete) {
  if (!remoteAthlete) return structuredClone(localAthlete);
  if (!localAthlete) return structuredClone(remoteAthlete);
  const merged = { ...structuredClone(remoteAthlete), ...structuredClone(localAthlete) };
  merged.results = mergeListById(remoteAthlete.results, localAthlete.results);
  merged.summaries = mergeListById(remoteAthlete.summaries, localAthlete.summaries);
  merged.plans = mergeListById(remoteAthlete.plans, localAthlete.plans);
  merged.attempts = mergeListById(remoteAthlete.attempts, localAthlete.attempts);
  return merged;
}

function mergeState(existingState, incomingState) {
  const remote = existingState && typeof existingState === "object" ? structuredClone(existingState) : {};
  const local = incomingState && typeof incomingState === "object" ? structuredClone(incomingState) : {};
  const athleteMap = new Map();
  for (const athlete of Array.isArray(remote.athletes) ? remote.athletes : []) {
    if (athlete?.id) athleteMap.set(athlete.id, athlete);
  }
  for (const athlete of Array.isArray(local.athletes) ? local.athletes : []) {
    if (!athlete?.id) continue;
    const previous = athleteMap.get(athlete.id);
    athleteMap.set(athlete.id, previous ? mergeAthlete(previous, athlete) : structuredClone(athlete));
  }
  const merged = {
    ...remote,
    ...local,
    settings: { ...(remote.settings || {}), ...(local.settings || {}) },
    athletes: [...athleteMap.values()]
  };
  merged.selectedId =
    (local.selectedId && athleteMap.has(local.selectedId) && local.selectedId) ||
    (remote.selectedId && athleteMap.has(remote.selectedId) && remote.selectedId) ||
    merged.athletes[0]?.id ||
    "";
  merged.updatedAt = local.updatedAt || remote.updatedAt || new Date().toISOString();
  return merged;
}

async function serveHtml(res) {
  try {
    const html = await fs.readFile(htmlFile, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(html);
  } catch {
    sendJson(res, 404, { error: "html_not_found", htmlFile });
  }
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
  const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS"
    });
    res.end();
    return;
  }

  if (pathname === "/athlete.html" && req.method === "GET") {
    res.writeHead(302, {
      Location: "/athlete-manager.html?mode=athlete",
      "Access-Control-Allow-Origin": "*"
    });
    res.end();
    return;
  }

  if (pathname === "/" || pathname === "/index.html" || pathname === "/athlete-manager.html" || pathname === "/app") {
    if (req.method === "GET") {
      await serveHtml(res);
      return;
    }
    if (req.method === "POST" || req.method === "PUT") {
      if (!checkKey(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const nextState = body && body.state ? body.state : body;
        if (!nextState || typeof nextState !== "object") {
          sendJson(res, 400, { error: "invalid_state" });
          return;
        }
        const existing = await loadState();
        const saved = mergeState(existing, {
          ...nextState,
          updatedAt: body?.updatedAt || nextState.updatedAt || new Date().toISOString()
        });
        await saveState(saved);
        sendJson(res, 200, { ok: true, state: saved });
      } catch (error) {
        sendJson(res, 400, { error: error?.message || "bad_request" });
      }
      return;
    }
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (pathname === "/api/health") {
    if (!checkKey(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!checkKey(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (pathname === "/api/" && req.method === "GET") {
    const state = await loadState();
    sendJson(res, 200, { state });
    return;
  }

  if (pathname === "/api/" && (req.method === "POST" || req.method === "PUT")) {
    try {
      const body = await readJsonBody(req);
      const nextState = body && body.state ? body.state : body;
      if (!nextState || typeof nextState !== "object") {
        sendJson(res, 400, { error: "invalid_state" });
        return;
      }
      const existing = await loadState();
      const saved = mergeState(existing, {
        ...nextState,
        updatedAt: body?.updatedAt || nextState.updatedAt || new Date().toISOString()
      });
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
