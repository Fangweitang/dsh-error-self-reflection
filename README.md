# dsh-error-self-reflection

> **把每一次配置事故，变成下一次自动拦截的检查。**

一个给 **DeepSeek Harness（DSH）** 用的错误自省工具。
它做三件事：**捕获**配置变更 → 精确比对到字段 → **拦截**越界改动；
再把问题**归档**、按类别统计**复发**，最后**沉淀**成可复用规则。

---

## 为什么有这个东西

起因是一次真实的翻车：

装某个 DSH 插件时，在 profile 里看到一个 `provider` 值，但在代码库里搜不到它的注册语句，
于是判断"这是失效配置"，顺手改成了自己认为正确的 provider。
结果**整个应用开始出问题**——因为改的不是插件的局部配置，而是**全局默认模型**。

更麻烦的是：当时我"验证"过了。健康检查返回正常、配置文件能被解析、依赖都能 import，
于是宣称"已实测通过"。但真正决定行为的是**组合后的运行时取值**，而我一次都没查。

复盘出的三条结论，构成了这个工具的设计：

1. **"搜不到"不等于"不存在"** —— provider 可能由内置 bundle 或远程配置提供。以实际运行为准。
2. **验证必须覆盖最终产物** —— 中间环节全绿，不代表最终生效。
3. **一次只改一个变量** —— 装插件不该动全局配置，改错了很难追溯到这次安装。

于是有了两个工具和一份规则清单。

---

## 它提供什么

### 一、静态结构检查（`scripts/check.mjs`）

装完插件、改完配置后跑一遍，抓那些**静默失效**的坑：

| 检查项 | 抓什么 |
|---|---|
| YAML 可解析 | BOM、语法错误（给出精确行号） |
| 粘贴残留 | `</li>`、`<br>` 等混入的非说明性行 |
| 编码损坏 | 真实 U+FFFD 替换字符（不是终端显示问题） |
| bundle 存在 | 第三方包是否真的落在 `node_modules`；内置包不误报 |
| bundle patch | 每个 bundle 声明的 `dsh.bundle.patch` 是否可读 |
| **手写 insert 撞 id** | profile 手写 `insert` 与 bundle 自带 `insert` 同 id → 可能拒绝启动 |
| **孤儿配置行** | 配置行 id 对不上任何可读 bundle 的插入（**只报告，不武断**，见下方边界） |
| 同 id 多行 | 覆盖语义合法；仅当两次都带完整 config 时警告 |
| 依赖 / peer | 第三方依赖是否落地、peer 是否可解析 |
| skill frontmatter | `name` 是否 kebab-case、`description` 是否非空 |

### 二、变更拦截与沉淀（`scripts/reflect.mjs`）

这是**主线能力**：不只检查现状，而是追踪"你改了什么、该不该改、犯过几次"。

```bash
# 动手前拍基线
node scripts/reflect.mjs snapshot --tag pre --note "要装某插件"

# ... 做改动 ...

# 对比：声明预期会动的 id，其余动了就是越界
node scripts/reflect.mjs diff --from pre --scope "<预期id>"
```

输出**字段级**差异，并对越界改动报 ERROR：

```
── 配置行 ──
  [override] <全局条目> modified
      · provider: "<旧值>" -> "<新值>"

── ⚠ 越界/异常 ──
  ❌ 改动了全局配置行 "<全局条目>"（provider: "<旧值>" -> "<新值>"），但它不在本次声明的范围内
      ↳ 装插件不该改全局默认模型/权限等配置，这会影响所有会话
```

然后沉淀：

```bash
node scripts/reflect.mjs record      # 跑检查并把问题归档
node scripts/reflect.mjs incidents   # 按类别看复发次数（🔁 x2 / ✅已确认）
node scripts/reflect.mjs confirm <fp> --note "原因"  # 人工确认真问题
node scripts/reflect.mjs promote     # 生成 lessons 草稿
```

---

## 快速开始

### 安装

放到 DSH 的 skill 扫描根之一即可（目录形式 `<name>/SKILL.md`）：

```bash
# 用户级（对所有项目生效）
git clone <this-repo> ~/.agents/skills/dsh-error-self-reflection

# 或项目级
git clone <this-repo> <project>/.agents/skills/dsh-error-self-reflection
```

DSH 扫描这些位置：`<project>/.dsh/skills`、`<project>/.agents/skills`、
`~/.dsh/skills`、`~/.agents/skills`。新开会话即可看到 `dsh-error-self-reflection`。

**依赖**：Node.js ≥ 18。YAML 解析器会从 DSH profile 的 `node_modules` 自动借用
（`js-yaml` 或 `yaml`，DSH 环境里通常自带）。找不到时报 ERROR 并提示安装，**不会静默跳过检查**。

### 跑

