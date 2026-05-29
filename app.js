/* ════════════════════════════════════════════════════════
   墨摘 WeChat Digest · 抓取 + AI 分析 + 匿名工作区码云同步
   ════════════════════════════════════════════════════════ */

/* ★★★ 部署后端后，把你的 Deno Deploy 地址填到这里（结尾不要加斜杠）★★★
   例如：const BACKEND_BASE = "https://wechat-digest.deno.dev";
   留空时会回退到「设置 → 后端 API 地址」，或同源 /api（本地 deno 调试）。 */
const BACKEND_BASE = "";

const WS_KEY = "wcd_ws";
const SETTINGS_KEY = "wcd_settings_v2";
const artKey = (code) => `wcd_art_${code}`;
const metaKey = (code) => `wcd_meta_${code}`;

const PROVIDERS = {
  openai: { label: "OpenAI", models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"], note: "需国外网络访问" },
  deepseek: { label: "DeepSeek", models: ["deepseek-chat", "deepseek-reasoner"], note: "国内可直连，性价比高" },
  dashscope: { label: "通义千问", models: ["qwen-plus", "qwen-turbo", "qwen-max"], note: "阿里云百炼控制台获取" },
};

const SYS_PROMPT =
  "你是一名资深的中文内容分析师，擅长从公众号文章中快速提炼结构化要点。输出必须为简洁、信息密度高的 Markdown。";

/* ── State ── */

let wsCode = resolveWsCode();
let settings = loadSettings();
let articles = loadArticlesLocal(wsCode);
let activeId = null;
let crawlResults = [];
let cloudMode = "unknown"; // unknown | cloud | local
let localUpdatedAt = loadMetaLocal(wsCode);
let syncTimer = null;

/* ── DOM ── */

const $ = (id) => document.getElementById(id);
const articleListEl = $("article-list");
const detailEmpty = $("detail-empty");
const detailContent = $("detail-content");
const toastEl = $("toast");

/* ── Init ── */

bindEvents();
applySettingsToUI();
renderWsCode();
maybeSeedDemo();
renderAll();
initSync();

// 纯静态 demo 模式（未配置后端）：首次访问自动载入示例，让站点开箱即有内容。
// 配置了真实后端后不再自动播种，交给云同步。
function maybeSeedDemo() {
  if (backendConfigured()) return;
  if (localStorage.getItem("wcd_seeded")) return;
  if (articles.length) return;
  articles = demoArticles();
  saveArticlesLocal();
  localStorage.setItem("wcd_seeded", "1");
}

/* ════════════════ Workspace code ════════════════ */

function resolveWsCode() {
  const fromHash = (location.hash.match(/ws=([a-z0-9-]+)/i) || [])[1];
  if (fromHash && isValidCode(fromHash)) {
    localStorage.setItem(WS_KEY, fromHash.toLowerCase());
    return fromHash.toLowerCase();
  }
  const stored = localStorage.getItem(WS_KEY);
  if (stored && isValidCode(stored)) {
    syncHash(stored);
    return stored;
  }
  const fresh = genCode();
  localStorage.setItem(WS_KEY, fresh);
  syncHash(fresh);
  return fresh;
}

function isValidCode(c) {
  return /^[a-z0-9]{4,8}(-[a-z0-9]{4,8}){1,5}$/i.test((c || "").trim());
}

function genCode() {
  const buf = new Uint8Array(9);
  crypto.getRandomValues(buf);
  const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function syncHash(code) {
  const url = `${location.pathname}${location.search}#ws=${code}`;
  history.replaceState(null, "", url);
}

function renderWsCode() {
  $("ws-code-label").textContent = wsCode;
  const cur = $("switch-current");
  if (cur) cur.textContent = wsCode;
}

/* ════════════════ Cloud sync ════════════════ */

async function initSync() {
  if (!backendConfigured()) {
    cloudMode = "local";
    setSync("local", "未配置后端");
    return;
  }
  setSync("syncing", "同步中…");
  try {
    const res = await fetch(apiUrl(`/api/data?ws=${encodeURIComponent(wsCode)}`));
    if (res.status === 501) {
      cloudMode = "local";
      setSync("local", "本地模式");
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    cloudMode = "cloud";

    const merged = mergeArticles(articles, data.articles || []);
    const changed = merged.length !== articles.length || JSON.stringify(merged) !== JSON.stringify(articles);
    articles = merged;
    saveArticlesLocal();
    renderAll();

    // If local had items the cloud lacked, push the merge back up.
    if (changed && (data.articles || []).length !== merged.length) {
      await pushCloud();
    } else {
      setSync("ok", "已同步");
    }
  } catch (err) {
    cloudMode = cloudMode === "cloud" ? "cloud" : "local";
    setSync("err", "离线（仅本地）");
  }
}

function mergeArticles(localArr, cloudArr) {
  const map = new Map();
  const keyOf = (a) => a.id || `${a.account}::${a.title}`;
  for (const a of cloudArr) map.set(keyOf(a), a);
  for (const a of localArr) {
    const k = keyOf(a);
    const existing = map.get(k);
    if (!existing) {
      map.set(k, a);
    } else {
      // Prefer the one that's analyzed / more recently touched.
      const score = (x) => (x.summary ? 2 : 0) + (x.analyzedAt ? 1 : 0);
      if (score(a) >= score(existing)) map.set(k, a);
    }
  }
  return [...map.values()].sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );
}

function scheduleSync() {
  saveArticlesLocal();
  if (cloudMode !== "cloud") return;
  setSync("syncing", "同步中…");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushCloud, 1100);
}

async function pushCloud() {
  if (cloudMode !== "cloud") return;
  try {
    const res = await fetch(apiUrl(`/api/data?ws=${encodeURIComponent(wsCode)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articles }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    localUpdatedAt = data.updatedAt || new Date().toISOString();
    saveMetaLocal();
    setSync("ok", "已同步");
  } catch (err) {
    setSync("err", "同步失败");
  }
}

function setSync(state, text) {
  const pill = $("sync-status");
  pill.className = "sync-pill " + state;
  $("sync-text").textContent = text;
}

async function loadWorkspace(code) {
  wsCode = code;
  localStorage.setItem(WS_KEY, code);
  syncHash(code);
  activeId = null;
  articles = loadArticlesLocal(code);
  localUpdatedAt = loadMetaLocal(code);
  renderWsCode();
  renderAll();
  await initSync();
}

/* ════════════════ Events ════════════════ */

function bindEvents() {
  $("hero-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("hero-account").value.trim();
    if (!v) return;
    $("account-input").value = v;
    $("workspace").scrollIntoView({ behavior: "smooth" });
    crawl(v);
  });

  $("crawl-btn").addEventListener("click", () => crawl($("account-input").value.trim()));
  $("account-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") crawl($("account-input").value.trim());
  });

  $("parse-link-btn").addEventListener("click", () => parseLink($("link-input").value.trim()));
  $("link-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") parseLink($("link-input").value.trim());
  });

  [$("keyword"), $("filter-account"), $("filter-date")].forEach((el) =>
    el.addEventListener("input", renderList)
  );
  $("clear-filters").addEventListener("click", () => {
    $("keyword").value = "";
    $("filter-account").value = "";
    $("filter-date").value = "";
    renderList();
  });

  $("analyze-all-btn").addEventListener("click", analyzeAll);
  $("add-article-btn").addEventListener("click", () => openModal("add-modal"));
  $("open-settings").addEventListener("click", openSettings);
  $("load-demo-empty").addEventListener("click", loadDemo);

  // workspace code controls
  $("copy-code-btn").addEventListener("click", copyCode);
  $("switch-ws-btn").addEventListener("click", () => {
    $("switch-code-input").value = "";
    renderWsCode();
    openModal("switch-modal");
  });
  $("copy-code-btn2").addEventListener("click", copyCode);
  $("switch-confirm-btn").addEventListener("click", confirmSwitch);
  $("new-ws-btn").addEventListener("click", newWorkspace);

  // generic close
  document.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", () => closeAllModals())
  );
  document.querySelectorAll(".modal-overlay").forEach((ov) =>
    ov.addEventListener("click", (e) => {
      if (e.target === ov) closeAllModals();
    })
  );

  // results modal
  $("results-select-all").addEventListener("change", (e) => {
    document.querySelectorAll(".result-check").forEach((c) => (c.checked = e.target.checked));
  });
  $("import-selected-btn").addEventListener("click", importSelected);

  // settings
  $("provider-tabs").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => selectProviderTab(b.dataset.provider))
  );
  $("save-settings").addEventListener("click", saveSettingsFromUI);
  $("load-demo-btn").addEventListener("click", loadDemo);
  $("import-json-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", importJson);
  $("clear-all-btn").addEventListener("click", clearAll);

  $("article-form").addEventListener("submit", addArticle);
}

function copyCode() {
  navigator.clipboard?.writeText(wsCode).then(
    () => toast("工作区码已复制，妥善保存即可换设备同步"),
    () => toast("复制失败，请手动选择复制", true)
  );
}

async function confirmSwitch() {
  const code = $("switch-code-input").value.trim().toLowerCase();
  if (!isValidCode(code)) {
    toast("工作区码格式不正确", true);
    return;
  }
  if (code === wsCode) {
    toast("已在该工作区");
    closeAllModals();
    return;
  }
  closeAllModals();
  await loadWorkspace(code);
  toast("已切换工作区");
}

async function newWorkspace() {
  closeAllModals();
  await loadWorkspace(genCode());
  toast("已新建空白工作区，记得复制保存新码");
}

/* ════════════════ Crawl ════════════════ */

async function crawl(account) {
  if (!account) {
    toast("请输入公众号名称", true);
    return;
  }
  if (!backendConfigured()) {
    toast("自动抓取需要后端：请在「设置 → 后端 API 地址」填入你的 Deno Deploy 地址", true);
    openSettings();
    return;
  }
  const btn = $("crawl-btn");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "抓取中…";
  try {
    const res = await fetch(apiUrl(`/api/search?account=${encodeURIComponent(account)}`));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    crawlResults = data.articles || [];
    openResults(account, crawlResults);
  } catch (err) {
    toast(`抓取失败：${err.message}（确认后端 /api 已部署，或在设置中填写后端地址）`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function openResults(account, list) {
  $("results-account").textContent = account;
  $("results-select-all").checked = false;
  const ul = $("results-list");
  ul.innerHTML = "";
  if (!list.length) {
    ul.innerHTML =
      '<li class="results-empty">未找到文章。可能是名称不精确，或搜狗暂时限制了访问。可改用「粘贴文章链接」。</li>';
  } else {
    const tpl = $("tpl-result-item");
    list.forEach((item, i) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      const check = node.querySelector(".result-check");
      check.value = i;
      node.querySelector(".result-meta").textContent =
        `${item.account || "未知"} · ${item.publishDate || "日期未知"}`;
      node.querySelector(".result-title").textContent = item.title;
      node.querySelector(".result-summary").textContent = item.summary || "";
      ul.appendChild(node);
    });
  }
  openModal("results-modal");
}

async function importSelected() {
  const checked = [...document.querySelectorAll(".result-check:checked")];
  if (!checked.length) {
    toast("请先勾选要导入的文章", true);
    return;
  }
  const autoAnalyze = $("results-auto-analyze").checked;
  const btn = $("import-selected-btn");
  btn.disabled = true;

  const picked = checked.map((c) => crawlResults[+c.value]);
  closeAllModals();
  let imported = 0;
  const added = [];

  for (let i = 0; i < picked.length; i++) {
    const item = picked[i];
    btn.textContent = `导入中 ${i + 1}/${picked.length}`;
    toast(`正在解析正文 ${i + 1}/${picked.length}…`);
    try {
      const res = await fetch(apiUrl(`/api/article?url=${encodeURIComponent(item.sogouLink)}`));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.content) throw new Error(data.error || "解析失败");
      const article = makeArticle({
        account: data.account || item.account || "未知公众号",
        publishDate: data.publishDate || item.publishDate || today(),
        title: data.title || item.title,
        url: data.url || "",
        content: data.content,
      });
      articles.unshift(article);
      added.push(article);
      imported++;
    } catch (err) {
      toast(`「${item.title.slice(0, 12)}…」导入失败：${err.message}`, true);
    }
  }

  scheduleSync();
  renderAll();
  btn.disabled = false;
  btn.textContent = "导入选中";
  if (imported) {
    toast(`成功导入 ${imported} 篇`);
    selectArticle(added[0].id);
    if (autoAnalyze && hasKey()) {
      for (const a of added) await streamAnalyze(a, "", a.id === activeId ? $("analysis-out") : null);
      toast("全部分析完成");
    } else if (autoAnalyze && !hasKey()) {
      toast("已导入，但未配置 API Key，跳过自动分析", true);
    }
  }
}

async function parseLink(url) {
  if (!url) {
    toast("请输入文章链接", true);
    return;
  }
  if (!backendConfigured()) {
    toast("解析链接需要后端：请在「设置 → 后端 API 地址」填入你的 Deno Deploy 地址", true);
    openSettings();
    return;
  }
  const btn = $("parse-link-btn");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "解析中…";
  try {
    const res = await fetch(apiUrl(`/api/article?url=${encodeURIComponent(url)}`));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.content) throw new Error(data.error || `HTTP ${res.status}`);
    const article = makeArticle({
      account: data.account || "未知公众号",
      publishDate: data.publishDate || today(),
      title: data.title || "未命名文章",
      url: data.url || url,
      content: data.content,
    });
    articles.unshift(article);
    scheduleSync();
    renderAll();
    selectArticle(article.id);
    $("link-input").value = "";
    toast("解析成功");
  } catch (err) {
    toast(`解析失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ════════════════ AI Analysis ════════════════ */

function buildUserMsg(article, instruction) {
  return (
    `【文章标题】${article.title}\n【公众号】${article.account || "未知"}\n【发布日期】${article.publishDate || "未知"}\n\n` +
    `【正文】\n${article.content}\n\n---\n` +
    `请按以下结构输出分析，每个小标题用「## 」开头，要点用「- 」列表：\n` +
    `## 一句话总结\n## 核心观点\n## 关键数据 / 事实\n## 关键词标签\n## 价值与适用人群\n\n` +
    `补充指令：${instruction || "无"}`
  );
}

async function streamAnalyze(article, instruction, outEl) {
  const cfg = PROVIDERS[settings.provider];
  const key = settings.keys[settings.provider];
  if (!backendConfigured()) {
    toast("AI 分析需要后端代理：请在「设置 → 后端 API 地址」填入你的 Deno Deploy 地址", true);
    openSettings();
    return false;
  }
  if (!key) {
    toast(`请先在设置中配置 ${cfg.label} 的 API Key`, true);
    openSettings();
    return false;
  }

  if (outEl) outEl.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';
  let result = "";

  try {
    const res = await fetch(apiUrl("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: settings.provider,
        model: settings.model,
        key,
        messages: [
          { role: "system", content: SYS_PROMPT },
          { role: "user", content: buildUserMsg(article, instruction) },
        ],
      }),
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const d = t.slice(5).trim();
        if (d === "[DONE]") continue;
        try {
          const delta = JSON.parse(d).choices?.[0]?.delta?.content;
          if (delta) {
            result += delta;
            if (outEl) {
              outEl.innerHTML = formatMarkdown(result) + '<span class="typing-cursor"></span>';
            }
          }
        } catch {}
      }
    }

    if (!result.trim()) throw new Error("模型未返回内容");
    article.summary = result;
    article.analyzedAt = new Date().toISOString();
    scheduleSync();
    if (outEl) outEl.innerHTML = formatMarkdown(result);
    renderList();
    updateStats();
    return true;
  } catch (err) {
    if (outEl) outEl.innerHTML = `<div class="err">分析失败：${esc(err.message)}</div>`;
    toast(`分析失败：${err.message}`, true);
    return false;
  }
}

async function analyzeAll() {
  if (!hasKey()) {
    toast("请先在设置中配置 API Key", true);
    openSettings();
    return;
  }
  const pending = articles.filter((a) => !a.summary);
  if (!pending.length) {
    toast("没有待分析的文章");
    return;
  }
  const btn = $("analyze-all-btn");
  btn.disabled = true;
  for (let i = 0; i < pending.length; i++) {
    btn.textContent = `分析中 ${i + 1}/${pending.length}`;
    const a = pending[i];
    await streamAnalyze(a, "", a.id === activeId ? $("analysis-out") : null);
  }
  btn.disabled = false;
  btn.textContent = "⚡ 一键分析未分析";
  toast(`完成 ${pending.length} 篇分析`);
}

/* ════════════════ Render ════════════════ */

function renderAll() {
  renderList();
  updateStats();
  updateProviderChip();
  if (activeId && articles.find((a) => a.id === activeId)) renderDetail(byId(activeId));
  else showEmpty();
}

function updateStats() {
  const analyzed = articles.filter((a) => a.summary).length;
  $("stat-articles").textContent = articles.length;
  $("stat-analyzed").textContent = analyzed;
  $("article-count").textContent = articles.length;
  $("analyzed-count").textContent = analyzed;
}

function getFiltered() {
  const kw = $("keyword").value.trim().toLowerCase();
  const acc = $("filter-account").value.trim().toLowerCase();
  const date = $("filter-date").value;
  return articles.filter((a) => {
    const mk = !kw || a.title.toLowerCase().includes(kw) || a.content.toLowerCase().includes(kw);
    const ma = !acc || (a.account || "").toLowerCase().includes(acc);
    const md = !date || a.publishDate === date;
    return mk && ma && md;
  });
}

function renderList() {
  const filtered = getFiltered();
  articleListEl.innerHTML = "";
  if (!filtered.length) {
    articleListEl.innerHTML = `<li class="list-empty">${
      articles.length ? "没有符合条件的文章" : "本工作区暂无文章<br/>在上方抓取，或加载示例数据"
    }</li>`;
    return;
  }
  const tpl = $("tpl-article-item");
  filtered.forEach((a, i) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.style.animationDelay = `${i * 0.03}s`;
    if (a.id === activeId) node.classList.add("active");
    node.querySelector(".ai-meta").textContent = `${a.account || "未知"} · ${a.publishDate || ""}`;
    const badge = node.querySelector(".ai-badge");
    badge.textContent = a.summary ? "已分析" : "待分析";
    badge.classList.add(a.summary ? "done" : "todo");
    node.querySelector(".ai-title").textContent = a.title;
    node.querySelector(".ai-preview").textContent = a.content.slice(0, 80);
    node.addEventListener("click", () => selectArticle(a.id));
    articleListEl.appendChild(node);
  });
}

function selectArticle(id) {
  activeId = id;
  renderList();
  renderDetail(byId(id));
}

function showEmpty() {
  detailEmpty.style.display = "flex";
  detailContent.style.display = "none";
}

function renderDetail(a) {
  if (!a) return showEmpty();
  detailEmpty.style.display = "none";
  detailContent.style.display = "block";
  const analyzed = !!a.summary;

  detailContent.innerHTML = `
    <div class="detail-head">
      <div class="detail-meta">
        <span>${esc(a.account || "未知公众号")}</span><span>·</span><span>${esc(a.publishDate || "")}</span>
        ${a.url ? `<span>·</span><a href="${esc(a.url)}" target="_blank" rel="noopener">查看原文 ↗</a>` : ""}
      </div>
      <div class="detail-title">${esc(a.title)}</div>
      <div class="detail-bar">
        <button class="btn-solid sm" id="d-analyze">${analyzed ? "重新分析" : "AI 分析"}</button>
        <button class="btn-danger" id="d-delete">删除</button>
      </div>
    </div>

    <div class="analysis-block">
      <div class="analysis-label">AI 结构化分析</div>
      <div class="analysis-out" id="analysis-out">${
        analyzed
          ? formatMarkdown(a.summary)
          : '<span class="placeholder">尚未分析。点击「AI 分析」自动生成一句话总结、核心观点、关键数据与标签。</span>'
      }</div>
      <div class="prompt-row">
        <input id="d-prompt" placeholder="自定义分析指令（可选），如：侧重投资视角、提炼可执行清单" />
        <button class="btn-line sm" id="d-gen">生成</button>
      </div>
    </div>

    <div class="analysis-block">
      <div class="analysis-label">原文正文</div>
      <button class="content-toggle" id="d-toggle">展开全文（${a.content.length} 字）</button>
      <div class="content-full" id="d-content" style="display:none">${esc(a.content)}</div>
    </div>
  `;

  const run = () => streamAnalyze(a, $("d-prompt").value.trim(), $("analysis-out"));
  $("d-analyze").addEventListener("click", run);
  $("d-gen").addEventListener("click", run);
  $("d-delete").addEventListener("click", () => deleteArticle(a.id));
  $("d-toggle").addEventListener("click", () => {
    const c = $("d-content");
    const open = c.style.display !== "none";
    c.style.display = open ? "none" : "block";
    $("d-toggle").textContent = open ? `展开全文（${a.content.length} 字）` : "收起正文";
  });
}

function deleteArticle(id) {
  articles = articles.filter((a) => a.id !== id);
  scheduleSync();
  if (activeId === id) {
    activeId = null;
    showEmpty();
  }
  renderList();
  updateStats();
  toast("已删除");
}

/* ════════════════ Settings ════════════════ */

function openSettings() {
  applySettingsToUI();
  openModal("settings-modal");
}

function selectProviderTab(provider) {
  settings.provider = provider;
  $("provider-tabs")
    .querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b.dataset.provider === provider));
  const cfg = PROVIDERS[provider];
  const sel = $("model-select");
  sel.innerHTML = cfg.models.map((m) => `<option value="${m}">${m}</option>`).join("");
  if (cfg.models.includes(settings.model)) sel.value = settings.model;
  else settings.model = cfg.models[0];
  $("api-key").value = settings.keys[provider] || "";
  $("key-note").textContent = `· ${cfg.note}`;
}

