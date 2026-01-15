/**
 * Cloudflare Worker 多项目部署管理器 (V5.4 Header Integration)
 * * 更新日志：
 * 1. [布局优化] "自动检测与熔断设置" 移至顶部标题栏右侧，节省版面空间。
 * 2. [UI调整] 顶部控制栏采用紧凑型 Flex 布局。
 * 3. [内核保持] 继承 V5.3 的所有核心功能（汉化、变量自定义、全局熔断）。
 */

// ==========================================
// 1. 项目模板配置
// ==========================================
const TEMPLATES = {
  'cmliu': {
    name: "CMliu - EdgeTunnel",
    scriptUrl: "https://raw.githubusercontent.com/cmliu/edgetunnel/beta2.0/_worker.js",
    apiUrl: "https://api.github.com/repos/cmliu/edgetunnel/commits/beta2.0",
    defaultVars: ["UUID", "PROXYIP", "PATH", "URL", "KEY", "ADMIN"],
    uuidField: "UUID",
    description: "CMliu (beta2.0)"
  },
  'joey': {
    name: "Joey - 少年你相信光吗",
    scriptUrl: "https://raw.githubusercontent.com/byJoey/cfnew/main/%E5%B0%91%E5%B9%B4%E4%BD%A0%E7%9B%B8%E4%BF%A1%E5%85%89%E5%90%97",
    apiUrl: "https://api.github.com/repos/byJoey/cfnew/commits?path=%E5%B0%91%E5%B9%B4%E4%BD%A0%E7%9B%B8%E4%BF%A1%E5%85%89%E5%90%97&per_page=1",
    defaultVars: ["u", "d"],
    uuidField: "u",
    description: "Joey (自动修复)"
  }
};

