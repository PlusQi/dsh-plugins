# dsh-plugins

简体中文 | [English](./README.en.md)

可能有用的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件仓库。

所有插件集中在一个包里（一个 repo = 一个 profile bundle），装一次即全部生效，不必逐个安装。

## 插件清单

| 插件            | 功能                                                                                      |
| ------------- | --------------------------------------------------------------------------------------- |
| **tokprev**   | Composer 底部"下一轮 token 输入预告"（上下文 + 排队 + 草稿，随打字实时跳动）+ 每轮收尾消息上的真实消耗徽标（提供商上报：输入/缓存/输出/调用次数） |
| **tokstats**  | 侧栏脚按钮弹层面板：跨会话 token 消耗统计（时间段总览 / 按工作区 / 按模型含成本 / 上下文长度分布，今日·本周·累计三档切换）                  |
| **promptopt** | Composer 工具行的星标按钮（hover 看提示）：发送前把草稿交给模型重写，原文/优化文对照，**采纳**才写回输入框                         |

> **tokprev** 是纯界面插件；**tokstats** 与 **promptopt** 另有宿主侧半边（一个在后台聚合会话日志，一个发起一次旁路模型调用）。

## 语言（中文 / English）

插件的界面文案都走宿主 locale 服务，**跟随 DSH 设置 → 常规 → Language**，插件自身没有语言开关。

- 词典按插件划分命名空间：`dsh-plugins.tokprev`、`dsh-plugins.tokstats` 与 `dsh-plugins.promptopt`。
- promptopt 是**两轴分离**：界面文案跟随宿主语言，而**优化产物跟随草稿语言**（英文界面照样出中文优化文）——优化文是内容、不是 UI 文案，不进词典。
- 用户没显式选过时，宿主取浏览器语言；非 zh/en 回落 en。
- `locale` 是本包的**硬依赖**（与官方 UI 包一致）：宿主没有 locale 服务（或被手动禁用）时整包不加载——表现为插件 UI 消失且无日志，而不是半中半英。
- 数字记号（1.2K / 3.4M）、上下文桶区间（`[0,4K)`）与金额符号 ¥ 不翻译（英文语境同样通用，且 ¥ 是 DeepSeek 官方人民币价，写成 CNY 反而误导）；面板脚注时间固定 24 小时制，不跟浏览器 locale。

## tokprev 用途说明

单轮 token 消耗的"事前预告 + 事后实报"闭环：发送前告诉你这一轮大概要喂多少 token，轮次结束后用提供商上报的真数对账。

![tokprev 效果示意](./docs/assets/tokprev.png)

### 发送前预告（Composer 底部）

形态示例：

> **下一轮输入 ≈ 36.2K (28%)** · 上下文 33.8K + 排队 0.1K + 草稿 0.3K · 输出预估 1.5K–3K

- **下一轮输入** = 上下文基座（`contextPressure.projectedTokens`，提供商锚定）+ 排队消息 + 草稿，随打字实时跳动；
- **占比** = 下一轮输入 / 上下文窗口；
- **输出预估** = 最近 5 轮真实 `outputTokens` 的 \[P25, P75] 区间；无历史时显示 `-`，仅 1 轮时显示 `≈该值`；
- 降级：空会话无锚点时回退启发式估算（`contextBreakdown` 三桶求和），上下文数字加 `*` 前缀；会话运行中整行隐藏（预测对象不存在），空闲恢复。

### 每轮收尾真实消耗徽标

每轮最后一跳 assistant 消息上渲染一行弱化小字（durable，刷新页面、翻历史轮都在）：

> `本轮 输入 12.4K（3 次调用 · 缓存 11.8K）· 输出 2.1K`

- 数据为该轮所有调用 `usage` 求和的提供商上报真数；计费输入 = `inputTokens + cacheReadTokens + cacheWriteTokens` 三桶之和；
- 悬浮可见精确 token 数与调用次数。

### 口径提醒（预告 ≠ 徽标）

- **预告** 是单次请求的 prompt 大小估算；
- **徽标** 是该轮**所有调用的计费输入总和**——多步轮每步重发全量上下文，累计远大于单次请求，缓存命中字段（徽标里的"缓存"段）可解释差额。两者口径不同但均有意义，不矛盾。

## tokstats 用途说明

