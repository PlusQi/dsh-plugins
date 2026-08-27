# dsh-plugins

个人 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 扩展集。
一个 repo = 一个 profile bundle：所有插件集中在一个包里，新增插件只需改代码 + 重启，无需重装。

## 插件清单

| 插件 | 功能 | 设计定稿 |
|---|---|---|
| **tokprev** | Composer 底部"下一轮 token 输入预告"（上下文 + 排队 + 草稿，随打字实时跳动）+ 每轮收尾消息上的真实消耗徽标（提供商上报：输入/缓存/输出/调用次数） | [SPEC-tokprev.md](./SPEC-tokprev.md) |

## 安装（web profile）

```powershell
# 开发链接（推荐：改代码重启即生效）
npx @deepseek-ai/dsh plugin --profile web add link:D:\Workbench\dsh-plugins

# 或从 GitHub（本仓库公开后）
npx @deepseek-ai/dsh plugin --profile web add github:<user>/dsh-plugins
```

安装后**重启 dsh web 进程**并刷新页面（profile 组合仅启动时生效）。
依赖：pnpm（`npm i -g pnpm`）。

## 卸载 / 单插件开关

```powershell
# 整包卸载
npx @deepseek-ai/dsh plugin --profile web remove dsh-plugins
```

临时关掉单个插件（不动代码）：编辑 `~/.dsh/profiles/web/cordis.patch.yml` 追加

```yaml
- id: tokprev
  disabled: true
```

重启生效。

## 新增插件（本包的维护模式）

1. `lib/client.js` 里加一个 `── plugin: xxx ──` 段：helpers + 组件 + `ctx.slots.inject(...)` 注册块；
2. `cordis.patch.yml` 加一行 `- id: xxx`（id 带自己的前缀，别撞 dsh-base/dsh-web-app 内置 id）；
3. 写 `SPEC-xxx.md` 决策记录；
4. 重启进程。**零安装操作。**

插件长大了要独立发布/独立 repo？把那段代码连同注册块复制出去单开包即可（模型见 SPEC-tokprev.md §11）。

## 维护须知

- **无构建步骤**：`lib/client.js` 即最终产物（纯 JS，不用 TS/JSX，React 经 ModuleLoader 注入）。改动 = 编辑 + 重启。
- **兼容面**：插件依赖 UI slot 契约（`conversation.composer.dock`、`conversation.chat.assistant-actions`）与投影字段（`contextPressure`/`contextBreakdown`/`AssistantMessageNode.usage`）。DSH 升级后若插件消失，先对照这些契约。所有读取路径均带优雅降级（拿不到数据渲染 null，不会报错）。
- **开发所对版本**：DSH `@deepseek-ai/dsh 0.1.1-rc.2`。
- **开发循环**：先用动态 Cordis 插件（`cordis_define` -> `cordis_run`）在会话内热迭代原型，满意后落入本包。

## License

[MIT](./LICENSE)
