import {
  fetchHtml,
  fetchHtmlRetry,
  htmlToText,
  decodeEntities,
  sogouCookie,
  kvGet,
  kvSet,
  handlePreflight,
  setCors,
} from "./_lib.js";

// Fetch & clean a single WeChat article.
// GET /api/article?url=<mp.weixin.qq.com link OR sogou /link redirect>
export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  const input = (req.query?.url || "").toString().trim();
  if (!input) {
    res.status(400).json({ error: "缺少 url 参数" });
    return;
  }
  if (!/^https?:\/\//.test(input)) {
    res.status(400).json({ error: "url 格式不正确" });
    return;
  }

  try {
    // Sogou search results point at a redirect page whose real mp.weixin.qq.com
    // URL is assembled in JS — resolve it first.
    let url = input;
    if (/weixin\.sogou\.com\/link/.test(input)) {
      const resolved = await resolveSogouLink(input);
      if (resolved) url = resolved;
    }

    // Serve cached clean content keyed by the canonical mp URL.
    const mpKey = canonicalKey(url);
    if (mpKey) {
      const cached = await kvGet(`art:${mpKey}`);
      if (cached && cached.content) {
        res.status(200).json({ ...cached, cached: true });
        return;
      }
    }

    const result = await fetchHtmlRetry(
      url,
      { Referer: "https://mp.weixin.qq.com/" },
      { tries: 3, shouldRetry: (r) => isBlocked(r.html) }
    );
    const html = result?.html || "";
    const finalUrl = result?.finalUrl || url;

    if (isBlocked(html)) {
      res.status(429).json({
        error: "目标页触发了验证（链接可能已过期或被风控），请直接粘贴文章正文。",
        blocked: true,
      });
      return;
    }

    if (!result?.ok) {
      res.status(result?.status || 502).json({ error: `目标页返回 ${result?.status || "无响应"}` });
      return;
    }

    const title =
      pick(html, /<h1[^>]*class="rich_media_title"[^>]*>([\s\S]*?)<\/h1>/) ||
      pick(html, /<meta property="og:title" content="([^"]*)"/) ||
      pick(html, /<title>([\s\S]*?)<\/title>/);

    const account =
      pick(html, /<a[^>]*id="js_name"[^>]*>([\s\S]*?)<\/a>/) ||
      pick(html, /<strong[^>]*class="profile_nickname"[^>]*>([\s\S]*?)<\/strong>/) ||
      pick(html, /var nickname\s*=\s*"([^"]*)"/) ||
      pick(html, /var user_name\s*=\s*"([^"]*)"/) ||
      "";

    let publishDate =
      pick(html, /<em[^>]*id="publish_time"[^>]*>([\s\S]*?)<\/em>/) ||
      pick(html, /var ct\s*=\s*"(\d+)"/) ||
      pick(html, /"createTime"\s*:\s*"?(\d{10})"?/);
    if (/^\d+$/.test(publishDate)) {
      publishDate = new Date(parseInt(publishDate, 10) * 1000).toISOString().slice(0, 10);
    }

    const contentHtml =
      sliceBetween(html, /<div[^>]*id="js_content"[^>]*>/, /<\/div>\s*(?:<script|<div[^>]*id="js_tags")/) ||
      sliceBetween(html, /<div[^>]*id="js_content"[^>]*>/, /<\/div>/) ||
      sliceBetween(html, /<div[^>]*class="rich_media_content"[^>]*>/, /<\/div>\s*<script/);

    const content = contentHtml ? htmlToText(contentHtml) : "";

    if (!content || content.length < 20) {
      res.status(422).json({
        error: "未能解析到正文（可能是图片/视频类推送或页面结构特殊），请尝试粘贴正文。",
        title: clean(title),
        account: clean(account),
      });
      return;
    }

    const payload = {
      title: clean(title),
      account: clean(account),
      publishDate,
      url: finalUrl,
      content,
    };

    // Cache clean content for a day.
    if (mpKey) await kvSet(`art:${mpKey}`, payload, 86400);

    res.status(200).json(payload);
  } catch (err) {
    res.status(500).json({ error: err?.message || "抓取失败" });
  }
}

// Sogou /link pages assemble the real URL in JS via repeated `url += '...'`.
async function resolveSogouLink(linkUrl) {
  try {
    const cookie = await sogouCookie();
    const { html, finalUrl } = await fetchHtml(linkUrl, {
      Referer: "https://weixin.sogou.com/",
      Cookie: cookie,
    });
    // If it already redirected straight to mp, use that.
    if (/mp\.weixin\.qq\.com/.test(finalUrl)) return finalUrl;

    const parts = [...html.matchAll(/url\s*\+=\s*'([^']*)'/g)].map((m) => m[1]);
    if (parts.length) {
      let url = parts.join("").replace(/@/g, "");
      url = url.replace(/&amp;/g, "&");
      if (/^https?:\/\//.test(url)) return url;
    }
    // Fallback: a plain mp link embedded somewhere in the page.
    const m = html.match(/https?:\/\/mp\.weixin\.qq\.com\/s[^"'\\<>\s]+/);
    if (m) return m[0].replace(/&amp;/g, "&");
    return "";
  } catch {
    return "";
  }
}

function canonicalKey(url) {
  const m = url.match(/mp\.weixin\.qq\.com\/s[\/?]([^#]*)/);
  if (!m) return "";
  // Use src/mid/idx/sn params as a stable identity when present.
  const sn = url.match(/[?&]sn=([0-9a-f]+)/i);
  if (sn) return sn[1];
  return encodeURIComponent(m[1]).slice(0, 120);
}

function isBlocked(html) {
  if (!html) return false;
  return /请输入验证码|antispider|环境异常|访问过于频繁/.test(html) && !/js_content/.test(html);
}

function pick(html, re) {
  const m = html.match(re);
  return m ? clean(m[1]) : "";
}

function clean(s) {
  return decodeEntities((s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).trim();
}

function sliceBetween(html, startRe, endRe) {
  const startM = html.match(startRe);
  if (!startM) return "";
  const startIdx = startM.index + startM[0].length;
  const rest = html.slice(startIdx);
  const endM = rest.match(endRe);
  const endIdx = endM ? endM.index : rest.length;
  return rest.slice(0, endIdx);
}