跨会话 token 消耗统计：宿主 StatsLine 只看单会话，本插件扫全部 durable 会话日志回答「今天烧了多少」「哪个项目吃得最多」「长上下文请求占比多高」。

![tokstats 面板效果示意](./docs/assets/tokstats.png)

侧栏底部「Token 统计」按钮（rail 模式为图标位）点开弹层面板：

- **总览**：今日 / 本周（周一起）/ 累计 三行——请求数 + 四桶（纯 token，不含金额）；
- **按工作区**：Top 8（子会话消耗沿 parent 链归并到根工作区，fork 的 seed 前缀去重不双计）；
- **按模型**：provider/model 分组，含按定价估算的成本列（未配价显示「未配价」）；
- **上下文长度分布**：计费输入按 2 的幂对数桶 `[0,4K)…[128K,∞)` 的请求数 / 输入 / 输出 / 缓存命中率。

口径与宿主一致：计费输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`；同 `(turn,step)` 的最终 `assistant/message.usage` 替换 usage chunk 采样（不双计）。金额为**估算**：内置 DeepSeek 官方高峰单价（元/Mtok，可在 patch 行覆盖），面板有标注。

首次安装后，面板在任一会话被打开（或统计推送到达）之前显示「统计中…」；宿主侧服务缺席时显示对应提示，不会报错。

### 定价配置（可选）

内置价只覆盖 `deepseek-official` 路由。第三方 provider 在你的 profile patch（`~/.dsh/profiles/web/cordis.patch.yml`）追加覆盖/自定义价（元/Mtok）：

```yaml
- id: tokstats
  patch:
    config:
      prices:
        ark-codingplan:
          glm-5.3: { input: 2, inputCached: 0.2, output: 4 }
```

（profile patch 按 id 定向覆盖行 config，与 dsh 官方 patch 语义一致。）

## promptopt 用途说明

在 composer 敲完草稿后，不必另开一轮「帮我优化这段提示词」：点工具行里的**星标按钮**（hover 看提示，禁用时换文字），模型重写一遍，原文与优化文上下对照，**满意才点采纳**——采纳才把优化文写回输入框，不满意关掉即可，草稿原样不动。

- **触发位置**：composer 卡片**内部**工具行的右端（模型选择座位之后、发送按钮之前）——「发送前顺手点」的位置。
- **流程**：点按钮（弹层出现、转圈）→ 模型返回（上下对照 + 耗时脚注）→ 采纳 / 关闭。关闭、Esc、点弹层外都算取消，会中止这次调用。
- **禁用场景**（按钮置灰，悬浮有说明）：草稿为空；草稿含引用 chip、图片附件或 `/` 命令 token——写回是全量替换，模型重排会破坏引用坐标与图片归属，属于静默损坏，直接不让点。
- **采纳语义**：以**发起时刻的草稿快照**为准，无条件写回。等待期间你又改了草稿，采纳会覆盖掉那些改动（没有二次确认弹层）。
- **模型与开销**：走宿主 `ctx.llm` 做一次**旁路调用**——骑当前已注册的第一个 provider/model 路由，**没有配置面**，也不新建 API key；每次点击 = 一次模型调用（输入约为草稿的 1.5 倍量级）。
- **不落盘**：无 checkpoint、无会话日志，纯内存瞬时。这次旁路调用的开销**不会**计入 tokstats 的跨会话统计（它不在 durable 会话日志里）。
- **降级**：模型服务缺席时点按钮显示「模型调用失败，请稍后重试」，不会白屏。

DSH 升级后若按钮点了没反应或一直报错，先对照维护文档里的宿主契约清单。

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

重启生效。注意：`disabled` 只摘除该行的**宿主侧** fiber，浏览器侧界面是否卸载取决于**包内是否还有任一行存活**——所以对纯界面插件（如 tokprev）禁用一行**不会**让它从页面上消失。需要按插件独立开关，请把该插件拆成独立包（原因与步骤见维护文档）。

## 维护

本文件面向使用者。维护者与 AI Agent 从 [AGENTS.md](./AGENTS.md) 进入（路由表 + 硬规则 + 结构 guard）；发布流程、新增插件五步、多插件结构的四条硬约束、各插件的 host 侧行为与宿主契约、单插件开关的真实语义见 [docs/MAINTAINING.md](./docs/MAINTAINING.md)。版本变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## License

[MIT](./LICENSE)
