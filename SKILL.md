---
name: dsh-error-self-reflection
description: 把一次配置事故变成下一次能自动拦住的检查。用于 DeepSeek Harness 的插件安装与 profile 配置变更：动手前拍快照、改完后做字段级 diff、识别越界改动（如误改全局默认模型）、把问题归档并按类别统计复发、生成复盘草稿。也用于排查"装了插件后对话异常"、"配置改了却不生效"。**装插件、改 profile、修复故障、或纠正自己错误之后，任务收尾时必须执行一次 record 归档**——否则复发统计失效。触发词：装插件、改 profile、配置漂移、越界改动、复盘、self-reflection、安装校验。
---

# 错误自省（dsh-error-self-reflection）

**把每一次配置事故，变成下一次自动拦截的检查。**

起因很直接：装一个 DSH 插件时顺手改了不该改的全局默认模型，导致整个应用异常；
而当时的"验证"只停在健康检查和文件内容，没覆盖最终生效值，所以问题一路穿过去没被发现。

这个 skill 把那次事故连同后续踩到的坑固化成两类东西：

- **可执行的检查**（`scripts/check.mjs` 静态结构校验、`scripts/reflect.mjs` 变更拦截与沉淀）
- **可复用的规则**（`references/lessons.md` 15 条故障模式，每条对应一次真实事故）

核心原则：**"我改了配置文件" ≠ "配置生效了"**；**"我发现问题" ≠ "我知道根因"**。
前者要用程序读出 loader 的实际组合结果来证明；后者必须人来判断，工具只负责把证据摆到眼前。

主线流程：**捕获 → 比对 → 拦截 → 归档 → 复发计数 → 沉淀。**

## 何时必须用

- 安装 / 卸载 / 启用 / 禁用任何 DSH 插件
- 修改 `~/.dsh/profiles/<name>/` 下的 `cordis.patch.yml` 或 `package.json`
- 用户报告"装了插件后对话失败""配置改了但没生效"
- 你准备说"已完成""已验证""兼容"之前
- 想把某次出错沉淀下来，防止以后重犯时

## 收尾纪律（强制性，不是建议）

**每次任务结束前，必须执行一次 `record`。** 没有例外。

理由：这个工具的价值完全建立在"有没有人真的把问题记下来"之上。
数据已经存在全局共享位置（`$DSH_HOME/error-self-reflection`），所有窗口都能读，
但**没有任何自动写入机制**——没有人 `record`，`incidents` 永远是空的，
"同一个坑犯了第几次"就无从谈起。

```bash
node scripts/reflect.mjs record
node scripts/reflect.mjs incidents    # 顺手看一眼有没有复发
```

### 什么时候算"结束"

满足任一条即可视为一次可收尾的任务：

- 装完 / 卸完一个插件，或改完 profile 配置
- 修完一个 bug，或诊断完一个异常
- 你即将向用户汇报"已完成""已修复""已验证"
- 本次会话中你**实际犯了一个错误并纠正了它**——这种情况尤其必须记

### 记录时的自我要求

| 情形 | 要做什么 |
|---|---|
| 本次没犯错 | `record` 一次即可（会归档当前环境的存量问题） |
| 本次犯了错并修好 | `record` 之后再 `incidents`，看是否已有同类；把根因补进 `references/lessons.md` |
| 出现新类型的问题 | 该问题可能落在 `uncategorized`——说明缺少对应检查项，考虑给 `check.mjs` 加规则 |

### 不许做的事

- 不许因为"这次很简单"就跳过 `record`
- 不许在 `record` 报错时假装没看见（那本身就是一个要归档的问题）
- 不许把 `record` 当成形式——`incidents` 里同一指纹持续增长，说明检查项没修或纪律没守住

## 铁律（每条都对应一个真实事故，见 `references/lessons.md`）

### 1. 先备份，再改，改完逐项 diff

```powershell
Copy-Item $patch "$patch.bak-<用途>-$(Get-Date -Format yyyyMMdd-HHmmss)"
```
改完不要只看"我写进去了"，要对比**原始备份与当前文件的语义差异**，确认只有预期内的改动。

### 2. 不要改与安装目标无关的全局配置

