const STORAGE_KEY = "wechat_digest_articles";
const READER_PREFIX = "https://r.jina.ai/http://";
const FETCH_TIMEOUT_MS = 10000;

const articleList = document.getElementById("article-list");
const template = document.getElementById("article-item-template");
const summaryOutput = document.getElementById("summary-output");
const fetchStatus = document.getElementById("fetch-status");

const keywordInput = document.getElementById("keyword");
const filterDateInput = document.getElementById("filter-date");
const filterAccountInput = document.getElementById("filter-account");
const clearFiltersBtn = document.getElementById("clear-filters");
const summarizeBtn = document.getElementById("summarize-btn");
const promptInput = document.getElementById("prompt");

const articleUrlInput = document.getElementById("article-url-input");
const accountNameInput = document.getElementById("account-name-input");
const fetchArticleBtn = document.getElementById("fetch-article-btn");
const fetchAccountBtn = document.getElementById("fetch-account-btn");

let articles = loadArticles();
renderArticles();

fetchArticleBtn.addEventListener("click", async () => {
  const url = articleUrlInput.value.trim();
  if (!url) return setFetchStatus("请先输入文章地址。", true);

  toggleFetchButtons(true);
  setFetchStatus("正在抓取文章（提速模式）...");
  try {
    const article = await fetchAndParseArticle(url);
    saveArticle(article);
    articleUrlInput.value = "";
    setFetchStatus(`抓取成功：${article.title}`);
  } catch (error) {
    setFetchStatus(`抓取失败：${error.message}`, true);
  } finally {
    toggleFetchButtons(false);
  }
});

fetchAccountBtn.addEventListener("click", async () => {
  const account = accountNameInput.value.trim();
  if (!account) return setFetchStatus("请先输入公众号名称。", true);

  toggleFetchButtons(true);
  setFetchStatus("正在检索并并发抓取最近文章...");
  try {
    const foundUrls = await fetchArticleLinksByAccount(account);
    if (!foundUrls.length) throw new Error("未检索到文章链接，请改用文章地址抓取。");

    const targets = foundUrls.slice(0, 5);
    const results = await Promise.allSettled(targets.map((url) => fetchAndParseArticle(url, account)));
    const successArticles = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((item) => !articles.some((a) => a.url === item.url));

    if (!successArticles.length) {
      throw new Error("检索到链接但抓取失败率高，建议改用单篇链接抓取。");
    }

    articles = [...successArticles, ...articles];
    persistArticles();
    renderArticles();
    accountNameInput.value = "";
    setFetchStatus(`已自动整理 ${successArticles.length}/${targets.length} 篇文章。`);
  } catch (error) {
    setFetchStatus(`公众号抓取失败：${error.message}`, true);
  } finally {
    toggleFetchButtons(false);
  }
});

[keywordInput, filterDateInput, filterAccountInput].forEach((el) => el.addEventListener("input", renderArticles));
clearFiltersBtn.addEventListener("click", () => {
  keywordInput.value = "";
  filterDateInput.value = "";
  filterAccountInput.value = "";
  renderArticles();
});

summarizeBtn.addEventListener("click", () => {
  const selectedId = getSelectedArticleId();
  if (!selectedId) return (summaryOutput.textContent = "请先在文章库中选择一篇文章。");

  const article = articles.find((item) => item.id === selectedId);
  if (!article) return (summaryOutput.textContent = "未找到所选文章。");

  const prompt = promptInput.value.trim() || "请总结这篇文章的核心观点。";
  summaryOutput.textContent = summarizeText(article, prompt);
});

function toggleFetchButtons(disabled) {
  fetchArticleBtn.disabled = disabled;
  fetchAccountBtn.disabled = disabled;
}

function setFetchStatus(message, isError = false) {
  fetchStatus.textContent = message;
  fetchStatus.style.borderColor = isError ? "#dc2626" : "#e6ebf2";
  fetchStatus.style.color = isError ? "#b91c1c" : "#0f172a";
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`网络请求失败（${resp.status}）`);
    return await resp.text();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAndParseArticle(url, accountHint = "") {
  const normalizedUrl = normalizeUrl(url);
  const readerUrl = `${READER_PREFIX}${normalizedUrl}`;

  let text = "";
  try {
    text = await fetchWithTimeout(readerUrl);
  } catch {
    text = await fetchWithTimeout(normalizedUrl);
  }

  const title = extractTitle(text) || `未命名文章 ${new Date().toLocaleTimeString()}`;
  const content = extractContent(text);
  if (!content) throw new Error("无法解析正文");

  return {
    id: crypto.randomUUID(),
    account: accountHint || extractAccount(text) || "未知公众号",
    publishDate: extractDate(text) || new Date().toISOString().slice(0, 10),
    title,
    url: normalizedUrl,
    content,
    createdAt: new Date().toISOString()
  };
}

