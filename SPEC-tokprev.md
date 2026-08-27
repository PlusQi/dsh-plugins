# tokprev - 设计定稿（单轮 Token 消耗预告插件）

- **状态**：已定稿（grilling 会话共识，2026-08-26）
- **归属**：`dsh-plugins` 扩展集首成员（`lib/client.js` 的 `── plugin: tokprev ──` 段 + `cordis.patch.yml` 的 `id: tokprev` 行）
- **参照物**：workbuddy 的每轮 credits 消耗预测 + 对话过程实时 token 计量

---

## 1. 背景与目标

workbuddy 在每轮对话上方显示该轮的消耗预测。经环境核查，DSH 官方 stats line（composer 底部）已覆盖"实时累计 token 计量"需求（累计计费输入/输出、缓存命中率、tok/s、TTFT 等，每次调用落账后刷新），故本插件聚焦于：

1. **发送前的下一轮消耗预告**（预测）；
2. **每轮结束后的真实消耗徽标**（回顾，后期回归需求）。

## 2. 决策记录

| # | 决策点 | 结论 | 备选与否决理由 |
|---|---|---|---|
| Q1/Q6 | 交付形态 | **C：动态原型 -> 静态定稿两段** | 纯动态重启即失；纯静态迭代慢 |
| Q2 | 计量单位 | **C：纯 tokens**，不引入货币/价格表 | 货币需维护价格表；抽象 credits 无对账意义 |
| Q3 | 预测语义 | **A+B：输入侧预告 + 输出侧区间**，区间用最近 5 轮 P25–P75 | 整轮多步总账需假设步数，两层投机，不做 |
| Q4 | 预告座位 | **A：`conversation.composer.dock`**，与 stats line 同带形成"已消耗 \| 将消耗" | `input.dock` 占独立一行，弃 |
| Q5 | 草稿跟随 | **A：实时跟随打字**（实现升级为官方 props，见 §11） | 不跟随则新会话首轮严重低估 |
| 修订 1 | 轮尾徽标 | **回归需求**：每轮一条真实消耗 | Q4 时曾搁置，用户明确要求与轮次绑定 |
| 修订 2 | 输出区间数据源 | 改用按轮真实 `usage` 分组（durable），弃内存采样 | 刷新不丢历史，与徽标口径一致 |
| 开销评估 | 系统资源 | 接受：打字期每 ~300ms 微秒级计算；空闲近似零开销 | 详见 §6 |

## 3. 功能规格

### 3.1 组件 1 - Composer 底部预告（发送前）

**座位**：`conversation.composer.dock`（list entry，session-scope）。

**公式**：

```
下一轮输入 ≈ contextPressure.projectedTokens      （上下文基座，提供商锚定）
           + Σ 估算(队列消息)                       （InputState.queue）
           + 估算(草稿)                             （InputState.draft，随打字实时）
输出区间   = 最近 5 轮真实 outputTokens 的 [P25, P75]（无历史 -> 默认区间 + 标注）
占比       = 下一轮输入 / contextPressure.contextWindow
```

**形态示例**（原型现场调）：

> **下一轮 ~36.2K tok（28%）** · 输入 34.1K（上下文 33.8K + 草稿 0.3K）· 输出预估 1.5K–3K

**降级路径**：
- `projectedTokens` 缺失（空会话/无提供商锚点）-> 回退 `contextBreakdown`（system+tools+message 启发式），加 `*` 前缀标注粗估；
- 会话运行中 -> 隐藏（预测对象不存在）。

### 3.2 组件 2 - 轮尾真实消耗徽标（每轮结束后）

**座位**：`conversation.chat.assistant-actions`（list entry，见 §11 修订 3）。

