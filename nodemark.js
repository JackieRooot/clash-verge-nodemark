#!/usr/bin/env node
// clash-verge-nodemark：在浏览器里镜像 Clash Verge 的代理组页面，右键节点卡片标记 好用 / 一般 / 不建议。
// 不改 Clash Verge 的任何设置：直接连 mihomo 内核的控制接口（Windows 命名管道 / macOS、Linux 的 Unix socket，
// 或者 HTTP 外部控制），读节点、切节点、测延迟。标记按订阅分开存，节点清单以内核里的真实清单为准。
// 另有「系统标记」模式：按历次「测全组」的结果给节点算推荐指数（星级），规则见下面的 SCORE_BANDS。
//
// 用法：
//   node nodemark.js          服务没在运行就在后台启动，然后用默认浏览器打开页面
//   node nodemark.js serve    在前台运行服务（看日志、调试用）
//   node nodemark.js stop     停掉后台服务
// 选项：--port <端口>（默认 9099）、--no-open（只启动不开浏览器）、
//       --keep（关掉页面后也不自动退出）、
//       --no-follow（Clash Verge 退出后也不跟着退出）、
//       --demo（演示模式：用假数据，不连内核、不写标记文件，默认端口 9098）
// 后台启动的服务在所有页面都关掉 15 秒后自动退出；带 --no-open 或 --keep 启动的不会。
// 不管怎么启动，内核连续 30 秒连不上（Clash Verge 退出了）服务都会跟着退出；带 --no-follow 的不会。

'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP = 'clash-verge-nodemark';
const VERSION = require('./package.json').version;

// ---------- 命令行参数 ----------

