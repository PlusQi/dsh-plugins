# Changelog

本包遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式；版本号对齐 `package.json`，用户可用 `github:PlusQi/dsh-tokstats#vX.Y.Z` 固定安装（旧地址 `PlusQi/dsh-plugins` 仍可用，GitHub 301 自动重定向）。

## [0.7.0] - 2026-10-24

> **状态**：本段对应 tag `v0.7.0`。此后未发布内容重新挂回 `[Unreleased]` 段。

> **破坏性变更（一项）**：**包名 `dsh-plugins` → `dsh-tokstats`**，profile 的依赖键随之变化，`dsh plugin update` / `remove` 用旧名会失效。迁移（一次性，**不需要清缓存**）：
>
> ```powershell
> npx @deepseek-ai/dsh plugin --profile web remove dsh-plugins
> npx @deepseek-ai/dsh plugin --profile web add github:PlusQi/dsh-tokstats
> ```
>
> - **不丢投影缓存、不需要冷折叠**：投影单元 key、RPC 通道名、存储域名刻意保留旧名（详见 Changed「包名」条与 README 的冻结清单表）。
> - **旧仓库地址仍可用**：`github.com/PlusQi/dsh-plugins` 会 301 跳到新地址，已发布 tag 与 `raw.githubusercontent.com` 图片链接不受影响。
> - 插件页标题/描述不受影响（来自包级 `locale`，显示「Token 工具集」/「Token Toolbox」，与包名无关）。
> - 本版本同时包含 E1 展示元数据与 E3 文档纠错（见 Added / Changed）。

### Fixed

- **后台冷读在数字已经正确之后继续空转，把宿主 CPU 烧满（真实缺陷，v0.6.0 起存在）**：TS-24 把冷读移出首帧后，面板确实秒开，但后台 drain 仍要对**每个已结束会话**冷读一次来建立 TS-19 基线——哪怕该会话的缓存行本来就是对的。实测本机（74 会话 / 41 MB 压缩日志 / 48 851 事件）：终值在第 3 次请求（228 ms）就已正确，drain 却又跑了 **14.6 s / 20.6 CPU 秒**，而面板显示的数字**一个都没再变**。用户感受是「点完整机发烫、点别的也慢」——drain 期间并发 RPC 延迟 p95 640 ms、峰值 914 ms。
  - **成本归因（实测，修正上一轮的「98% 在 zstd 解码」）**：在 `tokstatsColdRead` 打点后测得 `readSession` 合计 **14 095 ms**、纯 zstd 解码仅 **1 904 ms**、本插件折叠仅 **107 ms**。贵的不是解码，而是宿主 `readSession` 的**同步包装层**（`readStableJsonlFile` + `SessionLogScanner` + `Session.create` 的逐事件深拷贝/冻结/校验 + `events.map`），那段不经过宿主每 500 ms 一次的 `scheduler.yield()`，单会话最长 951 ms。
  - **修法一（治本）：冷读凭据按日志 `revision` 记账（TS-26）**。宿主**不会**替插件重校验已落盘会话的缓存行（`coldSnapshot` 在整个宿主 asar 内零调用点），所以「这行缓存是不是我们冷读出来的」必须插件自己记住。记账口径用宿主公开服务 `ctx.sessionPersistence` 的 `revision`（纯 stat 元数据，**不解码日志**；api-catalog 原文点明它「exists for derived read-model caches keyed off `stat`/`list`」）。冷读成功即记下 `{ revision, seq }`，落官方存储域（与 promptopt 计数器同一手法，不写自有文件——PK-08）。下次启动取当前 `revision`：**相同即日志字节未变 ⇒ 缓存行仍是冷读真值 ⇒ 不冷读**；不同 ⇒ 保守重读（TS-19 原路径）。跨进程生效，宿主重启不再重付。
  - **修法二：drain 每会话之后让出事件循环（TS-27）**，用 `node:timers/promises` 的 `scheduler.yield()`（与宿主同一原语，`node:` 内建不违硬规则 5）。这不减少总 CPU，只把「连续占用数秒」拆成小段。
  - **三个实测踩到的坑**：① **不能每帧核对** —— 74 会话每帧 `stat` 一遍是 330 ms 起步，把热路径 p50 从 50 ms 抬到 1337 ms；改为只在后台 drain 核对 + 2 s TTL。② **v0 格式的 `revision` 证明不了「本会话没变」** —— 宿主对 `sourceVersion < SESSION_FORMAT_VERSION` 把 revision 算成 `${fileRevision}:${historicalCorpusRevision()}`，后者是**所有**历史日志的 SHA-256（6 段 vs v4 的 5 段），任何历史日志一变全部 v0 会话都跟着变；本机 74 会话里 14 个是 v0（11.9 MB），必须按「无凭据」处理、退回 TS-19 基线。③ **`fresh` 表不能一次性消费** —— 官方 `coldSnapshot` 写回是 fail-soft fire-and-forget，下一帧缓存行可能还没落盘；一次性消费会把刚冷读过的会话判成「未命中」再排一遍。改为「缓存已追平冷读水位」才删除。
  - **实测收益（真实宿主，同口径）**：冷启动首轮 15.9 s / 21.4 CPU-s（不可避免，要先建立凭据）→ **重启后 4.4 s / 6.2 CPU-s、RPC p50 180→71 ms**（-72% 墙钟 / -71% CPU）。剩余成本全部落在 14 个 v0 会话上（宿主格式迁移截断，插件侧修不了）。
  - **数字终值不变**：`docs/debug/tools/verify-final-amounts.mjs` 对同一份日志快照按「缓存命中路径」与「强制冷折叠路径」各算一次聚合，`totals / buckets / daily / weekly / routes / workspaces / coverage` **逐字段相等**。不抬 `stateVersion`、不清缓存（TS-03 的反例：纯 host 侧性能改动，不碰投影状态）。