装插件不该顺手改 `agent-default-model` 的 provider/model。那是所有会话的默认模型，
改错影响面是整个应用，而插件本身只影响被它接管的请求。**一次只改一个变量。**

### 3. "搜不到"不能证明"不存在"

曾在全库 grep 不到某个 provider 的注册代码后，就断言它是失效 id 并改掉了它；
而现有会话其实一直正常跑在该 provider 上——**实际运行才是证据**。
判断 provider 是否有效：看它是否在实际请求里成功过，而不是看代码里有没有注册语句。

### 4. 区分"文件不存在"和"符号不存在"

`window.__ModuleLoader__` 在 asar 里 grep 不到任何文件，我一度以为接口不存在。
它其实是运行时注入的全局对象。**静态查找无结果只说明没有同名文件。**

### 5. 一个 id 出现两次，不一定是错

Cordis 的 patch 语义是：带 `id` 且无 `insert` 的 patch **覆盖**已存在的行。
所以同一个 id 可以在文件里出现多次，后者覆盖前者——`copylee-computer-use` 的两行就是合法的
（先配置，再 `disabled: true`）。真正会静默失效的是 **patch 的 id 对不上任何已插入的行**：
loader 只警告并跳过，你的配置就变成了死代码。这是本 skill 最重要的检查项。

### 6. 用户可能同时在改同一个文件

我写完配置后，用户又追加了一行，文件已不是我写时的样子。
**写操作前必须重新读取**（`edit` 会报 FS_STALE_VERSION，别绕过它，要重读后再改）。

### 7. 插件包自带 patch 与手写行会冲突

`pnpm add` 会把包写进 `dsh.profile.bundles`，包自带的 `dsh.bundle.patch` 会 `insert` 一行。
如果 profile 里再手写 `- insert:` 同一个 id → 树里出现两个 insert，Cordis 拒绝启动。
正确做法：**bundle 层负责 insert，profile 层只用 override-by-id 提供 config**。

### 8. 写文件用无 BOM UTF-8

PowerShell `Set-Content` 默认带 BOM，会让 JSON/YAML 解析器报
`expected value at line 1 column 1`。用：

```powershell
[IO.File]::WriteAllText($path, $raw, (New-Object Text.UTF8Encoding($false)))
```

### 9. 脚本里不要混入粘贴残留

我的下载脚本里混进了 `</li>` 这类 HTML 碎片，运行时报
`无法将"<"项识别为 cmdlet`。**写完脚本先做语法自检**（见下方 `--syntax`）。

### 10. 大文件下载：不要相信"下完了"

803 MB 权重用并发分片下载，3 个分片被源端截断成几百 KB。**必须逐片校验长度 + 全文件哈希**，
不能只看"文件存在"。

### 11. 依赖安装卡住要先分辨是解析还是下载

`pip install -r lock.txt` 在 Python 3.14 上长时间无进展、缓存无大文件 → 是**依赖回溯**卡住，
不是网速问题。改用"手取 wheel + `--no-index --no-deps` 本地安装 + 镜像装其余"。

### 12. 声明"已验证"前，把验证做完整

我验证了服务 `/health`、验证了单条配置能解析，却没验证**配置组合后的实际生效值**
（`mode` 实际返回 `manual`，以及我改的 provider 是否生效）。**验证要覆盖最终产物，不是中间环节。**

## 用校验程序

在技能根目录下执行（下文 `<name>` 替换成你的 profile 名）：

```bash
node scripts/check.mjs --profile <name>
node scripts/check.mjs --skills
node scripts/check.mjs --all --strict
```

退出码：`0` 无阻断问题，`1` 有 ERROR。`--strict` 让 WARN 也算失败。

它检查：

