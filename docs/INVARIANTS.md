# 不变量登记表

> 状态：Active
> 适用范围：整个仓库（`lib/`、`cordis.patch.yml`、`scripts/`、`test/`）
> 最后核验：2026-10-22
> 维护责任：修改对应不变量的提交者
> 证据下限：每条必须写明「证据」列；`L0` = 仅文档/评审，`L1` = 静态检查，`L2` = 可执行断言
>
> **先登记后实现**：本变更新增的 TS-21 / TS-22 / TS-23 按其批次逐步落地，落地前证据列写「待落地」并列出预定用例名——**不得**在用例还不存在时把证据写成 L2。落地那批必须回来更新本表。当前进度：TS-21 / TS-22 / TS-23 **三条已全部落地**（TS-21 / TS-22 走 host 载荷第一批 + client 展示第二批；TS-23 与 TS-17 的副值语义走第三批）。TS-24（首帧秒开 + 后台校验）**同批落地**：host 与 client 两侧断言 + 真实宿主实测 + 四项反向验证均已就位。

本文件是 `I*` / `AC-*` 编号的**唯一定义源**。代码、测试与 guard 的注释里出现的 ID 都在这里查定义——此前这些编号只存在于本地 SDD 文档（`docs/specs/`，不随仓库分发），导致同一编号在不同文档里有两套含义（见文末「历史编号映射」）。

**读法**：`PK` = 包级（pack）、`TP` = tokprev、`TS` = tokstats、`PO` = promptopt。编号一经发布不复用；不变量作废时整行标记「已废弃」并保留，不删行。

## 包级（PK）

| ID | 不变量 | 证据 | 层级 |
| --- | --- | --- | --- |
| PK-01 | `cordis.patch.yml` 每行的 `name` 是裸包名 `'dsh-plugins'`；写成子路径只剩 host 半边 | guard「硬规则 1」 | L1 |
| PK-02 | client 模块图按包扁平：所有插件实现在 `lib/client.js` 单文件内，禁止相对路径 `require`（factory 的 require 只认模块表词） | guard「硬规则 2（require 部分）」 | L1 |
| PK-03 | patch 每行建一个 host fiber、`config.plugin` 是 host 分发键；client 每包单 fiber 且无条件注册 `PLUGINS` 全部插件。`PLUGINS` 注册表与 patch 行必须一一对应（新增插件漏注册即拦） | guard「硬规则 3」 | L1 |
| PK-04 | 每插件独立样式 tag（`data-plugin-css="dsh-plugins/<id>"`），禁止包级共享 `<style>` | guard「硬规则 4」；`test/client-tokstats.test.mjs`「每插件样式 tag 独立」 | L1 + L2 |
| PK-05 | 无构建步骤、零运行时依赖：`lib/client.js` 即最终产物（无 TS/JSX/构建脚本）；`lib/index.js` 只 import `node:` 内建，npm 包（含 cordis/zod）在 pnpm link 路径下不可解析 | guard「零运行时依赖：`lib/index.js` 只许 `node:` 前缀」 | L1 |
| PK-06 | 兼容面优雅降级：所有宿主数据读取路径拿不到数据时渲染 null / 空态，不抛错 | 各插件的降级断言（见 TS-10 / TP / PO 各行） | L2 |
| PK-07 | 每插件自带词典：`PLUGINS` 条目带 `ns`（值必须等于 `dsh-plugins.<键>`，带包前缀防撞车）与 `dicts`（`{ zh, en }`，zh 为键集真源，en 逐键对应）；无界面文案的插件显式写 `ns: null`。文案写成 `{name}` 占位符整句模板，带计数按 `.one`/`.other` 成对 | guard「硬规则 7：ns 字段 / ns 值 / dicts 字段」；`assertDictPair` 双向键集断言（4 个 client 测试文件） | L1 + L2 |
| PK-08 | host 半边不写盘：持久化只经官方 `session-projection-cache`，本包不得写 `DSH_HOME/storages/` 下任何自有文件 | guard「I2 / AC-15：host 半边不得写盘」（写/改名/建目录调用） | L1 |
| PK-09 | client 产物不持有成本维度：无 `prices` 字面量（成本维度已整体删除） | guard「I1：client 半边不得持有价格」；`test/client-tokstats.test.mjs`「client 产物无 prices 字面量」 | L1 + L2 |
| PK-10 | client 不解释路由维度：`rt` 只作整串标签渲染，产物里不存在对 `provider` / `model` 的维度用法（属性访问 / 下标 / 键 / 拆分） | guard「DIMENSION_USE 四条正则」 | L1 |
| PK-11 | `CHANGELOG.md` 的版本段与底部链接区**双向一一对应**：每个 `## [X.Y.Z]` 段落必须有 `[X.Y.Z]:` 链接行，每条链接行必须有对应段落（无悬空）；`[Unreleased]` 必须存在且基线指向**最新已发布版本**（`...compare/v<最新>...HEAD`）；链接里引用的每个 `vX.Y.Z` **必须是本地真实存在的 tag**（指向不存在的 tag 在 GitHub 上是硬 404 且不会自愈——未发布内容应挂在 `[Unreleased]` 段下，打 tag 时才改名为版本段） | guard「CHANGELOG 版本段 ↔ 底部链接区一一对应」（四条：段缺链接 / 链接悬空 / Unreleased 基线 / tag 存在性） | L1 |
| PK-12 | `package.json` 的 `version` **等于 CHANGELOG 最新已发布版本段**（第一个 `## [X.Y.Z]`）。未发布的改动挂在 `[Unreleased]` 下、不抬版本号；打 tag 时同时抬版本号并把段落定版——这条检查让「版本号」与「已发布事实」无法各自漂移（此前出现过 `package.json` 0.7.1 / 最新已发布段 0.6.0 / `v0.7.1` tag 不存在三者并存） | guard「package.json 版本 ↔ CHANGELOG 最新已发布段」 | L1 |

