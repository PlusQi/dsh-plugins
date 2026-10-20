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
			let summary;
			try {
				summary = tokstatsReadCached(cache, header);
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
	// `sessionProjectionCache` 用 `ctx.get` 惰性取而**不进 inject**：inject 是「齐备
	// 才回调」的硬依赖，把它写进去会让缓存缺席时端点也不注册；而本插件要求该情形
	// 下端点仍在、只返回空聚合（I8 / AC-8）。`ctx.get` 是宿主官方的可选服务读取
	// 形式（inspect 的 Service 目录对 sessionQuery 也是这么标的）。
	ctx.inject(["connection", "sessionQuery"], (pctx) => {
		const cacheOf = () => {
			try {
				return pctx.get("sessionProjectionCache");
			} catch {
				return undefined;
			}
		};
		const readSummary = tokstatsSummaryReader(pctx.sessionQuery, cacheOf, windowDays, log);
		// p0-f：`handle(channel, handler)` 只有两参；0.2.1-rc.2 已无 authority 选项。
		pctx.connection.rpc.handle(TOKSTATS_CHANNEL, async (endpoint, payload) => {
			if (endpoint !== TOKSTATS_ENDPOINT) return tokstatsFail("bad-request");
			try {
				return { ok: true, value: await readSummary(payload) };
			} catch (error) {
				// handler 抛异常会被宿主转成整响应 500（客户端拿不到错误码），故全 catch。
				log(`tokstats: 汇总失败: ${String(error)}`);
				return tokstatsFail("model-unavailable");
			}
		});
	});
}

// ── plugin: promptopt（host：RPC 通道 + 旁路 llm 调用） ──────────────────────
//
// composer 草稿的 AI 重写：浏览器点按钮 → 本通道 → 一次旁路模型调用 → 优化文
// 回浏览器，由用户审阅后才写回草稿（浏览器半边见 lib/client.js）。
//
// 契约核验（2026-08-30，@deepseek-ai/dsh@0.1.1-rc.2，详见 TASKS-promptopt.md
// 附记 pot-0b/0c）：
// - 注册走 ctx.connection.rpc.handle（handle 在 rpc 子对象上），options.authority
//   必填。取 'trusted-host' 而不是 'loopback'：信任判定由宿主部署的 trusted
//   hosts 决定（loopback 恒放行 + 清单匹配），收窄到 loopback 会让局域网访问
//   的 web UI 直接 403。
// - handler 签名 (endpoint, payload, signal) => Promise<RpcResult>；request.signal
//   由宿主透传，浏览器 abort fetch 即中止这里的 in-flight 调用。
// - 响应信封的**错误码是闭集**（客户端 serverResponseSchema 用 discriminatedUnion
//   校验），自定义码会导致客户端 parse 抛错；成功分支是 { ok: true, value }，
//   摊平写 { ok: true, text } 会被 zod 的 strip 默认行为吃掉。因此：
//     成功 → { ok: true, value: { text, durationMs, usage? } }
//     失败 → { ok: false, error: { code, message, details } }，code 取自闭集。

const PROMPTOPT_CHANNEL = "/dsh-plugins.promptopt";
const PROMPTOPT_ENDPOINT = "optimize";
const PROMPTOPT_TIMEOUT_MS = 60000;
/** 草稿上限（字符）：超过即拒，避免一次旁路调用吃掉整个上下文窗口。 */
const PROMPTOPT_MAX_DRAFT_CHARS = 65536;

/**
 * 内置 meta-prompt（英文协议常量，不进词典不翻译）。
 * 五条约束：保留原意只增强 / 只返回改写结果 / 输出跟随草稿语言 / 长度不超原文
 * 约 1.5 倍（防递归膨胀）/ 不虚构原文没有的事实。
 */
const PROMPTOPT_META_PROMPT = [
	"Rewrite the draft prompt below so that it is clearer and more effective.",
	"",
	"Rules:",
	"1. Preserve the original intent and only strengthen it: make the goal explicit, add the context a competent reader would be missing, state constraints explicitly, and specify the expected output format.",
	"2. Return ONLY the rewritten prompt. No explanation, no preamble, no wrapping quotes, no code fence.",
	"3. Write the output in the same language as the draft.",
	"4. Keep the output under about 1.5x the length of the original.",
	"5. Do not invent facts, files, paths, or requirements the original does not contain.",
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
		return {
			ok: true,
			value: {
				text: optimized,
				durationMs: Date.now() - startedAt,
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

	// connection 与 llm 都是软依赖：任一缺席则回调永不触发，通道不注册——
	// 浏览器半边表现为点按钮报 error.llm，而不是整包挂掉（硬规则 6）。
	ctx.inject(["connection", "llm"], (pctx) => {
		pctx.connection.rpc.handle(
			PROMPTOPT_CHANNEL,
			async (endpoint, payload, signal) => {
				if (endpoint !== PROMPTOPT_ENDPOINT) return promptoptFail("bad-request", { issues: [] });
				return promptoptOptimize(pctx.llm, payload, signal, timeoutMs);
			},
			{ authority: "trusted-host" },
		);
		log(`promptopt: 已注册 RPC 通道 ${PROMPTOPT_CHANNEL}`);
	});
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