- **面板后台校验期间反复整块闪烁，首屏虽快却「一直在刷、什么都没看到」**：TS-24 把冷读移出首帧后，首屏确实秒开（面板 85–102 ms 出数），但后台校验要让客户端按 1.5 s 间隔自动重拉，而**重拉与「用户主动操作」共用同一条 loading 路径**——每轮重拉都无条件 `setPhase("loading")`，把 KPI 卡 / 桶分布 / 趋势整块卸载换成一行「统计中…」，等 RPC 返回再挂回来。1.5 s 一轮、连续 3–4 轮时，用户根本来不及看清任何一帧数据，观感就是「一直在闪但没有数据」。
  - **修法：后台自动重拉不再卸载已有内容**。缓存值虽可能偏低，但它仍是 host 手头能给出的最好值，留在屏上才有参考价值；「数字仍在变准」由页脚全程在场的「校验中…」如实披露（TS-24 已有），不靠清空内容来暗示。
  - **用户主动操作（切档位 / 切工作区 / 点刷新）仍走 loading 态**：口径已经变了，旧窗口的数字对新窗口无意义——「显示上一个窗口的数字」比闪烁更糟，故这三处显式清掉后台标记。
  - **后台轮次之间退避 1500 → 3000 ms**（首轮仍是 1500 ms）：把「连续 3–4 轮闪烁」压到「1–2 轮」，「几秒后自己变准」的观感不变。
  - **纯 client 侧改动**：不涉及 host 半边与投影状态，故不抬 `stateVersion`、不清缓存（TS-03 的反例），缓存行照常读取。数字终值不变。
- **README 中英指向会装错包的安装路径**：删掉「若发到 npm，`add dsh-plugins` 同理」这句。npm 上的 `dsh-plugins@0.1.2` 是**别人**的包（一个插件市场 CLI，与本项目无关），而本包从未发布到任何 registry——照着原文做会装上一个来路不明的包，且失败时表现为「插件没生效」而不是「装错了」。改为显式声明「只能从 GitHub 装」并写明原因。
- **面板首次打开要等十几秒（真实缺陷，v0.6.0 起存在）**：进程启动后第一次点开「Token 分析」时，面板空白等待 **12–17 秒**才出数（同进程内再次打开只要 30–70 ms）。根因是 TS-19 的检查点滞后补偿在首次汇总里**串行**对每个会话调宿主 `readSession` 建立基线——本机 70 个会话累计 **16.9 s**（均值 238 ms、最长 1.26 s），而其中 **55/70 个缓存水位本来就已追平日志末尾**，这段开销买不到任何正确性。逐项实测：并发读**零收益**（上限 4：16.97 s vs 串行 16.98 s，瓶颈是 CPU 同步回放而非 I/O 等待，已回退）；`verifyStale: false` 也不快（缓存清空后无论如何都要冷读）。
  - **修法一：活会话不再回放日志**。宿主的 `SessionProjectionRegistry` 在每个 `session/event` 上急切驱动已注册单元，所以活会话的正确折叠值本来就在内存里；此前却对它调 `readSession` 全量回放（单会话 604 ms，而折叠本身只有 1–5 ms）。现在直接读 `sessionProjections.cachedSnapshot(liveSession, [key])`，拿不到才退回 `snapshot(...)`（就地增量推进），再拿不到才冷读。
  - **修法二：冷读移出首帧，改后台校验**。需要校验的会话（缓存缺失 / 判定滞后 / 无基线）排进后台队列，首帧只用手头缓存值；返回值新增 `verifying: true`，客户端据此在页脚显示「校验中…」并按 1500 ms 退避自动重拉，直到收敛。队列纪律：单飞（全进程一个 drain）、去重、每会话**重试预算 2 次**——上限双向必需，无上限会让读不出日志的会话永远建不了基线、`verifying` 恒 true、客户端无限重拉；只试一次又修不了「水位再次回退」。
  - **实测（本机 70 会话 / 约 50 MB 压缩日志）**：清空缓存的最坏情况——首帧 RPC **39 ms**、面板 **85 ms** 出数、后台 **13.0 s** 收敛；缓存已在的重启场景（真实用户路径）——面板 **102 ms** 直接显示与终值一致的 5.7K，随后 `verifying` 自行消失。**数字不变**：终值与修前一致（5709 次 / skipped 0），`stateVersion` 不抬、缓存不清（TS-24 按 TS-03 的反例：只加聚合输出字段）。
