# dsh-plugins 维护说明

> 状态：Active
> 适用范围：本仓库的维护流程与插件实现细节
> 维护责任：修改对应流程或契约的提交者
> 最后核验：2026-10-21

本文件承载**维护者向**的内容。使用者视角的安装与用法见 [README](../README.md)，仓库级硬规则、变更路由与提交规范见 [AGENTS.md](../AGENTS.md)，不变量编号的定义与证据指针见 [INVARIANTS.md](./INVARIANTS.md)。四者分工：AGENTS.md 是**规则**，本文件是**详述**，不变量登记表是**证据指针**，README 只讲使用者看得见的东西。

## 包结构（为什么是混合包）

本包从 v0.2.4 起是**混合包**：tokprev 是纯浏览器 UI；tokstats 与 promptopt 含 host 半边实现（tokstats 注册一个 per-session 投影单元，持久化交给官方会话投影缓存；promptopt 注册 RPC 通道做一次旁路模型调用，计数器落官方存储域）。**两个 host 半边都不写 `$DSH_HOME` 下的自有文件**——这是 v0.6.0 起的硬约束，由结构 guard 静态把关。

## 发布到 GitHub

```powershell
git remote add origin git@github.com:PlusQi/dsh-plugins.git
git push -u origin master
git tag vX.Y.Z; git push origin refs/tags/vX.Y.Z   # 必做：#vX.Y.Z 固定安装靠它，漏打则该版本号装不上；显式 ref 而非 --tags
```

**打 tag 前的硬门槛**：link 安装目标提交 -> 重启 dsh web -> 刷新页面，目检**每个插件**的 UI 元素实际渲染。"启动无报错 ≠ 插件正常工作"——slot 注册是副作用，apply 提前返回或抛错都可能静默失效。目检不过不打 tag。

推上去即可被安装，无需注册表。`files` 字段保证打包形态（git 安装 / npm 安装都走打包）只带运行必需件加文档：
`lib/` + `icon.svg` + `cordis.patch.yml` + `AGENTS.md` / `CHANGELOG.md` / `docs/MAINTAINING.md` / `docs/INVARIANTS.md`（README / LICENSE / package.json 由打包器自动附带，不必列）。
`icon.svg` **必须**在 `files` 里：`package.json` 的 `icon` 指向它，宿主按包内相对路径读成 data URL 内联；漏了只会在插件元数据里留一条 `meta.error`，界面表现是「没有图标」而不是报错。

**本包只从 GitHub 分发**：不要在任何文档里写「从 npm 装 `dsh-plugins`」——npm 上那个名字是别人的包，见下节「分发与元数据纪律」。

**`docs/INVARIANTS.md` 必须进包**：AGENTS.md 的路由表指向它，包内若缺这份文件，装包者拿到的就是一张指空的必读清单。同理，AGENTS.md 里不得再引用 `docs/specs/`（本地 gitignored，不随包分发）——需要引证据时引 `docs/INVARIANTS.md` 的行号。

`docs/assets/` 的四张截图**不进包**（1.1MB，看 GitHub 上的 README 就够）：包内 README 的文本链接可达，但效果图会裂。要连图一起带，把 `docs/assets` 加进 `files`。

## 新增插件（本包的维护模式）

1. `lib/client.js` 的 `PLUGINS` 注册表加一段：`css` + **`ns`** + **`dicts`** + `apply(ctx)`（helpers、组件、词典、`ctx.slots.inject(...)` 注册块都放这段里）：
   ```js
   const LOCALE_NS_XXX = "dsh-plugins.xxx";
   const xxxZh = { "row.title": "标题" };
   const xxxEn = { "row.title": "Title" };
   // PLUGINS 内：xxx: { css: xxxCss, apply: xxxApply, ns: LOCALE_NS_XXX, dicts: { zh: xxxZh, en: xxxEn } }
   ```
   `npm run guard` 会拦下漏带 `ns` / `dicts` 的注册块；该插件确无任何界面文案时显式写 `ns: null`。
2. `cordis.patch.yml` 加一行（`name` 固定 `'dsh-plugins'`，`config.plugin` 指向注册表键；id 带自己的前缀，别撞 dsh-base/dsh-web-app 内置 id）：
   ```yaml
   - id: xxx
     name: 'dsh-plugins'
     config:
       plugin: xxx
   ```
3. **文案一律走词典**：slot 注册声明 `locale: ns` 取得标准席位 `t`，文案写成 `{name}` 占位符整句模板（英文按英文语序重写，不做片段拼接），带计数的文案按 `.one` / `.other` 成对出键；测试里调 `assertDictPair`（`test/client-harness.mjs`）断言 zh/en 键集一致——本包无构建步骤，官方那层编译期保障只能由它替代。术语对照见 [AGENTS.md](../AGENTS.md) 硬规则 7。
4. 在本地留存该插件的决策记录（不随仓库分发，供维护者回溯）；
5. 重启进程。**零安装操作。**

