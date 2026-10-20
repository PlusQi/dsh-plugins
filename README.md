# dsh-plugins

简体中文 | [English](./README.en.md)

可能有用的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件仓库。

所有插件集中在一个包里（一个 repo = 一个 profile bundle），装一次即全部生效，不必逐个安装。

## 插件清单

| 插件            | 功能                                                                                      |
| ------------- | --------------------------------------------------------------------------------------- |
| **tokprev**   | Composer 底部三点式预告：下一轮输入 · 草稿 · 输出预估（只补官方 ContextMeter 给不了的草稿增量） |
| **tokstats**  | 侧栏「Token 分析」全局面板：上下文长度分布 + 周趋势 + 工作区分组 + promptopt 使用计数，近 90 天／30 天／全部三档 |
| **promptopt** | Composer 工具行的星标按钮（hover 看提示）：把草稿保真重排为结构化输入，原文／整理结果对照，**采纳**才写回输入框 |

> **tokprev** 是纯界面插件；**tokstats** 与 **promptopt** 另有宿主侧半边（一个注册会话投影单元并汇总，一个发起一次旁路模型调用）。

## 语言（中文 / English）

插件的界面文案都走宿主 locale 服务，**跟随 DSH 设置 → 常规 → Language**，插件自身没有语言开关。

- 词典按插件划分命名空间：`dsh-plugins.tokprev`、`dsh-plugins.tokstats` 与 `dsh-plugins.promptopt`。
- promptopt 是**两轴分离**：界面文案跟随宿主语言，而**整理产物跟随草稿语言**（英文界面照样出中文整理结果）——产物是内容、不是 UI 文案，不进词典。
- 用户没显式选过时，宿主取浏览器语言；非 zh/en 回落 en。
- `locale` 是本包的**硬依赖**（与官方 UI 包一致）：宿主没有 locale 服务（或被手动禁用）时整包不加载——表现为插件 UI 消失且无日志，而不是半中半英。
- 数字记号（1.2K / 3.4M）、上下文桶区间（`[0,4K)`）不翻译（英文语境同样通用）；面板脚注时间固定 24 小时制，不跟浏览器 locale。

## tokprev 用途说明

发送前告诉你这一轮大概要喂多少 token。**只补官方没有的那部分**：官方 ContextMeter 已经给了上下文绝对数与系统/工具/消息三段明细，每轮真实消耗另有 TurnUsagePanel，所以本插件只保留官方结构上给不了的增量——草稿与下一轮输入合计。

![tokprev 效果示意](./docs/assets/tokprev.png)

### 形态（Composer 底部，三点式）

> **下一轮输入 ≈ 36.2K** · 草稿 0.3K · 输出预估 1.5K–3K

- **下一轮输入** = 上下文锚点（`contextPressure.projectedTokens`，提供商锚定）+ 草稿估算，随打字实时跳动；
- **草稿** = 本地启发式估算（字符数 / 4 + 开销），不发请求；
- **输出预估** = 最近 5 轮真实 `outputTokens` 的 \[P25, P75] 区间；无历史时显示 `-`，仅 1 轮时显示 `≈该值`；
- 降级：无真实请求锚点时数字加 `*` 前缀（纯启发式）；会话运行中整行隐藏（预测对象不存在），空闲恢复。

## tokstats 用途说明

跨会话 token 消耗统计：宿主只在单会话内折叠 token，本插件回答「长上下文请求占比多高」「这周比上周多还是少」。

![tokstats 面板效果示意](./docs/assets/tokstats.png)

侧栏列表里的「Token 分析」进入**全局面板**：

- **上下文长度分布**：计费输入按 2 的幂对数桶 `[0,4K)…[128K,∞)` 的请求数 / 输入 / 输出 / 缓存命中率；
- **趋势**：按自然周（周一起）分组的请求数与输入/输出；
- **工作区**：下拉切换「全部工作区」或某一个工作区（子会话沿 parent 链归并到根工作区，fork 的 seed 前缀去重不双计）；
- **提示词整理使用情况**：promptopt 的发起 / 采纳 / 放弃计数与采纳后的字符增减（promptopt 未启用时该区块不显示）。

口径与宿主一致：计费输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`；同 `(turn,step)` 的最终 `assistant/message.usage` 替换 usage chunk 采样（不双计）。

时间窗有「近 90 天 / 近 30 天 / 全部」三档；数据在打开面板、切换窗口、切换工作区时各拉一次，不做常驻推送——这个面板不需要实时跳动。

首次安装后面板显示「统计中…」；宿主侧服务缺席时显示对应提示，不会报错。**本插件不写任何自有文件**：折叠状态由 DSH 官方的会话投影缓存持久化，删掉旧版遗留的 `storages/tokstats-checkpoint.json` 不影响使用。

## promptopt 用途说明

把口语草稿**保真重排**成模型更易解析的结构化输入——不是把它扩写成执行计划，更不是替你想需求。点工具行里的**星标按钮**（hover 看提示，禁用时换文字），原文与整理结果上下对照，**满意才点采纳**。

- **触发位置**：composer 卡片**内部**工具行的右端（模型选择座位之后、发送按钮之前）——「发送前顺手点」的位置。
- **重排做什么**：一段话里的多个诉求拆成并列条目；把「那个文件」「刚才的报错」这类指代还原为草稿里已有的名词；把「不要动 X」「必须用 Y」这类约束从句提成显式条目；去掉寒暄、试探、自我怀疑。**草稿里没有的事实、路径、约束、步骤一律不补**——不确定是否原文已有，就保留原样。
- **无需整理**：草稿已经足够结构化时模型原样返回，弹层显示「原文已足够清晰，无需整理」并禁用采纳按钮。
- **流程**：点按钮（弹层出现、转圈）→ 模型返回（上下对照 + 耗时脚注）→ 采纳 / 关闭。关闭、Esc、点弹层外都算取消，会中止这次调用。
- **禁用场景**（按钮置灰，悬浮有说明）：草稿为空；草稿含引用 chip、图片附件或 `/` 命令 token——写回是全量替换，模型重排会破坏引用坐标与图片归属，属于静默损坏，直接不让点。
- **采纳语义**：以**发起时刻的草稿快照**为准，无条件写回。等待期间你又改了草稿，采纳会覆盖掉那些改动（没有二次确认弹层）。
- **模型与开销**：走宿主 `ctx.llm` 做一次**旁路调用**——骑当前已注册的第一个 provider/model 路由，**没有配置面**，也不新建 API key。
- **不写会话日志**：无会话事件、无日志写入。这次旁路调用的开销**不会**计入 tokstats 的 token 统计（它不在 durable 会话日志里），但发起/采纳/放弃的**次数**会记在 tokstats 面板里（官方存储域，跨重启可查）。
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
