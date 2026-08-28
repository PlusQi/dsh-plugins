# Changelog

本包遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式；版本号对齐 `package.json`，用户可用 `github:PlusQi/dsh-plugins#vX.Y.Z` 固定安装。

## [Unreleased]

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

[Unreleased]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/PlusQi/dsh-plugins/releases/tag/v0.2.0