## 多插件结构的四条硬约束

（来自 DSH 本体，调整前先读）

- **client bundle 按包名发现**：host 按 entry 的 `name` 解析 `<name>/package.json` 读 `dsh.client` 声明，整包服务 `exports["./client"]`。行 name 必须是裸包名 `dsh-plugins`；写成 `dsh-plugins/xxx` 子路径只剩 host 半边（dsh-web-app 的 `web-startup` 行就是这种 host-only 子路径用法）。
- **client 模块图按包扁平**：一个包的 client 半边 = 一个模块节点，包内不能拆多文件（bundle factory 里的 `require` 只认模块表词，相对路径直接抛错）。所有插件共用 `lib/client.js` 单文件靠分段纪律维护，这是"无构建步骤"的边界。
- **host 按行分 fiber，client 每包单 fiber**：patch 每行建一个 **host** fiber，`config.plugin` 是 host 侧分发键（dsh-base 的 `tool-subagent` / `tool-subagent-fork` 是同名多行参考）。本包 `lib/index.js` 的 `apply(ctx, config)` 按该键分发：纯 UI 插件的 host 半边为空（行即存在/禁用锚点），tokstats 的 host 聚合器宿主在 `tokstats` 行的 fiber 上（行禁用 = 统计停摆）。**client 侧** **`__DSH_BOOT__`** **每包只建一个条目且不传 config**（`dsh-client-modules` 按包名构建 boot graph），因此 `lib/client.js` 的 apply 无条件注册 `PLUGINS` 全部插件，靠组件数据不可用时返回 null 降级；客户端不存在"第二行再跑一遍 apply"，也不可能在客户端按 `config.plugin` 分发。host 半边额外受模块图约束：pnpm link 安装下插件真实路径不在宿主 node\_modules 树内，**npm 包 import 不可解析**——`lib/index.js` 只用 `node:` 内建 + `apply(ctx, config)` 参数，不 import cordis/zod 等运行时依赖。
- **样式按插件分 tag**：每插件一个 `data-plugin-css="dsh-plugins/<id>"` tag（`ensurePluginStyles` 幂等注入、随包 fiber 停止移除）；保持插件块独立颗粒度，日后单插件独立成包时连样式原样带走。

插件长大了要独立发布/独立 repo？把注册块连同 patch 行复制出去单开包即可（可参考本仓库已有插件的实现与打包方式）。

## 插件的 host 侧行为与宿主契约

### tokprev

UI slot `conversation.composer.dock`（**只此一个**：`conversation.chat.assistant-actions` 的每轮徽标已在 v0.6.0 删除，官方 TurnUsagePanel 已覆盖该信息）；投影字段 `contextPressure`（**只此一个**：`contextBreakdown` 依赖已删）；`AssistantMessageNode.usage`（仅取输出历史算 P25–P75）。所有读取路径均带优雅降级（拿不到数据渲染 null，不会报错）。

### tokstats host 侧行为（v0.6.0 起；v0.7.0 加每日序列与路由维度）

架构：**注册一个 per-session 投影单元**，持久化与冷启动交给官方管线，本插件不写任何自有文件。

- **单元**：`key: "dsh-plugins.tokstats"`、`stateVersion: 6`、`state: { w, seed, epoch, rows, last }`。宿主 `ctx.sessionProjections` 在每个已提交事件上驱动 `apply`；`init(header, inheritedEventCount)` 记下 `w`（会话自身 cwd）与 `seed`（fork 继承前缀长度）。
  - **key 带包前缀**：v0.7.0 由 `"tokstats"` 改名，消除与宿主日后注册同名单元的撞车风险（撞车时注册抛错、`startTokstats` catch 后静默退回冷折叠，属极难排查的降级）。宿主对 key 的字符集**零限制**，且 key 只进缓存文件内的字段名、不进文件路径。
  - **旧 key 残留**：官方缓存从不在 `session/disposed` 删记录，改名后旧的 `tokstats` 行留在 `<id>.json` 里不再被读取（每会话数百字节），本版不处理。
