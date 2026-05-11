/**
 * Cloudflare Worker 多项目部署管理器 (V10.10.0)
 * 更新日志 (V10.10.0)：
 * 1. [Feature] 首创 YXIP 面向 Joey 底层的双轨分发策略，兼顾 KV 数据流强管与纯变量下发兼容模式。
 * 完整历史版本记录见 CHANGELOG.md
 */

// ==========================================
// 1. 后端配置与逻辑
// ==========================================
const TEMPLATES = {
    'cmliu': {
        name: "CMliu - EdgeTunnel",
        ghUser: "cmliu",
        ghRepo: "edgetunnel",
        ghBranch: "main",
        ghPath: "_worker.js",
        defaultVars: ["UUID", "PROXYIP", "DOH", "PATH", "URL", "KEY", "ADMIN"],
        uuidField: "UUID",
        description: "CMliu (beta2.0) - 建议开启 KV"
    },
    'joey': {
        name: "Joey - 少年你相信光吗",
        ghUser: "byJoey",
        ghRepo: "cfnew",
        ghBranch: "main",
        ghPath: "少年你相信光吗",
        defaultVars: ["u"],
        uuidField: "u",
        description: "Joey (自动修复) - KV 可选"
    },
    'ech': {
        name: "ECH - WebSocket Proxy",
        ghUser: "hc990275",
        ghRepo: "ech-wk",
        ghBranch: "main",
        ghPath: "_worker.js",
        defaultVars: ["PROXYIP"],
        uuidField: "",
        description: "ECH (无需频繁更新)"
    }
};

const ECH_PROXIES = [
    { group: "Global", list: ["ProxyIP.CMLiussss.net", "ProxyIP.Aliyun.CMLiussss.net", "ProxyIP.Oracle.CMLiussss.net"] },
    { group: "HK (香港)", list: ["ProxyIP.HK.CMLiussss.net", "ProxyIP.Aliyun.HK.CMLiussss.net", "ProxyIP.Oracle.HK.CMLiussss.net"] },
    { group: "JP (日本)", list: ["ProxyIP.JP.CMLiussss.net", "ProxyIP.Aliyun.JP.CMLiussss.net", "ProxyIP.Oracle.JP.CMLiussss.net"] },
    { group: "SG (新加坡)", list: ["ProxyIP.SG.CMLiussss.net", "ProxyIP.Aliyun.SG.CMLiussss.net", "ProxyIP.Oracle.SG.CMLiussss.net"] },
    { group: "KR (韩国)", list: ["ProxyIP.KR.CMLiussss.net", "ProxyIP.Oracle.KR.CMLiussss.net"] },
    { group: "US (美国)", list: ["ProxyIP.US.CMLiussss.net", "ProxyIP.Aliyun.US.CMLiussss.net", "ProxyIP.Oracle.US.CMLiussss.net"] },
    { group: "Europe", list: ["ProxyIP.DE.CMLiussss.net (德国)", "ProxyIP.UK.CMLiussss.net (英国)", "ProxyIP.FR.CMLiussss.net (法国)", "ProxyIP.NL.CMLiussss.net (荷兰)", "ProxyIP.RU.CMLiussss.net (俄罗斯)"] },
    { group: "Others", list: ["ProxyIP.TW.CMLiussss.net (台湾)", "ProxyIP.AU.CMLiussss.net (澳洲)", "ProxyIP.IN.CMLiussss.net (印度)"] }
];

export default {
    async scheduled(event, env, ctx) {
        if (env.CONFIG_KV) {
            ctx.waitUntil(handleCronJob(env));
        }
    },

    async fetch(request, env) {
        try {
            if (!env.CONFIG_KV) {
                return new Response(`KV Not Bound (Error 1001)`, { status: 500 });
            }

            const url = new URL(request.url);
            const correctCode = env.ACCESS_CODE;
            const cookieHeader = request.headers.get("Cookie") || "";

            // 公开路由（无需认证）
            if (url.pathname === "/manifest.json") {
                return new Response(JSON.stringify({
                    "name": "Worker Pro", "short_name": "WorkerPro", "start_url": "/", "display": "standalone",
                    "background_color": "#f3f4f6", "theme_color": "#1e293b",
                    "icons": [{ "src": "https://www.cloudflare.com/img/logo-cloudflare-dark.svg", "sizes": "192x192", "type": "image/svg+xml" }]
                }), { headers: { "Content-Type": "application/json" } });
            }

            // 登录接口（POST 安全提交）
            if (url.pathname === "/api/login" && request.method === "POST") {
                const body = await request.json();
                if (body.code === correctCode) {
                    return new Response(JSON.stringify({ success: true }), {
                        headers: { "Content-Type": "application/json", "Set-Cookie": `auth=${correctCode}; Path=/; HttpOnly; Secure; Max-Age=86400; SameSite=Lax` }
                    });
                }
                return new Response(JSON.stringify({ success: false, msg: "密码错误" }), { status: 401, headers: { "Content-Type": "application/json" } });
            }

            // 认证检查（仅 Cookie，不再通过 URL 传递密码）
            if (correctCode && !cookieHeader.includes(`auth=${correctCode}`)) {
                return new Response(loginHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
            }

            // CSRF 防护（POST 请求校验 Origin）
            if (request.method === "POST") {
                const origin = request.headers.get("Origin");
                if (origin && new URL(origin).host !== url.host) {
                    return new Response(JSON.stringify({ success: false, msg: "CSRF rejected" }), { status: 403, headers: { "Content-Type": "application/json" } });
                }
            }

            const ACCOUNTS_KEY = `ACCOUNTS_UNIFIED_STORAGE`;
            const GLOBAL_CONFIG_KEY = `AUTO_UPDATE_CFG_GLOBAL`;

            // API 路由
            if (url.pathname === "/api/accounts") {
                if (request.method === "GET") return new Response(await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]", { headers: { "Content-Type": "application/json" } });
                if (request.method === "POST") { await env.CONFIG_KV.put(ACCOUNTS_KEY, JSON.stringify(await request.json())); return new Response(JSON.stringify({ success: true })); }
            }
            if (url.pathname === "/api/settings") {
                const type = url.searchParams.get("type");
                const VARS_KEY = `VARS_${type}`;
                if (request.method === "GET") return new Response(await env.CONFIG_KV.get(VARS_KEY) || "null", { headers: { "Content-Type": "application/json" } });
                if (request.method === "POST") { await env.CONFIG_KV.put(VARS_KEY, JSON.stringify(await request.json())); return new Response(JSON.stringify({ success: true })); }
            }
            if (url.pathname === "/api/deploy_config" && request.method === "GET") {
                const type = url.searchParams.get("type");
                const key = `DEPLOY_CONFIG_${type}`;
                const defaultCfg = { mode: 'latest', currentSha: null, deployTime: null };
                return new Response(await env.CONFIG_KV.get(key) || JSON.stringify(defaultCfg), { headers: { "Content-Type": "application/json" } });
            }
            if (url.pathname === "/api/favorites") {
                const type = url.searchParams.get("type");
                const key = `FAVORITES_${type}`;
                if (request.method === "GET") return new Response(await env.CONFIG_KV.get(key) || "[]", { headers: { "Content-Type": "application/json" } });
                if (request.method === "POST") {
                    const { action, item } = await request.json();
                    let favs = JSON.parse(await env.CONFIG_KV.get(key) || "[]");
                    if (action === 'add') { if (!favs.find(f => f.sha === item.sha)) favs.unshift(item); }
                    else if (action === 'remove') { favs = favs.filter(f => f.sha !== item.sha); }
                    await env.CONFIG_KV.put(key, JSON.stringify(favs));
                    return new Response(JSON.stringify({ success: true, favorites: favs }), { headers: { "Content-Type": "application/json" } });
                }
            }
            if (url.pathname === "/api/auto_config") {
                if (request.method === "GET") return new Response(await env.CONFIG_KV.get(GLOBAL_CONFIG_KEY) || "{}", { headers: { "Content-Type": "application/json" } });
                if (request.method === "POST") {
                    const body = await request.json();
                    await env.CONFIG_KV.put(GLOBAL_CONFIG_KEY, JSON.stringify(body));
                    return new Response(JSON.stringify({ success: true }));
                }
            }
            if (url.pathname === "/api/check_update" && request.method === "GET") {
                const type = url.searchParams.get("type");
                const mode = url.searchParams.get("mode");
                const limitStr = url.searchParams.get("limit");
                const limit = limitStr ? parseInt(limitStr) : 10;
                return await handleCheckUpdate(env, type, mode, limit);
            }
            if (url.pathname === "/api/get_code" && request.method === "GET") {
                const type = url.searchParams.get("type");
                return await handleGetCode(env, type);
            }
            if (url.pathname === "/api/deploy" && request.method === "POST") {
                const { type, variables, deletedVariables, targetSha, customCode, echTokenEnabled, echDisableWorkersDev, targetAccountIds } = await request.json();
                return await handleManualDeploy(env, type, variables, deletedVariables, ACCOUNTS_KEY, targetSha, customCode, echTokenEnabled, echDisableWorkersDev, targetAccountIds);
            }
            if (url.pathname === "/api/batch_deploy" && request.method === "POST") {
                const data = await request.json();
                return await handleBatchDeploy(env, data, ACCOUNTS_KEY);
            }
            if (url.pathname === "/api/zones" && request.method === "POST") {
                const { accountId, email, globalKey } = await request.json();
                return await handleGetZones(accountId, email, globalKey);
            }
            if (url.pathname === "/api/all_workers" && request.method === "POST") {
                const { accountId, email, globalKey } = await request.json();
                return await handleGetAllWorkers(accountId, email, globalKey);
            }
            if (url.pathname === "/api/delete_worker" && request.method === "POST") {
                const { accountId, email, globalKey, workerName, deleteKv } = await request.json();
                return await handleDeleteWorker(env, accountId, email, globalKey, workerName, deleteKv);
            }
            if (url.pathname === "/api/stats" && request.method === "GET") return await handleStats(env, ACCOUNTS_KEY);
            if (url.pathname === "/api/fetch_bindings" && request.method === "POST") {
                const { accountId, email, globalKey, workerName } = await request.json();
                return await handleFetchBindings(accountId, email, globalKey, workerName);
            }
            if (url.pathname === "/api/get_subdomain" && request.method === "POST") {
                const { accountId, email, globalKey } = await request.json();
                return await handleGetSubdomain(accountId, email, globalKey);
            }
            if (url.pathname === "/api/change_subdomain" && request.method === "POST") {
                const { accountId, email, globalKey, newSubdomain } = await request.json();
                return await handleChangeSubdomain(accountId, email, globalKey, newSubdomain);
            }
            if (url.pathname === "/api/fix_1101" && request.method === "POST") {
                const { type } = await request.json();
                return await handleFix1101(env, type);
            }
            if (url.pathname === "/api/get_regions_data" && request.method === "GET") {
                return await handleGetRegionsData();
            }
            if (url.pathname === "/api/save_yxip" && request.method === "POST") {
                const data = await request.json();
                return await handleSaveYxip(env, data, ACCOUNTS_KEY);
            }

            return new Response(mainHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

        } catch (err) {
            return new Response(JSON.stringify({ success: false, msg: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }
};

// ================= 后端辅助函数 =================

function getGithubUrls(type, sha = null) {
    const t = TEMPLATES[type];
    const safePath = t.ghPath.split('/').map(p => encodeURIComponent(p)).join('/');
    const apiUrl = `https://api.github.com/repos/${t.ghUser}/${t.ghRepo}/commits`;
    const ref = sha || t.ghBranch;
    const scriptUrl = `https://raw.githubusercontent.com/${t.ghUser}/${t.ghRepo}/${ref}/${safePath}`;
    return { apiUrl, scriptUrl, branch: t.ghBranch };
}

function getAuthHeaders(email, key) {
    return { "X-Auth-Email": email, "X-Auth-Key": key, "Content-Type": "application/json" };
}

function getUploadHeaders(email, key) {
    return { "X-Auth-Email": email, "X-Auth-Key": key };
}



async function handleCronJob(env) {
    const ACCOUNTS_KEY = `ACCOUNTS_UNIFIED_STORAGE`;
    const GLOBAL_CONFIG_KEY = `AUTO_UPDATE_CFG_GLOBAL`;
    const configStr = await env.CONFIG_KV.get(GLOBAL_CONFIG_KEY);
    if (!configStr) return;
    const config = JSON.parse(configStr);
    if (!config.enabled) return;

    const now = Date.now();
    const lastCheck = config.lastCheck || 0;
    const intervalMs = (parseInt(config.interval) || 30) * 60 * 1000;


    if (now - lastCheck <= intervalMs) return;

    const accounts = JSON.parse(await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]");
    if (accounts.length === 0) return;

    const statsData = await fetchInternalStats(accounts);
    let actionTaken = false;

    const fuseThreshold = parseInt(config.fuseThreshold || 0);
    if (fuseThreshold > 0) {
        for (const acc of accounts) {
            const stat = statsData.find(s => s.alias === acc.alias);
            if (!stat || stat.error) continue;
            const limit = stat.max || 100000;
            // [熔断触发] 超过阈值
            if ((stat.total / limit) * 100 >= fuseThreshold) {
                // 动态识别需要熔断的模板（拥有 uuidField 的模板）
                const fuseTypes = Object.entries(TEMPLATES).filter(([_, t]) => t.uuidField).map(([k]) => k);
                for (const ft of fuseTypes) {
                    await rotateUUIDAndDeploy(env, ft, accounts, ACCOUNTS_KEY);
                }
                actionTaken = true;
                break;
            }
        }
    }

    if (!actionTaken) {
        // [自动更新] 动态识别模板
        const updateTypes = Object.entries(TEMPLATES).filter(([_, t]) => t.uuidField).map(([k]) => k);
        await Promise.all(updateTypes.map(type =>
            checkAndDeployUpdate(env, type, accounts, ACCOUNTS_KEY)
        ));
    }

    config.lastCheck = now;
    await env.CONFIG_KV.put(GLOBAL_CONFIG_KEY, JSON.stringify(config));
}

async function checkAndDeployUpdate(env, type, accounts, accountsKey) {
    try {
        const deployConfig = JSON.parse(await env.CONFIG_KV.get(`DEPLOY_CONFIG_${type}`) || '{"mode":"latest"}');
        if (deployConfig.mode === 'fixed') return;

        const res = await handleCheckUpdate(env, type, 'latest');
        const checkData = await res.json();

        if (checkData.remote && (!checkData.local || checkData.remote.sha !== checkData.local.sha)) {
            const varsStr = await env.CONFIG_KV.get(`VARS_${type}`);
            const variables = varsStr ? JSON.parse(varsStr) : [];
            await coreDeployLogic(env, type, variables, [], accountsKey, 'latest');
        }
    } catch (e) { console.error(`[Update Error] ${type}: ${e.message}`); }
}

async function rotateUUIDAndDeploy(env, type, accounts, accountsKey) {
    const VARS_KEY = `VARS_${type}`;
    const varsStr = await env.CONFIG_KV.get(VARS_KEY);
    let variables = varsStr ? JSON.parse(varsStr) : [];
    const uuidField = TEMPLATES[type].uuidField;
    if (!uuidField) return;

    let uuidUpdated = false;
    variables = variables.map(v => {
        if (v.key === uuidField) { v.value = crypto.randomUUID(); uuidUpdated = true; }
        return v;
    });
    if (!uuidUpdated) variables.push({ key: uuidField, value: crypto.randomUUID() });
    await env.CONFIG_KV.put(VARS_KEY, JSON.stringify(variables));

    const deployConfig = JSON.parse(await env.CONFIG_KV.get(`DEPLOY_CONFIG_${type}`) || '{"mode":"latest"}');
    const targetSha = deployConfig.mode === 'fixed' ? deployConfig.currentSha : 'latest';
    await coreDeployLogic(env, type, variables, [], accountsKey, targetSha);
}

async function handleGetCode(env, type) {
    try {
        const { scriptUrl } = getGithubUrls(type);
        const res = await fetch(scriptUrl);
        if (!res.ok) throw new Error("Fetch failed: " + res.status);
        const code = await res.text();
        return new Response(JSON.stringify({ success: true, code: code }), { headers: { "Content-Type": "application/json" } });
    } catch (e) { return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500 }); }
}

async function handleCheckUpdate(env, type, mode, limit = 10) {
    try {
        const DEPLOY_CONFIG_KEY = `DEPLOY_CONFIG_${type}`;
        const deployConfig = JSON.parse(await env.CONFIG_KV.get(DEPLOY_CONFIG_KEY) || '{"mode":"latest"}');
        const localSha = deployConfig.currentSha;
        const localTime = deployConfig.deployTime;
        const { apiUrl, branch } = getGithubUrls(type);

        let fetchUrl = apiUrl + (mode === 'history' ? `?sha=${branch}&per_page=${limit}` : `?sha=${branch}&per_page=1`);
        const headers = { "User-Agent": "Cloudflare-Worker-Manager" };
        if (env.GITHUB_TOKEN) headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;

        const ghRes = await fetch(fetchUrl + `&t=${Date.now()}`, { headers });
        if (!ghRes.ok) throw new Error(`GitHub API Error: ${ghRes.status}`);
        const ghData = await ghRes.json();

        if (mode === 'history') return new Response(JSON.stringify({ history: ghData }), { headers: { "Content-Type": "application/json" } });

        const latestCommit = Array.isArray(ghData) ? ghData[0] : ghData;
        let localCommitInfo = null;
        if (localSha) {
            if (localSha === latestCommit.sha) {
                localCommitInfo = { sha: localSha, date: latestCommit.commit.committer.date };
            } else {
                localCommitInfo = { sha: localSha, date: localTime };
            }
        }

        return new Response(JSON.stringify({
            local: localCommitInfo,
            remote: { sha: latestCommit.sha, date: latestCommit.commit.committer.date, message: latestCommit.commit.message },
            mode: deployConfig.mode
        }), { headers: { "Content-Type": "application/json" } });

    } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
}

async function handleManualDeploy(env, type, variables, deletedVariables, accountsKey, targetSha, customCode, echTokenEnabled, echDisableWorkersDev, targetAccountIds) {
    if (customCode) {
        const result = await coreDeployLogic(env, type, variables, deletedVariables, accountsKey, targetSha, customCode, echTokenEnabled, echDisableWorkersDev, targetAccountIds);
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    }
    const result = await coreDeployLogic(env, type, variables, deletedVariables, accountsKey, targetSha, null, echTokenEnabled, echDisableWorkersDev, targetAccountIds);
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
}

async function handleBatchDeploy(env, reqData, accountsKey) {
    const { template, workerName, kvName, config, targetAccounts, disableWorkersDev, customDomainPrefix, enableKV, savedVars } = reqData;
    const allAccounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");

    const accountsToDeploy = allAccounts.filter(a => targetAccounts.includes(a.alias));
    if (accountsToDeploy.length === 0) return new Response(JSON.stringify([{ name: "错误", success: false, msg: "未选择有效账号" }]), { headers: { "Content-Type": "application/json" } });

    let scriptContent = "";
    const { scriptUrl } = getGithubUrls(template);
    try {
        const codeRes = await fetch(scriptUrl);
        if (!codeRes.ok) throw new Error("代码拉取失败");
        scriptContent = await codeRes.text();
        if (template === 'joey') scriptContent = 'var window = globalThis;\n' + scriptContent;
    } catch (e) {
        return new Response(JSON.stringify([{ name: "网络错误", success: false, msg: e.message }]), { headers: { "Content-Type": "application/json" } });
    }

    const logs = [];
    let updatedAccounts = false;

    for (const acc of accountsToDeploy) {
        const log = { name: `${acc.alias} -> [${workerName}]`, success: false, msg: "" };
        try {
            const jsonHeaders = getAuthHeaders(acc.email, acc.globalKey);

            let nsId = "";
            if (enableKV) {
                const nsListRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/storage/kv/namespaces?per_page=100`, { headers: jsonHeaders });
                if (!nsListRes.ok) throw new Error("无法读取KV列表");
                const nsList = (await nsListRes.json()).result;
                const existNs = nsList.find(n => n.title === kvName);
                if (existNs) { nsId = existNs.id; } else {
                    const createNsRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/storage/kv/namespaces`, {
                        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: kvName })
                    });
                    if (!createNsRes.ok) throw new Error("创建KV失败: " + (await createNsRes.json()).errors[0].message);
                    nsId = (await createNsRes.json()).result.id;
                }
            }

            const bindings = [];
            if (enableKV && nsId) {
                if (template === 'cmliu') bindings.push({ name: "KV", type: "kv_namespace", namespace_id: nsId });
                if (template === 'joey') bindings.push({ name: "C", type: "kv_namespace", namespace_id: nsId });
            }

            // 如果前端传了已保存变量，优先使用
            if (savedVars && Array.isArray(savedVars) && savedVars.length > 0) {
                savedVars.forEach(v => {
                    if (v.key && !bindings.find(b => b.name === v.key)) {
                        bindings.push({ name: v.key, type: "plain_text", text: v.value || "" });
                    }
                });
            } else {
                // 回退到 config 配置
                if (config.admin) bindings.push({ name: "ADMIN", type: "plain_text", text: config.admin });
                if (template === 'joey' && config.uuid) bindings.push({ name: "u", type: "plain_text", text: config.uuid });

                const defaultVars = TEMPLATES[template].defaultVars;
                defaultVars.forEach(key => {
                    if (key !== 'KV' && key !== 'C' && key !== 'ADMIN' && key !== 'u') {
                        if (key === 'UUID') {
                            bindings.push({ name: "UUID", type: "plain_text", text: config.uuid || crypto.randomUUID() });
                        } else {
                            bindings.push({ name: key, type: "plain_text", text: "" });
                        }
                    }
                });
            }

            const metadata = { main_module: "index.js", bindings: bindings, compatibility_date: new Date().toISOString().split('T')[0] };
            const formData = new FormData();
            formData.append("metadata", JSON.stringify(metadata));
            formData.append("script", new Blob([scriptContent], { type: "application/javascript+module" }), "index.js");

            const uploadHeaders = getUploadHeaders(acc.email, acc.globalKey);
            const deployRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/scripts/${workerName}`, {
                method: "PUT", headers: uploadHeaders, body: formData
            });

            if (deployRes.ok) {
                log.success = true;
                let msgs = [];
                if (customDomainPrefix && acc.defaultZoneId && acc.defaultZoneName) {
                    const hostname = `${customDomainPrefix}.${acc.defaultZoneName}`;
                    const domainRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/domains`, {
                        method: "PUT", headers: jsonHeaders,
                        body: JSON.stringify({ hostname: hostname, service: workerName, zone_id: acc.defaultZoneId })
                    });
                    if (domainRes.ok) msgs.push(`✅ 绑定: https://${hostname}`);
                    else msgs.push(`⚠️ 域名绑定失败`);
                }
                if (disableWorkersDev) {
                    await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/scripts/${workerName}/subdomain`, {
                        method: "POST", headers: jsonHeaders, body: JSON.stringify({ enabled: false })
                    });
                    msgs.push(`🚫 默认域名已禁用`);
                } else {
                    await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/scripts/${workerName}/subdomain`, {
                        method: "POST", headers: jsonHeaders, body: JSON.stringify({ enabled: true })
                    });
                    const subRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/subdomain`, { headers: jsonHeaders });
                    const prefix = (await subRes.json()).result?.subdomain || "unknown";
                    msgs.push(`✅ 默认: https://${workerName}.${prefix}.workers.dev`);
                }
                log.msg = msgs.join(" | ");
                if (!acc[`workers_${template}`]) acc[`workers_${template}`] = [];
                if (!acc[`workers_${template}`].includes(workerName)) {
                    acc[`workers_${template}`].push(workerName);
                    updatedAccounts = true;
                }
            } else {
                log.msg = `❌ ${(await deployRes.json()).errors?.[0]?.message}`;
            }
        } catch (e) { log.msg = `❌ ${e.message}`; }
        logs.push(log);
    }

    if (updatedAccounts) {
        const finalAccounts = allAccounts.map(a => {
            const updated = accountsToDeploy.find(u => u.alias === a.alias);
            return updated ? updated : a;
        });
        await env.CONFIG_KV.put(accountsKey, JSON.stringify(finalAccounts));
    }
    return new Response(JSON.stringify(logs), { headers: { "Content-Type": "application/json" } });
}

