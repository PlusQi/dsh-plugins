# dsh-plugins 维护说明

> 状态：Active
> 适用范围：本仓库的维护流程与插件实现细节
> 维护责任：修改对应流程或契约的提交者
> 最后核验：2026-09-10

本文件承载**维护者向**的内容。使用者视角的安装与用法见 [README](../README.md)，仓库级硬规则、变更路由与提交规范见 [AGENTS.md](../AGENTS.md)。三者分工：AGENTS.md 是**规则**，本文件是**详述**，README 只讲使用者看得见的东西。

## 包结构（为什么是混合包）

本包从 v0.2.4 起是**混合包**：tokprev 是纯浏览器 UI；tokstats 与 promptopt 含 host 半边实现（tokstats 注册一个 per-session 投影单元，持久化交给官方会话投影缓存；promptopt 注册 RPC 通道做一次旁路模型调用，计数器落官方存储域）。**两个 host 半边都不写 `$DSH_HOME` 下的自有文件**——这是 v0.6.0 起的硬约束，由结构 guard 静态把关。

## 发布到 GitHub

```powershell
git remote add origin git@github.com:PlusQi/dsh-plugins.git
git push -u origin master
git tag vX.Y.Z; git push origin refs/tags/vX.Y.Z   # 必做：#vX.Y.Z 固定安装靠它，漏打则该版本号装不上；显式 ref 而非 --tags
```

**打 tag 前的硬门槛**：link 安装目标提交 -> 重启 dsh web -> 刷新页面，目检**每个插件**的 UI 元素实际渲染。"启动无报错 ≠ 插件正常工作"——slot 注册是副作用，apply 提前返回或抛错都可能静默失效。目检不过不打 tag。

推上去即可被安装，无需注册表。`files` 字段保证打包形态（git 安装 / npm 安装都走打包）只带运行必需件加文档：
`lib/` + `cordis.patch.yml` + `AGENTS.md` / `CHANGELOG.md` / `docs/MAINTAINING.md`（README / LICENSE / package.json 由打包器自动附带，不必列）。

`docs/assets/` 的四张截图**不进包**（1.1MB，看 GitHub 上的 README 就够）：包内 README 的文本链接可达，但效果图会裂。要连图一起带，把 `docs/assets` 加进 `files`。

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

UI slot `conversation.composer.dock`（**只此一个**：`conversation.chat.assistant-actions` 的每轮徽标已在 v0.6.0 删除，官方 TurnUsagePanel 已覆盖该信息）；投影字段 `contextPressure`（**只此一个**：`contextBreakdown` 依赖已删）；`AssistantMessageNode.usage`（仅取输出历史算 P25–P75）。所有读取路径均带优雅降级（拿不到数据渲染 null，不会报错）。

### tokstats host 侧行为（v0.6.0 起）

架构：**注册一个 per-session 投影单元**，持久化与冷启动交给官方管线，本插件不写任何自有文件。

- **单元**：`key: "tokstats"`、`stateVersion: 2`、`state: { w, seed, epoch, rows, last }`。宿主 `ctx.sessionProjections` 在每个已提交事件上驱动 `apply`；`init(header, inheritedEventCount)` 记下 `w`（会话自身 cwd）与 `seed`（fork 继承前缀长度）。
- **必须带 `wire`**：只有带 wire 块的单元才出现在 `snapshot` / `cachedSnapshot` / `viewCheckpoint` / `restore` 的公开读取面上（host-only 单元被全部跳过）。`wire.view` 只返回 `{ w, e, rows }`——浏览器侧拿不到 provider/model，也拿不到跨会话聚合。
- **折叠语义**：计费输入 = `in + cr + cw` 落 2 的幂桶；`seq < seed` 的样本跳过（fork 前缀父会话已计过）；同 `(turn, step)` 的后一样本替换前一样本（差值法：先减旧再加新，跨桶也正确）；无关事件返回同一引用（`Object.is` 成立）。
- **E1 折叠**：窗口（`config.windowDays`，缺省 90）之外的明细按桶加进 `epoch.buckets`，`rows` 本体不删不改；读取期按 `[epoch.start, epoch.end)` 排除明细并改计 epoch 合计，因此「折叠前后明细条数不变、各桶数字逐项一致」两条同时成立。
- **汇总**：面板打开时经 RPC 现算。逐会话先 `cachedSnapshot(meta, ["tokstats"])`（零 I/O），取不到才 `readSession` + `coldSnapshot` 冷折叠兜底。根工作区在汇总侧按 `listSessions()` 的 header 链解析（`init` 拿不到 headersById）。
- **版本作废**：抬 `stateVersion` 即让旧缓存行被 `row.ver !== def.stateVersion` 丢弃，不需要写迁移。

