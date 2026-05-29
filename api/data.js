import { kvEnabled, kvGet, kvSet, handlePreflight, setCors } from "./_lib.js";

// Anonymous workspace storage.
//   GET /api/data?ws=CODE         → { articles, updatedAt }
//   PUT /api/data?ws=CODE  body { articles } → { ok, updatedAt }
// A workspace code is a high-entropy secret; whoever holds it can read/write.
// API keys are NEVER stored here — the frontend keeps them in localStorage only.

const MAX_BYTES = 2_000_000; // ~2MB per workspace
const MAX_ARTICLES = 500;
const CODE_RE = /^[a-z0-9]{4,8}(-[a-z0-9]{4,8}){1,5}$/i;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  if (!kvEnabled()) {
    res.status(501).json({
      error: "云同步未启用（后端未配置 KV）。应用将以纯本地模式运行。",
      kv: false,
    });
    return;
  }

  const ws = (req.query?.ws || "").toString().trim();
  if (!CODE_RE.test(ws)) {
    res.status(400).json({ error: "工作区码格式不正确" });
    return;
  }
  const key = `ws:${ws.toLowerCase()}`;

  try {
    if (req.method === "GET") {
      const data = await kvGet(key);
      if (!data) {
        res.status(200).json({ articles: [], updatedAt: null, fresh: true });
        return;
      }
      res.status(200).json({
        articles: Array.isArray(data.articles) ? data.articles : [],
        updatedAt: data.updatedAt || null,
      });
      return;
    }

    if (req.method === "PUT" || req.method === "POST") {
      const body = await readJson(req);
      let articles = Array.isArray(body?.articles) ? body.articles : null;
      if (!articles) {
        res.status(400).json({ error: "缺少 articles 数组" });
        return;
      }
      if (articles.length > MAX_ARTICLES) {
        articles = articles.slice(0, MAX_ARTICLES);
      }
      const sanitized = articles.map(sanitizeArticle);
      const updatedAt = new Date().toISOString();
      const payload = { articles: sanitized, updatedAt };
      const json = JSON.stringify(payload);
      if (json.length > MAX_BYTES) {
        res.status(413).json({ error: "工作区数据超出上限（约 2MB），请清理后再试" });
        return;
      }
      const ok = await kvSet(key, json);
      if (!ok) {
        res.status(502).json({ error: "云端写入失败，请稍后重试" });
        return;
      }
      res.status(200).json({ ok: true, updatedAt });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: err?.message || "服务器错误" });
  }
}

// Drop anything we don't want persisted (defensive — never store secrets).
function sanitizeArticle(a) {
  return {
    id: String(a.id || ""),
    account: String(a.account || ""),
    publishDate: String(a.publishDate || ""),
    title: String(a.title || ""),
    url: String(a.url || ""),
    content: String(a.content || ""),
    summary: String(a.summary || ""),
    analyzedAt: a.analyzedAt || null,
    createdAt: a.createdAt || null,
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.body) {
      if (typeof req.body === "string") {
        try {
          resolve(JSON.parse(req.body));
        } catch (e) {
          reject(e);
        }
      } else {
        resolve(req.body);
      }
      return;
    }
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
