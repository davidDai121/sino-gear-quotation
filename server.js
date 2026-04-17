const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { URL } = require('url');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 8081;

const DEFAULT_JYT_ACCESS_TOKEN = "d6fc3ebbc062a95403315f6e17b5aa38";
const DEFAULT_USD_CNY_RATE = 6.8;
const DEFAULT_FOB_MARKUP_CNY = 20000;

// Chromium flags tuned for 512MB Render free tier. Every bit counts.
// NOTE: --single-process is NOT set here — it saves memory but causes navigation
// hangs on JS-heavy SPAs (which JYT is). The mutex is the real OOM protection.
const LOW_MEM_CHROMIUM_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI,BlinkGenPropertyTrees',
    '--disable-ipc-flooding-protection',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--disable-blink-features=AutomationControlled'
];

async function launchPuppeteerBrowser(extraArgs = []) {
    return puppeteer.launch({
        headless: 'new',
        args: [...LOW_MEM_CHROMIUM_ARGS, ...extraArgs],
        // Let Chromium figure out executable; pipe over WebSocket saves a bit of RAM too
        pipe: false
    });
}

// Mutex: serialize all Puppeteer work so two Chromium instances never run concurrently
// (two simultaneous browsers ~= 400-600MB → OOM on 512MB free tier).
const puppeteerWaiters = [];
let puppeteerBusy = false;

function acquirePuppeteerSlot(label) {
    if (!puppeteerBusy) {
        puppeteerBusy = true;
        return Promise.resolve();
    }
    const enqueuedAt = Date.now();
    console.log(`[puppeteer-mutex] ${label} queued (position ${puppeteerWaiters.length + 1})`);
    return new Promise(resolve => {
        puppeteerWaiters.push({ label, resolve, enqueuedAt });
    });
}

function releasePuppeteerSlot() {
    const next = puppeteerWaiters.shift();
    if (next) {
        const waitedMs = Date.now() - next.enqueuedAt;
        console.log(`[puppeteer-mutex] ${next.label} resumed after ${waitedMs}ms`);
        setImmediate(() => next.resolve()); // puppeteerBusy stays true for the next holder
    } else {
        puppeteerBusy = false;
        if (global.gc) try { global.gc(); } catch (_) {}
    }
}

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