- **面板「模型排行」比实际用量少（真实缺陷，v0.6.0 起存在）**：已结束会话走 `cachedSnapshot` 时直接采信官方检查点，而该检查点可能停在远早于日志末尾的水位——实测本机 50 个会话里 **11 个滞后**，最严重的缓存 `seq=793` 而日志末序号 162925。全量对账：面板 3952 次 / 794.3M 计费输入，实际 4124 次 / 825.4M，**少报 172 次调用、3129 万计费输入**；按路由看 `trae/deepseek-v4.1-flash` 少 7.8%、`ark-codingplan/glm-5.3` 少 21.9%。现在加逐会话惰性基线（TS-19）：首次汇总冷读建立基线，之后缓存水位低于基线就冷读覆盖。
  - **已知未解**：7 个 v0 格式会话的 `readSession` 只返回旧检查点之前的事件（缓存水位与日志末尾比值 0.5%–1.5%），冷读也拿不到后续事件，属宿主侧格式迁移截断；这些会话仍偏低（`ark-codingplan` 少 115 次）。宿主修复后本机制自动受益。
- **面板 8 处「输入」口径不统一（真实缺陷，v0.3.0 起存在）**：其中 6 处只显示**未缓存输入**（`in`），漏掉缓存读（`cr`）与缓存写（`cw`），而同一个面板的指标卡与上下文桶分布早已用 `in + cr + cw`——同一面板自相矛盾。实测数据里缓存部分占输入的 97–99%，按路由的排行偏差最高达 130 倍（workbuddy/deepseek-v4.1-flash：显示 2.6M，实际 340.1M）。现在 KPI / 周趋势 / 日柱 tooltip / 工作区排行 / 模型排行统一走 `tokstatsBilled()`（`in + cr + cw`）。
- **每日柱聚合漏累加 `cr` / `cw`（独立缺陷）**：`tokstatsDailyColumns` 只累加 `calls` / `in` / `out`，即使显示侧改用 billed，日柱 tooltip 仍会退回未缓存口径。host 侧的 `daily` 行本就带四桶，只改客户端。
- **KPI 卡标签「计费输入」改为「输入」，hint 改为「未缓存 / 缓存读」**：面板不再有两个不同口径的「输入」；hint 标注的是拆分里的未缓存部分（`未缓存 {uncached} · 缓存读 {cached}` / `{uncached} uncached · {cached} cache read`）。
- **日柱图此前不可读（无轴、无刻度、无网格线，且柱宽被拉爆）**：三件事一起修。① 左轴给出 0 / 峰值÷2 / 峰值三个刻度，按**平方根刻度**定位（峰值÷2 在 `sqrt(0.5)=70.7%` 高度，而不是 50%——柱高本来就是 `sqrt(calls/peak)`，等距摆放会让读者按线性读出错误量级）；② 绘图区加 2 条水平网格线（走 `--dsw-alias-border-l1`，深色主题下是 6% 白），峰值柱顶直接标数值、其余柱保留 tooltip；③ 柱宽加 `max-width:48px` 并用 `justify-content:center` 处理余量——此前近 7 天窗口只有 3 个活跃日时每列约 306 CSS px，柱宽表达的是「窗口里有几天」而不是「量有多大」。绘图区 tooltip 写明「柱高按调用次数的平方根绘制（非线性刻度）」。
- **KPI 四卡副值不再互相复述（语义修正）**：「缓存命中率」的副值原来又写一遍「缓存读」，与「输入」卡的拆分是同一条信息；「输出」的副值写的是「缓存写」，与输出毫无关系——四张卡只剩三份信息。现在四卡副值各自拆自己的主值：调用次数 → 日均；输入 → 未缓存 / 缓存读；输出 → **占输入的比例**（如 `占输入 0.44%`，分母为 0 时给破折号而不是编一个 0%）；命中率 → **分子 / 分母**（`命中 1076M / 1098M`，可心算校验那个百分比）。
- **2:1 行的两张卡不再高度失配**：桶分布卡天然高于「趋势（按周）」，`align-items:start` 让右列在卡片下方留出约 218px 空洞。改为 `stretch`，同行两卡等高（实测高度差 0）。
- **时间档位选中态可辨**：选中 chip 原来是 `bg-layer-2` 底，与容器底只差 9 级灰度，实测「不知道当前在哪个档位」。改用品牌色底 + 反色文字，并补 `.switchOn:hover` —— `.switch:hover` 的特异性更高，不补这条时鼠标停在选中项上会把品牌色覆盖回灰。

