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
// - **单元**：每会话一个投影单元，key 'tokstats'、stateVersion 2。宿主
//   session-projection 注册表在每个已提交事件上主动驱动 apply，持久化与冷启动
//   由官方 session-projection-cache 负责——本插件不再写任何自有文件（I2）。
// - **带 wire**：单元必须带 wire 块才能被 cachedSnapshot/viewCheckpoint 读回
//   （host-only 单元在公开读取面上被跳过），而 wire.view 只返回紧凑摘要
//   { w, e, rows }，不返回跨会话 cells，也不含 provider/model（I1）。
// - **汇总**：面板打开时经 RPC 一次性拉取。每个会话先 cachedSnapshot（零 I/O），
//   取不到再 readSession + coldSnapshot 冷折叠兜底；provider/model 维度已删（Q6）。
//
// 阶段 0 契约结论（详见 docs/specs/active/TASKS-v0.6.0.md 附记）：
// - p0-c：init 只收 (header, inheritedEventCount)，拿不到 headersById，故根工作区
//   解析搬到这里（summarize 持有全部 meta）；init 保持纯函数。
// - p0-d：服务名 sessionProjectionCache，cachedSnapshot(meta, keys) 只比 header
//   生命周期四字段，返回 undefined 即需冷折叠。
// - p0-e（硬门）：sessionQuery 在 openAt: never 下照常注册（服务在构造函数里建），
//   listSessions/readSession 从不触碰 _db——汇总数据源用它，不走 persistence 私有面。
// - p0-f：connection.rpc.handle 只有两参，authority 选项已不存在，不要传第三参。

/** 投影单元 key（沿用既有 key，语义收窄为「本会话的天 × 桶折叠」）。 */
const TOKSTATS_KEY = "tokstats";
/** 单元版本：由 1 提升 → 旧缓存行按 stateVersion 不匹配自然作废，不写迁移（I3/R2）。 */
const TOKSTATS_STATE_VERSION = 2;
/** 面板 RPC 通道（连接层只接受 /[A-Za-z0-9._~-]+，见 p0-f）。 */
const TOKSTATS_CHANNEL = "/dsh-plugins.tokstats";
const TOKSTATS_ENDPOINT = "summary";
/** promptopt 计数器读数（跨插件观测面，AC-13）。 */
const TOKSTATS_PROMPTOPT_ENDPOINT = "promptopt";
/** 默认折叠窗口（天）：来自行 config.windowDays，缺省 90（SPEC §方案 1）。 */
const TOKSTATS_DEFAULT_WINDOW_DAYS = 90;

/** 上下文桶边界（2 的幂，计费输入 = in + cr + cw 落桶）；桶数 = 边界数 + 1。 */
const TOKSTATS_BUCKET_BOUNDS = [4096, 8192, 16384, 32768, 65536, 131072];
const TOKSTATS_BUCKET_COUNT = TOKSTATS_BUCKET_BOUNDS.length + 1;

/** 本地时区自然日键（host 进程时区，SPEC Q5-A 裁决口径）。 */
function tokstatsDayKey(ts) {
	const d = new Date(ts);
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return d.getFullYear() + "-" + m + "-" + day;
}

/** 计费输入 → 2 的幂对数桶序号（0..6 = [0,4K)…[128K,∞)）。 */
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

/** 单元格键：天 × 桶（工作区不进 key——单会话根工作区是常量，见 SPEC §方案 1）。 */
function tokstatsCellKey(day, bucket) {
	return day + "\x1f" + bucket;
}

/** 取一格（不新建）；折叠期按 key 查找用。 */
function tokstatsFindCell(rows, day, bucket) {
	const key = tokstatsCellKey(day, bucket);
	for (const cell of rows) {
		if (tokstatsCellKey(cell.d, cell.b) === key) return cell;
	}
	return undefined;
}

/**
 * 一条样本累加进 rows，返回**新**状态（纯函数，不改入参）。
 *
 * `sign < 0` 是差值法的减项：同 (turn, step) 的终值替换靠「先减旧再加新」，
 * 因为旧采样可能落在另一天或另一桶，减旧加新自动把两边都修对（I5）。
 */