function parsePositiveInt(value, fallback) {
    const n = Number.parseInt((value ?? '').toString(), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeInt(value, fallback) {
    const n = Number.parseInt((value ?? '').toString(), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

let runtimeJytAccessToken = null;
let runtimeJytAccessTokenSetAt = null;

// Storage backends for the JYT access token, in priority order:
//   1. Upstash Redis (if UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set)
//      → the only option that survives deploys on ephemeral hosts like Render free tier
//   2. Local JSON file at ./data/jyt-token.json (survives restarts on persistent disk)
//   3. JYT_ACCESS_TOKEN env var (platform dashboard)
//   4. Hardcoded DEFAULT_JYT_ACCESS_TOKEN (usually expired — last resort)
const TOKEN_FILE_PATH = path.join(__dirname, 'data', 'jyt-token.json');
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UPSTASH_KEY = process.env.UPSTASH_JYT_KEY || 'sinogear:jyt-access-token';
const UPSTASH_ENABLED = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

async function upstashCommand(args) {
    if (!UPSTASH_ENABLED) return null;
    const resp = await axios.post(UPSTASH_URL, args, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 8000,
        validateStatus: () => true
    });
    if (resp.status >= 400) throw new Error(`upstash ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
    return resp.data?.result ?? null;
}

async function upstashGetToken() {
    try {
        const raw = await upstashCommand(['GET', UPSTASH_KEY]);
        if (!raw) return null;
        try {
            const obj = JSON.parse(raw);
            return { token: obj.token, setAt: obj.setAt };
        } catch (_) {
            // Plain string token — tolerate it
            return { token: raw, setAt: null };
        }
    } catch (e) {
        console.log(`[upstash] get error: ${e.message}`);
        return null;
    }
}

async function upstashSetToken(token) {
    try {
        const payload = JSON.stringify({ token, setAt: new Date().toISOString() });
        await upstashCommand(['SET', UPSTASH_KEY, payload]);
        return true;
    } catch (e) {
        console.log(`[upstash] set error: ${e.message}`);
        return false;
    }
}

// GitHub auto-commit backend: rewrites the DEFAULT_JYT_ACCESS_TOKEN literal
// in server.js via the GitHub Contents API. On platforms with auto-deploy (Render
// with a GitHub-linked service), the commit triggers a redeploy so the token
// becomes the persistent default on the next cold start.
//
// Requires GITHUB_TOKEN (PAT with `contents:write` on this repo). Repo and
// branch are auto-detected from env / defaults.
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPO || 'davidDai121/sinogear-quotation';
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GH_FILE = process.env.GITHUB_TOKEN_FILE || 'server.js';
const GH_ENABLED = Boolean(GH_TOKEN);
const TOKEN_LINE_PATTERN = /(const\s+DEFAULT_JYT_ACCESS_TOKEN\s*=\s*")[^"]*(";)/;

async function githubCommitToken(newToken) {
    if (!GH_ENABLED) return { ok: false, reason: 'GITHUB_TOKEN not configured' };
    const api = axios.create({
        baseURL: 'https://api.github.com',
        headers: {
            Authorization: `Bearer ${GH_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'sinogear-quotation',
            'X-GitHub-Api-Version': '2022-11-28'
        },
        timeout: 15000,
        validateStatus: () => true
    });

    // 1. Fetch current file + sha
    const getResp = await api.get(`/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}?ref=${GH_BRANCH}`);
    if (getResp.status >= 400) {
        return { ok: false, reason: `GitHub GET failed (${getResp.status}): ${getResp.data?.message || ''}` };
    }
    const currentSha = getResp.data.sha;
    const currentContent = Buffer.from(getResp.data.content, 'base64').toString('utf8');

    if (!TOKEN_LINE_PATTERN.test(currentContent)) {
        return { ok: false, reason: 'DEFAULT_JYT_ACCESS_TOKEN line not found in remote file' };
    }
    const newContent = currentContent.replace(TOKEN_LINE_PATTERN, `$1${newToken}$2`);
    if (newContent === currentContent) {
        return { ok: true, unchanged: true };
    }

    // 2. Commit via PUT
    const putResp = await api.put(`/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}`, {
        message: `chore: rotate JYT access token (via /admin)`,
        content: Buffer.from(newContent, 'utf8').toString('base64'),
        sha: currentSha,
        branch: GH_BRANCH
    });
    if (putResp.status >= 400) {
        return { ok: false, reason: `GitHub PUT failed (${putResp.status}): ${putResp.data?.message || ''}` };
    }
    return { ok: true, commitSha: putResp.data?.commit?.sha, commitUrl: putResp.data?.commit?.html_url };
}

function loadPersistedToken() {
    try {
        if (!fs.existsSync(TOKEN_FILE_PATH)) return null;
        const raw = fs.readFileSync(TOKEN_FILE_PATH, 'utf8');
        const obj = JSON.parse(raw);
        const t = (obj?.token || '').toString().trim();
        return t ? { token: t, setAt: obj?.setAt || null } : null;
    } catch (e) {
        console.log(`[token] failed to load persisted token: ${e.message}`);
        return null;
    }
}

function persistToken(token) {
    try {
        const dir = path.dirname(TOKEN_FILE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const payload = { token, setAt: new Date().toISOString() };
        fs.writeFileSync(TOKEN_FILE_PATH, JSON.stringify(payload, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.log(`[token] failed to persist token: ${e.message}`);
        return false;
    }
}

function normalizeJytAccessToken(token) {
    const t = (token ?? '').toString().trim();
    return t ? t : null;
}

function getJytAccessToken() {
    return runtimeJytAccessToken || process.env.JYT_ACCESS_TOKEN || DEFAULT_JYT_ACCESS_TOKEN;
}

function getJytAccessTokenSource() {
    if (runtimeJytAccessToken) return 'runtime';
    if (process.env.JYT_ACCESS_TOKEN) return 'env';
    return 'default';
}

// Tracks which backend produced the current in-memory token (for status UI).
let runtimeJytAccessTokenOrigin = null; // 'upstash' | 'file' | null

// Load persisted token at startup. Try Upstash first (survives deploys),
// then fall back to the local file.
async function hydrateRuntimeToken() {
    if (UPSTASH_ENABLED) {
        const remote = await upstashGetToken();
        if (remote?.token) {
            runtimeJytAccessToken = remote.token;
            runtimeJytAccessTokenSetAt = remote.setAt ? new Date(remote.setAt) : new Date();
            runtimeJytAccessTokenOrigin = 'upstash';
            console.log(`[token] loaded from Upstash (set at ${runtimeJytAccessTokenSetAt.toISOString()})`);
            return;
        }
    }
    const persisted = loadPersistedToken();
    if (persisted) {
        runtimeJytAccessToken = persisted.token;
        runtimeJytAccessTokenSetAt = persisted.setAt ? new Date(persisted.setAt) : new Date();
        runtimeJytAccessTokenOrigin = 'file';
        console.log(`[token] loaded from file (set at ${runtimeJytAccessTokenSetAt.toISOString()})`);
    }
}

hydrateRuntimeToken().catch(e => console.log(`[token] hydrate error: ${e.message}`));

function maskToken(token) {
    const t = (token ?? '').toString();
    if (!t) return '';
    if (t.length <= 8) return `${t.slice(0, 2)}****${t.slice(-2)}`;
    return `${t.slice(0, 4)}****${t.slice(-4)}`;
}

const JYT_LIMITS = {
    ipMax: parsePositiveInt(process.env.JYT_RL_IP_MAX, 30),
    ipWindowMs: parsePositiveInt(process.env.JYT_RL_IP_WINDOW_MS, 60_000),
    ipDailyMax: parsePositiveInt(process.env.JYT_RL_IP_DAILY_MAX, 300),
    ipDailyWindowMs: parsePositiveInt(process.env.JYT_RL_IP_DAILY_WINDOW_MS, 86_400_000),
    ipCarMax: parsePositiveInt(process.env.JYT_RL_IP_CAR_MAX, 10),
    ipCarWindowMs: parsePositiveInt(process.env.JYT_RL_IP_CAR_WINDOW_MS, 600_000),
    cleanupEvery: parsePositiveInt(process.env.JYT_RL_CLEANUP_EVERY, 500),
    storeMaxSize: parsePositiveInt(process.env.JYT_RL_STORE_MAX_SIZE, 20_000)
};

const jytRlIpStore = new Map();
const jytRlIpDailyStore = new Map();
const jytRlIpCarStore = new Map();
let jytRlCounter = 0;

function getClientIp(req) {
    const xf = (req.headers['x-forwarded-for'] || '').toString();
    const first = xf.split(',')[0]?.trim();
    return first || req.ip || req.connection?.remoteAddress || 'unknown';
}

function cleanupRateLimitStore(store, now) {
    if (store.size <= JYT_LIMITS.storeMaxSize) return;
    for (const [k, v] of store.entries()) {
        if (!v || typeof v.resetAt !== 'number' || now >= v.resetAt) store.delete(k);
    }
}

function consumeFixedWindow(store, key, max, windowMs, now) {
    let entry = store.get(key);
    if (!entry || typeof entry.resetAt !== 'number' || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
    }
    if (entry.count >= max) {
        store.set(key, entry);
        const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        return { allowed: false, retryAfterSeconds };
    }
    entry.count += 1;
    store.set(key, entry);
    return { allowed: true, retryAfterSeconds: 0 };
}

function enforceJytRateLimit(req, carCode) {
    const now = Date.now();
    jytRlCounter += 1;
    if (jytRlCounter % JYT_LIMITS.cleanupEvery === 0) {
        cleanupRateLimitStore(jytRlIpStore, now);
        cleanupRateLimitStore(jytRlIpDailyStore, now);
        cleanupRateLimitStore(jytRlIpCarStore, now);
    }

    const ip = getClientIp(req);
    const ipKey = `ip:${ip}`;
    const ipDailyKey = `ipd:${ip}`;
    const ipCarKey = `ipc:${ip}:${carCode || ''}`;

    const r1 = consumeFixedWindow(jytRlIpStore, ipKey, JYT_LIMITS.ipMax, JYT_LIMITS.ipWindowMs, now);
    if (!r1.allowed) return { allowed: false, retryAfterSeconds: r1.retryAfterSeconds, scope: 'ip' };

    const r2 = consumeFixedWindow(jytRlIpDailyStore, ipDailyKey, JYT_LIMITS.ipDailyMax, JYT_LIMITS.ipDailyWindowMs, now);
    if (!r2.allowed) return { allowed: false, retryAfterSeconds: r2.retryAfterSeconds, scope: 'ip_daily' };

    if (carCode) {
        const r3 = consumeFixedWindow(jytRlIpCarStore, ipCarKey, JYT_LIMITS.ipCarMax, JYT_LIMITS.ipCarWindowMs, now);
        if (!r3.allowed) return { allowed: false, retryAfterSeconds: r3.retryAfterSeconds, scope: 'ip_car' };
    }

    return { allowed: true, retryAfterSeconds: 0, scope: 'ok' };
}

const CAR_DICT = {
    "丰田": "Toyota", "本田": "Honda", "日产": "Nissan", "马自达": "Mazda", "三菱": "Mitsubishi",
    "斯巴鲁": "Subaru", "铃木": "Suzuki", "雷克萨斯": "Lexus", "英菲尼迪": "Infiniti", "讴歌": "Acura",
    "大众": "Volkswagen", "奥迪": "Audi", "宝马": "BMW", "奔驰": "Mercedes-Benz", "保时捷": "Porsche",
    "路虎": "Land Rover", "捷豹": "Jaguar", "沃尔沃": "Volvo", "特斯拉": "Tesla",
    "福特": "Ford", "雪佛兰": "Chevrolet", "别克": "Buick", "凯迪拉克": "Cadillac", "吉普": "Jeep",
    "现代": "Hyundai", "起亚": "Kia",
    "比亚迪": "BYD", "吉利": "Geely", "奇瑞": "Chery", "哈弗": "Haval", "长安": "Changan", 
    "五菱": "Wuling", "长城": "Great Wall", "红旗": "Hongqi", "蔚来": "NIO", "小鹏": "Xpeng", "理想": "Li Auto",
    "捷途": "Jetour",
    "广汽传祺": "GAC Trumpchi",
    "上汽荣威": "Roewe",

    "卡罗拉": "Corolla", "凯美瑞": "Camry", "亚洲龙": "Avalon", "雷凌": "Levin", "威驰": "Vios",
    "荣放": "RAV4", "汉兰达": "Highlander", "普拉多": "Prado", "兰德酷路泽": "Land Cruiser",
    "埃尔法": "Alphard", "威尔法": "Vellfire", "赛那": "Sienna", "皇冠": "Crown",

    "思域": "Civic", "雅阁": "Accord", "飞度": "Fit", "凌派": "Crider", "英诗派": "Inspire",
    "缤智": "Vezel", "皓影": "Breeze", "冠道": "Avancier", "奥德赛": "Odyssey", "艾力绅": "Elysion",
    "XR-V": "XR-V", "CR-V": "CR-V",

    "轩逸": "Sylphy", "天籁": "Altima", "骐达": "Tiida", "逍客": "Qashqai", "奇骏": "X-Trail", 
    "途达": "Terra", "楼兰": "Murano",

    "朗逸": "Lavida", "宝来": "Bora", "速腾": "Sagitar", "迈腾": "Magotan", "帕萨特": "Passat", 
    "高尔夫": "Golf", "途观": "Tiguan", "途昂": "Teramont", "途锐": "Touareg", "威然": "Viloran",
    "桑塔纳": "Santana", "捷达": "Jetta", "探岳": "Tayron",

    "自动挡": "Automatic",
    "手动挡": "Manual",
    "智能电混": "Intelligent Hybrid",
    "电混": "Hybrid",
    "智能": "Intelligent",
    "款": " Model", "自动": "Auto", "手动": "Manual", "手自一体": "Tiptronic",
    "双离合": "DCT", "无级": "CVT", "混动": "Hybrid", "双擎": "Hybrid", "插混": "PHEV", "纯电": "EV",
    "增程": "EREV", "两驱": "2WD", "四驱": "4WD", "全时四驱": "AWD",
    "涡轮增压": "Turbo", "自然吸气": "NA",
    "三厢": "Sedan", "两厢": "Hatchback", "旅行版": "Wagon", "轿跑": "Coupe", "敞篷": "Convertible",
    "SUV": "SUV", "MPV": "MPV",

    "版": " Edition", "型": " Type",
    "标准": "Standard", "舒适": "Comfort", "精英": "Elite", "豪华": "Luxury", "尊贵": "Premium", 
    "旗舰": "Flagship", "至尊": "Supreme", "顶配": "Top", "次顶配": "Sub-top",
    "时尚": "Fashion", "进取": "Progressive", "先锋": "Pioneer", "领先": "Leading", 
    "运动": "Sport", "智联": "Smart Connect", "互联": "Connected", "科技": "Tech", 
    "风尚": "Style", "智行": "Intelligent", "荣耀": "Glory", "悦享": "Joy", "畅享": "Enjoy",

    "车况好": "Good condition",
    "可过三方": "Third-party inspection ok",
    "4S店": "Authorized dealer",
    "4s店": "Authorized dealer",
    "无事故": "Accident-free", "原版原漆": "Original paint", "原漆": "Original paint",
    "一手": "First owner", "个人一手": "First private owner", "美女一手": "Lady driven (First owner)",
    "实表": "Actual mileage", "公里数少": "Low mileage", "调表": "Odometer rollback",
    "全程4S": "Full dealer service history", "记录完美": "Perfect service record",
    "发变巅峰": "Engine & Gearbox in peak condition", "巅峰状态": "Peak condition",
    "极品": "Excellent condition", "精品": "Premium condition", "车况": "Condition",
    "支持检测": "Inspection welcome", "第三方检测": "Third-party inspection",
    "费用遥远": "Long registration validity", "保险": "Insurance", "年检": "Inspection",
    "更换": "Replaced", "钣金": "Sheet metal repair", "喷漆": "Repainted", "补漆": "Touch-up paint",
    "划痕": "Scratches", "凹陷": "Dents", "瑕疵": "Flaws",
    "左": "Left", "右": "Right", "前": "Front", "后": "Rear", 
    "门": "Door", "翼子板": "Fender", "保险杠": "Bumper", "机盖": "Hood", "后备箱": "Trunk",
    "大灯": "Headlight", "尾灯": "Taillight", "玻璃": "Glass/Window", 
    "内饰": "Interior", "磨损": "Wear", "新": "New", "整洁": "Clean",
    "天窗": "Sunroof", "全景天窗": "Panoramic sunroof", "真皮座椅": "Leather seats", 
    "导航": "Navigation", "倒车影像": "Reverse camera", "雷达": "Parking sensors",
    "一键启动": "Push start", "无钥匙进入": "Keyless entry"
    ,
    "汉EV": "Han EV",
    "汉DM-i": "Han DM-i",
    "汉DM-p": "Han DM-p",
    "秦PLUS DM-i": "Qin PLUS DM-i",
    "秦PLUS EV": "Qin PLUS EV",
    "秦L DM-i": "Qin L DM-i",
    "唐DM-i": "Tang DM-i",
    "唐EV": "Tang EV",
    "唐DM-p": "Tang DM-p",
    "宋PLUS DM-i": "Song PLUS DM-i",
    "宋PLUS EV": "Song PLUS EV",
    "宋Pro DM-i": "Song Pro DM-i",
    "宋L EV": "Song L EV",
    "元PLUS": "Yuan PLUS",
    "元UP": "Yuan UP",
    "海豚": "Dolphin",
    "海豹": "Seal",
    "海豹06 DM-i": "Seal 06 DM-i",
    "海豹07 EV": "Seal 07 EV",
    "护卫舰07": "Frigate 07",
    "护卫舰05": "Frigate 05",
    "海鸥": "Seagull",
    "海狮05 DM-i": "Sea Lion 05 DM-i",
    "海狮07 EV": "Sea Lion 07 EV",
    "腾势D9": "Denza D9",
    "腾势N7": "Denza N7",
    "腾势N8": "Denza N8",
    "方程豹5": "Fang Cheng Bao 5",
    "方程豹8": "Fang Cheng Bao 8",
    "仰望U8": "Yangwang U8",
    "仰望U9": "Yangwang U9",

    "星越L": "Monjaro",
    "星越L Hi·P": "Monjaro Hi·P",
    "星瑞": "Geely Xingrui",
    "星瑞L": "Geely Xingrui L",
    "帝豪": "Emgrand",
    "帝豪L Hi·P": "Emgrand L Hi·P",
    "帝豪EV": "Emgrand EV",
    "博越L": "Boyue L",
    "博越COOL": "Boyue COOL",
    "缤越": "BinYue",
    "缤越COOL": "BinYue COOL",
    "缤瑞COOL": "BinRui COOL",
    "豪越L": "HaoYue L",
    "远景X3": "Vision X3",
    "远景X6": "Vision X6",
    "领克01": "LYNK & CO 01",
    "领克01 EM-P": "LYNK & CO 01 EM-P",
    "领克02": "LYNK & CO 02",
    "领克02 Hatchback": "LYNK & CO 02 Hatchback",
    "领克03": "LYNK & CO 03",
    "领克03+": "LYNK & CO 03+",
    "领克05": "LYNK & CO 05",
    "领克05+": "LYNK & CO 05+",
    "领克06": "LYNK & CO 06",
    "领克06 Remix": "LYNK & CO 06 Remix",
    "领克07 EM-P": "LYNK & CO 07 EM-P",
    "领克08": "LYNK & CO 08",
    "领克09": "LYNK & CO 09",
    "领克09 EM-P": "LYNK & CO 09 EM-P",
    "极氪001": "Zeekr 001",
    "极氪001 FR": "Zeekr 001 FR",
    "极氪002": "Zeekr 002",
    "极氪007": "Zeekr 007",
    "极氪X": "Zeekr X",
    "极氪MIX": "Zeekr MIX",
    "熊猫mini": "Panda mini",
    "熊猫骑士": "Panda Knight",
    "ICON": "Geely ICON",
    "银河L6": "Galaxy L6",
    "银河L7": "Galaxy L7",
    "银河E5": "Galaxy E5",
    "银河E8": "Galaxy E8",
    "英伦TX5": "London EV Company TX5",

    "哈弗H6": "Haval H6",
    "哈弗H6新能源": "Haval H6 New Energy",
    "哈弗H6S": "Haval H6S",
    "哈弗H5": "Haval H5",
    "哈弗H9": "Haval H9",
    "哈弗大狗": "Haval Dargo",
    "哈弗二代大狗": "Haval Second-Gen Dargo",
    "哈弗酷狗": "Haval KuGou",
    "哈弗赤兔": "Haval Chitu",
    "哈弗初恋": "Haval First Love",
    "哈弗M6 PLUS": "Haval M6 PLUS",
    "哈弗枭龙MAX": "Haval Xiaolong MAX",
    "哈弗猛龙": "Haval Menglong",
    "魏牌拿铁DHT": "WEY Latte DHT",
    "魏牌拿铁DHT-PHEV": "WEY Latte DHT-PHEV",
    "魏牌摩卡DHT": "WEY Mocha DHT",
    "魏牌摩卡DHT-PHEV": "WEY Mocha DHT-PHEV",
    "魏牌玛奇朵DHT": "WEY Macchiato DHT",
    "魏牌玛奇朵DHT-PHEV": "WEY Macchiato DHT-PHEV",
    "魏牌蓝山DHT-PHEV": "WEY Lanshan DHT-PHEV",
    "魏牌高山DHT-PHEV": "WEY Gaoshan DHT-PHEV",
    "坦克300": "Tank 300",
    "坦克300铁骑02": "Tank 300 Tieqi 02",
    "坦克400 Hi4-T": "Tank 400 Hi4-T",
    "坦克500": "Tank 500",
    "坦克500 Hi4-T": "Tank 500 Hi4-T",
    "坦克700 Hi4-T": "Tank 700 Hi4-T",
    "欧拉好猫": "ORA Good Cat",
    "欧拉好猫GT": "ORA Good Cat GT",
    "欧拉芭蕾猫": "ORA Ballet Cat",
    "欧拉闪电猫": "ORA Lightning Cat",
    "欧拉朋克猫": "ORA Punk Cat",
    "欧拉白猫": "ORA White Cat",
    "欧拉黑猫": "ORA Black Cat",
    "欧拉糯玉米": "ORA Corn",
    "长城炮": "Great Wall Pao",
    "长城炮乘用版": "Great Wall Pao Passenger Version",
    "长城炮商用版": "Great Wall Pao Commercial Version",
    "长城炮越野版": "Great Wall Pao Off-Road Version",
    "金刚炮": "Great Wall Jingang Pao",
    "山海炮": "Great Wall Shanhai Pao",

    "CS75 PLUS": "CS75 PLUS",
    "CS75新能源": "CS75 New Energy",
    "CS55 PLUS": "CS55 PLUS",
    "CS35 PLUS": "CS35 PLUS",
    "CS95": "CS95",
    "UNI-V": "UNI-V",
    "UNI-V 智电iDD": "UNI-V iDD",
    "UNI-K": "UNI-K",
    "UNI-K 智电iDD": "UNI-K iDD",
    "UNI-T": "UNI-T",
    "逸动PLUS": "Eado PLUS",
    "逸动DT": "Eado DT",
    "逸动EV460": "Eado EV460",
    "锐程CC": "Raeton CC",
    "悦翔": "V3",
    "奔奔E-Star": "BenBen E-Star",
    "Lumin糯玉米": "Lumin",
    "深蓝SL03": "Deepal SL03",
    "深蓝S7": "Deepal S7",
    "深蓝G318": "Deepal G318",
    "启源A05": "Qiyuan A05",
    "启源A06": "Qiyuan A06",
    "启源Q05": "Qiyuan Q05",
    "凯程F70": "Kaicheng F70",

    "瑞虎8 PRO": "Tiggo 8 PRO",
    "瑞虎8 PLUS": "Tiggo 8 PLUS",
    "瑞虎8 鲲鹏版": "Tiggo 8 Kunpeng Edition",
    "瑞虎7 PLUS": "Tiggo 7 PLUS",
    "瑞虎7 超能版": "Tiggo 7 Super Energy Edition",
    "瑞虎5x": "Tiggo 5x",
    "瑞虎3x": "Tiggo 3x",
    "瑞虎9": "Tiggo 9",
    "艾瑞泽8": "Arrizo 8",
    "艾瑞泽5 PLUS": "Arrizo 5 PLUS",
    "艾瑞泽5 GT": "Arrizo 5 GT",
    "艾瑞泽GX": "Arrizo GX",
    "风云T9": "Fengyun T9",
    "风云T10": "Fengyun T10",
    "风云A8": "Fengyun A8",
    "星途揽月": "Exeed VX",
    "星途凌云": "Exeed TX",
    "星途追风": "Exeed TXL",
    "星途瑶光": "Exeed Yaoguang",
    "星途纪元ET": "Exeed ET",
    "捷途旅行者": "Jetour Traveler",
    "捷途X70 PLUS": "Jetour X70 PLUS",
    "捷途X90 PLUS": "Jetour X90 PLUS",
    "捷途X95": "Jetour X95",
    "捷途大圣": "Jetour Dasheng",
    "捷途山海T2": "Jetour Shanhai T2",
    "捷途山海T9": "Jetour Shanhai T9",
    "小蚂蚁": "Little Ant",
    "无界Pro": "Boundless Pro",
    "QQ冰淇淋": "QQ Ice Cream",

    "GS8": "GS8",
    "GS8双擎": "GS8 Hybrid",
    "GS7": "GS7",
    "GS5": "GS5",
    "GS4 PLUS": "GS4 PLUS",
    "GS4": "GS4",
    "GS3 POWER": "GS3 POWER",
    "影豹": "Emzoom",
    "影豹混动版": "Emzoom Hybrid",
    "影酷": "Emkoo",
    "M8宗师版": "M8 Master Edition",
    "M8领秀版": "M8 Leader Edition",
    "M6 PRO": "M6 PRO",
    "E9": "E9",
    "GA8": "GA8",
    "GA6": "GA6",
    "GA4 PLUS": "GA4 PLUS",
    "埃安Y PLUS": "AION Y PLUS",
    "埃安S PLUS": "AION S PLUS",
    "埃安S MAX": "AION S MAX",
    "埃安LX PLUS": "AION LX PLUS",
    "埃安V PLUS": "AION V PLUS",
    "埃安Hyper GT": "AION Hyper GT",
    "埃安Hyper SSR": "AION Hyper SSR",

    "RX9": "RX9",
    "RX8": "RX8",
    "RX5 MAX": "RX5 MAX",
    "RX5 PLUS": "RX5 PLUS",
    "RX5 第三代": "RX5 3rd Gen",
    "RX3 PRO": "RX3 PRO",
    "iMAX8": "iMAX8",
    "iMAX8 EV": "iMAX8 EV",
    "i6 MAX": "i6 MAX"
};

const MODEL_DICT_SOURCE = JSON.parse(`{
  "比亚迪": {
    "汉EV": "Han EV",
    "汉DM-i": "Han DM-i",
    "汉DM-p": "Han DM-p",
    "秦PLUS DM-i": "Qin PLUS DM-i",
    "秦PLUS EV": "Qin PLUS EV",
    "秦L DM-i": "Qin L DM-i",
    "唐DM-i": "Tang DM-i",
    "唐EV": "Tang EV",
    "唐DM-p": "Tang DM-p",
    "宋PLUS DM-i": "Song PLUS DM-i",
    "宋PLUS EV": "Song PLUS EV",
    "宋Pro DM-i": "Song Pro DM-i",
    "宋L EV": "Song L EV",
    "元PLUS": "Yuan PLUS",
    "元UP": "Yuan UP",
    "海豚": "Dolphin",
    "海豹": "Seal",
    "海豹06 DM-i": "Seal 06 DM-i",
    "海豹07 EV": "Seal 07 EV",
    "护卫舰07": "Frigate 07",
    "护卫舰05": "Frigate 05",
    "海鸥": "Seagull",
    "海狮05 DM-i": "Sea Lion 05 DM-i",
    "海狮07 EV": "Sea Lion 07 EV",
    "腾势D9": "Denza D9",
    "腾势N7": "Denza N7",
    "腾势N8": "Denza N8",
    "方程豹5": "Fang Cheng Bao 5",
    "方程豹8": "Fang Cheng Bao 8",
    "仰望U8": "Yangwang U8",
    "仰望U9": "Yangwang U9"
  },
  "吉利": {
    "星越L": "Monjaro",
    "星越L Hi·P": "Monjaro Hi·P",
    "星瑞": "Geely Xingrui",
    "星瑞L": "Geely Xingrui L",
    "帝豪": "Emgrand",
    "帝豪L Hi·P": "Emgrand L Hi·P",
    "帝豪EV": "Emgrand EV",
    "博越L": "Boyue L",
    "博越COOL": "Boyue COOL",
    "缤越": "BinYue",
    "缤越COOL": "BinYue COOL",
    "缤瑞COOL": "BinRui COOL",
    "豪越L": "HaoYue L",
    "远景X3": "Vision X3",
    "远景X6": "Vision X6",
    "领克01": "LYNK & CO 01",
    "领克01 EM-P": "LYNK & CO 01 EM-P",
    "领克02": "LYNK & CO 02",
    "领克02 Hatchback": "LYNK & CO 02 Hatchback",
    "领克03": "LYNK & CO 03",
    "领克03+": "LYNK & CO 03+",
    "领克05": "LYNK & CO 05",
    "领克05+": "LYNK & CO 05+",
    "领克06": "LYNK & CO 06",
    "领克06 Remix": "LYNK & CO 06 Remix",
    "领克07 EM-P": "LYNK & CO 07 EM-P",
    "领克08": "LYNK & CO 08",
    "领克09": "LYNK & CO 09",
    "领克09 EM-P": "LYNK & CO 09 EM-P",
    "极氪001": "Zeekr 001",
    "极氪001 FR": "Zeekr 001 FR",
    "极氪002": "Zeekr 002",
    "极氪007": "Zeekr 007",
    "极氪X": "Zeekr X",
    "极氪MIX": "Zeekr MIX",
    "熊猫mini": "Panda mini",
    "熊猫骑士": "Panda Knight",
    "ICON": "Geely ICON",
    "银河L6": "Galaxy L6",
    "银河L7": "Galaxy L7",
    "银河E5": "Galaxy E5",
    "银河E8": "Galaxy E8",
    "英伦TX5": "London EV Company TX5"
  },
  "长城": {
    "哈弗H6": "Haval H6",
    "哈弗H6新能源": "Haval H6 New Energy",
    "哈弗H6S": "Haval H6S",
    "哈弗H5": "Haval H5",
    "哈弗H9": "Haval H9",
    "哈弗大狗": "Haval Dargo",
    "哈弗二代大狗": "Haval Second-Gen Dargo",
    "哈弗酷狗": "Haval KuGou",
    "哈弗赤兔": "Haval Chitu",
    "哈弗初恋": "Haval First Love",
    "哈弗M6 PLUS": "Haval M6 PLUS",
    "哈弗枭龙MAX": "Haval Xiaolong MAX",
    "哈弗猛龙": "Haval Menglong",
    "魏牌拿铁DHT": "WEY Latte DHT",
    "魏牌拿铁DHT-PHEV": "WEY Latte DHT-PHEV",
    "魏牌摩卡DHT": "WEY Mocha DHT",
    "魏牌摩卡DHT-PHEV": "WEY Mocha DHT-PHEV",
    "魏牌玛奇朵DHT": "WEY Macchiato DHT",
    "魏牌玛奇朵DHT-PHEV": "WEY Macchiato DHT-PHEV",
    "魏牌蓝山DHT-PHEV": "WEY Lanshan DHT-PHEV",
    "魏牌高山DHT-PHEV": "WEY Gaoshan DHT-PHEV",
    "坦克300": "Tank 300",
    "坦克300铁骑02": "Tank 300 Tieqi 02",
    "坦克400 Hi4-T": "Tank 400 Hi4-T",
    "坦克500": "Tank 500",
    "坦克500 Hi4-T": "Tank 500 Hi4-T",
    "坦克700 Hi4-T": "Tank 700 Hi4-T",
    "欧拉好猫": "ORA Good Cat",
    "欧拉好猫GT": "ORA Good Cat GT",
    "欧拉芭蕾猫": "ORA Ballet Cat",
    "欧拉闪电猫": "ORA Lightning Cat",
    "欧拉朋克猫": "ORA Punk Cat",
    "欧拉白猫": "ORA White Cat",
    "欧拉黑猫": "ORA Black Cat",
    "欧拉糯玉米": "ORA Corn",
    "长城炮": "Great Wall Pao",
    "长城炮乘用版": "Great Wall Pao Passenger Version",
    "长城炮商用版": "Great Wall Pao Commercial Version",
    "长城炮越野版": "Great Wall Pao Off-Road Version",
    "金刚炮": "Great Wall Jingang Pao",
    "山海炮": "Great Wall Shanhai Pao"
  },
  "长安": {
    "CS75 PLUS": "CS75 PLUS",
    "CS75新能源": "CS75 New Energy",
    "CS55 PLUS": "CS55 PLUS",
    "CS35 PLUS": "CS35 PLUS",
    "CS95": "CS95",
    "UNI-V": "UNI-V",
    "UNI-V 智电iDD": "UNI-V iDD",
    "UNI-K": "UNI-K",
    "UNI-K 智电iDD": "UNI-K iDD",
    "UNI-T": "UNI-T",
    "逸动PLUS": "Eado PLUS",
    "逸动DT": "Eado DT",
    "逸动EV460": "Eado EV460",
    "锐程CC": "Raeton CC",
    "悦翔": "V3",
    "奔奔E-Star": "BenBen E-Star",
    "Lumin糯玉米": "Lumin",
    "深蓝SL03": "Deepal SL03",
    "深蓝S7": "Deepal S7",
    "深蓝G318": "Deepal G318",
    "启源A05": "Qiyuan A05",
    "启源A06": "Qiyuan A06",
    "启源Q05": "Qiyuan Q05",
    "凯程F70": "Kaicheng F70"
  },
  "奇瑞": {
    "瑞虎8 PRO": "Tiggo 8 PRO",
    "瑞虎8 PLUS": "Tiggo 8 PLUS",
    "瑞虎8 鲲鹏版": "Tiggo 8 Kunpeng Edition",
    "瑞虎7 PLUS": "Tiggo 7 PLUS",
    "瑞虎7 超能版": "Tiggo 7 Super Energy Edition",
    "瑞虎5x": "Tiggo 5x",
    "瑞虎3x": "Tiggo 3x",
    "瑞虎9": "Tiggo 9",
    "艾瑞泽8": "Arrizo 8",
    "艾瑞泽5 PLUS": "Arrizo 5 PLUS",
    "艾瑞泽5 GT": "Arrizo 5 GT",
    "艾瑞泽GX": "Arrizo GX",
    "风云T9": "Fengyun T9",
    "风云T10": "Fengyun T10",
    "风云A8": "Fengyun A8",
    "星途揽月": "Exeed VX",
    "星途凌云": "Exeed TX",
    "星途追风": "Exeed TXL",
    "星途瑶光": "Exeed Yaoguang",
    "星途纪元ET": "Exeed ET",
    "捷途旅行者": "Jetour Traveler",
    "捷途X70 PLUS": "Jetour X70 PLUS",
    "捷途X90 PLUS": "Jetour X90 PLUS",
    "捷途X95": "Jetour X95",
    "捷途大圣": "Jetour Dasheng",
    "捷途山海T2": "Jetour Shanhai T2",
    "捷途山海T9": "Jetour Shanhai T9",
    "小蚂蚁": "Little Ant",
    "无界Pro": "Boundless Pro",
    "QQ冰淇淋": "QQ Ice Cream"
  },
  "广汽传祺": {
    "GS8": "GS8",
    "GS8双擎": "GS8 Hybrid",
    "GS7": "GS7",
    "GS5": "GS5",
    "GS4 PLUS": "GS4 PLUS",
    "GS4": "GS4",
    "GS3 POWER": "GS3 POWER",
    "影豹": "Emzoom",
    "影豹混动版": "Emzoom Hybrid",
    "影酷": "Emkoo",
    "M8宗师版": "M8 Master Edition",
    "M8领秀版": "M8 Leader Edition",
    "M6 PRO": "M6 PRO",
    "E9": "E9",
    "GA8": "GA8",
    "GA6": "GA6",
    "GA4 PLUS": "GA4 PLUS",
    "埃安Y PLUS": "AION Y PLUS",
    "埃安S PLUS": "AION S PLUS",
    "埃安S MAX": "AION S MAX",
    "埃安LX PLUS": "AION LX PLUS",
    "埃安V PLUS": "AION V PLUS",
    "埃安Hyper GT": "AION Hyper GT",
    "埃安Hyper SSR": "AION Hyper SSR"
  },
  "上汽荣威": {
    "RX9": "RX9",
    "RX8": "RX8",
    "RX5 MAX": "RX5 MAX",
    "RX5 PLUS": "RX5 PLUS",
    "RX5 第三代": "RX5 3rd Gen",
    "RX3 PRO": "RX3 PRO",
    "iMAX8": "iMAX8",
    "iMAX8 EV": "iMAX8 EV",
    "i6 MAX": "i6 MAX",
    "i5": "i5",
    "D7 EV": "D7 EV",
    "D7 DMH": "D7 DMH",
    "鲸": "Whale",
    "龙猫": "Chinchilla",
    "科莱威CLEVER": "CLEVER"
  },
  "上汽名爵": {
    "MG7": "MG7",
    "MG6 PRO": "MG6 PRO",
    "MG5天蝎座": "MG5 Scorpio",
    "MG4 EV": "MG4 EV",
    "MG ONE": "MG ONE",
    "MG HS": "MG HS",
    "MG领航": "MG Pilot",
    "MG锐行": "MG GT",
    "MG锐腾": "MG GS",
    "MG3": "MG3"
  },
  "东风风神": {
    "AX7 马赫版": "AX7 Mach Edition",
    "AX7 浩瀚版": "AX7 Haohan Edition",
    "皓极": "Haoji",
    "奕炫MAX": "Yixuan MAX",
    "奕炫GS": "Yixuan GS",
    "奕炫EV": "Yixuan EV",
    "E70": "E70",
    "纳米01": "Nami 01",
    "风行T5 EVO": "Forthing T5 EVO",
    "风行游艇": "Forthing Yacht",
    "菱智M5": "Lingzhi M5",
    "风光580": "Fengguang 580",
    "风光MINIEV": "Fengguang MINIEV",
    "岚图FREE": "Voyah FREE",
    "岚图追光": "Voyah Zhuiguang",
    "岚图梦想家": "Voyah Dreamer"
  },
  "蔚来": {
    "ES6": "ES6",
    "ES7": "ES7",
    "ES8": "ES8",
    "EC6": "EC6",
    "ET5": "ET5",
    "ET5T": "ET5T",
    "ET7": "ET7",
    "ET9": "ET9",
    "EL6": "EL6",
    "EL7": "EL7",
    "EP9": "EP9",
    "乐道L60": "乐道 L60"
  },
  "小鹏": {
    "P7i": "P7i",
    "P5": "P5",
    "G3i": "G3i",
    "G6": "G6",
    "G9": "G9",
    "X9": "X9",
    "MONA M03": "MONA M03"
  },
  "理想": {
    "L6": "L6",
    "L7": "L7",
    "L8": "L8",
    "L9": "L9",
    "MEGA": "MEGA"
  },
  "问界": {
    "M5": "AITO M5",
    "M5 EV": "AITO M5 EV",
    "M7": "AITO M7",
    "M7 Ultra": "AITO M7 Ultra",
    "M9": "AITO M9"
  },
  "哪吒": {
    "S": "Nezha S",
    "S GT": "Nezha S GT",
    "GT": "Nezha GT",
    "U-II": "Nezha U-II",
    "V": "Nezha V",
    "AYA": "Nezha AYA"
  },
  "零跑": {
    "C10": "Leapmotor C10",
    "C11": "Leapmotor C11",
    "C11增程版": "Leapmotor C11 Extended Range",
    "C01": "Leapmotor C01",
    "C01增程版": "Leapmotor C01 Extended Range",
    "T03": "Leapmotor T03",
    "B10": "Leapmotor B10",
    "B12": "Leapmotor B12"
  },
  "极氪": {
    "001": "Zeekr 001",
    "001 FR": "Zeekr 001 FR",
    "002": "Zeekr 002",
    "007": "Zeekr 007",
    "X": "Zeekr X",
    "MIX": "Zeekr MIX"
  },
  "岚图": {
    "FREE": "Voyah FREE",
    "追光": "Voyah Zhuiguang",
    "梦想家": "Voyah Dreamer"
  },
  "高合": {
    "HiPhi X": "HiPhi X",
    "HiPhi Y": "HiPhi Y",
    "HiPhi Z": "HiPhi Z",
    "HiPhi A": "HiPhi A"
  },
  "阿维塔": {
    "11": "Avatr 11",
    "12": "Avatr 12",
    "07": "Avatr 07"
  },
  "深蓝": {
    "SL03": "Deepal SL03",
    "S7": "Deepal S7",
    "G318": "Deepal G318"
  },
  "启辰": {
    "D60 PLUS": "Venucia D60 PLUS",
    "D60 EV": "Venucia D60 EV",
    "T60": "Venucia T60",
    "T70": "Venucia T70",
    "T90": "Venucia T90",
    "大V": "Venucia Big V",
    "大V DD-i": "Venucia Big V DD-i",
    "VX6": "Venucia VX6"
  },
  "捷达": {
    "VS5": "Jetta VS5",
    "VS7": "Jetta VS7",
    "VA3": "Jetta VA3"
  },
  "思皓": {
    "X8 PLUS": "Sehol X8 PLUS",
    "X7": "Sehol X7",
    "QX": "Sehol QX",
    "E10X": "Sehol E10X",
    "花仙子": "Sehol Flower Fairy"
  },
  "创维": {
    "HT-i": "Skyworth HT-i",
    "EV6": "Skyworth EV6",
    "ET5": "Skyworth ET5"
  },
  "大运": {
    "远志M1": "Dayun Yuanzhi M1",
    "悦虎": "Dayun Yuehu"
  },
  "雷丁": {
    "芒果": "Leiding Mango",
    "芒果Pro": "Leiding Mango Pro"
  },
  "朋克": {
    "多多": "Punk Duoduo",
    "美美": "Punk Meimei",
    "啦啦": "Punk Lala"
  },
  "凌宝": {
    "BOX": "Lingbao BOX",
    "uni": "Lingbao uni",
    "COCO": "Lingbao COCO"
  },
  "江南": {
    "U2": "Jiangnan U2",
    "T11": "Jiangnan T11"
  },
  "北汽": {
    "BJ40": "BAW BJ40",
    "BJ80": "BAW BJ80",
    "BJ90": "BAW BJ90",
    "魔方": "BAW Rubik's Cube",
    "北京X7": "BAW X7",
    "EU5": "BAIC EU5",
    "EU7": "BAIC EU7",
    "EX3": "BAIC EX3",
    "EC3": "BAIC EC3",
    "极狐阿尔法S": "ARCFOX α-S",
    "极狐阿尔法T": "ARCFOX α-T"
  },
  "江淮": {
    "瑞风S7": "JAC Refine S7",
    "瑞风S4": "JAC Refine S4",
    "瑞风M3": "JAC Refine M3",
    "嘉悦A5": "JAC Jiayue A5",
    "思皓QX": "JAC Sehol QX"
  },
  "华晨鑫源": {
    "金杯海狮": "Jinbei Haishi",
    "鑫源X30L": "Xinyuan X30L",
    "新海狮X30L": "New Haishi X30L"
  },
  "东南": {
    "DX7星跃": "Soueast DX7 Star Jump",
    "DX5": "Soueast DX5",
    "DX3": "Soueast DX3"
  },
  "海马": {
    "8S": "Haima 8S",
    "7X": "Haima 7X",
    "6P": "Haima 6P"
  },
  "野马": {
    "博骏": "Yema Bojun",
    "斯派卡": "Yema Spica"
  },
  "大乘": {
    "G60S": "Dayun G60S",
    "G70S": "Dayun G70S"
  },
  "观致": {
    "7": "Qoros 7",
    "5": "Qoros 5",
    "3": "Qoros 3"
  },
  "领克": {
    "01": "LYNK & CO 01",
    "02": "LYNK & CO 02",
    "03": "LYNK & CO 03",
    "05": "LYNK & CO 05",
    "06": "LYNK & CO 06",
    "07": "LYNK & CO 07",
    "08": "LYNK & CO 08",
    "09": "LYNK & CO 09"
  },
  "五菱": {
    "宏光MINIEV": "Wuling Hongguang MINIEV",
    "宏光MINIEV GAMEBOY": "Wuling Hongguang MINIEV GAMEBOY",
    "缤果": "Wuling Bingo",
    "星光": "Wuling Starlight",
    "星辰": "Wuling Xingchen",
    "星驰": "Wuling Xingchi",
    "凯捷": "Wuling Victory",
    "佳辰": "Wuling Jachen",
    "征程": "Wuling Zhengcheng",
    "荣光": "Wuling Rongguang",
    "之光": "Wuling Zhiguang",
    "宝骏730": "Baojun 730",
    "宝骏510": "Baojun 510",
    "宝骏530": "Baojun 530",
    "宝骏KiWi EV": "Baojun KiWi EV",
    "宝骏云朵": "Baojun Cloud",
    "宝骏悦也": "Baojun Yep"
  },
  "奔腾": {
    "T99": "Bestune T99",
    "T90": "Bestune T90",
    "T77": "Bestune T77",
    "T55": "Bestune T55",
    "B70": "Bestune B70",
    "B70S": "Bestune B70S",
    "NAT": "Bestune NAT"
  },
  "欧尚": {
    "Z6": "Oshan Z6",
    "Z6 智电iDD": "Oshan Z6 iDD",
    "X7 PLUS": "Oshan X7 PLUS",
    "X5 PLUS": "Oshan X5 PLUS",
    "科赛Pro": "Oshan Cosai Pro",
    "尼欧II": "Oshan Neo II"
  },
  "思铭": {
    "X-NV": "Ciimo X-NV",
    "M-NV": "Ciimo M-NV"
  },
  "理念": {
    "VE-1": "Everus VE-1"
  },
  "华凯": {
    "皮卡": "Huakai Pickup",
    "凯马": "Huakai Kaima"
  },
  "之诺": {
    "60H": "Zinoro 60H"
  },
  "卡威": {
    "K150GT": "Karry K150GT",
    "W1": "Karry W1"
  },
  "恒天": {
    "途腾T3": "Hengtian Tuteng T3",
    "途腾T5": "Hengtian Tuteng T5"
  },
  "福迪": {
    "揽福": "Fudi Lanfu",
    "雄师F22": "Fudi Xiongshi F22"
  },
  "中兴": {
    "领主": "Zhongxing Lingzhu",
    "威虎": "Zhongxing Weihu"
  },
  "北汽制造": {
    "勇士": "BAW Warrior",
    "战旗": "BAW Battle Flag",
    "卡路里": "BAW Calorie"
  },
  "长安凯程": {
    "神骐T30": "Kaicheng Shenqi T30",
    "星卡PLUS": "Kaicheng Xingka PLUS"
  },
  "依维柯": {
    "欧胜": "Iveco Ousheng",
    "得意": "Iveco Deyi"
  },
  "南京金龙": {
    "开沃D10": "Kaiwo D10",
    "开沃D07": "Kaiwo D07"
  },
  "申龙": {
    "客车": "Shenlong Bus",
    "新能源客车": "Shenlong New Energy Bus"
  },
  "金旅": {
    "海狮": "Golden Dragon Haishi",
    "考斯特": "Golden Dragon Coaster"
  },
  "金龙": {
    "轻客": "King Long Light Bus",
    "大巴": "King Long Coach"
  },
  "宇通": {
    "客运客车": "Yutong Passenger Bus",
    "新能源客车": "Yutong New Energy Bus",
    "环卫车": "Yutong Sanitation Vehicle"
  },
  "中通": {
    "客车": "Zhongtong Bus",
    "校车": "Zhongtong School Bus"
  },
  "安凯": {
    "客车": "Ankai Bus",
    "豪华客车": "Ankai Luxury Bus"
  },
  "福田": {
    "欧曼": "Foton Auman",
    "奥铃": "Foton Ollin",
    "拓陆者": "Foton Tunland",
    "伽途": "Foton Gatu"
  },
  "重汽": {
    "豪沃": "SINOTRUK HOWO",
    "汕德卡": "SINOTRUK SITRAK"
  },
  "陕汽": {
    "德龙": "Shacman Delong",
    "奥龙": "Shacman Aolong"
  },
  "江淮格尔发": {
    "K7": "JAC Galaxy K7",
    "A5": "JAC Galaxy A5"
  },
  "江铃": {
    "域虎7": "JMC Yuhu 7",
    "宝典": "JMC Baodian",
    "顺达": "JMC Shunda",
    "全顺": "JMC Transit"
  },
  "庆铃": {
    "五十铃": "Qingling Isuzu",
    "KV100": "Qingling KV100"
  },
  "金杯": {
    "小海狮X30": "Jinbei Xiaohaishi X30",
    "海狮王": "Jinbei Haishi King"
  },
  "大通": {
    "G10": "Maxus G10",
    "G20": "Maxus G20",
    "G90": "Maxus G90",
    "D90 PRO": "Maxus D90 PRO",
    "T90": "Maxus T90",
    "V80": "Maxus V80",
    "V90": "Maxus V90"
  },
  "宇通轻卡": {
    "T5": "Yutong T5",
    "T7": "Yutong T7"
  },
  "远程": {
    "星智": "Yuancheng Xingzhi",
    "星享": "Yuancheng Xingxiang",
    "锋锐": "Yuancheng Fenrui"
  },
  "吉利远程": {
    "E6": "Geely Yuancheng E6",
    "E5": "Geely Yuancheng E5"
  },
  "东风柳汽": {
    "乘龙H7": "Chenglong H7",
    "乘龙M3": "Chenglong M3"
  },
  "东风商用车": {
    "天龙KL": "Dongfeng Tianlong KL",
    "天锦KR": "Dongfeng Tianjin KR"
  },
  "解放": {
    "J7": "FAW J7",
    "J6P": "FAW J6P",
    "JH6": "FAW JH6"
  },
  "三一重卡": {
    "江山": "Sany Jiangshan",
    "王道": "Sany Wangdao"
  },
  "徐工重卡": {
    "漢風": "XCMG Hanfeng",
    "G7": "XCMG G7"
  },
  "北奔重卡": {
    "V3ET": "Beiben V3ET",
    "NG80": "Beiben NG80"
  },
  "华菱": {
    "汉马H9": "Hualing Hanma H9",
    "星马": "Hualing Xingma"
  },
  "联合卡车": {
    "U+": "United Truck U+",
    "V系": "United Truck V Series"
  },
  "广汽日野": {
    "700系": "GAC Hino 700 Series",
    "500系": "GAC Hino 500 Series"
  },
  "四川现代": {
    "创虎": "Sichuan Hyundai Xcient",
    "盛图": "Sichuan Hyundai Porter"
  },
  "庆铃五十铃": {
    "VC46": "Qingling Isuzu VC46",
    "ELF": "Qingling Isuzu ELF"
  },
  "江淮帅铃": {
    "Q6": "JAC Shuailing Q6",
    "Q7": "JAC Shuailing Q7"
  },
  "江淮骏铃": {
    "V6": "JAC Junling V6",
    "V9": "JAC Junling V9"
  },
  "福田奥铃": {
    "CTS": "Foton Ollin CTS",
    "捷运": "Foton Ollin Express"
  },
  "福田欧马可": {
    "S1": "Foton Aumark S1",
    "S3": "Foton Aumark S3"
  },
  "东风凯普特": {
    "K6": "Dongfeng Captain K6",
    "K7": "Dongfeng Captain K7"
  },
  "东风多利卡": {
    "D6": "Dongfeng Dolica D6",
    "D9": "Dongfeng Dolica D9"
  },
  "江铃凯运": {
    "升级版": "JMC Kaiyun Upgraded",
    "蓝鲸版": "JMC Kaiyun Blue Whale"
  },
  "江铃顺达": {
    "窄体": "JMC Shunda Narrow Body",
    "宽体": "JMC Shunda Wide Body"
  },
  "金杯领骐": {
    "轻卡": "Jinbei Lingqi Light Truck",
    "自卸车": "Jinbei Lingqi Tipper"
  },
  "跃进": {
    "福星S100": "Yuejin Fuxing S100",
    "超越C300": "Yuejin Chaoyue C300"
  },
  "唐骏欧铃": {
    "小宝马": "Tangjun Ouling Xiaobaoma",
    "金利卡": "Tangjun Ouling Jinlika"
  },
  "凯马": {
    "凯捷M3": "Kaima Kaijie M3",
    "锐航X1": "Kaima Ruihang X1"
  },
  "时风": {
    "风菱": "Shifeng Fengling",
    "风顺": "Shifeng Fengshun"
  },
  "五征": {
    "奥驰": "Wuzheng Aochi",
    "缔途": "Wuzheng Ditu"
  },
  "飞碟": {
    "缔途DX": "Feidie Ditu DX",
    "奥驰V6": "Feidie Aochi V6"
  },
  "大运轻卡": {
    "奥普力": "Dayun Aopuli",
    "祥龙": "Dayun Xianglong"
  },
  "重汽豪沃轻卡": {
    "悍将": "HOWO Hanjiang",
    "统帅": "HOWO Tongshuai"
  },
  "陕汽轻卡": {
    "德龙K3000": "Shacman Delong K3000",
    "轩德X9": "Shacman Xuande X9"
  },
  "北汽黑豹": {
    "Q7": "BAW Heibao Q7",
    "G6": "BAW Heibao G6"
  },
  "一汽红塔": {
    "解放霸铃": "FAW Hongta Jiefang Baling",
    "解放金卡": "FAW Hongta Jiefang Jinka"
  },
  "上汽轻卡": {
    "福星S80": "SAIC Fuxing S80",
    "超越H300": "SAIC Chaoyue H300"
  },
  "江淮康铃": {
    "J3": "JAC Kangling J3",
    "J5": "JAC Kangling J5"
  },
  "福田时代": {
    "小卡之星": "Foton Times Xiaoka Zhixing",
    "领航": "Foton Times Linghang"
  },
  "东风途逸": {
    "T5": "Dongfeng Tuyi T5",
    "T3": "Dongfeng Tuyi T3"
  },
  "长安神骐": {
    "T20": "Changan Shenqi T20",
    "T30": "Changan Shenqi T30"
  },
  "五菱荣光小卡": {
    "单排": "Wuling Rongguang Xiaoka Single Row",
    "双排": "Wuling Rongguang Xiaoka Double Row"
  },
  "金杯小海狮X30L": {
    "货运版": "Jinbei Xiaohaishi X30L Cargo Version",
    "客运版": "Jinbei Xiaohaishi X30L Passenger Version"
  },
  "开瑞优劲": {
    "单排": "Karry Youjin Single Row",
    "双排": "Karry Youjin Double Row"
  },
  "东风小康C31": {
    "单排": "Dongfeng Xiaokang C31 Single Row",
    "双排": "Dongfeng Xiaokang C32 Double Row"
  },
  "北汽昌河": {
    "福瑞达K21": "BAW Changhe Furuidaka K21",
    "福瑞达K22": "BAW Changhe Furuidaka K22"
  },
  "东南得利卡": {
    "经典款": "Soueast Delica Classic",
    "新能源款": "Soueast Delica New Energy"
  },
  "金杯阁瑞斯": {
    "快运": "Jinbei Grace Express",
    "商务": "Jinbei Grace Business"
  },
  "依维柯得意": {
    "2.5T": "Iveco Deyi 2.5T",
    "2.8T": "Iveco Deyi 2.8T"
  },
  "大通V80": {
    "傲运通": "Maxus V80 Aoyuntong",
    "商旅版": "Maxus V80 Business Travel"
  },
  "江铃全顺": {
    "经典全顺": "JMC Transit Classic",
    "新全顺": "JMC Transit New"
  },
  "福田风景G7": {
    "平顶": "Foton Scenery G7 Flat Top",
    "高顶": "Foton Scenery G7 High Top"
  },
  "金杯海狮王": {
    "城运王": "Jinbei Haishi King Chengyun Wang",
    "商务王": "Jinbei Haishi King Shangwu Wang"
  },
  "东风御风": {
    "V9": "Dongfeng Yufeng V9",
    "EM26": "Dongfeng Yufeng EM26"
  },
  "南京依维柯": {
    "褒迪": "Nanjing Iveco Baodi",
    "欧胜": "Nanjing Iveco Ousheng"
  },
  "金龙凯锐浩克": {
    "2.0L": "King Long Kairui Haoke 2.0L",
    "2.3T": "King Long Kairui Haoke 2.3T"
  },
  "金旅海狮": {
    "新能源": "Golden Dragon Haishi New Energy",
    "燃油版": "Golden Dragon Haishi Fuel Version"
  },
  "申龙D10": {
    "纯电动": "Shenlong D10 Electric",
    "混动": "Shenlong D10 Hybrid"
  },
  "宇通T7": {
    "3.5T": "Yutong T7 3.5T",
    "4.0T": "Yutong T7 4.0T"
  },
  "安凯A6": {
    "客运": "Ankai A6 Passenger",
    "旅游": "Ankai A6 Tourism"
  },
  "中通LCK6128": {
    "大巴": "Zhongtong LCK6128 Coach",
    "通勤": "Zhongtong LCK6128 Commuter"
  },
  "福田欧辉": {
    "6119": "Foton AUV 6119",
    "6122": "Foton AUV 6122"
  },
  "比亚迪C9": {
    "纯电动": "BYD C9 Electric",
    "混动": "BYD C9 Hybrid"
  },
  "吉利远程E6": {
    "厢货": "Geely Yuancheng E6 Van",
    "冷藏": "Geely Yuancheng E6 Refrigerated"
  },
  "江淮星锐": {
    "5系": "JAC Sunray 5 Series",
    "6系": "JAC Sunray 6 Series",
    "9系": "JAC Sunray 9 Series"
  },
  "东风风行菱智": {
    "M5": "Forthing Lingzhi M5",
    "M3": "Forthing Lingzhi M3",
    "V3": "Forthing Lingzhi V3"
  },
  "传祺M8": {
    "宗师版": "Trumpchi M8 Master Edition",
    "领秀版": "Trumpchi M8 Leader Edition",
    "大师版": "Trumpchi M8 Master Edition"
  },
  "荣威iMAX8": {
    "尊荣版": "Roewe iMAX8 Zunrong Edition",
    "至尊版": "Roewe iMAX8 Zhizun Edition"
  },
  "别克GL8": {
    "陆上公务舱": "Buick GL8 Land Business Class",
    "ES陆尊": "Buick GL8 ES Lu Zun",
    "艾维亚": "Buick GL8 Avenir"
  },
  "本田奥德赛": {
    "锐·混动": "Honda Odyssey Hybrid",
    "福祉版": "Honda Odyssey Welfare Edition"
  },
  "丰田赛那SIENNA": {
    "舒适版": "Toyota Sienna Comfort Edition",
    "铂金版": "Toyota Sienna Platinum Edition"
  },
  "起亚嘉华": {
    "豪华版": "Kia Carnival Luxury Edition",
    "旗舰版": "Kia Carnival Flagship Edition"
  },
  "现代库斯途": {
    "尊贵版": "Hyundai Custo Premium Edition",
    "智爱旗舰版": "Hyundai Custo Ultimate Edition"
  },
  "大众威然": {
    "豪华版": "Volkswagen Viloran Luxury Edition",
    "尊贵版": "Volkswagen Viloran Premium Edition"
  },
  "福特领裕": {
    "尊领型": "Ford Equator Premium Edition",
    "尊领型PLUS": "Ford Equator Premium Plus Edition"
  },
  "奇瑞瑞虎8 PRO 冠军版": "Chery Tiggo 8 PRO Champion Edition",
  "长安CS75 PLUS 冠军版": "Changan CS75 PLUS Champion Edition",
  "吉利星越L 雷神Hi·P": "Geely Monjaro Thor Hi·P",
  "比亚迪汉DM-i 冠军版": "BYD Han DM-i Champion Edition",
  "特斯拉Model 3 焕新版": "Tesla Model 3 Refresh Edition",
  "宝马3系 改款": "BMW 3 Series Facelift",
  "奔驰C级 改款": "Mercedes-Benz C-Class Facelift",
  "奥迪A4L 改款": "Audi A4L Facelift",
  "雷克萨斯ES 新款": "Lexus ES New Model",
  "凯迪拉克CT5 新款": "Cadillac CT5 New Model",
  "沃尔沃S60 改款": "Volvo S60 Facelift",
  "林肯Z 新款": "Lincoln Z New Model",
  "英菲尼迪Q50L 改款": "Infiniti Q50L Facelift",
  "讴歌TLX-L 新款": "Acura TLX-L New Model"
}`);

function buildModelDict(source) {
    const result = {};
    for (const [k, v] of Object.entries(source || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [mk, mv] of Object.entries(v)) {
                if (typeof mv !== 'string') continue;
                const brand = (k || '').toString();
                const modelKey = (mk || '').toString();
                if (!brand || !modelKey) continue;

                const combined = `${brand}${modelKey}`;
                const hasCjk = /[\u3400-\u9FFF]/.test(modelKey);

                if (hasCjk) result[modelKey] = mv;
                result[combined] = mv;
            }
            continue;
        }
        if (typeof v === 'string') result[k] = v;
    }
    return result;
}

const MODEL_DICT = buildModelDict(MODEL_DICT_SOURCE);
const TRANSLATION_DICT = { ...CAR_DICT, ...MODEL_DICT };
const TRANSLATION_KEYS = Object.keys(TRANSLATION_DICT).sort((a, b) => b.length - a.length);

function translateText(text) {
    if (!text) return "";
    let result = text;
    
    for (const key of TRANSLATION_KEYS) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedKey, 'g');
        result = result.replace(regex, " " + TRANSLATION_DICT[key] + " ");
    }
    
    return result.replace(/\s+/g, ' ').trim();
}

const BRAND_DICT = (() => {
    const result = {};
    for (const k of Object.keys(MODEL_DICT_SOURCE || {})) {
        const v = CAR_DICT[k];
        if (typeof v === 'string') result[k] = v;
    }
    if (typeof CAR_DICT["捷途"] === 'string') result["捷途"] = CAR_DICT["捷途"];
    return result;
})();

const BRAND_MODEL_DICT = { ...MODEL_DICT, ...BRAND_DICT };
const BRAND_MODEL_KEYS = Object.keys(BRAND_MODEL_DICT).sort((a, b) => b.length - a.length);

function normalizeCjkSpacing(text) {
    return (text || '').toString().replace(/([\u3400-\u9FFF])\s+([\u3400-\u9FFF])/g, '$1$2');
}

function applyBrandModelDict(text) {
    if (!text) return "";
    let result = normalizeCjkSpacing(text);
    for (const key of BRAND_MODEL_KEYS) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedKey, 'g');
        result = result.replace(regex, BRAND_MODEL_DICT[key]);
    }
    return result.replace(/\s+/g, ' ').trim();
}

