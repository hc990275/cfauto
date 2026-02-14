# 🚀 Cloudflare Worker 智能部署中控 (V9.9.6 Pro)

> 全部代码为 Claude Code 完成
> 自行修改延伸功能

> **版本状态**: V9.9.6 Stable
> **核心进化**: 引入 **服务器端代码混淆**、**熔断保护机制** 与 **收藏版本管理**。

本项目是一个基于 Cloudflare Worker 构建的深度集成化部署管理平台。它不仅能管理多个 Cloudflare 账号，还支持一键批量部署、版本回滚、自动化流量熔断以及代码级的混淆加固，是管理大规模 Worker 节点的终极工具。

---

## ✨ V9.9.6 核心新特性

### 🔐 智能混淆体系 (Obfuscation Pro)

* **服务器端轻量混淆**：针对自动更新和熔断任务，系统会在部署前自动执行代码压缩、注释移除和 Window Polyfill 注入。
* **前端高级混淆**：批量部署插件内置 `JavaScript-Obfuscator`，支持自定义混淆配置，提高节点生存率。

### 🛡️ 流量熔断与自动轮换 (Auto Fuse)

* **实时监控**：自动统计各账号当日总用量。
* **阈值熔断**：可设置用量百分比（如 90%）。一旦触发，系统自动执行 **UUID 随机轮换** 并 **强制混淆部署**，快速切换节点状态以应对封锁或超额。

### 📜 收藏夹管理 (Favorites System)

* **版本锚定**：支持从 GitHub 历史中挑选稳定版本并加入"收藏"。
* **一键回滚**：即使上游代码库更新失败或被删，你依然可以从收藏夹中一键恢复到曾经锁定的稳定状态。

### 🌐 自动化运维

* **Zone 智能识别**：一键拉取账号下所有域名，支持自动化绑定自定义二级域名。
* **级联资源清理**：删除 Worker 时可选择同步清理关联的 KV 命名空间，拒绝资源浪费。

---

## 📖 核心操作说明

### 🛰️ 账号管理

* **添加账号**：需提供 `Account ID`、`Email` 和 `Global API Key`。
* **读取域名**：点击"读取"会自动填充该账号下的 Zone，用于后续的批量域名绑定。

### ✨ 批量部署 (Batch Deploy)

1. 点击顶部"批量部署"。
2. **选择模板**：支持 `CMliu` (EdgeTunnel)、`Joey` (相信光) 等主流模板。
3. **开启混淆**：勾选"启用代码混淆"，系统将通过前端加密后再上传。
4. **域名绑定**：输入前缀，系统会自动在所选账号的预设域名下生成子域名。

---

## 🛠️ 部署教程 (保姆级)

只需简单 4 步，即可拥有自己的 Worker 中控台。

### 1️⃣ 第一步：创建主控 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 进入 **Workers & Pages** -> **Overview** -> **Create Application** -> **Create Worker**。
3. 命名为 `manager` (建议)，点击 **Deploy**。
4. 点击 **Edit code**，将本项目提供的 `worker.js` (V9.9.6) **完整代码** 粘贴覆盖。
5. 点击 **Save and deploy**。

### 2️⃣ 第二步：绑定 KV 存储 (⚠️ 核心)

**中控本身需要一个 KV 来存储账号数据，不绑定无法启动！**

1. 在 Worker 编辑页面的 **Settings** (设置) -> **Variables** (变量)。
2. 找到 **KV Namespace Bindings**，点击 **Add binding**。
3. **Variable name**: 填写 `CONFIG_KV` (**必须大写，完全一致**)
4. **KV Namespace**: 点击 "Create new KV namespace"，命名为 `manager_data`，点击 **Add**。
5. 点击 **Save and deploy**。

### 3️⃣ 第三步：设置安全密码

1. 同样在 **Settings** -> **Variables** -> **Environment Variables**。
2. 点击 **Add variable**：
   * **Variable name**: `ACCESS_CODE`
   * **Value**: 设置你的登录密码（如 `admin888`）。

3. *(可选但推荐)* 防止 GitHub API 限流：
   * **Variable name**: `GITHUB_TOKEN`
   * **Value**: 你的 GitHub PAT (获取方式见下文)。

4. 点击 **Save and deploy**。

### 4️⃣ 第四步：开始使用

访问你的 Worker 域名（如 `https://manager.你的前缀.workers.dev`），输入密码即可进入控制台。

---

## 🔑 核心数据获取指南

### 🅰️ Cloudflare 账号信息

在添加账号时需要填写：

* **Account ID**: 登录 CF 后，URL 地址栏 `dash.cloudflare.com/` 后面的那串字符。
* **Global API Key**:
  1. 点击右上角头像 -> **My Profile** -> **API Tokens**。
  2. 找到 **Global API Key** -> View -> 输入密码复制。

> *注意：必须使用 Global Key，普通 Token 权限不足以创建 KV 和绑定域名。*

### 🅱️ GitHub Token (用于解除限流)

如果不配置此项，GitHub 每小时限制请求 60 次，可能导致无法检查更新。

1. 登录 GitHub -> 头像 -> **Settings** -> **Developer settings**。
2. **Personal access tokens** -> **Tokens (classic)** -> **Generate new token (classic)**。
3. **Scopes**: 如果只用公共仓库（如 cmliu），**不需要勾选任何权限**。
4. 生成并复制 `ghp_` 开头的 Token。

---

## 📖 常用操作指南

### ✨ 批量部署新项目

1. 点击顶部「**✨ 批量部署**」。
2. **模板选择**：
   * `CMliu`: 经典 EdgeTunnel，建议开启 KV。
   * `Joey`: 推荐关闭 KV (取消勾选 "绑定 KV 存储")，使用纯变量模式。
3. **KV 设置**：如果开启 KV，请填写 KV 名称（中控会自动创建）。
4. **域名设置**：
   * 勾选 `禁用默认域名` 可提高隐蔽性。
   * 填写 `自定义域名` 前缀（前提：账号已读取到预设域名）。
5. 勾选目标账号 -> **🚀 开始部署**。

### 🔄 变量同步 (反向更新)

如果你在 Cloudflare 后台手动修改了某个 Worker 的变量：

1. 在中控面板找到该项目。
2. 点击「**🔄 同步**」。
3. 中控会将云端的最新配置拉取回本地数据库，确保数据一致。

### 🗑️ 安全删除

1. 点击账号右侧的「**📂 管理**」。
2. 点击「**🗑️ 删除**」。
3. **勾选 "同时删除绑定的 KV"** (推荐)，系统将自动清理残留资源。

---

## 📝 内置模板说明

| 模板代码 | 项目名称 | 特性说明 | 建议配置 |
| --- | --- | --- | --- |
| **cmliu** | EdgeTunnel (Beta 2.0) | 功能最全，支持订阅 | 开启 KV |
| **joey** | 少年你相信光吗 | 自动修复，极简 | **关闭 KV** (变量模式) |
| **ech** | ECH Proxy | 无需维护，WebSocket | 关闭 KV |

---

## ⚠️ 免责声明

本项目仅供技术研究和学习使用，请勿用于任何非法用途。开发者不对使用本工具产生的任何后果负责。您的 API Key 仅保存在您自己的 Cloudflare KV 中，请妥善保管。
