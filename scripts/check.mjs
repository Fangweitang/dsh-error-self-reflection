#!/usr/bin/env node
/**
 * dsh-error-self-reflection :: profile / skill 安装校验
 *
 * 用法：
 *   node check.mjs --profile <name>
 *   node check.mjs --skills
 *   node check.mjs --all --strict
 *
 * 退出码：0 = 无 ERROR；1 = 有 ERROR（--strict 时 WARN 也算）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const AGENTS_HOME = process.env.DSH_AGENTS_HOME || path.join(HOME, '.agents');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};

const STRICT = flag('--strict');
const RESULTS = [];
function record(level, area, message, detail) {
  RESULTS.push({ level, area, message, detail });
}
const err = (a, m, d) => record('ERROR', a, m, d);
const warn = (a, m, d) => record('WARN', a, m, d);
const ok = (a, m, d) => record('OK', a, m, d);

// ---------- 找一个可用的 YAML 解析器 ----------
// 优先级：目标 profile → 当前 DSH_HOME 下其它 profile → 默认 ~/.dsh 下所有 profile → skill 自身
// 说明：DSH 环境通常在 profile 的 node_modules 里自带 js-yaml/yaml。若确实找不到，
// 不手写解析器（YAML 含多行字符串/锚点/流式集合，误解析比不解析更危险），
// 而是明确报 ERROR 并给出安装指引。
function loadYaml(profileDir) {
  const tryPaths = [profileDir, path.join(profileDir, 'node_modules')];

  const addProfiles = (homeRoot) => {
    const pd = path.join(homeRoot, 'profiles');
    if (!fs.existsSync(pd)) return;
    for (const e of fs.readdirSync(pd, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(pd, e.name);
      if (dir === profileDir) continue;
      tryPaths.push(dir, path.join(dir, 'node_modules'));
    }
  };
  addProfiles(DSH_HOME);
  const defaultHome = path.join(HOME, '.dsh');
  if (defaultHome !== DSH_HOME) addProfiles(defaultHome);

  tryPaths.push(HERE, path.join(HERE, '..'), path.join(HERE, '..', '..'));

  for (const base of tryPaths) {
    for (const mod of ['js-yaml', 'yaml']) {
      try {
        const req = createRequire(path.join(base, 'x.js'));
        const y = req(mod);
        return mod === 'yaml'
          ? { parse: (t) => y.parse(t), kind: 'yaml' }
          : { parse: (t) => y.load(t), kind: 'js-yaml' };
      } catch { /* next */ }
    }
  }
  return null;
}

// ---------- 通用文件检查：BOM / 残留 / 编码损坏 ----------
// 粘贴残留特征：这些只会在"代码/配置"里出现，不该出现在说明性文本中。
// 为避免把"文档里引用这些字符"误判为残留，只在非注释、非引号包裹说明的行报警。
const RESIDUE = [
  [/<\/li>/, 'HTML 片段 </li>'],
  [/<br\s*\/?>/i, 'HTML 片段 <br>'],
  [/&(lt|gt|amp|quot);/, 'HTML 实体'],
];