async function translateEnBrandModelPriority(text) {
    const pre = applyBrandModelDict(text);
    if (!/[\u3400-\u9FFF]/.test(pre)) return pre;
    const translated = await googleTranslate(pre, 'en');
    return translated || pre;
}

const translateCache = new Map();

async function googleTranslate(text, targetLang = 'en') {
    const clean = (text || '').trim();
    if (!clean) return '';
    const key = `${targetLang}:${clean}`;
    const now = Date.now();
    const cached = translateCache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;

    const endpoints = [
        'https://translate.googleapis.com/translate_a/single',
        'https://translate.google.com/translate_a/single'
    ];

    let data;
    for (const endpoint of endpoints) {
        try {
            const res = await axios.get(endpoint, {
                params: {
                    client: 'gtx',
                    sl: 'auto',
                    tl: targetLang,
                    dt: 't',
                    q: clean.length > 4500 ? clean.slice(0, 4500) : clean
                },
                timeout: 5000
            });
            data = res.data;
            break;
        } catch (_) {}
    }

    const translated = Array.isArray(data) && Array.isArray(data[0])
        ? data[0].map((seg) => (Array.isArray(seg) ? seg[0] : '')).join('')
        : '';

    const value = (translated || '').trim();
    translateCache.set(key, { value, expiresAt: now + 6 * 60 * 60 * 1000 });
    return value;
}

