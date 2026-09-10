# dsh-plugins 维护说明

> 状态：Active
> 适用范围：本仓库的维护流程与插件实现细节
> 维护责任：修改对应流程或契约的提交者
> 最后核验：2026-09-10

本文件承载**维护者向**的内容。使用者视角的安装与用法见 [README](../README.md)，仓库级硬规则、变更路由与提交规范见 [AGENTS.md](../AGENTS.md)。三者分工：AGENTS.md 是**规则**，本文件是**详述**，README 只讲使用者看得见的东西。

## 包结构（为什么是混合包）

本包从 v0.2.4 起是**混合包**：tokprev 是纯浏览器 UI；tokstats 与 promptopt 含 host 半边实现（tokstats 扫 durable 会话日志聚合、checkpoint 增量、projection 下发；promptopt 注册 RPC 通道做一次旁路模型调用，**无磁盘状态**）。

## 发布到 GitHub

```powershell
git remote add origin git@github.com:PlusQi/dsh-plugins.git
git push -u origin master
git tag vX.Y.Z; git push origin refs/tags/vX.Y.Z   # 必做：#vX.Y.Z 固定安装靠它，漏打则该版本号装不上；显式 ref 而非 --tags
```

**打 tag 前的硬门槛**：link 安装目标提交 -> 重启 dsh web -> 刷新页面，目检**每个插件**的 UI 元素实际渲染。"启动无报错 ≠ 插件正常工作"——slot 注册是副作用，apply 提前返回或抛错都可能静默失效。目检不过不打 tag。

推上去即可被安装，无需注册表。`files` 字段保证 git 安装只带
`lib/` + `cordis.patch.yml`（pnpm 打包时自动附带 README / LICENSE / package.json）。

## 新增插件（本包的维护模式）

1. `lib/client.js` 的 `PLUGINS` 注册表加一段：`css` + **`ns`** + **`dicts`** + `apply(ctx)`（helpers、组件、词典、`ctx.slots.inject(...)` 注册块都放这段里）：
   ```js
   const LOCALE_NS_XXX = "dsh-plugins.xxx";
   const xxxZh = { "row.title": "标题" };
   const xxxEn = { "row.title": "Title" };
   // PLUGINS 内：xxx: { css: xxxCss, apply: xxxApply, ns: LOCALE_NS_XXX, dicts: { zh: xxxZh, en: xxxEn } }
   ```
   `npm run guard` 会拦下漏带 `ns` / `dicts` 的注册块；该插件确无任何界面文案时显式写 `ns: null`。
2. `cordis.patch.yml` 加一行（`name` 固定 `'dsh-plugins'`，`config.plugin` 指向注册表键；id 带自己的前缀，别撞 dsh-base/dsh-web-app 内置 id）：
   ```yaml
   - id: xxx
     name: 'dsh-plugins'
     config:
       plugin: xxx
   ```
3. **文案一律走词典**：slot 注册声明 `locale: ns` 取得标准席位 `t`，文案写成 `{name}` 占位符整句模板（英文按英文语序重写，不做片段拼接），带计数的文案按 `.one` / `.other` 成对出键；测试里调 `assertDictPair`（`test/client-harness.mjs`）断言 zh/en 键集一致——本包无构建步骤，官方那层编译期保障只能由它替代。术语对照见 [AGENTS.md](../AGENTS.md) 硬规则 7。
4. 在本地留存该插件的决策记录（不随仓库分发，供维护者回溯）；
5. 重启进程。**零安装操作。**

## 多插件结构的四条硬约束

（来自 DSH 本体，调整前先读）