- **必须带 `wire`**：只有带 wire 块的单元才出现在 `snapshot` / `cachedSnapshot` / `viewCheckpoint` / `restore` 的公开读取面上（host-only 单元被全部跳过）。`wire.view` 只返回 `{ w, e, rows }`——浏览器侧拿不到跨会话聚合；路由以单个**不透明字符串** `rt` 随 cell 自然带出。
- **cell 三维**：`{ d, b, rt, calls, in, cr, cw, out }`，单元键为 `d \x1f b \x1f rt`。
  - `rt = provider + "/" + model`，由 host 侧拼合并解释；client 把它当整串标签渲染，**不拆、不按 provider/model 做维度用法**（guard 的 `DIMENSION_USE` 四条正则仍在扫 client 产物）。
  - **`rt` 唯一来源**是 `assistant/message` 的 `message.source`（实测带 usage 的 message 100% 齐备）。**刻意不读请求侧事件**：那是请求侧配置快照（带 initial / change / series / resume 四种 reason），与 usage 的结算语义不同源，混用会让「路由」与「用量」来自两条独立路径、数字再也无法对账。guard 静态项会拦 `request/header` 字面量（含注释行）与 `header.config` 读取。
  - **空串 `""` 是「未标注」的唯一表示**（不引入 `null`：JSON 往返与 Map 键都要额外分支，空串天然可排序）。唯一现实来源是「只有 usage chunk、没有同 step 的 message 终值」的步（实测 0.18%），它们仍计入 `calls`。
- **折叠语义**：计费输入 = `in + cr + cw` 落**市面计费档 6 桶**（边界 `[8K, 32K, 128K, 256K, 512K]`，标签 `[0,8K)`…`[512K,∞)`；对齐厂商「按输入长度分档」的真实档位，**不是 2 的幂**）；`seq < seed` 的样本跳过（fork 前缀父会话已计过）；同 `(turn, step)` 的后一样本替换前一样本（差值法：先减旧再加新，**按 `(d, b, rt)` 定位**——旧采样与新采样可能落在不同路由，跨桶跨路由都正确）；无关事件返回同一引用（`Object.is` 成立）。
  - **桶边界与 `stateVersion` 必须同批变更（TS-18）**：cell 只存桶序号 `b`、不存区间，边界一变同一个 `b` 就指向另一个区间，只改边界不抬版本是**静默错位**而不是报错。边界数组（`TOKSTATS_BUCKET_BOUNDS`）与版本号钉在同一条测试断言里，改任一半都必须显式改另一半。
- **E1 折叠**：窗口（`config.windowDays`，缺省 90）之外的明细按「桶 × 路由」加进 `epoch.routes: [{ rt, buckets[6] }]`，`rows` 本体不删不改；读取期按 `[epoch.start, epoch.end)` 排除明细并改计 epoch 合计，因此「折叠前后明细条数不变、各桶数字逐项一致、逐路由合计一致」三条同时成立。
  - **面板的四个时间档位都只发 `windowDays` 一个入参**（TS-20）：近 7 天 = 7、近 30 天 = 30、全部 = 0，**「本月」= 当天日期数**——因为 `tokstatsWindowStart` 的定义是 `today - (windowDays - 1)`，取「今天是几号」代入即落在当月 1 日。不要为「本月」给 host 加第二种窗口口径：那样折叠窗口（`config.windowDays`，决定 epoch 边界）与读取窗口会出现两套语义，而 epoch 区间一旦与读取口径不一致就会双计或漏计。客户端侧的折算函数是 `tokstatsRangeDays`，与这里的式子由 `test/host-tokstats.test.mjs` 的 TS-20 用例跨模块钉住。
  - **内层字段名是 `buckets`**（沿用旧结构同名），外层是 `routes`。
  - **旧结构防御**：读到无 `routes` 但有 `buckets` 的 epoch 时，视为单一路由 `""` 的一组桶（`stateVersion` 抬升后旧缓存行本就会被丢弃，但 `tokstatsSummaryOf` 对 `e` 只校验 start/end，兜底成本极低）。