function parsePriceCny(priceLabel) {
    const label = (priceLabel || '').toString().trim();
    if (!label) return null;
    const wan = label.match(/([\d.]+)\s*万/);
    if (wan) {
        const v = Number.parseFloat(wan[1]);
        return Number.isFinite(v) ? v * 10000 : null;
    }
    const num = label.replace(/[^\d.]/g, '');
    const v = Number.parseFloat(num);
    return Number.isFinite(v) ? v : null;
}

function containsCjk(text) {
    return /[\u3400-\u9FFF]/.test(text || '');
}

function formatCny(cny) {
    if (!Number.isFinite(cny)) return null;
    return `¥${Math.round(cny).toLocaleString()}`;
}

function formatUsd(usd) {
    if (!Number.isFinite(usd)) return null;
    return `$${Math.round(usd).toLocaleString()}`;
}

function pickFirstString(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        const parts = value
            .map((v) => (typeof v === 'string' ? v.trim() : ''))
            .filter(Boolean);
        if (parts.length) return parts.join('，');
    }
    if (value && typeof value === 'object') {
        for (const v of Object.values(value)) {
            const s = pickFirstString(v);
            if (typeof s === 'string' && s.trim()) return s;
        }
    }
    return '';
}

function pickBestDescription(data) {
    const candidates = [];
    const add = (v) => {
        const s = pickFirstString(v);
        const t = (s || '').toString().trim();
        if (t) candidates.push(t);
    };

    add(data?.description);
    add(data?.description_label);
    add(data?.desc);
    add(data?.desc_label);
    add(data?.car_desc);
    add(data?.carDesc);
    add(data?.car_desc_label);
    add(data?.detail_desc);
    add(data?.detailDesc);
    add(data?.remark);
    add(data?.remarks);
    add(data?.memo);
    add(data?.comment);
    add(data?.selling_points);
    add(data?.sellingPoints);
    add(data?.highlights);
    add(data?.tags);
    add(data?.tag_list);
    add(data?.tagList);

    const seen = new Set();
    const unique = candidates.filter((c) => {
        if (seen.has(c)) return false;
        seen.add(c);
        return true;
    });

    const preferred = unique
        .filter((s) => /[\u3400-\u9FFF]/.test(s) || /[a-zA-Z]/.test(s))
        .sort((a, b) => b.length - a.length)[0];
    const best = preferred || unique.sort((a, b) => b.length - a.length)[0] || '';
    return best.length > 6000 ? best.slice(0, 6000) : best;
}

