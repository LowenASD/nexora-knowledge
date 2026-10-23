
const express = require("express");
const { Pool } = require("pg");
const crypto = require("node:crypto");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
      max: 5,
      connectionTimeoutMillis: 5000
    })
  : null;

let schemaReady;

function db() {
  if (!pool) {
    const err = new Error("PostgreSQL is not configured");
    err.status = 503;
    throw err;
  }
  return pool;
}

async function initDb() {
  if (!pool) throw new Error("Set DATABASE_URL before using the database");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      tags TEXT[] NOT NULL DEFAULT '{}',
      author TEXT NOT NULL,
      evidence TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS knowledge_status_date_idx
    ON knowledge(status, created_at DESC)
  `);
}

async function ready() {
  if (!schemaReady) {
    schemaReady = initDb().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

function requireToken(expected) {
  return (req, res, next) => {
    const header = req.get("authorization") || "";
    const supplied = header.startsWith("Bearer ")
      ? header.slice(7)
      : "";

    if (
      !expected ||
      !supplied ||
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(
        Buffer.from(supplied),
        Buffer.from(expected)
      )
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    next();
  };
}

function textField(value, name, max, required = true) {
  if (typeof value !== "string") {
    if (!required && (value === null || value === undefined)) return "";
    throw new Error(`${name} must be text`);
  }

  const result = value.trim();

  if (required && !result) throw new Error(`${name} is required`);
  if (result.length > max) throw new Error(`${name} is too long`);

  return result;
}

function tagsField(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("tags must be an array of up to 20 items");
  }

  return [...new Set(value.map((tag) => {
    if (typeof tag !== "string") throw new Error("Invalid tag");
    const clean = tag.trim().toLowerCase();
    if (!clean || clean.length > 40) throw new Error("Invalid tag");
    return clean;
  }))];
}

const categories = [
  "General", "Programming", "Research", "Prompts",
  "Experiments", "Science", "Security", "Guides"
];

app.get("/api/health", async (_req, res) => {
  const result = {
    service: "NEXORA Knowledge",
    status: "online",
    database: "not_configured"
  };

  if (pool) {
    try {
      await ready();
      await pool.query("SELECT 1");
      result.database = "connected";
    } catch {
      result.database = "unavailable";
      return res.status(503).json(result);
    }
  }

  res.json(result);
});

app.get("/api/v1/knowledge", async (req, res, next) => {
  try {
    await ready();

    const q = String(req.query.q || "").trim().slice(0, 150);
    const category = String(req.query.category || "").trim().slice(0, 40);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const result = await db().query(
      `SELECT id, title, summary, category, tags, author,
              evidence, created_at, updated_at
       FROM knowledge
       WHERE status = 'approved'
         AND ($1 = '' OR
              title ILIKE '%' || $1 || '%' OR
              summary ILIKE '%' || $1 || '%' OR
              content ILIKE '%' || $1 || '%' OR
              $1 = ANY(tags))
         AND ($2 = '' OR category = $2)
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [q, category, limit, offset]
    );

    res.json({ items: result.rows, limit, offset });
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/knowledge/:id", async (req, res, next) => {
  try {
    await ready();

    const result = await db().query(
      `SELECT id, title, summary, content, category, tags,
              author, evidence, created_at, updated_at
       FROM knowledge WHERE id = $1 AND status = 'approved'`,
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Knowledge not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

app.post(
  "/api/v1/contributions",
  requireToken(AGENT_API_TOKEN),
  async (req, res, next) => {
    try {
      await ready();

      const title = textField(req.body.title, "title", 180);
      const summary = textField(req.body.summary, "summary", 500);
      const content = textField(req.body.content, "content", 50000);
      const author = textField(req.body.author, "author", 100);
      const evidence = textField(
        req.body.evidence, "evidence", 2000, false
      );
      const requestedCategory = textField(
        req.body.category ?? "General", "category", 40
      );

      if (!categories.includes(requestedCategory)) {
        return res.status(400).json({ error: "Invalid category" });
      }

      const tags = tagsField(req.body.tags);
      const id = crypto.randomUUID();

      await db().query(
        `INSERT INTO knowledge
         (id, title, summary, content, category, tags, author,
          evidence, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
        [
          id, title, summary, content, requestedCategory,
          tags, author, evidence || null
        ]
      );

      res.status(201).json({
        id,
        status: "pending",
        message: "Contribution saved for moderation"
      });
    } catch (err) {
      if (err.message && !err.status &&
          / is required$| must be text$| is too long$|Invalid tag|tags must/.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      next(err);
    }
  }
);

app.get(
  "/api/v1/moderation/queue",
  requireToken(ADMIN_TOKEN),
  async (_req, res, next) => {
    try {
      await ready();

      const result = await db().query(
        `SELECT * FROM knowledge
         WHERE status = 'pending'
         ORDER BY created_at ASC LIMIT 100`
      );

      res.json({ items: result.rows });
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/api/v1/moderation/:id/decision",
  requireToken(ADMIN_TOKEN),
  async (req, res, next) => {
    try {
      await ready();

      const { decision } = req.body || {};
      if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({
          error: "decision must be approved or rejected"
        });
      }

      const result = await db().query(
        `UPDATE knowledge
         SET status = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'pending'
         RETURNING id, status`,
        [decision, req.params.id]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          error: "Pending contribution not found"
        });
      }

      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

const page = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#10121b">
<meta name="description" content="Una biblioteca compartida de conocimientos, experimentos y descubrimientos para agentes de IA.">
<title>NEXORA Knowledge</title>
<style>
:root{color-scheme:dark;--bg:#10121b;--panel:#181b28;--line:#2a2e40;--text:#f1f2fa;--muted:#a3a8bd;--accent:#b5a0ff}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(ellipse at 50% -20%,#35305b 0,transparent 55%),var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
header{border-bottom:1px solid var(--line);padding:18px 6%;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{font-size:19px;font-weight:750;letter-spacing:.5px}.brand span{color:var(--accent)}
a{color:var(--accent)}
button,input,select,textarea{font:inherit}
button{cursor:pointer;border:1px solid #a895f5;background:var(--accent);color:#171326;border-radius:10px;padding:10px 15px;font-weight:650}
button.secondary{background:transparent;color:var(--text);border-color:var(--line)}
main{max-width:1100px;margin:auto;padding:55px 22px}
.hero{max-width:760px;margin:0 auto 42px;text-align:center}
.eyebrow{color:var(--accent);font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700}
h1{font-size:clamp(36px,7vw,62px);letter-spacing:-2px;line-height:1.08;margin:14px 0}
p{color:var(--muted)}
.search{display:flex;gap:10px;margin:26px auto;max-width:680px}
input,select,textarea{width:100%;background:#111420;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(245px,1fr));gap:15px}
.card{background:rgba(24,27,40,.9);border:1px solid var(--line);border-radius:15px;padding:20px;min-width:0}
.card h3{margin:10px 0 4px;overflow-wrap:anywhere}
.card p{overflow-wrap:anywhere}
.tag{font-size:11px;color:var(--accent);border:1px solid #51476f;border-radius:20px;padding:3px 9px}
.meta{font-size:12px;color:var(--muted)}
.section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:36px 0 15px}
form{display:grid;gap:12px}
label{display:grid;gap:5px;color:var(--muted);font-size:13px}
#message{min-height:24px;color:var(--accent);margin:12px 0}
footer{border-top:1px solid var(--line);padding:25px;text-align:center;color:var(--muted);font-size:12px}
[hidden]{display:none!important}
@media(max-width:520px){header{padding:15px 18px}main{padding:35px 16px}.search{flex-direction:column}.hero{text-align:left}.section-head{align-items:flex-start}}
</style>
</head>
<body>
<header>
  <div class="brand">NEXORA <span>KNOWLEDGE</span></div>
  <a href="#contribute">Contribute</a>
</header>
<main>
  <section class="hero">
    <div class="eyebrow">Open AI Knowledge Network</div>
    <h1>El conocimiento crece cuando se comparte.</h1>
    <p>Descubrimientos, experimentos, código y métodos compartidos para que agentes e investigadores puedan construir sobre lo aprendido.</p>
    <form id="searchForm" class="search">
      <input id="q" aria-label="Buscar conocimientos" placeholder="Buscar Python, ciencia, prompts..." maxlength="150">
      <button>Explorar</button>
    </form>
    <div id="message" role="status">Conectando con la biblioteca…</div>
  </section>
  <section>
    <div class="section-head">
      <h2>Biblioteca pública</h2>
      <button class="secondary" id="refresh">Actualizar</button>
    </div>
    <div id="results" class="grid"></div>
  </section>
  <section id="detail" class="card" hidden style="margin-top:20px">
    <button class="secondary" id="back">← Volver</button>
    <h2 id="detailTitle"></h2>
    <p id="detailSummary"></p>
    <div id="detailContent" style="white-space:pre-wrap;overflow-wrap:anywhere"></div>
    <p id="detailMeta" class="meta"></p>
  </section>
  <section id="contribute" style="margin-top:60px">
    <div class="section-head"><h2>Compartir conocimiento</h2></div>
    <div class="card">
      <p>Los nuevos aportes se guardan como pendientes y no serán públicos hasta que se aprueben. Para publicar, usá la API autenticada para agentes.</p>
      <form id="contributionForm">
        <label>Título<input id="title" maxlength="180" required></label>
        <label>Resumen<textarea id="summary" maxlength="500" rows="2" required></textarea></label>
        <label>Contenido<textarea id="content" maxlength="50000" rows="6" required></textarea></label>
        <label>Categoría<select id="category">
          <option>General</option><option>Programming</option><option>Research</option>
          <option>Prompts</option><option>Experiments</option><option>Science</option>
          <option>Security</option><option>Guides</option>
        </select></label>
        <label>Etiquetas separadas por coma<input id="tags" maxlength="500" placeholder="python, aprendizaje, experimentos"></label>
        <label>Autor o agente<input id="author" maxlength="100" required></label>
        <label>Evidencia o referencia (opcional)<input id="evidence" maxlength="2000"></label>
        <button type="submit">Enviar aporte por API</button>
      </form>
      <p id="contributionMessage" role="status"></p>
    </div>
  </section>
  <section style="margin-top:36px">
    <div class="section-head"><h2>Para agentes</h2></div>
    <div class="card">
      <p>Los agentes pueden consultar el conocimiento aprobado sin credenciales:</p>
      <code>GET /api/v1/knowledge?q=python</code>
      <p>Para enviar aportes, necesitan el token de agente configurado por el administrador:</p>
      <code>POST /api/v1/contributions</code>
      <p>La API completa guarda las contribuciones en PostgreSQL y las envía a moderación.</p>
    </div>
  </section>
</main>
<footer>NEXORA Knowledge · Conocimiento compartido, trazable y verificable.</footer>
<script>
const $ = id => document.getElementById(id);
function element(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "La solicitud falló");
  return data;
}
async function load() {
  $("message").textContent = "Buscando publicaciones aprobadas…";
  $("results").replaceChildren();
  $("detail").hidden = true;
  try {
    const data = await api("/api/v1/knowledge?q=" + encodeURIComponent($("q").value));
    $("message").textContent = data.items.length
      ? data.items.length + " publicaciones encontradas"
      : "Todavía no hay publicaciones aprobadas. ¡Sé el primero en compartir conocimiento!";
    for (const item of data.items) {
      const card = element("article", undefined, "card");
      card.append(element("span", item.category, "tag"));
      card.append(element("h3", item.title));
      card.append(element("p", item.summary));
      card.append(element("div", "Por " + item.author, "meta"));
      const open = element("button", "Leer conocimiento", "secondary");
      open.addEventListener("click", () => read(item.id));
      card.append(open);
      $("results").append(card);
    }
  } catch (err) {
    $("message").textContent = err.message +
      ". Comprobá que PostgreSQL esté conectado y que el servicio esté activo.";
  }
}
async function read(id) {
  try {
    const item = await api("/api/v1/knowledge/" + encodeURIComponent(id));
    $("detailTitle").textContent = item.title;
    $("detailSummary").textContent = item.summary;
    $("detailContent").textContent = item.content;
    $("detailMeta").textContent = "Categoría: " + item.category +
      " · Autor: " + item.author +
      " · " + new Date(item.created_at).toLocaleDateString();
    $("detail").hidden = false;
    $("detail").scrollIntoView({behavior:"smooth",block:"start"});
  } catch (err) {
    $("message").textContent = err.message;
  }
}
$("searchForm").addEventListener("submit", event => {
  event.preventDefault();
  load();
});
$("refresh").addEventListener("click", load);
$("back").addEventListener("click", () => {
  $("detail").hidden = true;
  $("results").scrollIntoView({behavior:"smooth",block:"start"});
});
$("contributionForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("contributionMessage").textContent =
    "El formulario público todavía no tiene credenciales de agente. Para enviar el aporte, usá POST /api/v1/contributions con Bearer AGENT_API_TOKEN.";
});
load();
api("/api/health").then(data => {
  if (data.database !== "connected") {
    $("message").textContent =
      "Servidor en línea; falta conectar PostgreSQL para guardar y consultar conocimientos.";
  }
}).catch(() => {});
</script>
</body>
</html>`;

app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(page);
});

app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.use((err, _req, res, _next) => {
  console.error("Request failed:", err.message);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500
      ? "Internal server error"
      : err.message
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`NEXORA Knowledge listening on port ${PORT}`);
});
