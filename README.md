# 墨摘 WeChat Digest · AI 公众号抓取与结构化分析

> 输入公众号名称，自动抓取最新文章，AI 一键完成总结与结构化分析。
> **匿名工作区码** 即开即用、跨设备同步、人人数据隔离；支持 **OpenAI / DeepSeek / 通义千问**。

![stack](https://img.shields.io/badge/frontend-Vanilla_JS-f7df1e) ![stack](https://img.shields.io/badge/backend-Vercel_Serverless-000) ![store](https://img.shields.io/badge/sync-Upstash_KV-00c389) ![ai](https://img.shields.io/badge/AI-OpenAI%20%7C%20DeepSeek%20%7C%20Qwen-10b981)

---

## ✨ 能做什么

| 能力 | 说明 |
| --- | --- |
| **按名称自动抓取** | 输入公众号名称 → 后端代理搜狗微信搜索（带 cookie 预热 / UA 轮换 / 重试 / 缓存）→ 拉取文章列表并解析正文 |
| **粘贴链接解析** | 直接粘贴 `mp.weixin.qq.com` 文章链接（或搜狗跳转链接），自动解析并清洗为纯净正文 |
| **AI 结构化分析** | 自动输出「一句话总结 / 核心观点 / 关键数据 / 关键词标签 / 适用人群」，流式输出 |
| **批量自动化** | 导入后可自动分析，或一键批量分析全部未分析文章 |
| **多模型切换** | OpenAI、DeepSeek、通义千问任意切换；国产模型经后端代理转发，绕过浏览器 CORS |
| **工作区码同步** | 每个访客自动获得专属工作区码，文章与分析存云端、按码隔离、互不重叠；换设备输入同码即可恢复 |
| **Key 仅本地** | API Key 只存浏览器 `localStorage`，**绝不写入云端工作区**，可随时清除 |

---

## 👥 多用户：匿名工作区码

无需注册登录。首次进入应用会自动生成一串高熵 **工作区码**（形如 `a1b2-c3d4-e5f6-7890`）：

- 工作区码写入浏览器与地址栏 `#ws=...`，可收藏/复制保存；
- 文章与分析结果按工作区码存于云端 KV，**不同码之间完全隔离、内容不重叠**；
- 在任意设备的工作台「切换」处输入同一串码，即可同步同一份数据；
- ⚠️ 工作区码即数据钥匙，**持有者可读写该工作区**，请妥善保存、勿公开分享；
- 若后端未配置 KV，应用自动降级为「纯本地模式」（仅存当前浏览器），功能照常可用。

---

## 🏗 架构

```
浏览器（静态前端，零构建）
  ├─ index.html / styles.css / app.js
  │   工作区码生成 + 云同步（防抖上传 / 合并下载）+ Key 本地存储
  └─ 调用 ↓
Serverless 后端（Vercel Functions, /api）
  ├─ GET  /api/search?account=名称      搜狗微信搜索 → 文章列表（KV 缓存 10min）
  ├─ GET  /api/article?url=链接         解析搜狗跳转 → 抓取清洗正文（KV 缓存 1d）
  ├─ GET/PUT /api/data?ws=工作区码       读取 / 保存某工作区的文章（Upstash KV）
  └─ POST /api/chat                     OpenAI 兼容流式代理（多 provider）
        ↓
Upstash Redis（KV）  按 ws:<码> 存数据；search:* / art:* 做抓取缓存
```

> 为什么需要后端：微信公众号无公开官方 API，浏览器直连会被 **CORS** 拦截且有强反爬；
> DeepSeek / 通义千问的 API 也未对浏览器开放跨域。抓取、AI 调用、跨设备同步都经由 Serverless 完成。

---

## 🚀 部署（推荐 Vercel，一处搞定前后端 + 同步）

1. Fork / clone 本仓库
2. 在 [vercel.com](https://vercel.com) 导入该仓库，框架选 **Other**，无需构建命令
3. **启用云同步（可选但推荐）**：在 Vercel 项目 → **Storage** → 创建一个 **Upstash for Redis**（或旧版 Vercel KV）并关联到项目。集成会自动注入环境变量：
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`

   （应用也兼容 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`。）
4. 重新部署。访问分配的域名即可，`/api/*` 自动成为 Serverless 函数。

> 未配置 KV 也能用：`/api/data` 会返回 501，前端自动切到「纯本地模式」（数据仅存当前浏览器，不跨设备）。

本地开发：

```bash
npm i -g vercel
vercel dev          # 同时跑前端与 /api 函数；如需同步，先在 Vercel 关联 KV 并 `vercel env pull`
```

> ⚠️ **GitHub Pages 只能托管静态前端，无法运行 `/api`。**
> 若用 Pages 托管前端，请把后端单独部署到 Vercel，并在应用「设置 → 后端 API 地址」填入
> 你的 Vercel 域名（如 `https://your-app.vercel.app`），前端会跨域调用它。

---

## 🔑 配置模型

进入「工作台 → 设置」：

| 模型 | Key 获取 | 备注 |
| --- | --- | --- |
| OpenAI | platform.openai.com | 需国外网络 |
| DeepSeek | platform.deepseek.com | 国内可直连，性价比高 |
| 通义千问 | 阿里云百炼控制台 | OpenAI 兼容模式 |

Key 仅保存在浏览器本地，调用时随请求发送给你自己部署的后端代理，再转发给模型厂商。

---

## 🧭 使用流程

1. 首页或工作台输入**公众号名称** → 「抓取文章」
2. 在结果弹窗勾选要导入的文章（可勾选「导入后自动 AI 分析」）
3. 左侧文章库点击任意文章 → 右侧查看 AI 结构化分析
4. 可在分析框填写**自定义指令**（如「侧重投资视角」）重新生成
5. 「一键分析未分析」批量处理整个文章库

---

## ⚠️ 关于抓取的现实说明

- 后端已做加固：**cookie 预热、UA 轮换、指数退避重试、KV 结果缓存**，可显著提高成功率并降低反爬触发。
- 但搜狗微信搜索仍存在反爬（高频访问会触发验证码），抓取**不保证 100% 成功**；触发时应用会提示，可改用「粘贴链接」。
- 搜狗搜索结果是 JS 跳转链接，后端会自动解析出真实 `mp.weixin.qq.com` 地址再抓取。
- 部分图片/视频类推送无法解析正文，会提示手动粘贴。
- 本项目仅供个人学习与研究，请遵守目标站点的 robots 与服务条款，控制访问频率。

---

## 📄 License

MIT