function applySettingsToUI() {
  selectProviderTab(settings.provider);
  $("model-select").value = settings.model;
  $("api-base").value = settings.apiBase || "";
}

function saveSettingsFromUI() {
  settings.provider = $("provider-tabs").querySelector("button.active").dataset.provider;
  settings.model = $("model-select").value;
  settings.keys[settings.provider] = $("api-key").value.trim();
  settings.apiBase = $("api-base").value.trim().replace(/\/+$/, "");
  saveSettings();
  updateProviderChip();
  closeAllModals();
  toast("设置已保存");
}

function updateProviderChip() {
  const cfg = PROVIDERS[settings.provider];
  const chip = $("provider-chip");
  if (hasKey()) {
    chip.textContent = `${cfg.label} · ${settings.model}`;
    chip.classList.add("ok");
  } else {
    chip.textContent = `${cfg.label} · 未配置 Key`;
    chip.classList.remove("ok");
  }
}

function hasKey() {
  return !!settings.keys[settings.provider];
}

/* ════════════════ Data ops ════════════════ */

function addArticle(e) {
  e.preventDefault();
  const a = makeArticle({
    account: $("f-account").value.trim(),
    publishDate: $("f-date").value,
    title: $("f-title").value.trim(),
    url: $("f-url").value.trim(),
    content: $("f-content").value.trim(),
  });
  if (!a.account || !a.title || !a.content) return;
  articles.unshift(a);
  scheduleSync();
  e.target.reset();
  closeAllModals();
  renderAll();
  selectArticle(a.id);
  toast("已添加");
}

