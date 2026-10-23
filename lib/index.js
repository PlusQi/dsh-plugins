/**
 * dsh-plugins node half. 按 config.plugin 分发（tokprev 等纯 UI 插件的 host
 * 半边为空，行只作存在/禁用锚点）；tokstats 是本包首个混合插件：host 侧注册
 * 一个 per-session 投影单元，持久化与冷启动全部交给官方 session-projection
 * 管线，浏览器半边见 lib/client.js。
 *
 * 模块图约束：本包经 pnpm link 安装，真实路径不在宿主 node_modules 树内，
 * npm 包 import 不可解析——host 半边只用 node: 内建 + apply(ctx, config)
 * 参数，不引运行时依赖（AGENTS 硬规则 5）。
 */
import { randomUUID } from "node:crypto";

/** host 侧分发框架：每个 patch 行一个 host fiber，config.plugin 是分发键。 */
function apply(ctx, config) {
	const plugin = String(config?.plugin ?? "");
	if (plugin === "tokstats") startTokstats(ctx, config);
	if (plugin === "promptopt") startPromptopt(ctx, config);
	// 其余插件 host 半边为空，静默跳过。
}

// ── plugin: tokstats（host：投影单元 + 汇总 RPC） ────────────────────────────
//
// 架构（SPEC-v0.6.0 §方案 1，决策 Q7 = X1）：
// - **单元**：每会话一个投影单元，key 'dsh-plugins.tokstats'、stateVersion 3。宿主
//   session-projection 注册表在每个已提交事件上主动驱动 apply，持久化与冷启动
//   由官方 session-projection-cache 负责——本插件不再写任何自有文件（I2）。
// - **带 wire**：单元必须带 wire 块才能被 cachedSnapshot/viewCheckpoint 读回
//   （host-only 单元在公开读取面上被跳过），而 wire.view 只返回紧凑摘要
//   { w, e, rows }，不返回跨会话 cells；路由以单个不透明串 `rt` 随 cell 带出，
//   浏览器侧不解释它的内部结构（I1′）。
// - **汇总**：面板打开时经 RPC 一次性拉取。每个会话先 cachedSnapshot（零 I/O），
//   取不到再 readSession + coldSnapshot 冷折叠兜底；按路由的排行在汇总侧产出（Q1）。
//
// 阶段 0 契约结论（详见 docs/specs/active/TASKS-v0.6.0.md 附记）：
// - p0-c：init 只收 (header, inheritedEventCount)，拿不到 headersById，故根工作区
//   解析搬到这里（summarize 持有全部 meta）；init 保持纯函数。
// - p0-d：服务名 sessionProjectionCache，cachedSnapshot(meta, keys) 只比 header
//   生命周期四字段，返回 undefined 即需冷折叠。
// - p0-e（硬门）：sessionQuery 在 openAt: never 下照常注册（服务在构造函数里建），
//   listSessions/readSession 从不触碰 _db——汇总数据源用它，不走 persistence 私有面。
// - p0-f：connection.rpc.handle 只有两参，authority 选项已不存在，不要传第三参。

/**
 * 投影单元 key：带包前缀，避免与宿主日后可能注册的同名单元撞车（SPEC Q5）。
 *
 * 改名与 RPC 通道名 `/dsh-plugins.tokstats` 是两件独立的事（Q6）：通道名是浏览器
 * 侧契约，key 只进缓存的字段名（C1/C4 确认点号合法且不进文件路径）。
 */
const TOKSTATS_KEY = "dsh-plugins.tokstats";
/**
 * 单元版本：由 2 提升（cell 加路由维 + epoch 改结构）、再由 3、4、5 提升（桶边界
 * 三轮改为市面计费档）→ 旧缓存行按 stateVersion 不匹配自然作废，不写迁移（I3/R2）。
 *
 * 桶边界与版本号必须同批变更（TS-18）：cell 只存桶序号 `b`，边界一变同一个 `b`
 * 就指向另一个区间，不抬版本会静默错位而不是报错。
 */
const TOKSTATS_STATE_VERSION = 6;
/** 面板 RPC 通道（连接层只接受 /[A-Za-z0-9._~-]+，见 p0-f）。 */
const TOKSTATS_CHANNEL = "/dsh-plugins.tokstats";
const TOKSTATS_ENDPOINT = "summary";
/** promptopt 计数器读数（跨插件观测面，AC-13）。 */
const TOKSTATS_PROMPTOPT_ENDPOINT = "promptopt";
/** 默认折叠窗口（天）：来自行 config.windowDays，缺省 90（SPEC §方案 1）。 */
const TOKSTATS_DEFAULT_WINDOW_DAYS = 90;

/**
 * 上下文桶边界（计费输入 = in + cr + cw 落桶）；桶数 = 边界数 + 1。
 *
 * **口径是市面「按输入长度分档计费」的真实边界，不是 2 的幂**（TS-18）：
 * 阿里云百炼 / 火山方舟 / 智谱 GLM 三家中国区主力厂商的档位在 32K / 128K / 256K
 * 三点上重叠；4K / 8K / 16K 没有任何厂商设档，旧边界里 `[4K,8K)` 在本机真实调用
 * 中是**完全空桶**。
 *
 * 低端保留 8K 这一刀（而非直接 `[0,32K)`）：8K 以下的短问答 / 单轮工具调用与
 * 8K–32K 的多轮会话 / RAG 单文档是两类负载，留着才能看出会话膨胀。
 *
 * 256K–1M 之间再切 512K：`[256K,1M)` 原本一桶吃掉本机 20.8% 调用 / 47.6% token，
 * 桶内跨了 4 倍跨度，看不出「接近窗口上限」的请求。512K 是 MiniMax M3 的计费分界
 * （≤512K / >512K 两档），切完两半分别 13.5% / 6.4% 调用，都有量。
 *
 * **最高桶不设 1M 上界、不设 `[1M,∞)` 尾巴**：1M 已经是市面上所有模型上下文窗口
 * 的最大值（本机 profile 里 `contextWindow` 最大就是 1048576，`contextBudgets`
 * 最大 1000000），单个请求的 prompt 结构上不可能超过它，那条尾巴永远不会亮。本机
 * 4039 次真实调用实测：最大计费输入 710.9K，≥1M 的 0 次、≥800K 的 0 次、≥700K
 * 的只有 29 次。所以最高桶是 `[512K,∞)`——它同时是「≥512K」的兜底桶与「异常超长」
 * 的哨兵，不需要再多一行恒空的格子。
 *
 * **改这个数组必须同批抬 `TOKSTATS_STATE_VERSION`**——cell 只存桶序号 `b`，
 * 边界一变同一个 `b` 就指向另一个区间，不抬版本是静默错位而不是报错。
 */
const TOKSTATS_BUCKET_BOUNDS = [8192, 32768, 131072, 262144, 524288];
const TOKSTATS_BUCKET_COUNT = TOKSTATS_BUCKET_BOUNDS.length + 1;

/** 本地时区自然日键（host 进程时区，SPEC Q5-A 裁决口径）。 */
function tokstatsDayKey(ts) {
	const d = new Date(ts);
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return d.getFullYear() + "-" + m + "-" + day;
}

/** 计费输入 → 桶序号（0..5 = [0,8K)…[512K,∞)）。 */
function tokstatsBucketOf(billedInput) {
	let b = 0;
	while (b < TOKSTATS_BUCKET_BOUNDS.length && billedInput >= TOKSTATS_BUCKET_BOUNDS[b]) b += 1;
	return b;
}