依赖（全部软依赖，缺席均不抛错）：
- slot：`main`（关键 keyed slot，id 必须与 panellist 的 `id` 一致）+ `sidebar.panellist`（列表项，第二参数是 `({ size })` 图标组件）；
- host 服务：`ctx.sessionProjections`（`register`）、`ctx.sessionQuery`（`listSessions` / `readSession`）、`ctx.sessionProjectionCache`（`cachedSnapshot` / `coldSnapshot`，经 `ctx.get` 惰性取）、`ctx.connection.rpc.handle`；
- `sessionQuery` 契约提醒：base 以 `path: ':memory:'` + `openAt: never` 挂载，**服务照常注册**（注册在构造函数里），`openAt: never` 只关全文检索。`listSessions` / `readSession` 走 live-preferred 语料，从不打开 SQLite——这是本插件敢直接依赖它、而不去碰 `sessionPersistence` 私有面的原因。

### promptopt host 侧行为

- 注册 RPC 通道 `/dsh-plugins.promptopt`（`ctx.connection.rpc.handle(channel, handler)`，随本行 fiber 卸载即摘），三个端点：
  - `optimize`：收 `{ text }` → 加内置 meta-prompt → `ctx.llm.stream` 收集完整输出 → 返回 `{ text, durationMs, noChange, usage? }`。`noChange` 由「产出与原文等价」判定，不是模型自报的标记；
  - `event`：收 `{ event: "adopted"|"dismissed", before?, after? }`，写计数器；
  - `counters`：读计数器。
- **meta-prompt 是内容协议，不进词典**：五条约束见 `lib/index.js` 的 `PROMPTOPT_META_PROMPT`（禁新增事实 / 不确定保留原样 / 已够结构化则原样返回 / 跟随草稿语言 / 只返回结果）。改它要同步 `test/host-promptopt.test.mjs` 的文本断言——I11 靠那组断言把关。
- 错误只回机器码（`bad-request` / `model-unavailable` / `internal` / `cancelled`），由浏览器侧查词典渲染——host 侧没有 locale 服务，不拼人类可读文案；
- 60s 双保险超时；浏览器 abort（关闭弹层）即中止这次调用；
- **计数器落官方存储域**（域 `dsh_plugins_promptopt`、表 `counters`、单键 `totals`）：`spec` 是**手写**的，因为 `defineDomain` 在 npm 包里、硬规则 5 禁止 import。只提供设施真正读取的形状（`name` / `version` / `tables.<name>.valueSchema`，而 `valueSchema` 只要有个 `parse` 方法）。这是对官方内部契约的一处真实耦合——**DSH 升级后如果计数器整块消失，先查 `ctx.storageDomain.open()` 是否还接受这种 spec 形状**；
- **降级**：`connection` 或 `llm` 缺席时通道不注册，点按钮显示「模型调用失败」而不是白屏；`storageDomain` 缺席或域打不开时计数器停用（记一条 warn），优化功能不受影响；`connection` 用 `ctx.get` 惰性取而不是 `inject`——后者是硬依赖，缺席会连带 tokprev / tokstats 一起不加载。