function translateJytData(data, options = {}) {
    const translated = {};
    
    const nameRaw = (data.name || "Unknown Model").toString();
    const descriptionRaw = pickBestDescription(data);
    translated.name_raw = nameRaw;
    translated.description_raw = descriptionRaw;
    translated.name = applyBrandModelDict(nameRaw);
    
    const priceCny = parsePriceCny(data.price_label);
    translated.price_cny = priceCny;
    translated.price_cny_label = priceCny != null ? formatCny(priceCny) : (data.price_label || "N/A");
    translated.price = translated.price_cny_label;

    const usdCnyRateFromEnv = Number.parseFloat(process.env.USD_CNY_RATE || '') || DEFAULT_USD_CNY_RATE;
    const fobMarkupCnyFromEnv = Number.parseFloat(process.env.FOB_MARKUP_CNY || '') || DEFAULT_FOB_MARKUP_CNY;
    const usdCnyRate = Number.isFinite(options.usdCnyRate) && options.usdCnyRate > 0 ? options.usdCnyRate : usdCnyRateFromEnv;
    const fobMarkupCny = Number.isFinite(options.fobMarkupCny) ? options.fobMarkupCny : fobMarkupCnyFromEnv;
    if (priceCny != null && Number.isFinite(usdCnyRate) && usdCnyRate > 0) {
        const fobCny = priceCny + fobMarkupCny;
        const fobUsd = fobCny / usdCnyRate;
        translated.fob_cny = fobCny;
        translated.fob_usd = fobUsd;
        translated.fob_usd_label = formatUsd(fobUsd);
        translated.fob_cny_label = formatCny(fobCny);
        translated.usd_cny_rate = usdCnyRate;
        translated.fob_markup_cny = fobMarkupCny;
    } else {
        translated.fob_cny = null;
        translated.fob_usd = null;
        translated.fob_usd_label = null;
        translated.fob_cny_label = null;
        translated.usd_cny_rate = usdCnyRate;
        translated.fob_markup_cny = fobMarkupCny;
    }
    
    const mileageMatch = (data.mileage_label || "").match(/([\d.]+)万公里/);
    if (mileageMatch) {
        translated.mileage = `${(parseFloat(mileageMatch[1]) * 10000).toLocaleString()} km`;
    } else {
        translated.mileage = data.mileage_label || "N/A";
    }
    
    let dateStr = data.plate_date_label || "N/A";
    dateStr = dateStr.replace("年", "");
    translated.plate_date = dateStr;
    
    translated.description = applyBrandModelDict(descriptionRaw);
    
    const images = Array.isArray(data.images) ? data.images : [];
    translated.images = images.map(img => `https://img.jytche.com/${img.filename}`);
    
    return translated;
}