// 核心部署逻辑
async function coreDeployLogic(env, type, variables, deletedVariables, accountsKey, targetSha, customCode = null, echTokenEnabled = false, echDisableWorkersDev = false, targetAccountIds = null) {
    try {
        // 规范化：'latest' 和空值统一视为“跟随最新”
        const isLatestMode = !targetSha || targetSha === 'latest';
        const shaForFetch = isLatestMode ? null : targetSha;

        let accounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");
        if (targetAccountIds && targetAccountIds.length > 0) {
            accounts = accounts.filter(a => targetAccountIds.includes(a.accountId));
        }
        if (accounts.length === 0) return [{ name: "提示", success: false, msg: "无账号配置" }];

        let githubScriptContent = "";
        let deployedSha = shaForFetch;

        if (customCode) {
            // 前端已提供混淆后的代码，直接使用
            githubScriptContent = customCode;
            if (!deployedSha) {
                // 获取最新 commit SHA
                const { apiUrl } = getGithubUrls(type, null);
                const headers = { "User-Agent": "CF-Worker" };
                if (env.GITHUB_TOKEN) headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
                try {
                    const apiRes = await fetch(apiUrl + `?sha=${TEMPLATES[type].ghBranch}&per_page=1`, { headers });
                    if (apiRes.ok) deployedSha = (await apiRes.json())[0].sha;
                } catch (e) { }
            }
        } else {
            // 从 GitHub 下载代码
            const { scriptUrl, apiUrl } = getGithubUrls(type, shaForFetch);
            try {
                const codeRes = await fetch(scriptUrl + `?t=${Date.now()}`);
                if (!codeRes.ok) throw new Error(`代码下载失败: ${codeRes.status}`);
                githubScriptContent = await codeRes.text();

                if (!deployedSha) {
                    const headers = { "User-Agent": "CF-Worker" };
                    if (env.GITHUB_TOKEN) headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
                    const apiRes = await fetch(apiUrl + `?sha=${TEMPLATES[type].ghBranch}&per_page=1`, { headers });
                    if (apiRes.ok) {
                        const commitData = (await apiRes.json())[0];
                        deployedSha = commitData.sha;
                    }
                }
            } catch (e) { return [{ name: "网络错误", success: false, msg: e.message }]; }
        }

        if (type === 'joey') githubScriptContent = 'var window = globalThis;\n' + githubScriptContent;
        if (type === 'ech') {
            const proxyVar = variables ? variables.find(v => v.key === 'PROXYIP') : null;
            const targetIP = proxyVar && proxyVar.value ? proxyVar.value.trim() : 'ProxyIP.CMLiussss.net';
            const proxyRegex = /const\s+CF_FALLBACK_IPS\s*=\s*\[.*?\];/s;
            githubScriptContent = githubScriptContent.replace(proxyRegex, `const CF_FALLBACK_IPS = ['${targetIP}'];`);

            // Token 注入：仅当 TOKEN 变量存在、有值且 echTokenEnabled=true 时才注入
            const tokenVar = variables ? variables.find(v => v.key === 'TOKEN') : null;
            const tokenVal = (tokenVar && tokenVar.value && tokenVar.value.trim() && echTokenEnabled)
                ? tokenVar.value.trim()
                : '';
            const tokenRegex = /const\s+token\s*=\s*['"]{1}.*?['"]{1};/;
            githubScriptContent = githubScriptContent.replace(tokenRegex, `const token = '${tokenVal}';`);
        }



        const logs = [];
        for (const acc of accounts) {
            const targetWorkers = acc[`workers_${type}`] || [];
            for (const wName of targetWorkers) {
                const logItem = { name: `${acc.alias} -> [${wName}]`, success: false, msg: "" };
                try {
                    const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/scripts/${wName}`;
                    const jsonHeaders = getAuthHeaders(acc.email, acc.globalKey);

                    const bindingsRes = await fetch(`${baseUrl}/bindings`, { headers: jsonHeaders });
                    let currentBindings = bindingsRes.ok ? (await bindingsRes.json()).result : [];
                    if (deletedVariables && deletedVariables.length > 0) currentBindings = currentBindings.filter(b => !deletedVariables.includes(b.name));

                    if (variables) {
                        variables.forEach(v => {
                            if (v.value && v.value.trim() !== "") {
                                const idx = currentBindings.findIndex(b => b.name === v.key);
                                if (idx !== -1) currentBindings[idx] = { name: v.key, type: "plain_text", text: v.value };
                                else currentBindings.push({ name: v.key, type: "plain_text", text: v.value });
                            }
                        });
                    }

                    const metadata = { main_module: "index.js", bindings: currentBindings, compatibility_date: new Date().toISOString().split('T')[0] };
                    const formData = new FormData();
                    formData.append("metadata", JSON.stringify(metadata));
                    formData.append("script", new Blob([githubScriptContent], { type: "application/javascript+module" }), "index.js");

                    const uploadHeaders = getUploadHeaders(acc.email, acc.globalKey);
                    const updateRes = await fetch(baseUrl, { method: "PUT", headers: uploadHeaders, body: formData });

                    if (updateRes.ok) {
                        logItem.success = true;
                        const msgs = [`✅ Ver: ${deployedSha ? deployedSha.substring(0, 7) : 'Unknown'}`];
                        // ECH 专属：控制 workers.dev 子域名启用/禁用
                        if (type === 'ech') {
                            try {
                                await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/scripts/${wName}/subdomain`, {
                                    method: 'POST', headers: jsonHeaders,
                                    body: JSON.stringify({ enabled: !echDisableWorkersDev })
                                });
                                msgs.push(echDisableWorkersDev ? '🚫 默认域名已禁用' : '🌐 默认域名已启用');
                            } catch (e) { msgs.push('⚠️ 域名状态设置失败'); }
                        }
                        logItem.msg = msgs.join(' | ');
                    } else {
                        logItem.msg = `❌ ${(await updateRes.json()).errors?.[0]?.message}`;
                    }
                } catch (err) { logItem.msg = `❌ ${err.message}`; }
                logs.push(logItem);
            }
        }

        // 仅在至少有一个 worker 成功部署时才更新 DEPLOY_CONFIG
        const hasSuccess = logs.some(l => l.success);
        if (hasSuccess) {
            const DEPLOY_CONFIG_KEY = `DEPLOY_CONFIG_${type}`;
            const mode = isLatestMode ? 'latest' : 'fixed';
            await env.CONFIG_KV.put(DEPLOY_CONFIG_KEY, JSON.stringify({ mode: mode, currentSha: deployedSha || 'unknown', deployTime: new Date().toISOString() }));
        }
        return logs;
    } catch (e) { return [{ name: "系统错误", success: false, msg: e.message }]; }
}

async function fetchInternalStats(accounts) {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const query = `query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
         viewer { accounts(filter: {accountTag: $AccountID}) {
             workersInvocationsAdaptive(limit: 10000, filter: $filter) { sum { requests } }
             pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
         }}}`;
    return await Promise.all(accounts.map(async (acc) => {
        try {
            const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
                method: "POST", headers: getAuthHeaders(acc.email, acc.globalKey),
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

async function handleStats(env, k) {
    try {
        const accounts = JSON.parse(await env.CONFIG_KV.get(k) || "[]");
        const results = await fetchInternalStats(accounts);
        return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
    } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
}

async function handleFetchBindings(accountId, email, key, workerName) {
    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/bindings`, {
            headers: getAuthHeaders(email, key)
        });
        const data = await res.json();
        const bindings = data.result
            .filter(b => b.type === "plain_text" || b.type === "secret_text")
            .map(b => ({ key: b.name, value: b.type === "plain_text" ? b.text : "" }));
        return new Response(JSON.stringify({ success: true, data: bindings }), { headers: { "Content-Type": "application/json" } });
    } catch (e) { return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500 }); }
}

async function handleGetZones(accountId, email, key) {
    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/zones?account.id=${accountId}&per_page=50`, {
            headers: getAuthHeaders(email, key)
        });
        const data = await res.json();
        const zones = data.result.map(z => ({ id: z.id, name: z.name }));
        return new Response(JSON.stringify({ success: true, zones: zones }), { headers: { "Content-Type": "application/json" } });
    } catch (e) { return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500 }); }
}

async function handleGetAllWorkers(accountId, email, key) {
    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`, {
            headers: getAuthHeaders(email, key)
        });
        const data = await res.json();
        const workers = data.result.map(w => ({
            id: w.id,
            created_on: w.created_on,
            modified_on: w.modified_on
        }));
        return new Response(JSON.stringify({ success: true, workers: workers }), { headers: { "Content-Type": "application/json" } });
    } catch (e) { return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500 }); }
}

async function handleDeleteWorker(env, accountId, email, key, workerName, deleteKv) {
    try {
        const headers = getAuthHeaders(email, key);

        let kvNamespaceIds = [];
        if (deleteKv) {
            const bindRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/bindings`, { headers });
            if (bindRes.ok) {
                const binds = (await bindRes.json()).result;
                kvNamespaceIds = binds.filter(b => b.type === 'kv_namespace').map(b => b.namespace_id);
            }
        }

        const delWorkerRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`, {
            method: "DELETE", headers
        });

        if (delWorkerRes.ok) {
            const ACCOUNTS_KEY = `ACCOUNTS_UNIFIED_STORAGE`;
            const accounts = JSON.parse(await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]");
            let updated = false;

            for (const acc of accounts) {
                if (acc.accountId === accountId) {
                    ['workers_cmliu', 'workers_joey', 'workers_ech'].forEach(type => {
                        if (acc[type] && acc[type].includes(workerName)) {
                            acc[type] = acc[type].filter(n => n !== workerName);
                            updated = true;
                        }
                    });
                }
            }

            if (updated) {
                await env.CONFIG_KV.put(ACCOUNTS_KEY, JSON.stringify(accounts));
            }

            if (deleteKv && kvNamespaceIds.length > 0) {
                await new Promise(r => setTimeout(r, 1000));
                for (const nsId of kvNamespaceIds) {
                    await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${nsId}`, {
                        method: "DELETE", headers
                    });
                }
            }
            return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
        } else {
            const err = await delWorkerRes.json();
            return new Response(JSON.stringify({ success: false, msg: err.errors[0]?.message || "删除失败" }), { status: 200 });
        }
    } catch (e) { return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500 }); }
}

