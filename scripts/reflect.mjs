#!/usr/bin/env node
/**
 * dsh-error-self-reflection :: reflect.mjs
 * 变更账本 + 状态快照 + 事故自动归档 + 复发计数 + lessons 草稿生成。
 *
 * 子命令：
 *   snapshot --tag <name> [--note "..."]        拍一份状态快照（baseline）
 *   diff --from <tag> [--to <tag>] [--scope ids]  对比快照，写出变更账本；越界改动报警
 *   journal [--limit N]                          查看变更账本
 *   record                                       运行 check 并把问题写入 incidents.jsonl
 *   incidents [--min N]                          查看事故复发计数
 *   confirm <fingerprint> [--note "..."]          人工确认某类事故是真问题
 *   promote [--min 2]                            对复发/已确认的模式生成 lessons.md 草稿
 *   status                                       总览
 *
 * 退出码：0 正常；1 发现阻断问题（越界改动 / 复发未处理）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const AGENTS_HOME = process.env.DSH_AGENTS_HOME || path.join(HOME, '.agents');

// ── 数据存放位置 ────────────────────────────────────────────────────────────
//
// 目标：同一台机器上跨项目、跨技能副本共享一份历史，而不是每装一份技能就丢一次账本。
//
// 解析顺序（先命中者生效）：
//   1. $DSH_ERROR_SELF_REFLECTION_DATA   —— 显式指定，便于测试或在便携盘上使用
//   2. $DSH_HOME/error-self-reflection   —— 默认落点（与 DSH 家目录同处，整机共享）
//   3. <skill>/data                      —— 兼容旧版：若已存在旧数据则继续用它，不迁移
//
// 第 3 条是刻意的兼容策略：老用户的账本留在原地继续可读，不会被静默搬走或丢弃。
// 迁移请显式执行 `reflect.mjs migrate-data`。
const LEGACY_DATA = path.join(HERE, '..', 'data');

function resolveDataDir() {
  const override = process.env.DSH_ERROR_SELF_REFLECTION_DATA;
  if (override) return { dir: path.resolve(override), source: 'DSH_ERROR_SELF_REFLECTION_DATA' };

  const shared = path.join(DSH_HOME, 'error-self-reflection');
  // 旧的技能内 data/ 若已有内容，优先沿用（避免老账本"消失"）
  if (fs.existsSync(LEGACY_DATA) && hasAnyData(LEGACY_DATA) && !hasAnyData(shared)) {
    return { dir: LEGACY_DATA, source: 'legacy-skill-data' };
  }
  return { dir: shared, source: 'dsh-home' };
}

function hasAnyData(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    if (fs.existsSync(path.join(dir, 'journal.jsonl'))) {
      const st = fs.statSync(path.join(dir, 'journal.jsonl'));
      if (st.size > 0) return true;
    }
    if (fs.existsSync(path.join(dir, 'incidents.jsonl'))) {
      const st = fs.statSync(path.join(dir, 'incidents.jsonl'));
      if (st.size > 0) return true;
    }
    const snap = path.join(dir, 'snapshots');
    if (fs.existsSync(snap) && fs.readdirSync(snap).some((f) => f.endsWith('.json'))) return true;
  } catch { /* unreadable counts as no data */ }
  return false;
}

const RESOLVED = resolveDataDir();
const DATA = RESOLVED.dir;
const DATA_SOURCE = RESOLVED.source;
const SNAPDIR = path.join(DATA, 'snapshots');
const JOURNAL = path.join(DATA, 'journal.jsonl');
const INCIDENTS = path.join(DATA, 'incidents.jsonl');

// 快照格式版本：结构变化时必须 +1，否则旧快照缺少字段会让 diff 产生"全部新增"的假噪音。
// v2: rows 带 config/deltas，skills 带 sha256
const SCHEMA = 2;

// 写文件一律无 BOM
function writeText(p, t) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t, { encoding: 'utf8' }); }
function appendJsonl(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8'); }
function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}
function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch { return null; }
}
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
function opt(n, d) {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
}