function tokstatsApplySample(state, sample, sign) {
	const billed = sample.in + sample.cr + sample.cw;
	const b = tokstatsBucketOf(billed);
	const d = tokstatsDayKey(sample.time);
	const prev = tokstatsFindCell(state.rows, d, b);
	if (prev === undefined && sign < 0) return state;
	const cell = prev === undefined
		? { d, b, calls: 0, in: 0, cr: 0, cw: 0, out: 0 }
		: { d, b, calls: prev.calls, in: prev.in, cr: prev.cr, cw: prev.cw, out: prev.out };
	cell.calls += sign;
	cell.in += sign * sample.in;
	cell.cr += sign * sample.cr;
	cell.cw += sign * sample.cw;
	cell.out += sign * sample.out;
	const rows = [];
	for (const existing of state.rows) {
		if (existing.d === d && existing.b === b) continue;
		rows.push(existing);
	}
	// calls 归零的格整条剔除：差值法减回去的空格若留在数组里，「明细条数」会随
	// 采样次数虚增（AC-5 断言折叠前后条数一致）。
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
 * 不读 `request/header`、不读 `message.source`：provider/model 维度已删（Q6），
 * content-less 调用的归因分支随之整体移除。
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
	if (event.type === "assistant/chunk") {
		const chunk = data.chunk;
		if (chunk === null || typeof chunk !== "object" || chunk.type !== "usage") return state;
		usage = chunk.usage;
	} else if (event.type === "assistant/message") {
		usage = data.usage;
	} else {
		return state;
	}
	if (usage === null || typeof usage !== "object") return state;
	if (typeof data.turn !== "number" || typeof data.step !== "number") return state;
	const sample = {
		turn: data.turn,
		step: data.step,
		time: event.time,
		in: tokstatsNum(usage.inputTokens),
		cr: tokstatsNum(usage.cacheReadTokens),
		cw: tokstatsNum(usage.cacheWriteTokens),
		out: tokstatsNum(usage.outputTokens),
	};
	// 全零样本：**照常计为一次调用**，四桶为 0，落在 [0,4K) 桶。
	//
	// 实测依据（28 份真实日志全量统计）：纯真实 step 1868 个、纯零 step 5 个、
	// 「真实样本 + 零样本」混合 step **0 个**——零样本永远独立成 step，不存在
	// 「真实终值被后续零样本抹掉」的情形。
	//
	// 所以不需要为它们写特例：终值替换在同 (turn,step) 内生效，而零 step 内部
	// 的多个零样本相互替换后仍是零。丢弃它们反而会让这 5 次真实发生过的调用
	// 从 `calls` 里消失（模型确实被调用了，只是没产出 token），既丢失计数，也
	// 与旧实现 575 次的基准对不上（其中 [0,4K) 的 5 次正是这些）。
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
 * epoch 必须保留**桶粒度**（`buckets` 数组），否则折叠后桶分布的形状会变扁——
 * AC-5 要求折叠前后各桶数字逐项一致，这是硬约束而不是优化细节。
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
	const buckets = tokstatsZeroBuckets();
	let start = hasEpoch && typeof epoch.start === "string" ? epoch.start : null;
	let folded = false;
	if (hasEpoch && Array.isArray(epoch.buckets)) {
		for (let i = 0; i < buckets.length; i += 1) {
			const prev = epoch.buckets[i];
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
	for (const cell of state.rows) {
		if (cell.d >= windowStart) continue;
		if (from !== null && cell.d >= from) continue;
		if (!Number.isInteger(cell.b) || cell.b < 0 || cell.b >= buckets.length) continue;
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
	return { ...state, epoch: { start, end: windowStart, buckets } };
}

/** 全零桶数组（epoch 合计与读取期桶分布同形状）。 */
function tokstatsZeroBuckets() {
	const buckets = [];
	for (let i = 0; i < TOKSTATS_BUCKET_COUNT; i += 1) buckets.push(tokstatsZeroTotals());
	return buckets;
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
 */
function tokstatsSummaryOf(value) {
	if (value === null || typeof value !== "object") return undefined;
	if (!Array.isArray(value.rows)) return undefined;
	const rows = [];
	for (const cell of value.rows) {
		if (cell === null || typeof cell !== "object") continue;
		if (typeof cell.d !== "string") continue;
		if (!Number.isInteger(cell.b)) continue;
		rows.push(cell);
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
 * 聚合：各会话摘要 → 面板要的三块（桶分布 / 周趋势 / 工作区分组）。
 *
 * 读取期排除 epoch 区间内的明细并改计 epoch 的按桶合计，避免与 E1 折叠双计；
 * 因为 epoch 保留桶粒度，折叠前后各桶数字逐项一致（AC-5）。
 *
 * @param entries - `{ rootWorkspace, summary }[]`；summary 为 undefined 表示该会话读取失败。
 * @param options - `{ windowDays, workspace, today }`。
 */
function tokstatsAggregate(entries, options) {
	const windowStart = tokstatsWindowStart(options.windowDays, options.today);
	const buckets = tokstatsZeroBuckets();
	const weeks = new Map();
	const workspaces = new Map();
	const totals = tokstatsZeroTotals();

	/** 一格计入所有维度（桶 / 周 / 工作区 / 总计）；`buckets` 与 `workspaces` 由闭包带。 */
	const addCell = (target, bucket, day, calls, inTokens, outTokens, cr, cw) => {
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
	};

	for (const entry of entries) {
		const summary = entry.summary;
		if (summary === undefined) continue;
		if (options.workspace !== undefined && entry.rootWorkspace !== options.workspace) continue;
		const epoch = summary.e;
		const wsTotals = tokstatsZeroTotals();
		let counted = false;

		for (const cell of summary.rows) {
			// E1：epoch 区间内的明细由 epoch 合计代表，这里跳过（不双计）。
			if (epoch !== null && cell.d >= epoch.start && cell.d < epoch.end) continue;
			if (windowStart !== null && cell.d < windowStart) continue;
			const calls = tokstatsNum(cell.calls);
			if (calls <= 0) continue;
			if (!Number.isInteger(cell.b) || cell.b < 0 || cell.b >= buckets.length) continue;
			addCell(wsTotals, buckets[cell.b], cell.d, calls, tokstatsNum(cell.in), tokstatsNum(cell.out), tokstatsNum(cell.cr), tokstatsNum(cell.cw));
			counted = true;
		}
		// epoch 自带按桶合计：用区间末的前一天当日期代表（趋势按周分组需要一天）。
		if (epoch !== null && Array.isArray(epoch.buckets)) {
			const epochDay = tokstatsDayBefore(epoch.end);
			if (windowStart === null || epochDay >= windowStart) {
				for (let i = 0; i < epoch.buckets.length && i < buckets.length; i += 1) {
					const src = epoch.buckets[i];
					if (src === null || src === undefined || typeof src !== "object") continue;
					const calls = tokstatsNum(src.calls);
					if (calls <= 0) continue;
					addCell(wsTotals, buckets[i], epochDay, calls, tokstatsNum(src.in), tokstatsNum(src.out), tokstatsNum(src.cr), tokstatsNum(src.cw));
					counted = true;
				}
			}
		}
		if (counted) workspaces.set(entry.rootWorkspace, wsTotals);
	}

	// 周趋势由桶分布之外的单趟记录得出：addCell 里没有周维度，这里补一遍。
	return {
		buckets,
		weekly: tokstatsWeeklyOf(entries, options, windowStart),
		workspaces: [...workspaces.entries()]
			.map(([path, wsTotals]) => ({ path, calls: wsTotals.calls, in: wsTotals.in, out: wsTotals.out }))
			.sort((a, b) => b.calls - a.calls),
		totals,
		windowStart,
	};
}

/** 周粒度趋势（独立一趟，避免 addCell 背上周维度）。 */
function tokstatsWeeklyOf(entries, options, windowStart) {
	const weeks = new Map();
	const bump = (day, calls, inTokens, outTokens) => {
		const weekStart = tokstatsWeekStartOf(day);
		let week = weeks.get(weekStart);
		if (week === undefined) {
			week = { weekStart, calls: 0, in: 0, out: 0 };
			weeks.set(weekStart, week);
		}
		week.calls += calls;
		week.in += inTokens;
		week.out += outTokens;
	};
	for (const entry of entries) {
		const summary = entry.summary;
		if (summary === undefined) continue;
		if (options.workspace !== undefined && entry.rootWorkspace !== options.workspace) continue;
		const epoch = summary.e;
		for (const cell of summary.rows) {
			if (epoch !== null && cell.d >= epoch.start && cell.d < epoch.end) continue;
			if (windowStart !== null && cell.d < windowStart) continue;
			const calls = tokstatsNum(cell.calls);
			if (calls <= 0) continue;
			bump(cell.d, calls, tokstatsNum(cell.in), tokstatsNum(cell.out));
		}
		if (epoch !== null && Array.isArray(epoch.buckets)) {
			const epochDay = tokstatsDayBefore(epoch.end);
			if (windowStart === null || epochDay >= windowStart) {
				let calls = 0;
				let inTokens = 0;
				let outTokens = 0;
				for (const src of epoch.buckets) {
					if (src === null || src === undefined || typeof src !== "object") continue;
					calls += tokstatsNum(src.calls);
					inTokens += tokstatsNum(src.in);
					outTokens += tokstatsNum(src.out);
				}
				if (calls > 0) bump(epochDay, calls, inTokens, outTokens);
			}
		}
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

/** 零 I/O 读缓存摘要（p0-d：meta 只需 header 的生命周期四字段）。 */
function tokstatsReadCached(cache, header) {
	if (cache === undefined || cache === null || typeof cache.cachedSnapshot !== "function") return undefined;
	const snapshot = cache.cachedSnapshot(header, [TOKSTATS_KEY]);
	if (snapshot === undefined || snapshot === null) return undefined;
	const value = snapshot.values === undefined ? undefined : snapshot.values[TOKSTATS_KEY];
	return tokstatsSummaryOf(value);
}

/**
 * 冷折叠兜底：`readSession` 的全量日志 → `coldSnapshot`（P7/P9）。
 *
 * `readSession` 返回 `{ session, inheritedEventCount, events }`，**不带 seedLength**
 * ——fork 切点就是 `inheritedEventCount`（P9）。
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
	return tokstatsSummaryOf(value);
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
 * @param sessionQuery - `ctx.sessionQuery`（listSessions / readSession）。
 * @param cacheOf - `() => ctx.sessionProjectionCache | undefined`。
 * @param defaultWindowDays - 行 config.windowDays（缺省 90）。
 * @param log - 降级告警出口。
 */
function tokstatsSummaryReader(sessionQuery, cacheOf, defaultWindowDays, log) {
	return async function readSummary(payload) {
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

		const cache = typeof cacheOf === "function" ? cacheOf() : cacheOf;
		const entries = [];
		for (const record of list) {
			const header = record === null || record === undefined ? undefined : record.header;
			if (header === undefined || typeof header.id !== "string") continue;
			const rootWorkspace = tokstatsRootWorkspaceOf(header, headersById);
			// 活会话（`record.live === true`）**跳过缓存**，直接冷读。
			//
			// 依据是官方对 cachedSnapshot 水位的说明：检查点可能滞后于日志，而它的
			// `asOfSeq`「无法与调用方稍后打开的日志关联」，故官方要求调用方让**活
			// 会话产出的值覆盖它**。实测代价是真实的：fork 会话
			// session-99226f96 的检查点停在水位 917（27 次调用），而日志已到 138241
			// （142 次）——采信缓存会少报 80%。
			//
			// 冷读对活会话是内存快照（`sessionQuery.readSession` 优先取 live），
			// 不是磁盘 I/O，所以这条路径不会把面板拖慢。
			//
			// 已结束的会话仍读缓存：那正是该设计的目的（零 I/O 列出历史），代价是
			// 数字可能停在最后一次检查点，由官方在后续 flush 时收敛。
			let summary;
			try {
				summary = record.live === true ? undefined : tokstatsReadCached(cache, header);
				if (summary === undefined) summary = await tokstatsColdRead(cache, sessionQuery, header, log);
			} catch (error) {
				// 单会话失败不拖垮整次汇总（硬规则 6）。
				log(`tokstats: 会话 ${header.id} 摘要读取失败，跳过: ${String(error)}`);
				summary = undefined;
			}
			entries.push({ rootWorkspace, summary });
		}

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
	const log = (...args) => {
		try {
			ctx.logger?.warn(...args);
		} catch {
			/* 降级：logger 缺席时静默 */
		}
	};

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
		const readSummary = tokstatsSummaryReader(pctx.sessionQuery, cacheOf, windowDays, log);
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
	TOKSTATS_KEY,
	TOKSTATS_STATE_VERSION,
	TOKSTATS_BUCKET_BOUNDS,
	TOKSTATS_BUCKET_COUNT,
	TOKSTATS_CHANNEL,
	TOKSTATS_ENDPOINT,
	TOKSTATS_DEFAULT_WINDOW_DAYS,
};