> **升级提示（输入口径）**：面板排行 / 周趋势 / 悬停提示里的「输入」数字会变大——那是修正而非回归。这一项是**纯展示层**改动：不抬 `stateVersion`、不需要清缓存，旧缓存行照常读取。

> **破坏性变更**（七项，均可回滚）：
> 1. **tokstats 投影单元 key 改名**：`tokstats` → `dsh-plugins.tokstats`（带包前缀，消除与宿主日后同名单元的撞车风险）。旧 key 的缓存记录不再被读取、永久残留，按每会话数百字节计；确认无误后可由维护者手工清理 `storages/session_projcache/sessions/*.json` 中的对应字段。
> 2. **tokstats 投影单元 `stateVersion` 由 2 提升到 3**：cell 增加路由维度、epoch 改为保留「桶 × 路由」粒度。旧缓存行被版本检查丢弃并自动冷折叠重建，**不需要手工清缓存**；升级后首次打开面板会冷读一次全量日志（本机实测：42 个会话、约 6.7 s；缓存建好后再次打开约 0.1 s）。
> 3. **tokstats 面板重做信息层级**：纯文本列表 → 指标卡 + 柱状图 + 占比条排行（详见 Changed）。
> 4. **tokstats 聚合新增 `routes` 字段**：`tokstatsAggregate` 返回值多一项，自行解析该返回值的消费方需同步。
> 5. **同一根工作区的多会话改为累加**：修正后工作区次数会变大，那是修正而非回归（详见 Fixed）。
> 6. **tokstats 投影单元 `stateVersion` 由 3 提升到 6**（本轮三次调整桶边界的最终值）：上下文桶边界由 2 的幂改为市面计费档（7 桶 → 6 桶 → 7 桶 → 6 桶，详见 Changed）。缓存里的 cell 只存桶序号 `b`、不存区间，边界一变同一个 `b` 就指向另一个区间，不抬版本是**静默错位**而不是报错（TS-18）。旧缓存行被版本检查丢弃并自动冷折叠重建，**不需要手工清缓存**；升级后首次打开面板要冷读一次全量日志（本机实测：清空 50 个会话的缓存行后，从点开面板到出现首行数据 **8.3 s**；缓存建好后再次打开约 **0.1 s**）。
> 7. **tokstats 汇总行为变化**：进程启动后**首次汇总会全量冷读一次**建立滞后基线（TS-19，本机 50 会话 7.9 s），之后同进程内保持零 I/O。若更看重秒开，可在该行 `config` 里加 `verifyStale: false` 关闭——代价是采信滞后的官方检查点（实测少报 4.4% 调用 / 4.6% 计费输入）。
> 8. **tokstats 首帧改为「先用缓存、后台校验」**（TS-24，见 Fixed「面板首次打开要等十几秒」）：首次汇总不再等全量冷读，返回值新增 `verifying: boolean`。**数字终值不变**，但首帧可能短暂显示偏低值并带「校验中…」提示，几秒后自动校正。自行解析该返回值的消费方可以忽略新字段；`stateVersion` 不抬、缓存不清。

### Changed