// 载入 YAML 解析器。DSH profile 的 node_modules 里通常带 js-yaml 或 yaml，
// 但我们不假设某个具体 profile 名——遍历所有 profile 找，再退回默认 ~/.dsh 与 skill 自身。
// 说明：找不到时返回 null，调用方必须据此降级（rows=null），不能假装解析成功。
function loadYaml() {
  const bases = [];
  const addProfiles = (homeRoot) => {
    const pd = path.join(homeRoot, 'profiles');
    if (!fs.existsSync(pd)) return;
    for (const e of fs.readdirSync(pd, { withFileTypes: true })) {
      if (e.isDirectory()) bases.push(path.join(pd, e.name));
    }
  };
  addProfiles(DSH_HOME);
  const defaultHome = path.join(HOME, '.dsh');
  if (defaultHome !== DSH_HOME) addProfiles(defaultHome);
  bases.push(HERE, path.join(HERE, '..'));
  for (const base of bases) {
    for (const mod of ['js-yaml', 'yaml']) {
      try {
        const req = createRequire(path.join(base, '__probe.js'));
        const y = req(mod);
        return mod === 'yaml' ? { parse: (t) => y.parse(t) } : { parse: (t) => y.load(t) };
      } catch { /* next */ }
    }
  }
  return null;
}

/* ───────────────── 快照 ───────────────── */

// 只收"配置面"文件，排除 node_modules 与备份，避免快照巨大
const IGNORE_DIRS = new Set(['node_modules', '.git', '.cache', '.pnpm']);

function walkFiles(root, maxDepth = 3, depth = 0) {
  if (!fs.existsSync(root) || depth > maxDepth) return [];
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full, maxDepth, depth + 1));
    else if (e.isFile()) {
      // 跳过自建的备份文件，它们不参与"当前状态"
      if (/\.bak[-.]/.test(e.name) || /\.bak$/.test(e.name)) continue;
      out.push(full);
    }
  }
  return out;
}

/** 解析 profile 的 cordis.patch.yml，返回 [{id, hasInsert, config, disabled}] */
function profileRows(patchPath) {
  const Y = loadYaml();
  if (!Y || !fs.existsSync(patchPath)) return null;
  try {
    const raw = fs.readFileSync(patchPath, 'utf8').replace(/^\uFEFF/, '');
    const doc = Y.parse(raw);
    if (!Array.isArray(doc)) return null;
    return doc.filter((e) => e && typeof e === 'object').map((e) => ({
      id: typeof e.id === 'string' ? e.id : null,
      hasInsert: Array.isArray(e.insert),
      config: e.config ?? null,
      disabled: e.disabled ?? null,
      name: e.name ?? null,
    }));
  } catch { return null; }
}

function takeSnapshot(tag, note) {
  const snap = {
    schema: SCHEMA,
    tag,
    note: note || '',
    at: new Date().toISOString(),
    host: os.hostname(),
    profiles: {},
    skills: {},
  };

  const pd = path.join(DSH_HOME, 'profiles');
  if (fs.existsSync(pd)) {
    for (const e of fs.readdirSync(pd, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(pd, e.name);
      const files = {};
      for (const f of walkFiles(dir)) {
        const rel = path.relative(dir, f).replace(/\\/g, '/');
        files[rel] = { sha256: sha256(f), size: fs.statSync(f).size };
      }
      snap.profiles[e.name] = {
        files,
        rows: profileRows(path.join(dir, 'cordis.patch.yml')),
        bundles: (() => {
          try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.dsh?.profile?.bundles ?? []; }
          catch { return []; }
        })(),
        deps: (() => {
          try { return Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.dependencies ?? {}); }
          catch { return []; }
        })(),
      };
    }
  }

  for (const [label, root] of [['user-agents', path.join(AGENTS_HOME, 'skills')], ['user-dsh', path.join(DSH_HOME, 'skills')]]) {
    if (!fs.existsSync(root)) { snap.skills[label] = {}; continue; }
    const map = {};
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const md = e.isDirectory() ? path.join(root, e.name, 'SKILL.md') : (e.name.endsWith('.md') ? path.join(root, e.name) : null);
      if (!md || !fs.existsSync(md)) continue;
      const t = fs.readFileSync(md, 'utf8').replace(/^\uFEFF/, '');
      const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      map[e.name] = {
        path: path.relative(path.join(HOME, '..'), md).replace(/\\/g, '/'),
        sha256: sha256(md),
        name: m ? (m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null) : null,
      };
    }
    snap.skills[label] = map;
  }

  const file = path.join(SNAPDIR, `${tag}.json`);
  writeText(file, JSON.stringify(snap, null, 2));
  return { file, snap };
}