- **汇总**：面板打开时经 RPC 现算。逐会话先 `cachedSnapshot(meta, ["dsh-plugins.tokstats"])`（零 I/O），取不到才 `readSession` + `coldSnapshot` 冷折叠兜底。**活会话（`record.live === true`）跳过缓存**直接冷读——官方检查点可能滞后于日志且其 `asOfSeq` 无法与调用方稍后打开的日志关联（实测踩到 fork 会话少报 80%）。根工作区在汇总侧按 `listSessions()` 的 header 链解析（`init` 拿不到 headersById）。
- **汇总输出形状**（RPC `summary` 端点返回值，面板唯一消费面）：
  ```
  { buckets[6], daily[], weekly[], routes[], workspaces[], totals, windowStart, windowDays, generatedAt, workspace?,
    coverage: { sessions, skipped }, epoch: { end, calls } | null }
  totals / 每个 daily 行 / 每个 route 行 / 每个 workspace 行：{ calls, in, cr, cw, out }
  route 行额外带 rt；未标注行的 rt 是空串
  ```
  - **`coverage` 与 `epoch` 是本变更新增的两个纯增量字段**（TS-21 / TS-22），语义分别是「这次请求的覆盖率」与「本次聚合是否把折叠历史并入了某个代表日」：
    - `coverage.sessions` = 通过 `header.id` 校验**且通过 workspace 过滤**的会话数；`coverage.skipped` = 其中 `summary === undefined` 的条数（日志读不出来）。两条恒等约束：`sessions - skipped` 必须等于实际贡献了数字的会话数；**分母与分子同源**——切到单个工作区时别的工作区的会话不进分母，否则页脚会写「已统计 50 个」而数字只来自 2 个。
    - `coverage.priced` **刻意不存在**：PK-09 禁止成本维度，这里显式记一笔防止日后误加。
    - `epoch` 无折叠历史被计入时**必须是 `null`**（不是 `{}`、不是 `undefined`）——client 用 `!== null` 判定，形状模棱两可会让 client 走进「有折叠」分支去读 `end`。`end` 是 epoch 区间的末端，代表日由 client 算 `end - 1`（与 host 的 `tokstatsDayBefore` 同口径）；`calls` 是所有经 epoch 路径计入的调用数，只用于 tooltip 说明。
    - **`epoch` 有三个「不报」的边角**，都是打标会指错列的形态：代表日落在窗口外（切到「近 7 天」时最常见）、epoch 各格全零（那列可能压根不存在）、以及只读到 epoch 结构但没有非零格被计入。多个会话各有不同 `epoch.end` 时取**最早**的代表日、`calls` 求和（PLAN §3.3：区间端点互不重叠，取最小保证是真实的合成日）。
    - **两个字段都不进投影状态**（不在 `state` / `wire.view` 里），因此**不抬 `stateVersion`、不需要清缓存**——这正是 TS-03 举的反例：只给聚合输出加字段不需要抬版本。`wire.view` 键集仍必须是 `w` / `e` / `rows`，那条既有断言若变红说明字段被误塞进状态。
    - 旧 host 消费方（读不到这两个字段）不受影响：纯增量、可缺省，client 走 `undefined` 分支（与 `routes` / `daily` 同一手法）；新 client + 旧 host 时整句不渲染、不打标、不抛错。
  - **client 侧消费（第二批）**：页脚渲染 `已统计 N 个会话`，`skipped > 0` 时追加 `· 跳过 M 个（日志不可读）`；`skipped === 0` **不渲染**那半句（不写「跳过 0 个」这种假零）。日柱里代表日落在该列区间的柱子带 `dsh-tokstats-barEpoch` 类（斜纹 + 次要底色）并在 tooltip 写明「含折叠历史（区间末归并）· N 次」。
  - **日柱图的结构约定（第三批，TS-23）**：`.dsh-tokstats-chart` = 纵轴刻度列 `.dsh-tokstats-axisY`（定宽 44px、与绘图区同为 112px 高）+ `.dsh-tokstats-chartMain`（绘图区 `.dsh-tokstats-chartPlot` + 横轴 `.dsh-tokstats-axis`）。
    - **纵轴刻度必须与绘图区同高、且不共用容器**：刻度按 `bottom:70.7%` 绝对定位，参照系是所在盒子的高度。若把横轴放进同一个盒子，刻度会以「绘图区 + 横轴」为基准而上移——柱顶刻度会漂到柱体中部。
    - **刻度位置按平方根刻度算**：峰值在 `100%`、`峰值÷2` 在 `sqrt(0.5)=70.7%`、`0` 在 `0%`。等距三档（100/50/0）会让读者按线性读，而柱高是 `sqrt(calls/peak)`——两者对不上就是「轴在撒谎」。网格线 `.dsh-tokstats-gridLine` 与刻度共用同一组 bottom 值，**改一处必须改两处**。
    - **柱宽上限 48px 必须配 `justify-content`**：`flex:1` 触顶后剩余空间不再分给柱体，容器不显式决定（`center`）就全部落在右侧，少列时看起来像图没画完。60 列时每列约 13–20px（实测「全部」档 58 列 / 18px），上限对密排无影响。
    - **峰值柱顶标数值，其余柱只留 tooltip**：峰值标签 `.dsh-tokstats-barPeak` 绝对定位在柱顶上方（`bottom:calc(100% + 2px)`），不改变柱高。并列峰值只标第一根（`peakDayKey`），否则同屏出现两个同值标签。
    - **窄窗（≤900px）隐藏中间刻度**：三行标签在 44px 轴列里会互相挤压，留首末两个仍能读出量级。
    - **KPI 副值必须是对主值的拆分（TS-17）**：调用次数 = 日均；输入 = 未缓存 / 缓存读；输出 = **占输入的比例**（`tokstatsPct`，分母为 0 时破折号，不编 0%）；命中率 = **分子 / 分母**（`命中 X / 计费输入 Y`）。判据是「四卡副值两两不等」断言——只要有一条复述别的卡，它就红。
    - 词典新增 10 个键（`foot.coverage` / `foot.skipped` / `tip.coverage` / `tip.coverageSkipped` / `tip.dayEpoch` 各 `.one`/`.other`）。**占位符名必须与 `tCount` 注入的一致**：`tCount` 只注入 `{count}`，模板里写 `{sessions}` 会原样显示花括号（本批真实踩到，已加「不得残留未替换占位符」断言）。第三批另加 `tip.dailyScale`（刻度口径说明）并改写 `kpi.outputHint` / `kpi.hitHint`。
    - **代表日由 client 也算一遍 `end - 1`**：与 host 的 `tokstatsDayBefore` 是同一条式子的两份实现（两个模块图没有共享常量）。改任一边都要改另一边，否则打标会落到错误的列上——host 侧有「end 与读取期代表日同口径」用例钉住自己的那半。
    - **判据是「代表日落在列区间内」而不是 `=== startDay`**：长窗口下列会被合并（跨度 > 1 天），只比首日在「全部 / 近 30 天」档必然漏标。
    - 词典新增 10 个键（`foot.coverage` / `foot.skipped` / `tip.coverage` / `tip.coverageSkipped` / `tip.dayEpoch` 各 `.one`/`.other`）。**占位符名必须与 `tCount` 注入的一致**：`tCount` 只注入 `{count}`，模板里写 `{sessions}` 会原样显示花括号（本批真实踩到，已加「不得残留未替换占位符」断言）。
  - `daily` 是**时间维度的唯一真源**：`weekly` 由它按自然周（周一）归并，不再独立遍历明细——两趟各自过滤 epoch 与窗口时，任一处漏条件都会让「周合计 ≠ 日合计」只能靠人工对账发现。现在周合计之和恒等于 `totals`。
  - `workspaces` 与 `routes` 都按各自键**累加**合并（同工作区多会话是常态：fork 与并行对话；同 rt 也可能出现在多个会话）。v0.6.0 曾在 `workspaces` 上用 `set()` 覆盖，后一个会话整段盖掉前一个；v0.7.0 修。`routes` 是同一形状的同一个坑，实现时直接按累加写。
  - `routes` 排序写死两步：`calls` 降序；空串「未标注」**显式排最后**（空串在字典序里最前，直接按 `rt` 排会与界面直觉相反）；其余同次数时按 `rt` 字典序，保证输出完全确定。**epoch 的合计同时计入 `routes`**，否则排行会随窗口推进悄悄少行。
  - `daily` 的 `day` 是 host 本地自然日键；epoch 合计用区间末前一天当代表日（与既有周归并口径一致，只影响桶分布/趋势的落点，不影响排行）。