- **README 中英各加「支持的 dsh 版本 + 每版怎么验证」一节**：版本表（含证据指针）+ `engines.dsh` 的判定语义（失败关闭、不进日志）+ 升级宿主后的三步重验清单（结构 guard → `npm test` → 重启目检）。原文只有维护文档里的散文「开发所对版本」，使用者升级后遇到插件消失没有可自查的入口；清单第一步指向 `docs/INVARIANTS.md` 的 PK-* 与 `scripts/check-plugin-structure.js`。
- **README 的 tokstats 功能列表改成「区块 → 解答的问题」表**：原列表是功能罗列（「有个周趋势表」），读者得自己推断每块图回答什么；改成每块先写问题再写怎么看，长段落（桶边界为什么这么切、观测面不是价目表）保留为表下注。
- **文档里三处过期/错误的对外事实更正**（不动任何代码与版本号）：
  - **README 中英的固定版本安装示例**从 `#v0.2.3` 改为当前真实 tag `#v0.6.0`。原示例停在四个版本前的 tag 上，而这句话**没有任何自动检查**（PK-11 只校验 CHANGELOG 里的 tag 存在性），比 CHANGELOG 更容易腐坏。
  - **`dsh.compatibility.dshReleases` 的表述**（README 中英 + `docs/MAINTAINING.md`）从「供插件市场与读者查」改为「**无任何自动化消费方，仅人读**」，并附实测依据。原文会让维护者以为改动它有运行时影响。
  - **改名成本口径**（`docs/MAINTAINING.md`）从「爆炸半径是 10 个文件」改为「改动面 / 用户代价」两栏：改动面实测 4–9 文件 / 6–34 行（四档 diff），真正的成本是每个已装用户 `remove` + `add` 一次、以及跟改投影 key 时的一次全量冷折叠。「10 个文件」是代码文件口径且描述的是文本散布面（`dsh[-_]plugins` 共 144 处 / 16 个文件，含 6 个文档），不是改动面。
- **包名 `dsh-plugins` → `dsh-tokstats`**（破坏性，迁移步骤见下方「破坏性变更」）。动机是对外辨识度：`dsh-plugins` 是中性名，社区目录里 name 含它的条目有 106 条，本项目淹没其中，而主打功能是 token 用量分析。仓库同步改名 `PlusQi/dsh-tokstats`，**旧地址仍可用**（GitHub 301 自动重定向，已实测），已发布 tag 与 README 图片链接不受影响。
  - **R1 包身份**：`package.json` 的 `name`、`cordis.patch.yml` 三条 `name:`、`lib/client.js` 的 `__ModuleLoader__.load({id})` 四处齐动。
  - **R2 派生命名空间**：三个 `LOCALE_NS_*`、`data-plugin-css` 前缀、`ctx.effect` 标签、日志前缀。纯进程内/纯展示，跟包名走。
  - **冻结项（刻意保持历史名）**：投影单元 key `dsh-plugins.tokstats`、RPC 通道 `/dsh-plugins.tokstats` 与 `/dsh-plugins.promptopt`、存储域名 `dsh_plugins_*`。判据「有持久化或跨侧契约 ⇒ 冻结」。代价对照不对称：改 key 要让每个用户的全部缓存行作废、重付一次全量冷折叠，而宿主对 key 零校验（不是路径、无字符集限制），改名买不到任何正确性。README 中英与 `docs/MAINTAINING.md` 三处写明这是刻意冻结，防后人「顺手补全」。
- **上下文长度分布由 2 的幂对数桶改为市面计费档 6 桶**：边界 `[4K, 8K, 16K, 32K, 64K, 128K]`（2 的幂，7 桶）→ `[8K, 32K, 128K, 256K, 512K]`（6 桶，标签 `[0,8K)` / `[8K,32K)` / `[32K,128K)` / `[128K,256K)` / `[256K,512K)` / `[512K,∞)`）。为什么这么切（2026-10-21，官方价格页 + 本机 4039 次真实调用实测）：
  - **32K 是最主流的低档上界**：阿里云百炼、火山方舟、智谱 GLM、腾讯混元 Hy3 preview 都在此设档（4 家）；**128K / 256K** 构成中段（阿里云 qwen3.5-flash 等、火山方舟 doubao-seed-2.0 系列都用这两点）；**512K** 是 MiniMax M3 的分界（≤512K / >512K 两档）。**200K** 是 Google Gemini / Anthropic 的历史分界，但 Anthropic 已于 2026 年取消 long-context 溢价（1M 全窗单一价），对以中国区厂商为主的观测面板意义弱于 256K，故不采用。
  - **旧划分对不上真实分布**：4K / 8K / 16K 没有任何厂商设档，旧方案里 `[4K,8K)` 在本机真实调用中是**完全空桶**，而 `[128K,∞)` 一桶吃掉 59% 调用 / 84% token——这就是旧桶划分失真的直接证据。
  - **低端保留 8K 一刀**（不直接合并成 `[0,32K)`）：8K 以下短问答 / 单轮工具调用与 8K–32K 多轮会话 / RAG 是两类负载，留着才看得出会话膨胀。
  - **256K–1M 之间再切 512K**：这一段原本一桶吃掉 20.8% 调用 / 47.6% token，桶内跨 4 倍跨度，看不出「接近窗口上限」的请求；切完两半分别 13.5% / 6.4% 调用、25.5% / 20.4% token，都有量不是空桶。
  - **最高桶不设 1M 上界、不留 `[1M,∞)` 尾巴**：1M 已是市面所有模型上下文窗口的最大值（本机 profile 里 `contextWindow` 最大就是 1048576），单个请求的 prompt 结构上超不过它，那一格**永远为空**。本机 4039 次真实调用实测：最大计费输入 **710.9K**，≥1M 的 0 次、≥800K 的 0 次、≥700K 的仅 29 次。所以最高桶是 `[512K,∞)`，它同时承担「≥512K 兜底」与「异常超长哨兵」两个角色，不必多一行恒空格子。
  - **口径不变**：厂商分档看的是「单次请求的输入 token 总量」，缓存命中只改变档内单价（通常标价 10%–20%）、**不改变落档**，所以计费输入 = `in + cr + cw` 正是分档长度，无需改口径；只算未缓存 `in` 反而会低估档位。
  - **这张图只是观测面**：OpenAI、Anthropic、DeepSeek、Kimi、腾讯混元 Hy3、GLM-5.2/5.3、qwen-max 等模型没有长度分档，落进哪个桶不映射任何价格档。
  - 与边界同批抬 `stateVersion` 3 → 6（见上方破坏性变更第 6 项，TS-18）。