const argv = process.argv.slice(2);
function option(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const command = argv.filter((a, i) => !a.startsWith('-') && argv[i - 1] !== '--port')[0] || 'open';
const NO_OPEN = argv.includes('--no-open');
const KEEP = argv.includes('--keep');
const NO_FOLLOW = argv.includes('--no-follow');
const OPEN_DELAY_S = 3;           // 打开浏览器前倒数的秒数
const DEMO = argv.includes('--demo');
const PORT = Number(option('--port') || (!DEMO && process.env.NODEMARK_PORT)) || (DEMO ? 9098 : 9099);

// ---------- 路径 ----------

function userDataDir() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

const DATA_DIR = process.env.NODEMARK_DATA_DIR || path.join(userDataDir(), APP);
const MARKS_FILE = path.join(DATA_DIR, 'marks.json');
const LOG_FILE = path.join(DATA_DIR, 'nodemark.log');
const LOG_MAX_BYTES = 1024 * 1024;  // 日志超过这么大，下次启动时改名成 nodemark.old.log，重新开一个
const PAGE_FILE = path.join(__dirname, 'index.html');

// Clash Verge Rev 的数据目录（正式版 / 开发版），可用 VERGE_DIR 指定
function findVergeDir() {
  if (process.env.VERGE_DIR) return process.env.VERGE_DIR;
  const ids = ['io.github.clash-verge-rev.clash-verge-rev', 'io.github.clash-verge-rev.clash-verge-rev.dev'];
  for (const id of ids) {
    const dir = path.join(userDataDir(), id);
    if (fs.existsSync(path.join(dir, 'clash-verge.yaml'))) return dir;
  }
  return null;
}

// ---------- 常量 ----------

const MARKS = ['good', 'warn', 'bad'];
const REMOVED_KEEP = 200;            // 每个订阅最多保留多少条「被移除的已标记节点」记录
const STABLE_MS = 5000;              // 节点清单至少稳定这么久才同步，避免切订阅的过渡期误删
const DEFAULT_TEST_URL = 'https://cp.cloudflare.com/generate_204';
const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay']);
const BUILTIN_TYPES = new Set(['Direct', 'Reject', 'RejectDrop', 'Pass', 'PassRule', 'Compatible']);
const isMarkable = (p) => p && !GROUP_TYPES.has(p.type) && !BUILTIN_TYPES.has(p.type);
const enc = encodeURIComponent;

// 系统标记：只记系统标记模式下「测全组」的结果，按历史换算成推荐指数（0–5 星，半星一档）。
// 每个样本按测试时统一延迟的开关选档位表：[延迟上限 ms（不含）, 单次分, 权重]，越差的档权重越大；
// 超过最后一档上限、超时、失败都按超时算（0 分，权重 TIMEOUT_WEIGHT）。
// 没开统一延迟的那套按实测定；开了的那套还没实测，是估算
const SCORE_BANDS = {
  off: [[800, 5, 1], [1100, 4, 1], [1500, 3, 1.5], [2200, 2, 2], [3500, 1, 3]],
  on: [[200, 5, 1], [400, 4, 1], [700, 3, 1.5], [1200, 2, 2], [2500, 1, 3]],
};
const TIMEOUT_WEIGHT = 6;
const PRIOR_SCORE = 3, PRIOR_WEIGHT = 1;   // 先垫一次 3 分的虚拟结果，新节点测一次拿不到满分
const SAMPLE_KEEP = 30;                    // 每个节点保留最近多少个样本（超时封顶也只看这些）
const VOID_MIN = 4, VOID_RATIO = 0.6;      // 组里至少 4 个节点、本轮 ≥ 60% 超时：当作本机网络问题，整轮不计入

// ---------- 读配置 ----------

function yamlScalar(text, key) {
  const m = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return '';
  return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
}

function readVerge(file) {
  const dir = findVergeDir();
  if (!dir) return null;
  try { return fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return null; }
}

// 连内核的方式，优先级：环境变量 CLASH_API / CLASH_SOCKET > Clash Verge 运行时配置里的管道或 socket > 外部控制 HTTP
function resolveCore() {
  const envSecret = process.env.CLASH_SECRET;
  if (process.env.CLASH_API) {
    const u = new URL(process.env.CLASH_API);
    return { kind: 'http', host: u.hostname, port: Number(u.port) || 80, secret: envSecret || '', label: u.host };
  }
  const y = readVerge('clash-verge.yaml');
  const secret = envSecret !== undefined ? envSecret : (y ? yamlScalar(y, 'secret') : '');
  if (process.env.CLASH_SOCKET) return { kind: 'socket', socketPath: process.env.CLASH_SOCKET, secret, label: process.env.CLASH_SOCKET };
  if (!y) {
    throw new Error('找不到 Clash Verge Rev 的配置（clash-verge.yaml）。没装 Clash Verge Rev 的话，用环境变量 CLASH_API 指定内核的外部控制地址');
  }
  const sock = yamlScalar(y, process.platform === 'win32' ? 'external-controller-pipe' : 'external-controller-unix');
  if (sock) return { kind: 'socket', socketPath: sock, secret, label: sock };
  const ctl = yamlScalar(y, 'external-controller');
  if (ctl) {
    const m = ctl.match(/^(.*):(\d+)$/);
    const host = !m || !m[1] || m[1] === '0.0.0.0' || m[1] === '::' || m[1] === '[::]' ? '127.0.0.1' : m[1].replace(/^\[|\]$/g, '');
    return { kind: 'http', host, port: Number(m ? m[2] : 9090), secret, label: `${host}:${m ? m[2] : 9090}` };
  }
  throw new Error('Clash Verge 的运行时配置里既没有命名管道 / Unix socket，也没有开外部控制');
}

function vergeSettings() {
  const v = readVerge('verge.yaml');
  return {
    testUrl: process.env.NODEMARK_TEST_URL || (v && yamlScalar(v, 'default_latency_test')) || DEFAULT_TEST_URL,
    timeout: Number(v && yamlScalar(v, 'default_latency_timeout')) || 10000,
  };
}

// 统一延迟开没开：优先用内核 /configs 返回的实际状态，没有再读运行时配置
function unifiedDelay(configs) {
  if (configs && typeof configs['unified-delay'] === 'boolean') return configs['unified-delay'];
  const y = readVerge('clash-verge.yaml');
  return !!y && yamlScalar(y, 'unified-delay') === 'true';
}

// 当前订阅：profiles.yaml 顶层 current 是 uid，到 items 里找同 uid 那一项的 name；没有 Clash Verge 时统一记在 default 下
function currentProfile() {
  if (DEMO) return { uid: 'demo', name: '示例订阅' };
  const y = readVerge('profiles.yaml');
  if (!y) return { uid: 'default', name: 'default' };
  const uid = yamlScalar(y, 'current') || 'default';
  let name = uid;
  const lines = y.split(/\r?\n/);
  const start = lines.findIndex((l) => l.replace(/\s+$/, '') === `- uid: ${uid}`);
  if (start >= 0) {
    for (let i = start + 1; i < lines.length && !lines[i].startsWith('- '); i++) {
      const m = lines[i].match(/^  name:[ \t]*(.*)$/);
      if (m) { name = m[1].trim().replace(/^(['"])(.*)\1$/, '$2') || uid; break; }
    }
  }
  return { uid, name };
}

// ---------- 读 Clash Verge 代理页里每个组的排序方式 ----------
// Clash Verge 把代理页每个组的界面状态存在 WebView 的 localStorage 里，键是 proxy-head-state，
// 结构为 { <订阅 uid>: { <组名>: { sortType: 0 默认 | 1 按延迟 | 2 按名称, ... } } }。
// Windows 上 WebView2 把 localStorage 存成 LevelDB（表文件的数据块用 snappy 压缩），这里自己解析，不引依赖。
// 其他系统的 WebView 用的是别的存储格式，读不到时页面退回默认顺序。

function varint(buf, pos) {
  let v = 0, mul = 1, b;
  do { b = buf[pos++]; v += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
  return [v, pos];
}

function snappyUncompress(src) {
  let [len, pos] = varint(src, 0);
  const out = Buffer.alloc(len);
  let op = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    if ((tag & 3) === 0) {                     // 字面量
      let n = tag >> 2;
      if (n >= 60) { const k = n - 59; n = src.readUIntLE(pos, k); pos += k; }
      n += 1;
      src.copy(out, op, pos, pos + n); pos += n; op += n;
      continue;
    }
    let n, off;                                // 回引：从已输出的数据里复制，可能和自身重叠，只能逐字节
    if ((tag & 3) === 1) { n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[pos++]; }
    else if ((tag & 3) === 2) { n = (tag >> 2) + 1; off = src.readUInt16LE(pos); pos += 2; }
    else { n = (tag >> 2) + 1; off = src.readUInt32LE(pos); pos += 4; }
    for (let i = 0; i < n; i++, op++) out[op] = out[op - off];
  }
  return out;
}

// 表文件（.ldb）里的一个块：前缀压缩的键值对 + 末尾的重启点数组
function blockEntries(block) {
  const end = block.length - 4 - block.readUInt32LE(block.length - 4) * 4;
  const out = [];
  let pos = 0, key = Buffer.alloc(0), shared, own, vlen;
  while (pos < end) {
    [shared, pos] = varint(block, pos); [own, pos] = varint(block, pos); [vlen, pos] = varint(block, pos);
    key = Buffer.concat([key.subarray(0, shared), block.subarray(pos, pos + own)]); pos += own;
    out.push([key, block.subarray(pos, pos + vlen)]); pos += vlen;
  }
  return out;
}

function readBlock(file, handle) {
  const [off, p] = varint(handle, 0);
  const [size] = varint(handle, p);
  const raw = file.subarray(off, off + size);
  return file[off + size] === 1 ? snappyUncompress(raw) : raw;   // 块后 1 字节压缩类型：0 不压缩，1 snappy
}

// 内部键 = 用户键 + 8 字节（序号 << 8 | 类型；类型 1 写入，0 删除）
function tableEntries(file, visit) {
  const footer = file.subarray(file.length - 48);
  let p = varint(footer, varint(footer, 0)[1])[1];              // 跳过 metaindex 的位置和大小
  for (const [, handle] of blockEntries(readBlock(file, footer.subarray(p)))) {
    for (const [ikey, value] of blockEntries(readBlock(file, handle))) {
      const tail = ikey.readBigUInt64LE(ikey.length - 8);
      visit(ikey.subarray(0, ikey.length - 8), tail >> 8n, Number(tail & 0xffn) === 1 ? value : null);
    }
  }
}

// 日志文件（.log）：32 KB 一块，记录可能跨块拆成 FIRST / MIDDLE / LAST；每条完整记录是一个写入批次
function logEntries(file, visit) {
  let parts = [];
  for (let block = 0; block < file.length; block += 32768) {
    const end = Math.min(block + 32768, file.length);
    for (let pos = block; pos + 7 <= end;) {
      const len = file.readUInt16LE(pos + 4), type = file[pos + 6];
      if (type === 0) break;
      const data = file.subarray(pos + 7, pos + 7 + len);
      pos += 7 + len;
      if (type === 1 || type === 2) parts = [data]; else parts.push(data);
      if (type !== 1 && type !== 4) continue;
      const batch = Buffer.concat(parts);
      let seq = batch.readBigUInt64LE(0), at = 12, klen, vlen;
      for (let i = batch.readUInt32LE(8); i > 0; i--, seq++) {
        const put = batch[at++] === 1;
        [klen, at] = varint(batch, at);
        const key = batch.subarray(at, at + klen); at += klen;
        let value = null;
        if (put) { [vlen, at] = varint(batch, at); value = batch.subarray(at, at + vlen); at += vlen; }
        visit(key, seq, value);
      }
      parts = [];
    }
  }
}

// 从 LevelDB 目录里找 localStorage 某个键的最新值（Chromium 的键格式：'_' + 源 + '\0' + '\x01' + 键名）
function readLocalStorage(dir, name) {
  const suffix = Buffer.from(`\0\x01${name}`, 'latin1');
  let best = { seq: -1n, value: null };
  const visit = (key, seq, value) => {
    if (key[0] === 0x5f && key.length > suffix.length && key.subarray(key.length - suffix.length).equals(suffix) && seq > best.seq) {
      best = { seq, value };
    }
  };
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.ldb')) tableEntries(fs.readFileSync(path.join(dir, f)), visit);
    else if (f.endsWith('.log')) logEntries(fs.readFileSync(path.join(dir, f)), visit);
  }
  const v = best.value;
  if (!v || !v.length) return null;
  return v[0] === 0 ? v.subarray(1).toString('utf16le') : v.subarray(1).toString('latin1');   // 首字节 0 = UTF-16LE，1 = Latin-1
}

let cvSortCache = { sig: '', data: null };

// 返回当前订阅下 { 组名: 0 | 1 | 2 }，没设置过的组不在里面（等于默认顺序）；读不到返回 null
function cvSortTypes(uid) {
  const vergeDir = findVergeDir();
  if (process.platform !== 'win32' || !vergeDir) return null;
  const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    path.basename(vergeDir), 'EBWebView', 'Default', 'Local Storage', 'leveldb');
  try {
    // 文件没变就不重新解析
    const sig = fs.readdirSync(dir).map((f) => { const s = fs.statSync(path.join(dir, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).join('|');
    if (sig !== cvSortCache.sig) {
      const text = readLocalStorage(dir, 'proxy-head-state');
      cvSortCache = { sig, data: text ? JSON.parse(text) : {} };
    }
  } catch {
    // Clash Verge 正在整理 LevelDB 文件时可能读到一半，沿用上次的结果，下次再读
    if (!cvSortCache.data) return null;
  }
  const groups = cvSortCache.data[uid] || {};
  const out = {};
  for (const [g, s] of Object.entries(groups)) if (s && [1, 2].includes(s.sortType)) out[g] = s.sortType;
  return out;
}

// ---------- 演示模式：一个只在内存里的假内核 ----------

const demo = (() => {
  const regions = [['🇭🇰', '香港'], ['🇯🇵', '日本'], ['🇸🇬', '新加坡'], ['🇺🇸', '美国'], ['🇨🇳', '台湾']];
  const types = ['Vless', 'Hysteria2', 'Trojan', 'Shadowsocks', 'Vmess'];
  const proxies = {};
  const nodes = [];
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // 每个节点的基准延迟和超时概率（loss = 1 是一直超时的节点）
  const sample = (p) => (rand() < p.loss ? 0 : Math.round(p.base + rand() * p.base * 0.8));
  const LOSS = { '3-4': 1, '4-3': 1, '0-3': 0.06, '1-2': 0.12, '2-4': 0.3 };
  regions.forEach(([flag, region], r) => {
    for (let i = 1; i <= 4; i++) {
      const name = `${flag} ${region} ${String(i).padStart(2, '0')}`;
      const p = { name, type: types[(r + i) % types.length], udp: i !== 3,
        base: [45, 70, 95, 180, 85][r] * [1, 1.6, 2.6, 4][i - 1], loss: LOSS[`${r}-${i}`] || 0 };
      p.history = [{ delay: p.loss === 1 ? 0 : Math.round(p.base + rand() * p.base * 0.8) }];
      proxies[name] = p;
      nodes.push(name);
    }
  });
  for (const t of ['Direct', 'Reject']) proxies[t.toUpperCase()] = { name: t.toUpperCase(), type: t, udp: true, history: [] };
  const group = (name, type, all, now) => { proxies[name] = { name, type, all, now, history: [] }; };
  group('节点选择', 'Selector', ['自动选择', '故障转移', ...nodes], nodes[1]);
  group('自动选择', 'URLTest', nodes, nodes[0]);
  group('故障转移', 'Fallback', nodes, nodes[0]);
  group('流媒体', 'Selector', ['节点选择', ...nodes.filter((n) => !n.includes('美国'))], nodes[5]);
  group('直连兜底', 'Selector', ['DIRECT', '节点选择'], 'DIRECT');
  group('GLOBAL', 'Selector', ['DIRECT', 'REJECT', '节点选择', '自动选择', '故障转移', '流媒体', '直连兜底', ...nodes], '节点选择');

  const marks = {};
  const seedMarks = { [nodes[0]]: 'good', [nodes[1]]: 'good', [nodes[5]]: 'good', [nodes[9]]: 'good',
    [nodes[2]]: 'warn', [nodes[12]]: 'warn', [nodes[15]]: 'bad', [nodes[18]]: 'bad', [nodes[7]]: 'bad' };
  // 系统标记的历史样本：大多数节点 10–24 个，一个只有 2 个（样本不足），一个还没测过；演示内核按开了统一延迟算
  nodes.forEach((n, k) => {
    marks[n] = { mark: seedMarks[n] || null, firstSeen: '2026-01-01T00:00:00.000Z' };
    const count = k === 19 ? 0 : k === 17 ? 2 : 10 + Math.floor(rand() * 15);
    if (count) marks[n].samples = Array.from({ length: count }, (_, j) => ({
      at: new Date(Date.now() - (count - j) * 6 * 3600e3).toISOString(), delay: sample(proxies[n]), unified: true,
    }));
  });

  function test(name) {
    const p = proxies[name];
    if (!p || p.type === 'Direct' || p.type === 'Reject') return 0;
    if (p.all) { const d = test(p.now); p.history = [{ delay: d }]; return d; }
    const delay = sample(p);
    p.history = [{ delay }];
    return delay;
  }

  function request(method, apiPath, body) {
    const url = new URL(apiPath, 'http://demo');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (method === 'GET' && url.pathname === '/proxies') return { status: 200, json: { proxies } };
    if (method === 'GET' && url.pathname === '/configs') return { status: 200, json: { mode: 'rule', 'unified-delay': true } };
    if (method === 'PUT' && parts[0] === 'proxies' && proxies[parts[1]]) {
      proxies[parts[1]].now = body.name;
      return { status: 204, json: null };
    }
    if (parts[0] === 'proxies' && parts[2] === 'delay') {
      const d = test(parts[1]);
      return d ? { status: 200, json: { delay: d } } : { status: 504, json: { message: 'Timeout' } };
    }
    if (parts[0] === 'group' && parts[2] === 'delay' && proxies[parts[1]]) {
      const out = {};
      for (const n of proxies[parts[1]].all) { const d = test(n); if (d) out[n] = d; }
      // 和 mihomo 一样：只返回测通的；全都不通时返回 504
      return Object.keys(out).length ? { status: 200, json: out } : { status: 504, json: { message: 'get delay: all proxies timeout' } };
    }
    return { status: 404, json: { message: 'not found' } };
  }

  return { request, profiles: { demo: { name: '示例订阅', syncedAt: null, nodes: marks, removed: [] } } };
})();

// ---------- 调内核接口 ----------

let core = null;   // 出错时清空，下次重新读配置（Clash Verge 重启后管道名可能会变）

function coreRequest(method, apiPath, body, retried = false) {
  if (DEMO) {
    const r = demo.request(method, apiPath, body);
    // 测速稍微等一下，看起来像真的在测
    return new Promise((resolve) => setTimeout(() => resolve(r), apiPath.includes('delay') ? 400 : 0));
  }
  return new Promise((resolve, reject) => {
    let c;
    try { c = core || (core = resolveCore()); } catch (e) { return reject(e); }
    const data = body === undefined ? null : JSON.stringify(body);
    const target = c.kind === 'socket' ? { socketPath: c.socketPath } : { host: c.host, port: c.port };
    const req = http.request({
      ...target, path: apiPath, method,
      headers: {
        ...(c.secret ? { Authorization: `Bearer ${c.secret}` } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { json = { message: buf }; }
        if (res.statusCode === 401) core = null;
        resolve({ status: res.statusCode, json });
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => {
      core = null;
      if (!retried) coreRequest(method, apiPath, body, true).then(resolve, reject);
      else reject(new Error(`连不上 mihomo 内核（${c.label}），Clash Verge 开着吗？${e.message}`));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function coreGet(apiPath) {
  const r = await coreRequest('GET', apiPath);
  if (r.status === 401) throw new Error('内核拒绝访问（密钥不对）。可以用环境变量 CLASH_SECRET 指定密钥');
  if (r.status !== 200) throw new Error(`${apiPath} 返回 ${r.status}：${r.json && r.json.message}`);
  return r.json;
}

// ---------- 标记文件 ----------
// { version, profiles: { <uid>: { name, syncedAt, removed: [...],
//     nodes: { <节点名>: { mark, firstSeen, markedAt, samples: [{ at, delay, unified }] } } } } }
// samples 是系统标记的测速历史，delay 为 0 表示超时 / 失败

function loadMarks() {
  if (DEMO) return { version: 1, profiles: demo.profiles };
  try {
    const m = JSON.parse(fs.readFileSync(MARKS_FILE, 'utf8').replace(/^﻿/, ''));
    if (m && m.profiles) return m;
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, profiles: {} };
  }
  // 文件坏了不要覆盖，另存一份再从空开始
  fs.copyFileSync(MARKS_FILE, `${MARKS_FILE}.broken-${Date.now()}`);
  return { version: 1, profiles: {} };
}

let marks = null;

function saveMarks() {
  if (DEMO) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${MARKS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marks, null, 2), 'utf8');
  fs.renameSync(tmp, MARKS_FILE);
}

function profileEntry(profile) {
  let p = marks.profiles[profile.uid];
  if (!p) p = marks.profiles[profile.uid] = { name: profile.name, syncedAt: null, nodes: {}, removed: [] };
  p.name = profile.name;
  return p;
}

// 清单稳定判断：同一订阅、同一份节点清单，连续出现超过 STABLE_MS 才同步
let pending = { key: '', since: 0 };

function syncNodes(profile, realNames) {
  const key = `${profile.uid}\n${[...realNames].sort().join('\n')}`;
  const now = Date.now();
  if (key !== pending.key) { pending = { key, since: now }; return false; }
  if (now - pending.since < STABLE_MS) return false;

  const p = profileEntry(profile);
  const stamp = new Date().toISOString();
  let changed = !p.syncedAt;
  for (const name of realNames) {
    if (!p.nodes[name]) { p.nodes[name] = { mark: null, firstSeen: stamp }; changed = true; }
  }
  for (const [name, info] of Object.entries(p.nodes)) {
    if (realNames.has(name)) continue;
    if (info.mark) p.removed.push({ name, mark: info.mark, markedAt: info.markedAt || null, removedAt: stamp });
    delete p.nodes[name];
    changed = true;
  }
  if (p.removed.length > REMOVED_KEEP) p.removed = p.removed.slice(-REMOVED_KEEP);
  if (changed) { p.syncedAt = stamp; saveMarks(); }
  return true;
}

// ---------- 系统标记：推荐指数 ----------

function sampleBand(s) {
  if (s.delay > 0) for (const [max, score, weight] of SCORE_BANDS[s.unified ? 'on' : 'off']) {
    if (s.delay < max) return { score, weight, timeout: false };
  }
  return { score: 0, weight: TIMEOUT_WEIGHT, timeout: true };
}

// 推荐指数 = 加权平均（含垫的虚拟结果），四舍五入到半星；再按窗口内的超时情况封顶
function rateNode(samples) {
  let sum = PRIOR_SCORE * PRIOR_WEIGHT, weights = PRIOR_WEIGHT, timeouts = 0;
  for (const s of samples) {
    const b = sampleBand(s);
    sum += b.score * b.weight; weights += b.weight;
    if (b.timeout) timeouts++;
  }
  const score = sum / weights;
  const rate = timeouts / samples.length;
  const cap = !timeouts ? 5 : rate >= 0.4 ? 0 : timeouts >= 2 || rate >= 0.15 ? 1 : 2;
  const rounded = Math.round(score * 2) / 2;
  return { stars: Math.min(rounded, cap), score: Math.round(score * 100) / 100, n: samples.length, timeouts, capped: cap < rounded };
}

// 系统标记模式的「测全组」：测完把组里每个真实节点的结果记一个样本（代理组、DIRECT 这类不记）
async function systemGroupTest(group, query) {
  const [{ proxies }, configs] = await Promise.all([coreGet('/proxies'), coreGet('/configs')]);
  const unified = unifiedDelay(configs);
  const g = proxies[group];
  if (!g || !g.all) throw new Error(`找不到代理组：${group}`);
  const names = [...new Set(g.all)].filter((n) => isMarkable(proxies[n]));
  const r = await coreRequest('GET', `/group/${enc(group)}/delay?${query}`);
  // 内核只返回测通的节点，全都不通时返回 504；没返回的都按超时记
  if (r.status !== 200 && r.status !== 504) throw new Error(`测速失败：${r.status} ${r.json && r.json.message}`);
  const got = r.status === 200 && r.json ? r.json : {};
  const results = names.map((n) => ({ name: n, delay: Number(got[n]) || 0 }));
  const timeouts = results.filter((x) => sampleBand({ delay: x.delay, unified }).timeout).length;
  const out = { ok: true, total: names.length, timeouts, recorded: false };
  if (!names.length || (names.length >= VOID_MIN && timeouts / names.length >= VOID_RATIO)) return out;

  const p = profileEntry(currentProfile());
  const at = new Date().toISOString();
  for (const { name, delay } of results) {
    const info = p.nodes[name] || (p.nodes[name] = { mark: null, firstSeen: at });
    info.samples = [...(info.samples || []), { at, delay, unified }].slice(-SAMPLE_KEEP);
  }
  saveMarks();
  return { ...out, recorded: true };
}

// ---------- 组装页面数据 ----------

async function buildState() {
  const [{ proxies }, configs] = await Promise.all([coreGet('/proxies'), coreGet('/configs')]);
  const profile = currentProfile();
  const mode = (configs.mode || 'rule').toLowerCase();

  // 分组顺序跟 Clash Verge 一样：按 GLOBAL.all 的顺序，隐藏的组不显示；全局模式只显示 GLOBAL
  const global = proxies.GLOBAL;
  let groupNames;
  if (mode === 'global') groupNames = ['GLOBAL'];
  else if (mode === 'direct') groupNames = [];
  else groupNames = (global ? global.all : Object.keys(proxies)).filter((n) => proxies[n] && proxies[n].all && n !== 'GLOBAL');

  const groups = groupNames
    .map((n) => proxies[n])
    .filter((g) => g && !g.hidden)
    .map((g) => ({ name: g.name, type: g.type, now: g.now || '', fixed: g.fixed || '', all: g.all || [] }));

  const realNames = new Set(Object.values(proxies).filter(isMarkable).map((p) => p.name));
  const synced = syncNodes(profile, realNames);

  const nodes = {};
  for (const name of new Set(groups.flatMap((g) => g.all))) {
    const p = proxies[name];
    if (!p) { nodes[name] = { type: '?', markable: false }; continue; }
    const h = p.history || [];
    nodes[name] = {
      type: p.type,
      udp: !!p.udp,
      markable: isMarkable(p),
      isGroup: GROUP_TYPES.has(p.type),
      delay: h.length ? h[h.length - 1].delay : null,   // null = 没测过，0 = 超时 / 失败
    };
  }

  const entry = marks.profiles[profile.uid];
  const nodeMarks = {};
  const ratings = {};
  if (entry) for (const [n, info] of Object.entries(entry.nodes)) {
    if (info.mark) nodeMarks[n] = info.mark;
    if (info.samples && info.samples.length) ratings[n] = rateNode(info.samples);
  }
  const bands = SCORE_BANDS[unifiedDelay(configs) ? 'on' : 'off'];

  return {
    demo: DEMO, profile, mode, groups, nodes,
    marks: nodeMarks,
    ratings,
    slowMs: bands[bands.length - 1][0],   // 当前档位下慢于多少算超时（页面上说明用）
    // 「按cv」排序用：每个组在 Clash Verge 里的排序方式，以及它判定超时的阈值
    cvSort: DEMO ? { '自动选择': 1, '流媒体': 2 } : cvSortTypes(profile.uid),
    cvTimeout: DEMO ? 10000 : vergeSettings().timeout,
    realCount: realNames.size,
    removedRecent: entry ? entry.removed.slice(-20).reverse() : [],
    syncing: !synced,
  };
}

function setMark(name, mark) {
  if (mark !== null && !MARKS.includes(mark)) throw new Error(`未知标记：${mark}`);
  const p = profileEntry(currentProfile());
  // 节点可能刚出现、还没等到清单稳定同步，先补进去
  if (!p.nodes[name]) p.nodes[name] = { mark: null, firstSeen: new Date().toISOString() };
  p.nodes[name].mark = mark;
  if (mark) p.nodes[name].markedAt = new Date().toISOString();
  else delete p.nodes[name].markedAt;
  saveMarks();
}

// 取消当前订阅下所有节点的标记，返回取消了几个
function clearMarks() {
  const p = profileEntry(currentProfile());
  let n = 0;
  for (const info of Object.values(p.nodes)) {
    if (!info.mark) continue;
    info.mark = null;
    delete info.markedAt;
    n++;
  }
  if (n) saveMarks();
  return n;
}

// ---------- HTTP 服务 ----------

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { buf += d; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// 自动退出：后台启动的服务在所有页面都关掉、过了 EXIT_GRACE_MS 还没有页面连回来时退出。
// 留一段宽限期，刷新页面时不会误退出；从来没有页面连上过就不退出（比如 --no-open 启动）。
const AUTO_EXIT = argv.includes('--auto-exit');
const EXIT_GRACE_MS = 15000;
let pages = 0;
let exitTimer = null;

// 服务的输出都带上本地时间：后台启动时它们追加进 nodemark.log，事后靠时间对上系统的睡眠、休眠记录
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const log = (...a) => console.log(stamp(), ...a);

function keepAlive(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  pages++;
  if (exitTimer) log(`页面连回来了，取消自动退出（当前 ${pages} 个页面）`);
  else log(`页面已连接（当前 ${pages} 个页面）`);
  clearTimeout(exitTimer);
  exitTimer = null;
  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(beat);
    pages--;
    log(`页面断开（当前 ${pages} 个页面）`);
    if (!AUTO_EXIT || pages > 0) return;
    log(`页面都断开了，${EXIT_GRACE_MS / 1000} 秒内没有页面连回来就自动退出`);
    exitTimer = setTimeout(() => {
      if (pages > 0) return;
      log('页面都关掉了，服务自动退出');
      process.exit(0);
    }, EXIT_GRACE_MS);
  });
}

// 记下服务是怎么退出的。taskkill /F、任务管理器结束进程这类强杀拦不住，日志里会只有前面的记录、没有「进程退出」这一行
function logLifecycle() {
  process.on('exit', (code) => log(`进程退出，退出码 ${code}`));
  process.on('uncaughtException', (e) => {
    log('未捕获的异常，服务退出：', e && e.stack || e);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    log('未处理的 Promise 拒绝，服务退出：', e && e.stack || e);
    process.exit(1);
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(sig, () => {
      log(`收到 ${sig}，服务退出`);
      process.exit(0);
    });
  }
  // 电脑睡眠、休眠时进程整个被挂起，醒来后计时器才接着走；按墙上时间的跳变认出来，方便和「页面断开」对上
  const TICK_MS = 30000;
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - last - TICK_MS;
    if (gap > 60000) log(`进程停了约 ${Math.round(gap / 60000)} 分钟，电脑可能睡眠或休眠过`);
    last = now;
  }, TICK_MS).unref();
}

// 跟随 Clash Verge：内核连上过之后，连续 FOLLOW_GRACE_MS 都连不上就退出。
// 看内核而不是看 Clash Verge 的进程名，各平台通用；宽限期留给切订阅、改设置时内核的重启。
// 从没连上过（比如先开了这个服务、还没开 Clash Verge）就一直等，不退出
const FOLLOW_CHECK_MS = 5000;
const FOLLOW_GRACE_MS = 30000;

function followCore() {
  let seen = false;
  let downSince = null;
  const check = async () => {
    let up;
    try { up = (await coreRequest('GET', '/version')).status < 500; } catch { up = false; }
    if (up) {
      if (!seen) log('已连上内核，Clash Verge 退出后服务会跟着退出');
      else if (downSince) log('内核连回来了');
      seen = true;
      downSince = null;
    } else if (seen) {
      if (!downSince) {
        downSince = Date.now();
        log(`内核连不上了，${FOLLOW_GRACE_MS / 1000} 秒内连不回来就退出`);
      } else if (Date.now() - downSince >= FOLLOW_GRACE_MS) {
        log('内核一直连不上，Clash Verge 应该已经退出，服务跟着退出');
        process.exit(0);
      }
    }
    setTimeout(check, FOLLOW_CHECK_MS);
  };
  check();
}

function serve() {
  logLifecycle();
  marks = loadMarks();
  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    // 只认本机地址；接口要求自定义请求头，别的网页跨域调不动（浏览器会先发预检，这里不应答）
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'forbidden host' });

    if (url.pathname === '/' && req.method === 'GET') {
      return send(res, 200, fs.readFileSync(PAGE_FILE, 'utf8'), 'text/html; charset=utf-8');
    }
    // 页面用 EventSource 连着这里（EventSource 带不了自定义请求头，所以放在请求头检查前面；它只回心跳，不做任何操作）
    if (url.pathname === '/api/alive' && req.method === 'GET') return keepAlive(req, res);
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.headers['x-node-marks'] !== '1') return send(res, 403, { error: 'missing header' });

    try {
      if (url.pathname === '/api/ping') return send(res, 200, { app: APP, version: VERSION, pid: process.pid });
      if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, await buildState());
      if (url.pathname === '/api/mark' && req.method === 'POST') {
        const { name, mark } = await readBody(req);
        setMark(String(name), mark || null);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/clear-marks' && req.method === 'POST') {
        return send(res, 200, { ok: true, cleared: clearMarks() });
      }
      if (url.pathname === '/api/select' && req.method === 'POST') {
        const { group, name } = await readBody(req);
        const r = await coreRequest('PUT', `/proxies/${enc(group)}`, { name });
        if (r.status >= 300) throw new Error(`切换失败：${r.json && r.json.message}`);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/delay' && req.method === 'POST') {
        const { name, group, record } = await readBody(req);
        const { testUrl, timeout } = vergeSettings();
        const q = `url=${enc(testUrl)}&timeout=${timeout}`;
        if (group && record) return send(res, 200, await systemGroupTest(String(group), q));
        // 测全组用 /group/<组>/delay，测单个用 /proxies/<节点>/delay；结果都写进内核的延迟历史
        const r = group
          ? await coreRequest('GET', `/group/${enc(group)}/delay?${q}`)
          : await coreRequest('GET', `/proxies/${enc(name)}/delay?${q}`);
        return send(res, 200, { ok: r.status === 200, delay: r.json && r.json.delay, message: r.json && r.json.message });
      }
      if (url.pathname === '/api/shutdown' && req.method === 'POST') {
        log('收到停止请求（node nodemark.js stop），服务退出');
        send(res, 200, { ok: true });
        return setTimeout(() => process.exit(0), 100);
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log(`${url.pathname} 出错：${e.message}`);
      return send(res, 502, { error: e.message });
    }
  });

  server.on('error', (e) => {
    log(e.code === 'EADDRINUSE' ? `端口 ${PORT} 被占用，换一个：--port <端口>` : e.message);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    log(`===== ${APP} ${VERSION}${DEMO ? '（演示模式）' : ''} 启动，pid ${process.pid}`);
    log(`页面：http://127.0.0.1:${PORT}`);
    log(AUTO_EXIT ? `所有页面关掉 ${EXIT_GRACE_MS / 1000} 秒后自动退出` : '不自动退出，用 node nodemark.js stop 停止');
    if (DEMO) return log('演示模式用的是假数据，不连内核，标记只存在内存里，停掉服务就没了');
    let how;
    try { how = resolveCore().label; } catch (e) { how = `（暂时连不上：${e.message}）`; }
    log(`内核：${how}`);
    log(`标记文件：${MARKS_FILE}`);
    if (NO_FOLLOW) log('不跟随 Clash Verge 退出（--no-follow）');
    else followCore();
  });
}

// ---------- 启动器：后台启动 / 打开浏览器 / 停止 ----------

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', headers: { 'X-Node-Marks': '1' }, timeout: 1500 }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { const j = JSON.parse(buf); resolve(j.app === APP ? 'ours' : 'other'); } catch { resolve('other'); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const p = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true });
    p.on('error', () => console.log(`打不开浏览器，请手动访问 ${url}`));
    p.unref();
  } catch {
    console.log(`打不开浏览器，请手动访问 ${url}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openCommand() {
  const url = `http://127.0.0.1:${PORT}`;
  let state = await ping();
  if (state === 'other') {
    console.error(`端口 ${PORT} 被别的程序占用了，换一个：node nodemark.js --port <端口>`);
    process.exit(1);
  }
  if (state === 'free') {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 追加写入，上一次服务的记录（包括它是怎么退出的）留着；太大了就换一个新文件，旧的只留一份
    const logFile = DEMO ? LOG_FILE.replace(/\.log$/, '-demo.log') : LOG_FILE;
    try {
      if (fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, logFile.replace(/\.log$/, '.old.log'));
    } catch {}
    const logFd = fs.openSync(logFile, 'a');
    const extra = [...(DEMO ? ['--demo'] : []), ...(NO_OPEN || KEEP ? [] : ['--auto-exit']), ...(NO_FOLLOW ? ['--no-follow'] : [])];
    const child = spawn(process.execPath, [__filename, 'serve', '--port', String(PORT), ...extra], {
      detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
    });
    child.unref();
    for (let i = 0; i < 40 && state !== 'ours'; i++) { await sleep(150); state = await ping(); }
    if (state !== 'ours') {
      console.error(`服务没能启动，日志：${LOG_FILE}`);
      process.exit(1);
    }
    console.log(`已在后台启动：${url}${NO_OPEN || KEEP ? '' : '（关掉页面后会自动退出）'}`);
  } else {
    console.log(`服务已在运行：${url}`);
  }
  if (NO_OPEN) return;
  // 先倒数几秒再打开，免得一回车就被切到浏览器、来不及看终端输出
  process.once('SIGINT', () => {
    console.log(`\n已取消打开浏览器。服务还在后台运行，可以手动访问 ${url}，或用 node nodemark.js stop 停掉`);
    process.exit(0);
  });
  for (let s = OPEN_DELAY_S; s > 0; s--) {
    const line = `${s} 秒后自动打开浏览器（按 Ctrl+C 取消）`;
    if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${line}`); else if (s === OPEN_DELAY_S) console.log(line);
    await sleep(1000);
  }
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K正在打开浏览器……\n');
  openBrowser(url);
}

async function stopCommand() {
  if ((await ping()) !== 'ours') return console.log(`端口 ${PORT} 上没有在运行的 ${APP}`);
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/shutdown', method: 'POST', headers: { 'X-Node-Marks': '1' } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end();
  });
  for (let i = 0; i < 20 && (await ping()) === 'ours'; i++) await sleep(100);
  console.log('已停止');
}

if (command === 'serve') serve();
else if (command === 'stop') stopCommand();
else if (command === 'open') openCommand();
else {
  console.log('用法：node nodemark.js [serve | stop] [--port 端口] [--no-open] [--keep] [--no-follow] [--demo]');
  process.exit(1);
}
