# dsh-install-verify

一个给 **DeepSeek Harness（DSH）** 用的安装校验技能：装完插件或改完 profile 配置后，
用可执行的检查证明"配置真的生效了"，而不是看着文件说"应该没问题"。

它的由来很直接：装一个插件时踩了坑——改了不该改的全局配置、验证停在中间环节、
把合法结构当成故障——于是把这些教训固化成两个脚本和一份规则清单。

---

## 它解决什么问题

DSH 的 profile 由多层 Cordis 补丁组合而成（bundle 层 + profile 层 + 命令行覆盖）。
这套机制有几个**静默失效**的坑，出了问题往往没有明显报错：

| 坑 | 后果 |
|---|---|
| profile 里的配置行 `id` 对不上任何插入行 | 该行被跳过，配置变成死代码，无人察觉 |
| 手写 `insert` 与 bundle 自带 `insert` 同 id | 树里出现两个 insert，可能拒绝启动 |
| 顺手改了全局条目（如默认模型） | 影响所有会话，且很难追溯到这次安装 |
| YAML 写了 BOM / 混入粘贴残留 | 解析器报含糊的"首行非法" |
| 验证只看健康检查与文件内容 | 运行时取值与配置不一致却依然"通过" |

本技能提供两个工具来对付这些坑。

---

## 安装

把整个目录放到 DSH 的 skill 扫描根之一即可（目录形式 `<name>/SKILL.md`）：

```bash
# 用户级（对所有项目生效）
git clone <this-repo> ~/.agents/skills/dsh-install-verify

# 或项目级
git clone <this-repo> <project>/.agents/skills/dsh-install-verify
```

DSH 会扫描 `<project>/.dsh/skills`、`<project>/.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`。
放到任一位置后，新开会话即可在技能列表里看到 `dsh-install-verify`。

**依赖**：Node.js ≥ 18。YAML 解析器会从 DSH profile 的 `node_modules` 自动借用
（`js-yaml` 或 `yaml`，DSH 环境里通常自带）。

---

## 用法

### 1. 静态结构校验

```bash
node scripts/verify-profile.mjs --profile <name>
node scripts/verify-profile.mjs --all --skills
node scripts/verify-profile.mjs --all --skills --strict   # WARN 也算失败（适合 CI）
```

退出码：`0` 无阻断问题，`1` 有 ERROR。

### 2. 变更追踪（这招最能防"顺手改坏"）

```bash
S=scripts/state.mjs

node $S snapshot --tag pre --note "要装某插件"
# ... 做改动 ...
node $S diff --from pre --to post --scope "<本次预期会动的 id>"
```

`diff` 会给出**字段级**差异，并对越界改动报 ERROR：

```
── 配置行 ──
  [override] <全局条目> modified
      · provider: "<旧值>" -> "<新值>"

── ⚠ 越界/异常 ──
  ❌ 改动了全局配置行 "<全局条目>"（provider: "<旧值>" -> "<新值>"），但它不在本次声明的范围内
      ↳ 装插件不该改全局默认模型/权限等配置，这会影响所有会话
```

### 3. 事故沉淀

```bash
node $S record                 # 跑 verify 并把问题归档
node $S incidents              # 按类别看复发次数
node $S confirm <fp> --note "原因"   # 人工确认真问题
node $S promote                # 生成 lessons 草稿
```

---

## 能力边界（重要）

| 能自动 | 不能自动 |
|---|---|
| 捕获状态变化，精确到字段 | 判断"这是真问题还是环境噪音" |
| 检测越界改动 | 写出根因（工具只能看到"A 变成 B"） |
| 按类别聚合、统计复发 | 决定该不该回滚 |
| 生成复盘草稿 | 替你想清楚为什么 |

`promote` 生成的草稿里，根因字段会显式标注 `（待补——工具无法推断）`。
这是刻意保留的诚实边界，不是未完成功能。

**另一个边界**：`verify-profile.mjs` 只证明"配置结构正确"，**不证明运行时生效**。
重启后仍需检查运行时返回值（插件 HTTP 路由、日志、健康检查）。

---

## 目录结构

```
dsh-install-verify/
├── SKILL.md                    # 技能说明：铁律 + 标准流程
├── references/
│   └── lessons.md              # 15 条故障模式与规则（脱敏版）
├── scripts/
│   ├── verify-profile.mjs      # 静态结构校验
│   └── state.mjs               # 快照 / diff / 归档 / 复发 / 沉淀
├── examples/
│   ├── run.mjs                 # 一键回归测试
│   ├── good/                   # 正确写法（应全绿）
│   ├── bad/                    # BOM + 残留 + 缺依赖（应报错）
│   └── bad-insert/             # insert 撞 id（应报错）
└── data/                       # 运行时生成（已被 .gitignore 忽略）
    ├── snapshots/
    ├── journal.jsonl
    └── incidents.jsonl
```

---

## 验证工具本身

```bash
node examples/run.mjs
```

它跑三个隔离的假 profile（不读也不改你的真实配置），验证：

- ✅ 正确写法**不误报**
- ✅ BOM / 粘贴残留 / YAML 错误 / 缺依赖**能抓到**
- ✅ 手写 `insert` 撞 bundle `insert`**能抓到**
- ✅ `diff` 能捕获字段级改动并报越界
- ✅ 还原后 diff 回到"无变化"

改完 `scripts/` 后请务必跑一遍：**校验工具最大的风险是误报让人弃用，或漏报给出虚假安全感。**

---

## 适用范围与已知限制

- **面向 DSH**：检查项针对 `cordis.patch.yml` 的 `insert` / override-by-id 语义设计，
  不适用于其它框架的配置文件。
- **对版本敏感**：DSH 大版本若改动 profile 结构或补丁语义，检查项可能失效。请优先在主分支跟进。
- **平台**：脚本是跨平台的 Node，但文档示例用 PowerShell（Windows 习惯）；命令本身不绑定 shell。
- **离线**：内置 bundle 的补丁打包在 `app.asar` 内，工具读不到，
  因此对"孤儿配置行"只能报告**无法离线确证**，不做确定性断言。
- **YAML 解析器**：不内置解析器（YAML 含多行字符串/锚点，误解析比不解析更危险）。
  找不到时工具报 ERROR 并提示安装，**不会静默跳过检查**。

---

## 自检

改完这个技能本身，跑：

```bash
node --check scripts/verify-profile.mjs
node --check scripts/state.mjs
node scripts/verify-profile.mjs --all --skills   # 技能自己也要通过自己的检查
node scripts/state.mjs status
```

---

## License

Apache-2.0，见 [LICENSE](LICENSE)。
