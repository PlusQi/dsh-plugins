# Changelog

本包遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式；版本号对齐 `package.json`，用户可用 `github:PlusQi/dsh-plugins#vX.Y.Z` 固定安装。

## [0.5.2] - 2026-08-30

### Changed

- **promptopt 按钮改成纯图标位**：去掉文字标签，hover 看 tooltip（空草稿/含 chip 时换禁用原因）。与工具行其他按钮（引用 / 计划 / 模型选择）形态一致，28x28 方形不撑长行。词典同步删 `button.label` 键——不留死键。

## [0.5.1] - 2026-08-30

### Changed

- **promptopt 触发位置从 `conversation.composer.dock` 改到 `conversation.input.right`**：dock 是宿主契约标注的「环境读数带」，可点控件本就该在 composer 工具行。新位置在模型选择座位之后、发送按钮之前，符合「发送前顺手点」的操作直觉。
- **弹层定位从 absolute 改 fixed + 按钮矩形锚定**：absolute 在 composer 工具行里会被祖先的 `overflow: hidden` 裁剪（与 v0.3.0 tokstats 同款教训——DOM 里有但肉眼看不见）；fixed + JS 锚定不依赖任何祖先 layout。

## [0.5.0] - 2026-08-30

### Added

- **promptopt 插件**：composer 底部「优化提示词」按钮——点一下把草稿交给模型重写，原文/优化文上下对照，**采纳**才写回输入框；不采纳关掉即止，草稿原样不动。
  - 走宿主 `ctx.llm` 做一次**旁路调用**（骑当前已注册的第一个 provider/model 路由），没有配置面、不新建 API key；无磁盘状态（无 checkpoint、无会话日志），该调用也不计入 tokstats 的跨会话统计；
  - 草稿为空、含引用 chip / 图片附件 / `/` 命令 token 时按钮置灰——写回是全量替换，模型重排会静默破坏引用坐标与图片归属，索性不让点；
  - 关闭 / Esc / 点弹层外都算取消，会中止这次调用（浏览器 abort 直接贯通到 host 的模型调用）；
  - 采纳以**发起时刻的草稿快照**为准，无条件写回，等待期间的编辑会被覆盖（无二次确认）；
  - 界面文案双语（新命名空间 `dsh-plugins.promptopt`），但**优化产物跟随草稿语言**——英文界面照样出中文优化文。

## [0.4.0] - 2026-08-29

> **破坏性变更**：本版本新增对宿主 `locale` 服务的硬依赖——用户 profile 的 `locale` 行缺席或被 `disabled` 时，整个 bundle 不再加载（插件 UI 消失且无日志）；此前该情形下插件仍以硬编码中文正常显示。0.x 阶段按 Semver §4 以 MINOR 承载，故版本号不跳 1.0.0。

### Added

- **中英文双语界面**：两个插件的全部可见文案（含 tooltip 与 aria-label）走宿主 locale 服务，跟随 DSH「设置 → 常规 → Language」切换，插件自身不带语言开关。
  - 词典按插件划分命名空间 `dsh-plugins.tokprev` / `dsh-plugins.tokstats`，zh 为键集真源、en 逐键对应；文案一律改为 `{name}` 占位符整句模板，英文按英文语序重写（原拼接串直译会产出中英语序混用的半吊子文案）；
  - 带计数的文案按 `.one` / `.other` 成对出键，英文正确区分单复数（`1 call` / `2 calls`）；
  - tokprev 补齐了此前缺失的 client 测试（11 条），中英各断言一遍预告行与徽标。

### Changed

- **新增对宿主 `locale` 服务的硬依赖**（`inject` 加 `locale`，与官方 UI 包一致）：宿主没有 locale 服务或被手动禁用时，整包不加载——表现为插件 UI 消失且无日志，而不是半中半英。三个 slot 注册均声明 `locale` 命名空间以取得 `t` 席位。
- **面板脚注时间由 `toLocaleTimeString()` 改为固定 24 小时制 `HH:mm:ss`**：`t` 席位只给翻译函数、不给当前语言 id，跟随浏览器 locale 会与 dsh 的语言偏好打架（中文界面配英文浏览器会显示英文时间格式）。数字记号（1.2K / 3.4M）、上下文桶区间与金额符号 ¥ 不翻译。

### Fixed

- 面板内 `t` 与局部变量撞名（`overviewRow` 的 period 与桶表 `map` 参数都叫 `t`），词典化后会把翻译函数遮蔽。

## [0.3.0] - 2026-08-28

### Added

- 正式测试套件 `test/`（node:test 零依赖，29 用例）：host 半边走完整 apply 管线断言（终值替换 / 递进采样 / 归因 / seed 去重 / 桶边界 / 日键 / checkpoint 对账 / flush 增量 / 版本回声 / 全降级矩阵），client 半边 mock react 浅渲染断言（按钮形态 / 面板四表 / 时间开关过滤 / 空态 / projection 值选择优先级）；`npm test` / `npm run guard` 入口。

### Changed