function loadDemo() {
  const existing = new Set(articles.map((a) => a.title));
  const fresh = demoArticles().filter((d) => !existing.has(d.title));
  if (!fresh.length) {
    toast("示例数据已存在");
    return;
  }
  articles = [...fresh, ...articles];
  scheduleSync();
  closeAllModals();
  renderAll();
  toast(`已加载 ${fresh.length} 篇示例`);
}

function importJson(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      const arr = Array.isArray(data) ? data : [data];
      let n = 0;
      arr.forEach((it) => {
        if (it.title && it.content) {
          articles.unshift(
            makeArticle({
              account: it.account || "未知公众号",
              publishDate: it.publishDate || today(),
              title: it.title,
              url: it.url || "",
              content: it.content,
              summary: it.summary || "",
            })
          );
          n++;
        }
      });
      scheduleSync();
      renderAll();
      toast(`成功导入 ${n} 篇`);
    } catch {
      toast("JSON 格式错误", true);
    }
    e.target.value = "";
  };
  reader.readAsText(file);
}

function clearAll() {
  if (!confirm("确定清空本工作区的全部文章与分析结果？此操作不可恢复。")) return;
  articles = [];
  activeId = null;
  scheduleSync();
  closeAllModals();
  renderAll();
  toast("已清空本工作区");
}