function tokstatsNum(v) {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** 全零合计（桶、窗口、epoch 共用同一形状）。 */
function tokstatsZeroTotals() {
	return { calls: 0, in: 0, cr: 0, cw: 0, out: 0 };
}

/**
 * 空状态。
 *
 * - `w`：本会话自身 cwd（根工作区在汇总侧按 meta 链解析，见 p0-c）。
 * - `seed`：fork 继承前缀长度。apply 只收 (state, event)，拿不到
 *   inheritedEventCount，故 init 时记进 state，供 foldUsage 跳过父会话已计过的
 *   样本（I4）。
 * - `epoch`：E1 折叠区间 + 自带合计，仅在读取期生效（见 tokstatsEpochFold）。
 */
function tokstatsInit(header, inheritedEventCount) {
	const cwd = header === null || header === undefined ? undefined : header.cwd;
	return {
		w: typeof cwd === "string" && cwd.length > 0 ? cwd : "_orphan",
		seed: typeof inheritedEventCount === "number" && inheritedEventCount > 0 ? inheritedEventCount : 0,
		epoch: null,
		rows: [],
	};
}

/**
 * 路由标识：`provider + "/" + model`，取不到时为空串（「未标注」的唯一表示）。
 *
 * 唯一来源是 `assistant/message` 的 `message.source`（p8-a 实测 2562/2562 齐备，
 * `data.source` 形态 0 条）。空串而不是 null：null 在 JSON 往返与 Map 键里都要
 * 额外分支，而空串天然是可排序字符串（SPEC §3.1）。
 *
 * @param source - `message.source`（可为 undefined / null / 非对象）。
 */
function tokstatsRouteOf(source) {
	if (source === null || source === undefined || typeof source !== "object") return "";
	const provider = source.provider;
	const model = source.model;
	if (typeof provider !== "string" || typeof model !== "string") return "";
	return provider + "/" + model;
}

/** 单元格键：天 × 桶 × 路由（工作区不进 key——单会话根工作区是常量，见 SPEC §方案 1）。 */
function tokstatsCellKey(day, bucket, route) {
	return day + "\x1f" + bucket + "\x1f" + route;
}

/** 取一格（不新建）；折叠期按 key 查找用。 */
function tokstatsFindCell(rows, day, bucket, route) {
	const key = tokstatsCellKey(day, bucket, route);
	for (const cell of rows) {
		if (tokstatsCellKey(cell.d, cell.b, cell.rt) === key) return cell;
	}
	return undefined;
}

/**
 * 一条样本累加进 rows，返回**新**状态（纯函数，不改入参）。
 *
 * `sign < 0` 是差值法的减项：同 (turn, step) 的终值替换靠「先减旧再加新」，
 * 因为旧采样可能落在另一天、另一桶**或另一条路由**（同 step 内先 usage chunk
 * 后 message 就会发生：chunk 没有路由、message 带真路由），减旧加新自动把两边
 * 都修对（I5 / AC-3）。
 */
function tokstatsApplySample(state, sample, sign) {
	const billed = sample.in + sample.cr + sample.cw;
	const b = tokstatsBucketOf(billed);
	const d = tokstatsDayKey(sample.time);
	const rt = typeof sample.rt === "string" ? sample.rt : "";
	const prev = tokstatsFindCell(state.rows, d, b, rt);
	if (prev === undefined && sign < 0) return state;
	const cell = prev === undefined
		? { d, b, rt, calls: 0, in: 0, cr: 0, cw: 0, out: 0 }
		: { d, b, rt, calls: prev.calls, in: prev.in, cr: prev.cr, cw: prev.cw, out: prev.out };
	cell.calls += sign;
	cell.in += sign * sample.in;
	cell.cr += sign * sample.cr;
	cell.cw += sign * sample.cw;
	cell.out += sign * sample.out;
	const rows = [];
	for (const existing of state.rows) {
		if (existing.d === d && existing.b === b && (typeof existing.rt === "string" ? existing.rt : "") === rt) continue;
		rows.push(existing);
	}
	// calls 归零的格整条剔除：差值法减回去的空格若留在数组里，「明细条数」会随
	// 采样次数虚增（AC-5 断言折叠前后条数一致）。剔除按 (d,b,rt) 定位——另一条
	// 路由上的同一 (d,b) 格不受影响。
	if (cell.calls > 0) rows.push(cell);
	return { w: state.w, seed: state.seed ?? 0, epoch: state.epoch ?? null, last: state.last, rows };
}

/**
 * 单事件折叠（纯函数，I6）。
 *
 * - `seq < seed` 的样本直接跳过（fork 前缀父会话已计过，I4）；
 * - 只有 `assistant/chunk{type:'usage'}` 与 `assistant/message{usage}` 出样本；
 * - 同 (turn, step) 的后一样本替换前一样本（I5）；
 * - **其余任何事件返回同一个引用**，下游零工作。
 *
 * 路由维度：`assistant/message` 分支从 `message.source` 取路由标识（`rt`），
 * `assistant/chunk` 分支的样本没有路由，`rt` 恒为空串。
 *
 * 路由只认 `message.source` 一个位置，刻意不读请求侧的事件（请求侧是配置快照，
 * 与 usage 的结算语义不同源；混用会让「路由」与「用量」来自两条独立路径）。代价
 * 是极少数只有 usage chunk、没有 message 终值的 step 归「未标注」（实测 0.18%），
 * 它们仍计入调用次数，是排行里差额的唯一出口（I9 / AC-2）。
 *
 * @param state - 既有状态；本函数不原地改它。
 * @param event - 一个已提交会话事件。
 * @param windowDays - E1 折叠窗口（天）。
 */
function tokstatsFoldUsage(state, event, windowDays) {
	if (typeof event.seq === "number" && event.seq < (state.seed ?? 0)) return state;
	const data = event.data;
	if (data === null || typeof data !== "object") return state;
	let usage;
	let rt;
	if (event.type === "assistant/chunk") {
		const chunk = data.chunk;
		if (chunk === null || typeof chunk !== "object" || chunk.type !== "usage") return state;
		usage = chunk.usage;
		// usage chunk 本身不带路由字段（p8-c 实测 708/708 皆无）：这里的样本恒为
		// 「未标注」，同 step 的 message 终值若存在会整条替换掉它。
		rt = "";
	} else if (event.type === "assistant/message") {
		usage = data.usage;
		// 只认 `data.message.source`（p8-a：2562/2562 都在这个位置，`data.source`
		// 形态 0 条，故不做兼容分支）。
		const message = data.message;
		const source = message === null || message === undefined || typeof message !== "object" ? undefined : message.source;
		rt = tokstatsRouteOf(source);
	} else {
		return state;
	}
	if (usage === null || typeof usage !== "object") return state;
	if (typeof data.turn !== "number" || typeof data.step !== "number") return state;
	const sample = {
		turn: data.turn,
		step: data.step,
		time: event.time,
		rt,
		in: tokstatsNum(usage.inputTokens),
		cr: tokstatsNum(usage.cacheReadTokens),
		cw: tokstatsNum(usage.cacheWriteTokens),
		out: tokstatsNum(usage.outputTokens),
	};
	// 全零样本：**照常计为一次调用**，四桶为 0，落在最低桶 [0,8K)。
	//
	// 实测依据（28 份真实日志全量统计）：纯真实 step 1868 个、纯零 step 5 个、
	// 「真实样本 + 零样本」混合 step **0 个**——零样本永远独立成 step，不存在
	// 「真实终值被后续零样本抹掉」的情形。
	//
	// 所以不需要为它们写特例：终值替换在同 (turn,step) 内生效，而零 step 内部
	// 的多个零样本相互替换后仍是零。丢弃它们反而会让这 5 次真实发生过的调用
	// 从 `calls` 里消失（模型确实被调用了，只是没产出 token），既丢失计数，也
	// 与旧实现 575 次的基准对不上（其中最低桶的 5 次正是这些）。
	let next = state;
	const last = state.last;
	if (last !== undefined && last !== null && last.turn === sample.turn && last.step === sample.step) {
		next = tokstatsApplySample(next, last, -1);
	}
	next = tokstatsApplySample(next, sample, 1);
	// 采样事件必然推进状态（last 要记下来），故这里无条件返回新引用；I6 的
	// 「无关事件同引用」由上面的早返回承担。
	const folded = { w: next.w, seed: next.seed ?? 0, epoch: next.epoch ?? null, rows: next.rows, last: sample };
	return tokstatsEpochFold(folded, tokstatsDayKey(sample.time), windowDays);
}

/** 窗口下界日键：`today` 往前 `windowDays - 1` 天；非正数表示不设限。 */
function tokstatsWindowStart(windowDays, today) {
	if (!Number.isFinite(windowDays) || windowDays <= 0) return null;
	const d = new Date(today + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() - (windowDays - 1));
	return d.toISOString().slice(0, 10);
}

/**
 * E1 折叠（I7：**不删原始明细**）。
 *
 * 窗口随时间推进时，落在窗口外的明细被**另记**进 epoch 的按桶合计，rows 本身
 * 原封不动。读取期按 `[epoch.start, epoch.end)` 排除这些明细，改计 epoch 合计，
 * 因此「折叠前后明细条数不变、汇总数字不变」两条同时成立。
 *
 * epoch 必须保留**桶 × 路由**两维粒度（`routes: [{ rt, buckets: [6] }]`）：
 * - 只留桶会让桶分布的形状变扁——AC-5 要求折叠前后各桶数字逐项一致；
 * - 不留路由维度会让折叠掉的历史无法归因，排行随窗口推进悄悄少行（Q10 / R4）。
 *
 * 兼容旧形状：读到没有 `routes` 但有 `buckets` 的 epoch 时，视为单一路由 `""`
 * 的一组桶（SPEC §3.4）。虽然 stateVersion 提升后旧缓存行本就会被丢弃，但
 * `tokstatsSummaryOf` 对 `e` 只校验 start/end，防御成本极低。
 *
 * 折叠是幂等且只向前的：`today` 未把窗口推过既有 `epoch.end` 时返回同一引用。
 *
 * @param state - 折叠前状态（不原地改）。
 * @param today - 宿主本地自然日键。
 * @param windowDays - 窗口天数。
 */
function tokstatsEpochFold(state, today, windowDays) {
	const windowStart = tokstatsWindowStart(windowDays, today);
	if (windowStart === null) return state;
	const epoch = state.epoch;
	const hasEpoch = epoch !== null && epoch !== undefined && typeof epoch === "object" && typeof epoch.end === "string";
	if (hasEpoch && epoch.end >= windowStart) return state;
	// 新进入 epoch 的区间：[旧 end, 新 windowStart)；首次折叠从最早明细起算。
	const from = hasEpoch ? epoch.end : null;
	// rt -> 全零桶；Map 保持首次出现次序，输出稳定可断言。
	const routes = new Map();
	const routeBucketsOf = (route) => {
		const rt = typeof route === "string" ? route : "";
		let buckets = routes.get(rt);
		if (buckets === undefined) {
			buckets = tokstatsZeroBuckets();
			routes.set(rt, buckets);
		}
		return buckets;
	};
	let start = hasEpoch && typeof epoch.start === "string" ? epoch.start : null;
	let folded = false;
	if (hasEpoch) {
		// 既有 epoch 的合计原样搬过来（新结构走 routes，旧结构由 tokstatsEpochGroups
		// 归一为单一路由 ""）。
		for (const group of tokstatsEpochGroups(epoch)) {
			const buckets = routeBucketsOf(group.rt);
			for (let i = 0; i < buckets.length; i += 1) {
				const prev = group.buckets[i];
				if (prev === null || prev === undefined || typeof prev !== "object") continue;
				buckets[i] = {
					calls: tokstatsNum(prev.calls),
					in: tokstatsNum(prev.in),
					cr: tokstatsNum(prev.cr),
					cw: tokstatsNum(prev.cw),
					out: tokstatsNum(prev.out),
				};
				folded = true;
			}
		}
	}
	for (const cell of state.rows) {
		if (cell.d >= windowStart) continue;
		if (from !== null && cell.d >= from) continue;
		if (!Number.isInteger(cell.b) || cell.b < 0 || cell.b >= TOKSTATS_BUCKET_COUNT) continue;
		const buckets = routeBucketsOf(cell.rt);
		const bucket = buckets[cell.b];
		bucket.calls += tokstatsNum(cell.calls);
		bucket.in += tokstatsNum(cell.in);
		bucket.cr += tokstatsNum(cell.cr);
		bucket.cw += tokstatsNum(cell.cw);
		bucket.out += tokstatsNum(cell.out);
		if (start === null || cell.d < start) start = cell.d;
		folded = true;
	}
	if (!folded || start === null) return state;
	const out = [];
	for (const [rt, buckets] of routes) out.push({ rt, buckets });
	return { ...state, epoch: { start, end: windowStart, routes: out } };
}

/** 全零桶数组（epoch 合计与读取期桶分布同形状）。 */
function tokstatsZeroBuckets() {
	const buckets = [];
	for (let i = 0; i < TOKSTATS_BUCKET_COUNT; i += 1) buckets.push(tokstatsZeroTotals());
	return buckets;
}

/**
 * epoch 的「路由 × 桶」分组视图（折叠写入与读取期共用，避免两处各写一份形状判断）。
 *
 * 新结构读 `routes: [{ rt, buckets }]`；旧结构（无 `routes` 但有 `buckets`）视为
 * 单一路由 `""` 的一组桶（SPEC §3.4 的防御性兼容）。`rt` 非字符串归一为空串。
 */
function tokstatsEpochGroups(epoch) {
	if (epoch === null || epoch === undefined || typeof epoch !== "object") return [];
	const groups = [];
	if (Array.isArray(epoch.routes)) {
		for (const group of epoch.routes) {
			if (group === null || group === undefined || typeof group !== "object") continue;
			if (!Array.isArray(group.buckets)) continue;
			groups.push({ rt: typeof group.rt === "string" ? group.rt : "", buckets: group.buckets });
		}
		return groups;
	}
	if (Array.isArray(epoch.buckets)) return [{ rt: "", buckets: epoch.buckets }];
	return [];
}

/** 日键减一天（UTC 解析，不随宿主时区漂移）。 */
function tokstatsDayBefore(day) {
	const d = new Date(day + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString().slice(0, 10);
}

/**
 * 从缓存/冷折叠的 wire 值取出可汇总的摘要。
 *
 * 只认 `w` / `e` / `rows` 三个键——这是 I1 的边界，也是 wire.view 的输出形状。
 *
 * `rt` 非字符串时归一为空串而**不丢 cell**（I10）：丢格会让 `calls` 凭空减少，
 * 比归到「未标注」更糟。归一后的 cell 是新对象，不改入参。
 */
function tokstatsSummaryOf(value) {
	if (value === null || typeof value !== "object") return undefined;
	if (!Array.isArray(value.rows)) return undefined;
	const rows = [];
	for (const cell of value.rows) {
		if (cell === null || typeof cell !== "object") continue;
		if (typeof cell.d !== "string") continue;
		if (!Number.isInteger(cell.b)) continue;
		rows.push(typeof cell.rt === "string" ? cell : { ...cell, rt: "" });
	}
	const e = value.e;
	return {
		w: typeof value.w === "string" ? value.w : "_orphan",
		e: e !== null && typeof e === "object" && typeof e.start === "string" && typeof e.end === "string" ? e : null,
		rows,
	};
}

/** 自然周起点（周一）的日键，供周粒度趋势分组。 */
function tokstatsWeekStartOf(day) {
	const d = new Date(day + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
	return d.toISOString().slice(0, 10);
}

/** 根工作区：沿 parentSession 链上溯到根会话的 cwd；链断归 _orphan。 */
function tokstatsRootWorkspaceOf(header, headersById) {
	let h = header;
	let depth = 0;
	while (h !== undefined && h !== null && h.parentSession !== undefined) {
		if (depth >= 64) return "_orphan";
		const parent = headersById.get(h.parentSession);
		if (parent === undefined) return "_orphan";
		h = parent;
		depth += 1;
	}
	if (h === undefined || h === null || h.cwd === undefined || h.cwd === "") return "_orphan";
	return h.cwd;
}

/**
 * 聚合：各会话摘要 → 面板要的五块（桶分布 / 每日序列 / 周趋势 / 路由排行 / 工作区分组），
 * 外加两项**可审计性载荷**：`coverage`（本次统计覆盖了多少会话）与 `epoch`（是否把折叠
 * 历史并入了某个代表日）。后两项只出现在返回值里、**不进投影状态**，故不抬 `stateVersion`
 * （TS-03 / TS-21 / TS-22）。
 *
 * 读取期排除 epoch 区间内的明细并改计 epoch 的按桶合计，避免与 E1 折叠双计；
 * 因为 epoch 保留「桶 × 路由」粒度，折叠前后各桶数字逐项一致（AC-5），且路由
 * 排行不随窗口推进少行（AC-5 的读取侧 / R4）。
 *
 * 每日序列是**唯一时间维度真源**：周趋势由它按自然周归并得出，不再单独跑一趟
 * 明细（两趟遍历曾让「周合计与日合计对不上」这类漂移无从对账）。
 *
 * @param entries - `{ rootWorkspace, summary }[]`；summary 为 undefined 表示该会话读取失败。
 * @param options - `{ windowDays, workspace, today }`。
 */
function tokstatsAggregate(entries, options) {
	const windowStart = tokstatsWindowStart(options.windowDays, options.today);
	const buckets = tokstatsZeroBuckets();
	const days = new Map();
	const workspaces = new Map();
	// rt -> 合计。与 `workspaces` 同一手法（闭包内的 Map + 累加），不发明第二个 helper。
	const routes = new Map();
	const totals = tokstatsZeroTotals();

	/**
	 * 一格计入所有维度（桶 / 日 / 路由 / 工作区 / 总计）。
	 *
	 * `buckets` / `workspaces` / `routes` 都由闭包带，`target` 是本会话的工作区合计。
	 * `route` 缺省为空串（未标注）——空串是唯一表示，不引入第二个「没有路由」的值。
	 */
	const addCell = (target, bucket, day, calls, inTokens, outTokens, cr, cw, route) => {
		target.calls += calls;
		target.in += inTokens;
		target.cr += cr;
		target.cw += cw;
		target.out += outTokens;
		bucket.calls += calls;
		bucket.in += inTokens;
		bucket.cr += cr;
		bucket.cw += cw;
		bucket.out += outTokens;
		totals.calls += calls;
		totals.in += inTokens;
		totals.cr += cr;
		totals.cw += cw;
		totals.out += outTokens;
		let dayTotals = days.get(day);
		if (dayTotals === undefined) {
			dayTotals = tokstatsZeroTotals();
			days.set(day, dayTotals);
		}
		dayTotals.calls += calls;
		dayTotals.in += inTokens;
		dayTotals.cr += cr;
		dayTotals.cw += cw;
		dayTotals.out += outTokens;
		// 同 rt 必须**累加**，不能 set() 覆盖：v0.7.0 在 workspaces 上踩过这个
		// 真实缺陷（同一根工作区的多会话互相覆盖），routes 是同形状数据的同一个坑。
		const rt = typeof route === "string" ? route : "";
		let routeTotals = routes.get(rt);
		if (routeTotals === undefined) {
			routeTotals = tokstatsZeroTotals();
			routes.set(rt, routeTotals);
		}
		routeTotals.calls += calls;
		routeTotals.in += inTokens;
		routeTotals.cr += cr;
		routeTotals.cw += cw;
		routeTotals.out += outTokens;
	};

	// ── 覆盖率（TS-21）：本次请求统计了多少会话、其中多少被跳过 ──────────────
	//
	// 只在 RPC 返回值里，**不进投影状态**：覆盖率是「本次请求」的瞬时事实，写进
	// durable 状态会制造 stale 语义（下次打开面板读到的是上次的分母）。依据 TS-03，
	// 不进投影状态就不需要抬 `stateVersion`、不需要清缓存。
	//
	// 口径与下面的聚合共用**同一套 workspace 过滤**：若在「切到单个工作区」的视图里
	// 把别的工作区的会话也算进分母，页脚就会写「已统计 50 个会话」而数字只来自 2 个
	// ——分母与分子不同源，正是这次变更要消除的那类谎报。
	//
	// 恒等约束（由测试钉住）：`sessions - skipped` = 实际贡献了数字的会话数。
	let coverageSessions = 0;
	let coverageSkipped = 0;
	// ── 折叠历史代表日（TS-22）──────────────────────────────────────────────
	//
	// 只有**真的**经由 epoch 路径计入过一个非零格时，`epoch` 才非 null。仅仅「读到
	// 了 epoch」不算：epoch 的代表日可能落在窗口外（切换档位就常见），那种情况下
	// 日柱里根本没有对应列，client 若照着打标就会凭空造一个标记。
	//
	// 多个会话各有不同 epoch 时取**最早**的代表日（PLAN §3.3）：区间端点互不重叠，
	// 打标只针对单一代表日，取最小 `end` 保证那一定是真实的合成日。
	let epochEnd = null;
	let epochCalls = 0;

	for (const entry of entries) {
		if (options.workspace !== undefined && entry.rootWorkspace !== options.workspace) continue;
		coverageSessions += 1;
		const summary = entry.summary;
		if (summary === undefined) {
			coverageSkipped += 1;
			continue;
		}
		const epoch = summary.e;
		const hasEpoch = epoch !== null && epoch !== undefined && typeof epoch === "object" && typeof epoch.end === "string";
		const wsTotals = tokstatsZeroTotals();
		let counted = false;

		for (const cell of summary.rows) {
			// E1：epoch 区间内的明细由 epoch 合计代表，这里跳过（不双计）。
			if (hasEpoch && cell.d >= epoch.start && cell.d < epoch.end) continue;
			if (windowStart !== null && cell.d < windowStart) continue;
			const calls = tokstatsNum(cell.calls);
			if (calls <= 0) continue;
			if (!Number.isInteger(cell.b) || cell.b < 0 || cell.b >= buckets.length) continue;
			addCell(wsTotals, buckets[cell.b], cell.d, calls, tokstatsNum(cell.in), tokstatsNum(cell.out), tokstatsNum(cell.cr), tokstatsNum(cell.cw), cell.rt);
			counted = true;
		}
		// epoch 自带「桶 × 路由」合计：用区间末的前一天当日期代表（趋势按周分组
		// 需要一天）。日期代表只影响桶分布/趋势的落点，路由排行不受它影响（R4）。
		if (hasEpoch) {
			const epochDay = tokstatsDayBefore(epoch.end);
			if (windowStart === null || epochDay >= windowStart) {
				// 本会话这个 epoch 实际计入的调用数：全零时不能算「有折叠历史被计入」，
				// 否则日柱里那列可能压根不存在（例如它整列零调用被跳过）。
				let fromThisEpoch = 0;
				for (const group of tokstatsEpochGroups(epoch)) {
					for (let i = 0; i < group.buckets.length && i < buckets.length; i += 1) {
						const src = group.buckets[i];
						if (src === null || src === undefined || typeof src !== "object") continue;
						const calls = tokstatsNum(src.calls);
						if (calls <= 0) continue;
						addCell(wsTotals, buckets[i], epochDay, calls, tokstatsNum(src.in), tokstatsNum(src.out), tokstatsNum(src.cr), tokstatsNum(src.cw), group.rt);
						counted = true;
						fromThisEpoch += calls;
					}
				}
				if (fromThisEpoch > 0) {
					epochCalls += fromThisEpoch;
					if (epochEnd === null || epoch.end < epochEnd) epochEnd = epoch.end;
				}
			}
		}
		// 同一根工作区可能有多个会话（fork / 多个对话）：必须**累加**进同一个
		// 合计，否则后一个会话会整段覆盖前一个。v0.6.0 起这里是 set() 覆盖，
		// 表现是「工作区排行各行的次数远小于总计」——v0.7.0 的排行条形图把
		// 这个差额暴露出来才发现。
		if (counted) {
			const merged = workspaces.get(entry.rootWorkspace);
			if (merged === undefined) workspaces.set(entry.rootWorkspace, wsTotals);
			else {
				merged.calls += wsTotals.calls;
				merged.in += wsTotals.in;
				merged.cr += wsTotals.cr;
				merged.cw += wsTotals.cw;
				merged.out += wsTotals.out;
			}
		}
	}

	const daily = [...days.entries()]
		.map(([day, dayTotals]) => ({ day, ...dayTotals }))
		.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

	return {
		buckets,
		daily,
		weekly: tokstatsWeeklyOf(daily),
		// 路由排行（与 workspaces 同形状）：calls 降序，空串「未标注」显式排最后。
		//
		// 为什么要那个显式的 0/1 排序键：空串在字典序里**最前**，直接按 rt 排会把
		// 「未标注」顶到同次数行的最前面，与「兜底项放最后」的界面直觉相反（Q8）。
		// 其余同 calls 时按 rt 字典序，保证输出完全确定、可稳定断言（AC-10）。
		routes: [...routes.entries()]
			.map(([rt, routeTotals]) => ({
				rt,
				calls: routeTotals.calls,
				in: routeTotals.in,
				out: routeTotals.out,
				cr: routeTotals.cr,
				cw: routeTotals.cw,
			}))
			.sort((a, b) => {
				const aUnattributed = a.rt === "" ? 1 : 0;
				const bUnattributed = b.rt === "" ? 1 : 0;
				if (aUnattributed !== bUnattributed) return aUnattributed - bUnattributed;
				if (b.calls !== a.calls) return b.calls - a.calls;
				return a.rt < b.rt ? -1 : a.rt > b.rt ? 1 : 0;
			}),
		workspaces: [...workspaces.entries()]
			.map(([path, wsTotals]) => ({
				path,
				calls: wsTotals.calls,
				in: wsTotals.in,
				out: wsTotals.out,
				cr: wsTotals.cr,
				cw: wsTotals.cw,
			}))
			.sort((a, b) => b.calls - a.calls),
		totals,
		windowStart,
		coverage: { sessions: coverageSessions, skipped: coverageSkipped },
		// TS-22：无折叠历史被计入时**必须是 null**（不是 {}、不是 undefined）——
		// client 用 `!== null` 判定，形状模棱两可会让它走进「有折叠」分支去读 end。
		epoch: epochEnd === null ? null : { end: epochEnd, calls: epochCalls },
	};
}

/**
 * 周粒度趋势：由**每日序列**按自然周（周一）归并。
 *
 * 为什么不再单独遍历明细：两趟各自过滤 epoch 与窗口，一旦哪一趟漏一个条件，
 * 「周合计 ≠ 日合计」这种漂移只能靠人工对账发现。单趟真源让面板上所有时间
 * 维度天然自洽（周合计之和恒等于总计）。
 *
 * @param daily - `tokstatsAggregate` 已排好序的每日序列。
 */
function tokstatsWeeklyOf(daily) {
	const weeks = new Map();
	for (const day of daily) {
		const weekStart = tokstatsWeekStartOf(day.day);
		let week = weeks.get(weekStart);
		if (week === undefined) {
			week = { weekStart, calls: 0, in: 0, cr: 0, cw: 0, out: 0 };
			weeks.set(weekStart, week);
		}
		week.calls += day.calls;
		week.in += day.in;
		week.cr += day.cr;
		week.cw += day.cw;
		week.out += day.out;
	}
	return [...weeks.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0));
}

/**
 * 投影单元定义（PLAN §3.2）。
 *
 * `wire.view` 只返回 `{ w, e, rows }`：浏览器侧拿不到 provider/model，也拿不到
 * 跨会话聚合——聚合只出现在 RPC 返回值里（I1）。
 */
function tokstatsDefinition(windowDays) {
	return {
		key: TOKSTATS_KEY,
		stateVersion: TOKSTATS_STATE_VERSION,
		// 手写 duck-type：不引 zod（硬规则 5），与既有实现一致。
		stateSchema: { parse: (v) => v },
		init: (header, inheritedEventCount) => tokstatsInit(header, inheritedEventCount),
		apply: (state, event) => tokstatsFoldUsage(state, event, windowDays),
		wire: {
			viewSchema: { parse: (v) => v },
			view: (state) => ({
				w: typeof state.w === "string" ? state.w : "_orphan",
				e: state.epoch === null || state.epoch === undefined ? null : state.epoch,
				rows: Array.isArray(state.rows) ? state.rows : [],
			}),
		},
	};
}

/**
 * 错误信封（wire 闭集）：客户端 `parseConnectionResponse` 要求 code / message /
 * details 三者齐备且 details 为对象，缺一个就在浏览器侧抛 TypeError。
 */
function tokstatsFail(code) {
	return { ok: false, error: { code, message: code, details: {} } };
}

// ── RPC 通道挂载（自建，因为官方的 connection.rpc.handle 在本版本不可用） ──────
//
// 为什么不用 `ctx.connection.rpc.handle(channel, handler)`（实测结论，SPEC p0-f 修正）：
// 它的实现是 `get rpc() { const owner = this.ctx; ... }`，而 `register()` 里
// `owner.effect(() => owner.webServer.register(route))` 会访问 owner.webServer。
// 这个 owner 是**连接插件自己的 ctx**（inject 只有 `credentials`，没有 webServer），
// 因此从任何第三方 context 调用都必然抛
// `cannot get property "webServer" without inject`。断言依据：整个 0.2.1-rc.2 官方
// 包里 `rpc.handle(` 的调用点是 **0** 个——它不是一条在用的公开扩展面。
//
// 这里复刻它内部真正需要的两件事，其余保持不变：
//   ① 信任与鉴权走**同一个** `connection.admit(req)`（官方 /api 路由也用它），
//      因此安全面与官方通道完全一致；
//   ② 应答沿用同一信封 `{ type:"server-response", rpcId, result }`，所以浏览器侧
//      `ctx.connection.rpc.call(channel, endpoint, payload, signal)` 的契约不变。

/** 读取并解析请求体（上限内），失败返回 undefined。 */
async function readJsonBody(req, limitBytes = 1 << 20) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > limitBytes) throw new Error("request body too large");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.length === 0) return undefined;
	return JSON.parse(text);
}