## tokprev（TP）

| ID | 不变量 | 证据 | 层级 |
| --- | --- | --- | --- |
| TP-01 | 只注册 `conversation.composer.dock` 一个 slot；不再注册 `conversation.chat.assistant-actions`（每轮徽标已删，官方 TurnUsagePanel 覆盖） | `test/client-tokprev.test.mjs`「I9：只注册 composer.dock」 | L2 |
| TP-02 | 只依赖 `contextPressure` 一个投影字段（加本地草稿估算），`contextBreakdown` 依赖已删 | `test/client-tokprev.test.mjs`「I10：组件只依赖 contextPressure 一个投影键」 | L2 |

## tokstats（TS）

| ID | 不变量 | 证据 | 层级 |
| --- | --- | --- | --- |
| TS-01 | `wire.view` 返回键集固定为 `w` / `e` / `rows`；浏览器侧拿不到跨会话聚合，面外字段一律不带出 | `test/host-tokstats.test.mjs`「wire.view 键集只有 w / e / rows」 | L2 |
| TS-02 | cell 形状固定为 `{ d, b, rt, calls, in, cr, cw, out }`；`rt` 是单个**不透明字符串**（host 拼、host 解释，client 不拆） | `test/host-tokstats.test.mjs`「cell 带不透明 rt 串」 | L2 |
| TS-03 | 抬 `stateVersion` 即让旧缓存行被 `row.ver !== def.stateVersion` 丢弃，**不写任何迁移代码**。反例：只给聚合输出加字段（不进投影状态）**不需要**抬版本 | `test/host-tokstats.test.mjs`「ver: 2 的旧缓存行被跳过，冷折叠重建成功」 | L2 |
| TS-04 | 投影单元 key 是带包前缀的 `dsh-plugins.tokstats`（消除与宿主日后同名单元的撞车；撞车时注册抛错、静默退回冷折叠，极难排查） | `test/host-tokstats.test.mjs`「单元定义：key / stateVersion / init / apply / wire 齐备」 | L2 |
| TS-05 | fork seed 前缀不双计：`seq < inheritedEventCount` 的样本不进入折叠 | `test/host-tokstats.test.mjs`「I4 / AC-2：fork seed 前缀不双计」 | L2 |
| TS-06 | 同 `(turn, step)` 的终值替换而非双计：`assistant/message.usage` 覆盖该 step 的 usage chunk 采样；跨桶跨路由（按 `(d, b, rt)` 定位）都正确减回 | `test/host-tokstats.test.mjs`「I5 / AC-3」「跨桶时旧格被正确减回」 | L2 |
| TS-07 | 折叠是纯函数：`apply(state, event)` 对无关事件返回同一引用（`Object.is` 成立） | `test/host-tokstats.test.mjs`「I6 / AC-4：无关事件返回同一引用」 | L2 |
| TS-08 | E1 折叠不写删：窗口外明细按「桶 × 路由」进 `epoch.routes`，`rows` 本体不删不改；读取期按 `[epoch.start, epoch.end)` 排除明细并改计 epoch 合计。折叠前后明细条数、逐桶数字、逐路由合计三项同时相等 | `test/host-tokstats.test.mjs`「I7 / AC-5」「epoch 折叠保住路由粒度」 | L2 |
| TS-09 | 排行各行次数之和**恒等于**总计次数；空串「未标注」行是差额的唯一出口 | `test/host-tokstats.test.mjs`「排行各行次数之和恒等于总计」 | L2 |
| TS-10 | 任何数据缺失都不抛错：`source` 缺失、`rt` 非字符串、epoch 形状残缺、三种宿主服务缺席、投影注册失败，均降级不抛 | `test/host-tokstats.test.mjs` 降级矩阵（「三种服务缺席各断言一次」「epoch 形状不完整」等）；`test/client-tokstats.test.mjs`「connection 缺席时显示空态」 | L2 |
| TS-11 | 路由来源只有 `assistant/message.data.message.source`：**不读请求侧事件**（`request/header` 是配置快照，与 usage 结算不同源，混用会让数字无法对账） | guard「I11：路由来源」两条（字面量 + `header.config`） | L1 |
| TS-12 | `daily` 是时间维度的唯一真源：`weekly` 由它按自然周（周一）归并，不再独立遍历明细——否则任一处漏条件都会让「周合计 ≠ 日合计」只能靠人工对账 | `test/host-tokstats.test.mjs`「周趋势由日序列归并：各周合计之和恒等于总计」 | L2 |
| TS-13 | `workspaces` 与 `routes` 按各自键**累加**合并，不用 `set()` 覆盖（同工作区多会话、同 rt 跨会话都是常态） | `test/host-tokstats.test.mjs`「同一根工作区的多个会话必须累加」「同一 rt 出现在两个会话时累加」 | L2 |
| TS-14 | 活会话（`record.live === true`）**跳过缓存**直接冷读：官方检查点可能滞后且 `asOfSeq` 无法与稍后打开的日志关联（实测 fork 会话少报 80%） | `test/host-tokstats.test.mjs`「活会话跳过缓存」「非活会话仍走缓存」 | L2 |
| TS-15 | 排行排序写死且完全确定：`calls` 降序；空串「未标注」**显式排最后**（空串字典序最前，直接排会与界面直觉相反）；同次数按 `rt` 字典序 | `test/host-tokstats.test.mjs`「calls 降序；未标注显式排最后；同次数按 rt 字典序」 | L2 |
| TS-16 | epoch 的合计**同时计入** `routes`（否则排行会随窗口推进悄悄少行） | `test/host-tokstats.test.mjs`「epoch 的路由合计计入排行（折叠后不少行）」 | L2 |
| TS-17 | 面板所有「输入」显示值统一为 `in+cr+cw`（KPI / 周行 / 日柱 tooltip / 工作区排行 / 模型排行同口径；日柱列聚合必须累加 `cr` / `cw`，否则 tooltip 退回未缓存口径）。**KPI 副值必须是对主值的拆分**：每张卡的副值只解释本卡的数，不得复述别的卡已显示的数字（0.6.0–0.7.0 曾出现「缓存命中率」副值复述「缓存读」、「输出」副值显示无关的「缓存写」，四张卡只剩三份信息）。**分母无定义时不得编零**：比例类副值在计费输入为 0 时渲染破折号 | 口径部分：`test/client-tokstats.test.mjs`「面板所有「输入」显示值统一为 in+cr+cw（KPI / 周行 / 日柱 tooltip / 工作区 / 模型排行）」。**副值语义部分（第三批已落地）**：`test/client-tokstats.test.mjs`「TS-17 / AC-5：KPI 四卡副值两两不等，且每张是对主值的拆分（不复述他卡）」「TS-17：输出副值在计费输入为 0 时给破折号，不编一个 0%」「TS-17 / TS-23：词典新增键 zh/en 成对、无 provider / model 两词」；真实宿主目检（第三批）：四卡副值 `日均 754.1 次` / `未缓存 22M · 缓存读 1076M` / `占输入 0.44%` / `命中 1076M / 1098M` 两两不等 | L2 + 目检 |
| TS-18 | 上下文桶边界固定为 `[8K, 32K, 128K, 256K, 512K]`（6 桶 `[0,8K)…[512K,∞)`），对齐市面按输入长度的计费档（32K / 128K / 256K 是中国区主力厂商的重叠边界，512K 是 MiniMax M3 的分界；4K/8K/16K 无人设档）。**最高桶不设 1M 上界**：1M 已是市面所有模型上下文窗口的最大值，单请求 prompt 结构上超不过它，再切 `[1M,∞)` 只是恒空格子。**改边界必须同批抬 `stateVersion`**：缓存里的 cell 只存桶序号 `b` 不存区间，边界一变同一 `b` 指向不同区间，不抬版本会静默错位。证据是**把边界数组与版本号钉在同一条断言里**的用例——改任一半都必须显式改另一半 | `test/host-tokstats.test.mjs`「桶边界：对齐市面计费档，且与 stateVersion 同批变更」；`test/client-tokstats.test.mjs`「桶标签与 host 侧边界逐项对齐」 | L2 |
| TS-19 | 已结束会话的官方检查点可能**远早于日志末尾**，采信它会少报用量。补偿是**逐会话惰性基线**：某会话首次汇总时冷读一次、把**本次读到的 events 最大 seq** 记进进程内记忆；之后读缓存时若 `cachedSnapshot().asOfSeq` 低于该基线，就判定滞后并冷读覆盖。**基线不能取 `coldSnapshot().asOfSeq`**——实测 v0 格式会话它返回旧检查点水位（如 1126）而非日志末尾（148654），取它会让判定永不成立。`config.verifyStale: false` 可整块关闭（面板秒开，代价是采信滞后检查点） | `test/host-tokstats.test.mjs`「TS-19：冷读后若缓存水位低于已见日志末序号，下一次汇总改为冷读覆盖」「TS-19：缓存水位追平…仍走零 I/O」「TS-19：verifyStale=false…」 | L2 |
| TS-20 | 时间档位固定四档「近 7 天 / 本月 / 近 30 天 / 全部」，缺省近 7 天；**四档共用 host 的 `windowDays` 一个入参**，「本月」由客户端折算成「当天日期数」（host 侧 `today - (windowDays - 1)` 因此落在当月 1 日），不引入第二种窗口口径。档位按 **id** 而非天数寻址选中态——「本月」在每月 7 号恰好也是 7 天，按天数寻址会让两个按钮同时高亮 | `test/client-tokstats.test.mjs`「时间档位：四个按钮…缺省选中近 7 天」「切换窗口：每个档位各发一次请求」；`test/host-tokstats.test.mjs`「TS-20：「本月」档的 windowDays 折算口径 = 当月 1 日」（跨模块钉住两条式子） | L2 |
| TS-21 | `tokstatsAggregate` 返回值纯增量带 `coverage: { sessions, skipped }`（`sessions` = 通过 `header.id` 校验且通过 workspace 过滤的会话数，`skipped` = 其中 `summary === undefined` 的条数），且**不进投影状态**——覆盖是「本次请求」的瞬时事实，进状态会制造 stale 语义。推论（见 TS-03）：**不需要抬 `stateVersion`、不需要清缓存**。两条恒等约束：`sessions - skipped` 等于实际贡献了数字的会话数；**分母与分子同源**（切到单个工作区时别的工作区的会话不进分母）。client 侧：字段缺失（旧 host）时整句不渲染，**不得显示假零** | host：`test/host-tokstats.test.mjs`「TS-21 / AC-2：coverage 形状——三会话一失败 → sessions 3 / skipped 1」「TS-21 / AC-2：coverage 与数字一致——被跳过的会话不贡献任何合计」「TS-21：entries 为空时 coverage 返回 0 / 0，不是 undefined」「TS-21：coverage 分母跟随 workspace 过滤（分母与分子同源）」「TS-21 / TS-22 / TS-03：coverage 与 epoch 不进投影状态（wire.view 键集不变）」「TS-21 / TS-22：端点返回值里带 coverage 与 epoch（client 的唯一消费面）」；client：`test/client-tokstats.test.mjs`「TS-21 / AC-2：页脚渲染「已统计 N 个会话」」「TS-21 / AC-2：skipped > 0 才出现「跳过」，并带原因 tooltip」「TS-21 / AC-2：skipped === 0 时不显示「跳过」（不显示假零）」「TS-21：旧 host 无 coverage 字段时整句不渲染、不抛错（硬规则 6）」「TS-21：coverage 为空对象 / sessions 非数字时同样不渲染（降级不抛错）」 | L2 |
| TS-22 | `tokstatsAggregate` 返回值纯增量带 `epoch: { end, calls } \| null`；**无折叠历史被计入时必须是 `null`**（不是 `{}`、不是 `undefined`），client 用 `!== null` 判定。代表日 = `end - 1`（与 host 的 `tokstatsDayBefore` 同口径），client 必须给该列打「折叠历史」标记并在 tooltip 写明区间末归并——**不得把它渲染成普通数据点**（那会显示一个不存在的用量尖峰）。三条边角：代表日落在窗口外时返回 `null`（否则打标指向不存在的列）；全零 epoch 不算「计入了折叠历史」；多会话各不同 epoch 时取**最早**代表日、`calls` 求和。client 侧另有一条：列被合并时代表日落在列**区间内**即须打标（只比对列首日在长窗口下必漏） | host：`test/host-tokstats.test.mjs`「TS-22 / AC-3：epoch 两态——无折叠为 null，有折叠带 end 与 calls」「TS-22：epoch 的 end 与读取期代表日同口径（代表日 = end - 1）」「TS-22：epoch 代表日落在窗口外时不得报 epoch（否则打标会指向不存在的列）」「TS-22：全零 epoch 不算「计入了折叠历史」」「TS-22：多个会话各有不同 epoch 时取最早的代表日（PLAN §3.3）」；client：`test/client-tokstats.test.mjs`「TS-22 / AC-3：epoch 非空 → 代表日那一列带折叠标记类名」「TS-22 / AC-3：epoch 为 null 时不出现任何折叠标记（反向断言）」「TS-22：代表日落在合并列区间内时也要标（不只比对列首日）」「样式：折叠列用斜纹/次要底色，不写死颜色（TS-22）」 | L2 |
| TS-23 | 日柱图的可读性下限：绘图区至少 2 条水平网格线（用 `--dsw-alias-border-l1` 变量，不写死颜色）；左轴至少 2 个刻度值且以 `fmtTok` 格式化（K/M 记号不进词典）；刻度位置必须按**平方根刻度**摆放（峰值÷2 在 `sqrt(0.5)=70.7%` 高度，不是 50%——等距摆放等于让读者按线性读）；**平方根刻度必须可被识别**（绘图区 tooltip 有口径说明）——`Math.sqrt` 未声明时读者会按线性误读。柱宽有上限（`max-width:48px`）以免列少时被 `flex` 拉爆，且上限触顶后余量由容器 `justify-content` 显式决定（否则少列挤在左侧）；列多时按窗口压缩不受该上限影响；窄窗（≤900px）隐藏中间刻度防重叠 | `test/client-tokstats.test.mjs`「TS-23 / AC-4：日柱左轴 3 个刻度值，且最大刻度 = 峰值、中间刻度 = 峰值÷2」（值 + 位置双断言）「TS-23 / AC-4：刻度值为 K/M 记号时走 fmtTok」「TS-23：绘图区至少有 2 条水平网格线，且用主题变量」「TS-23 / AC-4：柱容器有列宽上限（3 列与 60 列都不溢出）、列少时居中」「TS-23：sqrt 刻度可被识别」「TS-23：峰值柱顶部标数值，其余柱只留 tooltip」「AC-6：2:1 行用 stretch 对齐」「AC-7：选中态用品牌色 + 反色文字」；真实宿主目检（第三批）：3 列 / 48px、58 列 / 18px、中间刻度落在 70.7%、`rowGrid` 同行卡片高度差 0、窄窗中间刻度 `h=0` | L2 + 目检 |
| TS-24 | **首帧秒开 + 后台校验**（性能契约）：`summary` 的**首次请求不得串行等待全量冷读**——逐会话先走零 I/O 缓存，取不到（或需重新校验）的会话进后台队列；返回值带纯增量字段 `verifying: boolean`（`true` = 还有会话在后台校验中）。三条约束：<br>① **`verifying` 不进投影状态**（不在 `state` / `wire.view` 里）→ 按 TS-03 的反例，**不抬 `stateVersion`、不清缓存**；<br>② **活会话不得回放日志**：`record.live === true` 时直接读宿主投影注册表里**已被急切驱动**的单元（`sessionProjections.cachedSnapshot(liveSession, [key])`），拿不到才退回 `sessionProjections.snapshot(...)`，再拿不到才冷读——实测本机 70 会话串行 `readSession` 累计 16.9 s（均值 238 ms、最长 1.26 s），其中活会话单会话 604 ms，而折叠本身只有 1–5 ms；<br>③ **后台校验必须单飞且收敛**：同一会话在队列里只排一次（Set 去重）、全进程只有一个 drain 在跑、每会话**重试预算 2 次**（`attempts`）；校验完成即写回缓存、刷新 `observedSeq` 基线并把结果放进一次性内存表 `fresh`（下一帧立即可见，不必等缓存落盘），使下一次请求 `verifying: false`。预算上限的必要性双向：**不能无限**（读不出日志的会话永远建不了基线，队列永不空、客户端无限重拉）**也不能只试一次**（TS-19 的滞后可再次出现，实测「水位从 2 退回 0」必须允许再校验一轮）。client 侧：`verifying === true` 时页脚显示「校验中」并按 1500 ms 退避自动重拉，直到 `false`；**且此时不得把待校验会话写进「跳过（日志不可读）」**——首帧实测把 68 个待校验会话谎报成故障；旧 host 无该字段时**不重拉、不显示**（硬规则 6） | host：`test/host-tokstats.test.mjs`「TS-24：活会话走投影注册表 cachedSnapshot，不调用 readSession」「TS-19：冷读后若缓存水位低于已见日志末序号，下一次汇总改为冷读覆盖」（重试预算的第二轮）「冷折叠兜底…」「单会话 readSession 失败…」「TS-21 / TS-22：端点返回值…」（均经 `waitVerifyingSettled` 收敛）；client：`test/client-tokstats.test.mjs`「TS-24：verifying 为 true 时页脚显示「校验中」」「TS-24：verifying 时不得把待校验会话谎报成「日志不可读」」「TS-24：verifying 缺席（旧 host / 已收敛）时不显示「校验中」，也不重拉」「TS-24：verifying 为 true 时自动重拉一次，收敛后停止」。**真实宿主实测**（本机 70 会话 / 50 MB 日志，清空缓存行的最坏情况）：首帧 RPC **39 ms**、面板 **85 ms** 出数、后台 **13.0 s** 收敛；缓存已在的重启场景：面板 **102 ms** 显示与终值一致的 5.7K，`verifying` 提示随后自行消失。改前同口径为 **12–17 s** 空等。**反向验证**（四项均实测变红）：禁用活会话零回放 → TS-24 用例红；删掉 `verifying` 载荷 → 两个收敛用例卡住；client 不重拉 → 重拉用例红；允许校验中报「日志不可读」→ 谎报用例红 | L2 + 目检 |

