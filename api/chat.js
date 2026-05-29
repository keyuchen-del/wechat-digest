import { PROVIDERS, handlePreflight, setCors } from "./_lib.js";

// Universal streaming proxy for OpenAI-compatible chat providers.
// Frontend sends: { provider, model, key, messages }
// We forward to the provider and stream the SSE response back, sidestepping
// browser CORS limitations for DeepSeek / DashScope (通义千问).
export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJson(req);
    const { provider = "openai", model, key, messages } = body || {};

    const cfg = PROVIDERS[provider];
    if (!cfg) {
      res.status(400).json({ error: `未知的 provider: ${provider}` });
      return;
    }
    if (!key) {
      res.status(400).json({ error: "缺少 API Key" });
      return;
    }
    if (!Array.isArray(messages) || !messages.length) {
      res.status(400).json({ error: "messages 不能为空" });
      return;
    }

    const upstream = await fetch(cfg.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: model || cfg.models[0],
        messages,
        stream: true,
        temperature: 0.4,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      let msg = `上游 ${cfg.label} 返回 ${upstream.status}`;
      try {
        msg = JSON.parse(errText).error?.message || msg;
      } catch {}
      res.status(upstream.status || 502).json({ error: msg });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || "代理请求失败" });
    } else {
      res.end();
    }
  }
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
