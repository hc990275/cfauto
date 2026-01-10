---

# 🚀 Cloudflare Worker 多项目部署中控 (Auto-Update Edition)

这是一个基于 Cloudflare Worker 的**多项目集中部署与管理工具**。它允许你在一个统一的 Dashboard 中管理、配置并自动更新多个不同的 Worker 项目（目前支持 **CMliu (EdgeTunnel)** 和 **Joey (CFNew)**）。

> **✨ 最新版特性 (v2.0)**
> * **⏰ 自动更新**：支持后台定时检测 GitHub 上游版本，发现新版本自动拉取并重新部署。
> * **🙈 隐私保护**：账号列表默认支持折叠/展开，直播或截图时更安全。
> * **⚙️ 独立配置**：不同项目（CMliu/Joey）拥有独立的自动更新开关和变量配置。
> * **🧩 代码补丁**：针对 Joey 项目自动注入 `window` 环境补丁。
> 
> 

---

## 🛠️ 功能列表

1. **集中式账号管理**：支持添加多个 Cloudflare 账号（ID + Token），并将不同的 Worker 分配给不同账号。
2. **变量管理**：
* 可视化增删改查 Worker 环境变量 (KV/Text)。
* 支持 `UUID` 一键刷新生成。
* 针对 Joey 项目内置 `u` (UUID) 和 `d` (默认) 变量。


3. **智能更新系统**：
* **手动更新**：一键检测 GitHub API，对比本地与远程 SHA，手动触发部署。
* **自动更新**：配合 Cron Triggers，后台静默检查并更新。


4. **Token 增强**：支持配置 `GITHUB_TOKEN`，避免请求 GitHub API 时出现速率限制 (403 Error)。

---

## 📥 部署指南

### 1. 准备工作

* 一个 Cloudflare 账号。
* (可选) 一个 GitHub Token (用于提高 API 请求限额)。

### 2. 创建 Worker

1. 登录 Cloudflare Dashboard。
2. 进入 **Workers & Pages** -> **Create Application** -> **Create Worker**。
3. 命名为 `deploy-manager` (或你喜欢的名字)，点击 Deploy。
4. 点击 **Edit code**，将本项目提供的 `worker.js` 完整代码复制粘贴进去，保存。

### 3. 配置 KV 存储 (必须)

此项目依赖 KV 来存储账号数据、变量配置和版本信息。

1. 在 Cloudflare 侧边栏选择 **Storage & Databases** -> **KV**。
2. 点击 **Create a Namespace**，命名为 `CONFIG_KV`（建议）。
3. 回到你创建的 Worker 的 **Settings** -> **Variables** 页面。
4. 在 **KV Namespace Bindings** 区域：
* Variable name 填写: `CONFIG_KV` (**必须完全一致**)
* KV Namespace 选择你刚才创建的那个。



### 4. 设置环境变量

在 Worker 的 **Settings** -> **Variables** -> **Environment Variables** 区域添加：

| 变量名 | 示例值 | 说明 |
| --- | --- | --- |
| `ACCESS_CODE` | `password123` | **(强烈推荐)** 访问控制台的密码。如果不填，任何人都能访问你的后台！ |
| `GITHUB_TOKEN` | `ghp_xxxxxx` | **(推荐)** GitHub Personal Access Token。配置后可大幅提高更新检测的稳定性。 |

### 5. 配置自动更新 (Cron Triggers)

为了让“自动更新”功能生效，你需要设置一个唤醒触发器。

1. 进入 Worker 的 **Settings** -> **Triggers**。
2. 点击 **Add Cron Trigger**。
3. **CRON Expression** 建议填写：`*/30 * * * *`
* *意思是：每 30 分钟唤醒一次 Worker 检查任务。*
* *注意：这不会导致每30分钟就更新一次。脚本内部会根据你在前端页面设置的“间隔时间（小时）”来决定是否真正执行更新。*



---

## 💻 使用说明

### 1. 访问控制台

访问 `https://你的worker域名.workers.dev/`。如果设置了 `ACCESS_CODE`，需要输入密码登录。

### 2. 添加目标账号

在左侧“账号管理”面板：

* **Alias**: 备注名（如：主力号）。
* **Account ID**: 目标 CF 账号的 ID（在该账号主页右下角获取）。
* **API Token**: 必须拥有 `Edit Workers` 权限的 Token。
* **Workers**: 填写该账号下需要被部署的 Worker 名字，用逗号分隔。
* *CMliu 栏填 EdgeTunnel 相关的 Worker 名。*
* *Joey 栏填 CFNew 相关的 Worker 名。*



### 3. 启用自动更新

在右侧面板的“自动更新设置”区域：

1. 勾选开关。
2. 设置检查间隔（例如 `24` 小时）。
3. 点击“保存设置”。
4. *前提：请确保你已经完成了上述的 Cron Triggers 配置。*

### 4. 变量与部署

* 切换顶部的下拉菜单选择项目（CMliu 或 Joey）。
* 修改变量后，点击底部的 **“立即执行更新”** 即可手动强制部署。

---

## 🧩 支持的项目模板

目前内置支持以下项目：

1. **🔴 CMliu - EdgeTunnel**
* **Source**: `cmliu/edgetunnel` (beta2.0)
* **Default Vars**: `UUID`, `PROXYIP`, `PATH` 等。


2. **🔵 Joey - 少年你相信光吗**
* **Source**: `byJoey/cfnew`
* **Special**: 自动注入 `var window = globalThis;` 补丁以修复运行环境。
* **Default Vars**: `u` (UUID), `d`。



---

## ⚠️ 免责声明

本项目仅供学习和技术研究使用。请勿用于非法用途。使用者需自行承担因使用本项目而产生的任何后果。
