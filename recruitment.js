const jobList = document.getElementById("job-list");
const template = document.getElementById("job-item-template");

const keywordInput = document.getElementById("keyword");
const cityFilter = document.getElementById("city-filter");
const typeFilter = document.getElementById("type-filter");
const dateFilter = document.getElementById("date-filter");
const clearFiltersBtn = document.getElementById("clear-filters");

const lastUpdatedEl = document.getElementById("last-updated");
const todayCountEl = document.getElementById("today-count");

let jobs = [];

init();

async function init() {
  const data = await loadJobs();
  jobs = sortByPublishDate(data.jobs || []);

  setupSummary(data.updatedAt, jobs);
  setupFilterOptions(jobs);
  bindEvents();
  renderJobs();
}

async function loadJobs() {
  try {
    const response = await fetch("./data/jobs.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`加载失败：${response.status}`);
    }
    return await response.json();
  } catch (error) {
    jobList.innerHTML = `<li class="empty">数据加载失败：${error.message}</li>`;
    return { updatedAt: "未知", jobs: [] };
  }
}

function sortByPublishDate(items) {
  return [...items].sort((a, b) => (a.publishDate < b.publishDate ? 1 : -1));
}

function setupSummary(updatedAt, allJobs) {
  lastUpdatedEl.textContent = `最后更新：${updatedAt || "未知"}`;

  const today = getToday();
  const todayCount = allJobs.filter((job) => job.publishDate === today).length;
  todayCountEl.textContent = `今日新增：${todayCount}`;
}

function setupFilterOptions(allJobs) {
  const citySet = new Set();
  const typeSet = new Set();

  allJobs.forEach((job) => {
    if (job.city) citySet.add(job.city);
    if (job.type) typeSet.add(job.type);
  });

  [...citySet].sort().forEach((city) => cityFilter.append(new Option(city, city)));
  [...typeSet].sort().forEach((type) => typeFilter.append(new Option(type, type)));
}

function bindEvents() {
  [keywordInput, cityFilter, typeFilter, dateFilter].forEach((node) => {
    node.addEventListener("input", renderJobs);
    node.addEventListener("change", renderJobs);
  });

  clearFiltersBtn.addEventListener("click", () => {
    keywordInput.value = "";
    cityFilter.value = "";
    typeFilter.value = "";
    dateFilter.value = "";
    renderJobs();
  });
}

function getFilteredJobs() {
  const keyword = keywordInput.value.trim().toLowerCase();
  const city = cityFilter.value;
  const type = typeFilter.value;
  const publishDate = dateFilter.value;

  return jobs.filter((job) => {
    const text = [job.company, job.title, job.description, ...(job.tags || [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const matchKeyword = !keyword || text.includes(keyword);
    const matchCity = !city || job.city === city;
    const matchType = !type || job.type === type;
    const matchDate = !publishDate || job.publishDate === publishDate;

    return matchKeyword && matchCity && matchType && matchDate;
  });
}

function renderJobs() {
  const filtered = getFilteredJobs();
  jobList.innerHTML = "";

  if (!filtered.length) {
    jobList.innerHTML = '<li class="empty">暂无符合条件的岗位，试试放宽筛选条件。</li>';
    return;
  }

  filtered.forEach((job) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector(".title").textContent = `${job.company}｜${job.title}`;
    node.querySelector(".badge").textContent = job.type || "岗位";
    node.querySelector(".meta").textContent = `${job.city || "城市待定"} · 发布时间：${job.publishDate || "未知"}`;
    node.querySelector(".desc").textContent = job.description || "暂无岗位描述";
    node.querySelector(".deadline").textContent = `截止时间：${job.deadline || "未注明"}`;

    const tagsContainer = node.querySelector(".tags");
    (job.tags || []).forEach((tag) => {
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = tag;
      tagsContainer.appendChild(span);
    });

    const urlNode = node.querySelector(".url");
    if (job.url) {
      urlNode.href = job.url;
    } else {
      urlNode.textContent = "暂无投递链接";
      urlNode.removeAttribute("href");
      urlNode.style.pointerEvents = "none";
      urlNode.style.color = "#64748b";
    }

    jobList.appendChild(node);
  });
}

function getToday() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