## promptopt（PO）

| ID | 不变量 | 证据 | 层级 |
| --- | --- | --- | --- |
| PO-01 | meta-prompt 不含「补充上下文」类指令，且显式含「禁新增原文事实」条款（旧句 `add the context a competent reader would be missing` 必须不在场） | `test/host-promptopt.test.mjs`「meta-prompt 五条约束齐备 + 旧句消失」正反两组断言 | L2 |
| PO-02 | 不写会话日志、不新增存储文件：计数器落官方存储域（域 `dsh_plugins_promptopt` / 表 `counters` / 单键 `totals`） | 代码审查 + guard「PK-08 写盘调用」覆盖 `lib/index.js`（本插件 host 半边同文件） | L1（写盘）+ L0（不写会话日志） |
| PO-03 | 错误只回机器码（`bad-request` / `model-unavailable` / `internal` / `cancelled`），host 侧不拼人类可读文案——host 没有 locale 服务 | `test/host-promptopt.test.mjs`「错误响应不含人类可读文案：message 就是机器码」 | L2 |
| PO-04 | 采纳写回的唯一路径是 `setDraft(优化文)`，且无条件 | `test/client-promptopt.test.mjs`「采纳：唯一写回路径是 setDraft」 | L2 |
| PO-05 | 关闭弹层即 abort 在飞请求；迟到的响应不写状态 | `test/client-promptopt.test.mjs`「关闭按钮 / Esc / 点外 abort」「关闭后迟到的响应不写状态」 | L2 |
| PO-06 | 软依赖降级：`connection` / `llm` 缺席时通道不注册（点按钮显示「模型调用失败」而非白屏）；`storageDomain` 缺席或域打不开时计数器停用并留一行 stderr 诊断，优化功能不受影响 | `test/host-promptopt.test.mjs`「connection 缺席 → 通道不注册」「storageDomain 缺席时端点仍在、计数全零」「域打不开时记警告并停用」 | L2 |