- **版本作废**：抬 `stateVersion` 即让旧缓存行被 `row.ver !== def.stateVersion` 丢弃，不需要写迁移。本次（3 → 6）抬版本的原因是 **桶边界改了三轮、同一个桶序号 `b` 会指向另一个区间**（TS-18）；上一次（2 → 3）是 cell 形状与 epoch 形状都变了。反例：仅给聚合输出加字段（如 v0.7.0 加 `daily`）**不需要**抬——那是聚合期派生、不进投影状态。
- **检查点滞后补偿（TS-19）**：已结束会话走 `cachedSnapshot` 时可能采信**远早于日志末尾**的检查点，实测本机 50 会话里 11 个滞后（最严重缓存 `seq=793` 而日志末序号 162925），面板少报 4.4% 调用 / 4.6% 计费输入。补偿是**逐会话惰性基线**：某会话首次汇总时冷读一次、把**本次读到的 events 最大 seq** 记进进程内记忆（`observedSeq`）；之后读缓存时若 `cachedSnapshot().asOfSeq` 低于基线，就判定滞后并冷读覆盖。
  - **基线不能取 `coldSnapshot().asOfSeq`**：实测 v0 格式会话它返回旧检查点水位（如 1126）而非日志末尾（148654），取它会让判定永不成立（`1126 < 1126` 为 false），冷读算出的正确结果被下一轮旧缓存覆盖。这是本次排查踩到的真实坑。
  - **代价**：进程启动后首次汇总要建立基线（每会话冷读一次）。**该代价已由 TS-24 移出首帧**：首次请求不再串行等待全量冷读，而是先用缓存秒开、把需要校验的会话排进后台队列，返回值带 `verifying: true`，客户端按 1500 ms 退避自动重拉直到收敛。`config.verifyStale: false` 仍可整块关闭，退回「只按 live 判定」（不建基线、不排队，采信滞后检查点）。
  - **TS-24 的性能事实（2026-10-22 实测，70 会话 / 约 50 MB 压缩日志）**：串行 `readSession` 累计 **16.9 s**（均值 238 ms、最长 1.26 s），而单会话折叠只有 **1–5 ms**——慢的全部是宿主 `readSession` 里的读+解压+`Session.create` 全量回放校验+深拷贝。**并发读无效**（上限 4 实测 16.97 s vs 串行 16.98 s：瓶颈是 CPU 同步回放，不是 I/O 等待，已回退）。**有效的是两条**：活会话走投影注册表零回放（宿主的 `drive()` 在每个 `session/event` 上已经增量推进过本单元，正确值本来就在内存里）；已结束会话的冷读移出首帧、改后台。改后同口径：首帧 RPC **39 ms**、面板 **85 ms** 出数、后台 **13 s** 收敛；缓存已在的重启场景面板 **102 ms** 直接显示终值。
  - **后台队列的三条纪律**：单飞（全进程一个 drain）、去重（同会话只排一次）、每会话**重试预算 2 次**。预算上限是双向必需的——读不出日志的会话永远建不了基线，无上限会让队列永不空、`verifying` 恒 true、客户端无限重拉；只试一次又修不了 TS-19 的「水位再次回退」。校验结果先进一次性内存表 `fresh`（下一帧立即可见），不必等缓存写回落盘。
  - **已知未解**：7 个 v0 格式会话的 `readSession` 只返回旧检查点之前的事件（缓存 `seq` 与日志 `maxPlain` 比值 0.5%–1.5%），冷读也拿不到后续事件。这是宿主侧格式迁移的截断行为，插件无法绕过；表现是这些会话的用量仍偏低（`ark-codingplan/glm-5.3` 少 115 次）。若日后宿主修复，本机制自动受益，无需改插件。