| 检查 | 说明 |
|---|---|
| YAML 可解析 | 带 BOM / 语法错误直接报 |
| 粘贴残留 | `</li>`、`<br`、`&lt;` 等混入的行（会跳过注释行、反引号引用、说明性表格格） |
| 编码损坏 | 出现 U+FFFD 替换字符（真实损坏，不是终端显示问题） |
| bundle 存在 | 第三方包在 node_modules 里真的存在；`@deepseek-ai/*` 内置包由 app.asar 提供，不报错 |
| bundle patch | 每个第三方 bundle 声明的 `dsh.bundle.patch` 可读 |
| **孤儿 patch 行** | profile 里带 id 的行是否能对上可见 bundle 的 `insert`。对不上**只报告、不武断**：内置 bundle 的 patch 在 app.asar 内，离线无法确证 |
| 手写 insert 撞 id | 手写 `- insert:` 与 bundle 自带 insert 同 id → 树里两个 insert，可能拒绝启动 |
| 同 id 多行 | 合法覆盖语义；仅当两次都带完整 config 时警告（config 不深合并） |
| 依赖缺失 | 第三方 `dependencies` 是否落地 |
| peer 可解析 | 第三方 peer；跳过 `@deepseek-ai/*`（内置）与 react（shell 冻结表） |
| skill frontmatter | `name` 是否 kebab-case、`description` 是否非空；目录名不一致仅提示 |

### 关于"孤儿行"的正确说法

程序只会说"这个 id 未在任何**可读** bundle 的 insert 中出现"，并注明内置 bundle 无法离线确证。
**不要把它升级成"这段配置是死代码"** —— 除非你能证明对应包确实已卸载。
这是本工具刻意保留的保守性：宁可少报，不可误报。

---

## 自动捕获与沉淀：变更账本（reflect.mjs）

`check.mjs` 只看**当前状态**，看不出"我改了什么"。`reflect.mjs` 做的是**变更追踪 + 事故沉淀**，
这是防止"下次再犯"的核心机制。

### 能力边界（必须先讲清楚）

| 能力 | 自动化程度 |
|---|---|
| 捕获"状态突变"（改了哪个文件、哪一行、哪个字段） | ✅ 全自动，精确到 `provider: "<旧值>" -> "<新值>"` |
| 识别"越界改动"（装插件却改了全局模型配置） | ✅ 全自动，退出码 1 |
| 把问题归档、按类别聚合、统计复发次数 | ✅ 全自动 |
| 判定"这是真问题还是环境噪音" | ⚠️ 需 `confirm` 人工确认 |
| 写出"真正原因" | ❌ **工具不能推断**，必须人补 |

**根因无法自动化**——工具知道"`provider` 从 A 改成了 B"，
但不知道"你为什么改、这个改动会不会让对话失败"。所以草稿里 `真正原因` 一栏明确留空待补。

### 标准循环

```bash
# 以下命令都在技能根目录执行
node scripts/reflect.mjs snapshot --tag pre --note "要装某插件"

# 2) 做改动（安装 / 改配置）

# 3) 拍改动后
node scripts/reflect.mjs snapshot --tag post --note "装完"

# 4) 对比：声明这次"预期会动的 id"，其余动了就是越界
node scripts/reflect.mjs diff --from pre --to post --scope "<本次要装的插件/条目 id>"
```

`diff` 会输出字段级差异，并对**越界改动**报 ERROR：

```
── 配置行 ──
  [override] agent-default-model modified
      · provider: "<旧值>" -> "<新值>"

── ⚠ 越界/异常 ──
  ❌ 改动了全局配置行 "<全局条目 id>"（provider: "<旧值>" -> "<新值>"），但它不在本次声明的范围内
```

**这正是这类事故的精确复现**：如果当时跑了这一步，改 provider 的那一刻就会被拦下来。

哪些条目算"全局"，不同环境可能不同。内置一份常见清单（默认模型、权限、UI 等），
可按需覆盖：

```bash
node scripts/reflect.mjs diff --from pre --global-ids "agent-default-model,custom-global"   # 追加
node scripts/reflect.mjs diff --from pre --global-ids "" --reset-global-ids                  # 只用自己给的
```

### 事故沉淀

```powershell
node scripts/reflect.mjs record                 # 跑 check 并把问题归档到 incidents.jsonl
node scripts/reflect.mjs incidents              # 看按类别聚合的复发次数（🔁复发 x2 / ✅已确认）
node scripts/reflect.mjs confirm <fp> --note "原因"   # 确认真问题（判定需人做）
node scripts/reflect.mjs promote                # 对"复发≥2 或已确认"的类别生成 lessons.md 草稿
```

`promote` 输出的草稿里，**`真正原因` 和 `固化成的规则` 留空待补**——
补完后再追加进 `references/lessons.md`。工具负责"提醒你这类错误又犯了"，
你负责"想清楚为什么"。