function latestSnapshot(excludeTags = []) {
  if (!fs.existsSync(SNAPDIR)) return null;
  const files = fs.readdirSync(SNAPDIR).filter((f) => f.endsWith('.json') && !excludeTags.includes(f.replace('.json', '')));
  if (files.length === 0) return null;
  const withTime = files.map((f) => ({ f, t: fs.statSync(path.join(SNAPDIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  const p = path.join(SNAPDIR, withTime[0].f);
  try { return { file: p, snap: JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch { return null; }
}

/* ───────────────── diff ───────────────── */

// 这些是"全局配置"，改动会影响所有会话；装插件时不该动
/**
 * 默认视为"全局配置"的条目 id：改动它们会影响所有会话，安装类任务里通常不该碰。
 * 不同环境下条目名可能不同——用 `--global-ids "a,b"` 追加，或 `--global-ids ""` 清空。
 */
const GLOBAL_ENTRY_IDS = new Set([
  'agent-default-model', 'permission', 'im-qqbot', 'session-log-deepseek',
  'agent-preset-registry', 'ui-chat', 'ui-settings', 'ui-settings-account',
]);

/** 依据 --global-ids 展开实际的全局条目集合 */
function globalIdSet() {
  const raw = opt('--global-ids', null);
  if (raw === null) return new Set(GLOBAL_ENTRY_IDS);
  const extra = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const base = flag('--reset-global-ids') ? [] : [...GLOBAL_ENTRY_IDS];
  return new Set([...base, ...extra]);
}

/** 把一个对象的叶子路径展开成扁平 map，用于精确定位"改了哪个字段" */
function flatten(obj, prefix = '', out = {}) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    out[prefix || '(root)'] = obj;
    return out;
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) out[prefix || '(root)'] = '{}';
  for (const k of keys) flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/** 对比两份 config，返回字段级差异 */
function configDeltas(from, to) {
  const a = flatten(from ?? {});
  const b = flatten(to ?? {});
  const deltas = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    if (x === undefined) deltas.push({ path: k, kind: 'added', to: y });
    else if (y === undefined) deltas.push({ path: k, kind: 'removed', from: x });
    else deltas.push({ path: k, kind: 'changed', from: x, to: y });
  }
  return deltas;
}

function diffSnapshots(a, b) {
  const changes = { files: [], rows: [], bundles: [], deps: [], skills: [] };

  // 文件级
  const allProfiles = new Set([...Object.keys(a.profiles), ...Object.keys(b.profiles)]);
  for (const pn of allProfiles) {
    const ap = a.profiles[pn], bp = b.profiles[pn];
    if (!ap && bp) { changes.files.push({ profile: pn, kind: 'profile-added' }); continue; }
    if (ap && !bp) { changes.files.push({ profile: pn, kind: 'profile-removed' }); continue; }
    const af = ap.files || {}, bf = bp.files || {};
    for (const f of new Set([...Object.keys(af), ...Object.keys(bf)])) {
      const x = af[f], y = bf[f];
      if (!x && y) changes.files.push({ profile: pn, file: f, kind: 'added', sha256: y.sha256 });
      else if (x && !y) changes.files.push({ profile: pn, file: f, kind: 'removed' });
      else if (x.sha256 !== y.sha256) changes.files.push({ profile: pn, file: f, kind: 'modified', from: x.sha256, to: y.sha256 });
    }

    // 配置行级
    const ar = ap.rows || [], br = bp.rows || [];
    const keyOf = (r) => `${r.hasInsert ? 'insert' : 'row'}:${r.id ?? JSON.stringify(r.config)?.slice(0, 40)}`;
    const am = new Map(ar.map((r) => [keyOf(r), r]));
    const bm = new Map(br.map((r) => [keyOf(r), r]));
    for (const k of new Set([...am.keys(), ...bm.keys()])) {
      const x = am.get(k), y = bm.get(k);
      if (!x && y) changes.rows.push({ kind: 'added', id: y.id, hasInsert: y.hasInsert });
      else if (x && !y) changes.rows.push({ kind: 'removed', id: x.id, hasInsert: x.hasInsert });
      else if (JSON.stringify(x) !== JSON.stringify(y)) {
        changes.rows.push({
          kind: 'modified', id: y.id ?? x.id, hasInsert: y.hasInsert,
          from: x.config, to: y.config,
          deltas: configDeltas(x.config, y.config),
          disabled: { from: x.disabled ?? null, to: y.disabled ?? null },
        });
      }
    }

    // bundles / deps
    const ab = new Set(ap.bundles || []), bb = new Set(bp.bundles || []);
    for (const x of bb) if (!ab.has(x)) changes.bundles.push({ profile: pn, kind: 'added', name: x });
    for (const x of ab) if (!bb.has(x)) changes.bundles.push({ profile: pn, kind: 'removed', name: x });
    const ad = new Set(ap.deps || []), bd = new Set(bp.deps || []);
    for (const x of bd) if (!ad.has(x)) changes.deps.push({ profile: pn, kind: 'added', name: x });
    for (const x of ad) if (!bd.has(x)) changes.deps.push({ profile: pn, kind: 'removed', name: x });
  }

  // skill 级
  for (const label of new Set([...Object.keys(a.skills), ...Object.keys(b.skills)])) {
    const as = a.skills[label] || {}, bs = b.skills[label] || {};
    for (const k of new Set([...Object.keys(as), ...Object.keys(bs)])) {
      const x = as[k], y = bs[k];
      if (!x && y) changes.skills.push({ root: label, name: k, kind: 'added' });
      else if (x && !y) changes.skills.push({ root: label, name: k, kind: 'removed' });
      else if (x.sha256 !== y.sha256) changes.skills.push({ root: label, name: k, kind: 'modified' });
    }
  }
  return changes;
}

/* ───────────────── 事故指纹与归档 ───────────────── */

/** 归一化：把具体包名/路径/数字/引号内容抹掉，只留"问题类别"，让同类问题能聚合 */
function fingerprint(level, message) {
  let norm = message
    .replace(/[A-Za-z]:\\[^\s)，,]*/g, '<path>')
    .replace(/[A-Za-z0-9_.-]+@[A-Za-z0-9_.^~-]+/g, '<pkg@ver>')
    .replace(/[@][A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+/g, '<scoped-pkg>')
    .replace(/\b[A-Za-z0-9_-]+\/dsh-[A-Za-z0-9_.-]+/g, '<bundle>')
    .replace(/"[^"]{1,120}"/g, '"<x>"')
    .replace(/[“”][^“”]{1,120}[“”]/g, '"<x>"')
    .replace(/'[^']{1,120}'/g, "'<x>'")
    .replace(/\b\d+(\.\d+)*\b/g, '<n>')
    .replace(/[（(][^）)]{1,200}[）)]/g, '(<detail>)')
    .replace(/\s+/g, ' ')
    .trim();

  // 再压成"类别骨架"：只保留中文语义词与关键英文标识
  // 例："2 个第三方 peer 未在本地解析：cc-safety-net -> @opencode-ai/plugin"
  //   -> "peer-miss"
  // 例："hyperframes-cli: description 过短，影响被发现"
  //   -> "skill-desc-short"
  const CATEGORIES = [
    [/peer.*(未在本地解析|未解析|miss)/i, 'peer-miss'],
    [/description.*(过短|short)/i, 'skill-desc-short'],
    [/文件带.*BOM/i, 'bom'],
    [/name.*(与目录名不一致|mismatch)/i, 'skill-name-mismatch'],
    [/粘贴残留|HTML 片段|HTML 实体/i, 'pasted-residue'],
    [/编码损坏|U\+FFFD/i, 'encoding-broken'],
    [/依赖未安装|dependency.*missing/i, 'dep-missing'],
    [/bundle.*不在 node_modules/i, 'bundle-missing'],
    [/YAML.*解析失败|parse.*fail/i, 'yaml-parse-fail'],
    [/孤儿|越界|out-of-scope/i, 'scope-violation'],
    [/覆盖|override/i, 'override-conflict'],
  ];
  let category = null;
  for (const [re, name] of CATEGORIES) {
    if (re.test(message)) { category = name; break; }
  }
  const kind = category ? `${level}:${category}` : `${level}:${norm.slice(0, 100)}`;
  return {
    fp: crypto.createHash('sha256').update(kind).digest('hex').slice(0, 16),
    kind,
    category: category || 'uncategorized',
    sample: message.slice(0, 150),
  };
}

/* ───────────────── 命令 ───────────────── */

if (cmd === 'snapshot') {
  const tag = opt('--tag') || `snap-${Date.now()}`;
  const note = opt('--note', '');
  const { file } = takeSnapshot(tag, note);
  console.log(`快照已写入: ${file}`);
  console.log(`tag = ${tag}${note ? `  note = ${note}` : ''}`);
  console.log(`\n下一步：改完再拍一份，然后 diff`);
  console.log(`  node "${path.join(HERE, 'reflect.mjs')}" snapshot --tag post --note "改完之后"`);
  console.log(`  node "${path.join(HERE, 'reflect.mjs')}" diff --from ${tag}`);
  process.exit(0);
}

if (cmd === 'diff') {
  const fromTag = opt('--from');
  if (!fromTag) { console.error('需要 --from <tag>'); process.exit(2); }
  const aFile = path.join(SNAPDIR, `${fromTag}.json`);
  if (!fs.existsSync(aFile)) { console.error(`找不到快照: ${fromTag}`); process.exit(2); }
  const a = JSON.parse(fs.readFileSync(aFile, 'utf8'));
  // 旧快照缺少 rows 等字段会让 diff 报"全部新增"，直接拒绝并提示重拍
  if (a.schema !== SCHEMA) {
    console.error(`快照 "${fromTag}" 的格式版本是 ${a.schema ?? '未知'}，当前需要 ${SCHEMA}。`);
    console.error(`旧快照缺少字段会导致 diff 产生假的"全部新增"噪音。请重新拍摄基线：`);
    console.error(`  node reflect.mjs snapshot --tag <新tag> --note "重新基线"`);
    process.exit(2);
  }
  const toTag = opt('--to');
  let b, bTag;
  if (toTag) {
    const bFile = path.join(SNAPDIR, `${toTag}.json`);
    if (!fs.existsSync(bFile)) { console.error(`找不到快照: ${toTag}`); process.exit(2); }
    b = JSON.parse(fs.readFileSync(bFile, 'utf8')); bTag = toTag;
  } else {
    const cur = takeSnapshot(`auto-${Date.now()}`, 'diff 时自动拍摄');
    b = cur.snap; bTag = b.tag;
  }

  const ch = diffSnapshots(a, b);
  const scopeIds = (opt('--scope', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const globals = globalIdSet();

  console.log('\n================ 变更账本 ================\n');
  console.log(`from: ${a.tag} (${a.at})`);
  console.log(`to  : ${bTag} (${b.at})\n`);

  const sections = [
    ['文件', ch.files.map((c) => `${c.profile}/${c.file ?? ''} ${c.kind}`)],
    ['配置行', ch.rows.flatMap((c) => {
      const head = `[${c.hasInsert ? 'insert' : 'override'}] ${c.id ?? '(无名)'} ${c.kind}`;
      const lines = [head];
      // 字段级差异：这是"到底改了什么"的关键
      for (const d of (c.deltas || [])) {
        if (d.kind === 'changed') lines.push(`    · ${d.path}: ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}`);
        else if (d.kind === 'added') lines.push(`    · ${d.path}: (新增) ${JSON.stringify(d.to)}`);
        else if (d.kind === 'removed') lines.push(`    · ${d.path}: ${JSON.stringify(d.from)} (删除)`);
      }
      if (c.disabled && (c.disabled.from !== c.disabled.to)) {
        lines.push(`    · disabled: ${JSON.stringify(c.disabled.from)} -> ${JSON.stringify(c.disabled.to)}`);
      }
      return lines;
    })],
    ['bundles', ch.bundles.map((c) => `${c.profile} ${c.kind} ${c.name}`)],
    ['依赖', ch.deps.map((c) => `${c.profile} ${c.kind} ${c.name}`)],
    ['skills', ch.skills.map((c) => `${c.root}/${c.name} ${c.kind}`)],
  ];
  let total = 0;
  for (const [label, lines] of sections) {
    if (!lines.length) continue;
    console.log(`── ${label} ──`);
    for (const l of lines) {
      if (l.startsWith('    ·')) { console.log(`  ${l}`); } else { console.log(`  ${l}`); total++; }
    }
    console.log('');
  }
  if (total === 0) console.log('（无变化）\n');

  // 越界检测：改了全局配置行（含"改字段"与"新增行"两种情况）
  const violations = [];
  for (const c of ch.rows) {
    if (!c.id) continue;
    if (globals.has(c.id) && !(scopeIds.includes(c.id))) {
      const what = c.deltas?.length
        ? c.deltas.map((d) => `${d.path}: ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}`).join('; ')
        : `${c.kind}`;
      violations.push({
        level: 'ERROR',
        message: `改动了全局配置行 "${c.id}"（${what}），但它不在本次声明的范围内`,
        detail: '装插件不该改全局默认模型/权限等配置，这会影响所有会话；确认有意后用 --scope 声明，否则回滚',
      });
    }
  }

  // 特殊：provider/model 变更单独强调（这是最容易造成"对话失败"的改动）
  for (const c of ch.rows) {
    for (const d of (c.deltas || [])) {
      if (/\.(provider|model)$/.test(d.path) && d.kind === 'changed') {
        console.log(`⚠️  模型路由被改动：${c.id} 的 ${d.path} ${JSON.stringify(d.from)} -> ${JSON.stringify(d.to)}`);
        console.log(`    ↳ provider/model 变更会影响会话能否正常发起请求，务必确认\n`);
      }
    }
  }
  // 声明了 scope 却没动它 → 也值得提示
  const touchedIds = new Set(ch.rows.map((c) => c.id).filter(Boolean));
  for (const s of scopeIds) {
    if (!touchedIds.has(s)) {
      violations.push({ level: 'WARN', message: `声明范围里的 "${s}" 实际没被改动`, detail: '检查是否漏改或改错文件' });
    }
  }

  if (violations.length) {
    console.log('── ⚠ 越界/异常 ──');
    for (const v of violations) console.log(`  ${v.level === 'ERROR' ? '❌' : '⚠️ '} ${v.message}\n      ↳ ${v.detail}`);
    console.log('');
  }

  // 写账本
  const rec = {
    at: new Date().toISOString(),
    from: a.tag, to: bTag,
    scope: scopeIds,
    changes: ch,
    violations,
    note: opt('--note', ''),
  };
  appendJsonl(JOURNAL, rec);
  console.log(`已写入变更账本: ${JOURNAL}`);
  console.log(`结论：${violations.some((v) => v.level === 'ERROR') ? '存在越界改动，必须解释或回滚' : '未见越界改动'}`);
  process.exit(violations.some((v) => v.level === 'ERROR') ? 1 : 0);
}

if (cmd === 'journal') {
  const limit = Number(opt('--limit', '20'));
  const recs = readJsonl(JOURNAL).slice(-limit);
  if (!recs.length) { console.log('账本为空。'); process.exit(0); }
  for (const r of recs) {
    const n = Object.values(r.changes || {}).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
    console.log(`\n[${r.at}] ${r.from} -> ${r.to}  变更 ${n} 项${r.scope?.length ? ` scope=${r.scope.join(',')}` : ''}`);
    if (r.note) console.log(`  note: ${r.note}`);
    for (const v of (r.violations || [])) console.log(`  ${v.level}: ${v.message}`);
  }
  process.exit(0);
}

if (cmd === 'record') {
  // 跑 check，把 ERROR/WARN 归档
  const vs = path.join(HERE, 'check.mjs');
  const r = spawnSync(process.execPath, [vs, '--all', '--skills'], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const found = out.split('\n').filter((l) => /^❌|^⚠️/.test(l.trim()));
  let added = 0;
  for (const line of found) {
    const level = line.includes('❌') ? 'ERROR' : 'WARN';
    const msg = line.replace(/^[^❌⚠]*/, '').replace(/^❌\s*|^⚠️\s*/, '').trim();
    if (!msg) continue;
    const { fp, kind, category, sample } = fingerprint(level, msg);
    appendJsonl(INCIDENTS, { at: new Date().toISOString(), level, message: msg, fp, kind, category, sample });
    added++;
  }
  console.log(`已归档 ${added} 条问题到 ${INCIDENTS}`);
  console.log(`查看复发: node "${path.join(HERE, 'reflect.mjs')}" incidents`);
  process.exit(0);
}

if (cmd === 'incidents') {
  const min = Number(opt('--min', '1'));
  const all = readJsonl(INCIDENTS);
  if (!all.length) { console.log('还没有归档的事故。先跑 record。'); process.exit(0); }
  const groups = new Map();
  for (const it of all) {
    const g = groups.get(it.fp) || { fp: it.fp, level: it.level, kind: it.kind, message: it.message, count: 0, first: it.at, last: it.at, confirmed: false, note: '' };
    g.count++; g.last = it.at;
    if (it.confirmed) { g.confirmed = true; g.note = it.note || g.note; }
    groups.set(it.fp, g);
  }
  const rows = [...groups.values()].filter((g) => g.count >= min).sort((a, b) => b.count - a.count);
  console.log('\n================ 事故复发计数 ================\n');
  for (const g of rows) {
    const mark = g.confirmed ? '✅已确认' : (g.count >= 2 ? '🔁复发' : '  ');
    console.log(`${mark} [${g.fp}] x${g.count}  ${g.level}`);
    console.log(`     ${g.message.slice(0, 110)}`);
    console.log(`     first=${g.first} last=${g.last}${g.note ? `  note=${g.note}` : ''}`);
  }
  console.log(`\n共 ${rows.length} 类（阈值 ${min}）`);
  console.log(`\n下一步：确认是真问题 → node "${path.join(HERE, 'reflect.mjs')}" confirm <fp> --note "原因"`);
  console.log(`然后生成 lessons 草稿 → node "${path.join(HERE, 'reflect.mjs')}" promote`);
  process.exit(0);
}

if (cmd === 'confirm') {
  const fp = args[1];
  if (!fp) { console.error('用法: confirm <fingerprint> [--note "..."]'); process.exit(2); }
  const note = opt('--note', '');
  const all = readJsonl(INCIDENTS);
  const hit = all.find((x) => x.fp === fp);
  if (!hit) { console.error(`没有这个指纹: ${fp}`); process.exit(2); }
  appendJsonl(INCIDENTS, { at: new Date().toISOString(), level: hit.level, message: hit.message, fp, kind: hit.kind, confirmed: true, note });
  console.log(`已确认 ${fp}${note ? `：${note}` : ''}`);
  process.exit(0);
}

if (cmd === 'promote') {
  const min = Number(opt('--min', '2'));
  const all = readJsonl(INCIDENTS);
  const groups = new Map();
  for (const it of all) {
    const g = groups.get(it.fp) || { fp: it.fp, level: it.level, message: it.message, count: 0, confirmed: false, note: '' };
    g.count++;
    if (it.confirmed) { g.confirmed = true; g.note = it.note || g.note; }
    groups.set(it.fp, g);
  }
  const eligible = [...groups.values()].filter((g) => g.confirmed || g.count >= min);
  if (!eligible.length) {
    console.log(`没有达到阈值（复发 >= ${min} 次，或被 confirm）的模式。`);
    console.log('继续用 record 归档，事件成熟后再 promote。');
    process.exit(0);
  }
  const lessonsPath = path.join(HERE, '..', 'references', 'lessons.md');
  const exist = fs.existsSync(lessonsPath) ? fs.readFileSync(lessonsPath, 'utf8') : '';
  let n = (exist.match(/^## \d+\..*$/gm) || []).length;
  console.log('\n================ lessons.md 草稿 ================\n');
  console.log('把下面的块追加到 references/lessons.md，并补全"真实原因"（这是唯一必须人来判断的部分）：\n');
  for (const g of eligible) {
    n++;
    console.log(`## ${n}. ${g.message.slice(0, 60)}`);
    console.log(`- **现象**：${g.message}`);
    console.log(`- **复发次数**：${g.count} 次（指纹 ${g.fp}）${g.confirmed ? '，已人工确认' : ''}`);
    console.log(`- **我当时的错误判断**：（待补）`);
    console.log(`- **真正原因**：${g.note || '（待补——工具无法推断根因）'}`);
    console.log(`- **固化成的规则**：（待补一条可执行的检查）`);
    console.log('');
  }
  console.log(`共 ${eligible.length} 条待并入。`);
  process.exit(0);
}

if (cmd === 'status' || !cmd) {
  const j = readJsonl(JOURNAL);
  const inc = readJsonl(INCIDENTS);
  const groups = new Map();
  for (const it of inc) {
    const g = groups.get(it.fp) || { count: 0, confirmed: false };
    g.count++; if (it.confirmed) g.confirmed = true;
    groups.set(it.fp, g);
  }
  const snaps = fs.existsSync(SNAPDIR) ? fs.readdirSync(SNAPDIR).filter((f) => f.endsWith('.json')).length : 0;
  console.log('\n================ dsh-error-self-reflection status ================\n');
  console.log(`数据目录: ${DATA}`);
  console.log(`来源:     ${DATA_SOURCE}`);
  if (DATA_SOURCE === 'legacy-skill-data') {
    console.log('          （仍在使用技能内的旧 data/；运行 migrate-data 可迁到共享位置）');
  }
  console.log('');
  console.log(`快照:     ${snaps} 份       ${SNAPDIR}`);
  console.log(`变更账本: ${j.length} 条       ${JOURNAL}`);
  console.log(`事故归档: ${inc.length} 条 / ${groups.size} 类   ${INCIDENTS}`);
  const pending = [...groups.entries()].filter(([, g]) => g.count >= 2 || g.confirmed);
  console.log(`待沉淀:   ${pending.length} 类达到 promote 阈值`);
  console.log('\n推荐循环：');
  console.log('  1) snapshot --tag pre --note "要做的事"');
  console.log('  2) 改动');
  console.log('  3) snapshot --tag post');
  console.log('  4) diff --from pre --scope <预期会动的id>');
  console.log('  5) record            （把 check 发现的问题归档）');
  console.log('  6) incidents         （看复发）');
  console.log('  7) confirm / promote （沉淀成 lessons）');
  console.log('');
  process.exit(0);
}

if (cmd === 'migrate-data') {
  // 把技能内旧 data/ 迁到共享位置。默认只预览，--yes 才动文件。
  const target = path.join(DSH_HOME, 'error-self-reflection');
  console.log('\n================ 数据迁移 ================\n');
  console.log(`从: ${LEGACY_DATA}`);
  console.log(`到: ${target}`);

  if (!fs.existsSync(LEGACY_DATA) || !hasAnyData(LEGACY_DATA)) {
    console.log('\n旧 data/ 不存在或为空，无需迁移。');
    console.log(`当前实际使用: ${DATA}（来源 ${DATA_SOURCE}）`);
    process.exit(0);
  }
  if (target === LEGACY_DATA) {
    console.log('\n源与目标相同，无需迁移。（若设置了 DSH_HOME，请确认它指向预期位置）');
    process.exit(0);
  }

  const entries = [];
  const addIf = (rel) => {
    const src = path.join(LEGACY_DATA, rel);
    if (fs.existsSync(src)) entries.push(rel);
  };
  addIf('journal.jsonl');
  addIf('incidents.jsonl');
  const snapSrc = path.join(LEGACY_DATA, 'snapshots');
  if (fs.existsSync(snapSrc)) {
    for (const f of fs.readdirSync(snapSrc)) {
      if (f.endsWith('.json')) entries.push(path.join('snapshots', f));
    }
  }

  console.log(`\n待迁移 ${entries.length} 个文件:`);
  for (const rel of entries) console.log(`  ${rel}`);

  if (!flag('--yes')) {
    console.log('\n这是预览。确认后执行:');
    console.log(`  node ${path.join(HERE, 'reflect.mjs')} migrate-data --yes`);
    console.log('\n（迁移是复制，旧的 data/ 不会被删除；可自行清理）');
    process.exit(0);
  }

  let copied = 0;
  let skipped = 0;
  for (const rel of entries) {
    const src = path.join(LEGACY_DATA, rel);
    const dst = path.join(target, rel);
    if (fs.existsSync(dst)) {
      // 不覆盖已有文件：共享位置可能已经有更新的同名文件
      console.log(`  跳过（目标已存在）: ${rel}`);
      skipped++;
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    console.log(`  复制: ${rel}`);
    copied++;
  }
  console.log(`\n完成：复制 ${copied} 个，跳过 ${skipped} 个。`);
  console.log(`下次运行将使用: ${target}`);
  console.log('旧 data/ 保留在原处，确认迁移无误后可自行删除。');
  process.exit(0);
}

console.error(`未知子命令: ${cmd}`);
console.error('可用: snapshot | diff | journal | record | incidents | confirm | promote | status | migrate-data');
process.exit(2);