export default {
  // ================= 定时任务 (Cron) =================
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCronJob(env));
  },

  // ================= HTTP 请求入口 =================
  async fetch(request, env) {
    const url = new URL(request.url);
    const correctCode = env.ACCESS_CODE; 
    const urlCode = url.searchParams.get("code");
    const cookieHeader = request.headers.get("Cookie") || "";
    
    // 登录验证
    if (correctCode && !cookieHeader.includes(`auth=${correctCode}`) && urlCode !== correctCode) {
      return new Response(loginHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // 路由常量
    const ACCOUNTS_KEY = `ACCOUNTS_UNIFIED_STORAGE`; 
    const GLOBAL_CONFIG_KEY = `AUTO_UPDATE_CFG_GLOBAL`; 

    // API: 账号管理
    if (url.pathname === "/api/accounts") {
      if (request.method === "GET") {
        return new Response(await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]", { headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "POST") {
        await env.CONFIG_KV.put(ACCOUNTS_KEY, JSON.stringify(await request.json()));
        return new Response(JSON.stringify({ success: true }));
      }
    }

    // API: 变量管理
    if (url.pathname === "/api/settings") {
      const type = url.searchParams.get("type");
      const VARS_KEY = `VARS_${type}`;
      if (request.method === "GET") {
        return new Response(await env.CONFIG_KV.get(VARS_KEY) || "null", { headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "POST") {
        await env.CONFIG_KV.put(VARS_KEY, JSON.stringify(await request.json()));
        return new Response(JSON.stringify({ success: true }));
      }
    }

    // API: 全局自动配置
    if (url.pathname === "/api/auto_config") {
      if (request.method === "GET") {
        return new Response(await env.CONFIG_KV.get(GLOBAL_CONFIG_KEY) || "{}", { headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "POST") {
        const body = await request.json();
        const oldCfg = JSON.parse(await env.CONFIG_KV.get(GLOBAL_CONFIG_KEY) || "{}");
        body.lastCheck = oldCfg.lastCheck || 0; 
        await env.CONFIG_KV.put(GLOBAL_CONFIG_KEY, JSON.stringify(body));
        return new Response(JSON.stringify({ success: true }));
      }
    }

    // API: 检查更新
    if (url.pathname === "/api/check_update") {
        const type = url.searchParams.get("type");
        return await handleCheckUpdate(env, type, `VERSION_INFO_${type}`);
    }

    // API: 部署
    if (url.pathname === "/api/deploy" && request.method === "POST") {
      const type = url.searchParams.get("type");
      const { variables } = await request.json();
      return await handleManualDeploy(env, type, variables, ACCOUNTS_KEY, `VERSION_INFO_${type}`);
    }

    // API: 统计
    if (url.pathname === "/api/stats") {
      return await handleStats(env, ACCOUNTS_KEY);
    }

    const response = new Response(mainHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    if (urlCode === correctCode && correctCode) {
      response.headers.set("Set-Cookie", `auth=${correctCode}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
    }
    return response;
  }
};

/**
 * [核心逻辑] 定时任务：全局熔断检测 + 自动更新
 */
async function handleCronJob(env) {
    const ACCOUNTS_KEY = `ACCOUNTS_UNIFIED_STORAGE`;
    const GLOBAL_CONFIG_KEY = `AUTO_UPDATE_CFG_GLOBAL`;

    const configStr = await env.CONFIG_KV.get(GLOBAL_CONFIG_KEY);
    if (!configStr) return;
    const config = JSON.parse(configStr);
    if (!config.enabled) return;

    const now = Date.now();
    const lastCheck = config.lastCheck || 0;
    const intervalVal = parseInt(config.interval) || 30;
    const unit = config.unit || 'minutes';
    const intervalMs = unit === 'minutes' ? intervalVal * 60 * 1000 : intervalVal * 60 * 60 * 1000;

    if (now - lastCheck <= intervalMs) return; 

    console.log(`[Cron] 🕒 Global Check Started.`);
    
    const accounts = JSON.parse(await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]");
    if (accounts.length === 0) return;
    
    const statsData = await fetchInternalStats(accounts);

    let actionTaken = false;
    const fuseThreshold = parseInt(config.fuseThreshold || 0);

    // 熔断逻辑
    if (fuseThreshold > 0) {
        for (const acc of accounts) {
            const stat = statsData.find(s => s.alias === acc.alias);
            if (!stat || stat.error) continue;

            const limit = stat.max || 100000;
            const usedPercent = (stat.total / limit) * 100;

            console.log(`[Fuse] Account ${acc.alias}: ${usedPercent.toFixed(1)}%`);

            if (usedPercent >= fuseThreshold) {
                console.log(`[Fuse] 🚨 Triggered! Rotating BOTH projects for ${acc.alias}`);
                await rotateUUIDAndDeploy(env, 'cmliu', accounts, ACCOUNTS_KEY);
                await rotateUUIDAndDeploy(env, 'joey', accounts, ACCOUNTS_KEY);
                actionTaken = true;
                break; 
            }
        }
    }

    // 自动更新逻辑
    if (!actionTaken) {
        console.log('[Update] Checking updates for both projects...');
        await Promise.all([
            checkAndDeployUpdate(env, 'cmliu', accounts, ACCOUNTS_KEY),
            checkAndDeployUpdate(env, 'joey', accounts, ACCOUNTS_KEY)
        ]);
    }

    config.lastCheck = now;
    await env.CONFIG_KV.put(GLOBAL_CONFIG_KEY, JSON.stringify(config));
}

async function checkAndDeployUpdate(env, type, accounts, accountsKey) {
    try {
        const VERSION_KEY = `VERSION_INFO_${type}`;
        const checkRes = await handleCheckUpdate(env, type, VERSION_KEY);
        const checkData = await checkRes.json();
        
        if (checkData.remote && (!checkData.local || checkData.remote.sha !== checkData.local.sha)) {
            console.log(`[Update] ${type} new version found. Deploying...`);
            const VARS_KEY = `VARS_${type}`;
            const varsStr = await env.CONFIG_KV.get(VARS_KEY);
            const variables = varsStr ? JSON.parse(varsStr) : [];
            await coreDeployLogic(env, type, variables, accountsKey, VERSION_KEY);
        }
    } catch(e) { console.error(`[Update Error] ${type}: ${e.message}`); }
}

async function rotateUUIDAndDeploy(env, type, accounts, accountsKey) {
    const VARS_KEY = `VARS_${type}`;
    const varsStr = await env.CONFIG_KV.get(VARS_KEY);
    let variables = varsStr ? JSON.parse(varsStr) : [];
    
    const uuidField = TEMPLATES[type].uuidField;
    let uuidUpdated = false;
    variables = variables.map(v => {
        if (v.key === uuidField) {
            v.value = crypto.randomUUID();
            uuidUpdated = true;
        }
        return v;
    });
    if (!uuidUpdated) variables.push({ key: uuidField, value: crypto.randomUUID() });

    await env.CONFIG_KV.put(VARS_KEY, JSON.stringify(variables));
    await coreDeployLogic(env, type, variables, accountsKey, `VERSION_INFO_${type}`);
}

async function fetchInternalStats(accounts) {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const query = `
      query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
        viewer {
          accounts(filter: {accountTag: $AccountID}) {
            workersInvocationsAdaptive(limit: 10000, filter: $filter) { sum { requests } }
            pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
          }
        }
      }
    `;
    return await Promise.all(accounts.map(async (acc) => {
      try {
        const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
          method: "POST",
          headers: { "Authorization": `Bearer ${acc.apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: query, variables: { AccountID: acc.accountId, filter: { datetime_geq: todayStart.toISOString(), datetime_leq: now.toISOString() } } })
        });
        const data = await res.json();
        const accountData = data.data?.viewer?.accounts?.[0];
        if (!accountData) return { alias: acc.alias, error: "无数据" };
        
        const workerReqs = accountData.workersInvocationsAdaptive?.reduce((a, b) => a + (b.sum.requests || 0), 0) || 0;
        const pagesReqs = accountData.pagesFunctionsInvocationsAdaptiveGroups?.reduce((a, b) => a + (b.sum.requests || 0), 0) || 0;
        return { alias: acc.alias, total: workerReqs + pagesReqs, max: 100000 };
      } catch (e) { return { alias: acc.alias, error: e.message }; }
    }));
}

async function handleStats(env, accountsKey) {
    try {
        const accounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");
        if (accounts.length === 0) return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
        const results = await fetchInternalStats(accounts);
        return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
    } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
}

function getGithubHeaders(env) {
    const headers = { "User-Agent": "Cloudflare-Worker-Manager" };
    if (env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim() !== "") headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
    return headers;
}

async function handleCheckUpdate(env, type, versionKey) {
    try {
        const config = TEMPLATES[type];
        const localData = JSON.parse(await env.CONFIG_KV.get(versionKey) || "null");
        const apiUrlWithTs = `${config.apiUrl}${config.apiUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
        const ghRes = await fetch(apiUrlWithTs, { headers: getGithubHeaders(env) });
        if (!ghRes.ok) throw new Error(`GitHub API Error: ${ghRes.status}`);
        const ghData = await ghRes.json();
        const commitObj = Array.isArray(ghData) ? ghData[0] : ghData;
        return new Response(JSON.stringify({ local: localData, remote: { sha: commitObj.sha, date: commitObj.commit.committer.date, message: commitObj.commit.message } }), { headers: { "Content-Type": "application/json" } });
    } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
}

async function handleManualDeploy(env, type, variables, accountsKey, versionKey) {
    return new Response(JSON.stringify(await coreDeployLogic(env, type, variables, accountsKey, versionKey)), { headers: { "Content-Type": "application/json" } });
}

async function coreDeployLogic(env, type, variables, accountsKey, versionKey) {
    try {
        const templateConfig = TEMPLATES[type];
        const accounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");
        if (accounts.length === 0) return [{ name: "提示", success: false, msg: "无账号配置" }];
        
        let githubScriptContent = "";
        let currentSha = "";
        try {
            const [codeRes, apiRes] = await Promise.all([ 
                fetch(templateConfig.scriptUrl + `?t=${Date.now()}`), 
                fetch(templateConfig.apiUrl + `?t=${Date.now()}`, { headers: getGithubHeaders(env) }) 
            ]);
            if (!codeRes.ok) throw new Error(`代码下载失败`);
            githubScriptContent = await codeRes.text();
            if (apiRes.ok) {
                const json = await apiRes.json();
                currentSha = (Array.isArray(json) ? json[0] : json).sha;
            }
        } catch (e) { return [{ name: "网络错误", success: false, msg: e.message }]; }

        if (type === 'joey') githubScriptContent = 'var window = globalThis;\n' + githubScriptContent;
        
        const logs = [];
        let updateCount = 0;
        for (const acc of accounts) {
          const targetWorkers = acc[`workers_${type}`] || [];
          for (const wName of targetWorkers) {
              updateCount++;
              const logItem = { name: `${acc.alias} -> [${wName}]`, success: false, msg: "" };
              try {
                const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/scripts/${wName}`;
                const headers = { "Authorization": `Bearer ${acc.apiToken}` };
                const bindingsRes = await fetch(`${baseUrl}/bindings`, { headers });
                const currentBindings = bindingsRes.ok ? (await bindingsRes.json()).result : [];
                if (variables) {
                    for (const newVar of variables) {
                        if (newVar.value) {
                            const idx = currentBindings.findIndex(b => b.name === newVar.key);
                            if (idx !== -1) currentBindings[idx] = { name: newVar.key, type: "plain_text", text: newVar.value };
                            else currentBindings.push({ name: newVar.key, type: "plain_text", text: newVar.value });
                        }
                    }
                }
                const metadata = { main_module: "index.js", bindings: currentBindings, compatibility_date: "2024-01-01" };
                const formData = new FormData();
                formData.append("metadata", JSON.stringify(metadata));
                formData.append("script", new Blob([githubScriptContent], { type: "application/javascript+module" }), "index.js");
                const updateRes = await fetch(baseUrl, { method: "PUT", headers, body: formData });
                if (updateRes.ok) { logItem.success = true; logItem.msg = `✅ 更新成功`; } 
                else { logItem.msg = `❌ ${(await updateRes.json()).errors?.[0]?.message}`; }
              } catch (err) { logItem.msg = `❌ ${err.message}`; }
              logs.push(logItem);
          } 
        }
        if (updateCount > 0 && currentSha) await env.CONFIG_KV.put(versionKey, JSON.stringify({ sha: currentSha, deployDate: new Date().toISOString() }));
        return logs;
    } catch (e) { return [{ name: "系统错误", success: false, msg: e.message }]; }
}