- **prices 覆盖改为字段级合并**：`config.prices` 只配 `input` 时保留内置 `output` 等未覆盖字段（原为模型级整条替换，半配置会静默丢失计价项）。
- persistence 缺席时发布 `reason: "no-persistence"` 完成态空数据（兑现 SPEC 降级矩阵；原实现停「统计中」不落定）；启动扫盘成功后清除残留降级标注。
- 四表行值统一中文格式「输入 X · 输出 Y · ¥成本」（原总览中文、工作区/模型/桶行英文 `X in · Y out` 且顺序不一致）；工作区/模型/桶行补输出 tokens（原来只显示输入）；未配价由「—」改为「未配价」自释；面板加宽至 380px、label 列 42% 给值列让位。
- 计价展示收敛到「按模型」区：总览与工作区行值去掉金额（纯 token；总览 tooltip 悬停仍可见估算明细），定价归因本就按 provider/model——金额只在有意义分组处出现。

### Fixed

- **修复 tokstats 面板定位丢失**：面板 CSS 的 `position:fixed;left:0;bottom:0` 在实现块重写时意外丢失，面板退化为侧栏内的普通流元素——被宿主 `sidebarCol` 的 `overflow:hidden` 裁剪（rail 态仅 18px 宽不可用；展开态右侧数值列被裁、肉眼看不到任何数据）。补回 fixed 定位（锚定按钮矩形，钳制不越视口右缘），并新增 CSS 回归断言防止再丢。首版目检曾被 DOM 文本提取误导（数值在 DOM 里存在但视觉上被裁剪），本次复检改用几何 + `elementFromPoint` 遮挡检测双重确认两种侧栏形态下数值真实可见。

### Added

- **tokstats 插件**（本包首个含 host 半边实现的成员，包定性从纯 UI 升级为混合）：
  - 侧栏脚「Token 统计」按钮 + 弹层面板：跨会话 token 消耗统计——总览（今日/本周/累计三行）、按工作区（Top 8）、按模型（含估算成本列，未配价显示 `—`）、上下文长度分布（2 的幂对数桶 + 缓存命中率），共享时间开关三档；
  - host 聚合器（`lib/index.js`）：扫 durable 会话日志，usage 口径与宿主 tokenUsage 一致（同 `(turn,step)` 终值替换、fork seed 前缀去重、子会话归并根工作区）；checkpoint 增量（`(sessionId, storage revision)` 对账，落 `DSH_HOME/storages/`，防抖原子写）；`session/flush` 增量续折；经 `sessionProjections` 通道注册非会话级 `tokstats` unit 下发（imageLimits 先例 + 版本号回声变体触发推送）；
  - 成本估算：内置 DeepSeek 官方高峰单价（元/Mtok），`cordis.patch.yml` 行 `config.prices` 可覆盖/追加第三方定价；
  - 全链路优雅降级（persistence/projection 缺席、checkpoint 损坏、单会话 inspect 失败均不抛错）。

### Changed

- README 中/英、AGENTS.md、`package.json` description 同步混合包定性；「新增插件」/行禁用语义说明更新（tokstats 行承载 host 聚合器，禁用即停统计）。

## [0.2.4] - 2026-08-27

### Changed

- 客户端 apply 循环改为逐插件 try/catch：单个插件注册块抛错只跳过该插件（浏览器控制台报错），不再让整包 fiber FAILED 拖垮其余插件的 UI（多插件失败隔离；代价是 cordis 启动审计看不到该失败，诊断看控制台）。
- 文档澄清按行禁用语义：profile patch 的行级 `disabled` 只摘除该行的 host fiber，客户端 bundle 随"包内是否还有任一行存活"整体存亡；包内多插件时禁用一行不会移除该插件的浏览器 UI，需要独立开关请独立成包（README 中/英、`cordis.patch.yml` 注释、AGENTS.md 硬规则 3、guard 文案已同步对齐，详见 `docs/debug/postmortem-v0.2.md` 复核补记）。

## [0.2.3] - 2026-08-27

### Fixed

- 修复 tokprev 插件加载成功但 UI 不渲染的问题：客户端 cordis 通过 boot manifest 创建条目时不传递 config（仅 `{name: "dsh-plugins"}`），导致 `config.plugin` 为 `undefined`，apply 函数提前返回未注册任何 slot。改为客户端 apply 直接注册所有插件 UI（客户端 bundle 是单例，组件在数据不可用时返回 null）。同时改用 hooks（`useSession`/`useProjection`/`useInput`）获取响应式数据，对齐内置插件的模式。

## [0.2.2] - 2026-08-27

### Fixed

- 正确修复 tokprev 插件加载失败：`config` 应作为 `apply(ctx, config)` 的第二个参数接收（而非 `ctx.config`），`effect` 是 cordis 内置动词无需注入，`inject` 仅声明服务依赖（如 `slots`）。v0.2.1 的修复方向错误（把 config/effect 加入 inject 导致 "waiting for services: config, effect"）。

## [0.2.1] - 2026-08-27

### Fixed

- （已撤回的错误修复）误将 `config` 和 `effect` 加入 `inject` 数组，导致插件停留在 "waiting for services: config, effect" 状态无法激活。正确修复见 v0.2.2。

## [0.2.0] - 2026-08-27

### Added

- **tokprev** 插件首版（本包初始成员）：
  - Composer 底部"下一轮 token 输入预告"：上下文基座（提供商锚定）+ 排队 + 草稿，随打字实时跳动，含空会话启发式降级；
  - 每轮收尾 assistant 消息上的真实消耗徽标：提供商上报的输入/缓存/输出/调用次数，按轮分组求和，durable。
- 双语 README（中文默认 + English）及效果示意图。
- 设计决策记录 SPEC-tokprev.md（本地留存，不随仓库分发）。

[Unreleased]: https://github.com/PlusQi/dsh-plugins/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/PlusQi/dsh-plugins/releases/tag/v0.2.0
