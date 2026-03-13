# 原有项目 + 暑期招聘模块（增量接入）

可以，已经按“**接到原有库**”的方式处理，而不是覆盖：

- 原有主页功能保留：`index.html`（公众号推送整理与总结助手）
- 新增招聘模块页面：`recruitment.html`
- 招聘数据文件：`data/jobs.json`

## 页面入口

- 原有主页：`/index.html`
- 招聘看板：`/recruitment.html`

## 每日更新招聘信息（你的工作流）

每天只需要改一个文件：`data/jobs.json`

1. 更新 `updatedAt` 为当天日期
2. 在 `jobs` 数组新增/修改岗位
3. push 到 GitHub `main`
4. GitHub Pages 自动发布

## 本地预览

```bash
python3 -m http.server 4173
```

访问：
- <http://127.0.0.1:4173/index.html>
- <http://127.0.0.1:4173/recruitment.html>

## 部署

仓库已有 `.github/workflows/deploy-pages.yml`，直接使用 GitHub Pages（Source 选 `GitHub Actions`）。
