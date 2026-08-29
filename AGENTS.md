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
| `lib/client.js` 任意改动 | 本文件硬规则 + README「维护须知」 | `npm test`（含 client 浅渲染断言）+ `node scripts/check-plugin-structure.js` + 重启 dsh web 目检 |
| `lib/index.js`（host 半边，tokstats 聚合器） | 本文件硬规则 5 的 host 延伸（只用 `node:` 内建，npm 包 import 不可解析）+ 本地 SPEC-tokstats §3/§9 | `npm test`（host 管线断言）+ 重启 dsh web 目检四表 |
| `test/`（测试套件） | 对应被测模块 + 现有用例 | `npm test` |
| 新增插件 | README「新增插件」四步；模式参考本地 SPEC-tokprev §11；含 UI 文案的还需本文件硬规则 7（词典 ns + `locale` 声明） | 同上 |
| `cordis.patch.yml` | 本文件硬规则 1 / 3 | `node scripts/check-plugin-structure.js` |
| `package.json`（dsh 声明 / exports / files） | README「发布到 GitHub」 | link 安装后重启目检 |
| SDD 文档（`docs/specs/active/`） | 本地指南 §5.4 / §7.7–7.8 + 该变更的 SPEC | 状态头字段完整 + 交叉链接可达 |
| 纯文档 / 图片 | — | 链接可达性检查 |

## 硬规则

1. **patch 行 name 必须是裸包名 `'dsh-plugins'`**：client 半边按包名发现；写成子路径只剩 host 半边；
2. **client 模块图按包扁平**：所有插件实现在 `lib/client.js` 单文件内，禁止拆分文件或使用相对路径 `require`（factory 的 require 只认模块表词）；
3. **host 按行分 fiber，client 每包单 fiber**：patch 每行建一个 host fiber（`config.plugin` 是 host 侧分发键，`lib/index.js` 的 `apply(ctx, config)` 据此分发——纯 UI 插件 host 半边为空，tokstats 的聚合器宿主在自己的行 fiber 上）；client boot manifest 每包只建一个条目且不传 config，`lib/client.js` 的 apply 无条件注册 `PLUGINS` 全部插件。新增插件必须同时在 `PLUGINS` 注册表注册，由 guard 静态校验防漂移（v0.2.3 前的"客户端按 config 分发 + 未注册告警"模型已废弃）；
4. **每插件独立样式 tag**：经 `ensurePluginStyles` 注入 `data-plugin-css="dsh-plugins/<id>"`，禁止包级共享 `<style>`；
5. **无构建步骤**：`lib/client.js` 即最终产物，禁止引入 TS / JSX / 构建脚本 / npm 运行时依赖；host 半边 `lib/index.js` 同理零依赖——只许 import `node:` 内建（fs/os/path 等），npm 包（含 cordis/zod）在 pnpm link 安装路径下不可解析；
6. **兼容面**：所有宿主数据读取路径必须保持优雅降级（拿不到数据渲染 null，不抛错）；
7. **每插件自带词典，语言跟随宿主**：`PLUGINS` 条目带 `ns`（`dsh-plugins.<id>`，带包前缀防撞车——重复注册同 `(ns, locale)` 会抛）与 `dicts`（`{ zh, en }`，zh 为键集真源，en 必须逐键对应）；slot 注册声明 `locale: ns` 取得 `t` 席位；`locale` 是硬依赖（与官方 UI 包一致），宿主无 locale 服务时整包不加载。文案一律写成 `{name}` 占位符整句模板（英文语序独立），带计数的文案按 `.one` / `.other` 成对出键。非语言记号（K/M、桶区间、`¥`）与时间格式（固定 24 小时制）不进词典。

规则 1 / 3 / 4 及 2 的 require 部分由 `scripts/check-plugin-structure.js` 自动检查（L1 静态证据）。规则 5 / 6 / 7 依赖评审，无自动检查——其中 7 的键集一致性由 `npm test` 的双向断言兜住（官方靠 TS 类型在编译期保证，我们没有构建步骤）。

## Git 提交规范

