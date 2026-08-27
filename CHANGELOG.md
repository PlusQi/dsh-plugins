# Changelog

本包遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式；版本号对齐 `package.json`，用户可用 `github:PlusQi/dsh-plugins#vX.Y.Z` 固定安装。

## [Unreleased]

## [0.2.1] - 2026-08-27

### Fixed

- 修复 tokprev 插件加载失败：`inject` 数组遗漏 `config` 和 `effect` 声明，导致 cordis 运行时抛出 "cannot get property 'config' without inject"，插件整体无法加载。

## [0.2.0] - 2026-08-27

### Added

- **tokprev** 插件首版（本包初始成员）：
  - Composer 底部"下一轮 token 输入预告"：上下文基座（提供商锚定）+ 排队 + 草稿，随打字实时跳动，含空会话启发式降级；
  - 每轮收尾 assistant 消息上的真实消耗徽标：提供商上报的输入/缓存/输出/调用次数，按轮分组求和，durable。
- 双语 README（中文默认 + English）及效果示意图。
- 设计决策记录 SPEC-tokprev.md（现归档于 `docs/specs/archive/`）。

[Unreleased]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/PlusQi/dsh-plugins/releases/tag/v0.2.0
