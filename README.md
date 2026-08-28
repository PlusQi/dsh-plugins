# dsh-plugins

简体中文 | [English](./README.en.md)

个人 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 扩展集。
一个 repo = 一个 profile bundle：所有插件集中在一个包里，新增插件只需改代码 + 重启，无需重装。

## 插件清单

| 插件          | 功能                                                                                      | 设计定稿                                 |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------ |
| **tokprev** | Composer 底部"下一轮 token 输入预告"（上下文 + 排队 + 草稿，随打字实时跳动）+ 每轮收尾消息上的真实消耗徽标（提供商上报：输入/缓存/输出/调用次数） | SPEC-tokprev.md |

## tokprev 用途说明

单轮 token 消耗的"事前预告 + 事后实报"闭环：发送前告诉你这一轮大概要喂多少 token，轮次结束后用提供商上报的真数对账。

![tokprev 效果示意](./docs/assets/tokprev.png)

### 发送前预告（Composer 底部）

形态示例：

> **下一轮输入 ≈ 36.2K (28%)** · 上下文 33.8K + 排队 0.1K + 草稿 0.3K · 输出预估 1.5K–3K

- **下一轮输入** = 上下文基座（`contextPressure.projectedTokens`，提供商锚定）+ 排队消息 + 草稿，随打字实时跳动；
- **占比** = 下一轮输入 / 上下文窗口；
- **输出预估** = 最近 5 轮真实 `outputTokens` 的 [P25, P75] 区间；无历史时显示 `-`，仅 1 轮时显示 `≈该值`；
- 降级：空会话无锚点时回退启发式估算（`contextBreakdown` 三桶求和），上下文数字加 `*` 前缀；会话运行中整行隐藏（预测对象不存在），空闲恢复。

### 每轮收尾真实消耗徽标

每轮最后一跳 assistant 消息上渲染一行弱化小字（durable，刷新页面、翻历史轮都在）：

> `本轮 输入 12.4K（3 次调用 · 缓存 11.8K）· 输出 2.1K`

- 数据为该轮所有调用 `usage` 求和的提供商上报真数；计费输入 = `inputTokens + cacheReadTokens + cacheWriteTokens` 三桶之和；
- 悬浮可见精确 token 数与调用次数。

### 口径提醒（预告 ≠ 徽标）

- **预告** 是单次请求的 prompt 大小估算；
- **徽标** 是该轮**所有调用的计费输入总和**——多步轮每步重发全量上下文，累计远大于单次请求，缓存命中字段（徽标里的"缓存"段）可解释差额。两者口径不同但均有意义，不矛盾。

### 依赖的宿主契约

UI slot `conversation.composer.dock`、`conversation.chat.assistant-actions`；投影字段 `contextPressure` / `contextBreakdown`；`AssistantMessageNode.usage`。所有读取路径均带优雅降级（拿不到数据渲染 null，不会报错）。

## 安装（web profile）

前置：Node.js、git、pnpm（`npm i -g pnpm`）。私有仓库也可安装（pnpm 走你本机 git 凭据）。

```powershell
# 从 GitHub 安装（其他用户）
npx @deepseek-ai/dsh plugin --profile web add github:PlusQi/dsh-plugins

# 固定版本：# 后可跟 tag / 分支 / commit
npx @deepseek-ai/dsh plugin --profile web add github:PlusQi/dsh-plugins#v0.2.3

# 本机开发链接（改代码重启即生效，路径换成你本地的仓库位置）
npx @deepseek-ai/dsh plugin --profile web add link:D:\path\to\dsh-plugins
```

安装后**重启 dsh web 进程**并刷新页面（profile 组合仅启动时生效）。
安装位置：`$DSH_HOME/profiles/web/`（默认 `~/.dsh`）。`dsh plugin` 是 pnpm 转发器：
装完后自动把声明了 `dsh.bundle` 的包挂进 `dsh.profile.bundles` 层列表，无需手改配置。
本包无构建脚本，git 安装不会触发 pnpm 的 build-script 拦截（allowBuilds）。
若发到 npm，`npx @deepseek-ai/dsh plugin --profile web add dsh-plugins` 同理。

## 更新 / 卸载 / 单插件开关

```powershell
# 更新：重新解析安装 spec（未固定 ref 则拉默认分支最新提交）
npx @deepseek-ai/dsh plugin --profile web update dsh-plugins

# 整包卸载（自动从层列表摘除）
npx @deepseek-ai/dsh plugin --profile web remove dsh-plugins
```

临时关掉单个插件（不动代码）：编辑 `~/.dsh/profiles/web/cordis.patch.yml` 追加

```yaml
- id: tokprev
  disabled: true
```