- **tokstats 时间窗改为四档「近 7 天 / 本月 / 近 30 天 / 全部」**（默认近 7 天），替换原来的「近 90 天 / 近 30 天 / 全部」。加「本月」是因为滚动窗口回答不了「这个月花了多少」——月初看 30 天窗口会混进上月用量。**不改 host 侧窗口口径**：四档仍只发 `windowDays`，「本月」由客户端折算成「今天是几号」，host 侧 `today - (windowDays - 1)` 因此正好落在当月 1 日（TS-20）。档位选中态按 id 而非天数记录——「本月」在每月 7 号恰好也是 7 天，按天数记会让两个按钮同时高亮。

- **tokstats 面板重做信息层级**：原来是一列「标签 …… 数值」的纯文本，数据一多就退化成难扫读的清单。现在分四层：
  - **四张指标卡**：调用次数（附窗口内日均）、输入（附未缓存 / 缓存读拆分）、输出（附占输入的比例）、缓存命中率（附命中 / 计费输入）；四卡副值各自拆自己的主值，互不复述（见 Fixed）；
  - **每日调用量柱状图**（整行）：按窗口跨度自动逐日或合并成列，柱高用平方根刻度（实测日量差异可达百倍，线性刻度下除峰值外全压成细线）；左轴三档刻度 + 2 条网格线、峰值柱顶标数值（见 Fixed），精确数字在 tooltip；
  - **上下文长度分布改为占比条**：每行 = 标签 + 占比条 + 次数，每桶明细下移到第二行——原来长数值把条形挤成两段，条长不可比；
  - **工作区排行**：按调用次数排序带占比条，标签取路径末两段（完整路径在 tooltip）；
  - **周趋势改为四列表**（周起点 / 次数 / 输入 / 输出），promptopt 计数卡补采纳率与字符增减行。
- **面板新增刷新按钮**：窗口与工作区不变时也能重新拉一次数（此前只能靠切档位间接触发）。
- **页脚右侧显示统计区间**（`7/24 – 10/21`），「全部」档显示「全部历史」。
- **窄窗口折成单列**：主区宽度 900px 以下，2:1 分栏自动变单列。
- **面板改四行布局**：每日图（整行）→ 上下文分布（2fr）+ 周趋势（1fr）→ **模型排行（2fr）+ 工作区（1fr）** → promptopt（1fr）。工作区卡从原来的 2fr 位置移到新第四行的 1fr：模型标签最长 42 字符，需要宽列；工作区标签取路径末两段，本来就短。

### Added