依赖：UI slot `conversation.input.right`（composer 卡片**内部**工具行）；`InputActions.setDraft` 与 `InputState`（`draft` / `imageIds` / `occurrences` / `claim`）；客户端服务 `ctx.connection.rpc.call`；host 服务 `ctx.connection.rpc.handle`、`ctx.llm`（`stream` / `listProviders` / `listModels`）与 `ctx.storageDomain`（`open` / `get`）。

DSH 升级后若按钮点了没反应或一直报错，先对照这些契约——尤其是 RPC 响应信封（成功必须是 `{ ok: true, value }`，错误码取自宿主闭集）与 `GenerateOptions` 的 `provider` / `model` 必填约束。

### 触发位置的迁移史

v0.5.0 起初把 promptopt 放在 `conversation.composer.dock`（与 tokprev 预告行同带），实际用起来发现 dock 是宿主契约标注的「环境读数带」、可点控件本就该在 tool row——v0.5.1 挪到 `conversation.input.right` 符合「发送前顺手点」的操作逻辑。

## 维护须知

- **无构建步骤**：`lib/client.js` 即最终产物（纯 JS，不用 TS/JSX，React 经 ModuleLoader 注入）。改动 = 编辑 + 重启。`lib/index.js`（host 半边）同为纯 JS：只 import `node:` 内建（fs/os/path），不引 npm 运行时依赖。
- **兼容面**：tokprev 依赖 UI slot `conversation.composer.dock` 与投影字段 `contextPressure`；tokstats 依赖 `main` + `sidebar.panellist` slot、`ctx.sessionProjections`、`ctx.sessionQuery` 与 `ctx.sessionProjectionCache`；promptopt 依赖 `conversation.input.right` slot、`InputActions.setDraft`、`ctx.connection.rpc.call`、`ctx.connection.rpc.handle`、`ctx.llm` 与 `ctx.storageDomain`（明细见上节）。界面文案另依赖客户端服务 `ctx.locale`（注册词典 + slot 注册声明 `locale` 命名空间取得 `t` 席位）——它是硬依赖，缺席时整包不加载。DSH 升级后若插件消失，先对照这些契约。所有读取路径均带优雅降级（拿不到数据渲染 null，不会报错）。
- **开发所对版本**：DSH `@deepseek-ai/dsh 0.2.1-rc.2`。host 侧是**一次性压多个深契约**（`InputActions` / `connection.rpc` / `llm.stream` / `sessionProjections` / `sessionQuery` / `sessionProjectionCache` / `storageDomain`），且 rc 阶段官方保留破坏权——升级后优先重验：RPC 信封形状（成功必须是 `{ ok: true, value }`，错误码取自宿主闭集）、`GenerateOptions` 的 `provider` / `model` 是否仍必填、`connection.rpc.handle` 的签名（**0.2.1-rc.2 起只有两参，旧的 `options.authority` 已不存在**）、投影单元的 `init(header, inheritedEventCount)` 与 `wire` 读取面、`sessionQuery` 的 `listSessions` / `readSession` 返回形状、`storageDomain.open()` 是否仍接受手写 spec。
- **开发循环**：先用动态 Cordis 插件（`cordis_define` -> `cordis_run`）在会话内热迭代原型，满意后落入本包。
- **单插件开关的真实语义**：`disabled: true` 只摘除该行的 **host 侧** fiber，浏览器侧 bundle 是否加载取决于**包内是否还有任一行存活**（DSH 的 boot graph 按包名判活，客户端每包一个 fiber、无条件注册全部插件）。对 tokstats 这类 host 半边有实际工作的插件，禁用行即停掉聚合器与统计（客户端按钮还在但无数据）；对 tokprev 这类纯 UI 插件，禁用一行**不会**移除其浏览器 UI（tokstats 行会让整个 bundle 存活）。需要按插件独立开关，请把该插件独立成包（见「新增插件」末尾）。