重启生效。注意行的真实语义：`disabled` 只摘除该行的 **host 侧** fiber，浏览器侧 bundle 是否加载取决于**包内是否还有任一行存活**（DSH 的 boot graph 按包名判活，客户端每包一个 fiber、无条件注册全部插件）。包内只有 tokprev 一个插件时，禁用这行即整包下线、语义直观；将来包内有多个插件时，禁用一行**不会**移除该插件的浏览器 UI（其余行会让整个 bundle 存活）。需要按插件独立开关，请把该插件独立成包（见下文「新增插件」末尾）。

## 发布到 GitHub（维护者）

```powershell
git remote add origin git@github.com:PlusQi/dsh-plugins.git
git push -u origin master
git tag v0.2.0; git push --tags   # 可选：给用户可固定的版本打 tag
```

**打 tag 前的硬门槛**（v0.2.0 三连败的教训，详见 [postmortem](./docs/debug/postmortem-v0.2.md)）：link 安装目标提交 -> 重启 dsh web -> 刷新页面，目检**每个插件**的 UI 元素实际渲染。"启动无报错 ≠ 插件正常工作"——slot 注册是副作用，apply 提前返回或抛错都可能静默失效。目检不过不打 tag。

推上去即可被安装，无需注册表。`files` 字段保证 git 安装只带
`lib/` + `cordis.patch.yml`（pnpm 打包时自动附带 README / LICENSE / package.json）。

## 新增插件（本包的维护模式）

1. `lib/client.js` 的 `PLUGINS` 注册表加一段：`css` + `apply(ctx)`（helpers、组件、`ctx.slots.inject(...)` 注册块都放这段里）；
2. `cordis.patch.yml` 加一行（`name` 固定 `'dsh-plugins'`，`config.plugin` 指向注册表键；id 带自己的前缀，别撞 dsh-base/dsh-web-app 内置 id）：

   ```yaml
   - id: xxx
     name: 'dsh-plugins'
     config:
       plugin: xxx
   ```

3. 写 `SPEC-xxx.md` 决策记录；
4. 重启进程。**零安装操作。**

多插件结构的四条硬约束（来自 DSH 本体，调整前先读）：

- **client bundle 按包名发现**：host 按 entry 的 `name` 解析 `<name>/package.json` 读 `dsh.client` 声明，整包服务 `exports["./client"]`。行 name 必须是裸包名 `dsh-plugins`；写成 `dsh-plugins/xxx` 子路径只剩 host 半边（dsh-web-app 的 `web-startup` 行就是这种 host-only 子路径用法）。
- **client 模块图按包扁平**：一个包的 client 半边 = 一个模块节点，包内不能拆多文件（bundle factory 里的 `require` 只认模块表词，相对路径直接抛错）。所有插件共用 `lib/client.js` 单文件靠分段纪律维护，这是"无构建步骤"的边界。
- **host 按行分 fiber，client 每包单 fiber**：patch 每行建一个 **host** fiber，`config.plugin` 是 host 侧分发键（dsh-base 的 `tool-subagent` / `tool-subagent-fork` 是纯 host 包的同名多行参考；本包 host 半边为空，行实际充当存在/禁用锚点）。**client 侧 `__DSH_BOOT__` 每包只建一个条目且不传 config**（`dsh-client-modules` 按包名构建 boot graph），因此 `lib/client.js` 的 apply 无条件注册 `PLUGINS` 全部插件，靠组件数据不可用时返回 null 降级；客户端不存在"第二行再跑一遍 apply"，也不可能在客户端按 `config.plugin` 分发。
- **样式按插件分 tag**：每插件一个 `data-plugin-css="dsh-plugins/<id>"` tag（`ensurePluginStyles` 幂等注入、随包 fiber 停止移除）；保持插件块独立颗粒度，日后单插件独立成包时连样式原样带走。

插件长大了要独立发布/独立 repo？把注册块连同 patch 行复制出去单开包即可（模型见本地 SPEC-tokprev §11）。

## 维护须知

> 维护者与 AI Agent 的执行入口见 [AGENTS.md](./AGENTS.md)（路由表 + 硬规则 + 结构 guard）；本节为人类可读的详述。

- **无构建步骤**：`lib/client.js` 即最终产物（纯 JS，不用 TS/JSX，React 经 ModuleLoader 注入）。改动 = 编辑 + 重启。
- **兼容面**：插件依赖 UI slot 契约（`conversation.composer.dock`、`conversation.chat.assistant-actions`）与投影字段（`contextPressure`/`contextBreakdown`/`AssistantMessageNode.usage`）。DSH 升级后若插件消失，先对照这些契约。所有读取路径均带优雅降级（拿不到数据渲染 null，不会报错）。
- **开发所对版本**：DSH `@deepseek-ai/dsh 0.1.1-rc.2`。
- **开发循环**：先用动态 Cordis 插件（`cordis_define` -> `cordis_run`）在会话内热迭代原型，满意后落入本包。

## License

[MIT](./LICENSE)