// JYT API Endpoint
app.get('/api/jyt-car', async (req, res) => {
    const link = req.query.link;
    if (!link) return res.status(400).json({ error: "Link is required" });

    try {
        let carCode = null;
        try {
            const parsedUrl = new URL(link);
            carCode = parsedUrl.searchParams.get('car_code');
        } catch (_) {}

        if (!carCode) {
            const m = link.match(/(?:\?|&)?car_code=([a-zA-Z0-9_-]+)/);
            if (m && m[1]) carCode = m[1];
        }

        if (!carCode) {
            const raw = link.trim();
            if (/^[a-zA-Z0-9_-]{6,}$/.test(raw)) carCode = raw;
        }

        if (!carCode) return res.status(400).json({ error: "Invalid link: car_code not found" });

        const rl = enforceJytRateLimit(req, carCode);
        if (!rl.allowed) {
            res.set('Retry-After', String(rl.retryAfterSeconds || 1));
            return res.status(429).json({ error: "Rate limit exceeded", scope: rl.scope, retry_after_seconds: rl.retryAfterSeconds || 1 });
        }

        const startedAt = Date.now();
        const logPrefix = `[Puppeteer][${carCode}]`;
        console.log(`${logPrefix} start link=${link}`);
        const debugInfo = {
            car_code: carCode,
            tried_urls: [],
            navigations: [],
            final_url: "",
            captured_url: "",
            captured_status: null,
            error: "",
            elapsed_ms: 0
        };

        let data;
        let browser;
        let page;
        await acquirePuppeteerSlot('jyt-car:' + carCode);
        try {
            console.log(`${logPrefix} launching browser`);
            browser = await launchPuppeteerBrowser(['--window-size=1280,1024']);
            page = await browser.newPage();

            page.setDefaultTimeout(30000);
            // Simulate iPhone 12 Pro
            await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
            await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1');

            // Inject Access-Token into LocalStorage before navigation
            await page.evaluateOnNewDocument((token) => {
                try {
                    localStorage.setItem('Access-Token', token);
                    localStorage.setItem('token', token);
                    localStorage.setItem('userInfo', JSON.stringify({ token: token })); // Guessing possible keys
                } catch (e) {
                    console.error('Failed to inject token:', e);
                }
            }, getJytAccessToken());

            let capturedData = null;
            let capturedMeta = null;
            const isInnerApiUrl = (url) => {
                return url && typeof url === 'string' && url.includes('/inner-api/v2/');
            };
            const isCarApiUrl = (url) => {
                if (!isInnerApiUrl(url)) return false;
                if (url.includes(`/car/${carCode}`)) return true;
                if (url.includes(`car_code=${carCode}`)) return true;
                return false;
            };

            page.on('console', (msg) => {
                const text = msg.text();
                if (!text) return;
                console.log(`${logPrefix} console ${msg.type()}: ${text.slice(0, 800)}`);
            });
            page.on('pageerror', (err) => {
                console.log(`${logPrefix} pageerror: ${err?.message || String(err)}`);
            });
            page.on('error', (err) => {
                console.log(`${logPrefix} error: ${err?.message || String(err)}`);
            });
            page.on('requestfailed', (request) => {
                const url = request.url();
                const failure = request.failure();
                const reason = failure?.errorText || 'unknown';
                if (isInnerApiUrl(url) || url.includes('jytche.com')) {
                    console.log(`${logPrefix} requestfailed: ${reason} ${url}`);
                }
            });
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const url = request.url();

                if (url.includes('google-analytics') || url.includes('baidu.com')) {
                    request.abort();
                    return;
                }

                if (isInnerApiUrl(url)) {
                    const headers = {
                        ...request.headers(),
                        'Access-Token': getJytAccessToken(),
                        'from-type': 'h5',
                        'Origin': 'https://h5.jytche.com',
                        'Referer': 'https://h5.jytche.com/'
                    };
                    console.log(`${logPrefix} injecting headers for api ${url}`);
                    try {
                        request.continue({ headers });
                    } catch (e) {
                        console.log(`${logPrefix} request.continue error: ${e?.message || String(e)}`);
                        request.continue();
                    }
                    return;
                }
                request.continue();
            });
            page.on('response', async (response) => {
                const url = response.url();
                if (!isInnerApiUrl(url)) return;
                const status = response.status();
                console.log(`${logPrefix} api response status=${status} url=${url}`);
                if (status === 401) debugInfo.api_401 = true;

                if (!isCarApiUrl(url)) return; // Only capture data from car api

                try {
                    const headers = response.headers() || {};
                    const ct = (headers['content-type'] || headers['Content-Type'] || '').toString();
                    if (!ct.includes('application/json')) {
                        const text = await response.text();
                        console.log(`${logPrefix} api non-json head=${(text || '').slice(0, 300)}`);
                        return;
                    }
                    const json = await response.json();
                    if (json && typeof json === 'object') {
                        capturedData = json;
                        capturedMeta = { url, status };
                        debugInfo.captured_url = url;
                        debugInfo.captured_status = status;
                        console.log(`${logPrefix} captured api keys=${Object.keys(json).slice(0, 30).join(',')}`);
                    }
                } catch (e) {
                    console.log(`${logPrefix} api parse error: ${e?.message || String(e)}`);
                }
            });

            const candidateUrls = [];
            const normalizedLink = (link || '').toString().trim();
            if (/^https?:\/\//i.test(normalizedLink)) candidateUrls.push(normalizedLink);
            candidateUrls.push(`https://h5.jytche.com/#/car-detail?car_code=${carCode}`);
            candidateUrls.push(`https://h5.jytche.com/car-detail?car_code=${carCode}`);
            candidateUrls.push(`https://h5.jytche.com/car-detail?car_code=${carCode}&from=share`);

            for (const targetUrl of candidateUrls) {
                if (capturedData) break;
                debugInfo.tried_urls.push(targetUrl);
                console.log(`${logPrefix} goto ${targetUrl}`);
                let navResponse = null;
                try {
                    navResponse = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                } catch (e) {
                    console.log(`${logPrefix} goto error: ${e?.message || String(e)}`);
                }
                const navStatus = navResponse ? navResponse.status() : null;
                const finalUrl = page.url();
                debugInfo.navigations.push({ url: targetUrl, status: navStatus, final_url: finalUrl });
                console.log(`${logPrefix} goto done status=${navStatus} finalUrl=${finalUrl}`);
                try {
                    await page.evaluate((token) => { window.__ACCESS_TOKEN_OVERRIDE__ = token; }, getJytAccessToken());
                } catch (_) {}

                try {
                    await page.waitForResponse((r) => isCarApiUrl(r.url()), { timeout: 15000 });
                } catch (_) {
                    console.log(`${logPrefix} waitForResponse timeout (15s)`);
                }

                try {
                    await page.evaluate(async () => {
                        await new Promise((resolve) => {
                            let totalHeight = 0;
                            const distance = 120;
                            const timer = setInterval(() => {
                                const scrollHeight = document.body.scrollHeight;
                                window.scrollBy(0, distance);
                                totalHeight += distance;
                                if (totalHeight >= scrollHeight || totalHeight > 2400) {
                                    clearInterval(timer);
                                    resolve();
                                }
                            }, 120);
                        });
                    });
                } catch (e) {
                    console.log(`${logPrefix} scroll warning: ${e?.message || String(e)}`);
                }

                const delay = Math.floor(Math.random() * 3000) + 3000;
                console.log(`${logPrefix} dwell ${delay}ms`);
                await new Promise((r) => setTimeout(r, delay));
            }

            try {
                debugInfo.final_url = page.url();
            } catch (_) {}

            if (!capturedData) {
                console.log(`${logPrefix} api not captured, fallback fetch in page context`);
                const fallback = await page.evaluate(async (cCode) => {
                    try {
                        const url = `https://inner-h5.jytche.com/inner-api/v2/car/${cCode}`;
                        const res = await fetch(url, {
                            method: 'GET',
                            credentials: 'omit',
                            headers: { 
                                "from-type": "h5",
                                "Access-Token": (typeof window !== 'undefined' && window.__ACCESS_TOKEN_OVERRIDE__) || ""
                            },
                        });
                        const text = await res.text();
                        let json = null;
                        try { json = JSON.parse(text); } catch (_) {}
                        return {
                            url,
                            ok: res.ok,
                            status: res.status,
                            json,
                            textHead: (text || '').slice(0, 600)
                        };
                    } catch (e) {
                        return { ok: false, status: 0, url: '', json: null, textHead: String(e?.message || e) };
                    }
                }, carCode);
                console.log(`${logPrefix} fallback status=${fallback?.status} ok=${fallback?.ok} head=${(fallback?.textHead || '').slice(0, 300)}`);
                if (fallback && fallback.ok && fallback.json && typeof fallback.json === 'object') {
                    capturedData = fallback.json;
                    capturedMeta = { url: fallback.url, status: fallback.status };
                    debugInfo.captured_url = fallback.url;
                    debugInfo.captured_status = fallback.status;
                }
            }
            
            // DOM Scraping fallback (Ultimate fallback if API interception and fetch fail)
            if (!capturedData) {
                console.log(`${logPrefix} DOM scraping fallback triggered`);
                const scrapedData = await page.evaluate(() => {
                    const getText = (sel) => document.querySelector(sel)?.innerText?.trim() || '';
                    const getSrc = (sel) => document.querySelector(sel)?.src || '';
                    
                    // Try to find price
                    let price = "0";
                    // Try different price selectors observed in similar sites
                    const priceEl = document.querySelector('.price') || document.querySelector('[class*="price"]');
                    if (priceEl) {
                        const match = priceEl.innerText.match(/(\d+(?:\.\d+)?)/);
                        if (match) price = match[1];
                    }

                    // Try to find title
                    const name = getText('h1') || getText('.title') || getText('[class*="title"]') || document.title;
                    
                    // Try to find images
                    const images = [];
                    document.querySelectorAll('img').forEach(img => {
                        if (img.src && !img.src.includes('avatar') && !img.src.includes('icon') && img.width > 200) {
                            images.push({ filename: img.src });
                        }
                    });

                    // If we found at least a name, return a partial object
                    if (name) {
                        return {
                            name: name,
                            price: price,
                            mileage: "N/A", // Hard to parse without specific selector
                            plate_date: "N/A",
                            description: getText('.description') || getText('[class*="desc"]'),
                            images: images,
                            // Add flag to indicate scraped data
                            _is_scraped: true
                        };
                    }
                    return null;
                });

                if (scrapedData) {
                    console.log(`${logPrefix} DOM scraping success: ${scrapedData.name}`);
                    capturedData = scrapedData;
                    debugInfo.dom_scraped = true;
                } else {
                     console.log(`${logPrefix} DOM scraping failed`);
                }
            }

            data = capturedData;
            if (data) {
                console.log(`${logPrefix} success source=${debugInfo.dom_scraped ? 'dom' : (capturedMeta?.url || 'unknown')} elapsedMs=${Date.now() - startedAt}`);
            } else {
                console.log(`${logPrefix} no data captured elapsedMs=${Date.now() - startedAt}`);
            }

        } catch (err) {
            const message = err?.message || String(err);
            debugInfo.error = message;
            console.log(`${logPrefix} error: ${message}`);
            // Screenshot on error (opt-in — costs RAM right when we're close to OOM)
            if (process.env.DEBUG_SCREENSHOTS === '1') {
                try {
                    if (page) {
                        const errorScreenshotPath = path.join(__dirname, 'public', 'debug_error.png');
                        await page.screenshot({ path: errorScreenshotPath, fullPage: true });
                        console.log(`${logPrefix} error screenshot saved to ${errorScreenshotPath}`);
                    }
                } catch (e) {
                    console.log(`${logPrefix} failed to take error screenshot: ${e.message}`);
                }
            }
        } finally {
            debugInfo.elapsed_ms = Date.now() - startedAt;
            // Skip the "always final screenshot" on low-memory hosts — costs 20-40MB of
            // renderer activity right before shutdown and is only useful for debugging.
            if (process.env.DEBUG_SCREENSHOTS === '1') {
                try {
                    if (page && !page.isClosed()) {
                        const finalScreenshotPath = path.join(__dirname, 'public', 'debug_last_run.png');
                        await page.screenshot({ path: finalScreenshotPath, fullPage: true });
                        console.log(`${logPrefix} final screenshot saved to ${finalScreenshotPath}`);
                    }
                } catch (e) {}
            }

            try { if (page && !page.isClosed()) await page.close(); } catch (_) {}
            try { if (browser) await browser.close(); } catch (_) {}
            releasePuppeteerSlot();
        }

        if (!data) {
            if (debugInfo.api_401) {
                return res.status(401).json({ error: "TOKEN_EXPIRED", message: "JYT Access-Token 已失效，请到 /admin 页面更新 Token", car_code: carCode, debug: debugInfo });
            }
            return res.status(502).json({ error: "Failed to fetch data from JYT (Puppeteer)", car_code: carCode, debug: debugInfo });
        }
        
        const usdCnyRateOverride = Number.parseFloat(req.query.usd_cny_rate);
        const fobMarkupCnyOverride = Number.parseFloat(req.query.fob_markup_cny);
        const processedData = translateJytData(data, {
            usdCnyRate: Number.isFinite(usdCnyRateOverride) ? usdCnyRateOverride : undefined,
            fobMarkupCny: Number.isFinite(fobMarkupCnyOverride) ? fobMarkupCnyOverride : undefined
        });

        try {
            const [nameEn, descriptionEn] = await Promise.all([
                translateEnBrandModelPriority(processedData.name_raw || ''),
                translateEnBrandModelPriority(processedData.description_raw || '')
            ]);
            if (nameEn) processedData.name = nameEn;
            if (descriptionEn) processedData.description = descriptionEn;
        } catch (_) {}
        
        res.json(processedData);

    } catch (error) {
        console.error("JYT Fetch Error:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Configure storage for multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Ensure directory exists
        const dir = 'public/assets/';
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        // IMPORTANT: We need access to req.query here.
        // req.query is available because multer is called as middleware on the request.
        if (req.query.filename) {
            cb(null, req.query.filename);
        } else {
            cb(null, Date.now() + '-' + file.originalname);
        }
    }
});

