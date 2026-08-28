# 仓库 Agent 约束

> 状态：Active
> 适用范围：整个仓库
> 最后核验：2026-08-28
> 维护责任：修改仓库级约束的提交者

本文件是维护者与 AI Agent 进入仓库的执行入口。使用者视角的安装/发布说明见 [README.md](./README.md)，两者不重复承载内容。

## 优先级

```latex
宿主兼容契约（UI slot / 投影字段，见 README「维护须知」）
  > 本文件硬规则
  > README 维护说明（「新增插件」「多插件四条硬约束」详述）
  > 本地 Active spec（docs/specs/active/，进行中变更的 SDD 四件套；本地不随仓库分发，完成验收后回填并归档）
  > 本地设计记录（docs/specs/archive/ 与 docs/debug/，仅历史证据，不随仓库分发，不约束当前实现）
```

工程方法层参考本地指南（`docs/project-engineering-guardrails-guide.zh-CN.md`，不随仓库分发）：spec 反空壳与状态门（§7.7–7.8）、完成后的生命周期迁移映射（§5.8）。指南是方法论，不参与上表优先级仲裁。

同级约束冲突且无法按上表裁决时，**停顿询问维护者**，不得自动选择。

## 按变更范围读取

| 变更 | 必读材料 | 最低验证 |
| --- | --- | --- |
| `lib/client.js` 任意改动 | 本文件硬规则 + README「维护须知」 | `node scripts/check-plugin-structure.js` + 重启 dsh web 目检 |
| 新增插件 | README「新增插件」四步；模式参考本地 SPEC-tokprev §11 | 同上 |
| `cordis.patch.yml` | 本文件硬规则 1 / 3 | `node scripts/check-plugin-structure.js` |
| `package.json`（dsh 声明 / exports / files） | README「发布到 GitHub」 | link 安装后重启目检 |
| SDD 文档（`docs/specs/active/`） | 本地指南 §5.4 / §7.7–7.8 + 该变更的 SPEC | 状态头字段完整 + 交叉链接可达 |
| 纯文档 / 图片 | — | 链接可达性检查 |

## 硬规则

1. **patch 行 name 必须是裸包名 `'dsh-plugins'`**：client 半边按包名发现；写成子路径只剩 host 半边；
2. **client 模块图按包扁平**：所有插件实现在 `lib/client.js` 单文件内，禁止拆分文件或使用相对路径 `require`（factory 的 require 只认模块表词）；
3. **host 按行分 fiber，client 每包单 fiber**：patch 每行建一个 host fiber（`config.plugin` 是 host 侧分发键）；client boot manifest 每包只建一个条目且不传 config，`lib/client.js` 的 apply 无条件注册 `PLUGINS` 全部插件。新增插件必须同时在 `PLUGINS` 注册表注册，由 guard 静态校验防漂移（v0.2.3 前的"客户端按 config 分发 + 未注册告警"模型已废弃）；
4. **每插件独立样式 tag**：经 `ensurePluginStyles` 注入 `data-plugin-css="dsh-plugins/<id>"`，禁止包级共享 `<style>`；
5. **无构建步骤**：`lib/client.js` 即最终产物，禁止引入 TS / JSX / 构建脚本 / npm 运行时依赖；
6. **兼容面**：所有宿主数据读取路径必须保持优雅降级（拿不到数据渲染 null，不抛错）。

规则 1 / 3 / 4 及 2 的 require 部分由 `scripts/check-plugin-structure.js` 自动检查（L1 静态证据）。规则 5 / 6 依赖评审，无自动检查。

## Git 提交规范

**格式**：`<scope>: <一句话摘要>`（subject ≤ 72 字符，细节动机移入 body）。scope 用小写标识符，推荐集合：

| scope | 覆盖 |
| --- | --- |
| `tokprev`（或插件名） | `lib/client.js` 内该插件的实现块 |
| `pack` | 包结构：`cordis.patch.yml` / `package.json` / `lib/index.js` / 共享设施 |
| `docs` | 文档、图片 |
| `release` | CHANGELOG、tag、发布相关 |
| `repo` | 工程治理：AGENTS.md、hooks、guard 脚本 |

scope 的权威来源：插件名 = `PLUGINS` 注册表键（`lib/client.js`），插件改名/移除后旧 scope 引用即成悬空历史，仅存于历史提交不回收。

**硬约束**：

1. **职责单一**：一个提交一个意图；插件实现与包结构改动分开提交（评审时能独立判断行为影响）；
2. **行为变化必须进 subject 可见范围**：禁止把功能/行为改动伪装成 `docs:` / `repo:`（语义欺骗，hook 拦不住，靠评审）；
3. **确实无法拆分时**：在 body 写明混合原因与各部分验证，不得静默混提。

**body 约定**：

- subject 与 body 之间空一行；
- body 写动机与取舍（为什么这么做），不重复 diff 内容；
- 混合提交（约束 3）在 body 分行列出各部分及其验证方式；
- 例外标记：`Policy-Exception: <原因> -- <无法拆分/验证的说明>`，一条提交至多一条，理由为空视为无豁免。

## 分支命名规范

默认直推 `master`（单人维护无 PR 流程）。需要多线并行（原型试验、多插件并行开发）时开分支，命名 `<kind>/<scope>-<slug>`：

| kind | 用途 |
| --- | --- |
| `feat` | 新插件或插件功能扩展（`feat/tokprev-export`） |
| `fix` | 插件缺陷修复（`fix/tokprev-badge-rounding`） |
| `repo` | 工程治理变更（`repo/hooks-ci`） |

约定：`<scope>` 与提交 scope 同源（插件名 / pack / repo），slug 用小写连字符；分支生命与一个意图绑定，合回 master 后删除，不长期存活。

**闸门分层**（`scripts/git/hooks/`，经 `core.hooksPath` 启用）：

| 时点 | 机制 | 拦什么 |
| --- | --- | --- |
| 提交时 | `commit-msg` hook | 空信息、格式不符、全角冒号、超长 |
| 推送时 | `pre-push` hook | 重跑结构 guard（覆盖 `--no-verify` 漏网提交） |

注意（指南共识）：本地 hook 可被 `git push --no-verify` 绕过，本仓库单人维护无 CI，最终防线是规范自觉；merge / revert 自动提交直接放行。新 clone 启用方式：

```powershell
git config core.hooksPath scripts/git/hooks
```


## 交付信息

任何代码交付时报告：

- 改动范围（文件 + 行为变化判断）
- 已执行验证（guard 命令输出 + 是否目检）
- 未执行验证及原因
- 剩余风险与回滚方式（通常为 `git revert` 单提交）