- **host 侧新增每日序列**：`tokstatsAggregate` 返回值加 `daily`（`{ day, calls, in, cr, cw, out }[]`，按日升序），面板柱状图的唯一真源。
- **周趋势改由每日序列归并**：不再独立遍历明细。此前两趟各自过滤 epoch 与窗口，任一处漏条件都会让「周合计 ≠ 日合计」只能靠人工对账发现；现在周合计之和恒等于总计。
- **工作区行补 `cr` / `cw`**：与 `totals` 同形状，面板 tooltip 与明细行可显示完整四桶。
- **面板新增「模型排行」卡**：按 `provider/model` 的用量占比排行（**不做成本核算**，无金额、无「未配价」、无价表）。与工作区卡同构：全量列出、占比条、次数、`输入 · 输出 · 命中率` 明细，完整组合名进 tooltip。拿不到路由的样本单列「未标注」行并排最后，保证各行次数之和恒等于总计。
- **host 侧新增路由维度**：投影 cell 从 `{ d, b }` 扩为 `{ d, b, rt }`，`rt = provider + "/" + model` 的**不透明字符串**（浏览器侧不拆、不解释）。路由唯一来源是 `assistant/message` 的 `message.source`，刻意不读请求侧事件——那是配置快照，与 usage 结算不同源，混用会让数字无法对账。
- **epoch 折叠保留「桶 × 路由」粒度**：折叠掉的历史仍可归因，排行不随窗口推进悄悄少行。
- **聚合新增 `routes`**：`[{ rt, calls, in, cr, cw, out }]`，按次数降序、同次数按 `rt` 字典序、`""`（未标注）显式排最后。
- **分发元数据齐备（`package.json`）**：补 `author` / `repository` / `homepage` / `bugs` / `keywords` / `icon`，新增 `engines.dsh` 与 `dsh.compatibility.dshReleases`；新增 `icon.svg`（与侧栏「Token 分析」入口同一三柱造型，`currentColor` 单色，宿主按 SVG 原样内联）并加入 `files`。此前包在插件市场 / 设置页里没有作者与主页可跳，也读不到图标。
  - **`engines.dsh` 写精确版本 `0.2.1-rc.2`，不写区间**：宿主按 `engines.dsh` **单独**判定兼容性（有该字段时忽略 `peerDependencies`），不满足就**整包跳过**且只记进 `skippedBundles`、不打印。写一条没实测过的区间等于替未知版本放行——rc 阶段官方保留破坏权，宁可失败关闭。升级宿主后若插件 UI 消失，先查这条 pin（README「支持的 dsh 版本」写了排查与重验清单）。
  - `dsh.compatibility.dshReleases` **只列实测过的版本**（`0.2.1-rc.2`: compatible）。**无任何自动化消费方，仅人读**（实测：宿主 asar 内 7026 个 `.js` 条目全文扫 `dshReleases` 0 命中，官方市场只读 `engines.dsh`，第三方 `dshmarket` 亦 0 命中）——所以更不能凭推测写。
- **包级展示元数据（`locale/en.json` + `locale/zh.json`，PK-13）**：此前宿主插件页把这个包显示成 `dsh-plugins`（原始包名）加一段中文长描述——因为 `readPluginMeta` 的标题回退链是「包级 `locale` 的 `meta.title` → `package.json` 的 `name`」，而本包没有包级 `locale`，且英文界面下描述也照显示中文。现在两条语言文件都带 `meta.title` / `meta.description`，插件页显示「Token 工具集」/「Token Toolbox」并随宿主语言切换。
  - `package.json` 的 `exports` **只新增** `"./locale/*.json"`（不动 `.` / `./client` / `./package.json`）：宿主的 `optionalResourcePath` 走 Node ESM 解析器，未放行的子路径抛 `ERR_PACKAGE_PATH_NOT_EXPORTED` 后整段元数据静默退化为包名。`files` 同时加 `locale`，否则 npm / git 安装按白名单把文件丢掉（本机 `link:` 安装是 junction 直通仓库，**掩盖**这一条，只能靠 `npm pack --dry-run` 验）。
  - **与 client 内词典是两层不同东西**，本次一个字都没动 `lib/client.js`：包级 `locale` 是「宿主不启动 client 也能读的包元数据」（插件页 / 市场卡片），`LOCALE_NS_*` + `dicts` 是运行时界面文案。官方 96 个 client/bundle 包里 89 个都带包级 `locale/`，这层是事实标准。
  - 新增 guard 项 PK-13（文件与 `meta` 结构 / 语言 id 文件名 / `exports` 键 / `files` 项），失败信息写明「不改会怎样」。**缺 `meta` 外壳**（写成 `{"title":…}`）是最隐蔽的形态：JSON 合法、`npm test` 全绿、宿主不报错，标题静默回退成包名——已用反向验证确认 guard 能拦。
- **位图店招 `docs/assets/icon-180.png`（180×180 RGBA，1.7 KB）与 `screenshots.json`**：社区目录只接受 GitHub 托管的位图（SVG 会被拒），沿用 `icon.svg` 的三柱造型按品牌色 `#4D6BFE` 独立渲染（原 SVG 用 `currentColor`，单独渲染时无继承色会变黑）。`screenshots.json` 列四张既有截图的相对路径并进 `files`——本机 `dshmarket@1.66.45` 尚不读它，属前瞻性准备（新版市场读）。两者都只服务对外展示，不进任何运行路径。
- **PK-14 包身份一致性 guard**：以 `package.json` 的 `name` 为唯一真源，派生校验 `cordis.patch.yml` 每行 `name:`、`lib/client.js` 的 `__ModuleLoader__.load({id})`、每插件 `ns` 的包前缀与 `data-plugin-css` 前缀。此前这四处**没有任何静态检查**，而漏改一处（尤其是 `id:`）的后果是「插件 UI 整个消失、宿主不报错、guard 与全部测试全绿」——这是改名必须先落地本行的原因。

