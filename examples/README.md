# examples — 用来验证工具真的能发现问题

三个隔离的假 profile，**不会读取或修改你本机的真实配置**。
每个目录自带 `DSH_HOME`，通过环境变量指过去即可。

## 跑法

```bash
# 正确的写法：应全部通过
DSH_HOME=examples/good/.dsh node scripts/check.mjs --profile demo

# YAML 损坏（BOM + 粘贴残留 + 缺依赖）：应报多个 ERROR
DSH_HOME=examples/bad/.dsh node scripts/check.mjs --profile broken

# YAML 合法，但手写 insert 与 bundle 自带 insert 撞 id：应报 1 个 ERROR
DSH_HOME=examples/bad-insert/.dsh node scripts/check.mjs --profile collide
```

PowerShell：

```powershell
$env:DSH_HOME = "examples/good/.dsh"
node scripts/check.mjs --profile demo
```

## 预期结果

| 示例 | 预期 | 验证了什么 |
|---|---|---|
| `good/` | `ERROR 0` | override-by-id 是正确写法；内置包不会被误报为缺失 |
| `bad/` | `ERROR ≥ 3` | 能抓到 BOM、粘贴残留、YAML 语法错误、缺依赖；且**解析失败后仍继续检查其他项** |
| `bad-insert/` | `ERROR 1` | 能抓到"手写 insert 撞 bundle insert"这个会导致启动失败的错误 |

## 为什么要有这些

一个校验工具最大的风险是**误报**（让人放弃使用）和**漏报**（给了虚假的安全感）。
这两个方向都只能靠对照样本证明。改动 `scripts/` 后请重跑上面三条，
确认 `good/` 仍然全绿、`bad*/` 仍然报错。

## 结构说明

每个示例都是最小的 DSH profile 形状：

```
<example>/.dsh/profiles/<name>/
├── cordis.patch.yml          # 补丁层
├── package.json              # dependencies + dsh.profile.bundles
└── node_modules/<pkg>/       # 假装已安装的第三方 bundle
    ├── package.json          # 带 dsh.bundle.patch 声明
    └── cordis.patch.yml      # 它自己的 insert 行
```

`@deepseek-ai/*` 前缀的包被当作框架内置包，不要求真实存在于 `node_modules`。