function loginHtml() { return `<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f3f4f6"><form method="GET"><input type="password" name="code" placeholder="密码" style="padding:10px"><button style="padding:10px">登录</button></form></body></html>`; }

// ==========================================
// 2. 前端页面
// ==========================================
function mainHtml() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Worker 智能中控 (V5.4)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .input-field { border: 1px solid #cbd5e1; padding: 0.25rem 0.5rem; width:100%; border-radius: 4px; font-size: 0.8rem; } 
    .input-field:focus { border-color:#3b82f6; outline:none; }
    .toggle-checkbox:checked { right: 0; border-color: #68D391; }
    .toggle-checkbox:checked + .toggle-label { background-color: #68D391; }
    .compact-table th, .compact-table td { padding: 4px 8px; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
    .compact-table th { background-color: #f8fafc; color: #64748b; font-weight: 600; text-align: left; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
  </style>
</head>
<body class="bg-slate-100 p-4 min-h-screen">
  <div class="max-w-7xl mx-auto space-y-4">
    
    <header class="bg-white px-6 py-4 rounded shadow flex flex-col md:flex-row justify-between items-center gap-4">
        <div>
            <h1 class="text-xl font-bold text-slate-800 flex items-center gap-2">🚀 Worker 部署中控 <span class="text-xs bg-slate-200 text-slate-600 px-2 py-0.5 rounded ml-2">V5.4</span></h1>
            <div class="text-[10px] text-gray-400 mt-1">全局管理 · 自动排序 · 双重熔断</div>
        </div>
        
        <div class="flex items-center gap-3 bg-slate-50 p-2 rounded border border-slate-200">
             <div class="flex items-center gap-2 border-r border-slate-200 pr-3 mr-1">
                <span class="text-xs font-bold text-gray-600">自动检测</span>
                <div class="relative inline-block w-8 align-middle select-none">
                    <input type="checkbox" id="auto_update_toggle" class="toggle-checkbox absolute block w-4 h-4 rounded-full bg-white border-4 appearance-none cursor-pointer border-gray-300"/>
                    <label for="auto_update_toggle" class="toggle-label block overflow-hidden h-4 rounded-full bg-gray-300 cursor-pointer"></label>
                </div>
             </div>
             <div class="flex items-center gap-1">
                <span class="text-xs text-gray-500">频率:</span>
                <input type="number" id="auto_update_interval" value="30" class="w-10 text-center text-xs border rounded py-0.5">
                <select id="auto_update_unit" class="text-xs border rounded py-0.5 bg-white"><option value="minutes">分</option><option value="hours">时</option></select>
             </div>
             <div class="flex items-center gap-1">
                <span class="text-xs text-red-600 font-bold">熔断%:</span>
                <input type="number" id="fuse_threshold" value="0" placeholder="0" class="w-10 text-center text-xs border border-red-300 bg-red-50 rounded py-0.5 font-bold text-red-600">
             </div>
             <button onclick="saveAutoConfig()" class="text-[10px] bg-slate-700 text-white px-2 py-1 rounded hover:bg-slate-800 font-bold ml-1">保存设置</button>
        </div>
    </header>
    
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
      
      <div class="lg:col-span-7 space-y-4">
          
          <div class="bg-white p-4 rounded shadow">
             <div class="flex justify-between items-center mb-2">
                <h2 class="font-bold text-gray-700 text-sm">📊 今日用量 (已用降序排列)</h2>
                <button onclick="loadStats()" id="btn_stats" class="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded font-bold hover:bg-indigo-100 transition">🔄 刷新</button>
             </div>
             <div class="overflow-x-auto">
                 <table class="w-full compact-table">
                    <thead><tr><th width="30%">备注</th><th width="40%">已用 / 总数</th><th width="30%">占比</th></tr></thead>
                    <tbody id="stats_body"><tr><td colspan="3" class="text-center text-gray-300 py-2">点击刷新加载...</td></tr></tbody>
                 </table>
             </div>
          </div>

          <div class="bg-white p-4 rounded shadow flex-1">
            <div class="flex justify-between items-center mb-3">
                 <h2 class="font-bold text-gray-700 text-sm">📡 账号管理</h2>
                 <div class="flex gap-2">
                     <button onclick="toggleAccountList()" id="btn_toggle_list" class="text-[10px] bg-gray-100 px-2 py-0.5 rounded text-gray-600">👁️ 显示/隐藏列表</button>
                     <button onclick="toggleAddForm()" class="text-[10px] bg-blue-50 text-blue-600 px-2 py-0.5 rounded">➕ 添加账号</button>
                 </div>
            </div>
            
            <div id="account_form" class="hidden bg-slate-50 p-3 mb-3 border rounded text-xs space-y-2">
                 <div class="flex gap-2">
                     <input id="in_alias" placeholder="备注" class="input-field w-1/3">
                     <input id="in_id" placeholder="Account ID" class="input-field w-2/3">
                 </div>
                 <input id="in_token" type="password" placeholder="API Token" class="input-field">
                 <div class="grid grid-cols-2 gap-2">
                    <input id="in_workers_cmliu" placeholder="🔴 CMliu Workers (逗号隔开)" class="input-field bg-red-50">
                    <input id="in_workers_joey" placeholder="🔵 Joey Workers (逗号隔开)" class="input-field bg-blue-50">
                 </div>
                 <button onclick="addAccount()" class="w-full bg-slate-700 text-white py-1 rounded font-bold hover:bg-slate-800">保存账号</button>
            </div>
       
            <div id="account_list_container" class="overflow-x-auto max-h-[400px]">
              <table class="w-full compact-table">
                <thead><tr><th>备注</th><th>Worker 分配</th><th class="text-right">操作</th></tr></thead>
                <tbody id="account_body"></tbody>
              </table>
            </div>
          </div>
      </div>

      <div class="lg:col-span-5 space-y-4">

        <div class="bg-white rounded shadow overflow-hidden border-t-4 border-red-500">
            <div class="bg-red-50 px-4 py-2 flex justify-between items-center border-b border-red-100">
                <span class="text-sm font-bold text-red-700">🔴 CMliu 配置</span>
                <span id="ver_cmliu" class="text-[10px] text-red-400 font-mono">Checking...</span>
            </div>
            <div class="p-3">
                <div id="vars_cmliu" class="space-y-1 mb-3 max-h-[150px] overflow-y-auto"></div>
                <div class="flex gap-2 mb-2">
                     <button onclick="addVarRow('cmliu')" class="flex-1 bg-dashed border border-gray-300 text-gray-500 text-xs py-1 rounded hover:bg-gray-50 hover:text-gray-700">➕ 添加自定义变量</button>
                </div>
                <div class="flex gap-2">
                     <button onclick="refreshUUID('cmliu')" class="flex-1 bg-gray-100 text-gray-600 text-xs py-1.5 rounded hover:bg-gray-200">🎲 刷 UUID</button>
                     <button onclick="deploy('cmliu')" id="btn_deploy_cmliu" class="flex-[2] bg-red-600 text-white text-xs py-1.5 rounded hover:bg-red-700 font-bold">🚀 部署 CMliu</button>
                </div>
            </div>
        </div>

        <div class="bg-white rounded shadow overflow-hidden border-t-4 border-blue-500">
            <div class="bg-blue-50 px-4 py-2 flex justify-between items-center border-b border-blue-100">
                <span class="text-sm font-bold text-blue-700">🔵 Joey 配置</span>
                <span id="ver_joey" class="text-[10px] text-blue-400 font-mono">Checking...</span>
            </div>
            <div class="p-3">
                <div id="vars_joey" class="space-y-1 mb-3 max-h-[150px] overflow-y-auto"></div>
                <div class="flex gap-2 mb-2">
                     <button onclick="addVarRow('joey')" class="flex-1 bg-dashed border border-gray-300 text-gray-500 text-xs py-1 rounded hover:bg-gray-50 hover:text-gray-700">➕ 添加自定义变量</button>
                </div>
                <div class="flex gap-2">
                     <button onclick="refreshUUID('joey')" class="flex-1 bg-gray-100 text-gray-600 text-xs py-1.5 rounded hover:bg-gray-200">🎲 刷 UUID</button>
                     <button onclick="deploy('joey')" id="btn_deploy_joey" class="flex-[2] bg-blue-600 text-white text-xs py-1.5 rounded hover:bg-blue-700 font-bold">🚀 部署 Joey</button>
                </div>
            </div>
        </div>

      </div>
    </div>
    
    <div id="logs" class="bg-slate-900 text-green-400 p-3 rounded text-xs font-mono hidden max-h-40 overflow-y-auto shadow-inner mt-4"></div>
  </div>

  <script>
    const TEMPLATES = {
      'cmliu': { defaultVars: ["UUID", "PROXYIP", "PATH", "URL", "KEY", "ADMIN"], uuidField: "UUID" },
      'joey':  { defaultVars: ["u", "d"], uuidField: "u" }
    };
    let accounts = [];

    async function init() {
        await loadAccounts();
        await Promise.all([
            loadVars('cmliu'),
            loadVars('joey'),
            loadGlobalConfig(),
            loadStats()
        ]);
        checkUpdate('cmliu');
        checkUpdate('joey');
    }

    function timeAgo(dateString) {
        if(!dateString) return "无记录";
        const date = new Date(dateString);
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds > 86400) return Math.floor(seconds/86400) + "天前";
        if (seconds > 3600) return Math.floor(seconds/3600) + "小时前";
        if (seconds > 60) return Math.floor(seconds/60) + "分钟前";
        return "刚刚";
    }

    async function loadAccounts() {
        try {
            const res = await fetch('/api/accounts');
            accounts = await res.json();
            renderAccounts();
        } catch(e) { console.error(e); }
    }

    function renderAccounts() {
        const tb = document.getElementById('account_body');
        if(accounts.length === 0) tb.innerHTML = '<tr><td colspan="3" class="text-center text-gray-300 py-4">暂无账号</td></tr>';
        else tb.innerHTML = accounts.map((a,i) => \`
            <tr class="hover:bg-gray-50">
                <td>\${a.alias}</td>
                <td>
                    \${(a.workers_cmliu||[]).map(w=>\`<span class="text-red-600 bg-red-50 border border-red-100 px-1 rounded text-[10px] mr-1">\${w}</span>\`).join('')}
                    \${(a.workers_joey||[]).map(w=>\`<span class="text-blue-600 bg-blue-50 border border-blue-100 px-1 rounded text-[10px] mr-1">\${w}</span>\`).join('')}
                </td>
                <td class="text-right">
                    <button onclick="delAccount(\${i})" class="text-red-500 hover:text-red-700">×</button>
                </td>
            </tr>
        \`).join('');
    }

    async function loadStats() {
        const tb = document.getElementById('stats_body');
        const btn = document.getElementById('btn_stats');
        btn.innerText = '...';
        try {
            const res = await fetch('/api/stats');
            const data = await res.json();
            if(data.length === 0) { tb.innerHTML = '<tr><td colspan="3" class="text-center text-gray-300">无数据</td></tr>'; return; }
            
            data.sort((a, b) => (b.total || 0) - (a.total || 0));

            tb.innerHTML = data.map(item => {
                if(item.error) return \`<tr><td class="text-red-500" colspan="3">\${item.alias}: \${item.error}</td></tr>\`;
                const percent = Math.min((item.total / item.max) * 100, 100).toFixed(1);
                let color = 'text-green-600';
                if(percent > 80) color = 'text-orange-500';
                if(percent >= 100) color = 'text-red-600 font-bold';
                return \`
                    <tr>
                        <td class="font-medium">\${item.alias}</td>
                        <td class="font-mono text-gray-600">\${item.total.toLocaleString()} / \${item.max.toLocaleString()}</td>
                        <td class="\${color}">\${percent}%</td>
                    </tr>
                \`;
            }).join('');
        } catch(e) { tb.innerHTML = '<tr><td colspan="3" class="text-red-500">加载失败</td></tr>'; }
        btn.innerText = '🔄 刷新';
    }

    async function loadGlobalConfig() {
        try {
            const res = await fetch('/api/auto_config');
            const cfg = await res.json();
            document.getElementById('auto_update_toggle').checked = !!cfg.enabled;
            document.getElementById('auto_update_interval').value = cfg.interval || 30;
            document.getElementById('auto_update_unit').value = cfg.unit || 'minutes';
            document.getElementById('fuse_threshold').value = cfg.fuseThreshold || 0;
        } catch(e) {}
    }

    async function saveAutoConfig() {
        const enabled = document.getElementById('auto_update_toggle').checked;
        const interval = parseInt(document.getElementById('auto_update_interval').value);
        const unit = document.getElementById('auto_update_unit').value;
        const fuseThreshold = parseInt(document.getElementById('fuse_threshold').value);
        await fetch('/api/auto_config', { method: 'POST', body: JSON.stringify({ enabled, interval, unit, fuseThreshold }) });
        alert('✅ 全局设置已保存');
    }

    // 变量管理核心函数
    async function loadVars(type) {
        const container = document.getElementById(\`vars_\${type}\`);
        container.innerHTML = '<div class="text-gray-300 text-center py-2">加载中...</div>';
        try {
            const res = await fetch(\`/api/settings?type=\${type}\`);
            const savedVars = await res.json();
            const defaults = TEMPLATES[type].defaultVars;
            const uuidKey = TEMPLATES[type].uuidField;
            
            // 数据合并逻辑
            const varMap = new Map();
            if(Array.isArray(savedVars)) savedVars.forEach(v => varMap.set(v.key, v.value));
            
            defaults.forEach(k => {
                if(!varMap.has(k)) varMap.set(k, k === uuidKey ? crypto.randomUUID() : '');
            });
            
            container.innerHTML = ''; // 清空加载状态
            varMap.forEach((v, k) => {
                addVarRow(type, k, v, true); // true 表示是初始加载的
            });
        } catch(e) { container.innerHTML = '加载失败'; }
    }

    // 新增：添加变量行 (支持自定义 Key)
    function addVarRow(type, key = '', val = '', isLoaded = false) {
        const container = document.getElementById(\`vars_\${type}\`);
        const div = document.createElement('div');
        div.className = \`flex gap-1 items-center mb-1 var-row-\${type}\`;
        
        div.innerHTML = \`
            <input class="input-field w-1/3 var-key font-bold text-gray-700" placeholder="Key" value="\${key}">
            <input class="input-field w-2/3 var-val" placeholder="Value" value="\${val}">
            <button onclick="this.parentElement.remove()" class="text-gray-400 hover:text-red-500 px-1 font-bold">×</button>
        \`;
        container.appendChild(div);
    }

    async function deploy(type) {
        const btn = document.getElementById(\`btn_deploy_\${type}\`);
        const originalText = btn.innerText;
        btn.disabled = true; btn.innerText = "⏳ 部署中...";
        
        const rows = document.querySelectorAll(\`.var-row-\${type}\`);
        const variables = [];
        rows.forEach(r => {
            const k = r.querySelector('.var-key').value.trim();
            const v = r.querySelector('.var-val').value.trim();
            if(k) variables.push({ key: k, value: v });
        });

        await fetch(\`/api/settings?type=\${type}\`, { method: 'POST', body: JSON.stringify(variables) });

        const logBox = document.getElementById('logs');
        logBox.classList.remove('hidden');
        logBox.innerHTML = \`<div class="text-yellow-400">⚡ 正在部署 \${type} ...</div>\`;
        
        try {
            const res = await fetch(\`/api/deploy?type=\${type}\`, { method: 'POST', body: JSON.stringify({variables}) });
            const logs = await res.json();
            logBox.innerHTML += logs.map(l => \`<div>[\${l.success ? 'OK' : 'ERR'}] \${l.name}: <span class="text-gray-400">\${l.msg}</span></div>\`).join('');
            setTimeout(() => checkUpdate(type), 1000);
        } catch(e) { logBox.innerHTML += \`<div class="text-red-500">❌ 系统错误: \${e.message}</div>\`; }
        
        btn.disabled = false; btn.innerText = originalText;
    }

    async function checkUpdate(type) {
        const el = document.getElementById(\`ver_\${type}\`);
        try {
            const res = await fetch(\`/api/check_update?type=\${type}\`);
            const d = await res.json();
            if(d.remote && (!d.local || d.remote.sha !== d.local.sha)) {
                el.innerHTML = '<span class="text-red-500 font-bold animate-pulse">🔴 有更新</span>';
            } else {
                const ago = d.local ? timeAgo(d.local.deployDate) : "无记录";
                el.innerHTML = \`<span class="text-green-600">✅ 已是最新 (\${ago})</span>\`;
            }
        } catch(e) { el.innerText = '状态获取失败'; }
    }

    function refreshUUID(type) {
        const key = TEMPLATES[type].uuidField;
        const rows = document.querySelectorAll(\`.var-row-\${type}\`);
        rows.forEach(r => {
            const k = r.querySelector('.var-key').value;
            if(k === key) {
                const input = r.querySelector('.var-val');
                input.value = crypto.randomUUID();
                input.classList.add('bg-green-100');
                setTimeout(()=>input.classList.remove('bg-green-100'), 500);
            }
        });
    }

    function toggleAddForm() {
        document.getElementById('account_form').classList.toggle('hidden');
    }
    
    function toggleAccountList() {
        document.getElementById('account_list_container').classList.toggle('hidden');
    }

    async function addAccount() {
        const alias = document.getElementById('in_alias').value;
        const id = document.getElementById('in_id').value;
        const token = document.getElementById('in_token').value;
        const cW = document.getElementById('in_workers_cmliu').value.split(/,|，/).filter(x=>x);
        const jW = document.getElementById('in_workers_joey').value.split(/,|，/).filter(x=>x);
        
        if(!id || !token) return alert('ID/Token 必填');
        accounts.push({ alias, accountId: id, apiToken: token, workers_cmliu: cW, workers_joey: jW });
        await fetch('/api/accounts', { method: 'POST', body: JSON.stringify(accounts) });
        renderAccounts();
        document.getElementById('account_form').classList.add('hidden');
    }

    async function delAccount(i) {
        if(!confirm('删除此账号?')) return;
        accounts.splice(i, 1);
        await fetch('/api/accounts', { method: 'POST', body: JSON.stringify(accounts) });
        renderAccounts();
    }

    init();
  </script>
</body></html>
  `;
}
