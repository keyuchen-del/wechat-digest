// Shared helpers for serverless functions.

export const PROVIDERS = {
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  },
  deepseek: {
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  dashscope: {
    label: "通义千问",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    models: ["qwen-plus", "qwen-turbo", "qwen-max"],
  },
};

/* ──────────────── CORS ──────────────── */

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function handlePreflight(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.status(204).end();
    return true;
  }
  return false;
}

/* ──────────────── KV (Upstash Redis REST) ────────────────
   Works with both legacy Vercel KV and the Upstash Marketplace
   integration — both expose KV_REST_API_URL + KV_REST_API_TOKEN.
   Degrades gracefully to null when not configured. */

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export function kvEnabled() {
  return !!(KV_URL && KV_TOKEN);
}

async function kvCmd(args) {
  if (!kvEnabled()) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(KV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    return data ? data.result : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function kvGet(key) {
  const raw = await kvCmd(["GET", key]);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ttlSeconds optional — when provided, sets an expiry.
export async function kvSet(key, value, ttlSeconds) {
  const payload = typeof value === "string" ? value : JSON.stringify(value);
  const args = ["SET", key, payload];
  if (ttlSeconds) args.push("EX", String(ttlSeconds));
  const r = await kvCmd(args);
  return r === "OK";
}

/* ──────────────── HTTP fetching (hardened) ──────────────── */

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

function pickUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function baseHeaders(ua) {
  return {
    "User-Agent": ua || pickUA(),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Single fetch returning html + set-cookie + final url.
export async function fetchHtml(url, extraHeaders = {}, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout || 15000);
  try {
    const r = await fetch(url, {
      headers: { ...baseHeaders(opts.ua), ...extraHeaders },
      redirect: opts.redirect || "follow",
      signal: ctl.signal,
    });
    const html = await r.text();
    return {
      ok: r.ok,
      status: r.status,
      html,
      finalUrl: r.url,
      setCookie: r.headers.get("set-cookie") || "",
    };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch with retry + exponential backoff. `shouldRetry(result)` decides
// whether a 2xx-but-blocked page warrants another attempt.
export async function fetchHtmlRetry(url, extraHeaders = {}, opts = {}) {
  const tries = opts.tries || 3;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ua = pickUA();
      last = await fetchHtml(url, extraHeaders, { ...opts, ua });
      const blocked = opts.shouldRetry ? opts.shouldRetry(last) : false;
      if (last.ok && !blocked) return last;
    } catch (e) {
      last = { ok: false, status: 0, html: "", error: e?.message };
    }
    if (i < tries - 1) await sleep(400 * 2 ** i + Math.random() * 300);
  }
  return last;
}

// Warm up a Sogou session to obtain anti-spider cookies (SUV/SNUID).
// Returns a Cookie header string (may be empty if warmup fails).
export async function sogouCookie() {
  try {
    const r = await fetchHtml("https://weixin.sogou.com/", {
      Referer: "https://www.sogou.com/",
    });
    const sc = r.setCookie || "";
    const jar = [];
    for (const part of sc.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
      const kv = part.split(";")[0].trim();
      if (/^(SUV|SNUID|SUID|IPLOC|ABTEST)=/.test(kv)) jar.push(kv);
    }
    if (!jar.some((c) => c.startsWith("SUV="))) {
      jar.push("SUV=" + Date.now() + Math.floor(Math.random() * 1e6));
    }
    return jar.join("; ");
  } catch {
    return "SUV=" + Date.now() + Math.floor(Math.random() * 1e6);
  }
}

/* ──────────────── HTML → text ──────────────── */

export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<\/(p|div|section|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}
