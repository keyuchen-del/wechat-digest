import {
  fetchHtmlRetry,
  sogouCookie,
  decodeEntities,
  kvGet,
  kvSet,
  handlePreflight,
  setCors,
} from "./_lib.js";

// Search recent WeChat articles by account name via Sogou WeChat search.
// GET /api/search?account=xxx[&fresh=1]
export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  const account = (req.query?.account || "").toString().trim();
  if (!account) {
    res.status(400).json({ error: "缺少 account 参数" });
    return;
  }
  const skipCache = req.query?.fresh === "1";
  const cacheKey = `search:${account.toLowerCase()}`;

  // Serve from cache to avoid hammering Sogou (lowers anti-spider triggers).
  if (!skipCache) {
    const cached = await kvGet(cacheKey);
    if (cached && Array.isArray(cached.articles)) {
      res.status(200).json({ ...cached, account, cached: true });
      return;
    }
  }

  const searchUrl = `https://weixin.sogou.com/weixin?type=2&ie=utf8&query=${encodeURIComponent(
    account
  )}`;

  try {
    const cookie = await sogouCookie();
    const result = await fetchHtmlRetry(
      searchUrl,
      { Referer: "https://weixin.sogou.com/", Cookie: cookie },
      { tries: 3, shouldRetry: (r) => isBlocked(r.html) }
    );

    const html = result?.html || "";

    if (isBlocked(html)) {
      res.status(429).json({
        error:
          "搜狗微信触发了反爬验证（访问过于频繁或需要验证码）。已自动重试仍失败，请稍后再试，或改用「粘贴文章链接」抓取单篇。",
        blocked: true,
      });
      return;
    }

    if (!result?.ok) {
      res.status(result?.status || 502).json({
        error: `搜狗返回 ${result?.status || "无响应"}，请稍后重试`,
      });
      return;
    }

    const items = parseArticles(html);
    const payload = { account, count: items.length, articles: items };

    // Cache successful non-empty results for 10 minutes.
    if (items.length) await kvSet(cacheKey, payload, 600);

    res.status(200).json(payload);
  } catch (err) {
    res.status(500).json({ error: err?.message || "搜索失败" });
  }
}

function isBlocked(html) {
  if (!html) return false;
  return (
    /请输入验证码|antispider|访问过于频繁|系统检测到您网络中存在异常|请输入下方验证码/.test(
      html
    ) && !/news-list/.test(html)
  );
}

function parseArticles(html) {
  const results = [];
  const blocks = html.split(/<li[\s>]/).slice(1);
  for (const block of blocks) {
    const linkM = block.match(/<h3>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkM) continue;

    let href = decodeEntities(linkM[1]).replace(/&amp;/g, "&");
    if (href.startsWith("/")) href = "https://weixin.sogou.com" + href;

    const title = decodeEntities(stripTags(linkM[2]));
    if (!title) continue;

    const summaryM = block.match(/<p class="txt-info"[^>]*>([\s\S]*?)<\/p>/);
    const summary = summaryM ? decodeEntities(stripTags(summaryM[1])) : "";

    const accountM = block.match(/class="account"[^>]*>([\s\S]*?)<\/a>/);
    const accountName = accountM ? decodeEntities(stripTags(accountM[1])) : "";

    const tsM = block.match(/<div class="s-p"[^>]*\bt="(\d+)"/);
    const publishDate = tsM
      ? new Date(parseInt(tsM[1], 10) * 1000).toISOString().slice(0, 10)
      : "";

    results.push({
      title,
      summary,
      account: accountName,
      publishDate,
      sogouLink: href,
    });
  }
  return results;
}

function stripTags(s) {
  return (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