const upload = multer({ storage: storage });

// Serve static files from public directory
app.use(express.static('public'));

// Upload endpoint
app.post('/upload', (req, res) => {
    // Multer middleware needs to run inside the route handler to catch errors
    // and access query params properly? No, it works as middleware.
    // Let's use upload.single('image') as middleware.
    
    const uploader = upload.single('image');
    uploader(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(500).json(err);
        } else if (err) {
            return res.status(500).json(err);
        }
        
        if (!req.file) {
            return res.status(400).send('No file uploaded.');
        }
        console.log(`File uploaded: ${req.file.filename}`);
        res.json({ success: true, filename: req.file.filename });
    });
});

app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('URL required');

    try {
        const commonConfig = {
            url: imageUrl,
            method: 'GET',
            responseType: 'stream',
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 300
        };

        let response;
        try {
            response = await axios({
                ...commonConfig,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': ''
                }
            });
        } catch (_) {
            response = await axios({
                ...commonConfig,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://h5.jytche.com/'
                }
            });
        }

        res.set('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        response.data.pipe(res);
    } catch (error) {
        console.error('Proxy error:', error.message, 'URL:', imageUrl);
        res.redirect(imageUrl);
    }
});

// Server-side PDF rendering via Puppeteer. Client POSTs the quotation HTML;
// server wraps it in a full page with the site CSS, then uses page.pdf() which
// honors CSS print rules (break-inside: avoid etc.) natively.
app.post('/api/pdf', express.json({ limit: '15mb' }), async (req, res) => {
    const html = (req.body?.html || '').toString();
    const filename = (req.body?.filename || 'SinoGear-Quotation.pdf').toString().replace(/[^\w.\-]/g, '_');
    if (!html) return res.status(400).json({ error: 'html required' });

    const origin = `http://127.0.0.1:${PORT}`;
    const fullHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<base href="${origin}/">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<link rel="stylesheet" href="${origin}/css/style.css">
<style>
  /* Print overrides: enforce page breaks and remove UI chrome */
  html, body { margin: 0; padding: 0; background: #fff; }
  .toolbar, .add-btn-container, .delete-btn, .add-label-btn { display: none !important; }
  .img-container, .card, .section-title { break-inside: avoid; page-break-inside: avoid; }
  .section-title { break-after: avoid; page-break-after: avoid; }
  img { max-width: 100%; }
</style>
</head>
<body class="exporting">
${html}
</body>
</html>`;

    let browser = null;
    let page = null;
    const startedAt = Date.now();
    await acquirePuppeteerSlot('pdf');
    try {
        browser = await launchPuppeteerBrowser();
        page = await browser.newPage();
        await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });
        await page.setContent(fullHtml, { waitUntil: 'networkidle0', timeout: 30000 });

        // Make sure all images have actually loaded (networkidle0 sometimes misses lazy/async)
        await page.evaluate(async () => {
            const imgs = Array.from(document.images || []);
            await Promise.all(imgs.map(img => {
                if (img.complete && img.naturalHeight !== 0) return Promise.resolve();
                return new Promise(resolve => {
                    img.addEventListener('load', resolve, { once: true });
                    img.addEventListener('error', resolve, { once: true });
                    setTimeout(resolve, 8000);
                });
            }));
        });

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: false,
            margin: { top: '0', right: '0', bottom: '0', left: '0' }
        });

        console.log(`[pdf] generated ${pdfBuffer.length} bytes in ${Date.now() - startedAt}ms`);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(pdfBuffer);
    } catch (e) {
        console.error('[pdf] error:', e?.message || e);
        res.status(500).json({ error: 'PDF generation failed', detail: e?.message || String(e) });
    } finally {
        try { if (page && !page.isClosed()) await page.close(); } catch (_) {}
        try { if (browser) await browser.close(); } catch (_) {}
        releasePuppeteerSlot();
    }
});

// Cheap health/memory endpoint — useful for UptimeRobot pinging AND for us to
// see whether we're close to the Render 512MB ceiling.
app.get('/api/health', (req, res) => {
    const m = process.memoryUsage();
    const mb = (n) => Math.round(n / 1024 / 1024);
    res.json({
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        memory: {
            rss: mb(m.rss) + 'MB',
            heapUsed: mb(m.heapUsed) + 'MB',
            heapTotal: mb(m.heapTotal) + 'MB',
            external: mb(m.external) + 'MB'
        },
        puppeteer: { busy: puppeteerBusy, queued: puppeteerWaiters.length }
    });
});

function isAdminAuthorized(req) {
    const adminKey = (process.env.ADMIN_KEY || '').toString();
    if (!adminKey) return true; // No ADMIN_KEY set → open admin access (convenient for local use)
    const candidate = (
        req.get('x-admin-key') ||
        req.query.key ||
        req.body?.key ||
        ''
    ).toString();
    const ok = candidate === adminKey;
    if (!ok) {
        console.log(`[admin-auth] ✗ REJECTED ${req.method} ${req.path} from ip=${getClientIp(req)} — ADMIN_KEY env is set (len=${adminKey.length}) but request supplied ${candidate ? `wrong key (len=${candidate.length})` : 'no key'}`);
    }
    return ok;
}

app.get('/admin', (req, res) => {
    const requireAdminKey = Boolean((process.env.ADMIN_KEY || '').toString());
    let persistBanner;
    if (GH_ENABLED) {
        persistBanner = `<div style="background:#d4edda;color:#155724;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:14px;">✓ GitHub 自动 commit 已启用 — 保存 token 会直接写回 <code>${GH_REPO}@${GH_BRANCH}/${GH_FILE}</code>，Render 自动重新部署（1-2 分钟）后永久生效</div>`;
    } else if (UPSTASH_ENABLED) {
        persistBanner = `<div style="background:#d4edda;color:#155724;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:14px;">✓ Upstash Redis 已连接 — 保存 token 会同步到云端，重启/重新部署不丢</div>`;
    } else {
        persistBanner = `<div style="background:#fff3cd;color:#856404;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:14px;">⚠ 未配置线上持久化 — 当前只存本地文件。在 Render 等临时文件系统上<b>重启会丢</b>。<br>二选一：<br>&nbsp;&nbsp;• 设置 <code>GITHUB_TOKEN</code>（自动 commit 到代码仓库，推荐）<br>&nbsp;&nbsp;• 或设置 <code>UPSTASH_REDIS_REST_URL</code> + <code>UPSTASH_REDIS_REST_TOKEN</code></div>`;
    }
    const upstashStatusBanner = persistBanner; // keep old var name for template reference
    res.type('html').send(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin - JYT Token</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; margin: 24px; }
    .box { max-width: 720px; margin: 0 auto; }
    label { display:block; margin: 12px 0 6px; font-weight: 600; }
    input { width: 100%; padding: 10px 12px; font-size: 16px; border: 1px solid #ccc; border-radius: 8px; }
    button { margin-top: 14px; padding: 10px 14px; font-size: 16px; border: 0; border-radius: 8px; background: #111; color: #fff; cursor: pointer; }
    pre { background: #f6f6f6; padding: 12px; border-radius: 8px; overflow: auto; }
    .row { display:flex; gap: 12px; }
    .row > div { flex: 1; }
  </style>
</head>
<body>
  <div class="box">
    <h2>JYT Access Token</h2>
    ${upstashStatusBanner}
    <div class="row">
      ${requireAdminKey ? `<div>
        <label>ADMIN_KEY</label>
        <input id="adminKey" type="password" autocomplete="off" />
      </div>` : ''}
      <div>
        <label>JYT_ACCESS_TOKEN</label>
        <input id="token" type="password" autocomplete="off" />
      </div>
    </div>
    <button id="saveBtn">保存到当前服务</button>
    <button id="statusBtn" style="margin-left: 10px; background:#444;">查看状态</button>
    <button id="testBtn" style="margin-left: 10px; background:#0a6;">测试 Token</button>
    <div id="testResult" style="margin-top:12px;padding:10px 14px;border-radius:8px;display:none;font-weight:600;white-space:pre-line;word-break:break-all;"></div>
    <pre id="out"></pre>
  </div>
  <script>
    console.log('[admin] script loaded');
    window.addEventListener('error', (e) => {
      console.error('[admin] GLOBAL ERROR:', e.message, 'at', e.filename + ':' + e.lineno);
    });
    window.addEventListener('unhandledrejection', (e) => {
      console.error('[admin] UNHANDLED PROMISE REJECTION:', e.reason);
    });
    const out = document.getElementById('out');
    const testResult = document.getElementById('testResult');
    const adminKeyEl = document.getElementById('adminKey');
    const tokenEl = document.getElementById('token');
    const saveBtn = document.getElementById('saveBtn');
    const statusBtn = document.getElementById('statusBtn');
    const testBtn = document.getElementById('testBtn');
    console.log('[admin] elements:', { out: !!out, testResult: !!testResult, adminKeyEl: !!adminKeyEl, tokenEl: !!tokenEl, saveBtn: !!saveBtn, statusBtn: !!statusBtn, testBtn: !!testBtn });

    async function api(path, body) {
      const key = adminKeyEl ? (adminKeyEl.value || '') : '';
      const res = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { ok: res.ok, status: res.status, json, text };
    }

    function showTestResult(valid, msg) {
      testResult.style.display = 'block';
      testResult.style.background = valid ? '#d4edda' : '#f8d7da';
      testResult.style.color = valid ? '#155724' : '#721c24';
      testResult.textContent = msg;
    }

    saveBtn.addEventListener('click', async () => {
      const token = tokenEl.value || '';
      const r = await api('/api/admin/jyt-token', { token });
      const j = r.json;
      if (j?.ok) {
        const githubOk = j.backends?.github === true;
        const upstashOk = j.backends?.upstash === true;
        const fileOk = j.backends?.file === true;
        let msg, success = true;
        if (githubOk) {
          const commit = j.githubCommit?.url;
          msg = '✓ 已 commit 到 GitHub（' + j.masked + '）— 内存已生效可立即使用，Render 重新部署后永久生效';
          if (commit) msg += '\\n  commit: ' + commit;
        } else if (j.githubError) {
          msg = '⚠ GitHub commit 失败：' + j.githubError + '（token 仍保存在内存和文件中）';
          success = false;
        } else if (upstashOk) {
          msg = '✓ 已保存到 Upstash Redis（' + j.masked + '）— 重启/部署都不丢';
        } else if (fileOk) {
          msg = '✓ 已保存到本地文件（' + j.masked + '）' + (j.note ? '\\n' + j.note : '');
        } else {
          msg = '⚠ 只存在内存，' + (j.warning || '重启会丢');
          success = false;
        }
        showTestResult(success, msg);
      } else {
        showTestResult(false, '保存失败: ' + (j?.error || r.status));
      }
      out.textContent = JSON.stringify(j || { status: r.status, text: r.text }, null, 2);
    });

    statusBtn.addEventListener('click', async () => {
      const r = await api('/api/admin/jyt-token');
      const j = r.json;
      let display = j || { status: r.status, text: r.text };
      if (j && j.ageMinutes != null) {
        const sourceLabels = { runtime: '内存/文件', env: '环境变量', default: '默认（已硬编码，大概率过期）' };
        display = Object.assign({}, j, {
          age: j.ageMinutes + ' 分钟前设置',
          sourceLabel: sourceLabels[j.source] || j.source
        });
      }
      out.textContent = JSON.stringify(display, null, 2);
    });

    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testResult.style.display = 'none';

      // Elapsed-time indicator (Render cold starts can take 30-60s)
      const startedAt = Date.now();
      let elapsed = 0;
      const tick = setInterval(() => {
        elapsed = Math.floor((Date.now() - startedAt) / 1000);
        let hint = '';
        if (elapsed > 30) hint = '（可能是 Render 冷启动，再等等…）';
        else if (elapsed > 10) hint = '（Render 可能正在唤醒…）';
        testBtn.textContent = '测试中… ' + elapsed + 's' + hint;
      }, 500);

      // Client-side abort so the user isn't left hanging forever
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000);

      try {
        const inputToken = (tokenEl.value || '').trim();
        const key = adminKeyEl ? (adminKeyEl.value || '') : '';
        const body = inputToken ? { token: inputToken } : {};
        const res = await fetch('/api/admin/jyt-token-test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        const text = await res.text();
        let j = null;
        try { j = JSON.parse(text); } catch (_) {}

        if (!res.ok) {
          showTestResult(false, '请求失败 (HTTP ' + res.status + '): ' + (j?.error || text.slice(0, 200)));
        } else if (j?.valid) {
          const which = j.tested === 'input' ? '（输入框的 token）' : '（已保存的 token）';
          showTestResult(true, 'Token 有效 ' + which + ' — HTTP ' + j.status + '，用时 ' + elapsed + 's');
        } else {
          const which = j?.tested === 'input' ? '（输入框的 token）' : '（已保存的 token）';
          showTestResult(false, 'Token 无效 ' + which + ': ' + (j?.reason || 'unknown'));
        }
        out.textContent = JSON.stringify(j || { status: res.status, text }, null, 2);
      } catch (e) {
        if (e.name === 'AbortError') {
          showTestResult(false, '超时 90 秒仍无响应。JYT 可能不通，或 Render 没唤醒。可以直接点"保存"（保存不依赖 JYT 连通），或再试一次。');
        } else {
          showTestResult(false, '网络错误: ' + (e.message || e));
        }
      } finally {
        clearTimeout(timeoutId);
        clearInterval(tick);
        testBtn.disabled = false;
        testBtn.textContent = '测试 Token';
      }
    });
  </script>
</body>
</html>`);
});

