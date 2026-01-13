# 🚀 Cloudflare Worker 多项目部署中控 (Timer Enhanced V3.4)

<img width="1460" height="895" alt="image" src="https://github.com/user-attachments/assets/cfcd0ae8-5039-4893-84bc-dc0095663a5c" />

这是一个基于 Cloudflare Worker 的**多项目集中部署与自动化管理平台**。它允许你在一个统一的 Dashboard 中管理、监控并自动维护多个 Worker 项目（目前支持 **CMliu (EdgeTunnel)** 和 **Joey (CFNew)**）。

> **✨ V3.4 版本新特性**
> * **⏱️ 分钟级检测**：打破每日一次的限制，支持按 **分钟** 或 **小时** 设置检测间隔（如：每 10 分钟检测一次）。
> * **🛡️ 流量熔断机制**：当账号流量达到设定阈值（如 90%），系统将**自动更换 UUID 并重新部署**，实现软阻断，防止机场/节点被滥用消耗过多额度。
> * **⚡️ 统一计时器**：流量熔断与版本更新共用同一个计时器，大幅降低资源消耗。
> * **📊 精准统计内核**：采用 Billing 级接口，精准核算每日 10w 免费额度（Workers + Pages 总和），彻底解决查询报错问题。

---

## 🛠️ 功能列表

1. **可视化仪表盘 (经典布局)**：
   - **左侧**：实时流量统计（直观进度条）+ 账号列表。
   - **右侧**：控制台、日志窗口、自动化设置面板。
   - **隐私保护**：账号列表默认折叠，适合公开演示。

2. **多账号集中管理**：
   - 支持添加无限个 Cloudflare 账号（Account ID + Token）。
   - 支持将 Worker 灵活分配给不同账号。

3. **智能自动化系统**：
   - **自动更新**：后台静默检测 GitHub 上游版本，发现更新自动拉取并部署。
   - **自动熔断**：流量超标自动“换号重练”（更换 UUID），保护账号安全。

4. **变量管理**：
   - 可视化修改环境变量。
   - 支持 `UUID` 一键随机生成。

---

## 📥 部署指南

### 1. 创建 Worker

1. 登录 Cloudflare Dashboard。
2. 进入 **Workers & Pages** -> **Create Application** -> **Create Worker**。
3. 命名为 `deploy-manager`，点击 Deploy。
4. 点击 **Edit code**，将本项目提供的 `worker.js` (V3.4) 完整代码粘贴进去，保存。

### 2. 配置 KV 存储 (必须)

此项目依赖 KV 存储配置信息。

1. 在侧边栏选择 **Storage & Databases** -> **KV**。
2. 点击 **Create a Namespace**，命名为 `CONFIG_KV`。
3. 回到 Worker 的 **Settings** -> **Variables**。
4. 在 **KV Namespace Bindings**：
   * Variable name: `CONFIG_KV` (**必须一致**)
   * KV Namespace: 选择刚才创建的那个。

### 3. 设置环境变量

在 **Settings** -> **Variables** -> **Environment Variables** 添加：

| 变量名 | 示例值 | 说明 |
| --- | --- | --- |
| `ACCESS_CODE` | `password123` | **(必填)** 访问后台的密码。 |
| `GITHUB_TOKEN` | `ghp_xxxxxx` | **(推荐)** GitHub PAT，用于提高 API 限额，防止更新检测失败。 |

### 4. 配置 Cron 触发器 (关键)

为了实现“每 10 分钟检测一次”，你需要设置 Cloudflare 的 Cron Trigger。

1. 进入 Worker 的 **Settings** -> **Triggers**。
2. 点击 **Add Cron Trigger**。
3. **CRON Expression**：
   * 如果你想 10 分钟检测一次：填写 `*/10 * * * *`
   * 如果你想 1 小时检测一次：填写 `0 * * * *`
   * *建议设置为 `*/10 * * * *` (每10分钟唤醒一次)，具体的执行间隔可以在前端页面灵活控制。*

---

## 🔑 API Token 权限要求 (必读)

为了确保**流量统计**和**部署**功能正常，您填入的 CF 账号 Token 必须具备：

1. **Permissions (权限)**:
   * `Account` -> `Account Analytics` -> **Read** (统计流量)
   * `Account` -> `Workers Scripts` -> **Edit** (部署代码)
   * *(可选)* `Account` -> `Account Settings` -> **Read**

2. **Account Resources (资源范围) [🚫 最容易出错的地方]**:
   * ❌ **错误**：选择 `All zones`。
   * ✅ **正确**：必须选择 **`Include` -> `All accounts`** (所有账户) 或指定 Account。
   * *原因：流量统计是账号级别的，只给 Zone 权限查不到数据！*

---

## 💻 使用手册

### 1. 初始化
访问 `https://你的worker.workers.dev/?code=你的密码` 进入后台。

### 2. 添加账号
在左侧“账号管理”面板：
* 填写别名、Account ID、API Token。
* **CMliu Workers**: 填入该账号下已创建的 Worker 名称（例如 `edgetunnel-01`）。
* **Joey Workers**: 同上。

### 3. 配置自动化 (右侧面板)
在右侧 **“🛡️ 自动维护设置”** 区域：
* **启用 Cron 自动检测**：勾选。
* **检测间隔**：设置数值和单位（例如 `10` `分钟`）。
* **⚠️ 熔断阈值%**：设置一个百分比（例如 `90`）。
  * *效果：当流量用到 90,000 次 (90%) 时，下次检测会自动修改 UUID 并重新部署，使节点失效。*
* 点击 **“保存全部设置”**。

### 4. 手动操作
* 顶部下拉菜单切换当前管理的项目（CMliu / Joey）。
* 点击 **“🎲 刷新”** 可以手动换 UUID。
* 点击 **“🔄 立即执行更新”** 可以强制部署一次。

---

## 🧩 支持模板

| 项目 | 说明 | 默认变量 |
| --- | --- | --- |
| **CMliu** | EdgeTunnel (beta2.0) | `UUID`, `PROXYIP`, `path`... |
| **Joey** | CFNew (自动修复版) | `u` (UUID), `d`... |

---

## ⚠️ 免责声明
本项目仅供技术研究与学习，请勿用于任何非法用途。开发者不对使用本工具产生的任何后果负责。