## 维护规则

1. **新增不变量**：先在此表加行（含证据列），再去改代码/测试；不得先写代码后补编号。
2. **证据列不得为空**。只靠评审的条目标 `L0` 并写明「依赖评审」——把 L0 写成 L1/L2 是空壳（曾发生：旧 SPEC 声称「零运行时依赖由 guard 静态检查」，而 guard 当时并无 import 检查）。
3. **改证据形态时**（guard 项改名、测试重命名、断言移入新文件）必须同步本表指针，否则指针失效即为漂移。
4. **作废不变量**：整行标「已废弃（日期 + 原因）」，保留行不删除，避免编号复用造成历史误读。
5. **不改代码里的旧编号注释**：历史 `I*` 注释保留原样，靠下表映射到新 ID；改注释会触碰 `lib/index.js` 与全部测试文件，触发「按变更范围读取」表里的 `npm test` + 重启目检，收益不抵风险。

## 历史编号映射（旧 → 新）

旧编号来自两份本地 SPEC，两者**重号但含义不同**，这是本表存在的主要原因。已废弃的两套旧表：

### 来自 `SPEC-v0.6.0`（v0.6.0 向官方管线收敛）

| 旧 | 含义（旧表原文摘要） | 新 |
| --- | --- | --- |
| I1 | client 侧不得持有跨会话 cells；`wire.view` 不含 `provider`/`model` | TS-01 + PK-09 |
| I2 | 持久化只经官方缓存 | PK-08 |
| I3 | `stateVersion` 提升即作废旧记录 | TS-03 |
| I4 | fork seed 前缀不双计 | TS-05 |
| I5 | 同 `(turn, step)` 终值替换 | TS-06 |
| I6 | 折叠是纯函数 | TS-07 |
| I7 | E1 折叠不写删 | TS-08 |
| I8 | 任何数据缺失都不抛错 | TS-10 |
| I9 | tokprev 不再注册 `assistant-actions` | TP-01 |
| I10 | tokprev 只依赖 `contextPressure` | TP-02 |
| I11 | promptopt meta-prompt 不含「补充上下文」指令 | PO-01 |
| I12 | promptopt 不写会话日志、不新增存储文件 | PO-02 |
| I13 | 每插件词典 ns 与注册表一致，zh/en 逐键对应 | PK-07 |
| I14 | 零运行时依赖（host 只 import `node:` 内建） | PK-05 |