- **client bundle 按包名发现**：host 按 entry 的 `name` 解析 `<name>/package.json` 读 `dsh.client` 声明，整包服务 `exports["./client"]`。行 name 必须是裸包名 `dsh-plugins`；写成 `dsh-plugins/xxx` 子路径只剩 host 半边（dsh-web-app 的 `web-startup` 行就是这种 host-only 子路径用法）。
- **client 模块图按包扁平**：一个包的 client 半边 = 一个模块节点，包内不能拆多文件（bundle factory 里的 `require` 只认模块表词，相对路径直接抛错）。所有插件共用 `lib/client.js` 单文件靠分段纪律维护，这是"无构建步骤"的边界。
- **host 按行分 fiber，client 每包单 fiber**：patch 每行建一个 **host** fiber，`config.plugin` 是 host 侧分发键（dsh-base 的 `tool-subagent` / `tool-subagent-fork` 是同名多行参考）。本包 `lib/index.js` 的 `apply(ctx, config)` 按该键分发：纯 UI 插件的 host 半边为空（行即存在/禁用锚点），tokstats 的 host 聚合器宿主在 `tokstats` 行的 fiber 上（行禁用 = 统计停摆）。**client 侧** **`__DSH_BOOT__`** **每包只建一个条目且不传 config**（`dsh-client-modules` 按包名构建 boot graph），因此 `lib/client.js` 的 apply 无条件注册 `PLUGINS` 全部插件，靠组件数据不可用时返回 null 降级；客户端不存在"第二行再跑一遍 apply"，也不可能在客户端按 `config.plugin` 分发。host 半边额外受模块图约束：pnpm link 安装下插件真实路径不在宿主 node\_modules 树内，**npm 包 import 不可解析**——`lib/index.js` 只用 `node:` 内建 + `apply(ctx, config)` 参数，不 import cordis/zod 等运行时依赖。
- **样式按插件分 tag**：每插件一个 `data-plugin-css="dsh-plugins/<id>"` tag（`ensurePluginStyles` 幂等注入、随包 fiber 停止移除）；保持插件块独立颗粒度，日后单插件独立成包时连样式原样带走。

插件长大了要独立发布/独立 repo？把注册块连同 patch 行复制出去单开包即可（可参考本仓库已有插件的实现与打包方式）。

## 插件的 host 侧行为与宿主契约

### tokprev

UI slot `conversation.composer.dock`、`conversation.chat.assistant-actions`；投影字段 `contextPressure` / `contextBreakdown`；`AssistantMessageNode.usage`。所有读取路径均带优雅降级（拿不到数据渲染 null，不会报错）。

### tokstats host 侧行为

- 启动异步扫盘（不阻塞 boot）：`listSnapshots` 对账 checkpoint（`$DSH_HOME/storages/tokstats-checkpoint.json`，键 `(sessionId, storage revision)`），只重扫日志变更过的会话；checkpoint 损坏自动全量重扫；
- 活会话 flush 后从上次 seq 增量续折，变更防抖落盘；
- 数据经 `sessionProjections` 通道（`tokstats` unit）下发；首次安装后需任一会话被打开或推送到达才有值（面板在此之前显示「统计中…」）；
- 全链路降级：persistence/projection 缺席不抛错，面板显示对应提示。

依赖：slot `sidebar.footer.action`（root scope，标准位仅 `useSessions`/`useWorkspaces`，projection 值从会话列表快照的 `projectionValues` 读）、host 服务 `ctx.sessionPersistence`（`listSnapshots`/`inspect`/`readStoredRevision`）与 `ctx.sessionProjections`（注册 `tokstats` unit）、事件 `session/flush`。

### promptopt host 侧行为

- 注册 RPC 通道 `/dsh-plugins.promptopt`（`ctx.connection.rpc.handle`，随本行 fiber 卸载即摘），端点 `optimize`；
- 收 `{ text }` → 加内置 meta-prompt → `ctx.llm.stream` 收集完整输出 → 返回 `{ text, durationMs, usage? }`。错误只回机器码（`bad-request` / `model-unavailable` / `internal` / `cancelled`），由浏览器侧查词典渲染——host 侧没有 locale 服务，不拼人类可读文案；
- 60s 双保险超时；浏览器 abort（关闭弹层）即中止这次调用；
- **降级**：`connection` 或 `llm` 服务缺席时通道不注册，点按钮显示「模型调用失败」而不是白屏；`connection` 用 `ctx.get` 惰性取而不是 `inject`——后者是硬依赖，缺席会连带 tokprev / tokstats 一起不加载。