/** 该行是否明显是在"说明/引用"这些危险字符，而不是真的混入。 */
function isExplanatoryLine(line) {
  const t = line.trim();
  // 反引号包裹的内联代码、表格里的说明格、以 # 或 // 开头的注释
  if (/^#|^\/\//.test(t)) return true;
  // 行内反引号出现 >=2 次，说明是把符号当例子引用
  const ticks = (t.match(/`/g) || []).length;
  if (ticks >= 2) return true;
  // 行首是表格单元格且内容是描述（含"说明/残留/例"等词）
  if (/^\|/.test(t) && /(残留|示例|例|说明|等)/.test(t)) return true;
  return false;
}

function checkRawText(file, label, opts = {}) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) {
    err(label, `无法读取: ${e.message}`);
    return null;
  }
  // BOM：只有 YAML/JSON 这类严格解析器才致命；Markdown 有 BOM 通常无害
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (hasBom) {
    if (opts.markdown) {
      warn(label, '文件带 UTF-8 BOM（Markdown 通常无害，但部分工具链会误判）',
        '建议改为无 BOM：UTF8Encoding($false)');
    } else {
      err(label, '文件带 UTF-8 BOM，YAML/JSON 解析器会报 "expected value at line 1 column 1"',
        'PowerShell Set-Content 默认加 BOM；改用 [IO.File]::WriteAllText(p, t, UTF8Encoding($false))');
    }
  }
  const text = buf.toString('utf8');
  // 编码损坏（U+FFFD）
  const broken = (text.match(/\uFFFD/g) || []).length;
  if (broken > 0) {
    warn(label, `含 ${broken} 个 U+FFFD 替换字符（真实编码损坏）`, '文件被错误编码写入，需重写');
  }
  // 粘贴残留
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (isExplanatoryLine(lines[i])) continue;
    for (const [re, what] of RESIDUE) {
      if (re.test(lines[i])) {
        err(label, `第 ${i + 1} 行混入 ${what}（非说明性上下文）`, lines[i].trim().slice(0, 120));
      }
    }
  }
  return text;
}

// ---------- profile 校验 ----------
function verifyProfile(name) {
  const dir = path.join(DSH_HOME, 'profiles', name);
  const patchPath = path.join(dir, 'cordis.patch.yml');
  const pkgPath = path.join(dir, 'package.json');
  const area = `profile:${name}`;

  if (!fs.existsSync(dir)) { err(area, `profile 目录不存在: ${dir}`); return; }
  ok(area, `目录存在: ${dir}`);
  if (!fs.existsSync(patchPath)) { err(area, `缺少 cordis.patch.yml`); return; }

  const raw = checkRawText(patchPath, `${area}/cordis.patch.yml`);
  const YAML = loadYaml(dir);
  if (!YAML) {
    // 找不到解析器时，结构检查无法进行——这不算通过，必须报 ERROR
    err(area,
      '找不到可用的 YAML 解析器（js-yaml / yaml），无法进行结构检查',
      '这只是"没检查"，不是"检查通过"。安装其中之一后重跑：npm i -g js-yaml，'
      + '或把本技能放进任一带 js-yaml 的 DSH profile 目录旁边');
    return;
  }

  let entries = null;
  let patchBroken = false;
  try {
    entries = YAML.parse(raw);
    if (!Array.isArray(entries)) {
      err(area, 'cordis.patch.yml 顶层不是数组');
      entries = null;
      patchBroken = true;
    }
  } catch (e) {
    err(area, `cordis.patch.yml 解析失败: ${e.message}`);
    patchBroken = true;
  }
  if (patchBroken) {
    // 降级：patch 无法解析时不放弃整次检查——package.json / bundle / 依赖仍可独立校验，
    // 这些恰恰是"装完插件"最容易出问题的地方。跳过依赖 patch 结构的检查项。
    warn(area, 'patch 无法解析，跳过"配置行 / 孤儿行 / insert 撞 id"等依赖结构的检查',
      '修好 YAML 语法后重跑，才能得到完整结论');
  } else {
    ok(area, `YAML 可解析（解析器 ${YAML.kind}），顶层 ${entries.length} 个条目`);
  }

  // package.json
  let pkg = null;
  if (fs.existsSync(pkgPath)) {
    const t = checkRawText(pkgPath, `${area}/package.json`);
    try { pkg = JSON.parse(t); ok(area, 'package.json 可解析'); }
    catch (e) { err(area, `package.json 解析失败: ${e.message}`); }
  } else {
    err(area, '缺少 package.json');
  }

  const bundles = (pkg?.dsh?.profile?.bundles) || [];
  const deps = (pkg?.dependencies) || {};

  // DSH 内置包由 app.asar 提供，不会出现在 profile 的 node_modules。
  // 只有"第三方包"才要求落在 profile node_modules 里。
  const isBuiltin = (name) => name.startsWith('@deepseek-ai/');

  // 1) bundle 是否存在 + 收集它们 insert 的 id
  const insertedIds = new Map(); // id -> bundleName
  for (const b of bundles) {
    const bdir = path.join(dir, 'node_modules', b);
    const exists = fs.existsSync(bdir);
    if (!exists) {
      if (isBuiltin(b)) {
        ok(area, `bundle 为 DSH 内置包（由 app.asar 提供）: ${b}`);
        continue;
      }
      err(area, `第三方 bundle 不在 node_modules: ${b}`, '运行 dsh plugin --profile <p> add <pkg>');
      continue;
    }
    let bj;
    try { bj = JSON.parse(fs.readFileSync(path.join(bdir, 'package.json'), 'utf8')); }
    catch (e) { err(area, `bundle package.json 读取失败: ${b} (${e.message})`); continue; }

    const patchRel = bj?.dsh?.bundle?.patch;
    if (!patchRel) continue;
    const bp = path.join(bdir, patchRel);
    if (!fs.existsSync(bp)) { err(area, `bundle 声明的 patch 文件不存在: ${b} -> ${patchRel}`); continue; }

    let bdoc;
    try { bdoc = YAML.parse(fs.readFileSync(bp, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { err(area, `bundle patch 解析失败: ${b} (${e.message})`); continue; }

    for (const row of (Array.isArray(bdoc) ? bdoc : [])) {
      if (row && Array.isArray(row.insert)) {
        for (const r of row.insert) {
          if (r && typeof r.id === 'string') insertedIds.set(r.id, b);
        }
      }
    }
  }
  ok(area, `bundles ${bundles.length} 个，其中 insert 的 loader id ${insertedIds.size} 个`);

  // 2)～4) 依赖 patch 结构的检查：仅在 YAML 可解析时执行
  if (!patchBroken) {
    // 2) profile 行：insert vs override
    const profileRows = entries.filter((e) => e && typeof e === 'object');
    const insertRows = profileRows.filter((e) => Array.isArray(e.insert));
    const overrideRows = profileRows.filter((e) => typeof e.id === 'string' && !Array.isArray(e.insert));

    if (insertRows.length > 0) {
      // 手写 insert 与 bundle 自带 insert 撞 id = 树里两个 insert，可能拒绝启动
      for (const row of insertRows) {
        for (const r of row.insert) {
          if (r && typeof r.id === 'string' && insertedIds.has(r.id)) {
            err(area,
              `手写 insert 与 bundle 自带 insert 撞 id: "${r.id}"（bundle: ${insertedIds.get(r.id)}）`,
              'bundle 层负责 insert；profile 层应改用 override-by-id（带 id、无 insert）来提供 config');
          } else if (r && typeof r.id === 'string') {
            ok(area, `手写 insert id "${r.id}" 无冲突`);
          }
        }
      }
    }

    // 3) 孤儿 override 行（最重要：id 对不上 = 静默失效）
    //
    // 注意：内置 bundle（@deepseek-ai/*）的 patch 在 app.asar 里，这里读不到。
    // 所以"对不上已发现的 insert"不等于"孤儿"——可能正是内置 bundle 插入的。
    // 只有当该 id 明确"曾是第三方 bundle 插入的、而该 bundle 已被移除"时才算真孤儿。
    const unresolvable = [];
    for (const row of overrideRows) {
      const id = row.id;
      if (insertedIds.has(id)) continue;                 // 明确由可见 bundle 插入
      const selfInserted = insertRows.some((x) => x.insert?.some((r) => r && r.id === id));
      if (selfInserted) continue;                        // 由本文件自己的 insert 提供
      unresolvable.push(id);
    }
    if (unresolvable.length > 0) {
      ok(area,
        `有 ${unresolvable.length} 个 override id 未在任何"可读 bundle"的 insert 中出现：`
        + unresolvable.join(', '),
        '在内置 bundle（app.asar）里可能仍存在，无法离线确证；若某个包已卸载而该行残留，应删除');
    }

    // 4) 同 id 多行：合法（覆盖语义），但两次都写完整 config 时可疑
    const byId = new Map();
    for (const row of overrideRows) {
      if (!byId.has(row.id)) byId.set(row.id, []);
      byId.get(row.id).push(row);
    }
    for (const [id, rows] of byId) {
      if (rows.length > 1) {
        const withConfig = rows.filter((r) => r.config && Object.keys(r.config).length > 0).length;
        if (withConfig > 1) {
          warn(area, `id "${id}" 出现 ${rows.length} 次且 ${withConfig} 次都带 config`,
            '后者覆盖前者，前者的 config 会被整体丢弃（config 不深合并），确认这是本意');
        } else {
          ok(area, `id "${id}" 出现 ${rows.length} 次（覆盖语义，合法）`);
        }
      }
    }
  } // end if (!patchBroken)

  // 5) 依赖是否落地（内置 @deepseek-ai/* 由 app.asar 提供，不要求落地）
  for (const [d, ver] of Object.entries(deps)) {
    if (d.startsWith('file:') || d.startsWith('link:') || d.startsWith('workspace:')) continue;
    if (isBuiltin(d)) continue;
    const p = path.join(dir, 'node_modules', d);
    if (!fs.existsSync(p)) {
      err(area, `依赖未安装: ${d}@${ver}`, '运行 dsh plugin --profile <p> add <pkg>');
    }
  }

  // 6) 第三方包的 peer 是否可解析（内置 peer 由 app.asar 提供，跳过）
  const localPkgs = [];
  for (const d of Object.keys(deps)) {
    if (isBuiltin(d)) continue;
    const pj = path.join(dir, 'node_modules', d, 'package.json');
    if (fs.existsSync(pj)) {
      try { localPkgs.push({ name: d, json: JSON.parse(fs.readFileSync(pj, 'utf8')) }); } catch { /* skip */ }
    }
  }
  const peerMisses = [];
  for (const { name, json } of localPkgs) {
    for (const pr of Object.keys(json.peerDependencies || {})) {
      if (isBuiltin(pr)) continue;                       // 内置提供
      if (pr === 'react' || pr === 'react-dom') continue; // shell 冻结模块表提供
      if (fs.existsSync(path.join(dir, 'node_modules', pr))) continue;
      if (fs.existsSync(path.join(dir, 'node_modules', name, 'node_modules', pr))) continue;
      peerMisses.push(`${name} -> ${pr}`);
    }
  }
  if (peerMisses.length > 0) {
    warn(area, `${peerMisses.length} 个第三方 peer 未在本地解析：${peerMisses.join(', ')}`,
      '可能由内置 bundle 或 shell 提供；若插件加载失败优先查这里');
  }

  // 7) profile 目录里是否残留 .bak（提示，不算错）
  const baks = fs.readdirSync(dir).filter((f) => f.startsWith('cordis.patch.yml.bak'));
  if (baks.length) ok(area, `存在 ${baks.length} 个备份文件（回滚用）`);
}

// ---------- skill 校验 ----------
function verifySkills() {
  const roots = [
    { p: path.join(AGENTS_HOME, 'skills'), label: 'user-agents' },
    { p: path.join(DSH_HOME, 'skills'), label: 'user-dsh' },
  ];
  const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  for (const { p: root, label } of roots) {
    const area = `skills:${label}`;
    if (!fs.existsSync(root)) { ok(area, `根目录不存在（跳过）: ${root}`); continue; }
    const entries = fs.readdirSync(root, { withFileTypes: true });
    let n = 0;

    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(root, e.name);
      let md = null;
      if (e.isDirectory()) {
        md = path.join(full, 'SKILL.md');
        if (!fs.existsSync(md)) {
          warn(area, `${e.name}/ 目录下没有 SKILL.md（不是合法 skill；嵌套 **/SKILL.md 不会被发现）`);
          continue;
        }
      } else if (e.isFile() && e.name.endsWith('.md')) {
        md = full;
      } else continue;

      n++;
      checkRawText(md, `${area}/${e.name}`, { markdown: true });

      const text = fs.readFileSync(md, 'utf8').replace(/^\uFEFF/, '');
      const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) { err(area, `${e.name}: 缺少 YAML frontmatter`); continue; }

      const fm = m[1];
      const nameM = fm.match(/^name:\s*(.+)$/m);
      const descM = fm.match(/^description:\s*(.+)$/m);

      if (!nameM) err(area, `${e.name}: frontmatter 缺 name`);
      else {
        const nm = nameM[1].trim().replace(/^["']|["']$/g, '');
        if (!KEBAB.test(nm)) {
          err(area, `${e.name}: name "${nm}" 不是 kebab-case（DSH 会跳过整个 skill）`);
        } else if (e.isDirectory() && nm !== e.name) {
          warn(area, `${e.name}: name "${nm}" 与目录名不一致`);
        } else {
          ok(area, `${e.name}: 合法`);
        }
      }
      if (!descM) err(area, `${e.name}: frontmatter 缺 description（DSH 会跳过）`);
      else if (descM[1].trim().length < 10) warn(area, `${e.name}: description 过短，影响被发现`);
    }
    ok(area, `扫描 ${n} 个 skill`);
  }
}

// ---------- main ----------
const runProfile = flag('--profile') ? opt('--profile') : null;
const runSkills = flag('--skills') || flag('--all');
const runAllProfiles = flag('--all');

const profiles = [];
if (runProfile) profiles.push(runProfile);
if (runAllProfiles) {
  const pd = path.join(DSH_HOME, 'profiles');
  if (fs.existsSync(pd)) {
    profiles.push(...fs.readdirSync(pd, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name));
  }
}

if (profiles.length === 0 && !runSkills) {
  console.error('用法: node check.mjs [--profile <name> | --all] [--skills] [--strict]');
  process.exit(2);
}

for (const p of profiles) verifyProfile(p);
if (runSkills) verifySkills();

// ---------- 输出 ----------
const ICON = { ERROR: '❌', WARN: '⚠️ ', OK: '✅' };
console.log('\n================ dsh-error-self-reflection ================\n');
let curArea = null;
for (const r of RESULTS) {
  if (r.area !== curArea) { curArea = r.area; console.log(`\n── ${curArea} ──`); }
  console.log(`${ICON[r.level]} ${r.message}`);
  if (r.detail) console.log(`      ↳ ${r.detail}`);
}

const nErr = RESULTS.filter((r) => r.level === 'ERROR').length;
const nWarn = RESULTS.filter((r) => r.level === 'WARN').length;
const nOk = RESULTS.filter((r) => r.level === 'OK').length;

console.log('\n---------------------------------------------------');
console.log(`ERROR ${nErr} | WARN ${nWarn} | OK ${nOk}`);
if (nErr > 0) {
  console.log('\n结论：存在阻断问题，不要声称"安装已完成"。按上面的 ↳ 修掉再复跑。');
} else if (nWarn > 0) {
  console.log(`\n结论：无阻断问题，但有 ${nWarn} 条警告需要人工确认（多为静默失效风险）。`);
} else {
  console.log('\n结论：全部通过。');
}
console.log(`\n提示：这份检查只证明"配置结构正确"，不证明"运行时生效"。`);
console.log(`      重启后必须再验证实际返回值（HTTP 路由 / 日志 / /health）。`);

const fail = nErr > 0 || (STRICT && nWarn > 0);
process.exit(fail ? 1 : 0);
