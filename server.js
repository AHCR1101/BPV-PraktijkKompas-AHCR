const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4173);
const ENV_PATH = path.join(ROOT, ".env");
const PROMPT_PATH = path.join(ROOT, "INSTRUCTIES", "ai_prompt_opleidingsplan.md");

loadEnv(ENV_PATH);

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) process.env[key] = value;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Aanvraag is te groot."));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function safeJoin(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const normalized = path.normalize(decoded).replace(/^([/\\])+/, "");
  const resolved = path.join(root, normalized || "index.html");
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }[ext] || "application/octet-stream";
}

function extractResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function parseAiJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("AI gaf geen geldige JSON terug.");
  }
}

function normaliseItems(payload) {
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const required = [
    "Koppeling Werkproces",
    "Dossierkader",
    "Weeknr.",
    "Dag",
    "Datum",
    "Taak / Opdr. / Activiteit",
    "Leerdoel",
    "Kerntaak / Werkproces",
    "Op Welke Manier / Wijze",
    "Benodigdheden",
    "Voorbereidingen",
    "Praktijkopleider",
    "Tijd",
    "Resultaat / Criteria",
  ];
  const lookup = new Map(rawItems.map((item) => [String(item.label || "").trim(), String(item.value || "").trim()]));
  return required.map((label) => ({ label, value: lookup.get(label) || "Aan te vullen" }));
}

async function handleGenerateActivity(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.includes("plak_hier")) {
    sendJson(res, 500, { error: "OPENAI_API_KEY ontbreekt nog in het lokale .env-bestand." });
    return;
  }

  const body = await readRequestBody(req);
  const payload = JSON.parse(body || "{}");
  const prompt = fs.readFileSync(PROMPT_PATH, "utf8");
  const model = process.env.OPENAI_MODEL || "gpt-5.5";
  const userContext = JSON.stringify(payload, null, 2);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: prompt }],
        },
        {
          role: "user",
          content: [{
            type: "input_text",
            text: `Werk deze praktijkopleider-suggestie uit. Geef uitsluitend geldige JSON terug met deze vorm: {"items":[{"label":"...","value":"..."}]}.\n\nContext vanuit BPV PraktijkKompas AHCR:\n${userContext}`,
          }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "opleidingsplan_activiteit",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    label: { type: "string" },
                    value: { type: "string" },
                  },
                  required: ["label", "value"],
                },
              },
            },
            required: ["items"],
          },
          strict: true,
        },
      },
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `OpenAI-aanvraag mislukt (${response.status}).`;
    sendJson(res, response.status, { error: message });
    return;
  }

  const text = extractResponseText(data);
  const parsed = parseAiJson(text);
  sendJson(res, 200, { items: normaliseItems(parsed) });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "POST" && url.pathname === "/api/generate-activity") {
      await handleGenerateActivity(req, res);
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/download-handleiding") {
      const filePath = path.join(ROOT, "handleiding-bpv-praktijkkompas-ahcr.pdf");
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Handleiding niet gevonden");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="handleiding-bpv-praktijkkompas-ahcr.pdf"',
        "Content-Length": fs.statSync(filePath).size,
        "Cache-Control": "no-store",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end("Method not allowed");
      return;
    }

    const filePath = safeJoin(ROOT, url.pathname === "/" ? "/index.html" : url.pathname);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Niet gevonden");
      return;
    }

    const headers = { "Content-Type": contentType(filePath) };
    if (path.basename(filePath) === "handleiding-bpv-praktijkkompas-ahcr.pdf") {
      headers["Content-Disposition"] = 'attachment; filename="handleiding-bpv-praktijkkompas-ahcr.pdf"';
    }

    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Onbekende serverfout." });
  }
});

server.listen(PORT, () => {
  console.log(`BPV PraktijkKompas AHCR draait op http://localhost:${PORT}`);
});