async function handleGetSubdomain(accountId, email, key) {
    try {
        const headers = getAuthHeaders(email, key);
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { headers });
        const data = await res.json();
        if (data.success) {
            return new Response(JSON.stringify({ success: true, subdomain: data.result?.subdomain || '' }), { headers: { "Content-Type": "application/json" } });
        } else {
            return new Response(JSON.stringify({ success: false, msg: data.errors?.[0]?.message || '查询失败' }), { headers: { "Content-Type": "application/json" } });
        }
    } catch (e) { return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500 }); }
}

async function handleChangeSubdomain(accountId, email, key, newSubdomain) {
    try {
        const headers = getAuthHeaders(email, key);
        // Cloudflare API PUT subdomain 是 create-only，已有子域名需先 DELETE 再 PUT
        // 先尝试删除旧子域名（可能失败，忽略错误继续）
        try {
            await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
                method: 'DELETE', headers
            });
        } catch (e) { }
        // 创建新子域名
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ subdomain: newSubdomain })
        });
        const data = await res.json();
        if (data.success) {
            return new Response(JSON.stringify({ success: true, subdomain: data.result?.subdomain || newSubdomain }), { headers: { "Content-Type": "application/json" } });
        } else {
            const errMsg = data.errors?.[0]?.message || '修改失败';
            // 如果仍然报已存在，说明 CF 不支持通过 API 修改，提示用户去 Dashboard
            if (errMsg.includes('already has')) {
                return new Response(JSON.stringify({ success: false, msg: 'Cloudflare 不支持通过 API 修改已有子域名，请到 Dashboard → Workers & Pages → 设置中手动修改。' }), { headers: { "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ success: false, msg: errMsg }), { headers: { "Content-Type": "application/json" } });
        }
    } catch (e) { return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500 }); }
}