依赖：UI slot `conversation.input.right`（composer 卡片**内部**工具行）；`InputActions.setDraft` 与 `InputState`（`draft` / `imageIds` / `occurrences` / `claim`）；客户端服务 `ctx.connection.rpc.call`；host 服务 `ctx.connection.rpc.handle`（`authority: "trusted-host"`）与 `ctx.llm`（`stream` / `listProviders` / `listModels`）。

DSH 升级后若按钮点了没反应或一直报错，先对照这些契约——尤其是 RPC 响应信封（成功必须是 `{ ok: true, value }`，错误码取自宿主闭集）与 `GenerateOptions` 的 `provider` / `model` 必填约束。

### 触发位置的迁移史

v0.5.0 起初把 promptopt 放在 `conversation.composer.dock`（与 tokprev 预告行同带），实际用起来发现 dock 是宿主契约标注的「环境读数带」、可点控件本就该在 tool row——v0.5.1 挪到 `conversation.input.right` 符合「发送前顺手点」的操作逻辑。

## 维护须知

- **无构建步骤**：`lib/client.js` 即最终产物（纯 JS，不用 TS/JSX，React 经 ModuleLoader 注入）。改动 = 编辑 + 重启。`lib/index.js`（host 半边）同为纯 JS：只 import `node:` 内建（fs/os/path），不引 npm 运行时依赖。
- **兼容面**：tokprev 依赖 UI slot 契约与投影字段；tokstats 依赖 `sidebar.footer.action` slot、`ctx.sessionPersistence`、`ctx.sessionProjections` 与 `session/flush` 事件；promptopt 依赖 `conversation.input.right` slot、`InputActions.setDraft`、`ctx.connection.rpc.call`、`ctx.connection.rpc.handle` 与 `ctx.llm`（明细见上节）。界面文案另依赖客户端服务 `ctx.locale`（注册词典 + slot 注册声明 `locale` 命名空间取得 `t` 席位）——它是硬依赖，缺席时整包不加载。DSH 升级后若插件消失，先对照这些契约。所有读取路径均带优雅降级（拿不到数据渲染 null，不会报错）。
- **开发所对版本**：DSH `@deepseek-ai/dsh 0.1.1-rc.2`。host 侧 RPC 与 LLM 契约是**一次性压三个深契约**（`InputActions` / `connection.rpc` / `llm.stream`），且 rc 阶段官方保留破坏权——升级后 promptopt 优先重验：信封形状（成功必须是 `{ ok: true, value }`，错误码取自宿主闭集）、`GenerateOptions` 的 `provider` / `model` 是否仍必填、`connection.rpc.handle` 的调用路径与 `options.authority` 是否仍存在。
- **开发循环**：先用动态 Cordis 插件（`cordis_define` -> `cordis_run`）在会话内热迭代原型，满意后落入本包。
- **单插件开关的真实语义**：`disabled: true` 只摘除该行的 **host 侧** fiber，浏览器侧 bundle 是否加载取决于**包内是否还有任一行存活**（DSH 的 boot graph 按包名判活，客户端每包一个 fiber、无条件注册全部插件）。对 tokstats 这类 host 半边有实际工作的插件，禁用行即停掉聚合器与统计（客户端按钮还在但无数据）；对 tokprev 这类纯 UI 插件，禁用一行**不会**移除其浏览器 UI（tokstats 行会让整个 bundle 存活）。需要按插件独立开关，请把该插件独立成包（见「新增插件」末尾）。