- **冷折叠耗时实测**（2026-10-21，本机 42 会话 / 24.1 MB 压缩日志）：清掉本插件缓存行后，从点开面板到出现首行数据 **6.7 s**；缓存建好后再次打开 **125 ms**；单次 `summary` RPC **26–31 ms**。冷折叠是一次性代价，`stateVersion` 变更的直接后果。**本次 3 → 6 升级后按同一口径复测**（清空 50 个会话文件的 tokstats 缓存行 → 点开面板 → 轮询到首行数值）：**8.3 s**，缓存建好后切窗口 **105 ms**——会话数由 42 增到 50，耗时同比放大，仍是一次性代价。**注意聚合数字会受检查点影响**：已结束会话走 `cachedSnapshot`（可能滞后于日志），活会话才冷读——实测同一时刻面板显示 2674 次而全量日志折叠是 2771 次，差额全部来自检查点滞后，不是归因缺陷。TS-19 落地后这个差额已由滞后补偿处理。
- **不改的东西**：RPC 通道名 `/dsh-plugins.tokstats` 与端点名 `summary` 是浏览器侧契约，与投影单元 key 是两件独立的事，key 改名时通道名不动。

> **改 host 半边必须重启宿主进程（踩过的坑，2026-10-21）**
>
> 宿主的 `@deepseek-ai/dsh-client-hmr` 会**热替换 client bundle**（每 500 ms 比对 `lib/client.js` 的 mtime/ctime/size，变了就 `rebuilt()` 并经 `/plugins/events` SSE 推给浏览器），所以改 `lib/client.js` 后刷新页面即生效。但它**只管 browser 侧**：`lib/index.js` 的 host 半边由 cordis 在启动时 import 并常驻内存，**hmr 不会重新加载它**，必须重启宿主进程。
>
> 误判的典型症状：**新的客户端 + 旧的 host**。此时聚合返回值里没有 `routes` 字段，而新 client 按硬规则 6 的旧-host 兼容设计**整卡不渲染**——表现是「刷新了还是没有模型排行卡」，而不是「卡显示旧数据」。同时缓存里会继续出现旧 key `tokstats@ver2` 的行（那是旧 host 写的），这是最快的判别信号：
>
> ```powershell
> # 有 tokstats@ver2 → host 半边还是旧的
> Select-String -Path "$env:DSH_HOME\storages\session_projcache\sessions\*.json" -Pattern '"tokstats":\{"ver":2'
> ```
>
> 注意 desktop profile 由 Electron 独占，**不能**用 `dsh --profile desktop` 另起实例（会报 `profile "desktop" is managed exclusively by the Electron application`），只能退出应用再重开（不是关窗口——可能只是隐藏到托盘）。

