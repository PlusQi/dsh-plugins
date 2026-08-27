# 仓库 Agent 约束

> 状态：Active
> 适用范围：整个仓库
> 最后核验：2026-08-27
> 维护责任：修改仓库级约束的提交者

本文件是维护者与 AI Agent 进入仓库的执行入口。使用者视角的安装/发布说明见 [README.md](./README.md)，两者不重复承载内容。

## 优先级

```latex
宿主兼容契约（UI slot / 投影字段，见 README「维护须知」）
  > 本文件硬规则
  > README 维护说明（「新增插件」「多插件四条硬约束」详述）
  > Active spec（当前无）
  > 归档 SPEC（docs/specs/archive/，仅历史证据，不约束当前实现）
```

同级约束冲突且无法按上表裁决时，**停顿询问维护者**，不得自动选择。

## 按变更范围读取

| 变更 | 必读材料 | 最低验证 |
| --- | --- | --- |
| `lib/client.js` 任意改动 | 本文件硬规则 + README「维护须知」 | `node scripts/check-plugin-structure.js` + 重启 dsh web 目检 |
| 新增插件 | README「新增插件」四步；模式参考归档 SPEC-tokprev §11 | 同上 |
| `cordis.patch.yml` | 本文件硬规则 1 / 3 | `node scripts/check-plugin-structure.js` |
| `package.json`（dsh 声明 / exports / files） | README「发布到 GitHub」 | link 安装后重启目检 |
| 纯文档 / 图片 | — | 链接可达性检查 |

## 硬规则

1. **patch 行 name 必须是裸包名 `'dsh-plugins'`**：client 半边按包名发现；写成子路径只剩 host 半边；
2. **client 模块图按包扁平**：所有插件实现在 `lib/client.js` 单文件内，禁止拆分文件或使用相对路径 `require`（factory 的 require 只认模块表词）；
3. **每行 patch 一个 fiber，靠 `config.plugin` 分发**：新增插件必须同时在 `lib/client.js` 的 `PLUGINS` 注册表注册，否则该 fiber 空转并告警；
4. **每插件独立样式 tag**：经 `ensurePluginStyles` 注入 `data-plugin-css="dsh-plugins/<id>"`，禁止包级共享 `<style>`；
5. **无构建步骤**：`lib/client.js` 即最终产物，禁止引入 TS / JSX / 构建脚本 / npm 运行时依赖；
6. **兼容面**：所有宿主数据读取路径必须保持优雅降级（拿不到数据渲染 null，不抛错）。

规则 1 / 3 / 4 及 2 的 require 部分由 `scripts/check-plugin-structure.js` 自动检查（L1 静态证据）。规则 5 / 6 依赖评审，无自动检查。

## 交付信息

任何代码交付时报告：

- 改动范围（文件 + 行为变化判断）
- 已执行验证（guard 命令输出 + 是否目检）
- 未执行验证及原因
- 剩余风险与回滚方式（通常为 `git revert` 单提交）