### 来自 `SPEC-tokstats-routes`（v0.7.0 路由维度）

| 旧 | 含义（旧表原文摘要） | 新 |
| --- | --- | --- |
| I1′ | client 侧不解释路由字段（`DIMENSION_USE`） | PK-10 |
| I2 | 路由标识在 wire 里是单个不透明字符串 | TS-02 |
| I3 | `stateVersion` 提升即作废旧记录 | TS-03 |
| I4 | 投影 key 为 `dsh-plugins.tokstats` | TS-04 |
| I5 | fork seed 前缀不双计（延续） | TS-05 |
| I6 | 同 `(turn, step)` 终值替换（延续） | TS-06 |
| I7 | 折叠是纯函数（延续） | TS-07 |
| I8 | E1 折叠不写删，且保路由粒度 | TS-08 |
| I9 | 排行各行次数之和恒等于总计 | TS-09 |
| I10 | 任何数据缺失都不抛错（延续） | TS-10 |
| I11 | 路由来源只有 `assistant/message.source` | TS-11 |
| I12 | 每插件词典 ns 与注册表一致（延续） | PK-07 |
| I13 | 零运行时依赖（延续） | PK-05 |
| I14 | 宿主半边不写盘（延续） | PK-08 |

**撞车示例**（同一旧编号在两套表里含义完全不同）：`I2` = 持久化经官方缓存 / 路由不透明字符串；`I9` = tokprev 不注册 assistant-actions / 排行之和恒等总计；`I11` = meta-prompt 约束 / 路由来源唯一。查旧注释时**先确认它出自哪份 SPEC**，否则会读成相反的意思。

## 覆盖缺口（已知，未修复）

| 缺口 | 说明 | 现状 |
| --- | --- | --- |
| PK-06 只有间接证据 | 「优雅降级」由各插件的降级断言分别覆盖，没有一条聚合断言；新增插件时不会自动获得覆盖 | 依赖评审 |
| PO-02 的「不写会话日志」是 L0 | guard 只拦写盘调用，拦不住「经宿主 API 追加会话日志」这种形态（本包目前无此调用，靠评审） | 依赖评审 |
| PK-07 的「整句模板 / one-other 成对」是 L0 | 键集一致性有自动断言，但「文案是否整句模板、记号是否误入词典」无法静态判定 | 依赖评审 |
| 宿主契约版本矩阵未建 | 本包压着 DSH `0.2.1-rc.2` 的 7 个深契约，升级后的重验清单目前是 `docs/MAINTAINING.md` 的散文 + README「支持的 dsh 版本」的三步，不是矩阵 | 待建（见 AGENTS.md「按变更范围读取」） |