依赖（全部软依赖，缺席均不抛错）：
- slot：`main`（关键 keyed slot，id 必须与 panellist 的 `id` 一致）+ `sidebar.panellist`（列表项，第二参数是 `({ size })` 图标组件）；
- host 服务：`ctx.sessionProjections`（`register`）、`ctx.sessionQuery`（`listSessions` / `readSession`）、`ctx.sessionProjectionCache`（`cachedSnapshot` / `coldSnapshot`，经 `ctx.get` 惰性取）、`ctx.webServer`（自建 prefix 路由挂 RPC 通道）；
- `sessionQuery` 契约提醒：base 以 `path: ':memory:'` + `openAt: never` 挂载，**服务照常注册**（注册在构造函数里），`openAt: never` 只关全文检索。`listSessions` / `readSession` 走 live-preferred 语料，从不打开 SQLite——这是本插件敢直接依赖它、而不去碰 `sessionPersistence` 私有面的原因。

### promptopt host 侧行为

- 注册 RPC 通道 `/dsh-plugins.promptopt`（`ctx.connection.rpc.handle(channel, handler)`，随本行 fiber 卸载即摘），三个端点：
  - `optimize`：收 `{ text }` → 加内置 meta-prompt → `ctx.llm.stream` 收集完整输出 → 返回 `{ text, durationMs, noChange, usage? }`。`noChange` 由「产出与原文等价」判定，不是模型自报的标记；
  - `event`：收 `{ event: "adopted"|"dismissed", before?, after? }`，写计数器；
  - `counters`：读计数器。
- **meta-prompt 是内容协议，不进词典**：五条约束见 `lib/index.js` 的 `PROMPTOPT_META_PROMPT`（禁新增事实 / 不确定保留原样 / 已够结构化则原样返回 / 跟随草稿语言 / 只返回结果）。改它要同步 `test/host-promptopt.test.mjs` 的文本断言——[PO-01](./INVARIANTS.md) 靠那组断言把关。
- 错误只回机器码（`bad-request` / `model-unavailable` / `internal` / `cancelled`），由浏览器侧查词典渲染——host 侧没有 locale 服务，不拼人类可读文案；
- 60s 双保险超时；浏览器 abort（关闭弹层）即中止这次调用；
- **计数器落官方存储域**（域 `dsh_plugins_promptopt`、表 `counters`、单键 `totals`）：`spec` 是**手写**的，因为 `defineDomain` 在 npm 包里、硬规则 5 禁止 import。只提供设施真正读取的形状（`name` / `version` / `tables.<name>.valueSchema`，而 `valueSchema` 只要有个 `parse` 方法）。这是对官方内部契约的一处真实耦合——**DSH 升级后如果计数器整块消失，先查 `ctx.storageDomain.open()` 是否还接受这种 spec 形状**；
- **降级**：`connection` 或 `llm` 缺席时通道不注册，点按钮显示「模型调用失败」而不是白屏；`storageDomain` 缺席或域打不开时计数器停用（记一条 warn），优化功能不受影响；`connection` 用 `ctx.get` 惰性取而不是 `inject`——后者是硬依赖，缺席会连带 tokprev / tokstats 一起不加载。

依赖：UI slot `conversation.input.right`（composer 卡片**内部**工具行）；`InputActions.setDraft` 与 `InputState`（`draft` / `imageIds` / `occurrences` / `claim`）；客户端服务 `ctx.connection.rpc.call`；host 服务 `ctx.connection.rpc.handle`、`ctx.llm`（`stream` / `listProviders` / `listModels`）与 `ctx.storageDomain`（`open` / `get`）。

DSH 升级后若按钮点了没反应或一直报错，先对照这些契约——尤其是 RPC 响应信封（成功必须是 `{ ok: true, value }`，错误码取自宿主闭集）与 `GenerateOptions` 的 `provider` / `model` 必填约束。

### 触发位置的迁移史

v0.5.0 起初把 promptopt 放在 `conversation.composer.dock`（与 tokprev 预告行同带），实际用起来发现 dock 是宿主契约标注的「环境读数带」、可点控件本就该在 tool row——v0.5.1 挪到 `conversation.input.right` 符合「发送前顺手点」的操作逻辑。

## 分发与元数据纪律

- **本包没有发布到任何 registry，只能从 GitHub 安装**。npm 上的 `dsh-plugins@0.1.2` 是 MeCKodo 的插件市场 CLI（bin `dsp`），与本项目无关；dshfind 等索引已把两者混成一条记录（og:description 是本项目文案，Version / 安装命令指向别人的包）。
  - 因此**任何文档都不得写「从 npm 装 `dsh-plugins`」**——照做会装上别人的包，且失败时表现为「插件没生效」而不是「装错了」。README 中英已删掉该句并改成显式警告。
  - 包名改 scoped（`@plusqi/dsh-plugins` 实测 404 空闲）作为**独立决策**待维护者裁决，不在本变更内：爆炸半径是 10 个文件（`lib/client.js` 15 行 / `lib/index.js` 19 行 / guard 11 行 / 5 个测试文件 15 行 / `cordis.patch.yml` 6 行 / `package.json` 1 行），guard 三处硬编码（`row.name` / `ns` 前缀 / `data-plugin-css` 前缀），且改投影单元 key 会让所有旧缓存作废（需冷折叠一次）。