本仓库采用 [Conventional Commits](https://www.conventionalcommits.org/)（约定式提交）标准，与 Angular / React / Vue / Next 等开源项目对齐。提交信息由 header、body、footer 三段组成：

```
<type>(<scope>): <subject>
<空行>
<body>            # 可选
<空行>
<footer>          # 可选：BREAKING CHANGE / Closes / Fixes / Refs
```

**type（必填，小写）**：回答「改了什么性质」。推荐集合（基于 `@commitlint/config-conventional`）：

| type | 含义 | 触发版本 |
| --- | --- | --- |
| `feat` | 新功能 / 新插件 / 插件功能扩展 | MINOR |
| `fix` | 缺陷修复 | PATCH |
| `docs` | 文档、图片、README/CHANGELOG 内容 | — |
| `style` | 格式调整（空格/分号/排版，不影响运行） | — |
| `refactor` | 重构（非修非增的代码改动） | — |
| `perf` | 性能优化 | — |
| `test` | 测试（增/改用例） | — |
| `build` | 构建系统或外部依赖变更 | — |
| `ci` | CI 配置与脚本 | — |
| `chore` | 杂务（不产生用户影响的维护） | — |
| `revert` | 回退某次提交 | — |

`BREAKING CHANGE`（破坏性变更）：在 type/scope 后加 `!`（如 `feat(api)!:`），或在 footer 写 `BREAKING CHANGE: <描述>`，触发 MAJOR。

**scope（可选，小写连字符）**：回答「改了哪块」。权威来源是 `PLUGINS` 注册表键（`lib/client.js`）：

| scope | 覆盖 |
| --- | --- |
| 插件名（`tokprev` / `tokstats` / …） | 该插件的实现块，**含 `lib/client.js` 的 client 块与 `lib/index.js` 中该插件的 host 分发逻辑**（混合插件的 host 半边沿用插件名 scope，不归 `pack`） |
| `pack` | 包级通用设施与分发框架：`cordis.patch.yml` / `package.json` / `lib/index.js` 中 pack 级分发逻辑 / 共享设施（**不含**某插件的 host 实现） |
| `repo` | 工程治理文件：AGENTS.md、hooks、guard 脚本、本规范自身 |

scope 可省略：跨多模块或纯性质类提交（如 `docs: 修正错别字`、`chore: 升级依赖`）。插件改名/移除后旧 scope 引用即成悬空历史，仅存于历史提交不回收。

**subject（必填，≤72 字符）**：一句话摘要，祈使句、小写开头、结尾无句号（与 Git 自动生成的 Merge/Revert 语气一致）。只讲 what，why 留给 body。

**硬约束**：

1. **职责单一**：一个提交一个意图；插件实现与包结构改动分开提交（评审时能独立判断行为影响）；
2. **行为变化必须进 subject 可见范围**：禁止把功能/行为改动伪装成 `docs:` / `chore:`（语义欺骗，hook 拦不住，靠评审）；
3. **确实无法拆分时**：在 body 写明混合原因与各部分验证，不得静默混提。

**body / footer 约定**：

- subject 与 body 之间空一行；
- body 写动机与取舍（为什么这么做），不重复 diff 内容；每块以 `- ` 开头、续行缩进两空格、块间空一行——裸段落堆在一起时扫读分不出有几条动机、哪几句在讲取舍，加前缀后块数一眼可数；
- 混合提交（约束 3）在 body 分行列出各部分及其验证方式，并用 footer 的 `Policy-Exception: <原因>` 标记——`commit-msg` 只允许带该标记的 body 出现「验证：」行。非混合提交不写验证结果：每类变更的最低验证见「按变更范围读取」表，逐提交复述即噪音。包级改动（`pack`）与插件级改动同批时尤其要列清，例如：`分发框架：lib/index.js apply 分发；插件 patch 行：cordis.patch.yml；测试入口：test/*.test.mjs`。
- 关联 issue 用 footer：`Closes #123` / `Fixes #456`（自动关闭）、`Refs #789`（仅引用）。
- 例外标记：`Policy-Exception: <原因> -- <无法拆分/验证的说明>`，一条提交至多一条，理由为空视为无豁免。

## 分支命名规范

默认直推 `master`（单人维护无 PR 流程）。需要多线并行（原型试验、多插件并行开发）时开分支，命名 `<kind>/<scope>-<slug>`：

| kind | 用途（与提交 type 集合对齐） |
| --- | --- |
| `feat` | 新插件或插件功能扩展（`feat/tokstats-export`） |
| `fix` | 插件缺陷修复（`fix/tokstats-badge-rounding`） |
| `chore` | 工程治理 / 杂务变更（`chore/hooks-ci`） |
| 其他 type | 同提交 type：`docs` / `refactor` / `perf` / `test` / `build` / `ci` / `revert` |

约定：`<scope>` 与提交 scope 同源（插件名 / pack / repo），slug 用小写连字符；分支生命与一个意图绑定，合回 master 后删除，不长期存活。

**闸门分层**（`scripts/git/hooks/`，经 `core.hooksPath` 启用）：

| 时点 | 机制 | 拦什么 |
| --- | --- | --- |
| 提交时 | `commit-msg` hook | 空信息、非 `<type>(<scope>?): <摘要>` 格式、全角冒号、超长(72)、body 出现「验证：」但无 `Policy-Exception` 声明 |
| 推送时 | `pre-push` hook | 重跑结构 guard（覆盖 `--no-verify` 漏网提交） |

注意（指南共识）：本地 hook 可被 `git push --no-verify` 绕过，本仓库单人维护无 CI，最终防线是规范自觉；merge / revert 自动提交直接放行。新 clone 启用方式：

```powershell
git config core.hooksPath scripts/git/hooks
git config commit.template scripts/git/commit-template.txt
```

提交模板是骨架的兜底提醒：`git commit`（不带 `-m`）时编辑器自动带出 type / scope / body 格式要点，不必回翻本文件。模板全是注释行，编辑器提交时由 git 剥除，不会进提交信息。


## 交付信息

任何代码交付时报告：

- 改动范围（文件 + 行为变化判断）
- 已执行验证（guard 命令输出 + 是否目检）
- 未执行验证及原因
- 剩余风险与回滚方式（通常为 `git revert` 单提交）
