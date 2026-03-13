const STORAGE_KEY = "wechat_digest_articles";

const articleForm = document.getElementById("article-form");
const articleList = document.getElementById("article-list");
const template = document.getElementById("article-item-template");
const summaryOutput = document.getElementById("summary-output");

const keywordInput = document.getElementById("keyword");
const filterDateInput = document.getElementById("filter-date");
const filterAccountInput = document.getElementById("filter-account");
const clearFiltersBtn = document.getElementById("clear-filters");
const summarizeBtn = document.getElementById("summarize-btn");
const promptInput = document.getElementById("prompt");

let articles = loadArticles();
renderArticles();

articleForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const article = {
    id: crypto.randomUUID(),
    account: document.getElementById("account").value.trim(),
    publishDate: document.getElementById("publish-date").value,
    title: document.getElementById("title").value.trim(),
    url: document.getElementById("url").value.trim(),
    content: document.getElementById("content").value.trim(),
    createdAt: new Date().toISOString()
  };

  if (!article.account || !article.publishDate || !article.title || !article.content) {
    return;
  }

  articles.unshift(article);
  persistArticles();
  articleForm.reset();
  renderArticles();
  summaryOutput.textContent = "文章已保存，请在文章库选择目标文章后生成总结。";
});

[keywordInput, filterDateInput, filterAccountInput].forEach((el) => {
  el.addEventListener("input", renderArticles);
});

clearFiltersBtn.addEventListener("click", () => {
  keywordInput.value = "";
  filterDateInput.value = "";
  filterAccountInput.value = "";
  renderArticles();
});

summarizeBtn.addEventListener("click", () => {
  const selectedId = getSelectedArticleId();
  if (!selectedId) {
    summaryOutput.textContent = "请先在文章库中选择一篇文章。";
    return;
  }

  const article = articles.find((item) => item.id === selectedId);
  if (!article) {
    summaryOutput.textContent = "未找到所选文章。";
    return;
  }

  const prompt = promptInput.value.trim() || "请总结这篇文章的核心观点。";
  summaryOutput.textContent = summarizeText(article, prompt);
});

function loadArticles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistArticles() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(articles));
}

function getFilteredArticles() {
  const keyword = keywordInput.value.trim().toLowerCase();
  const date = filterDateInput.value;
  const account = filterAccountInput.value.trim().toLowerCase();

  return articles.filter((article) => {
    const matchKeyword =
      !keyword ||
      article.title.toLowerCase().includes(keyword) ||
      article.content.toLowerCase().includes(keyword);
    const matchDate = !date || article.publishDate === date;
    const matchAccount = !account || article.account.toLowerCase().includes(account);
    return matchKeyword && matchDate && matchAccount;
  });
}

function renderArticles() {
  articleList.innerHTML = "";
  const filtered = getFilteredArticles();

  if (!filtered.length) {
    articleList.innerHTML = "<li>暂无符合条件的文章。</li>";
    return;
  }

  filtered.forEach((article, index) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const radio = node.querySelector("input[type='radio']");
    radio.value = article.id;
    radio.checked = index === 0;

    node.querySelector(".meta").textContent = `${article.account} · ${article.publishDate}`;
    node.querySelector(".title").textContent = article.title;
    node.querySelector(".preview").textContent = `${article.content.slice(0, 90)}...`;

    const url = node.querySelector(".url");
    if (article.url) {
      url.href = article.url;
    } else {
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
  const selected = document.querySelector("input[name='selected-article']:checked");
  return selected ? selected.value : null;
}

function summarizeText(article, prompt) {
  const normalized = article.content
    .replace(/\s+/g, " ")
    .replace(/。/g, "。\n")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!normalized.length) {
    return "文章内容为空，无法生成总结。";
  }

  const topSentences = pickTopSentences(normalized, 3);
  return [
    `指令：${prompt}`,
    `文章：《${article.title}》`,
    "",
    "总结：",
    ...topSentences.map((sentence, i) => `${i + 1}. ${sentence}`),
    "",
    "（说明：当前为本地摘要算法结果，可继续对接大模型 API 以获得更强语义理解能力。）"
  ].join("\n");
}

function pickTopSentences(sentences, count) {
  const frequency = new Map();
  sentences.forEach((sentence) => {
    sentence
      .replace(/[，。！？、“”‘’；：,.!?;:()（）]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1)
      .forEach((word) => {
        frequency.set(word, (frequency.get(word) || 0) + 1);
      });
  });

  const scored = sentences.map((sentence, idx) => {
    const score = sentence
      .replace(/[，。！？、“”‘’；：,.!?;:()（）]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1)
      .reduce((sum, word) => sum + (frequency.get(word) || 0), 0);

    return { sentence, idx, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .sort((a, b) => a.idx - b.idx)
    .map((item) => item.sentence);
}