// 一键修复 1101：删除 Worker → 改子域名 → 重建（带混淆）→ 恢复变量
async function handleFix1101(env, type) {
    const ACCOUNTS_KEY = `ACCOUNTS_UNIFIED_STORAGE`;
    const accounts = JSON.parse(await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]");
    if (accounts.length === 0) return new Response(JSON.stringify([{ name: "提示", success: false, msg: "无账号" }]), { headers: { "Content-Type": "application/json" } });

    const logs = [];

    // 1. 下载最新代码
    const { scriptUrl, apiUrl } = getGithubUrls(type, null);
    let freshCode;
    try {
        const codeRes = await fetch(scriptUrl + `?t=${Date.now()}`);
        if (!codeRes.ok) throw new Error(`HTTP ${codeRes.status}`);
        freshCode = await codeRes.text();
    } catch (e) {
        return new Response(JSON.stringify([{ name: "系统", success: false, msg: `代码下载失败: ${e.message}` }]), { headers: { "Content-Type": "application/json" } });
    }

    // 获取最新 SHA（用于更新 DEPLOY_CONFIG）
    let latestSha = null;
    try {
        const hdrs = { "User-Agent": "CF-Worker" };
        if (env.GITHUB_TOKEN) hdrs["Authorization"] = `token ${env.GITHUB_TOKEN}`;
        const apiRes = await fetch(apiUrl + `?sha=${TEMPLATES[type].ghBranch}&per_page=1`, { headers: hdrs });
        if (apiRes.ok) latestSha = (await apiRes.json())[0].sha;
    } catch (e) { }

    for (const acc of accounts) {
        const targetWorkers = acc[`workers_${type}`] || [];
        if (targetWorkers.length === 0) {
            logs.push({ name: acc.alias, success: false, msg: "⏭️ 无此类 Worker，跳过" });
            continue;
        }

        const headers = getAuthHeaders(acc.email, acc.globalKey);

        for (const wName of targetWorkers) {
            const logItem = { name: `${acc.alias} → [${wName}]`, success: false, msg: "" };
            const steps = [];
            try {
                const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/scripts/${wName}`;

                // Step 1: 记录当前变量绑定
                let savedBindings = [];
                try {
                    const bindRes = await fetch(`${baseUrl}/bindings`, { headers });
                    if (bindRes.ok) {
                        savedBindings = (await bindRes.json()).result || [];
                    }
                } catch (e) { }
                const varCount = savedBindings.filter(b => b.type === 'plain_text').length;
                steps.push(`📋 记录 ${savedBindings.length} 个绑定 (${varCount} 变量)`);

                // Step 1.5: 记录自定义域名
                let savedDomains = [];
                try {
                    const domainsRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/domains`, { headers });
                    if (domainsRes.ok) {
                        const allDomains = (await domainsRes.json()).result || [];
                        savedDomains = allDomains.filter(d => d.service === wName);
                    }
                } catch (e) { }
                if (savedDomains.length > 0) steps.push(`🔗 记录 ${savedDomains.length} 个自定义域名`);

                // Step 2: 删除 Worker（不删 KV）
                const delRes = await fetch(baseUrl, { method: "DELETE", headers });
                if (!delRes.ok) {
                    const err = await delRes.json();
                    throw new Error(`删除失败: ${err.errors?.[0]?.message || delRes.status}`);
                }
                steps.push("🗑️ 已删除");

                // Step 3: 随机修改子域名（容错，失败不阻断）
                try {
                    await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/subdomain`, { method: 'DELETE', headers });
                    const randomSub = 'w' + Math.random().toString(36).substring(2, 8) + Math.floor(Math.random() * 99);
                    const subRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/subdomain`, {
                        method: 'PUT', headers,
                        body: JSON.stringify({ subdomain: randomSub })
                    });
                    if (subRes.ok) steps.push(`🌐 子域名 → ${randomSub}`);
                    else steps.push("🌐 子域名: 跳过(API限制)");
                } catch (e) { steps.push("🌐 子域名: 跳过"); }

                // Step 4: 重建 Worker + 恢复变量
                let deployCode = freshCode;
                if (type === 'joey') deployCode = 'var window = globalThis;\n' + deployCode;

                // 从 KV 读取用户配置的变量值（VARS_cmliu / VARS_joey 等）
                const varsStr = await env.CONFIG_KV.get(`VARS_${type}`);
                const kvVars = varsStr ? JSON.parse(varsStr) : [];
                const kvVarMap = new Map(kvVars.map(v => [v.key, v.value]));

                // 恢复绑定：KV 变量值优先，其次 API 绑定值
                const restoredBindings = savedBindings.map(b => {
                    if (b.type === 'plain_text' || b.type === 'secret_text') {
                        // 优先用 VARS_type 中的值
                        const kvVal = kvVarMap.get(b.name);
                        const val = (kvVal !== undefined && kvVal !== '') ? kvVal : (b.text || '');
                        return { name: b.name, type: 'plain_text', text: val };
                    }
                    if (b.type === 'kv_namespace') return { name: b.name, type: 'kv_namespace', namespace_id: b.namespace_id };
                    return b; // 其他类型原样返回
                });
                // 补充 KV 中有但 Bindings 中没有的变量
                for (const [key, value] of kvVarMap) {
                    if (!restoredBindings.find(b => b.name === key)) {
                        restoredBindings.push({ name: key, type: 'plain_text', text: value || '' });
                    }
                }
                const restoredVarCount = restoredBindings.filter(b => b.type === 'plain_text').length;

                const metadata = {
                    main_module: "index.js",
                    bindings: restoredBindings,
                    compatibility_date: new Date().toISOString().split('T')[0]
                };
                const formData = new FormData();
                formData.append("metadata", JSON.stringify(metadata));
                formData.append("script", new Blob([deployCode], { type: "application/javascript+module" }), "index.js");

                const uploadHeaders = getUploadHeaders(acc.email, acc.globalKey);
                const uploadRes = await fetch(baseUrl, { method: "PUT", headers: uploadHeaders, body: formData });

                if (uploadRes.ok) {
                    logItem.success = true;
                    steps.push(`✅ 重建成功 (${restoredVarCount} 变量已恢复)`);

                    // Step 5: 恢复自定义域名
                    if (savedDomains.length > 0) {
                        let domainOk = 0;
                        for (const d of savedDomains) {
                            try {
                                const dRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/domains`, {
                                    method: 'PUT', headers,
                                    body: JSON.stringify({ hostname: d.hostname, service: wName, zone_id: d.zone_id, environment: d.environment || 'production' })
                                });
                                if (dRes.ok) domainOk++;
                            } catch (e) { }
                        }
                        steps.push(`🔗 域名恢复 ${domainOk}/${savedDomains.length}`);
                    }
                } else {
                    const err = await uploadRes.json();
                    steps.push(`❌ 重建失败: ${err.errors?.[0]?.message}`);
                }
            } catch (err) {
                steps.push(`❌ ${err.message}`);
            }
            logItem.msg = steps.join(' → ');
            logs.push(logItem);
        }
    }

    // 更新 DEPLOY_CONFIG
    const hasSuccess = logs.some(l => l.success);
    if (hasSuccess) {
        const DEPLOY_CONFIG_KEY = `DEPLOY_CONFIG_${type}`;
        await env.CONFIG_KV.put(DEPLOY_CONFIG_KEY, JSON.stringify({ mode: 'latest', currentSha: latestSha || 'unknown', deployTime: new Date().toISOString() }));
    }

    return new Response(JSON.stringify(logs), { headers: { "Content-Type": "application/json" } });
}

// 提取并返回全球区域节点的基础数据（替代前端调用外部txt）
async function handleGetRegionsData() {
    try {
        const response = await fetch("https://zip.cm.edu.kg/all.txt");
        let text = await response.text();
        text = text.replace(/^\uFEFF/, '');
        const lines = text.split('\n');

        const regionPools = {};
        for (const line of lines) {
            if (!line.includes('#')) continue;
            const parts = line.split('#');
            const code = parts[1] ? parts[1].trim().toUpperCase() : '';
            const ipPort = parts[0].trim();

            if (code) {
                if (!regionPools[code]) regionPools[code] = [];
                regionPools[code].push({ line, code, ipPort });
            }
        }
        return new Response(JSON.stringify({ success: true, data: regionPools }), {
            headers: { 'content-type': 'application/json; charset=UTF-8' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ success: false, msg: "Error fetching data: " + e.message }), { status: 500 });
    }
}

// 保存优选节点逻辑
async function handleSaveYxip(env, reqData, accountsKey) {
    const { type, accountId, email, globalKey, rawContent } = reqData;

    // 针对旧模式（无 KV）的 Joey：覆盖中控的 VARS_joey 全局变量 'yx' 
    if (type === 'joey_var') {
        const VARS_KEY = `VARS_joey`;
        try {
            const varsStr = await env.CONFIG_KV.get(VARS_KEY);
            let variables = varsStr ? JSON.parse(varsStr) : [];
            const idx = variables.findIndex(v => v.key === 'yx');
            if (idx !== -1) {
                variables[idx] = { key: 'yx', type: "plain_text", value: rawContent };
            } else {
                variables.push({ key: 'yx', type: "plain_text", value: rawContent });
            }
            await env.CONFIG_KV.put(VARS_KEY, JSON.stringify(variables));
            return new Response(JSON.stringify([{ name: "Joey 全局变量 (无 KV 模式)", success: true, msg: "✅ 变量 [yx] 已成功覆盖至全体记录供稍后部署使用", type: 'joey' }]), { headers: { "Content-Type": "application/json" } });
        } catch (e) {
            return new Response(JSON.stringify([{ name: "写入错误", success: false, msg: e.message }]), { status: 500 });
        }
    }

    // 不论是 cmliu 还是 joey，都需要写入对应 Worker 的目标绑定 KV 空间
    if (type === 'cmliu' || type === 'joey') {
        if (!accountId || !email || !globalKey) return new Response(JSON.stringify([{ name: "配置错误", success: false, msg: "未提供对应账户凭证" }]), { status: 400 });

        try {
            const accounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");
            const targetAccount = accounts.find(a => a.accountId === accountId);
            if (!targetAccount) return new Response(JSON.stringify([{ name: "查找错误", success: false, msg: "系统记录中找不到该账户" }]), { status: 404 });

            const targetWorkers = type === 'cmliu' ? targetAccount.workers_cmliu : targetAccount.workers_joey;
            const workerTypeName = type === 'cmliu' ? 'CMLiu' : 'Joey';
            if (!targetWorkers || targetWorkers.length === 0) return new Response(JSON.stringify([{ name: "查找错误", success: false, msg: `该账号下未发现已部署的 ${workerTypeName} 项目` }]), { status: 200 });

            const logs = [];
            const jsonHeaders = getAuthHeaders(email, globalKey);

            for (const wName of targetWorkers) {
                const logItem = { name: `[${workerTypeName}] ${wName}`, success: false, msg: "" };
                try {
                    // 1. 获取该 Worker 的绑定的 KV ID
                    const bindRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${wName}/bindings`, { headers: jsonHeaders });
                    if (!bindRes.ok) throw new Error("无法读取绑定的变量");

                    const binds = (await bindRes.json()).result;
                    const kvBind = binds.find(b => b.type === 'kv_namespace' && (b.name === 'KV' || b.name === 'CONFIG' || b.name === 'C'));
                    if (!kvBind) {
                        logItem.msg = "❌ 该项目未绑定名为 KV/CONFIG/C 的核心配置空间";
                    } else {
                        const nsId = kvBind.namespace_id;
                        // 2. 将内容写入到空间的指定键
                        let targetKey = "ADD.txt";
                        let finalContent = rawContent;
                        let contentType = "text/plain";

                        if (type === 'joey') {
                            targetKey = "c";
                            // 构造最终的 JSON 内容
                            const configObj = { "ev": "yes", "et": "no", "ex": "no", "epd": "no", "epi": "yes", "egi": "no", "d": "990200", "ipv4": "yes", "ipv6": "no", "ispMobile": "yes", "ispUnicom": "no", "ispTelecom": "no", "yx": rawContent, "dkby": "yes", "ech": "yes", "scu": "https://SUBAPI.cmliussss.net" };
                            finalContent = JSON.stringify(configObj);
                            contentType = "application/json";
                        }

                        const putRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${targetKey}`, {
                            method: "PUT",
                            headers: {
                                ...jsonHeaders,
                                "Content-Type": contentType
                            },
                            body: finalContent
                        });

                        if (putRes.ok) {
                            logItem.success = true;
                            logItem.msg = `✅ 已更新对应命名空间的 ${targetKey}`;
                        } else {
                            logItem.msg = `❌ 写入失败: ${(await putRes.json()).errors?.[0]?.message}`;
                        }
                    }
                } catch (e) { logItem.msg = `❌ ${e.message}`; } // loop block catch
                logs.push(logItem);
            }
            return new Response(JSON.stringify(logs), { headers: { "Content-Type": "application/json" } });

        } catch (e) {
            return new Response(JSON.stringify([{ name: "执行异常", success: false, msg: e.message }]), { status: 500 });
        }
    }

    return new Response(JSON.stringify([{ name: "参数错误", success: false, msg: "未知的请求类型: " + type }]), { status: 400 });
}

function loginHtml() {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Login</title></head>
<body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f3f4f6;font-family:sans-serif">
<div style="background:white;padding:2rem;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);text-align:center">
<h2 style="margin:0 0 1rem;color:#1e293b">🔒 Worker 中控</h2>
<input type="password" id="login_code" placeholder="请输入密码" style="padding:10px;border:1px solid #cbd5e1;border-radius:4px;width:200px;margin-bottom:10px;display:block">
<button onclick="doLogin()" style="padding:10px 24px;background:#1e293b;color:white;border:none;border-radius:4px;cursor:pointer;width:100%">登录</button>
<div id="login_msg" style="color:red;font-size:12px;margin-top:8px"></div>
</div>
<script>
async function doLogin(){
    const code=document.getElementById('login_code').value;
    const msg=document.getElementById('login_msg');
    if(!code){msg.innerText='请输入密码';return;}
    try{
        const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
        const d=await r.json();
        if(d.success){location.reload();}else{msg.innerText=d.msg||'密码错误';}
    }catch(e){msg.innerText='网络错误';}
}
document.getElementById('login_code').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
</script>
</body></html>`;
}

// ==========================================
// 2. 前端页面 (完整 HTML)
// ==========================================
function mainHtml() {
    return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="manifest" href="/manifest.json">
    <title>Worker 智能中控 (V10.10.0)</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>

    <style>
      :root {
        --bg-page: #f1f5f9; --bg-card: #ffffff; --bg-card-alt: #f8fafc; --bg-input: #ffffff;
        --bg-header: #ffffff; --bg-toolbar: #f8fafc;
        --text-primary: #1e293b; --text-secondary: #475569; --text-muted: #94a3b8;
        --border-color: #e2e8f0; --border-light: #f1f5f9;
        --shadow-color: rgba(0,0,0,0.08);
        --table-header-bg: #f8fafc; --table-row-hover: #f8fafc;
      }
      [data-theme="dark"] {
        --bg-page: transparent; --bg-card: rgba(15,23,42,0.75); --bg-card-alt: rgba(30,41,59,0.7); --bg-input: rgba(30,41,59,0.8);
        --bg-header: rgba(15,23,42,0.8); --bg-toolbar: rgba(30,41,59,0.6);
        --text-primary: #e2e8f0; --text-secondary: #cbd5e1; --text-muted: #94a3b8;
        --border-color: rgba(71,85,105,0.5); --border-light: rgba(51,65,85,0.5);
        --shadow-color: rgba(0,0,0,0.3);
        --table-header-bg: rgba(30,41,59,0.8); --table-row-hover: rgba(51,65,85,0.4);
      }
      body { background: var(--bg-page); color: var(--text-primary); transition: background 0.4s, color 0.4s; }
      [data-theme="dark"] body { background: transparent; }
      #starfield { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; background: #0f172a; display: none; }
      [data-theme="dark"] #starfield { display: block; }
      [data-theme="dark"] .bg-white, [data-theme="dark"] .project-card,
      [data-theme="dark"] .bg-slate-100 {
        background: var(--bg-card) !important; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        border: 1px solid var(--border-color) !important;
      }
      [data-theme="dark"] header, [data-theme="dark"] .bg-white.rounded.shadow {
        background: var(--bg-header) !important; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      }
      [data-theme="dark"] .bg-slate-50, [data-theme="dark"] .bg-gray-50 {
        background: var(--bg-card-alt) !important;
      }
      [data-theme="dark"] .text-slate-800, [data-theme="dark"] .text-gray-700,
      [data-theme="dark"] .text-slate-700, [data-theme="dark"] .text-gray-600 {
        color: var(--text-primary) !important;
      }
      [data-theme="dark"] .text-gray-500, [data-theme="dark"] .text-gray-400,
      [data-theme="dark"] .text-gray-300 {
        color: var(--text-muted) !important;
      }
      [data-theme="dark"] .border-slate-200, [data-theme="dark"] .border-gray-100,
      [data-theme="dark"] .border-gray-200 {
        border-color: var(--border-color) !important;
      }
      [data-theme="dark"] .input-field {
        background: var(--bg-input) !important; color: var(--text-primary) !important;
        border-color: var(--border-color) !important;
      }
      [data-theme="dark"] .input-field::placeholder { color: var(--text-muted) !important; }
      [data-theme="dark"] .compact-table th { background: var(--table-header-bg) !important; color: var(--text-muted) !important; }
      [data-theme="dark"] .compact-table td { border-bottom-color: var(--border-light) !important; color: var(--text-secondary) !important; }
      [data-theme="dark"] .compact-table tr:hover { background: var(--table-row-hover) !important; }
      [data-theme="dark"] .bg-red-50    { background: rgba(127,29,29,0.2) !important; }
      [data-theme="dark"] .bg-blue-50   { background: rgba(30,58,138,0.2) !important; }
      [data-theme="dark"] .bg-green-50  { background: rgba(20,83,45,0.2) !important; }
      [data-theme="dark"] .bg-purple-50 { background: rgba(88,28,135,0.15) !important; }
      [data-theme="dark"] .bg-orange-50 { background: rgba(124,45,18,0.2) !important; }
      [data-theme="dark"] .bg-indigo-50 { background: rgba(49,46,129,0.2) !important; }
      [data-theme="dark"] .border-red-100   { border-color: rgba(127,29,29,0.3) !important; }
      [data-theme="dark"] .border-blue-100  { border-color: rgba(30,58,138,0.3) !important; }
      [data-theme="dark"] .border-green-100 { border-color: rgba(20,83,45,0.3) !important; }
      [data-theme="dark"] .border-purple-100 { border-color: rgba(88,28,135,0.3) !important; }
      [data-theme="dark"] .border-orange-100,.border-orange-200 { border-color: rgba(124,45,18,0.3) !important; }
      [data-theme="dark"] .border-indigo-100 { border-color: rgba(49,46,129,0.3) !important; }
      [data-theme="dark"] select, [data-theme="dark"] input[type="number"],
      [data-theme="dark"] input[type="text"], [data-theme="dark"] input[type="password"] {
        background: var(--bg-input) !important; color: var(--text-primary) !important;
        border-color: var(--border-color) !important;
      }
      [data-theme="dark"] .shadow { box-shadow: 0 2px 8px var(--shadow-color) !important; }
      /* Modal dark overrides */
      [data-theme="dark"] #batch_deploy_modal > div > div:first-child,
      [data-theme="dark"] #account_manage_modal > div,
      [data-theme="dark"] #history_modal > div > div,
      [data-theme="dark"] #sync_select_modal > div {
        background: rgba(15,23,42,0.95) !important; backdrop-filter: blur(20px);
        border: 1px solid var(--border-color) !important;
      }
      [data-theme="dark"] #batch_deploy_modal .p-4,
      [data-theme="dark"] #account_manage_modal .p-4 {
        color: var(--text-primary);
      }
      /* Theme toggle button */
      .theme-toggle { cursor: pointer; font-size: 18px; width: 36px; height: 36px; border-radius: 50%; border: 2px solid var(--border-color);
        display: flex; align-items: center; justify-content: center; transition: all 0.3s; background: var(--bg-card); }
      .theme-toggle:hover { transform: scale(1.1); box-shadow: 0 0 12px rgba(139,92,246,0.4); }
      /* Original styles */
      .input-field { border: 1px solid #cbd5e1; padding: 0.25rem 0.5rem; width:100%; border-radius: 4px; font-size: 0.8rem; } 
      .input-field:focus { border-color:#3b82f6; outline:none; }
      .toggle-checkbox:checked { right: 0; border-color: #68D391; }
      .toggle-checkbox:checked + .toggle-label { background-color: #68D391; }
      .compact-table th, .compact-table td { padding: 8px; font-size: 13px; border-bottom: 1px solid #f1f5f9; white-space: nowrap; }
      .compact-table th { background-color: #f8fafc; color: #64748b; font-weight: 600; text-align: left; }
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
      .animate-fade-in { animation: fadeIn 0.3s ease-out; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes twinkle { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
    </style>
  </head>
  <body class="bg-slate-100 p-2 md:p-4 min-h-screen text-slate-700">
    <canvas id="starfield"></canvas>
    <div class="max-w-7xl mx-auto space-y-4">
      
      <header class="bg-white px-4 py-3 md:px-6 md:py-4 rounded shadow flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
          <div class="flex-none">
              <h1 class="text-xl font-bold text-slate-800 flex items-center gap-2">🚀 Worker 部署中控 <span class="text-xs bg-purple-600 text-white px-2 py-0.5 rounded ml-2">V10.10.0</span></h1>
              <div class="text-[10px] text-gray-400 mt-1">安全加固 · 熔断轮换 · 子域名管理 · 星空主题</div>
          </div>
          <div id="logs" class="bg-slate-900 text-green-400 p-2 rounded text-xs font-mono hidden max-h-[80px] lg:max-h-[50px] overflow-y-auto shadow-inner w-full lg:flex-1 lg:mx-4 order-2 lg:order-none"></div>
          
          <div class="flex flex-wrap items-center gap-2 md:gap-3 bg-slate-50 p-2 rounded border border-slate-200 w-full lg:w-auto flex-none text-xs">
               <button onclick="toggleTheme()" class="theme-toggle" id="theme_btn" title="切换主题">🌙</button>
               <div class="w-px h-4 bg-gray-300 mx-0"></div>
               <button onclick="openWorkbench()" id="btn_workbench" class="bg-slate-700 text-white px-2 py-1 rounded hover:bg-slate-800 font-bold">📋 工作台</button>
               <button onclick="openBatchDeployModal()" class="bg-indigo-600 text-white px-2 py-1 rounded hover:bg-indigo-700 font-bold">✨ 批量部署</button>
               <button onclick="accounts.some(a => (a.workers_cmliu && a.workers_cmliu.length > 0) || (a.workers_joey && a.workers_joey.length > 0)) ? showYxipModal() : alert('必须先部署至少一个支持的代理项目 (CMLiu 或 Joey) 才能使用反代落地部署功能！')" class="bg-yellow-500 text-white px-2 py-1 rounded hover:bg-yellow-600 font-bold shadow-sm">⚡ 反代落地部署</button>
               <div class="w-px h-4 bg-gray-300 mx-1"></div>
               
               <div class="flex items-center gap-1">
                  <span>自动:</span>
                  <div class="relative inline-block w-8 align-middle select-none">
                      <input type="checkbox" id="auto_update_toggle" class="toggle-checkbox absolute block w-4 h-4 rounded-full bg-white border-4 appearance-none cursor-pointer border-gray-300"/>
                      <label for="auto_update_toggle" class="toggle-label block overflow-hidden h-4 rounded-full bg-gray-300 cursor-pointer"></label>
                  </div>
               </div>

               <div class="flex items-center gap-1">
                  <input type="number" id="auto_update_interval" value="30" class="w-8 text-center border rounded py-0.5"><span>分</span>
               </div>
               <div class="flex items-center gap-1">
                  <span class="text-red-600 font-bold">熔断:</span>
                  <input type="number" id="fuse_threshold" value="0" placeholder="0" class="w-8 text-center border border-red-300 bg-red-50 rounded py-0.5 font-bold text-red-600">
               </div>
               <button onclick="saveAutoConfig()" class="bg-slate-700 text-white px-2 py-1 rounded hover:bg-slate-800 font-bold ml-1">保存</button>
          </div>
      </header>
      
      <div id="layout_container" class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div id="section_accounts" class="lg:col-span-7 space-y-4">
            <div class="bg-white p-4 rounded shadow flex-1">
              <div class="flex justify-between items-center mb-3">
                   <h2 class="font-bold text-gray-700 text-sm">📡 账号列表</h2>
                   <div class="flex gap-2">
                       <button onclick="loadStats()" id="btn_stats" class="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-1 rounded font-bold hover:bg-indigo-100">🔄 刷新用量</button>
                       <button onclick="resetFormForAdd()" class="text-[10px] bg-blue-50 text-blue-600 px-2 py-1 rounded">➕ 添加账号</button>
                   </div>
              </div>
              
              <div id="account_form" class="hidden bg-slate-50 p-3 mb-3 border rounded text-xs space-y-3">
                 <div class="flex gap-2">
                    <input id="in_alias" placeholder="备注 (Alias)" class="input-field w-1/3">
                    <input id="in_id" placeholder="Account ID" class="input-field w-2/3">
                 </div>
                 <div class="flex gap-2">
                    <input id="in_email" placeholder="Login Email" class="input-field w-1/2">
                    <input id="in_gkey" type="password" placeholder="Global API Key" class="input-field w-1/2">
                 </div>
                 <div class="bg-purple-50 p-2 rounded border border-purple-100 flex gap-2 items-center">
                    <span class="text-purple-700 font-bold w-20">预设域名:</span>
                    <select id="in_zone_select" class="input-field w-full" onchange="updateZoneInfo()">
                        <option value="">(请先填写API信息后点击读取)</option>
                    </select>
                    <input type="hidden" id="in_zone_name">
                    <input type="hidden" id="in_zone_id">
                    <button onclick="fetchZonesForAccount()" class="bg-purple-600 text-white px-2 py-1 rounded hover:bg-purple-700 flex-none w-20">☁️ 读取</button>
                 </div>

                 <div class="grid grid-cols-3 gap-2">
                    <input id="in_workers_cmliu" placeholder="🔴 CMliu Worker (选填)" class="input-field bg-red-50">
                    <input id="in_workers_joey" placeholder="🔵 Joey Worker (选填)" class="input-field bg-blue-50">
                    <input id="in_workers_ech" placeholder="🟢 ECH Worker (选填)" class="input-field bg-green-50">
                 </div>
                 <div class="flex gap-2 pt-2">
                    <button onclick="saveAccount()" id="btn_save_acc" class="flex-1 bg-slate-700 text-white py-1.5 rounded font-bold">💾 保存账号</button>
                    <button onclick="deleteFromEdit()" id="btn_del_edit" class="hidden flex-none bg-red-100 text-red-600 px-3 py-1.5 rounded">🗑️</button>
                    <button onclick="cancelEdit()" class="flex-none bg-gray-200 text-gray-600 px-3 py-1.5 rounded">❌</button>
                 </div>
              </div>
              
              <div id="account_list_container" class="overflow-x-auto min-h-[300px]">
                  <table class="w-full compact-table">
                      <thead>
                          <tr><th>备注</th><th>预设域名</th><th>Worker</th><th>流量</th><th>占比</th><th class="text-right">操作</th></tr>
                      </thead>
                      <tbody id="account_body"></tbody>
                  </table>
              </div>
            </div>
        </div>
  
        <div id="section_projects" class="lg:col-span-5 space-y-4">
            <div class="bg-white rounded shadow border-t-4 border-red-500 project-card">
                <div class="bg-red-50 px-4 py-2 flex justify-between items-center border-b border-red-100">
                    <div class="flex items-center gap-2"><span class="text-sm font-bold text-red-700">🔴 CMliu 配置</span><span id="badge_cmliu" class="text-[9px] px-1.5 py-0.5 rounded text-white bg-gray-400">Loading</span></div>
                    <button onclick="openVersionHistory('cmliu')" class="text-[10px] bg-white border border-red-200 text-red-600 px-2 py-0.5 rounded hover:bg-red-50">📜 历史/收藏</button>
                </div>
                <div class="p-3">
                    <div id="ver_cmliu" class="text-[10px] font-mono text-gray-500 mb-2 border-b border-gray-100 pb-2 space-y-1">Checking...</div>
                    <details class="group bg-slate-50 rounded border mb-2">
                        <summary class="bg-slate-100 px-2 py-1 text-xs font-bold text-gray-600 flex justify-between"><span>📝 变量列表</span><span>▼</span></summary>
                        <div id="vars_cmliu" class="p-2 space-y-1 max-h-[200px] overflow-y-auto"></div>
                    </details>
                    <div class="flex gap-2 mb-2">
                        <button onclick="addVarRow('cmliu')" class="flex-1 bg-dashed border text-gray-400 text-xs py-1 rounded hover:text-gray-600">➕ 变量</button>
                        <button onclick="selectSyncAccount('cmliu')" class="flex-none bg-orange-50 text-orange-600 border border-orange-200 text-xs px-2 py-1 rounded">🔄 同步</button>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="refreshUUID('cmliu')" class="flex-1 bg-gray-100 text-gray-600 text-xs py-1.5 rounded">🎲 刷 UUID</button>
                        <button onclick="deploy('cmliu')" id="btn_deploy_cmliu" class="flex-[2] bg-red-600 text-white text-xs py-1.5 rounded font-bold hover:bg-red-700">🚀 部署更新</button>
                    </div>
                    <button onclick="fix1101('cmliu')" id="btn_fix1101_cmliu" class="w-full mt-2 bg-orange-500 text-white text-xs py-1.5 rounded font-bold hover:bg-orange-600">🔧 一键修复 1101</button>
                </div>
            </div>

            <div class="bg-white rounded shadow border-t-4 border-blue-500 project-card">
                <div class="bg-blue-50 px-4 py-2 flex justify-between items-center border-b border-blue-100">
                    <div class="flex items-center gap-2"><span class="text-sm font-bold text-blue-700">🔵 Joey 配置</span><span id="badge_joey" class="text-[9px] px-1.5 py-0.5 rounded text-white bg-gray-400">Loading</span></div>
                    <button onclick="openVersionHistory('joey')" class="text-[10px] bg-white border border-blue-200 text-blue-600 px-2 py-0.5 rounded hover:bg-blue-50">📜 历史/收藏</button>
                </div>
                <div class="p-3">
                    <div id="ver_joey" class="text-[10px] font-mono text-gray-500 mb-2 border-b border-gray-100 pb-2 space-y-1">Checking...</div>
                    <details class="group bg-slate-50 rounded border mb-2">
                        <summary class="bg-slate-100 px-2 py-1 text-xs font-bold text-gray-600 flex justify-between"><span>📝 变量列表</span><span>▼</span></summary>
                        <div id="vars_joey" class="p-2 space-y-1 max-h-[200px] overflow-y-auto"></div>
                    </details>
                    <div class="flex gap-2 mb-2">
                        <button onclick="addVarRow('joey')" class="flex-1 bg-dashed border text-gray-400 text-xs py-1 rounded hover:text-gray-600">➕ 变量</button>
                        <button onclick="selectSyncAccount('joey')" class="flex-none bg-orange-50 text-orange-600 border border-orange-200 text-xs px-2 py-1 rounded">🔄 同步</button>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="refreshUUID('joey')" class="flex-1 bg-gray-100 text-gray-600 text-xs py-1.5 rounded">🎲 刷 UUID</button>
                        <button onclick="deploy('joey')" id="btn_deploy_joey" class="flex-[2] bg-blue-600 text-white text-xs py-1.5 rounded font-bold hover:bg-blue-700">🚀 部署更新</button>
                    </div>
                </div>
            </div>

            <div class="bg-white rounded shadow border-t-4 border-green-500 project-card">
                <div class="bg-green-50 px-4 py-2 flex justify-between items-center border-b border-green-100"><span class="text-sm font-bold text-green-700">🟢 ECH 配置</span><span class="text-[9px] px-1.5 py-0.5 rounded text-white bg-green-500">Stable</span></div>
                <div class="p-3">
                    <div class="mb-2 p-2 bg-slate-50 border rounded text-xs"><div id="ech_proxy_selector_container" class="mb-2"></div><div id="vars_ech" class="space-y-1"></div></div>
                    <div class="mb-2 p-2 bg-slate-50 border border-dashed border-green-300 rounded text-xs">
                        <div class="flex items-center gap-2 mb-1">
                            <div class="relative inline-block w-8 align-middle select-none">
                                <input type="checkbox" id="ech_token_enabled" class="toggle-checkbox absolute block w-4 h-4 rounded-full bg-white border-4 appearance-none cursor-pointer border-gray-300" onchange="toggleEchToken()"/>
                                <label for="ech_token_enabled" class="toggle-label block overflow-hidden h-4 rounded-full bg-gray-300 cursor-pointer"></label>
                            </div>
                            <span class="font-bold text-green-700">🔑 Token 鉴权</span>
                            <span id="ech_token_status" class="text-gray-400 text-[10px]">(关闭 - 不填入)</span>
                        </div>
                        <input id="ech_token_input" type="text" placeholder="填写 Token 后开启开关才会生效" class="input-field w-full opacity-50 cursor-not-allowed" disabled/>
                        <div class="flex items-center gap-2 mt-2 pt-2 border-t border-green-200">
                            <input type="checkbox" id="ech_disable_workers_dev" class="w-4 h-4 text-red-600 border-gray-300 rounded cursor-pointer">
                            <label for="ech_disable_workers_dev" class="font-bold text-gray-700 cursor-pointer">🚫 禁用默认 *.workers.dev 域名</label>
                        </div>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="deploy('ech')" id="btn_deploy_ech" class="w-full bg-green-600 text-white text-xs py-1.5 rounded font-bold hover:bg-green-700">🚀 部署配置</button>
                    </div>
                </div>
            </div>
        </div>
      </div>
    </div>

    <div id="batch_deploy_modal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex justify-center items-center z-50">
        <div class="bg-white rounded-lg w-[600px] shadow-2xl overflow-hidden animate-fade-in">
            <div class="bg-indigo-600 p-3 flex justify-between items-center text-white">
                <h3 class="font-bold text-sm">✨ 批量部署</h3>
                <button onclick="document.getElementById('batch_deploy_modal').classList.add('hidden')" class="hover:text-gray-200">×</button>
            </div>
            <div class="p-4 text-xs space-y-3">
                <div class="grid grid-cols-2 gap-3">
                    <div><label class="block text-gray-500 mb-1">Worker 名称</label><input id="bd_name" class="input-field font-bold text-indigo-700" placeholder="例如: new-proxy-01"></div>
                    <div><label class="block text-gray-500 mb-1">选择模板</label><select id="bd_template" onchange="toggleBatchInputs()" class="input-field bg-gray-50"><option value="cmliu">🔴 CMliu (EdgeTunnel)</option><option value="joey">🔵 Joey (相信光)</option></select></div>
                </div>
                
                <div class="grid grid-cols-2 gap-3 items-end">
                    <div><label class="block text-gray-500 mb-1">KV 空间名称</label><input id="bd_kv_name" class="input-field" placeholder="自动创建/使用同名 KV"></div>
                    <div class="flex flex-col gap-2 pb-1">
                         <div class="flex items-center gap-2">
                            <input type="checkbox" id="bd_enable_kv" class="w-4 h-4 text-indigo-600 border-gray-300 rounded" checked>
                            <label for="bd_enable_kv" class="font-bold text-gray-700">绑定 KV 存储</label>
                         </div>
                         <div class="flex items-center gap-2">
                            <input type="checkbox" id="bd_use_saved_vars" class="w-4 h-4 text-green-600 border-gray-300 rounded" checked>
                            <label for="bd_use_saved_vars" class="font-bold text-green-700">📦 采用已保存变量 (VARS)</label>
                         </div>
                    </div>
                </div>

                <div class="bg-slate-50 p-2 rounded border">
                    <div class="flex items-center gap-2 mb-2">
                         <input type="checkbox" id="bd_disable_workers_dev" class="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500">
                         <label for="bd_disable_workers_dev" class="font-bold text-gray-700">🚫 禁用默认 *.workers.dev 域名</label>
                    </div>
                    <div class="border-t pt-2">
                        <label class="block text-purple-700 font-bold mb-1">🌐 自定义域名 (自动绑定)</label>
                        <div class="flex gap-1 items-center">
                            <input id="bd_domain_prefix" class="input-field w-1/3" placeholder="仅输入前缀">
                            <span class="text-gray-400">.</span>
                            <span class="text-gray-500 text-xs italic">[使用账号预设域名]</span>
                        </div>
                    </div>
                </div>

                <div id="bd_config_cmliu" class="bg-red-50 p-2 rounded border border-red-100">
                    <label class="block text-red-700 font-bold mb-1">设置 ADMIN 密码</label>
                    <input id="bd_admin_pass" class="input-field bg-white" placeholder="登录后台的密码">
                </div>
                <div id="bd_config_joey" class="hidden bg-blue-50 p-2 rounded border border-blue-100">
                    <label class="block text-blue-700 font-bold mb-1">设置用户 UUID (u)</label>
                    <div class="flex gap-2">
                        <input id="bd_uuid" class="input-field bg-white font-mono" placeholder="UUID">
                        <button onclick="document.getElementById('bd_uuid').value = crypto.randomUUID()" class="bg-blue-600 text-white px-2 rounded">🎲</button>
                    </div>
                </div>
                <div>
                    <label class="block text-gray-500 mb-1">选择目标账号</label>
                    <div id="bd_account_list" class="max-h-[100px] overflow-y-auto border rounded p-2 bg-gray-50 grid grid-cols-2 gap-2"></div>
                </div>
                <div class="pt-2 border-t flex justify-end gap-2">
                    <button onclick="document.getElementById('batch_deploy_modal').classList.add('hidden')" class="px-3 py-1.5 bg-gray-100 text-gray-600 rounded">取消</button>
                    <button onclick="doBatchDeploy()" id="btn_do_batch" class="px-3 py-1.5 bg-indigo-600 text-white rounded font-bold hover:bg-indigo-700">🚀 开始部署</button>
                </div>
            </div>
        </div>
    </div>

    <div id="yxip_modal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex justify-center items-start pt-[5vh] z-[60] overflow-y-auto">
        <div class="bg-white rounded-lg shadow-2xl flex flex-col w-[90%] max-w-[800px] my-[5vh]">
            <div class="bg-gradient-to-r from-yellow-500 to-yellow-600 p-4 rounded-t-lg flex justify-between items-center text-white shadow-sm">
                <h3 class="font-bold text-lg flex items-center gap-2">⚡ 反代落地部署 (YXIP)</h3>
                <button onclick="document.getElementById('yxip_modal').classList.add('hidden')" class="hover:bg-white/20 px-2 py-0.5 rounded transition-colors text-xl">×</button>
            </div>
            
            <div class="p-5 overflow-y-auto">
                <!-- Step 1: 目标配置 -->
                <div class="mb-6">
                    <h4 class="font-bold text-gray-700 border-b pb-2 mb-3 border-yellow-200">1. 操作目标配置</h4>
                    <div class="bg-yellow-50 p-4 border border-yellow-100 rounded-lg">
                        <label class="block text-sm font-bold text-gray-700 mb-2">更新策略类型：</label>
                        <select id="yxip_type" class="input-field w-full mb-4 bg-white" onchange="toggleYxipAccountSelect()">
                            <option value="joey">🚀 Joey 专属 (KV 模式): 写入目标账号项目绑定的核心配置库 (键 c)</option>
                            <option value="joey_var">🪐 Joey 兼容 (变量模式): 写入中控面板供当前所有 Joey 项目统一使用的全局变量组 [yx]</option>
                            <option value="cmliu">🌐 CMLiu 专属 (KV 模式): 写入目标账号项目绑定的自带节点列表库 (ADD.txt)</option>
                        </select>

                        <div id="yxip_cmliu_account_area" class="mt-3">
                            <label class="block text-sm font-bold text-slate-700 mb-2">选择目标 CF 账号 (对应其绑定的项目):</label>
                            <div id="yxip_account_list" class="max-h-[150px] overflow-y-auto border rounded p-3 bg-white grid grid-cols-1 md:grid-cols-2 gap-2 shadow-inner">
                                <!-- JS dynamically populates accounts -->
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Step 2: 选区配置 -->
                <div>
                    <h4 class="font-bold text-gray-700 border-b pb-2 mb-3 border-yellow-200 flex justify-between">
                        <span>2. 节点筛选池要求</span>
                        <div class="flex items-center gap-2 text-sm font-normal">
                            <label>单地区上限:</label>
                            <input type="number" id="yxip_limit" value="10" min="1" max="100" class="input-field bg-white py-1 w-[80px] text-center">
                            <span>个</span>
                        </div>
                    </h4>
                    
                    <div class="flex gap-2 mb-3">
                        <button onclick="yxipSelectAll()" class="px-3 py-1 bg-gray-100 border text-gray-700 shadow-sm hover:bg-gray-200 rounded text-sm transition-colors">全选</button>
                        <button onclick="yxipSelectNone()" class="px-3 py-1 bg-gray-100 border text-gray-700 shadow-sm hover:bg-gray-200 rounded text-sm transition-colors">反选</button>
                    </div>
                    
                    <div id="yxip_regions" class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2 text-sm max-h-[250px] overflow-y-auto p-2 border rounded bg-gray-50 shadow-inner">
                        <div class="col-span-full text-center py-4 text-gray-400">正在获取全球节点数据...</div>
                    </div>
                </div>

                <div class="mt-6 flex justify-end gap-3 pt-4 border-t border-gray-100">
                    <button onclick="document.getElementById('yxip_modal').classList.add('hidden')" class="px-4 py-2 bg-gray-100 text-gray-600 rounded font-bold hover:bg-gray-200 transition-colors">取消</button>
                    <button onclick="doYxipDeploy()" class="px-6 py-2 bg-gradient-to-r from-yellow-500 to-yellow-600 text-white rounded font-bold hover:from-yellow-600 hover:to-yellow-700 shadow-md transition-all flex items-center gap-2">
                        <span id="yxip_btn_icon">⚡</span> 开始提取与部署
                    </button>
                </div>
            </div>
        </div>
    </div>

    <div id="account_manage_modal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex justify-center items-center z-50">
        <div class="bg-white rounded-lg w-[650px] shadow-2xl max-h-[85vh] flex flex-col">
            <div class="bg-slate-700 p-3 flex justify-between items-center text-white">
                <h3 class="font-bold text-sm" id="manage_modal_title">📂 账号管理</h3>
                <button onclick="document.getElementById('account_manage_modal').classList.add('hidden')" class="hover:text-gray-200">×</button>
            </div>
            <div class="p-2 border-b bg-gray-50 text-[10px] text-gray-500 space-y-1">
                <div>⚠️ 警告：删除逻辑为 [解绑 Worker -> 删除 Worker -> 删除 KV]。</div>
                <div class="flex items-center gap-2 bg-indigo-50 p-1.5 rounded border border-indigo-100">
                    <span class="text-indigo-700 font-bold flex-none">🌐 子域名:</span>
                    <span id="manage_subdomain_display" class="font-mono text-indigo-600 text-[11px]">加载中...</span>
                    <span class="text-gray-400">.workers.dev</span>
                    <button onclick="promptChangeSubdomain()" class="ml-auto flex-none bg-indigo-600 text-white px-2 py-0.5 rounded hover:bg-indigo-700 font-bold">✏️ 修改</button>
                </div>
            </div>
            <div class="flex-1 overflow-y-auto p-4">
                <div id="manage_loading" class="text-center py-4 text-gray-400">正在加载 Workers 列表...</div>
                <table class="w-full compact-table hidden" id="manage_table">
                    <thead><tr><th>Worker 名称</th><th>创建时间</th><th>修改时间</th><th class="text-right">操作</th></tr></thead>
                    <tbody id="manage_list_body"></tbody>
                </table>
            </div>
        </div>
    </div>

    <div id="history_modal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
        <div class="bg-white rounded-lg w-[450px] shadow-xl max-h-[85vh] flex flex-col overflow-hidden">
            <div class="p-3 border-b bg-gray-50 flex justify-between items-center">
                <h3 class="text-sm font-bold text-gray-700">📜 版本管理</h3>
                <div class="flex gap-2">
                    <button onclick="openFavoritesPanel()" class="text-xs bg-orange-100 text-orange-600 px-2 py-1 rounded font-bold border border-orange-200 hover:bg-orange-200">⭐ 查看收藏</button>
                    <button onclick="document.getElementById('history_modal').classList.add('hidden')" class="text-gray-400 hover:text-gray-600 text-lg">×</button>
                </div>
            </div>
            
            <div id="fav_panel_view" class="hidden flex-col h-full bg-orange-50">
                <div class="p-2 border-b border-orange-200 flex justify-between items-center">
                    <span class="text-xs font-bold text-orange-800">⭐ 我的收藏版本</span>
                    <button onclick="closeFavoritesPanel()" class="text-[10px] bg-white border px-2 py-0.5 rounded">返回历史</button>
                </div>
                <div id="fav_full_list" class="flex-1 overflow-y-auto p-2 space-y-1"></div>
            </div>

            <div id="history_panel_view" class="flex flex-col h-full">
                <div class="bg-gray-50 p-2 border-b flex justify-between items-center text-xs">
                    <span>显示条数:</span>
                    <input type="number" id="history_limit_input" value="10" class="w-12 text-center border rounded" onchange="refreshHistory()">
                </div>
                <div class="flex-1 overflow-y-auto bg-slate-50 p-2 space-y-3">
                    <div>
                        <div class="flex justify-between items-end px-1 mb-1">
                            <div class="text-[10px] font-bold text-gray-500 uppercase tracking-wider">🕒 最近提交</div>
                        </div>
                        <div id="history_list" class="space-y-1 min-h-[100px]"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div id="sync_select_modal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
        <div class="bg-white rounded-lg p-4 w-80 shadow-xl max-h-[80vh] flex flex-col">
            <h3 class="text-sm font-bold mb-3 text-gray-700">📥 选择同步源</h3>
            <div id="sync_list" class="space-y-1 overflow-y-auto flex-1 mb-3"></div>
            <button onclick="document.getElementById('sync_select_modal').classList.add('hidden')" class="w-full bg-gray-200 text-gray-600 text-xs py-1.5 rounded">取消</button>
        </div>
    </div>

    <div id="workbench_modal" class="hidden fixed inset-0 z-50" style="pointer-events:none">
        <div id="workbench_panel" class="bg-slate-900 rounded-xl shadow-2xl flex flex-col border border-slate-700" style="pointer-events:auto;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:700px;max-width:90vw;height:50vh;max-height:80vh;resize:both;overflow:hidden">
            <div id="workbench_drag" class="flex justify-between items-center px-4 py-2 border-b border-slate-700 cursor-move select-none" style="cursor:move">
                <h3 class="text-sm font-bold text-green-400 flex items-center gap-2">📋 工作台 <span id="wb_status" class="text-[10px] text-slate-500 font-normal"></span></h3>
                <div class="flex gap-2">
                    <button onclick="document.getElementById('workbench_log').innerHTML=''" class="text-[10px] text-slate-500 hover:text-slate-300 border border-slate-600 px-2 py-0.5 rounded">🗑️ 清空</button>
                    <button onclick="closeWorkbench()" class="text-slate-400 hover:text-white text-lg leading-none">&times;</button>
                </div>
            </div>
            <div id="workbench_log" class="flex-1 overflow-y-auto p-3 text-xs font-mono text-green-400 space-y-0.5">
                <div class="text-slate-600">// 等待操作...</div>
            </div>
        </div>
    </div>

    <script>
      const TEMPLATES = ${JSON.stringify(Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, { defaultVars: v.defaultVars, uuidField: v.uuidField, name: v.name }])))};
      const ECH_PROXIES = ${JSON.stringify(ECH_PROXIES)};
  
      let accounts = [];
      let editingIndex = -1;
      let deletedVars = { cmliu: [], joey: [], ech: [] };
      let deployConfigs = {}; 
      let currentHistoryType = null;
  
      async function init() {
          renderProxySelector();
          await loadAccounts();
          await Promise.all(['cmliu','joey','ech'].map(t => loadVars(t)));
          await loadGlobalConfig();
          loadStats();
          ['cmliu','joey'].forEach(t => { checkDeployConfig(t); checkUpdate(t); });
      }

      function openWorkbench() {
          document.getElementById('workbench_modal').classList.remove('hidden');
      }
      function closeWorkbench() {
          document.getElementById('workbench_modal').classList.add('hidden');
      }
      function wbLog(msg, colorClass) {
          const log = document.getElementById('workbench_log');
          const div = document.createElement('div');
          if (colorClass) div.className = colorClass;
          div.textContent = msg;
          log.appendChild(div);
          log.scrollTop = log.scrollHeight;
      }

      // 工作台拖动
      (function initDrag() {
          let isDragging = false, startX, startY, startLeft, startTop;
          document.addEventListener('mousedown', e => {
              const drag = document.getElementById('workbench_drag');
              if (!drag || !drag.contains(e.target) || e.target.tagName === 'BUTTON') return;
              const panel = document.getElementById('workbench_panel');
              isDragging = true;
              const rect = panel.getBoundingClientRect();
              panel.style.transform = 'none';
              panel.style.left = rect.left + 'px';
              panel.style.top = rect.top + 'px';
              startX = e.clientX; startY = e.clientY;
              startLeft = rect.left; startTop = rect.top;
              e.preventDefault();
          });
          document.addEventListener('mousemove', e => {
              if (!isDragging) return;
              const panel = document.getElementById('workbench_panel');
              panel.style.left = Math.max(0, startLeft + e.clientX - startX) + 'px';
              panel.style.top = Math.max(0, startTop + e.clientY - startY) + 'px';
          });
          document.addEventListener('mouseup', () => { isDragging = false; });
      })();

      async function fetchZonesForAccount() {
          const email = document.getElementById('in_email').value;
          const key = document.getElementById('in_gkey').value;
          const id = document.getElementById('in_id').value;
          const select = document.getElementById('in_zone_select');

          if (!email || !key) return Swal.fire('提示', '请先填写 Email, API Key', 'warning');

          select.innerHTML = '<option>Loading...</option>';
          try {
              const res = await fetch('/api/zones', {
                  method: 'POST',
                  body: JSON.stringify({ accountId: id, email: email, globalKey: key })
              });
              const d = await res.json();
              if (d.success) {
                  select.innerHTML = '<option value="">-- 请选择预设域名 --</option>' + 
                      d.zones.map(z => \`<option value="\${z.id}" data-name="\${z.name}">\${z.name}</option>\`).join('');
              } else {
                  select.innerHTML = '<option>读取失败</option>';
                  Swal.fire('错误', d.msg, 'error');
              }
          } catch(e) { select.innerHTML = '<option>网络错误</option>'; }
      }

      function updateZoneInfo() {
          const sel = document.getElementById('in_zone_select');
          if(sel.selectedIndex > 0) {
              document.getElementById('in_zone_id').value = sel.value;
              document.getElementById('in_zone_name').value = sel.options[sel.selectedIndex].dataset.name;
          }
      }

      // 批量部署逻辑
      async function doBatchDeploy() {
          const btn = document.getElementById('btn_do_batch');
          const t = document.getElementById('bd_template').value;
          const name = document.getElementById('bd_name').value;
          const kvName = document.getElementById('bd_kv_name').value;
          const enableKV = document.getElementById('bd_enable_kv').checked;
          const useSavedVars = document.getElementById('bd_use_saved_vars').checked;

          if (!name) return Swal.fire('提示', 'Worker名称必填', 'warning');
          if (enableKV && !kvName) return Swal.fire('提示', '开启 KV 绑定时必须填写 KV 名称', 'warning');
          
          btn.disabled = true;
          btn.innerText = "⏳ 准备中...";
          openWorkbench();
          wbLog('✨ 开始批量部署...', 'text-yellow-400');
          
          try {

             btn.innerText = "🚀 部署中...";
             const chks = document.querySelectorAll('.bd-acc-chk:checked');
             if(chks.length===0) throw new Error("至少选择一个账号");
             const targetAccounts = Array.from(chks).map(c => c.value);
             const config = {};
             if (t === 'cmliu') {
                  config.admin = document.getElementById('bd_admin_pass').value;
                  config.uuid = document.getElementById('bd_uuid').value; 
             } else {
                  config.uuid = document.getElementById('bd_uuid').value;
             }

             // 如果勾选了「采用已保存变量」，从 KV 读取并合并
              let savedVars = null;
              if (useSavedVars) {
                  wbLog('📦 读取已保存变量 (VARS_' + t + ')...', 'text-blue-300');
                  try {
                      const vr = await fetch(\`/api/settings?type=\${t}\`);
                      savedVars = await vr.json();
                      if (Array.isArray(savedVars) && savedVars.length > 0) {
                          wbLog(\`✅ 读取到 \${savedVars.length} 个变量\`, 'text-green-300');
                          // 将 config 中的值合并到 savedVars
                          Object.entries(config).forEach(([k, v]) => {
                              if (v) {
                                  const idx = savedVars.findIndex(sv => sv.key === k);
                                  if (idx !== -1) savedVars[idx].value = v;
                                  else savedVars.push({ key: k, value: v });
                              }
                          });
                      } else { savedVars = null; }
                  } catch(e) { savedVars = null; }
              }

              const res = await fetch('/api/batch_deploy', {
                   method: 'POST',
                   body: JSON.stringify({ 
                       template: t, 
                       workerName: name, 
                       kvName: kvName, 
                       config: config, 
                       targetAccounts: targetAccounts,
                       disableWorkersDev: document.getElementById('bd_disable_workers_dev').checked,
                       customDomainPrefix: document.getElementById('bd_domain_prefix').value,
                       enableKV: enableKV,
                       savedVars: savedVars 
                   })
               });
              const logs = await res.json();
               logs.forEach(l => {
                   if (l.success && l.msg.startsWith('✅')) wbLog(\`✅ \${l.msg.replace('✅ ', '')}\`, 'text-white');
                   else wbLog(\`[\${l.success ? 'OK' : 'ERR'}] \${l.name}: \${l.msg}\`, l.success ? '' : 'text-red-400');
               });
               
               document.getElementById('batch_deploy_modal').classList.add('hidden');
               await loadAccounts(); 
               Swal.fire('完成', '操作完成，请查看工作台', 'success');

           } catch(e) { 
               Swal.fire('错误', '部署失败: ' + e.message, 'error'); 
               wbLog(\`❌ Error: \${e.message}\`, 'text-red-500');
           }
          btn.disabled = false;
          btn.innerText = "🚀 开始部署";
      }

      function openBatchDeployModal() {
          const m = document.getElementById('batch_deploy_modal');
          const list = document.getElementById('bd_account_list');
          list.innerHTML = '';
          accounts.forEach(a => {
              const div = document.createElement('div');
              div.className = "flex items-center gap-1";
              div.innerHTML = \`<input type="checkbox" value="\${a.alias}" class="bd-acc-chk" id="chk_\${a.alias}"><label for="chk_\${a.alias}">\${a.alias}</label>\`;
              list.appendChild(div);
          });
          document.getElementById('bd_uuid').value = crypto.randomUUID();
          toggleBatchInputs();
          m.classList.remove('hidden');
      }

      function toggleBatchInputs() {
          const t = document.getElementById('bd_template').value;
          document.getElementById('bd_config_cmliu').classList.toggle('hidden', t !== 'cmliu');
          document.getElementById('bd_config_joey').classList.toggle('hidden', t !== 'joey');
          const kvCheck = document.getElementById('bd_enable_kv');
          if (t === 'joey') kvCheck.checked = false; else kvCheck.checked = true;
      }



      let currentManageAccIndex = -1;

      async function openAccountManage(i) {
          currentManageAccIndex = i;
          const acc = accounts[i];
          if (!acc.globalKey) return Swal.fire('无法管理', '请先配置 Global API Key', 'error');

          const modal = document.getElementById('account_manage_modal');
          const table = document.getElementById('manage_table');
          const tbody = document.getElementById('manage_list_body');
          const loading = document.getElementById('manage_loading');
          const subDisplay = document.getElementById('manage_subdomain_display');
          
          document.getElementById('manage_modal_title').innerText = \`📂 管理账号: \${acc.alias}\`;
          subDisplay.innerText = '加载中...';
          modal.classList.remove('hidden');
          table.classList.add('hidden');
          loading.classList.remove('hidden');
          tbody.innerHTML = '';

          // 并行加载 Workers 列表和子域名
          try {
              const [workersRes, subRes] = await Promise.all([
                  fetch('/api/all_workers', {
                      method: 'POST',
                      body: JSON.stringify({ accountId: acc.accountId, email: acc.email, globalKey: acc.globalKey })
                  }),
                  fetch('/api/get_subdomain', {
                      method: 'POST',
                      body: JSON.stringify({ accountId: acc.accountId, email: acc.email, globalKey: acc.globalKey })
                  })
              ]);
              
              // 处理子域名
              const subData = await subRes.json();
              if (subData.success && subData.subdomain) {
                  subDisplay.innerText = subData.subdomain;
              } else {
                  subDisplay.innerText = subData.msg || '未设置';
              }

              // 处理 Workers 列表
              const d = await workersRes.json();
              loading.classList.add('hidden');
              
              if (d.success) {
                  table.classList.remove('hidden');
                  if (d.workers.length === 0) {
                      tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4">无 Worker</td></tr>';
                  } else {
                      tbody.innerHTML = d.workers.map(w => \`
                          <tr class="hover:bg-gray-50 border-b">
                              <td class="font-bold text-indigo-600">\${w.id}</td>
                              <td>\${new Date(w.created_on).toLocaleDateString()}</td>
                              <td>\${new Date(w.modified_on).toLocaleDateString()}</td>
                              <td class="text-right">
                                  <button onclick="confirmDeleteWorker('\${acc.alias}', '\${w.id}', \${i})" class="text-xs bg-red-100 text-red-600 px-2 py-1 rounded hover:bg-red-200">🗑️ 删除</button>
                              </td>
                          </tr>
                      \`).join('');
                  }
              } else {
                  tbody.innerHTML = \`<tr><td colspan="4" class="text-center text-red-500 py-4">\${d.msg}</td></tr>\`;
                  table.classList.remove('hidden');
              }
          } catch(e) { loading.innerText = "网络错误"; }
      }

      async function promptChangeSubdomain() {
          if (currentManageAccIndex < 0) return;
          const acc = accounts[currentManageAccIndex];
          const currentSub = document.getElementById('manage_subdomain_display').innerText;
          
          const { value: newSub } = await Swal.fire({
              title: '修改 Workers.dev 子域名',
              html: \`
                  <div class="text-left text-sm space-y-2">
                      <div class="bg-gray-50 p-2 rounded">当前: <b>\${currentSub}</b>.workers.dev</div>
                      <input id="swal_new_subdomain" class="swal2-input" placeholder="输入新子域名前缀" style="margin:0;width:100%">
                      <div class="text-xs text-gray-400">⚠️ 修改子域名可能需要数分钟生效，且可能影响现有 Worker 的访问地址。</div>
                  </div>
              \`,
              focusConfirm: false,
              showCancelButton: true,
              confirmButtonText: '确认修改',
              cancelButtonText: '取消',
              confirmButtonColor: '#4f46e5',
              preConfirm: () => {
                  const val = document.getElementById('swal_new_subdomain').value.trim();
                  if (!val) { Swal.showValidationMessage('请输入新子域名'); return false; }
                  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(val) && val.length > 1 || val.length < 1) {
                      Swal.showValidationMessage('子域名只能包含字母、数字和连字符'); return false;
                  }
                  return val;
              }
          });

          if (!newSub) return;

          const confirm2 = await Swal.fire({
              title: '二次确认',
              html: \`确定将子域名从 <b>\${currentSub}</b> 改为 <b>\${newSub}</b> 吗？<br><span class="text-xs text-red-500">此操作会影响所有使用 workers.dev 域名的 Worker！</span>\`,
              icon: 'warning',
              showCancelButton: true,
              confirmButtonText: '确认修改',
              cancelButtonText: '取消',
              confirmButtonColor: '#d33'
          });

          if (!confirm2.isConfirmed) return;

          try {
              Swal.fire({ title: '修改中...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
              const res = await fetch('/api/change_subdomain', {
                  method: 'POST',
                  body: JSON.stringify({ accountId: acc.accountId, email: acc.email, globalKey: acc.globalKey, newSubdomain: newSub })
              });
              const data = await res.json();
              if (data.success) {
                  document.getElementById('manage_subdomain_display').innerText = data.subdomain || newSub;
                  Swal.fire('修改成功', \`子域名已更新为: \${data.subdomain || newSub}.workers.dev\`, 'success');
              } else {
                  Swal.fire('修改失败', data.msg || '未知错误', 'error');
              }
          } catch(e) {
              Swal.fire('错误', '网络错误: ' + e.message, 'error');
          }
      }

      async function confirmDeleteWorker(alias, workerId, accIndex) {
          const result = await Swal.fire({
              title: '危险操作',
              html: \`
                <p>确认要删除 <b>\${workerId}</b> 吗？</p>
                <div class="mt-4 text-left bg-gray-50 p-2 rounded text-xs">
                    <label class="flex items-center space-x-2">
                        <input type="checkbox" id="del_kv_chk" checked class="form-checkbox text-red-600">
                        <span class="text-gray-700 font-bold">同时删除绑定的 KV (推荐)</span>
                    </label>
                    <p class="text-gray-400 mt-1 pl-5">执行顺序: 1.读取绑定 -> 2.删除Worker(自动解绑) -> 3.删除KV空间</p>
                </div>
              \`,
              icon: 'warning',
              showCancelButton: true,
              confirmButtonText: '确认删除',
              confirmButtonColor: '#d33',
              showLoaderOnConfirm: true,
              preConfirm: () => {
                  const deleteKv = document.getElementById('del_kv_chk').checked;
                  const acc = accounts[accIndex];
                  return fetch('/api/delete_worker', {
                      method: 'POST',
                      body: JSON.stringify({ 
                          accountId: acc.accountId, 
                          email: acc.email, 
                          globalKey: acc.globalKey, 
                          workerName: workerId,
                          deleteKv: deleteKv 
                      })
                  }).then(response => response.json()).then(data => {
                      if (!data.success) throw new Error(data.msg);
                      return data;
                  }).catch(error => Swal.showValidationMessage(\`删除失败: \${error}\`));
              }
          });

          if (result.isConfirmed) {
              Swal.fire('已删除', 'Worker 及相关资源已清理', 'success');
              await loadAccounts(); 
              openAccountManage(accIndex);
          }
      }

      function renderTable() {
          const tb = document.getElementById('account_body');
          if (accounts.length === 0) { tb.innerHTML = '<tr><td colspan="6" class="text-center text-gray-300 py-4">无数据</td></tr>'; return; }
          const sortedAccounts = [...accounts].sort((a, b) => b.stats.total - a.stats.total);
          tb.innerHTML = sortedAccounts.map((a) => {
              const originalIndex = accounts.findIndex(acc => acc.alias === a.alias);
              const count = (a.workers_cmliu||[]).length + (a.workers_joey||[]).length + (a.workers_ech||[]).length;
              const percent = ((a.stats.total / a.stats.max) * 100).toFixed(1);
              let barColor = 'bg-green-500'; if (percent > 80) barColor = 'bg-orange-500'; if (percent >= 100) barColor = 'bg-red-600';
              const zoneBadge = a.defaultZoneName ? \`<span class="bg-purple-100 text-purple-600 text-[10px] px-1 rounded">\${a.defaultZoneName}</span>\` : '<span class="text-gray-300">-</span>';
              return \`<tr class="hover:bg-gray-50 border-b">
                  <td class="font-medium">\${a.alias}</td>
                  <td>\${zoneBadge}</td>
                  <td><span class="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">\${count} 个</span></td>
                  <td>\${a.stats.total}</td>
                  <td><div class="flex items-center gap-2"><div class="w-12 bg-gray-200 rounded-full h-1.5 overflow-hidden"><div class="\${barColor} h-1.5" style="width: \${Math.min(percent, 100)}%"></div></div><span class="text-[10px]">\${percent}%</span></div></td>
                  <td class="text-right">
                      <button onclick="openAccountManage(\${originalIndex})" class="text-purple-600 mr-2 text-xs font-bold hover:bg-purple-50 px-1 rounded">📂 管理</button>
                      <button onclick="editAccount(\${originalIndex})" class="text-blue-500 mr-2 text-xs">✎</button>
                      <button onclick="delAccount(\${originalIndex})" class="text-red-500 text-xs">×</button>
                  </td>
              </tr>\`;
          }).join('');
      }

      async function loadAccounts() { try { const r = await fetch('/api/accounts'); accounts = await r.json(); accounts.forEach(a => a.stats = a.stats || {total:0,max:100000}); renderTable(); } catch(e){} }
      
      async function saveAccount() { 
          const o={
              alias:document.getElementById('in_alias').value,
              accountId:document.getElementById('in_id').value,
              email:document.getElementById('in_email').value,
              globalKey:document.getElementById('in_gkey').value,
              defaultZoneName:document.getElementById('in_zone_name').value,
              defaultZoneId:document.getElementById('in_zone_id').value,
              stats:(editingIndex>=0 && accounts[editingIndex]) ? (accounts[editingIndex].stats || {total:0,max:100000}) : {total:0,max:100000}
          }; 
          ['cmliu','joey','ech'].forEach(t=>o['workers_'+t]=document.getElementById('in_workers_'+t).value.split(/,|，/).map(s=>s.trim()).filter(s=>s)); 
          if(editingIndex>=0)accounts[editingIndex]=o; else accounts.push(o); 
          await fetch('/api/accounts',{method:'POST',body:JSON.stringify(accounts)}); 
          renderTable(); 
          document.getElementById('account_form').classList.add('hidden'); 
      }

      function editAccount(i){ 
          editingIndex=i; const a=accounts[i]; 
          document.getElementById('in_alias').value=a.alias; 
          document.getElementById('in_id').value=a.accountId; 
          document.getElementById('in_email').value=a.email||""; 
          document.getElementById('in_gkey').value=a.globalKey||""; 
          document.getElementById('in_zone_name').value=a.defaultZoneName||""; 
          document.getElementById('in_zone_id').value=a.defaultZoneId||""; 
          
          const select = document.getElementById('in_zone_select');
          if(a.defaultZoneName) { select.innerHTML = \`<option value="\${a.defaultZoneId}" data-name="\${a.defaultZoneName}" selected>\${a.defaultZoneName}</option>\`; } else { select.innerHTML = '<option value="">(请点击读取)</option>'; }

          ['cmliu','joey','ech'].forEach(t=>document.getElementById('in_workers_'+t).value=(a['workers_'+t]||[]).join(',')); 
          document.getElementById('account_form').classList.remove('hidden'); 
      }

      async function delAccount(i){ if(confirm('删除账号配置？')){ accounts.splice(i,1); await fetch('/api/accounts',{method:'POST',body:JSON.stringify(accounts)}); renderTable(); } }
      function resetFormForAdd(){ editingIndex=-1; document.querySelectorAll('#account_form input').forEach(i=>i.value=''); document.getElementById('in_zone_select').innerHTML='<option value="">(请先填写API信息后点击读取)</option>'; document.getElementById('account_form').classList.remove('hidden'); }
      function cancelEdit(){ document.getElementById('account_form').classList.add('hidden'); }
      async function deleteFromEdit(){ if(editingIndex>=0)delAccount(editingIndex); cancelEdit(); }
      async function loadStats(){ const b=document.getElementById('btn_stats'); b.disabled=true; try{ const r=await fetch('/api/stats'); const d=await r.json(); accounts.forEach(a=>{ const s=d.find(x=>x.alias===a.alias); a.stats=s&&!s.error?s:{total:0,max:100000}; }); renderTable(); }catch(e){} b.disabled=false; }
      
      function toggleEchToken() {
          const enabled = document.getElementById('ech_token_enabled').checked;
          const input = document.getElementById('ech_token_input');
          const status = document.getElementById('ech_token_status');
          if (enabled) {
              input.disabled = false;
              input.classList.remove('opacity-50', 'cursor-not-allowed');
              status.textContent = '(已开启 - Token 将注入)';
              status.className = 'text-green-600 text-[10px] font-bold';
          } else {
              input.disabled = true;
              input.classList.add('opacity-50', 'cursor-not-allowed');
              status.textContent = '(关闭 - 不填入)';
              status.className = 'text-gray-400 text-[10px]';
          }
      }

      async function deploy(t, sha='') {
         const btn = document.getElementById('btn_deploy_' + t); const ot = btn.innerText; btn.innerText = '⏳ 部署中...'; btn.disabled = true;
         const vars = []; document.querySelectorAll('.var-row-' + t).forEach(r => { const k = r.querySelector('.key').value; const v = r.querySelector('.val').value; if(k) vars.push({key: k, value: v}); });

         // ECH Token 处理：开关开启且有 token 值，则把 TOKEN 加入 vars
         let echTokenEnabled = false;
         let echDisableWorkersDev = false;
         if (t === 'ech') {
             const tokenEnabled = document.getElementById('ech_token_enabled').checked;
             const tokenVal = document.getElementById('ech_token_input').value.trim();
             echTokenEnabled = tokenEnabled && !!tokenVal;
             if (tokenVal) {
                 const idx = vars.findIndex(v => v.key === 'TOKEN');
                 if (idx !== -1) vars[idx].value = tokenVal;
                 else vars.push({ key: 'TOKEN', value: tokenVal });
             }
             vars._echTokenEnabled = echTokenEnabled;
             echDisableWorkersDev = document.getElementById('ech_disable_workers_dev').checked;
         }

         await fetch('/api/settings?type=' + t, {method: 'POST', body: JSON.stringify(vars)});
         openWorkbench();
         wbLog('⚡ Deploying ' + t + '...', 'text-yellow-400');
         try {
             const res = await fetch('/api/deploy?type=' + t, { method: 'POST', body: JSON.stringify({ type: t, variables: vars, deletedVariables: deletedVars[t], targetSha: sha, echTokenEnabled: echTokenEnabled, echDisableWorkersDev: echDisableWorkersDev }) });
             const logs = await res.json();
             logs.forEach(l => wbLog('[' + (l.success ? 'OK' : 'ERR') + '] ' + l.name + ': ' + l.msg, l.success ? '' : 'text-red-400'));
             deletedVars[t] = [];
             setTimeout(() => { checkUpdate(t); checkDeployConfig(t); }, 1000);
         } catch(e) { wbLog('Error: ' + e.message, 'text-red-500'); }
         btn.innerText = ot; btn.disabled = false;
      }

      async function fix1101(t) {
          const confirm = await Swal.fire({
              title: '🔧 一键修复 1101',
              html: '<div class="text-left text-sm"><p class="mb-2">将对所有账号执行：</p><ol class="list-decimal pl-5 space-y-1"><li>📋 记录变量绑定 + 自定义域名</li><li>🗑️ 删除 Worker</li><li>🌐 随机修改子域名</li><li>🚀 用相同名称重建</li><li>♻️ 恢复所有变量值 + 自定义域名</li></ol><p class="mt-3 text-orange-600 font-bold">⚠️ 子域名变更影响该账号下所有 Worker！</p></div>',
              icon: 'warning', showCancelButton: true,
              confirmButtonText: '执行修复', cancelButtonText: '取消',
              confirmButtonColor: '#f97316'
          });
          if (!confirm.isConfirmed) return;
          const btn = document.getElementById('btn_fix1101_' + t); const ot = btn.innerText; btn.innerText = '⏳ 修复中...'; btn.disabled = true;
          openWorkbench();
          wbLog('🔧 正在修复 ' + t + ' 的 1101...', 'text-orange-400');
          try {
              const res = await fetch('/api/fix_1101', { method: 'POST', body: JSON.stringify({ type: t }) });
              const logs = await res.json();
              logs.forEach(l => {
                  const color = l.success ? 'text-green-300' : 'text-red-400';
                  wbLog('[' + (l.success ? '✅' : '❌') + '] ' + l.name, color);
                  if (l.msg) l.msg.split(' | ').forEach(s => wbLog('   ' + s, 'text-slate-400'));
              });
              setTimeout(() => { checkUpdate(t); checkDeployConfig(t); }, 1000);
          } catch(e) { wbLog('Error: ' + e.message, 'text-red-500'); }
          btn.innerText = ot; btn.disabled = false;
      }

      function selectSyncAccount(t) {
          const m = document.getElementById('sync_select_modal');
          const l = document.getElementById('sync_list');
          const v = accounts.filter(a => a[\`workers_\${t}\`] && a[\`workers_\${t}\`].length);
          l.innerHTML = '';
          v.forEach(a => {
              const b = document.createElement('button');
              b.className = "w-full text-left bg-slate-50 p-2 mb-1 text-xs border rounded hover:bg-blue-50";
              b.innerHTML = \`<b>\${a.alias}</b> -> \${a[\`workers_\${t}\`][0]}\`;
              b.onclick = () => doSync(a, t, a[\`workers_\${t}\`][0]);
              l.appendChild(b);
          });
          m.classList.remove('hidden');
      }

      async function doSync(a, t, n) {
          document.getElementById('sync_select_modal').classList.add('hidden');
          if (!confirm('确认覆盖当前变量配置?')) return;
          const r = await fetch('/api/fetch_bindings', {
              method: 'POST',
              body: JSON.stringify({ accountId: a.accountId, email: a.email, globalKey: a.globalKey, workerName: n })
          });
          const d = await r.json();
          if (d.success) {
              const c = document.getElementById(\`vars_\${t}\`);
              c.innerHTML = ''; deletedVars[t] = [];
              d.data.forEach(v => addVarRow(t, v.key, v.value));
              Swal.fire('同步成功', '变量已更新', 'success');
          } else { Swal.fire('同步失败', d.msg, 'error'); }
      }

      function renderProxySelector(){ const c=document.getElementById('ech_proxy_selector_container'); let h='<select id="ech_proxy_select" onchange="applyEchProxy()" class="w-full text-xs border rounded p-1 mb-1"><option value="">-- Select ProxyIP --</option>'; ECH_PROXIES.forEach(g=>{ h+=\`<optgroup label="\${g.group}">\`; g.list.forEach(i=>h+=\`<option value="\${i.split(' ')[0]}">\${i}</option>\`); h+='</optgroup>'; }); c.innerHTML=h+'</select>'; }
      function applyEchProxy(){ const v=document.getElementById('ech_proxy_select').value; if(v)addVarRow('ech','PROXYIP',v); }
      function addVarRow(t,k='',v=''){ const c=document.getElementById(\`vars_\${t}\`); const d=document.createElement('div'); d.className=\`flex gap-1 items-center mb-1 var-row-\${t}\`; let h=''; if(t==='cmliu'&&(k==='PROXYIP'||k==='DOH')){ const options=k==='DOH'?["https://dns.jhb.ovh/joeyblog","https://doh.cmliussss.com/CMLiussss","cloudflare-ech.com"]:ECH_PROXIES.flatMap(g=>g.list); h=\`<select onchange="this.previousElementSibling.value=this.value" class="w-4 border rounded text-[8px] bg-gray-50 cursor-pointer"><option>▼</option>\${options.map(u=>\`<option value="\${u.split(' ')[0]}">\${u}</option>\`).join('')}</select>\`; } d.innerHTML=\`<input class="input-field w-1/3 key font-bold" placeholder="Key" value="\${k}"><input class="input-field w-2/3 val" placeholder="Val" value="\${v}">\${h}<button onclick="removeVarRow(this,'\${t}')" class="text-gray-300 hover:text-red-500 px-1 font-bold">×</button>\`; c.appendChild(d); }
      function removeVarRow(b,t){ const k=b.parentElement.querySelector('.key').value; if(k)deletedVars[t].push(k); b.parentElement.remove(); }
      async function loadVars(t){ const c=document.getElementById(\`vars_\${t}\`); c.innerHTML='<div class="text-center text-gray-300">...</div>'; try{ const r=await fetch(\`/api/settings?type=\${t}\`); const v=await r.json(); const m=new Map(); if(Array.isArray(v))v.forEach(x=>m.set(x.key,x.value)); TEMPLATES[t].defaultVars.forEach(k=>{ if(!m.has(k))m.set(k,k===TEMPLATES[t].uuidField?crypto.randomUUID():'') }); c.innerHTML=''; deletedVars[t]=[]; m.forEach((val,key)=>addVarRow(t,key,val)); }catch(e){ c.innerHTML='Load Error'; } }
      
      // Auto Config
      async function loadGlobalConfig(){ try{ const r=await fetch('/api/auto_config'); const c=await r.json(); document.getElementById('auto_update_toggle').checked=!!c.enabled; document.getElementById('auto_update_interval').value=c.interval||30; document.getElementById('fuse_threshold').value=c.fuseThreshold||0; }catch(e){} }
      async function saveAutoConfig(){ await fetch('/api/auto_config',{method:'POST',body:JSON.stringify({enabled:document.getElementById('auto_update_toggle').checked, interval:document.getElementById('auto_update_interval').value, fuseThreshold:document.getElementById('fuse_threshold').value})}); alert('已保存配置'); }
      
      async function checkUpdate(t){ 
          const el=document.getElementById(\`ver_\${t}\`); 
          try{ 
              const r=await fetch(\`/api/check_update?type=\${t}\`); 
              const d=await r.json(); 
              
              if(d.error) throw new Error(d.error);

              const remoteDate = new Date(d.remote.date).toLocaleString([], {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
              let statusHtml = '';
              let localDateStr = '未部署';

              if (d.local && d.local.date) {
                   localDateStr = new Date(d.local.date).toLocaleString([], {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
              }

              if(d.remote && (!d.local || d.remote.sha !== d.local.sha)) {
                  statusHtml = \`<div class="flex justify-between text-red-600 font-bold"><span>🚀 上游: \${remoteDate}</span><span class="animate-pulse">New!</span></div>\`;
              } else {
                  statusHtml = \`<div class="flex justify-between text-green-600"><span>✅ 上游: \${remoteDate}</span><span>Latest</span></div>\`;
              }
              
              const localClass = (d.local && d.remote && d.local.sha === d.remote.sha) ? 'text-gray-500' : 'text-orange-500 font-bold';
              const localHtml = \`<div class="flex justify-between \${localClass}"><span>💻 本地: \${localDateStr}</span><span>\${d.mode==='fixed'?'🔒 Locked':''}</span></div>\`;

              el.innerHTML = statusHtml + localHtml;
          }catch(err){ 
              el.innerHTML="<span class='text-red-400'>Check Fail</span>"; 
          } 
      }
      
      function timeAgo(s){ const sec=(new Date()-new Date(s))/1000; if(sec>86400)return Math.floor(sec/86400)+"天前"; if(sec>3600)return Math.floor(sec/3600)+"小时前"; return "刚刚"; }
      function refreshUUID(t){ const k=TEMPLATES[t].uuidField; if(k)document.querySelectorAll(\`.var-row-\${t}\`).forEach(r=>{ if(r.querySelector('.key').value===k){ const i=r.querySelector('.val'); i.value=crypto.randomUUID(); i.classList.add('bg-green-100'); setTimeout(()=>i.classList.remove('bg-green-100'),500); } }); }
      async function checkDeployConfig(t){ try{ const r=await fetch(\`/api/deploy_config?type=\${t}\`); const c=await r.json(); deployConfigs[t]=c; const b=document.getElementById(\`badge_\${t}\`); if(c.mode==='fixed'){ b.className="text-[9px] px-1.5 py-0.5 rounded text-white bg-orange-500 font-bold"; b.innerText="🔒 Locked"; }else{ b.className="text-[9px] px-1.5 py-0.5 rounded text-white bg-green-500"; b.innerText="Auto Update"; } }catch(e){} }

      // 历史记录 & 收藏 (新版逻辑)
      async function openVersionHistory(type){ currentHistoryType=type; refreshHistory(); }
      async function refreshHistory() {
          const type = currentHistoryType; if(!type) return;
          const limit = document.getElementById('history_limit_input').value || 10;
          const modal=document.getElementById('history_modal');const hList=document.getElementById('history_list');
          
          modal.classList.remove('hidden');
          document.getElementById('fav_panel_view').classList.add('hidden');
          document.getElementById('history_panel_view').classList.remove('hidden');

          hList.innerHTML='<div class="text-center text-gray-400 text-xs py-4">加载中...</div>';

          try{
            const[histRes,favRes]=await Promise.all([fetch(\`/api/check_update?type=\${type}&mode=history&limit=\${limit}\`),fetch(\`/api/favorites?type=\${type}\`)]);
            const histData=await histRes.json();const favData=await favRes.json();
            
            // 收藏夹渲染逻辑移到 openFavoritesPanel
            window.currentFavData = favData || [];

            hList.innerHTML='';
            const latestBtn=document.createElement('div');
            latestBtn.className="bg-green-50 hover:bg-green-100 p-2 rounded border border-green-200 cursor-pointer transition mb-2";
            latestBtn.innerHTML=\`<div class="flex justify-between items-center"><span class="font-bold text-green-700 text-xs">⚡ Always Latest (部署最新)</span></div>\`;
            latestBtn.onclick=()=>{modal.classList.add('hidden');deploy(type,'latest');};
            hList.appendChild(latestBtn);
            
            if(histData.history){
                histData.history.forEach(commit=>{
                    const item={sha:commit.sha,date:commit.commit.committer.date,message:commit.commit.message};
                    const isFav=window.currentFavData.find(f=>f.sha===item.sha);
                    renderHistoryItem(type,item,hList,false,isFav);
                });
            }
          }catch(e){hList.innerHTML='<div class="text-red-400 text-xs">网络错误: ' + e.message + '</div>';}
      }

      function openFavoritesPanel() {
          document.getElementById('history_panel_view').classList.add('hidden');
          const panel = document.getElementById('fav_panel_view');
          const list = document.getElementById('fav_full_list');
          panel.classList.remove('hidden');
          panel.classList.add('flex');
          list.innerHTML = '';
          
          if(window.currentFavData && window.currentFavData.length > 0) {
              window.currentFavData.forEach(item => {
                  renderHistoryItem(currentHistoryType, item, list, true, true);
              });
          } else {
              list.innerHTML = '<div class="text-center text-gray-400 text-xs py-4">暂无收藏</div>';
          }
      }

      function closeFavoritesPanel() {
          document.getElementById('fav_panel_view').classList.add('hidden');
          document.getElementById('fav_panel_view').classList.remove('flex');
          document.getElementById('history_panel_view').classList.remove('hidden');
      }
      
      function renderHistoryItem(type,item,container,isFavSection,isFavInHist){
          const shortSha=item.sha.substring(0,7);
          const date=new Date(item.date).toLocaleString();
          const isCurrent=deployConfigs[type]&&deployConfigs[type].currentSha===item.sha;
          const el=document.createElement('div');
          el.className=\`group relative p-2 rounded border transition mb-1 flex gap-2 \${isCurrent?'bg-orange-50 border-orange-300':'bg-white border-gray-100 hover:border-blue-200'}\`;
          
          const starBtn=document.createElement('button');
          starBtn.className=\`text-sm focus:outline-none \${(isFavSection||isFavInHist)?'text-orange-400':'text-gray-300 hover:text-orange-400'}\`;
          starBtn.innerHTML=(isFavSection||isFavInHist)?'★':'☆';
          starBtn.onclick=(e)=>{
              e.stopPropagation();
              toggleFavorite(type,item,(isFavSection||isFavInHist));
          };
          
          const content=document.createElement('div');
          content.className="flex-1 cursor-pointer overflow-hidden";
          content.innerHTML=\`<div class="flex justify-between items-center mb-0.5"><span class="font-mono text-[10px] bg-slate-100 px-1 rounded text-slate-600">\${shortSha}</span><span class="text-[9px] text-gray-400">\${date}</span></div><div class="text-[10px] text-gray-700 truncate">\${item.message}</div>\`;
          content.onclick=()=>{if(confirm(\`确认回滚/锁定到版本 [\${shortSha}]？\`)){document.getElementById('history_modal').classList.add('hidden');deploy(type,item.sha);}};
          
          el.appendChild(starBtn);el.appendChild(content);container.appendChild(el);
      }
      
      async function toggleFavorite(type,item,isRemove){
          await fetch(\`/api/favorites?type=\${type}\`,{method:'POST',body:JSON.stringify({action:isRemove?'remove':'add',item:item})});
          // 刷新数据
          const r = await fetch(\`/api/favorites?type=\${type}\`);
          window.currentFavData = await r.json();
          // 如果在收藏面板，重新渲染收藏列表；如果在历史面板，刷新历史
          if(!document.getElementById('fav_panel_view').classList.contains('hidden')) {
              openFavoritesPanel();
          } else {
              refreshHistory();
          }
      }

      // ============== 星空主题引擎 ==============
      let starAnimId = null;
      function initStarfield() {
          const canvas = document.getElementById('starfield');
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          let stars = [], shootingStars = [];
          
          function resize() {
              canvas.width = window.innerWidth;
              canvas.height = window.innerHeight;
          }
          resize();
          window.addEventListener('resize', resize);
          
          // 生成星星
          function createStars() {
              stars = [];
              const count = Math.floor((canvas.width * canvas.height) / 3000);
              for (let i = 0; i < count; i++) {
                  stars.push({
                      x: Math.random() * canvas.width,
                      y: Math.random() * canvas.height,
                      r: Math.random() * 1.5 + 0.3,
                      alpha: Math.random(),
                      delta: (Math.random() * 0.02 + 0.003) * (Math.random() > 0.5 ? 1 : -1),
                      color: ['#ffffff', '#c4b5fd', '#93c5fd', '#fcd34d', '#a5b4fc'][Math.floor(Math.random() * 5)]
                  });
              }
          }
          createStars();
          window.addEventListener('resize', createStars);

          // 流星
          function maybeShootingStar() {
              if (Math.random() < 0.008 && shootingStars.length < 3) {
                  shootingStars.push({
                      x: Math.random() * canvas.width * 0.7,
                      y: Math.random() * canvas.height * 0.3,
                      len: Math.random() * 80 + 40,
                      speed: Math.random() * 6 + 4,
                      alpha: 1
                  });
              }
          }
          
          function draw() {
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              // 深空渐变背景
              const grad = ctx.createRadialGradient(canvas.width/2, canvas.height/2, 0, canvas.width/2, canvas.height/2, canvas.width*0.7);
              grad.addColorStop(0, '#0f172a');
              grad.addColorStop(0.5, '#0c1222');
              grad.addColorStop(1, '#020617');
              ctx.fillStyle = grad;
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              
              // 星云光晕
              const nebula = ctx.createRadialGradient(canvas.width * 0.2, canvas.height * 0.3, 0, canvas.width * 0.2, canvas.height * 0.3, 300);
              nebula.addColorStop(0, 'rgba(139, 92, 246, 0.03)');
              nebula.addColorStop(1, 'transparent');
              ctx.fillStyle = nebula;
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              
              const nebula2 = ctx.createRadialGradient(canvas.width * 0.8, canvas.height * 0.7, 0, canvas.width * 0.8, canvas.height * 0.7, 250);
              nebula2.addColorStop(0, 'rgba(59, 130, 246, 0.025)');
              nebula2.addColorStop(1, 'transparent');
              ctx.fillStyle = nebula2;
              ctx.fillRect(0, 0, canvas.width, canvas.height);

              // 绘制星星
              for (const s of stars) {
                  s.alpha += s.delta;
                  if (s.alpha <= 0.1 || s.alpha >= 1) s.delta = -s.delta;
                  ctx.beginPath();
                  ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
                  ctx.fillStyle = s.color;
                  ctx.globalAlpha = Math.max(0.1, Math.min(1, s.alpha));
                  ctx.fill();
              }
              ctx.globalAlpha = 1;
              
              // 流星
              maybeShootingStar();
              shootingStars = shootingStars.filter(m => {
                  m.x += m.speed; m.y += m.speed * 0.6; m.alpha -= 0.015;
                  if (m.alpha <= 0) return false;
                  ctx.save();
                  ctx.globalAlpha = m.alpha;
                  const gradient = ctx.createLinearGradient(m.x, m.y, m.x - m.len, m.y - m.len * 0.6);
                  gradient.addColorStop(0, '#ffffff');
                  gradient.addColorStop(1, 'transparent');
                  ctx.strokeStyle = gradient;
                  ctx.lineWidth = 1.5;
                  ctx.beginPath();
                  ctx.moveTo(m.x, m.y);
                  ctx.lineTo(m.x - m.len, m.y - m.len * 0.6);
                  ctx.stroke();
                  ctx.restore();
                  return true;
              });
              
              starAnimId = requestAnimationFrame(draw);
          }
          draw();
      }
      
      function stopStarfield() {
          if (starAnimId) { cancelAnimationFrame(starAnimId); starAnimId = null; }
      }
      
      function toggleTheme() {
          const html = document.documentElement;
          const isDark = html.getAttribute('data-theme') === 'dark';
          if (isDark) {
              html.removeAttribute('data-theme');
              document.getElementById('theme_btn').innerText = '🌙';
              stopStarfield();
              localStorage.setItem('worker_theme', 'light');
          } else {
              html.setAttribute('data-theme', 'dark');
              document.getElementById('theme_btn').innerText = '☀️';
              initStarfield();
              localStorage.setItem('worker_theme', 'dark');
          }
      }

      // ================= YXIP 前端核心逻辑 =================
      const REGION_MAP = {'JP':'日本','KR':'韩国','SG':'新加坡','HK':'香港','TW':'台湾','MY':'马来西亚','TH':'泰国','VN':'越南','PH':'菲律宾','ID':'印尼','IN':'印度','AU':'澳大利亚','NZ':'新西兰','GB':'英国','UK':'英国','DE':'德国','FR':'法国','NL':'荷兰','IT':'意大利','ES':'西班牙','US':'美国','CA':'加拿大','BR':'巴西','ZA':'南非','AE':'阿联酋','RU':'俄罗斯','UA':'乌克兰','SE':'瑞典','CH':'瑞士','TR':'土耳其','AR':'阿根廷','CL':'智利','CO':'哥伦比亚','PE':'秘鲁','MX':'墨西哥','PL':'波兰','FI':'芬兰','NO':'挪威','DK':'丹麦','IE':'爱尔兰','BE':'比利时','AT':'奥地利','CZ':'捷克','HU':'匈牙利','RO':'罗马尼亚','GR':'希腊','PT':'葡萄牙'};
      function getFlagEmoji(code) { if (code === 'TW') return '🇹🇼'; if (code === 'UK') return '🇬🇧'; if (!code || code.length !== 2) return '🇺🇳'; const codePoints = code.toUpperCase().split('').map(char => 127397 + char.charCodeAt()); return String.fromCodePoint(...codePoints); }
      
      let yxipData = {};
      let yxipSelected = [];

      async function showYxipModal() {
          document.getElementById('yxip_modal').classList.remove('hidden');
          toggleYxipAccountSelect();
          if (Object.keys(yxipData).length === 0) {
              await fetchYxipRegions();
          }
      }

      function toggleYxipAccountSelect() {
          const type = document.getElementById('yxip_type').value;
          const accountArea = document.getElementById('yxip_cmliu_account_area');
          const accountList = document.getElementById('yxip_account_list');
          
          accountArea.classList.remove('hidden');
          const borderCls = type === 'cmliu' ? 'border-red-200' : 'border-blue-200';
          const txtCls = type === 'cmliu' ? 'text-red-500' : 'text-blue-500';
          const bgHoverCls = type === 'cmliu' ? 'hover:bg-red-50' : 'hover:bg-blue-50';
          const badgeBgCls = type === 'cmliu' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600';
          const targetArrName = type === 'cmliu' ? 'workers_cmliu' : 'workers_joey';
          const targetNameStr = type === 'cmliu' ? 'CMLiu' : 'Joey';
          
          const btnHtml = '<div class="col-span-full flex gap-2 mb-1"><button onclick="document.querySelectorAll(\\\'input[name=yxip_account]:not([disabled])\\\').forEach(c=>c.checked=true)" class="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded">全选有效账号</button><button onclick="document.querySelectorAll(\\\'input[name=yxip_account]\\\').forEach(c=>c.checked=false)" class="text-xs bg-gray-100 text-gray-500 px-2 py-1 rounded">反选所有账号</button></div>';
          
          accountList.className = 'max-h-[150px] overflow-y-auto border rounded p-3 bg-white grid grid-cols-1 md:grid-cols-2 gap-2 shadow-inner ' + borderCls;
          accountList.innerHTML = btnHtml + accounts.map(a => {
              const targetWorkers = a[targetArrName] || [];
              const noWorker = targetWorkers.length === 0;
              const badge = noWorker ? '<span class="text-[10px] text-gray-400 ml-auto mx-1">无 ' + targetNameStr + ' 项目</span>' : '<span class="' + badgeBgCls + ' px-1.5 py-0.5 rounded text-[10px] ml-auto">' + targetWorkers.length + ' 个项目</span>';
              const opacityClass = noWorker ? 'opacity-50 grayscale' : '';
              const disabledAttr = noWorker ? 'disabled' : '';
              return '<label class="flex items-center gap-2 p-2 border rounded cursor-pointer transition-colors ' + bgHoverCls + ' ' + opacityClass + '">' +
                  '<input type="checkbox" name="yxip_account" value="' + a.accountId + '" class="' + txtCls + '" ' + disabledAttr + '>' +
                  '<span class="text-xs font-bold text-gray-700 truncate" title="' + a.email + '">' + a.email + '</span>' +
                  badge +
              '</label>';
          }).join('');
      }

      async function fetchYxipRegions() {
          const container = document.getElementById('yxip_regions');
          container.innerHTML = '<div class="col-span-full text-center py-4 text-gray-400">✈️ 正在获取全球节点数据...</div>';
          try {
              const res = await fetch('/api/get_regions_data');
              const data = await res.json();
              if(data.success) {
                  yxipData = data.data;
                  renderYxipRegions();
              } else {
                  container.innerHTML = '<div class="col-span-full text-center py-4 text-red-500">❌ 获取失败: ' + data.msg + '</div>';
              }
          } catch(e) {
              container.innerHTML = '<div class="col-span-full text-center py-4 text-red-500">❌ 网络异常，获取节点数据失败</div>';
          }
      }

      function renderYxipRegions() {
          const container = document.getElementById('yxip_regions');
          const codes = Object.keys(yxipData).sort();
          if (codes.length === 0) {
              container.innerHTML = '<div class="col-span-full text-center py-4 text-gray-400">没有找到任何可用节点</div>';
              return;
          }
          container.innerHTML = codes.map(code => {
              const count = yxipData[code].length;
              const cname = REGION_MAP[code] || code;
              return '<label class="flex items-center gap-1.5 p-1.5 border rounded cursor-pointer hover:bg-yellow-50 transition-colors">' +
                  '<input type="checkbox" value="' + code + '" onchange="toggleYxipRegion(this)" class="text-yellow-500 accent-yellow-500 rounded">' +
                  '<span class="font-bold text-gray-700 text-sm truncate">' + cname + '</span>' +
                  '<span class="text-[10px] text-gray-400 ml-auto">' + count + '</span>' +
              '</label>';
          }).join('');
      }

      function toggleYxipRegion(checkbox) {
          if(checkbox.checked) yxipSelected.push(checkbox.value);
          else yxipSelected = yxipSelected.filter(v => v !== checkbox.value);
      }

      function yxipSelectAll() {
          document.querySelectorAll('#yxip_regions input[type="checkbox"]').forEach(cb => {
              if(!cb.checked) { cb.checked = true; yxipSelected.push(cb.value); }
          });
      }

      function yxipSelectNone() {
          document.querySelectorAll('#yxip_regions input[type="checkbox"]').forEach(cb => { cb.checked = false; });
          yxipSelected = [];
      }
      
      // Fisher-Yates shuffle
      function shuffleArray(array) {
          for (let i = array.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [array[i], array[j]] = [array[j], array[i]];
          }
          return array;
      }

      async function doYxipDeploy() {
          const type = document.getElementById('yxip_type').value;
          const limit = parseInt(document.getElementById('yxip_limit').value) || 10;
          
          if (yxipSelected.length === 0) return alert('⚠️ 请至少选择一个区域！');

          let targetAccounts = [];
          const checkedBoxes = Array.from(document.querySelectorAll('input[name="yxip_account"]:checked'));
          if (checkedBoxes.length === 0) {
               return alert(type === 'cmliu' ? '⚠️ 请至少选择一个包含有 CMLiu 项目的目标账号！' : '⚠️ 请至少选择一个包含有 Joey 项目的目标账号！');
          }
          checkedBoxes.forEach(box => {
              const acc = accounts.find(a => a.accountId === box.value);
              if (acc) targetAccounts.push(acc);
          });

          const btnIcon = document.getElementById('yxip_btn_icon');
          btnIcon.innerHTML = '<svg class="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';
          
          // 组装内容
          const regionCounters = {};
          const results = [];
          
          for (const region of yxipSelected) {
              const ipList = shuffleArray([...yxipData[region]]); // 深拷贝并打乱
              const toTake = Math.min(limit, ipList.length);
              
              for (let i = 0; i < toTake; i++) {
                  const item = ipList[i];
                  const code = item.code;
                  regionCounters[code] = (regionCounters[code] || 0) + 1;
                  const seqNo = regionCounters[code].toString().padStart(2, '0');
                  const flag = getFlagEmoji(code);
                  const cname = REGION_MAP[code] || code;
                  const alias = flag + ' ' + cname + ' ' + seqNo;
                  results.push(item.ipPort + '#' + alias);
              }
          }
          
          const rawContent = type.startsWith('joey') ? results.join(',') : results.join('\\n');
          
          try {
              document.getElementById('yxip_modal').classList.add('hidden');
              openWorkbench();
              wbLog('⚡ 开始进行反代落地部署...', 'text-yellow-400');
              
              if (type === 'joey_var') {
                  const res = await fetch('/api/save_yxip', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ type: 'joey_var', rawContent })
                  });
                  const logs = await res.json();
                  logs.forEach(l => {
                      wbLog(l.msg, l.success ? 'text-green-300' : 'text-red-500');
                  });
                  
                  wbLog('🔄 开始触发变量专属重加载部署...', 'text-yellow-300');
                  try {
                      const varsRes = await fetch('/api/settings?type=joey');
                      const varsList = await varsRes.json();
                      const accIds = targetAccounts.map(a => a.accountId);
                      
                      const deployRes = await fetch('/api/deploy', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                              type: 'joey',
                              variables: varsList,
                              deletedVariables: [],
                              targetAccountIds: accIds
                          })
                      });
                      const deployLogs = await deployRes.json();
                      deployLogs.forEach(l => wbLog('[' + (l.success ? '部署OK' : '报错') + '] ' + l.name + ': ' + l.msg, l.success ? 'text-green-300' : 'text-red-400'));
                  } catch (e) {
                      wbLog('⚠️ 下发变量部署失败: ' + e.message, 'text-red-500');
                  }
              } else {
                  for (let i = 0; i < targetAccounts.length; i++) {
                      const acc = targetAccounts[i];
                      wbLog('>> 正在处理账号: ' + acc.alias, 'text-blue-300');
                      const res = await fetch('/api/save_yxip', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                              type,
                              accountId: acc.accountId,
                              email: acc.email,
                              globalKey: acc.globalKey,
                              rawContent
                          })
                      });
                      const logs = await res.json();
                      logs.forEach(l => {
                          wbLog(l.msg, l.success ? 'text-green-300' : 'text-red-500');
                      });
                  }
              }
              
              wbLog('部署流程结束！', 'text-white font-bold');
              
              if (type === 'joey') {
                  wbLog('⚡ 提示：优选参数已经作为核心配置文件「c」发送到了指定目标账号下的所有 Joey 项目所绑定的 KV 空间。一般下一次访问接口时立即可生效。', 'text-blue-500 font-bold text-xs mt-2');
              } else if (type === 'joey_var') {
                  wbLog('⚡ 提示：优选参数已更新并触发了一次目标对应工作台的重加载执行部署。请留意上方控制台的下发动态。', 'text-blue-500 font-bold text-xs mt-2');
              } else if (type === 'cmliu') {
                  wbLog('⚡ 提示：CMLiu 优选节点列表已成功注入目标空间的「ADD.txt」。一般下一次访问接口时立即可生效。', 'text-blue-500 font-bold text-xs mt-2');
              }

          } catch (e) {
              alert('请求异常：' + e.message);
          } finally {
              btnIcon.innerHTML = '⚡';
          }
      }
      // ==================================================

      function applyTheme() {
          const saved = localStorage.getItem('worker_theme');
          if (saved === 'dark') {
              document.documentElement.setAttribute('data-theme', 'dark');
              document.getElementById('theme_btn').innerText = '\u2600\ufe0f';
              initStarfield();
          }
      }
      applyTheme();

      init();
    </script>
  </body></html>
    `;
}