### 数据位置（跨项目共享）

历史数据**不放在技能目录里**，而是放在 DSH 家目录下，这样同一台机器上
多个项目、多份技能副本都共用一份账本，复发统计才有意义。

解析顺序（先命中者生效）：

| 优先级 | 位置 | 说明 |
|---|---|---|
| 1 | `$DSH_ERROR_SELF_REFLECTION_DATA` | 显式指定（测试、便携盘） |
| 2 | `$DSH_HOME/error-self-reflection` | **默认落点**，整机共享 |
| 3 | `<skill>/data` | 兼容旧版：已有旧数据时沿用，不静默迁移 |

目录内容：

```
<数据目录>/snapshots/<tag>.json    快照（带 schema 版本，防旧快照失真）
<数据目录>/journal.jsonl           变更账本（每次 diff 追加一条）
<数据目录>/incidents.jsonl         事故归档 + 确认标记
```

`status` 会显示**当前实际使用的目录与来源**，不确定用了哪份时先看它。

从旧版升级（技能内 `data/` 已有数据）时，迁移到共享位置：

```bash
node scripts/reflect.mjs migrate-data          # 预览要迁移哪些文件
node scripts/reflect.mjs migrate-data --yes    # 执行（复制，不删旧的）
```

迁移是**复制**而非移动，且目标已存在同名文件时**跳过不覆盖**——
避免覆盖共享位置里更新的数据。确认无误后可自行删除旧的 `data/`。

三条命令看总览：

```powershell
node scripts/reflect.mjs status
node scripts/reflect.mjs journal
node scripts/reflect.mjs incidents
```

### 关于快照 schema 版本

快照里记 `schema` 版本。结构变化时 +1，**旧快照会被 `diff` 拒绝并提示重拍**——
因为缺少字段会让 diff 产生"全部新增"的假噪音。这个坑我踩过一次：
修复 `loadYaml` 之前拍的快照 `rows` 是 `null`，对比时报了 9 条假的"added"。

---

## 安装插件的标准流程

```
1. 拍基线 snapshot --tag pre --note "<要做什么>"
2. 备份 cordis.patch.yml 与 package.json
3. dsh plugin --profile <p> add <pkg>          # 让它自己写 bundles
4. 只加配置（override-by-id，不写 insert）
5. check.mjs                         # 结构校验
6. snapshot --tag post && diff --from pre --scope <预期id>   # 变更校验
7. 重启 → 验证实际生效值（不要只验证文件内容）
8. 出问题 → 备份回滚 → diff 确认回到基线 → record 归档
```

第 7 步最关键：重启后要检查**运行时返回值**（插件的 HTTP 路由、日志里的实际路由结果、
`/health` 状态），而不是只读配置文件。

### 局部验证（不碰全局配置）

`examples/` 下有三个隔离的假 profile，自带 `DSH_HOME`，可直接验证工具行为：

```bash
node examples/run.mjs      # 一键回归：好配置应全绿，坏配置应报错
```

单独跑某个：

```bash
DSH_HOME=examples/good/.dsh        node scripts/check.mjs --profile demo
DSH_HOME=examples/bad/.dsh         node scripts/check.mjs --profile broken
DSH_HOME=examples/bad-insert/.dsh  node scripts/check.mjs --profile collide
```

**不要用真实 profile 做试验。** 改动 `scripts/` 后跑 `node examples/run.mjs`，
它同时检查"能发现问题"和"不误报"两个方向。

## 更新这个 skill

把新事故追加到 `references/lessons.md`，格式：

```markdown
## N. <一句话结论>
- **症状**：
- **容易犯的误判**：
- **实际机制**：
- **规则**：<可执行的检查或步骤>
```

新增可自动检查的项，就加到 `scripts/check.mjs`，并在上面的表格里补一行。
**规则必须可执行，不写成感想。**

每次修改后必须：

```bash
node --check scripts/check.mjs
node --check scripts/reflect.mjs
node examples/run.mjs                            # 回归：好不误报、坏能抓到
node scripts/check.mjs --all --skills   # 自检：这个 skill 自己也要通过
node scripts/reflect.mjs status
```
