#!/usr/bin/env node
/**
 * examples/run.mjs — 回归测试：证明工具真的能发现该发现的问题，也不会误报。
 *
 * 用法：node examples/run.mjs
 * 退出码：0 全部符合预期；1 有偏差
 *
 * 这个脚本只用 examples/ 下的隔离假 profile，不读也不改本机真实配置。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));     // examples/
const ROOT = path.join(HERE, '..');                            // repo root
const VERIFY = path.join(ROOT, 'scripts', 'verify-profile.mjs');
const STATE = path.join(ROOT, 'scripts', 'state.mjs');

const cases = [
  {
    name: 'good',
    home: path.join(HERE, 'good', '.dsh'),
    profile: 'demo',
    wantMinErrors: 0,
    wantMaxErrors: 0,
    why: 'override-by-id 正确写法；内置包不应被误报为缺失',
  },
  {
    name: 'bad',
    home: path.join(HERE, 'bad', '.dsh'),
    profile: 'broken',
    wantMinErrors: 3,
    wantMaxErrors: Infinity,
    why: 'BOM + 粘贴残留 + YAML 语法错误 + 缺依赖；解析失败后应继续检查其余项',
  },
  {
    name: 'bad-insert',
    home: path.join(HERE, 'bad-insert', '.dsh'),
    profile: 'collide',
    wantMinErrors: 1,
    wantMaxErrors: Infinity,
    why: '手写 insert 与 bundle 自带 insert 撞 id（会导致启动失败）',
  },
];

function run(cmdArgs, envExtra = {}) {
  const r = spawnSync(process.execPath, cmdArgs, {
    encoding: 'utf8',
    env: { ...process.env, ...envExtra },
  });
  return { out: (r.stdout || '') + (r.stderr || ''), code: r.status ?? 1 };
}

function parseCounts(out) {
  const m = out.match(/ERROR (\d+) \| WARN (\d+) \| OK (\d+)/);
  return m ? { err: +m[1], warn: +m[2], ok: +m[3] } : null;
}

let failures = 0;
console.log('\n============ examples 回归测试 ============\n');

for (const c of cases) {
  if (!fs.existsSync(c.home)) {
    console.log(`❌ ${c.name}: 找不到 ${c.home}`);
    failures++;
    continue;
  }
  const { out } = run([VERIFY, '--profile', c.profile], { DSH_HOME: c.home });
  const counts = parseCounts(out);
  if (!counts) {
    console.log(`❌ ${c.name}: 输出里没有统计行，工具可能崩溃`);
    console.log(out.split('\n').slice(0, 8).map((l) => `     ${l}`).join('\n'));
    failures++;
    continue;
  }
  const ok = counts.err >= c.wantMinErrors && counts.err <= c.wantMaxErrors;
  const mark = ok ? '✅' : '❌';
  const expect = c.wantMaxErrors === Infinity ? `>= ${c.wantMinErrors}` : `= ${c.wantMinErrors}`;
  console.log(`${mark} ${c.name.padEnd(11)} ERROR=${counts.err} (期望 ${expect})  ${c.why}`);
  if (!ok) failures++;
}

// state.mjs：快照 → 改一个字段 → diff 必须报出该字段
console.log('\n── 变更检测 ──');
const tmpHome = path.join(HERE, 'good', '.dsh');
const patchPath = path.join(tmpHome, 'profiles', 'demo', 'cordis.patch.yml');
if (fs.existsSync(patchPath)) {
  const original = fs.readFileSync(patchPath);
  try {
    run([STATE, 'snapshot', '--tag', 'rt-base', '--note', '回归基线'], { DSH_HOME: tmpHome });
    const altered = original.toString('utf8').replace('provider: primary', 'provider: altered');
    fs.writeFileSync(patchPath, altered, 'utf8');
    const d = run([STATE, 'diff', '--from', 'rt-base', '--global-ids', 'global-model'], { DSH_HOME: tmpHome });
    const sawField = /provider: "primary" -> "altered"/.test(d.out);
    const sawScope = /改动了全局配置行/.test(d.out);
    console.log(`${sawField ? '✅' : '❌'} 字段级差异被捕获（provider: primary -> altered）`);
    console.log(`${sawScope ? '✅' : '❌'} 越界改动被报为 ERROR`);
    if (!sawField || !sawScope) failures++;
  } finally {
    // 无论成败都还原，避免把示例改脏
    fs.writeFileSync(patchPath, original);
  }
  // 还原后再 diff，应回到"无变化"
  const back = run([STATE, 'diff', '--from', 'rt-base'], { DSH_HOME: tmpHome });
  const clean = /（无变化）/.test(back.out);
  console.log(`${clean ? '✅' : '❌'} 还原后 diff 显示无变化`);
  if (!clean) failures++;
}

// 清理回归期间产生的 data/
const dataDir = path.join(ROOT, 'data');
if (fs.existsSync(dataDir)) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('\n（已清理回归测试产生的 data/）');
}

console.log(`\n${failures === 0 ? '全部符合预期 ✅' : `${failures} 项不符合预期 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