### Fixed

- **同一根工作区的多个会话互相覆盖（真实缺陷，v0.6.0 起存在）**：`tokstatsAggregate` 用 `workspaces.set()` 写入，同一工作区的后一个会话会整段覆盖前一个，导致工作区排行各行的次数远小于总计。改为累加合并。此前纯文本列表下这个差额不显眼，v0.7.0 的排行占比条把它暴露出来。**升级后工作区数字会变大，那是修正而非回归。**

## [0.6.0] - 2026-10-20

> **破坏性变更**（四项，均可回滚）：
> 1. **tokstats 面板入口变更**：侧栏底部按钮 + 弹层 → 侧栏列表项 + 全局面板。旧的 `sidebar.footer.action` 座位已被官方 cordis-panel 占用。
> 2. **tokstats 成本与模型维度整体删除**：`config.prices` 不再存在，任何用它覆盖价格的 profile patch 会变成未知字段。实测 91.8% 调用走第三方 provider，本地估算没有可对账的权威价格来源。
> 3. **tokstats 投影单元 `stateVersion` 由 1 提升到 2**：旧缓存行被版本检查丢弃并自动冷折叠重建，**不需要手工清缓存**。
> 4. **tokprev 信息面收缩**：删除每轮真实消耗徽标（`conversation.chat.assistant-actions` 不再注册），预告行从「上下文 + 排队 + 草稿 + 占比」收为三点式。

### Changed

- **tokstats 宿主侧改为注册官方投影单元**：删除自建 checkpoint 文件（`storages/tokstats-checkpoint.json`）、persistence 适配层、revision 对账、flush 增量监听与防抖写盘。持久化与冷启动交给官方 session-projection-cache，**本插件不再写任何自有文件**。旧 checkpoint 文件留在原处不再被读写，确认无误后可手工删除。
- **tokstats 客户端改为全局面板**：`sidebar.panellist` 列表项 + root `main` keyed slot。主体收敛到上下文桶分布 + 周趋势 + 工作区分组三块；弹层定位全套（`useLayoutEffect` + `resize` + `pointerdown` + Esc）随弹层一并删除。数据在打开 / 切窗口 / 切工作区时各拉一次，不做常驻推送。
- **tokstats 时间窗改为三档窗口**：今日 / 本周 / 累计 → 近 90 天 / 近 30 天 / 全部。原三档在实测强度（5 天历史）下退化重复。
- **tokprev 预告行改为三点式**：`下一轮输入 ≈ N · 草稿 M · 输出预估 X–Y`。上下文基线与窗口占比已被官方 ContextMeter 覆盖，排队估算与每轮徽标已被 TurnUsagePanel 覆盖，重复显示只是噪音。投影依赖因此只剩 `contextPressure` 一个。
- **promptopt 定位从「润色」改为「保真结构化重排」**：新的 meta-prompt 禁止新增原文不存在的事实/路径/约束/步骤，不确定时保留原样，原文已足够结构化则原样返回。界面文案同步从「优化」改为「整理」。
- **tokstats 面板新增 promptopt 使用计数**：发起 / 采纳 / 放弃与采纳后的字符增减。

### Added

- **promptopt「无需整理」形态**：产出与原文等价时弹层显示提示并禁用采纳按钮——采纳一个没有变化的文本没有意义。
- **promptopt 计数器**：落官方存储域（`dsh_plugins_promptopt` 域），跨重启可查。发起 / 采纳 / 放弃分开计数，采纳另记字符增减量。存储域不可用时计数器静默停用，不影响优化功能。
- **结构 guard 新增三项静态校验**：`lib/index.js` 无写盘调用、`lib/client.js` 无 `prices` 字面量、无 provider/model 维度用法。

### Fixed

- **`connection.rpc.handle` 的第三参数是死参数**：0.2.1-rc.2 起该方法只有两参，per-channel `authority` 选项已不存在（信任判定上移到连接层的 Host/Origin fence）。删掉它——留着只会让人以为那里还在做鉴权。
- **fork 子会话的用量归并口径**：`readSession` 不返回 `seedLength`，改读 `inheritedEventCount`；对账验证 14 个存量会话的每一格数字与旧实现完全一致。

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

[Unreleased]: https://github.com/PlusQi/dsh-tokstats/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/PlusQi/dsh-tokstats/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/PlusQi/dsh-plugins/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/PlusQi/dsh-plugins/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/PlusQi/dsh-plugins/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/PlusQi/dsh-plugins/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/PlusQi/dsh-plugins/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/PlusQi/dsh-plugins/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/PlusQi/dsh-plugins/releases/tag/v0.2.0