**数据**：该轮所有 `AssistantMessageNode.usage` 求和 - 提供商上报真数（`inputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`outputTokens`/`reasoningTokens`，三桶计费输入 = 三者之和），按 `turn` 字段归属，durable log 支撑，刷新/历史轮均在。

**形态**：

> `本轮 输入 12.4K（3 次调用 · 缓存 11.8K）· 输出 2.1K` - 弱化小字，不抢视觉；仅在收尾消息且轮已结束（`turnEnds` 含该轮）时渲染。

**口径说明**：徽标 = 该轮**所有调用的计费输入总和**（多步轮每步重发全量上下文，累计远大于单次请求）；预告 = **单次请求**的 prompt 大小。两者不矛盾，缓存命中字段可解释差额。

## 4. 数据口径总表

| 数据 | 来源 | 性质 |
|---|---|---|
| 上下文基座 | `useProjection('contextPressure')` -> `projectedTokens` + `contextWindow` | 提供商锚定估算，Host 已算好下发 |
| 队列消息 | `InputState.queue`，客户端估算 | 复刻官方估算器口径 |
| 草稿 | `InputState.draft`（owner props 响应式） | 同上 |
| 轮消耗 / 输出区间 | `AssistantMessageNode.usage` 按 `turn` 分组 | 提供商真数，durable |
| 空会话回退 | `useProjection('contextBreakdown')` | 纯启发式，标注展示 |

## 5. 边界与非目标

- 纯 tokens，**不做货币/价格/credits 兑换**；
- 不做整轮多步总账预测（步数假设不可靠）；
- 不拦截 `llm/stream`、不注册新投影/fold、不建后台任务；
- 不修改官方 stats line（并存同带）。

## 6. 资源开销评估（已与用户确认接受）

| 项 | 时机 | 量级 |
|---|---|---|
| 预告读数 | 打字期，框架级重渲染 | DOM 读 + 字符估算 + 一行重渲染，微秒级 |
| 投影订阅 | 投影更新 | 零额外 Host 计算，仅多一订阅者 |
| 轮尾徽标 | 每轮落账一次 | O(该轮消息数) 求和 + 一行 DOM |
| 空闲期 | - | 近似零（无轮询/无定时器/无后台任务） |

## 7. 交付计划

1. **第一阶段（动态原型）**：已完成并验收（tokpv-1/pkg-1、pkg-2）。
2. **第二阶段（静态定稿）**：本包（`dsh-plugins` profile bundle）。

## 8. 实现者保留细节（不再上行确认）

输出区间分位数算法细节、格式化样式、隐藏/过渡动效、轮尾徽标具体排版。

## 9. 关键技术事实备忘

- `conversation.composer.dock`：list slot，owner props 为 `InputZone = { session, input }`（含 `input.draft`/`input.queue`，输入态变化即重渲染），另有框架标准 props（`useSession`/`useProjection`/`sessionId`）；
- `conversation.chat.turnTail`：chain **选举**制（第一个 select 非 null 者独占），不可用于叠加式徽标；
- `AssistantMessageNode.usage` 类型标 `unknown`，运行时形状为 `TokenUsage`（trajectory 按 `inputTokens` 等五字段读取）；
- 估算器（dsh-token-meter `estimate.ts`）：CHARS_PER_TOKEN=4、BLOCK_OVERHEAD=4、ROLE_OVERHEAD=4，即文本消息 `ceil(len/4)+8`；系统性低估 CJK（`projectedTokens` 的锚定机制即为修正此误差而生）；
- Inspect 工具 `listService`/`listEvents` 带参数查询在本环境被 input guard 误拒（报 "input must be an object"），细查契约需读包源码或用无参目录查询。

## 10. 验收标准

- [x] 预告读数随打字实时更新，发送后该轮真实输入与预告同数量级（锚定误差内）；
- [x] 每轮（含历史轮）轮尾显示真实消耗徽标，刷新页面仍在；
- [x] 空会话、无历史输出两种降级路径均不报错、不空白错乱；
- [x] 会话运行中预告隐藏，空闲恢复；
- [ ] 静态包接入后重启 DSH 仍生效。

---

## 11. 实现定稿备注（第一阶段落地后追加）

实现阶段核验契约后，三处优于本 SPEC 原设计的修正：

1. **草稿无需 DOM 读取**（取代原 DOM 方案）：`conversation.composer.dock`
   的 owner props `InputZone` 本身携带 `input.draft` 全文与 `input.queue`，
   且输入态变化即重渲染--Q5 的脆弱点不存在了。
2. **无需 Host 半**（取代原"极小 Host RPC"）：估算器是
   `ceil(len/4)+8` 纯函数，客户端直接复刻，零 RPC。
3. **轮尾徽标座位改为 `conversation.chat.assistant-actions`**（取代 turnTail）：
   turnTail 是 chain 选举制，与 ui-deliverables 的"产物"条互斥，不可用。
   改挂 assistant-actions（list 型真叠加，位于每条 assistant 消息 IconActions 行内、
   常驻可见），仅在"收尾消息 + 轮已结束"（`turnEnds` 含该轮）时渲染，实现每轮一枚。
   输出区间数据源随之升级为 durable 的按轮 `usage` 分组。

交付形态：动态原型已验证（tokpv-1/pkg-2）；静态包为 `dsh-plugins` 扩展集
（`dsh.bundle` profile bundle，含 `cordis.patch.yml` 行插入与 `dsh.client` 声明），
安装方式见 README.md。