async function fetchArticleLinksByAccount(accountName) {
  const query = encodeURIComponent(accountName);
  const searchUrl = `${READER_PREFIX}https://weixin.sogou.com/weixin?type=2&query=${query}`;
  const text = await fetchWithTimeout(searchUrl);
  const links = [...text.matchAll(/https?:\/\/mp\.weixin\.qq\.com\/s\?[^\s)]+/g)].map((m) => m[0]);
  return Array.from(new Set(links));
}

function normalizeUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("请输入完整文章地址（需含 http/https）");
  return url;
}

function extractTitle(text) {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim() || text.match(/(?:标题|Title)[:：]\s*(.+)/i)?.[1]?.trim() || "";
}
function extractAccount(text) {
  return text.match(/(?:公众号|作者|Account)[:：]\s*([^\n]+)/i)?.[1]?.trim() || "";
}
function extractDate(text) {
  const match = text.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})/);
  return match ? match[1].replace(/[年/.]/g, "-").replace("月", "-").replace("日", "") : "";
}
function extractContent(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("http") && !line.startsWith("```"));
  return lines.slice(2).join("\n").slice(0, 12000).trim();
}

function saveArticle(article) {
  if (articles.some((item) => item.url === article.url)) return setFetchStatus("该文章已存在，未重复入库。");
  articles.unshift(article);
  persistArticles();
  renderArticles();
  summaryOutput.textContent = "已自动整理文章，请在文章库选择目标文章后生成总结。";
}

function loadArticles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function persistArticles() { localStorage.setItem(STORAGE_KEY, JSON.stringify(articles)); }

function getFilteredArticles() {
  const keyword = keywordInput.value.trim().toLowerCase();
  const date = filterDateInput.value;
  const account = filterAccountInput.value.trim().toLowerCase();
  return articles.filter((article) => {
    const matchKeyword = !keyword || article.title.toLowerCase().includes(keyword) || article.content.toLowerCase().includes(keyword);
    const matchDate = !date || article.publishDate === date;
    const matchAccount = !account || article.account.toLowerCase().includes(account);
    return matchKeyword && matchDate && matchAccount;
  });
}

function renderArticles() {
  articleList.innerHTML = "";
  const filtered = getFilteredArticles();
  if (!filtered.length) return (articleList.innerHTML = "<li>暂无符合条件的文章。</li>");

  filtered.forEach((article, index) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const radio = node.querySelector("input[type='radio']");
    radio.value = article.id;
    radio.checked = index === 0;
    node.querySelector(".meta").textContent = `${article.account} · ${article.publishDate}`;
    node.querySelector(".title").textContent = article.title;
    node.querySelector(".preview").textContent = `${article.content.slice(0, 90)}...`;

    const url = node.querySelector(".url");
    if (article.url) url.href = article.url;
    else {
      url.textContent = "无原文链接";
      url.removeAttribute("href");
      url.style.pointerEvents = "none";
    }

    node.querySelector(".delete-btn").addEventListener("click", () => {
      articles = articles.filter((item) => item.id !== article.id);
      persistArticles();
      renderArticles();
      summaryOutput.textContent = "已删除文章。";
    });
    articleList.appendChild(node);
  });
}

function getSelectedArticleId() {
  return document.querySelector("input[name='selected-article']:checked")?.value || null;
}

function summarizeText(article, prompt) {
  const normalized = article.content.replace(/\s+/g, " ").replace(/。/g, "。\n").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!normalized.length) return "文章内容为空，无法生成总结。";
  const topSentences = pickTopSentences(normalized, 3);
  return [`指令：${prompt}`, `文章：《${article.title}》`, "", "总结：", ...topSentences.map((s, i) => `${i + 1}. ${s}`), "", "（说明：当前为本地摘要算法结果，可继续对接大模型 API。）"].join("\n");
}

function pickTopSentences(sentences, count) {
  const frequency = new Map();
  sentences.forEach((sentence) => {
    sentence.replace(/[，。！？、“”‘’；：,.!?;:()（）]/g, " ").split(/\s+/).filter((word) => word.length > 1).forEach((word) => {
      frequency.set(word, (frequency.get(word) || 0) + 1);
    });
  });

  return sentences
    .map((sentence, idx) => ({
      sentence,
      idx,
      score: sentence
        .replace(/[，。！？、“”‘’；：,.!?;:()（）]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 1)
        .reduce((sum, word) => sum + (frequency.get(word) || 0), 0)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .sort((a, b) => a.idx - b.idx)
    .map((item) => item.sentence);
}