app.get('/api/admin/jyt-token', (req, res) => {
    if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = getJytAccessToken();
    const result = {
        hasToken: Boolean(token),
        masked: maskToken(token),
        source: getJytAccessTokenSource(),
        origin: runtimeJytAccessTokenOrigin, // 'upstash' | 'file' | null
        githubEnabled: GH_ENABLED,
        githubRepo: GH_ENABLED ? `${GH_REPO}@${GH_BRANCH}` : null,
        upstashEnabled: UPSTASH_ENABLED,
        persistedFileExists: fs.existsSync(TOKEN_FILE_PATH)
    };
    if (runtimeJytAccessTokenSetAt) {
        result.setAt = runtimeJytAccessTokenSetAt.toISOString();
        result.ageMinutes = Math.round((Date.now() - runtimeJytAccessTokenSetAt.getTime()) / 60000);
    }
    res.json(result);
});

app.post('/api/admin/jyt-token', async (req, res) => {
    if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = normalizeJytAccessToken(req.body?.token);
    if (!token) return res.status(400).json({ error: 'token required' });
    runtimeJytAccessToken = token;
    runtimeJytAccessTokenSetAt = new Date();

    const result = { ok: true, masked: maskToken(token), backends: {} };

    // 1. GitHub auto-commit (writes to the actual source file → next redeploy becomes permanent)
    if (GH_ENABLED) {
        try {
            const gh = await githubCommitToken(token);
            result.backends.github = gh.ok ? true : false;
            if (gh.ok) {
                result.githubCommit = { sha: gh.commitSha, url: gh.commitUrl, unchanged: !!gh.unchanged };
            } else {
                result.githubError = gh.reason;
            }
        } catch (e) {
            result.backends.github = false;
            result.githubError = e.message;
        }
    } else {
        result.backends.github = 'not-configured';
    }

    // 2. Upstash (alternative persistent backend, also survives deploys)
    if (UPSTASH_ENABLED) {
        const ok = await upstashSetToken(token);
        result.backends.upstash = ok;
        if (ok) runtimeJytAccessTokenOrigin = 'upstash';
    } else {
        result.backends.upstash = 'not-configured';
    }

    // 3. Local file (cheap, always attempted)
    const fileOk = persistToken(token);
    result.backends.file = fileOk;
    if (fileOk && runtimeJytAccessTokenOrigin !== 'upstash') runtimeJytAccessTokenOrigin = 'file';

    // Summarize persistence outcome for the user
    if (result.backends.github === true) {
        result.note = '✓ 已提交到 GitHub，Render 会在 1-2 分钟内自动重新部署。这期间 token 在内存里已生效，可以直接用。';
    } else if (result.backends.upstash === true) {
        result.note = '✓ 已写入 Upstash，立即持久生效。';
    } else if (!GH_ENABLED && !UPSTASH_ENABLED && !fileOk) {
        result.warning = '只存在内存中，重启会丢。配置 GITHUB_TOKEN 或 Upstash 即可持久化。';
    } else if (!GH_ENABLED && !UPSTASH_ENABLED) {
        result.note = '已保存到本地文件（临时文件系统重启会丢）。配置 GITHUB_TOKEN 让保存自动提交到代码仓库。';
    }

    res.json(result);
});

async function testJytToken(token) {
    const logPrefix = `[token-test]`;
    if (!token) {
        console.log(`${logPrefix} skipped: token is empty`);
        return { valid: false, reason: 'token 为空' };
    }
    const testUrl = 'https://inner-h5.jytche.com/inner-api/v2/car/test_placeholder';
    const masked = maskToken(token);
    const startedAt = Date.now();
    console.log(`${logPrefix} → GET ${testUrl} with Access-Token=${masked} (len=${token.length})`);

    let resp;
    try {
        resp = await axios.get(testUrl, {
            headers: {
                'Access-Token': token,
                'from-type': 'h5',
                'Origin': 'https://h5.jytche.com',
                'Referer': 'https://h5.jytche.com/',
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                'Accept': 'application/json, text/plain, */*'
            },
            timeout: 10000,
            validateStatus: () => true
        });
    } catch (e) {
        const elapsed = Date.now() - startedAt;
        const kind = e.code || e.name || 'error';
        console.log(`${logPrefix} ✗ network error after ${elapsed}ms: ${kind} - ${e.message}`);
        return { valid: false, reason: `网络错误 (${kind}): ${e.message}`, elapsedMs: elapsed };
    }

    const elapsed = Date.now() - startedAt;
    const status = resp.status;
    const body = resp.data;
    const bodyPreview = typeof body === 'object' ? JSON.stringify(body).slice(0, 200) : String(body).slice(0, 200);
    console.log(`${logPrefix} ← HTTP ${status} in ${elapsed}ms, body=${bodyPreview}`);

    if (status === 401 || status === 403) {
        console.log(`${logPrefix} ✗ invalid: HTTP ${status} (auth rejected by JYT)`);
        return { valid: false, status, reason: `Token 已失效 (HTTP ${status})`, body, elapsedMs: elapsed };
    }
    // JYT sometimes returns 200 with auth error in body
    if (body && typeof body === 'object') {
        const code = body.code ?? body.status ?? body.errcode;
        const msg = (body.msg || body.message || '').toString();
        if (code === 401 || code === 403 || /token|未登录|未授权|过期|无效/i.test(msg)) {
            console.log(`${logPrefix} ✗ invalid: 200 OK but body says code=${code} msg="${msg}"`);
            return { valid: false, status, reason: `Token 无效: code=${code} msg=${msg}`, body, elapsedMs: elapsed };
        }
    }
    console.log(`${logPrefix} ✓ valid (HTTP ${status})`);
    return { valid: true, status, reason: `Token 有效 (HTTP ${status})`, body, elapsedMs: elapsed };
}

// POST with optional body.token: if provided, test that exact token; else test saved
app.post('/api/admin/jyt-token-test', async (req, res) => {
    if (!isAdminAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const ip = getClientIp(req);
    const provided = normalizeJytAccessToken(req.body?.token);
    const token = provided || getJytAccessToken();
    const which = provided ? 'input' : 'saved';
    console.log(`[token-test] POST from ip=${ip} testing=${which} source=${getJytAccessTokenSource()}`);
    try {
        const result = await testJytToken(token);
        res.json({ ...result, tested: which, masked: maskToken(token) });
    } catch (e) {
        console.log(`[token-test] unexpected error: ${e.message}`);
        res.json({ valid: false, reason: `请求失败: ${e.message}` });
    }
});

app.get('/api/admin/jyt-token-test', async (req, res) => {
    if (!isAdminAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const ip = getClientIp(req);
    console.log(`[token-test] GET from ip=${ip} testing=saved source=${getJytAccessTokenSource()}`);
    try {
        const result = await testJytToken(getJytAccessToken());
        res.json({ ...result, tested: 'saved' });
    } catch (e) {
        console.log(`[token-test] unexpected error: ${e.message}`);
        res.json({ valid: false, reason: `请求失败: ${e.message}` });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('Use Ctrl+C to stop.');
});