```bash
node scripts/check.mjs --profile <name>          # 结构检查
node scripts/check.mjs --all --skills            # 全部 profile + 技能
node scripts/check.mjs --all --skills --strict   # WARN 也算失败（适合 CI）

node scripts/reflect.mjs status                  # 看快照/账本/归档总览
node examples/run.mjs                            # 验证工具本身
```

---

## 能力边界（重要，请先读这一段）

这个工具最容易被误解的地方：它不是"装完就自动变正确"的魔法。

| 能自动 | 不能自动 |
|---|---|
| 捕获状态变化，精确到字段 | 判断"这是真问题还是环境噪音" |
| 检测越界改动 | 写出根因（工具只能看到"A 变成 B"） |
| 按类别聚合、统计复发 | 决定该不该回滚 |
| 生成复盘草稿 | 替你想清楚为什么 |

`promote` 生成的草稿里，根因字段会显式标注 `（待补——工具无法推断）`。
**这是刻意保留的诚实边界，不是未完成功能。**

另一个边界：`check.mjs` 只证明**配置结构正确**，**不证明运行时生效**。
重启后仍需检查运行时返回值（插件 HTTP 路由、日志、健康检查）。

**关于"孤儿配置行"**：内置 bundle 的补丁打包在 `app.asar` 内，工具读不到，
所以对"配置行对不上任何可读 bundle"只能报告**无法离线确证**，不做确定性断言。
宁可少报，不可误报——误报会让人放弃工具，这是更坏的结果。

---

## 适用版本与限制

**已测试环境**

| 项 | 版本 |
|---|---|
| DeepSeek Harness | `0.2.1-rc.2` |
| `@deepseek-ai/dsh-base` | `0.2.1-rc.2`（补丁语义来源） |
| `@deepseek-ai/dsh-skill-filesystem` | `0.2.1-rc.2`（skill 扫描根规则来源） |
| Node.js | `≥18`（实测 25.2.1） |
| 操作系统 | Windows 10 x64 实测；脚本为跨平台 Node，未在 Linux/macOS 实测 |

**依赖的 DSH 内部结构**（版本变化可能让检查项失效）：

- profile 的 `cordis.patch.yml` 补丁语义（`insert` / override-by-id）
- `package.json` 的 `dsh.profile.bundles` 声明与 `dsh.bundle.patch` 指向
- skill 扫描根的优先级顺序与 frontmatter 解析规则

**如果你用的 DSH 版本不同**：先跑 `node examples/run.mjs` 确认基线行为符合预期，
再用于真实环境。检查项失效时，工具倾向于报 ERROR 而非静默通过。

**其它限制**

- 仅面向 DSH，不适用于其它框架的配置文件
- 不内置 YAML 解析器（YAML 含多行字符串/锚点，误解析比不解析更危险）
- 文档示例用 PowerShell（Windows 习惯），命令本身不绑定 shell

---

## 目录结构

```
dsh-error-self-reflection/
├── SKILL.md                  # 技能说明：铁律 + 标准流程
├── references/
│   └── lessons.md            # 15 条故障模式与规则（已脱敏）
├── scripts/
│   ├── check.mjs             # 静态结构检查
│   └── reflect.mjs           # 快照 / diff / 归档 / 复发 / 沉淀
├── examples/
│   ├── run.mjs               # 一键回归测试
│   ├── good/                 # 正确写法（应全绿）
│   ├── bad/                  # BOM + 残留 + 缺依赖（应报错）
│   └── bad-insert/           # insert 撞 id（应报错）
└── data/                     # 运行时生成（已被 .gitignore 忽略）
```

---

## 验证工具本身

```bash
node examples/run.mjs
```

跑三个隔离的假 profile（**不读也不改你的真实配置**），验证：

- ✅ 正确写法**不误报**
- ✅ BOM / 粘贴残留 / YAML 错误 / 缺依赖**能抓到**
- ✅ 手写 `insert` 撞 bundle `insert`**能抓到**
- ✅ `diff` 能捕获字段级改动并报越界
- ✅ 还原后 diff 回到"无变化"

改完 `scripts/` 后请务必跑一遍：**校验工具最大的风险是误报让人弃用，或漏报给出虚假安全感。**

---

## 一个使用示例

真实工作流：

```
1. node scripts/reflect.mjs snapshot --tag pre --note "装 X 插件"
2. dsh plugin --profile <name> add X
3. 只加配置（override-by-id，不写 insert）
4. node scripts/check.mjs --profile <name>
5. node scripts/reflect.mjs diff --from pre --scope "X"
   → 如果这里报"改动了全局配置行"，停手，确认是否本意
6. 重启 → 验证运行时实际取值（不要只读文件）
7. 出问题 → 备份回滚 → diff 确认回到基线 → record 归档
```

---

## License

Apache-2.0，见 [LICENSE](LICENSE)。

非官方工具，与 DeepSeek 官方无隶属关系。