- **`engines.dsh` 写精确版本，不写区间**。宿主 `evaluatePluginCompatibility` 的判定是：**有 `engines.dsh` 时它单独决定、忽略 `peerDependencies`**；不满足就整包跳过（`loadProfileDirectory` 把它记进 `skippedBundles`，**不打印任何东西**）。写一条没实测过的区间等于替未知版本放行，而 rc 阶段官方保留破坏权。当前 pin 是 `0.2.1-rc.2`；升级宿主后按 README「支持的 dsh 版本」的三步重验，再抬 pin 并同步本文件「开发所对版本」。
  - `dsh.compatibility.dshReleases` 是**描述性**元数据（宿主运行时不读它，供插件市场与读者查），只列实测过的版本。它和 `engines.dsh` 必须表达同一事实，不能一个说兼容、另一个把整包挡掉。
- **`icon` 字段**：值是包内相对路径（绝对路径与 `file:` 之类的 scheme 会被宿主拒绝），宿主按 SVG/PNG/JPEG/WebP 读成 data URL 内联，**上限 256 KiB**，且必须留在 manifest 所在目录内。当前 `icon.svg` 与侧栏图标同一造型、单色 `currentColor`。`files` 必须含它，否则 git 安装后读不到（宿主此时只回一条 `meta.error`，界面表现为没图标）。

## 维护须知

- **无构建步骤**：`lib/client.js` 即最终产物（纯 JS，不用 TS/JSX，React 经 ModuleLoader 注入）。改动 = 编辑 + 重启。`lib/index.js`（host 半边）同为纯 JS：只 import `node:` 内建（fs/os/path），不引 npm 运行时依赖。
- **兼容面**：tokprev 依赖 UI slot `conversation.composer.dock` 与投影字段 `contextPressure`；tokstats 依赖 `main` + `sidebar.panellist` slot、`ctx.sessionProjections`、`ctx.sessionQuery` 与 `ctx.sessionProjectionCache`；promptopt 依赖 `conversation.input.right` slot、`InputActions.setDraft`、`ctx.connection.rpc.call`、`ctx.connection.rpc.handle`、`ctx.llm` 与 `ctx.storageDomain`（明细见上节）。界面文案另依赖客户端服务 `ctx.locale`（注册词典 + slot 注册声明 `locale` 命名空间取得 `t` 席位）——它是硬依赖，缺席时整包不加载。DSH 升级后若插件消失，先对照这些契约。所有读取路径均带优雅降级（拿不到数据渲染 null，不会报错）。
- **开发所对版本**：DSH `@deepseek-ai/dsh 0.2.1-rc.2`（`package.json` 的 `engines.dsh` 钉的就是它；宿主版本号从 `@deepseek-ai/dsh-app-boot/package.json` 读，与 `dsh-runtimes/*/runtime.json` 的 `desktopVersion` 一致）。host 侧是**一次性压多个深契约**（`InputActions` / `connection.rpc` / `llm.stream` / `sessionProjections` / `sessionQuery` / `sessionProjectionCache` / `storageDomain`），且 rc 阶段官方保留破坏权——升级后优先重验：RPC 信封形状（成功必须是 `{ ok: true, value }`，错误码取自宿主闭集）、`GenerateOptions` 的 `provider` / `model` 是否仍必填、`connection.rpc.handle` 的签名（**0.2.1-rc.2 起只有两参，旧的 `options.authority` 已不存在**）、投影单元的 `init(header, inheritedEventCount)` 与 `wire` 读取面、`sessionQuery` 的 `listSessions` / `readSession` 返回形状、`storageDomain.open()` 是否仍接受手写 spec。
- **开发循环**：先用动态 Cordis 插件（`cordis_define` -> `cordis_run`）在会话内热迭代原型，满意后落入本包。
- **单插件开关的真实语义**：`disabled: true` 只摘除该行的 **host 侧** fiber，浏览器侧 bundle 是否加载取决于**包内是否还有任一行存活**（DSH 的 boot graph 按包名判活，客户端每包一个 fiber、无条件注册全部插件）。对 tokstats 这类 host 半边有实际工作的插件，禁用行即停掉聚合器与统计（客户端按钮还在但无数据）；对 tokprev 这类纯 UI 插件，禁用一行**不会**移除其浏览器 UI（tokstats 行会让整个 bundle 存活）。需要按插件独立开关，请把该插件独立成包（见「新增插件」末尾）。