/* ════════════════ Helpers ════════════════ */

function makeArticle(o) {
  return {
    id: crypto.randomUUID(),
    account: o.account || "",
    publishDate: o.publishDate || today(),
    title: o.title || "",
    url: o.url || "",
    content: o.content || "",
    summary: o.summary || "",
    analyzedAt: o.summary ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(),
  };
}

function byId(id) {
  return articles.find((a) => a.id === id);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function apiUrl(path) {
  const base = (settings.apiBase || BACKEND_BASE || "").replace(/\/+$/, "");
  return base + path;
}

function backendConfigured() {
  return !!(settings.apiBase || BACKEND_BASE);
}

function loadArticlesLocal(code) {
  try {
    return JSON.parse(localStorage.getItem(artKey(code))) || [];
  } catch {
    return [];
  }
}
function saveArticlesLocal() {
  localStorage.setItem(artKey(wsCode), JSON.stringify(articles));
}
function loadMetaLocal(code) {
  return localStorage.getItem(metaKey(code)) || null;
}
function saveMetaLocal() {
  if (localUpdatedAt) localStorage.setItem(metaKey(wsCode), localUpdatedAt);
}

function loadSettings() {
  const def = {
    provider: "openai",
    model: "gpt-4o-mini",
    apiBase: "",
    keys: { openai: "", deepseek: "", dashscope: "" },
  };
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return s ? { ...def, ...s, keys: { ...def.keys, ...(s.keys || {}) } } : def;
  } catch {
    return def;
  }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function openModal(id) {
  $(id).style.display = "flex";
}
function closeAllModals() {
  document.querySelectorAll(".modal-overlay").forEach((m) => (m.style.display = "none"));
}

let toastTimer;
function toast(msg, isErr) {
  toastEl.textContent = msg;
  toastEl.classList.toggle("err", !!isErr);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatMarkdown(md) {
  const lines = String(md).split("\n");
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  let html = "";
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,6}\s+/.test(line)) {
      closeList();
      html += `<h2>${inline(line.replace(/^#{1,6}\s+/, ""))}</h2>`;
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`;
    } else if (!line) {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

/* ════════════════ Demo data ════════════════ */

function demoArticles() {
  return [
    {
      id: crypto.randomUUID(),
      account: "晚点LatePost",
      publishDate: "2025-03-17",
      title: "大模型价格战背后：谁在亏钱，谁在布局",
      url: "",
      content:
        "2025年初，国内大模型市场掀起新一轮价格战。多家头部厂商将API调用价格下调50%-90%，部分模型甚至推出免费版本。这场价格战背后的逻辑并不简单。首先，模型推理成本确实在快速下降，得益于模型蒸馏、量化压缩和推理芯片迭代，同等性能的推理成本在过去一年下降了约70%。其次，各厂商战略目的不同：头部玩家希望通过低价快速占领开发者生态；中小厂商则被迫跟进以保住市场份额。从商业模式看，单纯的API调用收入很难支撑大模型公司的估值，真正的盈利点在于企业级定制部署、垂直行业解决方案以及基于模型能力构建的SaaS产品。值得注意的是，价格战正在加速行业洗牌，预计2025年底将有30%-40%的大模型创业公司面临资金链断裂或被收购。",
      summary:
        "## 一句话总结\n国内大模型价格战的核心驱动是推理成本一年降约 70%，而非单纯补贴，正加速行业洗牌。\n\n## 核心观点\n- 价格下调 50%-90% 背后是成本结构性下降（蒸馏+量化+芯片）\n- 头部用低价抢生态，中小厂被动跟进保份额\n- 单纯 API 收入难撑估值，盈利靠定制部署/垂直方案/SaaS\n\n## 关键数据 / 事实\n- 推理成本一年下降约 70%\n- API 价格下调 50%-90%\n- 预计 2025 年底 30%-40% 创业公司出局\n\n## 关键词标签\n- 大模型 推理成本 价格战 商业模式 行业洗牌\n\n## 价值与适用人群\n适合 AI 从业者、投资人快速把握大模型商业化拐点与竞争格局。",
      analyzedAt: "2025-03-17T11:00:00.000Z",
      createdAt: "2025-03-17T10:30:00.000Z",
    },
    {
      id: crypto.randomUUID(),
      account: "半佛仙人",
      publishDate: "2025-03-16",
      title: "为什么你存不下钱？从行为经济学说起",
      url: "",
      content:
        "很多人月薪一万五却存不下一分钱，月薪八千反而能攒下不少。这不是简单的克制力问题，而是行为经济学中的几个经典陷阱在起作用。第一个陷阱是心理账户：人们会无意识地把收入分成不同账户，工资要省着花，年终奖可以大手大脚，实际上钱就是钱。第二个陷阱是锚定效应：当你看到原价899现价299，你觉得自己赚了600块，实际上你花了299，商家设定的原价就是锚点。第三个陷阱是即时满足偏好：大脑天生偏好现在的快乐，一杯30块奶茶的即时愉悦远比30年后多30块退休金真实。解决方案其实很简单：发工资当天自动转20%到不方便取出的账户；设定24小时冷静期再下单；把存款目标具象化，比如明年去日本旅行的机票钱。",
      summary: "",
      analyzedAt: null,
      createdAt: "2025-03-16T14:00:00.000Z",
    },
    {
      id: crypto.randomUUID(),
      account: "虎嗅APP",
      publishDate: "2025-03-15",
      title: "Sora之后：AI视频生成的技术路线之争",
      url: "",
      content:
        "OpenAI的Sora发布后，AI视频生成赛道迅速升温，目前主要存在三条技术路线的竞争。第一条是Sora采用的Diffusion Transformer路线，通过在视频潜空间中进行去噪生成，优势是生成质量高、物理一致性好，但计算成本极高。第二条是以Runway Gen-3为代表的图像到视频路线，先生成关键帧再插帧，速度快但容易出现运动不连贯。第三条是国内可灵、智谱等采用的端到端路线，试图通过大规模视频数据训练一步到位。实际落地场景中，短视频平台和广告行业最先买单，一条15秒产品广告视频传统制作成本约3-5万元，使用AI工具后降至几百元，但仍需人工审核和精修。预计2025年底AI视频生成市场规模将达到50亿美元。",
      summary: "",
      analyzedAt: null,
      createdAt: "2025-03-15T09:00:00.000Z",
    },
  ];
}