/** 写一个 RPC 应答信封。 */
function writeEnvelope(res, rpcId, result) {
	const body = JSON.stringify({ type: "server-response", rpcId, result });
	res.writeHead(200, { "content-type": "application/json" });
	res.end(body);
}

/**
 * 把一条 RPC 通道挂到 `webServer` 上。
 *
 * @param pctx - 已注入 `webServer` 与 `connection` 的 context。
 * @param channel - 通道前缀（`/dsh-plugins.<plugin>`）。
 * @param dispatch - `(endpoint, payload, signal) => Promise<result>`。
 * @param log - 降级告警出口。
 */
function tokstatsRegisterRpcChannel(pctx, channel, dispatch, log) {
	const prefix = channel + "/";
	const route = {
		kind: "prefix",
		path: channel,
		handler: async (req, res) => {
			// ① 与官方 /api 完全相同的信任/鉴权闸门。
			let admission;
			try {
				admission = pctx.connection.admit(req);
			} catch (error) {
				log(`dsh-plugins: ${channel} admit 失败: ${String(error)}`);
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			if (admission !== null && typeof admission === "object" && "rejection" in admission) {
				res.writeHead(admission.rejection);
				res.end(admission.rejection === 401 ? "unauthorized" : "forbidden");
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end("method not allowed");
				return;
			}
			const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
			if (!pathname.startsWith(prefix)) {
				res.writeHead(404);
				res.end("not found");
				return;
			}
			const endpoint = pathname.slice(prefix.length);
			if (endpoint.length === 0 || endpoint.includes("/")) {
				res.writeHead(404);
				res.end("not found");
				return;
			}
			if ((req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
				res.writeHead(415);
				res.end("content type must be application/json");
				return;
			}
			// ② 浏览器 abort fetch 时 req 会中断，据此中止 in-flight 调用。
			const controller = new AbortController();
			req.on("aborted", () => controller.abort());
			res.on("close", () => {
				if (res.writableEnded !== true) controller.abort();
			});
			let envelope;
			try {
				envelope = await readJsonBody(req);
			} catch (error) {
				log(`dsh-plugins: ${channel} 请求体解析失败: ${String(error)}`);
				res.writeHead(400);
				res.end("body is not JSON");
				return;
			}
			const rpcId = envelope !== null && typeof envelope === "object" && typeof envelope.rpcId === "string"
				? envelope.rpcId
				: "invalid-request";
			if (envelope === undefined || envelope.type !== "client-request") {
				writeEnvelope(res, rpcId, { ok: false, error: { code: "bad-request", message: "invalid client-request envelope", details: {} } });
				return;
			}
			let result;
			try {
				result = await dispatch(endpoint, envelope.payload, controller.signal);
			} catch (error) {
				// 与官方一致：handler 抛错不让整个响应变成 500，交给调用方看信封。
				log(`dsh-plugins: ${channel}/${endpoint} 处理失败: ${String(error)}`);
				result = { ok: false, error: { code: "internal", message: "internal", details: {} } };
			}
			// 即使请求已被中断也把信封写出去：浏览器侧那时已经断开、读不到它，但
			// 「不写」会让中止路径的返回值无从观察；写失败（socket 已关）忽略即可。
			if (res.writableEnded !== true) {
				try {
					writeEnvelope(res, rpcId, result);
				} catch {
					/* 连接已断开：应答无人接收，不是错误 */
				}
			}
		},
	};
	return pctx.effect(() => pctx.webServer.register(route), `dsh-plugins: ${channel} rpc channel`);
}

/** 把诊断写到 stderr（`ctx.logger.warn` 在桌面/本机不一定落盘，见 TS-19 的实测）。 */
function tokstatsStderr(message) {
	try {
		process.stderr.write(`[dsh-plugins] ${message}\n`);
	} catch {
		/* stderr 不可写时静默 */
	}
}

/**
 * 零 I/O 读缓存摘要（p0-d：meta 只需 header 的生命周期四字段）。
 *
 * 返回 `{ summary, asOfSeq }`：`asOfSeq` 是缓存行水位（官方 `viewRecord` 取所有
 * 被服务行的最低 `seq`），调用方用它做检查点滞后判定（TS-19）。缺失时按「未知」
 * 处理（不是 0——0 会让所有缓存都被判为滞后，退化成每次全量冷读）。
 */
function tokstatsReadCached(cache, header) {
	if (cache === undefined || cache === null || typeof cache.cachedSnapshot !== "function") return undefined;
	const snapshot = cache.cachedSnapshot(header, [TOKSTATS_KEY]);
	if (snapshot === undefined || snapshot === null) return undefined;
	const value = snapshot.values === undefined ? undefined : snapshot.values[TOKSTATS_KEY];
	const summary = tokstatsSummaryOf(value);
	if (summary === undefined) return undefined;
	const asOfSeq = typeof snapshot.asOfSeq === "number" && Number.isFinite(snapshot.asOfSeq) ? snapshot.asOfSeq : undefined;
	return { summary, asOfSeq };
}

/**
 * 活会话零回放读：直接取宿主投影注册表里**已被急切驱动**的本单元。
 *
 * 为什么这条路径存在（TS-24）：宿主的 `SessionProjectionRegistry` 在
 * `session/event` 上急切驱动每个已注册单元（`drive()`），所以活会话的正确
 * 折叠值**本来就在内存里**。当前实现却对活会话调 `readSession` 全量回放——
 * 实测单会话 604 ms，而折叠本身只有 1–5 ms，这一跳纯属重复劳动。
 *
 * 两级取法（都不回放日志）：
 * - `cachedSnapshot(session, keys)`：只读已 materialize 的 cell，零折叠；
 * - `snapshot(session, keys)`：cell 缺失时由注册表就地增量推进到当前游标
 *   （`advanceCell` 只跑未折过的事件，不是全量 replay）。
 *
 * 返回 `{ summary, asOfSeq }`；拿不到（服务缺席 / 单元未注册 / 形状不符）返回
 * undefined，由调用方退回冷读（硬规则 6 的优雅降级）。
 *
 * @param projections - `ctx.sessionProjections`（可能缺席）。
 * @param session - `ctx.sessions.get(id)` 拿到的活会话对象（可能缺席）。
 */
function tokstatsReadLive(projections, session) {
	if (projections === undefined || projections === null || session === undefined || session === null) return undefined;
	const keys = [TOKSTATS_KEY];
	const pick = (block) => {
		if (block === undefined || block === null) return undefined;
		const value = block.values === undefined ? undefined : block.values[TOKSTATS_KEY];
		const summary = tokstatsSummaryOf(value);
		if (summary === undefined) return undefined;
		const asOfSeq = typeof block.asOfSeq === "number" && Number.isFinite(block.asOfSeq) ? block.asOfSeq : undefined;
		return { summary, asOfSeq };
	};
	// 先零折叠读；cell 还没 materialize 时再让注册表就地推进（仍不是全量 replay）。
	for (const method of ["cachedSnapshot", "snapshot"]) {
		const fn = projections[method];
		if (typeof fn !== "function") continue;
		try {
			const hit = pick(fn.call(projections, session, keys));
			if (hit !== undefined) return hit;
		} catch {
			/* 单个服务形态不符时继续试下一级；全都不行则由调用方冷读 */
		}
	}
	return undefined;
}

/**
 * 冷折叠兜底：`readSession` 的全量日志 → `coldSnapshot`（P7/P9）。
 *
 * `readSession` 返回 `{ session, inheritedEventCount, events }`，**不带 seedLength**
 * ——fork 切点就是 `inheritedEventCount`（P9）。
 *
 * 返回的 `asOfSeq` 是**本次读到的 events 的最大 seq**，不是 `cut.asOfSeq`。
 *
 * 为什么不用 `cut.asOfSeq`（TS-19 的实测教训）：官方 `restore` 把 `snapshot.asOfSeq`
 * 定义为 `events.at(-1)?.seq`，但它**先用旧检查点做续算起点**（`row.seq`），遇到
 * v0 格式会话的打包行时返回的水位会停在旧检查点位置（实测 1126），而日志实际已到
 * 148654。拿它做基线会让滞后判定永远不成立（`1126 < 1126` 为 false），冷读算出的
 * 正确结果被下一轮的旧缓存覆盖回去。events 的最大 seq 才是「亲眼见过的日志末尾」。
 */
async function tokstatsColdRead(cache, sessionQuery, header, log) {
	if (cache === undefined || cache === null || typeof cache.coldSnapshot !== "function") return undefined;
	if (typeof sessionQuery.readSession !== "function") return undefined;
	let snapshot;
	try {
		snapshot = await sessionQuery.readSession(header.id);
	} catch (error) {
		log(`tokstats: 会话 ${header.id} 日志读取失败，跳过: ${String(error)}`);
		return undefined;
	}
	if (snapshot === undefined || snapshot === null) return undefined;
	const events = Array.isArray(snapshot.events) ? snapshot.events : [];
	const inherited = typeof snapshot.inheritedEventCount === "number" ? snapshot.inheritedEventCount : 0;
	const cut = cache.coldSnapshot(header, inherited, events);
	if (cut === undefined || cut === null) return undefined;
	const value = cut.values === undefined ? undefined : cut.values[TOKSTATS_KEY];
	const summary = tokstatsSummaryOf(value);
	if (summary === undefined) return undefined;
	// 基线取 events 的最大 seq（亲眼见过的日志末尾），见函数头注释的实测教训。
	let maxSeq = -1;
	for (const event of events) {
		const seq = event === null || typeof event !== "object" ? undefined : event.seq;
		if (typeof seq === "number" && Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
	}
	// 兜底：events 里没有 seq（极端异常）时退回官方水位，至少不比旧检查点更差。
	const asOfSeq = maxSeq >= 0 ? maxSeq : (typeof cut.asOfSeq === "number" && Number.isFinite(cut.asOfSeq) ? cut.asOfSeq : -1);
	return { summary, asOfSeq };
}

/**
 * 汇总读取器：`(payload) => Promise<aggregate>`。
 *
 * 逐会话两级读取阶梯（SPEC §方案 1）：先 `cachedSnapshot`（零 I/O），取不到才
 * `readSession` + `coldSnapshot` 冷折叠（首次必然走这条）。
 *
 * `cacheOf` 是惰性取值器而不是服务实例：缓存服务可能在端点注册之后才就绪，且它
 * 缺席时端点必须照常工作（返回空聚合，I8）。
 *
 * **检查点滞后补偿（TS-19）**：官方检查点可能停在远早于日志末尾的水位，而
 * `listSessions()` 只返回 `{ header, live, persisted, formatStatus }`——**没有**
 * 日志长度信号，无法廉价判断缓存是否新鲜。本函数用一份**进程内记忆**
 * `observedSeq`（sessionId → 上次冷读观察到的日志末序号）补上这个信号：
 *
 * - 冷读时把**日志真实末序号**记进记忆；
 * - 之后每次读缓存，若 `snapshot.asOfSeq < 记忆里的值`，说明检查点没追平**我们
 *   亲眼见过**的日志末尾 → 冷读覆盖。
 *
 * **注意基线不能取 `cut.asOfSeq`**：实测 v0 格式会话的 `coldSnapshot` 会返回
 * 旧检查点的水位（如 1126）而不是日志末尾（148654）——取它做基线会让判定永远
 * 不触发（`1126 < 1126` 为 false），冷读算出的正确结果被下一轮的旧缓存覆盖。
 * 基线必须取**本次读到的 events 的最大 seq**，那才是「我们亲眼见过的日志末尾」。
 *
 * 用进程内记忆而不是写进投影 state，理由是 state 只在 usage 事件上被 `apply`
 * 推进（非 usage 事件必须返回同一引用，I6），没有位置承载「与样本无关的水位」；
 * 而硬塞进 state 还得抬 `stateVersion` 让旧行作废。记忆的代价是**首次汇总看不到
 * 历史滞后**（进程启动后每个会话要冷读一次才建立基线），换来的是零迁移成本与
 * 零额外 I/O——首次冷读本来就会发生。
 *
 * @param sessionQuery - `ctx.sessionQuery`（listSessions / readSession）。
 * @param cacheOf - `() => ctx.sessionProjectionCache | undefined`。
 * @param defaultWindowDays - 行 config.windowDays（缺省 90）。
 * @param log - 降级告警出口。
 * @param verifyStale - 是否做 TS-19 的检查点滞后校验（缺省 true）。
 *   关闭后行为退回「只按 live 判定」：缓存命中的已结束会话一律采信，面板秒开，
 *   但实测会少报 4.6% 的调用（本机 50 会话里 11 个检查点滞后）。
 */
function tokstatsSummaryReader(sessionQuery, cacheOf, defaultWindowDays, log, verifyStale = true, services = {}) {
	/** sessionId → 本进程见过的最大日志末序号（TS-19）。 */
	const observedSeq = new Map();
	/** 活会话零回放读取面（TS-24）：投影注册表 + 活会话表，两者都可能缺席。 */
	const projectionsOf = services.projectionsOf ?? (() => undefined);
	const liveSessionOf = services.liveSessionOf ?? (() => undefined);
	/**
	 * 持久化水位读取面（TS-26）：`ctx.sessionPersistence` 的 `stat`。
	 *
	 * 它给出**日志 revision**（纯 stat 元数据，不解码日志）。宿主 `sessionQuery` 的
	 * `listSessions` 内部调的就是同一份 listing，但它把 revision 扔了——这里直接
	 * 取公开服务，拿到那半张被扔掉的表。
	 */
	const persistenceOf = services.persistenceOf ?? (() => undefined);
	/** 冷读凭据存取器（TS-26）：跨进程记住「这行缓存是我们冷读出来的」。 */
	const credentials = services.credentials;

	// ── 后台校验队列（TS-24）──────────────────────────────────────────────
	//
	// 首次汇总不再同步等待全量冷读：需要校验的会话排进这里，由**一个** drain
	// 在后台逐个冷读、写回缓存、刷新基线。三条不变量：
	//
	// - **单飞**：`draining` 保证全进程只有一个 drain 在跑；
	// - **去重**：`queued` 保证同一会话只排一次——否则每次请求都排一遍，冷读
	//   次数会随请求数放大（客户端还会因 `verifying` 反复重拉）；
	// - **收敛**：drain 跑完队列即把基线追平，下一轮请求 `verifying: false`，
	//   客户端据此停止重拉。
	const queued = new Set();
	const queue = [];
	let draining = false;
	/**
	 * 每个会话已经尝试过几次后台校验（`sessionId → count`）。
	 *
	 * 必须有预算上限，理由有两面：
	 * - **不能无限重试**：冷读失败的会话（日志读不出）永远建立不了基线，若只看
	 *   基线就会每轮重排——队列永不空、`verifying` 永远 true，客户端无限重拉。
	 * - **也不能只试一次**：TS-19 的滞后是**可再次出现**的（官方检查点回退、
	 *   缓存行被旧水位覆盖），只试一次就再也修不好。实测「水位从 2 退回 0」正是
	 *   这种形态，必须允许再校验一轮。
	 *
	 * 取 2：正常路径一轮就够（冷读会写回正确水位），第二轮的用途只有「修一次
	 * 回退」；再多就只是在同一个失败上反复付代价。
	 */
	const attempts = new Map();
	const MAX_VERIFY_ATTEMPTS = 2;
	/**
	 * 后台刚折出、还没被下一帧读到的摘要（sessionId → `{ summary, asOfSeq }`）。
	 *
	 * 为什么需要它：后台 drain 与下一帧请求之间存在一个 tick 的间隙——drain 写完
	 * 缓存、下一帧读缓存，中间若客户端正好在那一刻重拉，就会读到「verifying 已
	 * 消失但数字还是旧的」。把结果先放进这份内存表，下一帧直接取用，语义就变成
	 * 「校验完成即可见」，而不是「缓存落盘后才可见」。
	 *
	 * 条目在下一帧被读到后即删除（一次性消费）：缓存已经写回，后续走零 I/O。
	 */
	const fresh = new Map();
	/** `pending` 只对外暴露「还有没有活要干」，供本帧算 `verifying`。 */
	const pending = { has: () => queue.length > 0 || draining };

	/** 本帧的 headersById（供后台 drain 在帧外解析 header）。 */
	const headersByIdRef = new Map();
	/** 缓存服务的当前实例（后台 drain 在帧外也要用它冷读）。 */
	let cacheRef;
	/**
	 * 本进程内**已核对过凭据**的会话 → 核对时刻（TS-26）。
	 *
	 * 为什么必须有这个集合：凭据核对要读一次日志 `revision`（`stat`，单会话实测
	 * 4.5 ms）。本机 74 个会话若**每帧**都核对一遍，就是 330 ms 起步的请求开销
	 * ——实测把热路径 p50 从 50 ms 抬到 1337 ms（后台 drain 争 CPU 时更糟），
	 * 把省下来的冷读时间全赔回去还倒贴。
	 *
	 * 于是：核对结果带**时间戳**，TTL 内直接采信、零 I/O；过期才重新核对。
	 * TTL 取 `REVALIDATE_TTL_MS`：这是「日志在别处被追加后，最多多久发现」的上界。
	 * 已落盘会话在本进程里没有写句柄，正常不会变；要变只可能是**别的进程**
	 * （desktop 与 web 同时开着）在写。2 s 的发现延迟对这种场景足够，
	 * 且远小于用户「隔一会儿再看一眼」的节奏。
	 */
	const validatedAt = new Map();
	/**
	 * 凭据核对结果的有效期（毫秒）：过期后重新读一次 `revision`。
	 *
	 * 为什么需要有效期而不是「每进程核一次就够」：已落盘会话在本进程里没有写句柄，
	 * 但**别的进程**（desktop 与 web 同时开着）可能在写同一个日志。有效期是
	 * 「日志在别处被追加后，最多多久发现」的上界。
	 *
	 * 取 2000：远小于用户「隔一会儿再看一眼」的节奏，又足以让同一屏的多次
	 * 重拉（1.5 s / 3 s 退避，TS-25）复用同一次核对结果、不再每帧付 `stat` 成本。
	 * 测试可经 `config.revalidateTtlMs` 覆盖（0 = 每帧都核）。
	 */
	const REVALIDATE_TTL_MS = Number.isFinite(services.revalidateTtlMs) && services.revalidateTtlMs >= 0
		? services.revalidateTtlMs
		: 2000;
	/** 本帧的日志 revision 快照（sessionId → revision 串），供后台 drain 记账用。 */
	const revisionsByIdRef = new Map();

	/**
	 * 读某个会话当前的日志 revision（TS-26）。
	 *
	 * 读不到（服务缺席 / 会话不存在 / 后端失败）时返回 undefined——调用方据此走
	 * 「无凭据 ⇒ 排冷读」的保守路径，**绝不**因为读不到水位就采信缓存（那会少报）。
	 *
	 * 用 `stat`（单会话）而不是 `list`（全表）：本机 74 个会话，`list` 单次要
	 * 58–803 ms（每个会话各 stat 一次 + 各解一次 header 帧），而 `stat` 单会话只要
	 * 4.5 ms（实测 73 次累计 332 ms）。两者都**不解码日志**。
	 *
	 * ⚠️ **不得给这里加缓存**：缓存会把「日志变了」遮住——凭据闸门拿旧 revision
	 * 去比，等于永远认为日志没变 → 永远不重读 → **会少报**。水位必须现取。
	 *
	 * @param sessionId - 会话 id。
	 * @returns revision 串（不透明，原样比较）或 undefined。
	 */
	const revisionOf = async (sessionId) => {
		const persistence = typeof persistenceOf === "function" ? persistenceOf() : undefined;
		if (persistence === undefined || persistence === null || typeof persistence.stat !== "function") return undefined;
		try {
			const snapshot = await persistence.stat(sessionId);
			if (snapshot === undefined || snapshot === null) return undefined;
			const revision = snapshot.revision;
			return typeof revision === "string" && revision.length > 0 ? revision : undefined;
		} catch (error) {
			// 读水位失败不是错误：退化成「没有凭据」= 排冷读 = 旧行为。
			log(`tokstats: 会话 ${sessionId} 读持久化水位失败，按未记账处理: ${String(error)}`);
			return undefined;
		}
	};

	/**
	 * 把一个会话排进后台校验队列。
	 *
	 * 已在队列里（或正在被 drain 处理）时不重复排——见上面「去重」。
	 * 这个函数**不 await**：它只负责登记，调用方拿到本帧即可返回。
	 */
	const scheduleVerify = (sessionId) => {
		if (!verifyStale) return;
		// 预算上限只约束**真正冷读**的次数（读不出日志的会话不能反复读）。
		// 但「核对凭据」是便宜操作且**必须允许反复做**——TTL 过期后要重新确认
		// 日志有没有变，这是正确性要求，不能被执行预算挡住。
		const credentialKnown = credentials !== undefined && credentials.get(sessionId) !== undefined;
		if (!credentialKnown && (attempts.get(sessionId) ?? 0) >= MAX_VERIFY_ATTEMPTS) return;
		if (queued.has(sessionId)) return;
		queued.add(sessionId);
		queue.push(sessionId);
		if (draining) return;
		draining = true;
		void (async () => {
			try {
				while (queue.length > 0) {
					const id = queue.shift();
					try {
						const header = headersByIdRef.get(id);
						if (header !== undefined) {
							// ── 先核对凭据（TS-26）────────────────────────────────────
							//
							// 这一步是本轮省 CPU 的核心：拿当前日志 revision 与我们冷读
							// 时记下的比。**相同** ⇒ 日志字节没变 ⇒ 那次冷读的结果今天
							// 仍成立 ⇒ **根本不冷读**，只把会话标记为「已核对」。
							//
							// 代价是每个会话一次 `stat`（实测 4.5 ms / 会话，73 个
							// 会话 ≈ 330 ms），换掉的是每个会话一次冷读（本机合计
							// 14 s / 20.6 CPU-s）。
							//
							// 核对只在**后台**做、且每进程只做一次：请求路径零 I/O
							//（见 readSummary 里的说明）。
							const credential = credentials === undefined ? undefined : credentials.get(id);
							// 冷读/核对前的 revision 快照（若本帧已采过就复用）。
							const revisionBefore = revisionsByIdRef.get(id) ?? await revisionOf(id);
							// 核对通过的条件：**日志没变**（冷读时记的 revision 与现在的
							// 相同）且缓存行存在。
							if (credential !== undefined && revisionBefore !== undefined
								&& credential.rev === revisionBefore) {
								// 日志没变 ⇒ 缓存里就是我们冷读出来的真值 ⇒ 不冷读。
								const cached = tokstatsReadCached(cacheRef, header);
								if (cached !== undefined) {
									validatedAt.set(id, Date.now());
									observedSeq.set(id, credential.seq);
									// 放进 `fresh` 表：下一帧立刻可见。
									fresh.set(id, cached);
								} else {
									// 缓存行没了（被清 / 被宿主丢弃）→ 只能重读。
									const reRead = await tokstatsColdRead(cacheRef, sessionQuery, header, log);
									if (reRead !== undefined) {
										observedSeq.set(id, reRead.asOfSeq);
										fresh.set(id, reRead);
										validatedAt.set(id, Date.now());
										if (revisionBefore !== undefined && credentials !== undefined) {
											credentials.put(id, { rev: revisionBefore, seq: reRead.asOfSeq });
										}
									}
								}
							} else {
								// 无凭据或日志变了 → 走原路径：冷读并重新记账。
								const read = await tokstatsColdRead(cacheRef, sessionQuery, header, log);
								if (read !== undefined && typeof read.asOfSeq === "number" && Number.isFinite(read.asOfSeq)) {
									// 冷读成功即刷新基线：下一轮该会话走零 I/O、不再排队。
									observedSeq.set(id, read.asOfSeq);
								}
								if (read !== undefined) {
									// 校验结果先落内存表：下一帧立刻可见，不必等缓存写回落盘。
									fresh.set(id, read);
									// 记账（TS-26）：本次冷读看到的日志版本 + 亲眼见到的日志
									// 末尾序号一起存下来。下次汇总若当前 revision 与此相同
									// ⇒ 日志字节未变 ⇒ 这行缓存仍是真值 ⇒ **不再冷读**。
									//
									// 只记**按会话**的 revision：v0 格式的 revision 掺了全局
									// 历史语料哈希，证明不了本会话没变（见 tokstatsRevisionIsPerSession）。
									if (revisionBefore !== undefined && credentials !== undefined
										&& tokstatsRevisionIsPerSession(revisionBefore)) {
										credentials.put(id, { rev: revisionBefore, seq: read.asOfSeq });
									}
									validatedAt.set(id, Date.now());
								}
							}
						}
					} catch (error) {
						const detail = `tokstats: 会话 ${id} 后台校验失败，跳过: ${String(error)}`;
						log(detail);
						tokstatsStderr(detail);
					} finally {
						queued.delete(id);
						// 计一次尝试（成功或失败都算）：预算上限挡住无限重试，
						// 见 attempts 的说明。
						attempts.set(id, (attempts.get(id) ?? 0) + 1);
					}
					// ── 让出事件循环（TS-27）─────────────────────────────────────
					//
					// 宿主 `readSession` 的包装层（深拷贝 + 冻结 + 逐事件校验）是**同步**
					// 的，宿主自己的 500 ms yield 切不开它。在**会话之间**让一次，能把
					// 「单次 drain 连续占用 CPU 数秒」拆成一串小段——单会话最长 951 ms
					// （实测），让出后宿主有机会处理别的请求。
					//
					// 注意：这**不减少**总 CPU，只改善阻塞形态；减少 CPU 靠的是凭据闸门
					// 那条「不重复冷读」。
					//
					// ⚠️ 让出后必须让 `while` 重新检查队列：让出期间会有新的一帧请求
					// 进来排新活，而那帧看到 `draining === true` 就不会另起一个 drain
					// ——若让出后就收工（`break`），新排的活就没人做了，`verifying`
					// 永远不消失。`while (queue.length > 0)` 的条件正好覆盖这一点。
					await tokstatsYield();
				}
			} finally {
				draining = false;
			}
		})();
	};

	return async function readSummary(payload) {
		// 基线的建立是**逐会话惰性**的：只有从未冷读过的会话才需要付一次冷读
		// （`observedSeq` 里没有它的条目）。已经建立基线的会话照常走零 I/O，
		// 因此「缓存命中零 I/O」这条契约对**已见过**的会话完全不变（AC-7 覆盖
		// 的场景正是这一类）。
		//
		// 首轮之所以要建立基线：`observedSeq` 为空时无从判断缓存是否滞后，而
		// 滞后是真实存在的（实测 50 会话里 11 个）。建立基线只付一次全量冷读，
		// 之后靠 `asOfSeq < 基线` 判定，不再周期性全量冷读。
		const request = payload !== null && typeof payload === "object" ? payload : {};
		// 0 是**显式的「全部」档位**（客户端「全部」按钮就发 0），不是缺省；只有
		// 非数字或负数才回落行配置。tokstatsWindowStart 把 <= 0 视作不设窗口。
		const requestedDays = typeof request.windowDays === "number" && Number.isFinite(request.windowDays) && request.windowDays >= 0
			? request.windowDays
			: undefined;
		const workspace = typeof request.workspace === "string" && request.workspace.length > 0 ? request.workspace : undefined;

		const records = await sessionQuery.listSessions();
		const list = Array.isArray(records) ? records : [];
		const headersById = new Map();
		for (const record of list) {
			const header = record === null || record === undefined ? undefined : record.header;
			if (header !== undefined && typeof header.id === "string") headersById.set(header.id, header);
		}
		// 后台 drain 在帧外也要能解析 header，故把本帧的快照交给它。
		headersByIdRef.clear();
		for (const [id, header] of headersById) headersByIdRef.set(id, header);

		// ── 日志 revision（TS-26）──────────────────────────────────────────────
		//
		// **请求路径上不读 revision**。为什么：核对一条凭据要一次 `stat`（单会话
		// 4.5 ms），本机 74 个会话每帧核对一遍就是 330 ms 起步——实测把热路径
		// p50 从 50 ms 抬到 1337 ms，把冷读省下来的时间全赔回去还倒贴。
		//
		// 改为：核对在**后台 drain** 里做（见 `verifySession`），每个会话**每进程
		// 只核对一次**，结果记进 `validated`。请求路径只看 `validated` 这个内存
		// 集合，零 I/O。
		//
		// 首帧仍然是「先用手头缓存、报 verifying、后台核对」，与 TS-24 的秒开契约
		// 完全一致——只是后台要做的事从「冷读」（14 s）变成了「核对 revision」
		// （330 ms），而且核对通过就**根本不冷读**。

		const cache = typeof cacheOf === "function" ? cacheOf() : cacheOf;
		// 后台 drain 在帧外也要冷读，故把本帧的缓存实例留给它（每帧刷新：服务可能
		// 在端点注册之后才就绪，缓存实例也可能是新的）。
		cacheRef = cache;
		const entries = [];
		/** 本帧是否新排过校验任务（见 verifying 的说明）。 */
		let scheduledThisFrame = false;
		for (const record of list) {
			const header = record === null || record === undefined ? undefined : record.header;
			if (header === undefined || typeof header.id !== "string") continue;
			const rootWorkspace = tokstatsRootWorkspaceOf(header, headersById);
			// 首帧只做**零等待**的事（TS-24）：
			//
			// 1. 活会话 → 读宿主投影注册表里已急切驱动的单元（`tokstatsReadLive`）。
			//    这一跳不回放日志，实测单会话 604 ms → 微秒级。此前这里对活会话
			//    调 `readSession` 全量回放，是「每次点开都慢」的主要来源。
			// 2. 已结束会话 → 零 I/O 读官方检查点；有基线且水位未追平才需要校验。
			//
			// 3. **需要校验的会话不再在这一轮里等**，而是排进后台队列，本帧先用
			//    手头的缓存值（没有就给 undefined）。返回值带 `verifying: true`，
			//    客户端据此在后台校验完成后自动重拉一次。
			//
			// 为什么必须校验（TS-19）：已结束会话的官方检查点可能远早于日志末尾。
			// 实测本机 50 会话里 11 个滞后，最严重的缓存 seq=793 而日志末序号
			// 162925；全量对账是面板少报 172 次调用 / 3129 万计费输入。
			//
			// `verifyStale === false` 时整块跳过，退回旧行为（采信检查点）。
			const hasBaseline = !verifyStale || observedSeq.has(header.id) || (attempts.get(header.id) ?? 0) > 0;
			let read;
			let needsVerify = false;
			try {
				if (record.live === true) {
					// 活会话：注册表里已急切驱动的值就是当前真值；注册表缺席时
					// 退回后台冷读的结果（一次性消费，TS-24 原语义）。
					const pendingFresh = fresh.get(header.id);
					if (pendingFresh !== undefined) {
						fresh.delete(header.id);
						read = pendingFresh;
					} else {
						read = tokstatsReadLive(projectionsOf(), liveSessionOf(header.id));
						// 活会话的注册表值就是当前真值，不需要进校验队列；拿不到才冷读。
						if (read === undefined) needsVerify = true;
					}
				} else {
					// ── 三级读取阶梯（TS-24 + TS-26 / TS-27）──────────────────────
					//
					// ① **刚冷读出来的结果**（`fresh` 表）——最新且必然正确，本帧用它，
					//    **不再排冷读**。
					// ② **凭据已核对的缓存**（`validated`）——后台已确认「我们冷读过这个
					//    会话且日志没变」⇒ 那次冷读的结果今天仍成立 ⇒ 采信缓存，不再冷读。
					// ③ **其余情况**——排后台核对（有凭据）或排冷读（无凭据，TS-19 原路径）。
					//
					// 优先级不能反：① 是「我们手里就有真值」，② 是「真值还在缓存里」，
					// ③ 才是「得再算一遍 / 再核一遍」。
					const cached = tokstatsReadCached(cache, header);
					const pendingFresh = fresh.get(header.id);

					if (pendingFresh !== undefined) {
						// ① 刚冷读出来的结果：直接用。
						read = pendingFresh;
						// **不立刻丢掉它**：官方 `coldSnapshot` 的写回是 fail-soft
						// fire-and-forget，下一帧读缓存时那一行**可能还没落盘**（或
						// 落盘失败）。若此时把 `fresh` 一次性消费掉，下一帧读到的缓存
						// 就是「未命中」→ 判成需要校验 → 把刚冷读过的会话**再排一遍**
						// → 白白再付一次全量冷读（本机一次 14 s / 20.6 CPU-s）。
						//
						// 所以删除条件是「缓存行已追平我们冷读到的那一水位」：追平了
						// 才说明写回落盘了，此刻起读缓存就够用。
						if (cached !== undefined && cached.asOfSeq !== undefined
							&& pendingFresh.asOfSeq !== undefined && cached.asOfSeq >= pendingFresh.asOfSeq) {
							fresh.delete(header.id);
						}
					} else if (validatedAt.has(header.id) && Date.now() - validatedAt.get(header.id) < REVALIDATE_TTL_MS) {
						// ② 后台已核对通过：缓存里就是我们冷读出来的那版真值。
						//
						// **仍然每次都做零 I/O 的水位自检**（TS-19 不因凭据而豁免）：
						// 缓存行可能被回退成更旧的一次（官方检查点回退、被别的进程
						// 覆盖），那时 `cached.asOfSeq` 会低于我们亲眼见过的水位。
						// 这条检查不读盘，成本可忽略，却是「不会少报」的最后一道闸。
						const credential = credentials === undefined ? undefined : credentials.get(header.id);
						const seen = observedSeq.get(header.id);
						const baseline = credential !== undefined ? credential.seq : seen;
						if (cached !== undefined && cached.asOfSeq !== undefined
							&& (baseline === undefined || cached.asOfSeq >= baseline)) {
							read = cached;
							if (credential !== undefined) observedSeq.set(header.id, credential.seq);
						} else {
							// 缓存行没追平（被回退 / 被清）→ 重新校验。
							log(`tokstats: 会话 ${header.id} 缓存行未追平已见水位（${String(cached?.asOfSeq)} < ${String(baseline)}），重新校验`);
							read = cached;
							needsVerify = true;
						}
					} else {
						// ③ 还没核对过 → 有凭据就排后台核对，没凭据就排冷读。
						read = cached;
						const credential = credentials === undefined ? undefined : credentials.get(header.id);
						const seen = observedSeq.get(header.id);
						if (read !== undefined && seen !== undefined && read.asOfSeq !== undefined && read.asOfSeq < seen) {
							log(`tokstats: 会话 ${header.id} 检查点滞后（asOfSeq ${read.asOfSeq} < 已见日志末序号 ${seen}），改为校验`);
							needsVerify = true;
						} else if (read === undefined) {
							needsVerify = true;
						} else if (!hasBaseline) {
							needsVerify = true;
						} else if (credential !== undefined) {
							// 有凭据但本进程还没核对过 → 排核对（不直接冷读）。
							needsVerify = true;
						}
					}
				}
			} catch (error) {
				const detail = `tokstats: 会话 ${header.id} 摘要读取失败，跳过: ${String(error)}`;
				log(detail);
				tokstatsStderr(detail);
				read = undefined;
				needsVerify = true;
			}
			if (needsVerify) {
				// 预算上限只约束**真正冷读**的次数（读不出日志的会话不能反复读）。
				// 但「核对凭据」是便宜操作且**必须允许反复做**——TTL 过期后要重新
				// 确认日志有没有变，这是正确性要求，不能被执行预算挡住。
				const credentialKnown = credentials !== undefined && credentials.get(header.id) !== undefined;
				const withinBudget = credentialKnown || (attempts.get(header.id) ?? 0) < MAX_VERIFY_ATTEMPTS;
				if (withinBudget && !queued.has(header.id)) scheduledThisFrame = true;
				if (withinBudget) scheduleVerify(header.id);
			}
			entries.push({ rootWorkspace, summary: read === undefined ? undefined : read.summary });
		}

		// 有会话在后台校验时告诉客户端「先看这帧、稍后自动校正」。
		// 注意本帧刚排进去的任务也要算上：drain 是异步启动的，`queue.length` 此刻
		// 可能已为 0（首帧就一个会话时必然如此），只看队列会把首帧误报成已收敛。
		const verifying = pending.has() || scheduledThisFrame;

		// 冷读会把摘要写回缓存，后续请求即走零 I/O 分支；本次请求用刚折出的值。
		const windowDays = requestedDays ?? defaultWindowDays;
		const aggregate = tokstatsAggregate(entries, {
			windowDays,
			workspace,
			today: tokstatsDayKey(Date.now()),
		});
		return {
			...aggregate,
			generatedAt: Date.now(),
			windowDays,
			// 后台还有校验在跑 → 客户端先看这帧、稍后自动重拉（TS-24）。
			// 不进投影状态，故不抬 stateVersion、不清缓存（TS-03 的反例）。
			...(verifying ? { verifying: true } : {}),
			...(workspace === undefined ? {} : { workspace }),
		};
	};
}

/**
 * tokstats 宿主半边组装。
 *
 * 三段独立软依赖（任一缺席都不抛错，面板显示空态——I8/AC-8）：
 * - `sessionProjections` 缺席 → 单元不注册，聚合仍可跑（只是没有缓存收益）；
 * - `connection` + `sessionQuery` 缺席 → RPC 不注册，面板显示空态；
 * - `sessionProjectionCache` 缺席 → 无缓存可读，汇总退化为「不返回数据」而不抛错。
 */
function startTokstats(ctx, config) {
	const windowDays = Number.isFinite(config?.windowDays) && config.windowDays > 0
		? config.windowDays
		: TOKSTATS_DEFAULT_WINDOW_DAYS;
	// 检查点滞后校验（TS-19）：缺省开启。关闭后退回「只按 live 判定」，面板秒开但
	// 已结束会话的滞后检查点会被采信（实测少报 4.6% 调用）。
	const verifyStale = config?.verifyStale !== false;
	const log = (...args) => {
		try {
			ctx.logger?.warn(...args);
		} catch {
			/* 降级：logger 缺席时静默 */
		}
	};

	// ── 冷读凭据域（TS-26，软依赖）──────────────────────────────────────────
	//
	// 存放「这行投影缓存是我们冷读出来的，对应哪一版日志」。跨进程持久化，
	// 否则每次宿主重启都要重付一次全量冷读（实测本机 14 s / 20.6 CPU-s）。
	//
	// 域缺席（storageDomain 未挂载）或打不开时，凭据退化为**进程内记忆**：
	// 同进程内仍免掉重复冷读（TS-27），只是跨进程失效——功能降级，不抛错
	// （硬规则 6 / I8），与 promptopt 的计数器域同一纪律。
	const credentials = tokstatsCredentialStore(log);
	ctx.inject(["storageDomain"], async (pctx) => {
		try {
			const domain = await pctx.storageDomain.open(TOKSTATS_CREDENTIAL_DOMAIN_SPEC);
			credentials.attach(domain);
			// 域句柄的生命周期归调用方：随本 fiber 卸载关闭。
			ctx.effect(() => () => domain.close(), "dsh-plugins/tokstats: cold-read credential domain");
		} catch (error) {
			const detail = `tokstats: 冷读凭据域不可用，退回进程内记忆（跨进程不再省冷读）: ${String(error)}`;
			log(detail);
			try {
				process.stderr.write(`[dsh-plugins] ${detail}\n`);
			} catch {
				/* 降级：stderr 不可写时静默 */
			}
		}
	});

	// ── 单元注册（软依赖） ───────────────────────────────────────────────────
	ctx.inject(["sessionProjections"], (pctx) => {
		try {
			pctx.sessionProjections.register(tokstatsDefinition(windowDays));
		} catch (error) {
			log(`tokstats: 投影单元注册失败，面板将退回冷折叠: ${String(error)}`);
		}
	});

	// ── 面板数据端点（软依赖） ───────────────────────────────────────────────
	//
	// 每次请求现算：不做推送、不做轮询、不常驻订阅（Q3 裁决）。
	//
	// 通道挂载走本包的 `tokstatsRegisterRpcChannel`（`webServer.register` +
	// `connection.admit`），**不是** `connection.rpc.handle`——后者在 0.2.1-rc.2 上
	// 从第三方 context 调用必然抛 `cannot get property "webServer" without inject`
	// （原因与证据见该函数的注释）。因此这里要注入 `webServer`。
	//
	// `sessionProjectionCache` 则用 `ctx.get` 惰性取而**不进 inject**：inject 是
	// 「齐备才回调」的硬依赖，把它写进去会让缓存缺席时端点也不注册；而本插件要求
	// 该情形下端点仍在、只返回空聚合（I8 / AC-8）。
	ctx.inject(["connection", "sessionQuery", "webServer"], (pctx) => {
		const cacheOf = () => {
			try {
				return pctx.get("sessionProjectionCache");
			} catch {
				return undefined;
			}
		};
		// 活会话零回放读取面（TS-24）：投影注册表与活会话表都用 `ctx.get` 惰性取，
		// 缺席时 `tokstatsReadLive` 返回 undefined、退回冷读（硬规则 6）。
		const projectionsOf = () => {
			try {
				return pctx.get("sessionProjections");
			} catch {
				return undefined;
			}
		};
		const liveSessionOf = (id) => {
			try {
				const sessions = pctx.get("sessions");
				if (sessions === undefined || sessions === null || typeof sessions.get !== "function") return undefined;
				return sessions.get(id);
			} catch {
				return undefined;
			}
		};
		// 持久化水位读取面（TS-26）：`ctx.sessionPersistence` 的 `stat` 给日志
		// revision（纯 stat 元数据，不解码日志）。缺席时凭据闸门自动退化为
		// 「每轮都排冷读」= 旧行为，不抛错。
		const persistenceOf = () => {
			try {
				return pctx.get("sessionPersistence");
			} catch {
				return undefined;
			}
		};
		const readSummary = tokstatsSummaryReader(pctx.sessionQuery, cacheOf, windowDays, log, verifyStale, {
			projectionsOf,
			liveSessionOf,
			persistenceOf,
			credentials,
			revalidateTtlMs: config?.revalidateTtlMs,
		});
		// 注册失败必须显式暴露：通道没注册时浏览器侧只看到「统计服务不可用」，
		// 与「服务缺席」的症状无法区分，而两者的修法完全不同。
		try {
			tokstatsRegisterRpcChannel(pctx, TOKSTATS_CHANNEL, async (endpoint, payload) => {
				if (endpoint === TOKSTATS_PROMPTOPT_ENDPOINT) {
					// promptopt 计数器（AC-13）：跨插件观测面。它由 promptopt 自己的域
					// 持有，这里只读——tokstats 不写别人的域。
					return { ok: true, value: await tokstatsPromptoptCounters(pctx, log) };
				}
				if (endpoint !== TOKSTATS_ENDPOINT) return tokstatsFail("bad-request");
				try {
					return { ok: true, value: await readSummary(payload) };
				} catch (error) {
					log(`tokstats: 汇总失败: ${String(error)}`);
					return tokstatsFail("model-unavailable");
				}
			}, log);
			process.stderr.write(`[dsh-plugins] tokstats: 已注册 RPC 通道 ${TOKSTATS_CHANNEL}\n`);
		} catch (error) {
			const detail = `tokstats: RPC 通道注册失败，面板将显示「统计服务不可用」: ${String(error)}`;
			log(detail);
			try {
				process.stderr.write(`[dsh-plugins] ${detail}\n`);
			} catch {
				/* 降级：stderr 不可写时静默 */
			}
		}
	});
}

/**
 * 读 promptopt 的计数器（跨插件观测，AC-13）。
 *
 * 两个域的所有权各自独立：promptopt 打开并写它自己的域，tokstats **只读**
 * 已打开的同名域——它不 open()，因为同名域二次 open 会抛 already-open，而且
 * 「谁拥有句柄谁负责关闭」是域层的生命周期约定。
 *
 * 域未打开（promptopt 未挂载 / 其 fiber 已卸载 / 版本不符）时返回 null：面板据此
 * 隐藏该区块，而不是显示一排零假装统计过。
 *
 * @returns `{ started, adopted, dismissed, charsDelta }`，或在不可用时为 null。
 */
function tokstatsPromptoptCounters(pctx, log) {
	let facility;
	try {
		facility = pctx.get("storageDomain");
	} catch {
		return null;
	}
	if (facility === undefined || facility === null || typeof facility.get !== "function") return null;
	try {
		const domain = facility.get(PROMPTOPT_DOMAIN);
		if (domain === undefined) return null;
		const record = domain.table(PROMPTOPT_TABLE).get(PROMPTOPT_COUNTER_KEY);
		if (record === undefined) return promptoptZeroCounters();
		return PROMPTOPT_COUNTER_SCHEMA.parse(record);
	} catch (error) {
		log(`tokstats: promptopt 计数器读取失败: ${String(error)}`);
		return null;
	}
}

// ── plugin: promptopt（host：RPC 通道 + 旁路 llm 调用） ──────────────────────
//
// composer 草稿的保真**结构化重排**：浏览器点按钮 → 本通道 → 一次旁路模型调用 →
// 重排结果回浏览器，由用户审阅后才写回草稿（浏览器半边见 lib/client.js）。
//
// 定位（Q9，SPEC §方案 4）：把口语草稿重排成模型易解析的结构化输入，**不是**把
// 它展开成执行计划、更不是补全内容。失败策略取 F1 保守：不确定是否原文已有，就
// 保留原样。
//
// 契约核验（2026-10-20 复核 + 实测修正，@deepseek-ai/dsh@0.2.1-rc.2）：
// - **`ctx.connection.rpc.handle()` 在本版本不可用**（实测踩到并修正）：它把 owner
//   取成连接插件自己的 ctx（inject 只有 `credentials`），而 `register()` 里要访问
//   `owner.webServer`，故必然抛 `cannot get property "webServer" without inject`；
//   官方树里 `rpc.handle(` 的调用点为 0。本包改用自建的
//   `tokstatsRegisterRpcChannel`（`webServer.register` + `connection.admit`，
//   与官方 /api 路由同一道闸门），浏览器侧 `rpc.call` 的契约因此不变。
// - 函数签名 (endpoint, payload, signal) => Promise<RpcResult>；signal 来自请求中断
//   （浏览器 abort fetch 即中止这里的 in-flight 调用）。
// - 响应信封的**错误码是闭集**：成功分支是 { ok: true, value }，摊平写成
//   { ok: true, text } 会被客户端 parseConnectionResponse 吃掉；失败分支的
//   code / message / details 三者都是硬性类型检查，details 必须是对象。

const PROMPTOPT_CHANNEL = "/dsh-plugins.promptopt";
const PROMPTOPT_ENDPOINT = "optimize";
/** 只读计数器（面板展示用）。 */
const PROMPTOPT_COUNTER_ENDPOINT = "counters";
/** 上报一次采纳/放弃（浏览器侧动作，不是会话事件）。 */
const PROMPTOPT_EVENT_ENDPOINT = "event";
const PROMPTOPT_TIMEOUT_MS = 60000;
/** 草稿上限（字符）：超过即拒，避免一次旁路调用吃掉整个上下文窗口。 */
const PROMPTOPT_MAX_DRAFT_CHARS = 65536;

/**
 * 内置 meta-prompt（英文协议常量，不进词典不翻译）。
 *
 * 五条约束（对应 I11）：
 * 1. 只重排与显式化，**禁止新增**原文不存在的事实、路径、约束、步骤；
 * 2. 不确定是否原文已有 → 保留原样（F1 保守失败）；
 * 3. 原文已足够结构化 → 原样返回并标注「无需整理」（F4）；
 * 4. 产出跟随草稿语言；
 * 5. 只返回重排结果，不带解释、不带包裹引号或代码围栏。
 *
 * 「结构化」的定义写成可执行的判据而不是抽象要求：多诉求拆条、代词还原为名词、
 * 约束从句提为显式条目、去掉对话性填充。
 */
const PROMPTOPT_META_PROMPT = [
	"Restructure the draft below into input that is easier for a model to parse.",
	"You are reformatting, not expanding: every fact must already be in the draft.",
	"",
	"Rules:",
	"1. Do not add facts, files, paths, constraints, steps, or requirements that the draft does not already contain. Adding any of these is a failure, even if it would make the prompt better.",
	"2. If you are unsure whether something is already in the draft, leave it exactly as written instead of supplying it.",
	"3. If the draft is already structured enough, return it unchanged and say nothing about it.",
	"4. Write the output in the same language as the draft.",
	"5. Return ONLY the restructured text. No explanation, no preamble, no wrapping quotes, no code fence.",
	"",
	"Restructuring means:",
	"- Split one run-on request that carries several asks into parallel items.",
	"- Replace pronouns and vague references that point at something the draft already names with that name; if the draft does not name it, keep the original wording.",
	"- Lift constraint clauses (do not touch X, must use Y) out into explicit items.",
	"- Drop conversational filler: greetings, hedging, and self-doubt about the request.",
].join("\n");

/**
 * 错误码映射（wire 闭集 → 本插件语义）。每个 wire 码在本插件内有且仅有一个
 * 生产者，客户端据此选词典键，不会两义：
 * - bad-request       ← 草稿预检失败（空 / 非字符串 / 超长）
 * - model-unavailable ← 路由解析失败、模型调用失败、产出不可用、未预期异常
 * - internal         ← 只有超时（保留给 60s 截止，不兼作兜底以免文案误导）
 * - cancelled        ← 请求进入时已被 abort
 */
function promptoptFail(code, details) {
	// message 是 schema 必填字段，但本插件不产出人类可读文案（词典在 client
	// bundle，host 侧无 locale 服务），故回填机器码本身。
	return { ok: false, error: { code, message: code, details: details ?? {} } };
}

/** 草稿预检：空 / 非字符串 / 超长 → bad-draft（客户端也预检一次，这里是权威侧）。 */
function promptoptBadDraft(payload) {
	const text = payload === null || typeof payload !== "object" ? undefined : payload.text;
	if (typeof text !== "string") return true;
	if (text.trim().length === 0) return true;
	// 按 UTF-16 长度卡上限（与浏览器侧 String.length 同口径，避免两侧判定漂移）。
	return text.length > PROMPTOPT_MAX_DRAFT_CHARS;
}

/**
 * 解析旁路调用的路由：首个已注册 provider 的首个模型。
 *
 * GenerateOptions 的 provider / model 都是必填、且没有「当前模型」默认回落
 * （dsh-session-title-llm 要么读 config、要么拿 session 的 route，而本 fiber
 * 不注入 sessions），故按注册序取第一个可用路由——零配置面，代价是多 provider
 * 时用的未必是用户偏好的那个，但改写提示词这类旁路调用对模型不敏感。
 */
async function promptoptResolveRoute(llm) {
	const providers = llm.listProviders();
	if (!Array.isArray(providers)) return undefined;
	for (const provider of providers) {
		const id = provider === null || typeof provider !== "object" ? undefined : provider.id;
		if (typeof id !== "string" || id.length === 0) continue;
		const models = await llm.listModels(id);
		if (!Array.isArray(models)) continue;
		for (const model of models) {
			const modelId = model === null || typeof model !== "object" ? undefined : model.id;
			if (typeof modelId === "string" && modelId.length > 0) return { provider: id, model: modelId };
		}
	}
	return undefined;
}

/** 手写 user message（不能 import dsh-llm 的 createUserMessage——硬规则 5）。 */
function promptoptUserMessage(text) {
	return {
		id: randomUUID(),
		role: "user",
		content: [{ type: "text", text }],
		source: { kind: "plugin", plugin: "dsh-plugins.promptopt" },
	};
}

/**
 * 收集一次旁路调用的完整输出。
 * 官方用 BlockAssembler（@deepseek-ai/dsh-llm/assembler），但那在 npm 包里、
 * 本包不可解析；chunk 协议足够简单，自行累加 text-delta 并收 usage / finish。
 * reasoning-delta 刻意不收：思考过程不是改写产物，进了输入框就是污染。
 */
async function promptoptCollect(llm, options) {
	let text = "";
	let usage;
	let finish;
	for await (const chunk of llm.stream(options)) {
		if (chunk === null || typeof chunk !== "object") continue;
		if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
		else if (chunk.type === "usage") usage = chunk.usage;
		else if (chunk.type === "finish") finish = chunk.reason;
	}
	return { text, usage, finish };
}

/**
 * 一次 optimize 调用。返回的永远是 RpcResult 形状——handler 抛异常会被宿主
 * 转成整响应 500（`handler failure: ...`），客户端拿不到错误码，所以这里全 catch。
 */
async function promptoptOptimize(llm, payload, signal, timeoutMs) {
	if (promptoptBadDraft(payload)) return promptoptFail("bad-request", { issues: [] });
	if (signal?.aborted === true) return promptoptFail("cancelled");

	const route = await promptoptResolveRoute(llm);
	if (route === undefined) return promptoptFail("model-unavailable", { provider: "unknown", model: "unknown" });

	// 双保险超时：宿主透传的 signal 管用户取消，本控制器管 60s 截止（宿主不替
	// 我们做超时）。两者合并成同一个 signal 交给 llm，任一路触发都中止调用。
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	if (signal !== undefined && signal !== null) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	const startedAt = Date.now();
	try {
		const options = {
			...route,
			messages: [promptoptUserMessage(payload.text)],
			system: PROMPTOPT_META_PROMPT,
			// purpose 是 'compaction' | 'session-title' 闭集，自定义值会被拒，故省略。
			signal: controller.signal,
		};
		const { text, usage, finish } = await promptoptCollect(llm, options);
		if (timedOut || controller.signal.aborted) {
			// 用户取消优先于超时：浏览器已经关了弹层，超时文案对用户没有意义。
			return promptoptFail(signal?.aborted === true ? "cancelled" : "internal");
		}
		const finishKind = finish === null || typeof finish !== "object" ? undefined : finish.kind;
		if (finishKind !== undefined && finishKind !== "stop") {
			return promptoptFail("model-unavailable", route);
		}
		const optimized = text.trim();
		if (optimized.length === 0) return promptoptFail("model-unavailable", route);
		// F4：原文已足够结构化时模型被要求原样返回。判定放在这里而不是让模型
		// 自报「无需整理」——模型自报的标记不可靠，而「产出与原文等价」是可直接
		// 观察的事实，弹层据此禁用采纳、避免用户点了采纳却什么也没变。
		const noChange = optimized === payload.text.trim();
		return {
			ok: true,
			value: {
				text: optimized,
				durationMs: Date.now() - startedAt,
				noChange,
				...(usage === undefined ? {} : { usage }),
			},
		};
	} catch {
		// 流中抛错、llm 服务异常、路由查询失败都落这里。区分不出具体原因时归
		// model-unavailable（「模型调用没产出可用结果」），不占用只留给超时的
		// internal。
		return promptoptFail(timedOut ? "internal" : "model-unavailable", route);
	} finally {
		clearTimeout(timer);
		if (signal !== undefined && signal !== null) signal.removeEventListener("abort", onAbort);
	}
}

// ── promptopt 计数器（候选 A：官方 storageDomain，软依赖） ──────────────────
//
// 落点决策（SPEC §方案 4 开放项，阶段 0 p0-a 定夺）：用官方存储域而不是宿主内存。
// 理由：内存计数重启即清零，「这周用没用过」这类判断随之失效；而存储域是官方基础
// 设施，不违反 I2 的「不自建文件格式」——我们不写 DSH_HOME 下任何自有文件，格式与
// 落盘由 storage-domain 后端负责。
//
// 形状约束（p0-a 核验结论）：
// - 域/表名受 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 约束，故用下划线不用点/连字符；
// - AGENTS 硬规则 5 禁止 import 任何 npm 包，而 `defineDomain` / `domainTable` 都在
//   npm 包里，故这里**手写 spec**：`tables.<name>` 只需 `{ valueSchema }`，而
//   `valueSchema` 只需 `{ parse }`（域打开时逐记录校验走它）。零 zod 依赖。
// - `version: 1`：将来改记录形状必须抬版本，抬版本会让旧域整体打不开（域层没有
//   per-record 的 backup-and-skip，除非 spec 显式声明）。

/** 计数器域名（受 UNIT_NAME_RE 约束）。 */
const PROMPTOPT_DOMAIN = "dsh_plugins_promptopt";
const PROMPTOPT_TABLE = "counters";
/** 单记录键：三个计数器 + 字符增减量放同一行，避免多条记录的事务性问题。 */
const PROMPTOPT_COUNTER_KEY = "totals";

/** 手写值校验器：三个计数必须是非负整数，charsDelta 是可负整数。 */
const PROMPTOPT_COUNTER_SCHEMA = {
	parse(value) {
		if (value === null || typeof value !== "object") throw new TypeError("promptopt counters must be an object");
		const out = {};
		for (const field of ["started", "adopted", "dismissed", "charsDelta"]) {
			const raw = value[field];
			if (!Number.isSafeInteger(raw)) throw new TypeError(`promptopt counters.${field} must be a safe integer`);
			out[field] = raw;
		}
		if (out.started < 0 || out.adopted < 0 || out.dismissed < 0) throw new TypeError("promptopt counters must be non-negative");
		return out;
	},
};

/** 计数器域 spec（手写，等价于 defineDomain({...}) 的返回形状）。 */
const PROMPTOPT_DOMAIN_SPEC = {
	name: PROMPTOPT_DOMAIN,
	version: 1,
	tables: { [PROMPTOPT_TABLE]: { valueSchema: PROMPTOPT_COUNTER_SCHEMA } },
};

function promptoptZeroCounters() {
	return { started: 0, adopted: 0, dismissed: 0, charsDelta: 0 };
}

/**
 * 让出事件循环一次（TS-27）。
 *
 * 用 `node:timers/promises` 的 `scheduler.yield()`——与宿主 `readZstdPrefix` 用的是
 * 同一个原语（`dsh-session-persistence-jsonl/lib/index.js:3003`），且是 `node:` 内建，
 * 不违反硬规则 5 的零依赖。
 *
 * 降级：`scheduler` 不可用时退回 `setImmediate`（同样是「下一轮事件循环」语义）。
 * 两者都不可用时同步返回——那只是少一次让出，不影响正确性。
 */
async function tokstatsYield() {
	try {
		const { scheduler } = await import("node:timers/promises");
		if (scheduler !== undefined && typeof scheduler.yield === "function") {
			await scheduler.yield();
			return;
		}
	} catch {
		/* 降级到 setImmediate */
	}
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

/**
 * tokstats 冷读凭据域（TS-26）：记住「这行投影缓存是我们冷读出来的，且对应哪一版日志」。
 *
 * 为什么需要它（TS-26 / TS-27）：
 * - 冷读成本 **98% 在宿主 `readSession`**（本机 73 个会话实测 14 095 ms，纯 zstd 解码
 *   仅 1 904 ms，本插件折叠仅 107 ms）。宿主**不会**替插件重校验已落盘会话的缓存行
 *   （`coldSnapshot` 在宿主 asar 内零调用点），所以「这行缓存可不可信」只有插件
 *   自己知道。宿主重启后进程内记忆全丢 → 每次重启都要重付 14 s。
 * - 记账口径用宿主公开服务 `ctx.sessionPersistence` 的 `revision`（纯 stat 元数据
 *   `dev:ino:size:mtimeNs:ctimeNs`，**不解码日志**）。宿主对该字段的定义原文是
 *   「equal revisions may be treated as an unchanged log… It exists for derived
 *   read-model caches keyed off `stat`/`list`」——正是本用途。
 *
 * **凭据只证明「日志字节未变」，不替代 TS-19 的 seq 基线**：revision 判定「日志有没有
 * 动过」，`observedSeq` 判定「缓存行追没追平我们亲眼见过的日志末尾」。两者都要。
 *
 * 落点约束：官方存储域（不得自建文件——PK-08）；域/表名受 `UNIT_NAME_RE =
 * /^[a-z][a-z0-9_]*$/` 约束。spec 手写（`defineDomain` 在 npm 包里，硬规则 5 禁止
 * import），与 promptopt 的计数器域同一手法：`tables.<name>` 只需 `{ valueSchema }`，
 * 而 `valueSchema` 只需 `{ parse }`。
 */

/** 冷读凭据域名（受 UNIT_NAME_RE 约束）。 */
const TOKSTATS_CREDENTIAL_DOMAIN = "dsh_plugins_tokstats";
/** 单表：会话 id → 冷读凭据。 */
const TOKSTATS_CREDENTIAL_TABLE = "cold_reads";

/**
 * 凭据记录形状：`{ rev, seq }`。
 *
 * - `rev`：宿主持久化层的日志 revision（不透明串，原样存原样比）。
 * - `seq`：本次冷读**亲眼看到**的日志末序号（TS-19 口径），跨进程记下来后，
 *   新进程不必再冷读一次就能知道缓存行的水位下限。
 *
 * ⚠️ **v0 格式会话的 revision 不能当「日志未变」的凭据用**（实测踩到）：
 * 宿主对 `sourceVersion < SESSION_FORMAT_VERSION` 的产物把 revision 算成
 * `${fileRevision}:${historicalCorpusRevision()}`，而后者是**所有历史日志**的
 * SHA-256（`dsh-session-persistence-jsonl/lib/index.js:2588` + `:3097-3100`）。
 * 于是**任何一个**历史日志变了，**每一个** v0 会话的 revision 都会跟着变——
 * 这些会话会永远重新冷读。本机 74 个会话里有 14 个是 v0 格式，
 * 占了冷读 CPU 的绝大部分。
 *
 * 识别办法：v0 的 revision 比 v4 多一段（`...:ctimeNs:<sha256>`），
 * 即 `split(":").length === 6`（v4 是 5 段）。对这个形态**不记凭据**，
 * 退回 TS-19 的 seq 基线路径——那些会话本来就是宿主格式迁移截断的已知问题。
 */
const TOKSTATS_CREDENTIAL_SCHEMA = {
	parse(value) {
		if (value === null || typeof value !== "object") throw new TypeError("tokstats cold-read credential must be an object");
		const rev = value.rev;
		if (typeof rev !== "string" || rev.length === 0) throw new TypeError("tokstats cold-read credential.rev must be a non-empty string");
		const seq = value.seq;
		if (!Number.isSafeInteger(seq)) throw new TypeError("tokstats cold-read credential.seq must be a safe integer");
		return { rev, seq };
	},
};

/**
 * 一条 revision 是否可以做「日志未变」的凭据（TS-26）。
 *
 * v0 格式（历史版本）的 revision 里掺了**全局**历史语料哈希，任何历史日志变化
 * 都会让它变，因此它证明不了「这个会话的日志没变」——只能退回 seq 基线。
 * 形态判据见 `TOKSTATS_CREDENTIAL_SCHEMA` 的说明（6 段 vs 5 段）。
 */
function tokstatsRevisionIsPerSession(revision) {
	if (typeof revision !== "string" || revision.length === 0) return false;
	return revision.split(":").length === 5;
}

/** 冷读凭据域 spec（手写，等价于 defineDomain({...}) 的返回形状）。 */
const TOKSTATS_CREDENTIAL_DOMAIN_SPEC = {
	name: TOKSTATS_CREDENTIAL_DOMAIN,
	version: 1,
	tables: { [TOKSTATS_CREDENTIAL_TABLE]: { valueSchema: TOKSTATS_CREDENTIAL_SCHEMA } },
};

/**
 * 冷读凭据存取器。
 *
 * 读面是**同步**的（存储域的读永远走内存表，见 storage-domain README）：
 * `get(id)` 返回 `{ rev, seq }` 或 undefined。写面是异步的（要等落盘），
 * 失败一律吞掉——凭据只是**加速**手段，写不进去最坏退回「每次都冷读」，
 * 那是旧行为，不是错误。
 *
 * 域缺席（`storageDomain` 未挂载 / 域打不开）时退化为**进程内记忆**：
 * 同进程内仍能免掉重复冷读（TS-27），只是跨进程失效。这与 promptopt 的计数器
 * 同一降级纪律（硬规则 6 / I8）。
 *
 * @param log - 降级告警出口。
 */
function tokstatsCredentialStore(log) {
	/** 进程内记忆（域缺席时也用它兜底；域在场时以域为准）。 */
	const memory = new Map();
	let domain;
	let table;

	const readTable = () => {
		if (domain === undefined || domain === null) return undefined;
		try {
			table ??= domain.table(TOKSTATS_CREDENTIAL_TABLE);
			return table;
		} catch (error) {
			log(`tokstats: 冷读凭据表不可用，本次按未记账处理: ${String(error)}`);
			return undefined;
		}
	};

	return {
		/**
		 * 取某会话的凭据。域优先，域缺席时退回进程内记忆。
		 * @returns `{ rev, seq }` 或 undefined（从未冷读过 / 读不出来）。
		 */
		get(id) {
			const t = readTable();
			if (t === undefined) return memory.get(id);
			try {
				const raw = t.get(id);
				if (raw === undefined) return undefined;
				const parsed = TOKSTATS_CREDENTIAL_SCHEMA.parse(raw);
				// v0 格式的 revision 证明不了「这个会话没变」（见 tokstatsRevisionIsPerSession），
				// 按「没有凭据」处理 → 退回 TS-19 的 seq 基线路径。
				if (!tokstatsRevisionIsPerSession(parsed.rev)) return undefined;
				return parsed;
			} catch (error) {
				// 坏记录按「没有凭据」处理：宁可多冷读一次，不可少报。
				log(`tokstats: 冷读凭据 ${id} 不可用，按未记账处理: ${String(error)}`);
				return undefined;
			}
		},
		/**
		 * 记下某会话的凭据。**不 await**：调用方在冷读成功后立即调用，
		 * 写入是 fire-and-forget（域的写入链保证最终落盘）。
		 */
		put(id, credential) {
			let value;
			try {
				value = TOKSTATS_CREDENTIAL_SCHEMA.parse(credential);
			} catch (error) {
				log(`tokstats: 冷读凭据 ${id} 形状不合法，不记账: ${String(error)}`);
				return;
			}
			// v0 格式的 revision 证明不了「这个会话没变」→ 不记账，退回 seq 基线。
			if (!tokstatsRevisionIsPerSession(value.rev)) return;
			memory.set(id, value);
			const t = readTable();
			if (t === undefined) return;
			try {
				t.put(id, value).catch((error) => {
					log(`tokstats: 冷读凭据 ${id} 写入失败（下次仍会冷读）: ${String(error)}`);
				});
			} catch (error) {
				log(`tokstats: 冷读凭据 ${id} 写入失败（下次仍会冷读）: ${String(error)}`);
			}
		},
		/** 域句柄就绪后换上（`startTokstats` 的 inject 回调里调用）。 */
		attach(domainHandle) {
			domain = domainHandle;
			table = undefined;
		},
	};
}

/**
 * 计数器读写器。写入失败一律吞掉：计数器是观测面，不能因为它坏掉就挡住用户
 * 优化提示词（硬规则 6 / I8）。
 *
 * @param domain - 已打开的存储域；缺席时返回全零的空操作读写器（read 仍可用，
 *   因为面板要能拿到「没有计数的零」，而不是一个不存在的端点）。
 * @returns `{ record(event, detail), read() }`，事件为 'adopted' / 'dismissed'。
 *
 * `record` **返回写入后的值**：`table.put()` 是异步的（要走域的写入链），内存里
 * 的表在 await 之前不会变，所以「record 完立刻 read」读到的是写入前的旧值。
 * 实测踩到：上报一次 adopted 后响应仍是 0/0/0，而磁盘上已经是 adopted:1。
 * 调用方要回显最新值就直接用 record 的返回值，别再调 read。
 */
function promptoptCounter(ctx, domain, log) {
	let table;
	const read = () => {
		if (domain === undefined) return promptoptZeroCounters();
		try {
			table ??= domain.table(PROMPTOPT_TABLE);
			const current = table.get(PROMPTOPT_COUNTER_KEY);
			if (current === undefined) return promptoptZeroCounters();
			// 读面也过一遍校验：磁盘上的记录可能来自更早的版本，坏记录按「没有」处理。
			return PROMPTOPT_COUNTER_SCHEMA.parse(current);
		} catch (error) {
			log(`promptopt: 计数器读取失败（按零计）: ${String(error)}`);
			return promptoptZeroCounters();
		}
	};
	return {
		read,
		record(event, detail) {
			const next = read();
			if (domain === undefined) return next;
			try {
				table ??= domain.table(PROMPTOPT_TABLE);
				next[event] += 1;
				if (event === "adopted" && detail !== undefined) {
					// 字符增减量 = 采纳后的长度 − 原文长度（可为负：重排往往更短）。
					const before = typeof detail.before === "number" ? detail.before : 0;
					const after = typeof detail.after === "number" ? detail.after : 0;
					next.charsDelta += after - before;
				}
				table.put(PROMPTOPT_COUNTER_KEY, next).catch((error) => {
					log(`promptopt: 计数器写入失败（本次不计）: ${String(error)}`);
				});
			} catch (error) {
				log(`promptopt: 计数器更新失败（本次不计）: ${String(error)}`);
			}
			return next;
		},
	};
}

/** promptopt 组装：登记 RPC 通道，路由随本 fiber 卸载即摘。 */
function startPromptopt(ctx, config) {
	// 超时可注入（测试用短超时，避免真等 60s）。
	const timeoutMs = Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : PROMPTOPT_TIMEOUT_MS;
	const log = (...args) => {
		try {
			ctx.logger?.warn(...args);
		} catch {
			/* 降级：logger 缺席时静默 */
		}
	};

	// 计数器域（软依赖）：storageDomain 缺席 → domain 保持 undefined，record() 变成
	// 空操作，promptopt 的其余功能照常（I8）。域打不开（版本不符 / 后端缺失）也只
	// 记一条警告，不阻断通道注册。
	const counters = { current: promptoptCounter(ctx, undefined, log) };
	ctx.inject(["storageDomain"], async (pctx) => {
		try {
			const domain = await pctx.storageDomain.open(PROMPTOPT_DOMAIN_SPEC);
			counters.current = promptoptCounter(ctx, domain, log);
			// 域句柄的生命周期归调用方：随本 fiber 卸载关闭。
			ctx.effect(() => () => domain.close(), "dsh-plugins/promptopt: counter domain");
		} catch (error) {
			// 计数器缺失是**静默**的功能降级（面板隐藏该分区），而静默失败最难查。
			// 这里额外往 stderr 打一行：ctx.logger 的 warn 不落进程 stdout，排查时
			// 只能靠宿主自己的日志通道，实测在 dsh web 下拿不到。
			const detail = `promptopt: 计数器域不可用，计数停用（其余功能不受影响）: ${String(error)}`;
			log(detail);
			try {
				process.stderr.write(`[dsh-plugins] ${detail}\n`);
			} catch {
				/* 降级：stderr 不可写时静默 */
			}
		}
	});

	// connection 与 llm 都是软依赖：任一缺席则回调永不触发，通道不注册——
	// 浏览器半边表现为点按钮报 error.llm，而不是整包挂掉（硬规则 6）。
	//
	// 通道挂载走本包的 `tokstatsRegisterRpcChannel`（`webServer.register` +
	// `connection.admit`），**不是** `connection.rpc.handle`——后者在 0.2.1-rc.2 上
	// 从第三方 context 调用必然抛 `cannot get property "webServer" without inject`
	// （原因与证据见该函数的注释）。
	ctx.inject(["connection", "llm", "webServer"], (pctx) => {
		try {
			tokstatsRegisterRpcChannel(pctx, PROMPTOPT_CHANNEL, async (endpoint, payload, signal) => {
				if (endpoint === PROMPTOPT_COUNTER_ENDPOINT) return { ok: true, value: counters.current.read() };
				if (endpoint === PROMPTOPT_EVENT_ENDPOINT) {
					const event = promptoptCounterEvent(payload);
					if (event === undefined) return promptoptFail("bad-request", { issues: [] });
					// 用 record 的返回值回显，不要再调 read()：put 是异步的，紧接着的
					// read 会拿到写入前的旧内存（实测响应恒为 0）。
					return { ok: true, value: counters.current.record(event.name, event.detail) };
				}
				if (endpoint !== PROMPTOPT_ENDPOINT) return promptoptFail("bad-request", { issues: [] });
				const result = await promptoptOptimize(pctx.llm, payload, signal, timeoutMs);
				// 发起计数在拿到结果后记：提前记会让「通道挂了」也算一次发起。
				if (result.ok === true) counters.current.record("started");
				return result;
			}, log);
			process.stderr.write(`[dsh-plugins] promptopt: 已注册 RPC 通道 ${PROMPTOPT_CHANNEL}\n`);
		} catch (error) {
			const detail = `promptopt: RPC 通道注册失败，按钮将报「模型调用失败」: ${String(error)}`;
			log(detail);
			try {
				process.stderr.write(`[dsh-plugins] ${detail}\n`);
			} catch {
				/* 降级：stderr 不可写时静默 */
			}
		}
	});
}

/** 计数器事件入参校验：只认三个事件名，detail 里的长度必须是非负整数。 */
function promptoptCounterEvent(payload) {
	if (payload === null || typeof payload !== "object") return undefined;
	const name = payload.event;
	if (name !== "adopted" && name !== "dismissed") return undefined;
	const before = payload.before;
	const after = payload.after;
	const detail = name === "adopted"
		? {
			before: Number.isSafeInteger(before) && before >= 0 ? before : 0,
			after: Number.isSafeInteger(after) && after >= 0 ? after : 0,
		}
		: undefined;
	return { name, detail };
}

export {
	apply,
	// 纯函数出口：tks-1a…1d 要求这些折叠/落桶/聚合函数能脱离 cordis 直跑单测
	// （TASKS 阶段 1 的判据就是「无 cordis，node 直跑可测」）。
	tokstatsBucketOf,
	tokstatsDayKey,
	tokstatsFoldUsage,
	tokstatsInit,
	tokstatsAggregate,
	tokstatsWeekStartOf,
	tokstatsEpochFold,
	tokstatsWindowStart,
	tokstatsRootWorkspaceOf,
	tokstatsSummaryOf,
	tokstatsDefinition,
	tokstatsRouteOf,
	TOKSTATS_KEY,
	TOKSTATS_STATE_VERSION,
	TOKSTATS_BUCKET_BOUNDS,
	TOKSTATS_BUCKET_COUNT,
	TOKSTATS_CHANNEL,
	TOKSTATS_ENDPOINT,
	TOKSTATS_DEFAULT_WINDOW_DAYS,
};

