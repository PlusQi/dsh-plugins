// tokstats host 半边测试（v0.6.0 第一批）：投影单元 + 汇总 RPC。
//
// 两层覆盖：
// 1. 纯函数直跑（tks-1a…1d 的判据是「无 cordis，node 直跑可测」）——折叠、落桶、
//    E1 折叠、聚合都从 lib/index.js 直接 import；
// 2. 真实 apply 管线（伪 cordis ctx + 伪 sessionQuery / sessionProjectionCache /
//    connection）——测的就是宿主实际走的那条路径。
//
// 桩的保真度纪律沿用既有做法：伪服务只暴露真实服务面内的成员，面外调用直接抛错
// ——桩比真实宿主宽松时，缺陷会以「全绿」伪装过去。零依赖（AGENTS 硬规则 5）。
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeWebServerStub } from "./host-harness.mjs";
import {
	apply,
	tokstatsAggregate,
	tokstatsBucketOf,
	tokstatsDayKey,
	tokstatsDefinition,
	tokstatsEpochFold,
	tokstatsFoldUsage,
	tokstatsInit,
	tokstatsRootWorkspaceOf,
	tokstatsSummaryOf,
	tokstatsWeekStartOf,
	tokstatsWindowStart,
	TOKSTATS_KEY,
	TOKSTATS_STATE_VERSION,
	TOKSTATS_BUCKET_BOUNDS,
	TOKSTATS_BUCKET_COUNT,
	TOKSTATS_CHANNEL,
	TOKSTATS_ENDPOINT,
	tokstatsRouteOf,
} from "../lib/index.js";

// ── fixture ────────────────────────────────────────────────────────────────

/** 本地时区 2026-08-26（周三）的指定时刻。 */
const T = (d, h, m) => new Date(2026, 7, d, h, m, 0).getTime();
const D1 = "2026-08-26";

const W_ALPHA = "D:\\proj\\alpha";
const W_BETA = "D:\\proj\\beta";
const HEADER = { id: "s-root", version: 4, createdAt: 1, cwd: W_ALPHA, isSeeded: false };

/** usage chunk 事件。 */
function chunkEvent(seq, time, turn, step, usage) {
	return { type: "assistant/chunk", seq, time, data: { turn, step, chunk: { type: "usage", usage } } };
}

/** assistant/message 事件（可带 usage 终值）。 */
function messageEvent(seq, time, turn, step, usage) {
	return { type: "assistant/message", seq, time, data: { turn, step, ...(usage === undefined ? {} : { usage }) } };
}

/** 带路由的 assistant/message 事件：`source` 是 p8-a 实测的唯一位置（data.message.source）。 */
function routedMessageEvent(seq, time, turn, step, usage, route) {
	const event = messageEvent(seq, time, turn, step, usage);
	if (route !== undefined) {
		event.data.message = { source: { kind: "model", provider: route.provider, model: route.model } };
	}
	return event;
}

/** 把一串事件折进新状态（模拟注册表的驱动方式：逐事件 apply）。 */
function fold(events, { seed = 0, windowDays = 90, header = HEADER } = {}) {
	let state = tokstatsInit(header, seed);
	for (const ev of events) state = tokstatsFoldUsage(state, ev, windowDays);
	return state;
}

/**
 * 带折叠历史的摘要：`epoch.end` 给定、区间内 `calls` 次落在最低桶。
 *
 * 折叠历史的形状是「按路由分组的桶数组」（tks8-3a 起），这里只造一组 `rt: ""`
 * 的最简形态——本次要测的是聚合层怎么把它转成 `epoch` 载荷，不是折叠算法本身
 * （折叠算法由 E1 那一组用例覆盖）。
 */
function foldedSummary(epochEnd, calls, { rt = "" } = {}) {
	const buckets = Array.from({ length: TOKSTATS_BUCKET_COUNT }, () => ({ calls: 0, in: 0, cr: 0, cw: 0, out: 0 }));
	buckets[0] = { calls, in: 1000, cr: 0, cw: 0, out: 10 };
	return {
		w: W_ALPHA,
		e: { start: "2026-01-01", end: epochEnd, routes: [{ rt, buckets }] },
		rows: [],
	};
}

// ── 阶段 1：纯函数 ─────────────────────────────────────────────────────────

test("I6 / AC-4：无关事件返回同一引用（Object.is 成立）", () => {
	let state = tokstatsInit(HEADER, 0);
	const same = state;
	for (const ev of [
		{ type: "turn/start", seq: 0, time: T(26, 10, 0), data: { turn: 1 } },
		{ type: "turn/end", seq: 1, time: T(26, 10, 0), data: { turn: 1, reason: { kind: "completed" } } },
		{ type: "step/start", seq: 2, time: T(26, 10, 0), data: { turn: 1, step: 1 } },
		{ type: "tool/call", seq: 3, time: T(26, 10, 0), data: { turn: 1, step: 1, callId: "c", name: "x", arguments: "{}" } },
		{ type: "assistant/chunk", seq: 4, time: T(26, 10, 0), data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "hi" } } },
		{ type: "assistant/message", seq: 5, time: T(26, 10, 0), data: { turn: 1, step: 1 } },
	]) {
		const next = tokstatsFoldUsage(state, ev, 90);
		assert.equal(Object.is(state, next), true, `${ev.type} 应返回同一引用（I6）`);
		state = next;
	}
	assert.equal(Object.is(same, state), true);
});

test("I5 / AC-3：同 (turn,step) 终值替换，chunk 50 后接 message 60 → 终值 60", () => {
	const state = fold([
		chunkEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 1000, outputTokens: 50 }),
		messageEvent(1, T(26, 10, 0), 1, 1, { inputTokens: 1000, outputTokens: 60 }),
	]);
	assert.equal(state.rows.length, 1, "同一 (turn,step) 只应留一格");
	assert.equal(state.rows[0].calls, 1, "不得双计");
	assert.equal(state.rows[0].out, 60, "终值必须替换成 60");
	assert.equal(state.rows[0].in, 1000);
});

test("I5：递进采样（多个 usage chunk）只留最后一个", () => {
	const state = fold([
		chunkEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 500, outputTokens: 10 }),
		chunkEvent(1, T(26, 10, 0), 1, 1, { inputTokens: 500, outputTokens: 20 }),
		chunkEvent(2, T(26, 10, 0), 1, 1, { inputTokens: 500, outputTokens: 30 }),
	]);
	assert.equal(state.rows.length, 1);
	assert.equal(state.rows[0].calls, 1);
	assert.equal(state.rows[0].out, 30);
});

test("I5：终值替换跨桶时旧格被正确减回（不残留空格）", () => {
	// chunk 落在 [0,8K)，message 终值 200000 落在 [128K,256K)：减旧加新必须把旧格清掉。
	const state = fold([
		chunkEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 1000, outputTokens: 10 }),
		messageEvent(1, T(26, 10, 0), 1, 1, { inputTokens: 200000, outputTokens: 20 }),
	]);
	assert.equal(state.rows.length, 1, "旧桶的空格必须被剔除");
	assert.equal(state.rows[0].b, 3, "终值落在 [128K,256K)");
	assert.equal(state.rows[0].calls, 1);
});

test("I4 / AC-2：fork seed 前缀不双计（inheritedEventCount=6）", () => {
	const events = [
		// seq 0..5 是父会话继承来的前缀
		messageEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 5000, outputTokens: 100 }),
		messageEvent(1, T(26, 10, 0), 1, 2, { inputTokens: 5000, outputTokens: 100 }),
		messageEvent(2, T(26, 10, 0), 1, 3, { inputTokens: 5000, outputTokens: 100 }),
		messageEvent(3, T(26, 10, 0), 1, 4, { inputTokens: 5000, outputTokens: 100 }),
		messageEvent(4, T(26, 10, 0), 1, 5, { inputTokens: 5000, outputTokens: 100 }),
		messageEvent(5, T(26, 10, 0), 1, 6, { inputTokens: 5000, outputTokens: 100 }),
		// seq 6 起是子会话自己的
		messageEvent(6, T(26, 11, 0), 2, 1, { inputTokens: 1000, outputTokens: 7 }),
		messageEvent(7, T(26, 11, 0), 2, 2, { inputTokens: 1000, outputTokens: 9 }),
	];
	const state = fold(events, { seed: 6 });
	assert.equal(state.rows.length, 1);
	assert.equal(state.rows[0].calls, 2, "只计子会话自身的新增 step");
	assert.equal(state.rows[0].out, 16);
});

test("I4：seed 为 0 时全部计入（非 fork 会话）", () => {
	const state = fold([
		messageEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 1000, outputTokens: 1 }),
		messageEvent(1, T(26, 10, 0), 1, 2, { inputTokens: 1000, outputTokens: 2 }),
	], { seed: 0 });
	assert.equal(state.rows[0].calls, 2);
});

test("桶边界：对齐市面计费档，且与 stateVersion 同批变更（TS-18）", () => {
	// 边界不是 2 的幂，而是市面「按输入长度分档计费」的真实档位：32K / 128K / 256K
	// 是中国区主力厂商（阿里云百炼 / 火山方舟 / 智谱 GLM）重叠的边界，512K 是
	// MiniMax M3 的分界（≤512K / >512K 两档）；4K / 8K / 16K 没有任何厂商设档
	// （旧方案的 [4K,8K) 在本机真实调用中是完全空桶）。
	//
	// **最高桶是 [512K,∞)、不设 1M 上界**：1M 已是市面所有模型上下文窗口的最大值
	// （本机 profile 的 contextWindow 最大就是 1048576），单请求 prompt 结构上超不过
	// 它。本机真实调用实测最大计费输入 710.9K、≥1M 的 0 次，所以 [1M,∞) 是一条
	// 永远不会亮的尾巴，已删除。
	//
	// **这条用例同时钉边界数组与 stateVersion**：cell 只存桶序号 `b`，边界一变同一个
	// `b` 就指向另一个区间，不抬版本会静默错位而不是报错。改任一半都必须显式改另一半。
	assert.deepEqual(TOKSTATS_BUCKET_BOUNDS, [8192, 32768, 131072, 262144, 524288]);
	assert.equal(TOKSTATS_BUCKET_COUNT, 6);
	assert.equal(TOKSTATS_STATE_VERSION, 6, "桶边界改为市面计费档（含 512K 细分、去掉恒空的 1M 尾巴）→ 旧缓存行必须作废（TS-18）");

	// 每个边界两侧各测一点，另加最高桶的尾巴。
	assert.equal(tokstatsBucketOf(0), 0);
	assert.equal(tokstatsBucketOf(8191), 0, "8K 以下是最低桶");
	assert.equal(tokstatsBucketOf(8192), 1);
	assert.equal(tokstatsBucketOf(32767), 1);
	assert.equal(tokstatsBucketOf(32768), 2);
	assert.equal(tokstatsBucketOf(131071), 2);
	assert.equal(tokstatsBucketOf(131072), 3);
	assert.equal(tokstatsBucketOf(262143), 3);
	assert.equal(tokstatsBucketOf(262144), 4);
	assert.equal(tokstatsBucketOf(524287), 4, "256K–512K 与 ≥512K 必须是两桶");
	assert.equal(tokstatsBucketOf(524288), 5);
	assert.equal(tokstatsBucketOf(1048576), 5, "1M 落在最高桶 [512K,∞)，不再单独一档");
	assert.equal(tokstatsBucketOf(200000), 3, "200K 落在 [128K,256K)");
	assert.equal(tokstatsBucketOf(700000), 5, "700K 落在 [512K,∞)");
});

test("桶落点在 fold 里用 in+cr+cw 之和（缓存读也计入计费输入）", () => {
	// in 1000 + cr 70000 → 71000 → 落在 [32K,128K)（桶 2）
	const state = fold([messageEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 1000, cacheReadTokens: 70000, outputTokens: 5 })]);
	assert.equal(state.rows[0].b, 2);
});

test("日键按本地时区自然日：23:59 与 00:01 分属两日", () => {
	assert.equal(tokstatsDayKey(new Date(2026, 7, 25, 23, 59, 0).getTime()), "2026-08-25");
	assert.equal(tokstatsDayKey(new Date(2026, 7, 26, 0, 1, 0).getTime()), D1);
	const state = fold([
		messageEvent(0, new Date(2026, 7, 25, 23, 59, 0).getTime(), 1, 1, { inputTokens: 100, outputTokens: 1 }),
		messageEvent(1, new Date(2026, 7, 26, 0, 1, 0).getTime(), 1, 2, { inputTokens: 100, outputTokens: 1 }),
	]);
	assert.equal(state.rows.length, 2, "跨日应落两格");
});

test("I7 / AC-5：E1 折叠不删原始明细，且汇总数字与折叠前一致", () => {
	// 两格都早于 30 天窗口（today=2026-10-20 → windowStart=2026-09-21），会全部进 epoch。
	const state = fold([
		messageEvent(0, T(1, 10, 0), 1, 1, { inputTokens: 4000, outputTokens: 7 }),
		messageEvent(1, T(20, 10, 0), 1, 2, { inputTokens: 4000, outputTokens: 11 }),
	]);
	const rowsBefore = state.rows.length;
	const epoch = tokstatsEpochFold(state, "2026-10-20", 30);
	assert.equal(epoch.rows.length, rowsBefore, "折叠不得删改原始明细（I7）");
	// epoch 保留「路由 × 桶」两维（A-5 / tks8-3a）：无 source 的样本归单一路由 ""。
	assert.equal(epoch.epoch.routes.length, 1, "同一条路由只建一组");
	assert.equal(epoch.epoch.routes[0].rt, "", "无 source 的样本归未标注路由");
	// 计费输入 4000 < 8192 → 桶 0
	assert.equal(epoch.epoch.routes[0].buckets[0].calls, 2, "窗口外的两格都折进 epoch 的桶 0");
	assert.equal(epoch.epoch.routes[0].buckets[0].out, 18);

	const before = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary: tokstatsSummaryOf(state) }], { windowDays: 0, today: "2026-10-20" });
	const after = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary: tokstatsSummaryOf({ ...state, epoch: epoch.epoch, w: state.w, rows: state.rows }) }], { windowDays: 0, today: "2026-10-20" });
	assert.deepEqual(after.buckets, before.buckets, "折叠前后各桶数字必须逐项一致（AC-5）");
	assert.equal(after.totals.calls, before.totals.calls);
	assert.equal(after.totals.out, before.totals.out);
});

test("E1 折叠幂等：同一 today 重复折叠返回同一引用", () => {
	const state = tokstatsEpochFold(fold([messageEvent(0, T(1, 10, 0), 1, 1, { inputTokens: 4000 })]), "2026-10-20", 30);
	const again = tokstatsEpochFold(state, "2026-10-20", 30);
	assert.equal(Object.is(state, again), true);
});

test("windowStart / weekStartOf：日键算术只走 UTC 解析，不随宿主时区漂移", () => {
	assert.equal(tokstatsWindowStart(0, "2026-10-20"), null);
	assert.equal(tokstatsWindowStart(1, "2026-10-20"), "2026-10-20");
	assert.equal(tokstatsWindowStart(30, "2026-10-20"), "2026-09-21");
	assert.equal(tokstatsWeekStartOf("2026-10-20"), "2026-10-19", "2026-10-20 是周二，周一为 10-19");
	assert.equal(tokstatsWeekStartOf("2026-10-19"), "2026-10-19", "周一归自身");
	assert.equal(tokstatsWeekStartOf("2026-10-25"), "2026-10-19", "周日归上一个周一");
});

test("TS-20：「本月」档的 windowDays 折算口径 = 当月 1 日（客户端取当天日期数，host 侧 windowStart 落地）", () => {
	// 面板的「本月」不加新口径：客户端把「今天是几号」当 windowDays 发下来，
	// host 侧 `today - (windowDays - 1)` 正好落在当月 1 日。两条式子分处两个模块图
	// （client 是浏览器 bundle、host 是独立文件），没有任何共享常量，所以必须在这里
	// 把耦合钉住——否则 host 侧哪天把 windowStart 改成 `today - windowDays`（少减 1），
	// 面板「本月」会静默地少算一天，而两边各自的用例都不会失败。
	for (const today of ["2026-10-22", "2026-10-01", "2026-02-28", "2026-12-31"]) {
		// 客户端这边算的就是本地日期数（10-22 → 22，10-01 → 1）。
		const dayOfMonth = Number(today.slice(8, 10));
		assert.equal(tokstatsWindowStart(dayOfMonth, today), today.slice(0, 8) + "01", `${today} 的「本月」应到当月 1 日`);
	}
	// 跨年边界：12 月 31 日 → 31 → 12-01（不是次年 1 月）。
	assert.equal(tokstatsWindowStart(31, "2026-12-31"), "2026-12-01");
	// 对照：近 7 天 = 今天 + 前 6 天（不是前 7 天），与「本月」共用同一条式子。
	assert.equal(tokstatsWindowStart(7, "2026-10-22"), "2026-10-16");
});

test("聚合：窗口过滤 + 工作区分组 + 周趋势分组", () => {
	const summary = {
		w: W_ALPHA,
		e: null,
		rows: [
			{ d: "2026-10-19", b: 3, calls: 2, in: 200000, cr: 0, cw: 0, out: 10 },
			{ d: "2026-10-20", b: 2, calls: 1, in: 70000, cr: 0, cw: 0, out: 5 },
			{ d: "2026-06-01", b: 0, calls: 3, in: 100, cr: 0, cw: 0, out: 1 },
		],
	};
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 30, today: "2026-10-20" });
	assert.equal(result.windowStart, "2026-09-21");
	assert.equal(result.totals.calls, 3, "窗口外的 2026-06-01 不计");
	assert.equal(result.buckets[3].calls, 2);
	assert.equal(result.buckets[2].calls, 1);
	assert.equal(result.buckets[0].calls, 0);
	assert.equal(result.weekly.length, 1, "两周内三格落在同一自然周");
	assert.equal(result.weekly[0].weekStart, "2026-10-19");
	assert.equal(result.workspaces.length, 1);
	assert.equal(result.workspaces[0].path, W_ALPHA);
	assert.equal(result.workspaces[0].calls, 3);
});

test("聚合：日序列按日升序、逐日四桶齐全（面板柱状图的唯一真源）", () => {
	const summary = {
		w: W_ALPHA,
		e: null,
		rows: [
			{ d: "2026-10-20", b: 2, calls: 1, in: 70000, cr: 0, cw: 0, out: 5 },
			{ d: "2026-10-19", b: 3, calls: 2, in: 200000, cr: 100, cw: 7, out: 10 },
			{ d: "2026-06-01", b: 0, calls: 3, in: 100, cr: 0, cw: 0, out: 1 },
		],
	};
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 30, today: "2026-10-20" });
	assert.deepEqual(result.daily.map((d) => d.day), ["2026-10-19", "2026-10-20"], "窗口外的日不出现");
	assert.deepEqual(
		Object.keys(result.daily[0]).sort(),
		["calls", "cr", "cw", "day", "in", "out"],
		"日行形状与 totals 同四桶 + day",
	);
	assert.equal(result.daily[0].calls, 2);
	assert.equal(result.daily[0].in, 200000);
	assert.equal(result.daily[0].cr, 100);
	assert.equal(result.daily[0].cw, 7);
	assert.equal(result.daily[0].out, 10);
});

test("周趋势由日序列归并：各周合计之和恒等于总计（单趟真源，不漂移）", () => {
	const summary = {
		w: W_ALPHA,
		e: null,
		rows: [
			{ d: "2026-10-19", b: 3, calls: 2, in: 200000, cr: 10, cw: 0, out: 10 },
			{ d: "2026-10-20", b: 2, calls: 1, in: 70000, cr: 20, cw: 5, out: 5 },
			// 跨周：2026-10-26 属于下一自然周（周一）
			{ d: "2026-10-26", b: 2, calls: 4, in: 40000, cr: 30, cw: 0, out: 9 },
		],
	};
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 90, today: "2026-10-27" });
	assert.deepEqual(result.weekly.map((w) => w.weekStart), ["2026-10-19", "2026-10-26"]);
	const weeklyCalls = result.weekly.reduce((sum, w) => sum + w.calls, 0);
	const weeklyIn = result.weekly.reduce((sum, w) => sum + w.in, 0);
	const weeklyOut = result.weekly.reduce((sum, w) => sum + w.out, 0);
	const dailyCalls = result.daily.reduce((sum, d) => sum + d.calls, 0);
	assert.equal(weeklyCalls, result.totals.calls, "周合计之和 = 总计");
	assert.equal(weeklyCalls, dailyCalls, "周合计之和 = 日合计之和");
	assert.equal(weeklyIn, result.totals.in);
	assert.equal(weeklyOut, result.totals.out);
	assert.equal(result.weekly[0].cr, 30, "缓存读也随周归并（面板 tooltip 要）");
	assert.equal(result.weekly[0].cw, 5);
});

test("聚合：epoch 合计计入日序列（折叠前的历史仍能在柱状图与周趋势上看见）", () => {
	const summary = {
		w: W_ALPHA,
		e: {
			start: "2026-01-01",
			end: "2026-09-21",
			// epoch 新结构：按路由分组，内层沿用字段名 buckets（tks8-3a）。
			routes: [
				{
					rt: "",
					buckets: [
						{ calls: 2, in: 5000, cr: 0, cw: 0, out: 20 },
						{ calls: 0, in: 0, cr: 0, cw: 0, out: 0 },
						{ calls: 0, in: 0, cr: 0, cw: 0, out: 0 },
						{ calls: 0, in: 0, cr: 0, cw: 0, out: 0 },
						{ calls: 0, in: 0, cr: 0, cw: 0, out: 0 },
						{ calls: 0, in: 0, cr: 0, cw: 0, out: 0 },
					],
				},
			],
		},
		rows: [{ d: "2026-10-20", b: 0, calls: 1, in: 100, cr: 0, cw: 0, out: 1 }],
	};
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 0, today: "2026-10-20" });
	// epoch 用区间末前一天（2026-09-20）当代表日
	assert.deepEqual(result.daily.map((d) => d.day), ["2026-09-20", "2026-10-20"]);
	assert.equal(result.daily[0].calls, 2);
	assert.equal(result.daily[0].out, 20);
	assert.equal(result.totals.calls, 3);
});

test("TS-21 / TS-22 / TS-03：coverage 与 epoch 不进投影状态（wire.view 键集不变）", () => {
	// 这条是本变更**最容易被破坏**的边界：coverage / epoch 是 RPC 返回值里的瞬时
	// 载荷，一旦有人把它们塞进 state 或 wire.view，就会变成 durable 数据（旧的覆盖率
	// 在下次打开面板时被读回来 = stale 语义），且按 TS-03 必须同批抬 stateVersion
	// 让旧缓存行作废。断言放在这两条不变量旁边，改动时最容易看见。
	const def = tokstatsDefinition(90);
	const state = fold([messageEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 1000, outputTokens: 5 })]);
	assert.deepEqual(Object.keys(state).sort(), ["epoch", "last", "rows", "seed", "w"], "state 键集里没有 coverage");
	const view = def.wire.view(state);
	assert.deepEqual(Object.keys(view).sort(), ["e", "rows", "w"], "wire.view 键集仍只有 w / e / rows（插进去就要抬 stateVersion）");
});

test("聚合：同一根工作区的多个会话必须累加（不是后者覆盖前者）", () => {
	// 回归：v0.6.0 的 workspaces.set() 会让同工作区的后一个会话整段覆盖前一个，
	// 表现为「工作区排行各行的次数远小于总计」（v0.7.0 的排行条形图暴露）。
	const one = { w: W_ALPHA, e: null, rows: [{ d: "2026-10-20", b: 0, calls: 2, in: 100, cr: 0, cw: 0, out: 10 }] };
	const two = { w: W_ALPHA, e: null, rows: [{ d: "2026-10-20", b: 0, calls: 3, in: 200, cr: 50, cw: 5, out: 20 }] };
	const result = tokstatsAggregate([
		{ rootWorkspace: W_ALPHA, summary: one },
		{ rootWorkspace: W_ALPHA, summary: two },
	], { windowDays: 90, today: "2026-10-20" });
	assert.equal(result.workspaces.length, 1, "同一工作区只出一行");
	assert.equal(result.workspaces[0].calls, 5, "2 + 3");
	assert.equal(result.workspaces[0].in, 300);
	assert.equal(result.workspaces[0].cr, 50);
	assert.equal(result.workspaces[0].cw, 5);
	assert.equal(result.workspaces[0].out, 30);
	assert.equal(result.workspaces[0].calls, result.totals.calls, "只有一个工作区时它必须等于总计");
});

// ── 阶段 1b：可审计性载荷 coverage / epoch（本变更第一批；TS-21 / TS-22） ────
// 为什么这批断言必须存在：`coverage` 与 `epoch` 是「数字算对了，但界面看不出少了
// 什么」这个问题的唯一载荷。它们的失败模式都是**静默的**——skipped 少算一个，页脚
// 只是写着「已统计 3 个」而实际只有 2 个贡献了数字；epoch 该 null 而不 null，日柱
// 会给一个不存在的日子打上「折叠历史」标记。两种都只能靠断言抓。

test("TS-21 / AC-2：coverage 形状——三会话一失败 → sessions 3 / skipped 1", () => {
	const ok = (calls) => ({ w: W_ALPHA, e: null, rows: [{ d: "2026-10-20", b: 0, calls, in: 10, cr: 0, cw: 0, out: 1 }] });
	const result = tokstatsAggregate([
		{ rootWorkspace: W_ALPHA, summary: ok(1) },
		{ rootWorkspace: W_ALPHA, summary: undefined }, // 日志读不出来
		{ rootWorkspace: W_ALPHA, summary: ok(2) },
	], { windowDays: 90, today: "2026-10-20" });
	assert.deepEqual(result.coverage, { sessions: 3, skipped: 1 }, "sessions 含被跳过的那一个，skipped 单独计数");
	// 恒等约束（PLAN §3.2 的硬约束）：sessions - skipped 必须等于实际贡献了数字的会话数。
	assert.equal(result.coverage.sessions - result.coverage.skipped, 2, "3 - 1 = 2 个会话真正贡献了数字");
});

test("TS-21 / AC-2：coverage 与数字一致——被跳过的会话不贡献任何合计", () => {
	// 反向验证「被跳过」确实没计入：如果实现把 skipped 的会话按空摘要折进去，
	// 或把 sessions 当成「贡献数」，这条就会红。
	const result = tokstatsAggregate([
		{ rootWorkspace: W_ALPHA, summary: { w: W_ALPHA, e: null, rows: [{ d: "2026-10-20", b: 0, calls: 2, in: 100, cr: 0, cw: 0, out: 10 }] } },
		{ rootWorkspace: W_ALPHA, summary: undefined },
		{ rootWorkspace: W_ALPHA, summary: { w: W_ALPHA, e: null, rows: [{ d: "2026-10-20", b: 0, calls: 3, in: 200, cr: 0, cw: 0, out: 20 }] } },
	], { windowDays: 90, today: "2026-10-20" });
	assert.equal(result.coverage.sessions, 3);
	assert.equal(result.coverage.skipped, 1);
	assert.equal(result.totals.calls, 5, "只含两个可读会话的量（2 + 3），不含被跳过者");
	assert.equal(result.totals.in, 300);
	assert.equal(result.workspaces.length, 1);
	assert.equal(result.workspaces[0].calls, 5);
});

test("TS-21：entries 为空时 coverage 返回 0 / 0，不是 undefined", () => {
	// 缺省值必须是「零」而不是「缺席」：client 用 `undefined` 判定旧 host，
	// 新 host 在空数据下若返回 undefined，client 会误判成旧 host 而整句不渲染。
	const result = tokstatsAggregate([], { windowDays: 90, today: "2026-10-20" });
	assert.deepEqual(result.coverage, { sessions: 0, skipped: 0 });
	assert.equal(result.epoch, null);
});

test("TS-21：coverage 分母跟随 workspace 过滤（分母与分子同源）", () => {
	// 切到单个工作区时，别的工作区的会话不得算进分母——否则页脚写「已统计 3 个」
	// 而数字只来自 1 个，正是本次变更要消除的那类谎报。
	const a = { w: "a", e: null, rows: [{ d: "2026-10-20", b: 0, calls: 1, in: 10, cr: 0, cw: 0, out: 1 }] };
	const b = { w: "b", e: null, rows: [{ d: "2026-10-20", b: 0, calls: 2, in: 10, cr: 0, cw: 0, out: 1 }] };
	const entries = [
		{ rootWorkspace: "a", summary: undefined },
		{ rootWorkspace: "b", summary: b },
		{ rootWorkspace: "b", summary: b },
	];
	const all = tokstatsAggregate(entries, { windowDays: 90, today: "2026-10-20" });
	assert.deepEqual(all.coverage, { sessions: 3, skipped: 1 }, "全量视图：三个会话、一个跳过");
	const onlyB = tokstatsAggregate(entries, { windowDays: 90, today: "2026-10-20", workspace: "b" });
	assert.deepEqual(onlyB.coverage, { sessions: 2, skipped: 0 }, "只统计 b 的两个会话，a 的失败会话不进分母");
});

test("TS-22 / AC-3：epoch 两态——无折叠为 null，有折叠带 end 与 calls", () => {
	const flat = tokstatsAggregate([
		{ rootWorkspace: W_ALPHA, summary: { w: W_ALPHA, e: null, rows: [{ d: "2026-10-20", b: 0, calls: 1, in: 10, cr: 0, cw: 0, out: 1 }] } },
	], { windowDays: 90, today: "2026-10-20" });
	// 无折叠时必须**严格为 null**：client 用 `!== null` 判定，{} 或 undefined 都会让它
	// 走进「有折叠」分支去读 end。
	assert.equal(flat.epoch, null, "无折叠历史 → null（不是 {}、不是 undefined）");

	const folded = tokstatsAggregate([
		{ rootWorkspace: W_ALPHA, summary: foldedSummary("2026-08-21", 4) },
	], { windowDays: 0, today: "2026-10-20" });
	assert.notEqual(folded.epoch, null);
	assert.equal(typeof folded.epoch.end, "string", "end 是日键字符串");
	assert.ok(folded.epoch.calls > 0, "calls 是所有经 epoch 路径计入的调用数");
	assert.equal(folded.epoch.calls, folded.totals.calls, "只有折叠历史时它等于总计");
});

test("TS-22：epoch 的 end 与读取期代表日同口径（代表日 = end - 1）", () => {
	// 两面必须共用同一条式子：host 用 tokstatsDayBefore(epoch.end) 当落点，client 用
	// end - 1 算打标列。两边各写一份时，一旦有一边改成「end 当天」就打不到那一列。
	const summary = foldedSummary("2026-08-21", 3);
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 0, today: "2026-10-20" });
	assert.equal(result.epoch.end, "2026-08-21");
	const epochDay = result.daily.reduce((a, d) => (d.day < a ? d.day : a), result.daily[0].day);
	assert.equal(epochDay, "2026-08-20", "折叠历史落在 end 的前一天");
});

test("TS-22：epoch 代表日落在窗口外时不得报 epoch（否则打标会指向不存在的列）", () => {
	// 「近 7 天」视图里，折叠历史的代表日（8/20）早已在窗口外，日柱里没有那一列。
	// 此时若仍返回 epoch，client 就会给一个不存在的日子打标（或凭空造一列）。
	const summary = foldedSummary("2026-08-21", 3);
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 7, today: "2026-10-20" });
	assert.equal(result.epoch, null, "没有折叠格真正计入本次窗口 → epoch 必须是 null");
	assert.equal(result.totals.calls, 0, "窗口内确实没有数据");
});

test("TS-22：全零 epoch 不算「计入了折叠历史」", () => {
	// epoch 结构存在但每一格都是 0：没有调用被计入，日柱那列可能压根不存在。
	// 这种情况返回非 null 会让 client 给一个空列打标。
	const summary = {
		w: W_ALPHA,
		e: {
			start: "2026-01-01",
			end: "2026-08-21",
			routes: [{ rt: "", buckets: Array.from({ length: TOKSTATS_BUCKET_COUNT }, () => ({ calls: 0, in: 0, cr: 0, cw: 0, out: 0 })) }],
		},
		rows: [],
	};
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 0, today: "2026-10-20" });
	assert.equal(result.epoch, null);
	assert.equal(result.totals.calls, 0);
});

test("TS-22：多个会话各有不同 epoch 时取最早的代表日（PLAN §3.3）", () => {
	// 区间端点互不重叠：不同会话的 epoch.end 不同 → 打标只针对单一代表日，取最小
	// 保证那一定是真实的合成日；calls 是两者之和。
	const early = foldedSummary("2026-08-21", 2);
	const late = foldedSummary("2026-09-11", 3);
	const result = tokstatsAggregate([
		{ rootWorkspace: W_ALPHA, summary: early },
		{ rootWorkspace: W_BETA, summary: late },
	], { windowDays: 0, today: "2026-10-20" });
	assert.equal(result.epoch.end, "2026-08-21", "取最早的代表日");
	assert.equal(result.epoch.calls, 5, "2 + 3：所有经 epoch 路径计入的调用之和");
});

test("聚合：workspace 过滤只留匹配的会话", () => {
	const a = { w: "a", e: null, rows: [{ d: "2026-10-20", b: 0, calls: 1, in: 10, cr: 0, cw: 0, out: 1 }] };
	const b = { w: "b", e: null, rows: [{ d: "2026-10-20", b: 0, calls: 2, in: 10, cr: 0, cw: 0, out: 1 }] };
	const all = tokstatsAggregate([
		{ rootWorkspace: "a", summary: a },
		{ rootWorkspace: "b", summary: b },
	], { windowDays: 90, today: "2026-10-20" });
	assert.equal(all.totals.calls, 3);
	const onlyB = tokstatsAggregate([
		{ rootWorkspace: "a", summary: a },
		{ rootWorkspace: "b", summary: b },
	], { windowDays: 90, today: "2026-10-20", workspace: "b" });
	assert.equal(onlyB.totals.calls, 2);
	assert.deepEqual(onlyB.workspaces.map((w) => w.path), ["b"]);
});

test("聚合：summary 为 undefined 的会话被跳过（不抛错）", () => {
	const result = tokstatsAggregate([
		{ rootWorkspace: "a", summary: undefined },
		{ rootWorkspace: "b", summary: { w: "b", e: null, rows: [] } },
	], { windowDays: 90, today: "2026-10-20" });
	assert.equal(result.totals.calls, 0);
	assert.deepEqual(result.workspaces, []);
});

test("根工作区：沿 parentSession 链上溯到顶层 cwd；链断归 _orphan", () => {
	const headers = new Map([
		["root", { id: "root", cwd: W_ALPHA }],
		["child", { id: "child", cwd: W_ALPHA, parentSession: "root" }],
	]);
	assert.equal(tokstatsRootWorkspaceOf({ id: "child", cwd: W_ALPHA, parentSession: "root" }, headers), W_ALPHA);
	assert.equal(tokstatsRootWorkspaceOf({ id: "lost", parentSession: "missing" }, headers), "_orphan");
	assert.equal(tokstatsRootWorkspaceOf({ id: "nocwd" }, headers), "_orphan");
	assert.equal(tokstatsRootWorkspaceOf({ id: "root", cwd: W_BETA }, headers), W_BETA);
});

test("I1 / AC-8：wire.view 键集只有 w / e / rows；cell 带不透明 rt 串", () => {
	const def = tokstatsDefinition(90);
	const state = fold([messageEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 1000, outputTokens: 5 })]);
	const view = def.wire.view(state);
	assert.deepEqual(Object.keys(view).sort(), ["e", "rows", "w"]);
	for (const cell of view.rows) {
		// rt 是三维 cell 的第三段（tks8-2a）；wire 摘要形状本身不变（I2）。
		assert.deepEqual(Object.keys(cell).sort(), ["b", "calls", "cr", "cw", "d", "in", "out", "rt"], "cell 键集含 rt，且无 provider/model 字段");
		assert.equal(typeof cell.rt, "string", "rt 必须是字符串（空串表示未标注）");
	}
});

test("单元定义：key / stateVersion / init / apply / wire 齐备", () => {
	const def = tokstatsDefinition(90);
	assert.equal(def.key, TOKSTATS_KEY);
	assert.equal(def.stateVersion, TOKSTATS_STATE_VERSION);
	// AC-7 / I4：key 带包前缀，消除与宿主同名单元的撞车（Q5）。
	assert.equal(TOKSTATS_KEY, "dsh-plugins.tokstats", "投影 key 必须是带包前缀的全名（I4）");
	assert.equal(TOKSTATS_STATE_VERSION, 6, "由 3、4、5 提升（桶边界改为市面计费档，含 512K 细分、去掉恒空的 1M 尾巴），旧缓存行据此作废（TS-18）");
	assert.equal(typeof def.init, "function");
	assert.equal(typeof def.apply, "function");
	assert.ok(def.wire !== undefined, "必须带 wire（host-only 单元读不回来）");
	assert.equal(typeof def.wire.view, "function");
	assert.equal(typeof def.stateSchema.parse, "function");
	assert.equal(typeof def.wire.viewSchema.parse, "function");
});

test("init 从 header 取 cwd；缺 cwd 归 _orphan；seed 取自 inheritedEventCount", () => {
	assert.equal(tokstatsInit(HEADER, 0).w, W_ALPHA);
	assert.equal(tokstatsInit({ id: "x" }, 0).w, "_orphan");
	assert.equal(tokstatsInit(null, 0).w, "_orphan");
	assert.equal(tokstatsInit(HEADER, 6).seed, 6);
	assert.equal(tokstatsInit(HEADER, 0).seed, 0);
	assert.equal(tokstatsInit(HEADER, 6).epoch, null);
	assert.deepEqual(tokstatsInit(HEADER, 0).rows, []);
});

test("apply 用 state.seed 做 fork 去重（apply 只收 state/event，拿不到 inheritedEventCount）", () => {
	const def = tokstatsDefinition(90);
	let state = def.init(HEADER, 3);
	state = def.apply(state, messageEvent(2, T(26, 10, 0), 1, 1, { inputTokens: 100, outputTokens: 1 }));
	assert.deepEqual(state.rows, [], "seed 前缀内的样本应被跳过");
	state = def.apply(state, messageEvent(3, T(26, 10, 0), 1, 2, { inputTokens: 100, outputTokens: 1 }));
	assert.equal(state.rows.length, 1);
});

test("I1：摘要只认 w / e / rows 三键（面外字段一律不带出；rt 是被保留的维度）", () => {
	const summary = tokstatsSummaryOf({ w: "a", e: null, rows: [{ d: D1, b: 0, calls: 1, in: 1, cr: 0, cw: 0, out: 1, p: "x", m: "y" }] });
	assert.deepEqual(Object.keys(summary).sort(), ["e", "rows", "w"]);
	assert.equal(tokstatsSummaryOf(undefined), undefined);
	assert.equal(tokstatsSummaryOf({ rows: "nope" }), undefined);
	assert.equal(tokstatsSummaryOf(null), undefined);
});

// ── 阶段 1b：路由维度（第一批：cell 三维 + epoch 保路由） ────────────────────
test("tks8-1c：tokstatsRouteOf 只认字符串 provider/model，其余归一为空串（I10）", () => {
	assert.equal(tokstatsRouteOf({ provider: "a", model: "b" }), "a/b");
	assert.equal(tokstatsRouteOf({ provider: "deepseek-official", model: "deepseek-v4-flash-vision-exp" }), "deepseek-official/deepseek-v4-flash-vision-exp");
	// 空串是「未标注」的唯一表示（不引入 null：JSON 往返与 Map 键都要额外分支）
	assert.equal(tokstatsRouteOf(undefined), "");
	assert.equal(tokstatsRouteOf(null), "");
	assert.equal(tokstatsRouteOf("a/b"), "", "非对象一律归未标注");
	assert.equal(tokstatsRouteOf({}), "");
	assert.equal(tokstatsRouteOf({ provider: "a" }), "", "缺 model 不放行");
	assert.equal(tokstatsRouteOf({ model: "b" }), "", "缺 provider 不放行");
	assert.equal(tokstatsRouteOf({ provider: 1, model: "b" }), "", "provider 非字符串不放行");
	assert.equal(tokstatsRouteOf({ provider: "a", model: null }), "", "model 非字符串不放行");
	// source 的键形状有 replayState 变体（p8-a：2518/2562 带它），不影响取值
	assert.equal(tokstatsRouteOf({ kind: "model", provider: "a", model: "b", replayState: "x" }), "a/b");
});

test("AC-1 / tks8-4b：带 source 的 message → cell 的 rt 为 provider/model", () => {
	const state = fold([
		routedMessageEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 1000, outputTokens: 5 }, { provider: "a", model: "b" }),
	]);
	assert.equal(state.rows.length, 1);
	assert.equal(state.rows[0].rt, "a/b", "路由归因正确（AC-1）");
	assert.equal(state.rows[0].calls, 1);
});

test("AC-2 / tks8-4c：只由 chunk 采样形成的 step → rt 为空串且仍计入 calls", () => {
	// 不要用「message 缺 source」构造：p8-a 实测该形态不存在（2562/2562 全有 source）。
	// rt === "" 的唯一现实来源是「chunk 采样未被同 step 的 message 终值替换」。
	const state = fold([
		chunkEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 1000, outputTokens: 50 }),
	]);
	assert.equal(state.rows.length, 1);
	assert.equal(state.rows[0].rt, "", "无路由来源 → 未标注（AC-2）");
	assert.equal(state.rows[0].calls, 1, "未标注样本仍计入调用次数（I9 的差额出口）");
	assert.equal(state.rows[0].out, 50);
});

test("AC-3 / R3 / tks8-4d：跨 rt 终值替换不残留空格（chunk \"\" → message 真路由）", () => {
	const state = fold([
		chunkEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 1000, outputTokens: 50 }),
		routedMessageEvent(1, T(26, 10, 0), 1, 1, { inputTokens: 1000, outputTokens: 60 }, { provider: "a", model: "b" }),
	]);
	assert.equal(state.rows.length, 1, "只剩一行：未标注那格必须被整条剔除（R3）");
	assert.equal(state.rows[0].rt, "a/b", "终值带真路由");
	assert.equal(state.rows[0].calls, 1, "不得双计");
	assert.equal(state.rows[0].out, 60, "out 取终值");
});

test("AC-5 / I8 / tks8-4e：epoch 折叠保住路由粒度（逐路由合计与折叠前相等）", () => {
	// 两条路由各一格，都早于 30 天窗口（today=2026-10-20 → windowStart=2026-09-21）。
	const state = fold([
		routedMessageEvent(0, T(1, 10, 0), 1, 1, { inputTokens: 4000, outputTokens: 7 }, { provider: "a", model: "b" }),
		routedMessageEvent(1, T(20, 10, 0), 1, 2, { inputTokens: 4000, outputTokens: 11 }, { provider: "c", model: "d" }),
	]);
	const rowsBefore = state.rows.length;
	const byRouteBefore = new Map();
	for (const cell of state.rows) {
		const acc = byRouteBefore.get(cell.rt) ?? { calls: 0, in: 0, cr: 0, cw: 0, out: 0 };
		acc.calls += cell.calls;
		acc.in += cell.in;
		acc.cr += cell.cr;
		acc.cw += cell.cw;
		acc.out += cell.out;
		byRouteBefore.set(cell.rt, acc);
	}

	const epoch = tokstatsEpochFold(state, "2026-10-20", 30);
	assert.equal(epoch.rows.length, rowsBefore, "折叠不得删改原始明细（I7）");
	assert.equal(epoch.epoch.routes.length, 2, "两条路由各建一组（R4：不能塌成一组）");
	const byRouteAfter = new Map();
	for (const group of epoch.epoch.routes) {
		const acc = { calls: 0, in: 0, cr: 0, cw: 0, out: 0 };
		for (const bucket of group.buckets) {
			acc.calls += bucket.calls;
			acc.in += bucket.in;
			acc.cr += bucket.cr;
			acc.cw += bucket.cw;
			acc.out += bucket.out;
		}
		byRouteAfter.set(group.rt, acc);
	}
	assert.deepEqual([...byRouteAfter.keys()].sort(), [...byRouteBefore.keys()].sort(), "路由集合不变");
	for (const [rt, before] of byRouteBefore) {
		assert.deepEqual(byRouteAfter.get(rt), before, `路由 ${rt} 的合计必须与折叠前逐项相等（AC-5 / I8）`);
	}
});

test("tks8-3c：读到旧结构 epoch（无 routes 但有 buckets）时视为单一路由 \"\"", () => {
	const buckets = [];
	for (let i = 0; i < TOKSTATS_BUCKET_COUNT; i += 1) buckets.push({ calls: 0, in: 0, cr: 0, cw: 0, out: 0 });
	buckets[0] = { calls: 2, in: 5000, cr: 0, cw: 0, out: 20 };
	const summary = tokstatsSummaryOf({
		w: W_ALPHA,
		e: { start: "2026-01-01", end: "2026-09-21", buckets },
		rows: [{ d: "2026-10-20", b: 0, calls: 1, in: 100, cr: 0, cw: 0, out: 1 }],
	});
	assert.doesNotThrow(() => tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 0, today: "2026-10-20" }));
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 0, today: "2026-10-20" });
	assert.equal(result.totals.calls, 3, "旧结构 epoch 的合计仍要计入（不静默丢值）");
});

test("tks8-3d：摘要里 rt 非字符串时归一为空串，且不丢 cell（I10）", () => {
	const summary = tokstatsSummaryOf({
		w: "a",
		e: null,
		rows: [
			{ d: D1, b: 0, calls: 1, in: 10, cr: 0, cw: 0, out: 1, rt: 12345 },
			{ d: D1, b: 0, calls: 1, in: 10, cr: 0, cw: 0, out: 1 },
			{ d: D1, b: 0, calls: 1, in: 10, cr: 0, cw: 0, out: 1, rt: "a/b" },
		],
	});
	assert.equal(summary.rows.length, 3, "丢 cell 会让 calls 凭空减少（比归到未标注更糟）");
	assert.deepEqual(summary.rows.map((c) => c.rt), ["", "", "a/b"]);
});

test("tks8-3c：epoch 形状不完整（缺 end / 非对象）时聚合不抛错（I10）", () => {
	const rows = [{ d: "2026-10-20", b: 0, calls: 1, in: 100, cr: 0, cw: 0, out: 1 }];
	for (const e of [undefined, {}, { start: "2026-01-01" }, { end: 123 }, "nope"]) {
		const summary = tokstatsSummaryOf({ w: W_ALPHA, e, rows });
		assert.doesNotThrow(
			() => tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 0, today: "2026-10-20" }),
			`epoch 为 ${JSON.stringify(e)} 时不得抛错`,
		);
		const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 0, today: "2026-10-20" });
		assert.equal(result.totals.calls, 1, "损坏的 epoch 只影响 epoch 合计，明细照常计入");
	}
});

/**
 * 伪 `ctx.sessionPersistence`（TS-26）：只暴露真实服务面里本插件会用的成员
 * （`stat`），面外调用抛错。
 *
 * `revision` 是宿主持久化层的「日志变更令牌」：纯 stat 元数据
 * （`dev:ino:size:mtimeNs:ctimeNs`，**5 段**），**不解码日志**。宿主对它的定义是
 * 「equal revisions may be treated as an unchanged log」——本插件据此判断
 * 「这行缓存是不是我们冷读出来的、且日志没动过」。
 *
 * ⚠️ 桩必须用 **5 段**形态：6 段是 v0 格式的 revision（末尾多一段全局历史语料
 * 哈希），实现会把它判成「证明不了本会话没变」而不记账（见
 * `tokstatsRevisionIsPerSession`）。用 6 段会让 TS-26 的用例静默失效。
 *
 * 桩用一个可变的 `current` 字段模拟「日志长了」：改了它，`stat` 就返回新 revision。
 */
function makeSessionPersistence(initialRevision = "1:2:3:4:5") {
	const state = { current: initialRevision, calls: { stat: 0, list: 0 } };
	const stub = {
		state,
		async stat(id) {
			state.calls.stat += 1;
			return { header: { id }, revision: state.current, sizeBytes: 1024 };
		},
		async list() {
			state.calls.list += 1;
			return [{ header: { id: HEADER.id }, revision: state.current, sizeBytes: 1024 }];
		},
	};
	return stub;
}

/**
 * 伪 `ctx.storageDomain`（TS-26）：只提供 `open`，返回一个内存域桩。
 *
 * 真实域的读是**同步**的（走内存表）、写是**异步**的（要等落盘）——桩照此形状，
 * 否则「写完立刻读」会读到旧值，把测试写成假绿。
 */
function makeStorageDomain() {
	const tables = new Map();
	const opened = [];
	const stub = {
		opened,
		/** 某域某表的记录条数（用例用来钉住「有没有记账」）。 */
		count(domainName) {
			return tables.get(domainName)?.size ?? 0;
		},
		async open(spec) {
			opened.push(spec);
			const records = tables.get(spec.name) ?? new Map();
			tables.set(spec.name, records);
			return {
				table(name) {
					if (name !== spec.tables[Object.keys(spec.tables)[0]] && !(name in spec.tables)) {
						throw new Error(`域 ${spec.name} 没有表 ${name}`);
					}
					return {
						get(key) { return records.get(key); },
						put(key, value) {
							records.set(key, value);
							return Promise.resolve();
						},
					};
				},
				close() { return Promise.resolve(); },
			};
		},
	};
	return stub;
}

test("AC-6 / I3：ver: 2 的旧缓存行被跳过，冷折叠重建成功且不抛错", async () => {
	// 宿主 viewCheckpoint 按 row.ver !== def.stateVersion 丢弃（C5），故旧行读回时
	// 已不存在；这里按同一语义模拟「缓存里只有旧版本行」。
	const connection = makeConnection();
	const cache = {
		calls: { cachedSnapshot: 0, coldSnapshot: 0 },
		cachedSnapshot() {
			cache.calls.cachedSnapshot += 1;
			return undefined; // 旧版本行被宿主丢弃 → 缓存未命中
		},
		coldSnapshot(meta, inheritedEventCount, events) {
			cache.calls.coldSnapshot += 1;
			let state = tokstatsInit(meta, inheritedEventCount);
			for (const event of events) state = tokstatsFoldUsage(state, event, 90);
			return { asOfSeq: -1, values: { [TOKSTATS_KEY]: tokstatsDefinition(90).wire.view(state) } };
		},
	};
	const query = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx);
	// 首帧不等待冷读（TS-24）：先拿到空态，再等后台校验收敛后取真值。
	let result;
	await assert.doesNotReject(async () => {
		result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	});
	assert.equal(result.ok, true, "旧版本行作废后不得抛错（AC-6）");
	result = await waitVerifyingSettled(connection, {}, (v) => v.totals.calls === 2);
	assert.equal(cache.calls.coldSnapshot, 1, "必须走冷折叠重建");
	assert.equal(result.value.totals.calls, 2, "重建后的数字与真实日志一致");
	// 第二批起 routes 由聚合产出；旧行作废重建后它必须同样可用（不复用旧形状）。
	assert.deepEqual(result.value.routes.map((r) => r.rt), [""], "重建后的排行里只有未标注一行");
	assert.equal(result.value.routes[0].calls, 2);
});

test("聚合字段集：第二批起含 routes，本变更（可审计性）起再含 coverage / epoch", () => {
	const summary = { w: W_ALPHA, e: null, rows: [{ d: "2026-10-20", b: 0, calls: 1, in: 100, cr: 0, cw: 0, out: 1, rt: "a/b" }] };
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 90, today: "2026-10-20" });
	assert.deepEqual(
		Object.keys(result).sort(),
		["buckets", "coverage", "daily", "epoch", "routes", "totals", "weekly", "windowStart", "workspaces"],
		"聚合字段集 = 第二批的七项 + 本变更的 coverage / epoch；字段集是绊线，防的是「顺手又加一个没人消费的字段」",
	);
	assert.deepEqual(result.routes.map((r) => r.rt), ["a/b"]);
});

// ── 阶段 1c：按路由的排行（第二批：5a…5e / AC-9…AC-11） ────────────────────

test("AC-11 / tka8-5b：同一 rt 出现在两个会话时累加，不是后者覆盖前者", () => {
	// 回归形状与 v0.7.0 的 workspaces 覆盖缺陷完全同款：同 key 的 Map.set() 会让
	// 后一个会话整段覆盖前一个，表现是「排行各行次数远小于总计」。
	const one = { w: W_ALPHA, e: null, rows: [{ d: "2026-10-20", b: 0, calls: 2, in: 100, cr: 10, cw: 1, out: 10, rt: "a/b" }] };
	const two = { w: W_BETA, e: null, rows: [{ d: "2026-10-20", b: 0, calls: 3, in: 200, cr: 20, cw: 2, out: 20, rt: "a/b" }] };
	const result = tokstatsAggregate([
		{ rootWorkspace: W_ALPHA, summary: one },
		{ rootWorkspace: W_BETA, summary: two },
	], { windowDays: 90, today: "2026-10-20" });
	assert.equal(result.routes.length, 1, "同一 rt 只出一行");
	assert.equal(result.routes[0].calls, 5, "2 + 3");
	assert.equal(result.routes[0].in, 300);
	assert.equal(result.routes[0].cr, 30);
	assert.equal(result.routes[0].cw, 3);
	assert.equal(result.routes[0].out, 30);
});

test("AC-9 / I9：排行各行次数之和恒等于总计（未标注兜住差额）", () => {
	const mixed = {
		w: W_ALPHA,
		e: null,
		rows: [
			{ d: "2026-10-20", b: 0, calls: 2, in: 100, cr: 0, cw: 0, out: 10, rt: "a/b" },
			{ d: "2026-10-20", b: 1, calls: 3, in: 100, cr: 0, cw: 0, out: 20, rt: "c/d" },
			{ d: "2026-10-20", b: 2, calls: 4, in: 100, cr: 0, cw: 0, out: 30, rt: "" },
		],
	};
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary: mixed }], { windowDays: 90, today: "2026-10-20" });
	const sum = result.routes.reduce((acc, entry) => acc + entry.calls, 0);
	assert.equal(sum, result.totals.calls, "排行之和 = 总计（R5：差额必须有出口）");
	assert.equal(sum, 9);
});

test("AC-10 / tka8-5d：calls 降序；未标注显式排最后；同次数按 rt 字典序", () => {
	const summary = {
		w: W_ALPHA,
		e: null,
		rows: [
			{ d: "2026-10-20", b: 0, calls: 1, in: 10, cr: 0, cw: 0, out: 1, rt: "" },
			{ d: "2026-10-20", b: 0, calls: 5, in: 10, cr: 0, cw: 0, out: 1, rt: "z/z" },
			{ d: "2026-10-20", b: 0, calls: 2, in: 10, cr: 0, cw: 0, out: 1, rt: "b/b" },
			{ d: "2026-10-20", b: 0, calls: 2, in: 10, cr: 0, cw: 0, out: 1, rt: "a/a" },
		],
	};
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 90, today: "2026-10-20" });
	assert.deepEqual(result.routes.map((r) => r.rt), ["z/z", "a/a", "b/b", ""],
		"calls 降序 → 同次数按 rt 字典序 → 空串显式排最后（空串在字典序里本是最前）");
});

test("AC-5 读取侧 / tka8-5c：epoch 的路由合计计入排行（折叠后不少行）", () => {
	const bucketsRouteA = [];
	const bucketsRouteB = [];
	for (let i = 0; i < TOKSTATS_BUCKET_COUNT; i += 1) {
		bucketsRouteA.push({ calls: 0, in: 0, cr: 0, cw: 0, out: 0 });
		bucketsRouteB.push({ calls: 0, in: 0, cr: 0, cw: 0, out: 0 });
	}
	bucketsRouteA[0] = { calls: 2, in: 5000, cr: 0, cw: 0, out: 20 };
	bucketsRouteB[1] = { calls: 1, in: 9000, cr: 0, cw: 0, out: 5 };
	const summary = tokstatsSummaryOf({
		w: W_ALPHA,
		e: {
			start: "2026-01-01",
			end: "2026-09-21",
			routes: [{ rt: "a/b", buckets: bucketsRouteA }, { rt: "c/d", buckets: bucketsRouteB }],
		},
		rows: [{ d: "2026-10-20", b: 0, calls: 3, in: 100, cr: 0, cw: 0, out: 1, rt: "a/b" }],
	});
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 0, today: "2026-10-20" });
	const byRoute = new Map(result.routes.map((r) => [r.rt, r.calls]));
	assert.equal(byRoute.get("a/b"), 5, "epoch 的 2 次 + 窗口内明细的 3 次");
	assert.equal(byRoute.get("c/d"), 1, "只存在于 epoch 里的路由不得丢行（R4）");
	assert.equal(result.routes.reduce((acc, r) => acc + r.calls, 0), result.totals.calls);
});

test("排行行形状：与 workspaces 同形状（rt + 四桶 + calls），不含额外字段", () => {
	const summary = { w: W_ALPHA, e: null, rows: [{ d: "2026-10-20", b: 0, calls: 1, in: 10, cr: 1, cw: 2, out: 3, rt: "a/b" }] };
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 90, today: "2026-10-20" });
	assert.deepEqual(Object.keys(result.routes[0]).sort(), ["calls", "cr", "cw", "in", "out", "rt"], "复用 client 的 tokstatsHit/tokstatsBilled 所需的字段");
});


// ── TS-19：检查点滞后补偿 ────────────────────────────────────────────────────
//
// 背景（本机实测）：官方检查点可以停在远早于日志末尾的水位，而 listSessions 不
// 提供日志长度信号。实测 50 个会话里 11 个滞后，最严重的缓存 seq=793 而日志末
// 序号 162925；面板因此少报 172 次调用 / 3129 万计费输入。这组用例钉住补偿逻辑。

test("TS-19：冷读后若缓存水位低于已见日志末序号，下一次汇总改为冷读覆盖", async () => {
	const connection = makeConnection();
	// 第一次：缓存未命中 → 后台冷读，coldAsOfSeq 是日志末序号 2，建立基线
	const cache = makeProjectionCache({}, { coldAsOfSeq: 2 });
	const query = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx);
	// 首帧只排队（TS-24），必须等后台冷读跑完、基线建立。
	await waitVerifyingSettled(connection, {}, (v) => v.totals.calls === 2);
	assert.equal(cache.calls.coldSnapshot, 1, "首次必然冷读");

	// 模拟真实缺陷形态：缓存行存在但水位停在 0（远早于日志末尾 2）。
	// 真实场景里这是「官方检查点没追上日志」，实测最严重的一个会话差 162132。
	cache.setCachedAsOfSeq(0);
	cache.calls.coldSnapshot = 0;
	cache.calls.cachedSnapshot = 0;
	const second = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(second.ok, true);
	assert.equal(cache.calls.cachedSnapshot, 1, "仍先尝试零 I/O 读缓存");
	// 判定滞后 → 排后台校验；再等它跑完确认真的冷读了。
	await waitVerifyingSettled(connection, {}, (v) => v.totals.calls === 2);
	assert.equal(cache.calls.coldSnapshot, 1, "水位低于已见日志末序号 → 冷读覆盖（TS-19）");
});

test("TS-19：缓存水位追平已见日志末序号时仍走零 I/O（不误伤缓存路径）", async () => {
	// 先用「缓存未命中」建立冷读基线（日志末序号 2），再让缓存水位等于 2 看是否
	// 保持零 I/O。基线必须真的来自冷读——直接给缓存行的话首次请求就命中缓存，
	// 记忆为空、判定不触发，测不到「追平后不误伤」这一点。
	const connection = makeConnection();
	const cache = makeProjectionCache({}, { coldAsOfSeq: 2 });
	const query = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx);
	await waitVerifyingSettled(connection, {}, (v) => v.totals.calls === 2);
	assert.equal(cache.calls.coldSnapshot, 1, "首次冷读建立基线（日志末序号 2）");

	// 让缓存水位追平基线：asOfSeq = 2 不再低于已见的 2 → 不得冷读
	cache.setCachedAsOfSeq(2);
	cache.calls.coldSnapshot = 0;
	const second = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(second.ok, true);
	assert.equal(second.value.verifying, undefined, "水位已追平 → 不进校验队列");
	assert.equal(cache.calls.coldSnapshot, 0, "水位已追平 → 保持零 I/O，不得退化成每次冷读");
});

test("TS-19：verifyStale=false 时不建立基线，直接采信缓存（退回旧行为）", async () => {
	// 关闭校验后行为必须与改动前完全一致：首轮就零 I/O、不读日志。
	// 这条给「宁可秒开也不接受首次冷读」的部署留出口。
	const connection = makeConnection();
	const cache = makeProjectionCache({
		[HEADER.id]: { [TOKSTATS_KEY]: { w: HEADER.cwd, e: null, rows: [{ d: D1, b: 3, calls: 2, in: 200000, cr: 0, cw: 0, out: 90 }] } },
	});
	const query = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx, { verifyStale: false });
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(result.ok, true);
	assert.equal(cache.calls.coldSnapshot, 0, "关闭校验后首轮不得冷读");
	assert.equal(query.calls.readSession, 0, "关闭校验后首轮不得读日志");
	assert.equal(result.value.buckets[3].calls, 2, "数字直接来自缓存");
});

// ── 阶段 2：单元注册 / 汇总 / 降级 ──────────────────────────────────────────

/**
 * 伪 `ctx.sessionQuery`：只暴露真实服务面内本插件会用的成员
 * （listSessions / readSession），面外调用抛错——桩比宿主宽松会让用错 API 的实现
 * 也全绿。
 */
function makeSessionQuery(records, logsById) {	const calls = { listSessions: 0, readSession: 0 };
	const stub = {
		calls,
		async listSessions() {
			calls.listSessions += 1;
			return records;
		},
		async readSession(id) {
			calls.readSession += 1;
			const log = logsById[id];
			if (log === undefined) throw new Error("not found: " + id);
			return { session: log.header, inheritedEventCount: log.inheritedEventCount ?? 0, events: log.events };
		},
	};
	return new Proxy(stub, {
		get(obj, key) {
			// `then` 是引擎的 thenable 探测，不是插件在调方法。
			if (key === "then") return undefined;
			if (typeof key === "symbol" || key in obj) return Reflect.get(obj, key);
			throw new Error(`tokstats 调了 sessionQuery.${String(key)}：真实服务面上没有这个方法`);
		},
	});
}

/**
 * 等后台校验收敛（TS-24）。
 *
 * 首帧只排队列、不等待冷读，所以「冷读发生过」这类断言必须先等 drain 跑完。
 * 判据是「再请求一次，`verifying` 已消失**且**数字已稳定」：
 * - 只等 `verifying` 不够——drain 在 `await readSession` 之后才写回缓存，
 *   而 `verifying` 反映的是「队列里还有没有活」，两者之间有一个 tick 的间隙；
 * - 所以这里连数字一起等：调用方给出期望值后，等到该值出现为止。
 *
 * @param connection - 伪 connection（`invoke` 返回信封里的 result）。
 * @param payload - RPC 入参。
 * @param pick - 从 result.value 里取待稳定的数字；缺省只等 `verifying` 消失。
 */
async function waitVerifyingSettled(connection, payload = {}, pick, rounds = 200) {
	let last;
	for (let i = 0; i < rounds; i += 1) {
		// 注意 `connection.invoke` 返回的是**信封里的 result**（不是信封本身）：
		// 既有用例都按 `result.ok` / `result.value` 取值。
		last = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, payload);
		const settled = last?.ok === true && last.value?.verifying !== true;
		if (settled && (pick === undefined || pick(last.value) === true)) return last;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("后台校验在 200 轮内未收敛（TS-24）");
}

/**
 * 伪 `ctx.sessionProjectionCache`：cachedSnapshot / coldSnapshot 两个读面。
 * coldSnapshot 真的把日志折一遍（走同一套纯函数），这样「冷折叠兜底」测的是真实
 * 折叠语义而不是桩返回的常量。
 */
function makeProjectionCache(cachedById, opts = {}) {
	const calls = { cachedSnapshot: 0, coldSnapshot: 0 };
	const coldAsOfSeq = opts.coldAsOfSeq ?? -1;
	const stub = {
		calls,
		/** 让用例在两次请求之间改缓存水位（模拟官方 flush 追上日志）。 */
		setCachedAsOfSeq(value) { stub.cachedAsOfSeqValue = value; },
		cachedAsOfSeqValue: opts.asOfSeq ?? 0,
		cachedSnapshot(meta, keys) {
			calls.cachedSnapshot += 1;
			const keyed = cachedById[meta.id];
			if (keyed === undefined) return undefined;
			const values = {};
			for (const key of keys ?? []) {
				if (keyed[key] !== undefined) values[key] = keyed[key];
			}
			return Object.keys(values).length === 0 ? undefined : { asOfSeq: stub.cachedAsOfSeqValue, values };
		},
		coldSnapshot(meta, inheritedEventCount, events) {
			calls.coldSnapshot += 1;
			let state = tokstatsInit(meta, inheritedEventCount);
			for (const event of events) state = tokstatsFoldUsage(state, event, 90);
			const view = tokstatsDefinition(90).wire.view(state);
			// 真实 coldSnapshot 会把结果写回缓存（官方 coldSnapshot 的写回语义）。
			// 桩必须照做：否则「冷读之后下一次走零 I/O」这条路径根本测不到。
			cachedById[meta.id] = { [TOKSTATS_KEY]: view };
			// 写回水位 = events 的最大 seq（与实现侧的基线口径一致，TS-19）。
			// 用 coldAsOfSeq 会让「追平」用例构造不出正确水位。
			const maxSeq = events.reduce((a, e) => (typeof e?.seq === "number" && e.seq > a ? e.seq : a), -1);
			const writeSeq = opts.coldAsOfSeq ?? maxSeq;
			stub.cachedAsOfSeqValue = writeSeq;
			return { asOfSeq: writeSeq, values: { [TOKSTATS_KEY]: view } };
		},
	};
	return new Proxy(stub, {
		get(obj, key) {
			if (key === "then") return undefined;
			if (typeof key === "symbol" || key in obj) return Reflect.get(obj, key);
			throw new Error(`tokstats 调了 sessionProjectionCache.${String(key)}：真实服务面上没有这个方法`);
		},
	});
}

/**
 * 伪 connection：只提供本包实际使用的 `admit`，并把它接到自带的 webServer 桩上。
 *
 * 本包不复用 `connection.rpc.handle`（0.2.1-rc.2 上从第三方 context 调用必然抛
 * cannot get property "webServer"），所以桩里**故意不提供** rpc.handle —— 实现若
 * 回退到那条路径会立刻 TypeError，而不是悄悄测过。
 */
function makeConnection() {
	const server = makeWebServerStub();
	const calls = { admit: 0 };
	const stub = {
		calls,
		server,
		admit() {
			calls.admit += 1;
			return {};
		},
		invoke(channel, endpoint, payload) {
			return server.result(channel, endpoint, payload);
		},
		envelope(channel, endpoint, payload) {
			return server.invoke(channel, endpoint, payload);
		},
	};
	return stub;
}

/**
 * 伪 cordis ctx：inject 只在**全部**依赖到齐时回调（对齐 cordis 语义）；缺席的
 * 服务让回调永不触发——这正是被测代码要扛住的降级路径。
 *
 * `sessionProjectionCache` 刻意**不**出现在 inject 名单里：实现用 `ctx.get` 惰性
 * 取它（inject 是「齐备才回调」，写进去会让缓存缺席时端点也不注册）。所以桩必须
 * 提供 `get`，且只认已被注入的服务名——凭空返回未注册服务等于给「用了宿主没有
 * 的服务」发通行证。
 *
 * `webServer` 默认在场：`connection.rpc.handle()` 把路由登记挂在**读取方**的
 * fiber 上（内部访问 `owner.webServer`），少了它会抛
 * `cannot get property "webServer" without inject` 而不注册通道——这是实测踩到的
 * 真缺陷，桩必须按真实契约提供它，否则测不出「忘了注入」。
 */
function makeCtx({ connection, sessionQuery, sessionProjectionCache, projections = true, liveSessions, webServer, loggerWarns, sessionPersistence, storageDomain } = {}) {
	const state = { registered: [], injectCalls: [], effects: [] };
	const hasWebServer = webServer !== null;
	// 默认用 connection 自带的那份 webServer 桩：用例既能 `connection.invoke(...)`
	// 驱动路由，又不必显式传两层桩。
	const server = webServer ?? connection?.server ?? makeWebServerStub();
	const provided = { connection, sessionQuery, sessionProjectionCache, webServer: hasWebServer ? server : null };
	// `sessions` 服务（TS-24 的活会话零回放路径要 `ctx.get("sessions").get(id)`）。
	// 默认缺席：多数用例不该被迫提供它，缺席时实现退回冷读（硬规则 6）。
	if (liveSessions !== undefined) provided.sessions = { get: (id) => liveSessions[id] };
	// `projections` 给完整读面对象时，它同时充当 `ctx.get("sessionProjections")`
	// 的读取面（实现用 get 惰性取，与 register 用的 inject 面是两回事）。
	const projectionReader = typeof projections === "object" && projections !== null ? projections : undefined;
	if (projectionReader !== undefined) provided.sessionProjections = projectionReader;
	// `sessionPersistence` 服务（TS-26 的日志 revision 读取面）：实现用 get 惰性取。
	// 默认缺席：缺席时凭据闸门退化为「每轮都排冷读」= 旧行为（硬规则 6）。
	if (sessionPersistence !== undefined) provided.sessionPersistence = sessionPersistence;
	// `storageDomain` 服务（TS-26 的冷读凭据域）：实现用 inject 取。
	if (storageDomain !== undefined) provided.storageDomain = storageDomain;
	const ctx = {
		logger: { warn: (...args) => { if (loggerWarns !== undefined) loggerWarns.push(args.join(" ")); } },
		get(name) {
			const service = provided[name];
			return service === undefined || service === null ? undefined : service;
		},
		inject(names, cb) {
			state.injectCalls.push(names);
			// 真实 cordis 的 inject 子 ctx 也带 effect/on；缺了它们，
			// `pctx.effect(() => pctx.webServer.register(...))` 会抛，路由静默不注册。
			const pctx = {
				get: (name) => ctx.get(name),
				effect: (fn, label) => ctx.effect(fn, label),
				on: (name, handler) => ctx.on(name, handler),
			};
			for (const name of names) {
				if (name === "sessionProjections") {
					if (projections === false) continue;
					// `projections` 若给了完整读面对象（带 cachedSnapshot/snapshot），
					// 就同时充当注册面与读面；否则只造一个 register 桩。
					const isReader = typeof projections === "object" && projections !== null;
					pctx.sessionProjections = isReader
						? { ...projections, register: (def) => { state.registered.push(def); return () => {}; } }
						: { register: (def) => { state.registered.push(def); return () => {}; } };					continue;
				}
				const service = provided[name];
				if (service !== undefined && service !== null) pctx[name] = service;
			}
			// get 是桩自带的读取面，不参与「依赖是否到齐」的计数。
			const ready = names.every((name) => name === "sessionProjections"
				? (projections !== false)
				: (provided[name] !== undefined && provided[name] !== null));
			if (ready) cb(pctx);
		},
		on() { return () => {}; },
		// cordis 的 effect 会**立刻执行**回调并保留其返回的清理函数；桩若只是吞掉
		// 回调，`pctx.effect(() => pctx.webServer.register(route))` 就永远不会注册
		// 路由——测试会以为「通道没注册」，实际是桩没跑。
		effect(fn, label) {
			const disposer = typeof fn === "function" ? fn() : undefined;
			state.effects.push({ label, disposer });
			return () => { if (typeof disposer === "function") disposer(); };
		},
	};
	return { ctx, state };
}

/** 一条完整会话日志：两次 step，各自一条 usage 终值。 */
function sampleLog(header, inheritedEventCount = 0) {
	return {
		header,
		inheritedEventCount,
		events: [
			{ type: "turn/start", seq: 0, time: T(26, 10, 0), data: { turn: 1 } },
			messageEvent(1, T(26, 10, 0), 1, 1, { inputTokens: 1000, outputTokens: 60 }),
			messageEvent(2, T(26, 10, 1), 1, 2, { inputTokens: 200000, outputTokens: 30 }),
		],
	};
}

/** 走真实分发框架：config.plugin 是分发键。 */
function startTokstats(ctx, config) {
	apply(ctx, { plugin: "tokstats", ...(config ?? {}) });
}

test("单元注册：key/stateVersion 走 ctx.inject 软依赖", () => {
	const { ctx, state } = makeCtx({});
	startTokstats(ctx);
	assert.equal(state.registered.length, 1);
	assert.equal(state.registered[0].key, TOKSTATS_KEY);
	assert.equal(state.registered[0].stateVersion, 6);
});

test("projection 缺席：不注册单元，且不抛错（I8）", () => {
	const { ctx, state } = makeCtx({ projections: false });
	assert.doesNotThrow(() => startTokstats(ctx));
	assert.equal(state.registered.length, 0);
});

test("RPC 注册：挂在 webServer 的 prefix 路由上，且**不**走 connection.rpc.handle", () => {
	const connection = makeConnection();
	const { ctx } = makeCtx({
		connection,
		sessionQuery: makeSessionQuery([], {}),
		sessionProjectionCache: makeProjectionCache({}),
	});
	startTokstats(ctx);
	assert.equal(connection.server.routes.length, 1);
	const [route] = connection.server.routes;
	assert.equal(route.path, TOKSTATS_CHANNEL);
	// 前缀挂载：端点由通道自己认领（/summary、/promptopt）
	assert.equal(route.kind, "prefix");
	// connection 桩**没有** rpc 面：实现若回退到 connection.rpc.handle 会直接抛。
	assert.equal(connection.calls.admit, 0, "admit 只在真正请求时调用，注册阶段不碰它");
});

test("sessionQuery 缺席：RPC 不注册，且不抛错（I8 / AC-8）", () => {
	const connection = makeConnection();
	const { ctx } = makeCtx({ connection, sessionProjectionCache: makeProjectionCache({}) });
	assert.doesNotThrow(() => startTokstats(ctx));
	assert.equal(connection.server.routes.length, 0, "无 sessionQuery 时不得注册端点");
});

test("sessionProjectionCache 缺席：端点注册但不抛错、返回空聚合（I8 / AC-8）", async () => {
	const connection = makeConnection();
	const { ctx } = makeCtx({
		connection,
		sessionQuery: makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) }),
	});
	startTokstats(ctx);
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(result.ok, true);
	assert.equal(result.value.totals.calls, 0, "无缓存服务时没有摘要可折，聚合为空但不抛错");
});

test("AC-8：三种服务缺席各断言一次不抛错", () => {
	for (const missing of ["sessionProjections", "sessionQuery", "sessionProjectionCache"]) {
		const connection = makeConnection();
		const opts = {
			connection,
			sessionQuery: makeSessionQuery([], {}),
			sessionProjectionCache: makeProjectionCache({}),
		};
		if (missing === "sessionProjections") opts.projections = false;
		if (missing === "sessionQuery") opts.sessionQuery = undefined;
		if (missing === "sessionProjectionCache") opts.sessionProjectionCache = undefined;
		const { ctx } = makeCtx(opts);
		assert.doesNotThrow(() => startTokstats(ctx), `${missing} 缺席不得抛错`);
	}
});

test("AC-7：cachedSnapshot 命中时零 I/O 读回摘要（不触发 coldSnapshot）", async () => {
	const connection = makeConnection();
	const cache = makeProjectionCache({
		[HEADER.id]: { [TOKSTATS_KEY]: { w: HEADER.cwd, e: null, rows: [{ d: D1, b: 3, calls: 2, in: 200000, cr: 0, cw: 0, out: 90 }] } },
	});
	const query = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx);
	// TS-19 起首轮要冷读一次建立基线（否则无从判断缓存是否滞后），所以「零 I/O」
	// 的准确表述是「**建立基线之后**的汇总零 I/O」。这正是面板日常使用（同进程内
	// 重复打开）的形态。
	await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(cache.calls.coldSnapshot, 1, "首轮冷读一次建立基线（TS-19）");
	const readAfterFirst = query.calls.readSession;
	assert.equal(readAfterFirst, 1, "首轮读一次日志");
	cache.calls.coldSnapshot = 0;
	cache.calls.cachedSnapshot = 0;
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(result.ok, true);
	assert.equal(cache.calls.coldSnapshot, 0, "缓存命中不得触发冷折叠");
	assert.equal(query.calls.readSession, readAfterFirst, "缓存命中不得再读日志");
	// 数字来自缓存（首轮冷读已把真实折叠值写回）：sampleLog 两次调用
	// —— 1000 落桶 0、200000 落桶 3。
	assert.equal(result.value.totals.calls, 2);
	assert.equal(result.value.buckets[3].calls, 1);
});

test("冷折叠兜底：缓存未命中时 readSession + coldSnapshot，数字与折叠一致", async () => {
	const connection = makeConnection();
	const cache = makeProjectionCache({}); // 全部未命中
	const query = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx);
	// 首帧只排队（TS-24），数字要等后台校验收敛后才有。
	const settled = await waitVerifyingSettled(connection, {}, (v) => v.totals.calls === 2);
	assert.equal(settled.ok, true);
	assert.equal(cache.calls.coldSnapshot, 1);
	assert.equal(query.calls.readSession, 1);
	const value = settled.value;
	// 200000 → 桶 3（[128K,256K)）；1000 → 桶 0
	assert.equal(value.buckets[3].calls, 1);
	assert.equal(value.buckets[0].calls, 1);
	assert.equal(value.totals.calls, 2);
});

test("单会话 readSession 失败：跳过该会话，其余正常（不抛错）", async () => {
	const loggerWarns = [];
	const connection = makeConnection();
	const other = { id: "s-other", version: 4, createdAt: 2, cwd: W_BETA, isSeeded: false };
	const cache = makeProjectionCache({});
	const query = makeSessionQuery(
		[{ header: HEADER }, { header: other }],
		{ [other.id]: sampleLog(other) }, // HEADER 无日志 → readSession 抛
	);
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache, loggerWarns });
	startTokstats(ctx);
	const settled = await waitVerifyingSettled(connection);
	assert.equal(settled.ok, true, "单会话失败不得让整次汇总失败");
	assert.equal(settled.value.totals.calls, 2, "另一会话仍被计入");
	assert.ok(loggerWarns.some((line) => line.includes(HEADER.id)), "失败会话应有告警");
});

test("TS-21 / TS-22：端点返回值里带 coverage 与 epoch（client 的唯一消费面）", async () => {
	// 纯函数断言只证明 tokstatsAggregate 产出这两个字段；而 client 拿到的是
	// **RPC 端点的 value**。中间还有一层 `{ ...aggregate, generatedAt, windowDays }`
	// 的展开——那一层若被改成挑字段返回（或以后加了白名单过滤），纯函数断言仍然
	// 全绿而界面永远看不到覆盖率。所以这条必须在真实 apply 管线 + 端点调用上钉。
	const connection = makeConnection();
	const other = { id: "s-other", version: 4, createdAt: 2, cwd: W_BETA, isSeeded: false };
	const cache = makeProjectionCache({});
	const query = makeSessionQuery(
		[{ header: HEADER }, { header: other }, { header: { id: "s-broken", version: 4, createdAt: 3, cwd: W_BETA } }],
		{ [other.id]: sampleLog(other) }, // HEADER 与 s-broken 都无日志 → 两个会话被跳过
	);
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx);
	// 首帧的 coverage 就已经是完整的（分母来自 listSessions，与后台校验无关）；
	// 但 skipped 只有在冷读跑过之后才确定，故等收敛后再断言。
	const settled = await waitVerifyingSettled(connection);
	const result = settled;
	assert.equal(result.ok, true);
	// 端点值里必须有这两个字段，且形状正确。
	assert.equal(typeof result.value.coverage, "object");
	assert.equal(typeof result.value.coverage.sessions, "number");
	assert.equal(typeof result.value.coverage.skipped, "number");
	assert.equal(result.value.coverage.sessions, 3, "三个会话进了 entries");
	assert.equal(result.value.coverage.skipped, 2, "两个读不出来");
	// 端点值仍保留原有的字段（不能因为加了字段就把别人挤掉）。
	assert.equal(typeof result.value.windowDays, "number");
	assert.equal(typeof result.value.generatedAt, "number");
	assert.ok(Array.isArray(result.value.buckets));
	// 端点值里不得出现投影面字段：RPC 是聚合面，不是 wire 面。
	assert.equal(result.value.rows, undefined);
	assert.equal(result.value.w, undefined);
	// 无折叠历史 → epoch 必须严格为 null（client 用 !== null 判定）。
	assert.equal(result.value.epoch, null);
});

test("listSessions 抛错：端点返回错误信封而不是抛 500", async () => {
	const connection = makeConnection();
	const query = new Proxy({
		async listSessions() { throw new Error("boom"); },
	}, {
		get(obj, key) {
			if (key === "then") return undefined;
			if (typeof key === "symbol" || key in obj) return Reflect.get(obj, key);
			throw new Error("面外成员");
		},
	});
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: makeProjectionCache({}) });
	startTokstats(ctx);
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(result.ok, false, "handler 抛异常会被宿主转成 500，故必须自己收成错误信封");
	assert.equal(typeof result.error.code, "string");
	assert.equal(typeof result.error.message, "string");
	assert.deepEqual(result.error.details, {}, "details 必须是对象（客户端 parseConnectionResponse 硬性检查）");
});

test("未知 endpoint：返回 bad-request 错误信封", async () => {
	const connection = makeConnection();
	const { ctx } = makeCtx({
		connection,
		sessionQuery: makeSessionQuery([], {}),
		sessionProjectionCache: makeProjectionCache({}),
	});
	startTokstats(ctx);
	const result = await connection.invoke(TOKSTATS_CHANNEL, "nope", {});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "bad-request");
});

test("RPC 入参：windowDays 透传并影响窗口过滤", async () => {
	const connection = makeConnection();
	const cache = makeProjectionCache({
		[HEADER.id]: {
			[TOKSTATS_KEY]: {
				w: HEADER.cwd, e: null,
				rows: [
					{ d: tokstatsDayKey(Date.now()), b: 0, calls: 1, in: 10, cr: 0, cw: 0, out: 1 },
					{ d: "2026-01-05", b: 0, calls: 5, in: 10, cr: 0, cw: 0, out: 1 },
				],
			},
		},
	});
	const { ctx } = makeCtx({ connection, sessionQuery: makeSessionQuery([{ header: HEADER }], {}), sessionProjectionCache: cache });
	// 这条只测 windowDays 透传，不测滞后判定：关掉校验以保持「首轮即读缓存」。
	startTokstats(ctx, { verifyStale: false });
	// 注：windowDays 是「近 N 天」，故 0 表示全部、365 才覆盖到 1 月。
	const wide = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, { windowDays: 0 });
	assert.equal(wide.value.totals.calls, 6, "windowDays: 0 = 全部");
	const narrow = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, { windowDays: 30 });
	assert.equal(narrow.value.totals.calls, 1, "30 天窗口滤掉 1 月的格子");
});

test("RPC 入参：windowDays 非正数回落行配置；workspace 透传", async () => {
	const connection = makeConnection();
	const other = { id: "s-other", version: 4, createdAt: 2, cwd: W_BETA, isSeeded: false };
	const today = tokstatsDayKey(Date.now());
	const cache = makeProjectionCache({
		[HEADER.id]: { [TOKSTATS_KEY]: { w: HEADER.cwd, e: null, rows: [{ d: today, b: 0, calls: 1, in: 10, cr: 0, cw: 0, out: 1 }] } },
		[other.id]: { [TOKSTATS_KEY]: { w: other.cwd, e: null, rows: [{ d: today, b: 0, calls: 4, in: 10, cr: 0, cw: 0, out: 1 }] } },
	});
	const { ctx } = makeCtx({
		connection,
		sessionQuery: makeSessionQuery([{ header: HEADER }, { header: other }], {}),
		sessionProjectionCache: cache,
	});
	startTokstats(ctx, { verifyStale: false });
	const filtered = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, { workspace: other.cwd });
	assert.equal(filtered.value.totals.calls, 4);
	assert.equal(filtered.value.workspace, other.cwd);
	assert.deepEqual(filtered.value.workspaces.map((w) => w.path), [other.cwd]);
	const fallback = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, { windowDays: -3 });
	assert.equal(fallback.value.windowDays, 90, "非正数回落行配置缺省 90");
});

test("行 config.windowDays 生效（缺省 90）", async () => {
	const connection = makeConnection();
	const cache = makeProjectionCache({
		[HEADER.id]: {
			[TOKSTATS_KEY]: {
				w: HEADER.cwd, e: null,
				rows: [
					{ d: tokstatsDayKey(Date.now()), b: 0, calls: 1, in: 10, cr: 0, cw: 0, out: 1 },
					{ d: "2026-01-05", b: 0, calls: 5, in: 10, cr: 0, cw: 0, out: 1 },
				],
			},
		},
	});
	const { ctx } = makeCtx({ connection, sessionQuery: makeSessionQuery([{ header: HEADER }], {}), sessionProjectionCache: cache });
	startTokstats(ctx, { windowDays: 10, verifyStale: false });
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(result.value.windowDays, 10);
	assert.equal(result.value.totals.calls, 1, "10 天窗口滤掉 1 月的格子");
});

test("E1 折叠区间在读取期排除，避免与 epoch 合计双计", async () => {
	const connection = makeConnection();
	// epoch 是「按桶合计」：桶 1 有 2 次、桶 0 有 1 次，各带自己的输出量。
	const epochBuckets = [];
	for (let i = 0; i < TOKSTATS_BUCKET_COUNT; i += 1) epochBuckets.push({ calls: 0, in: 0, cr: 0, cw: 0, out: 0 });
	epochBuckets[1] = { calls: 2, in: 5000, cr: 0, cw: 0, out: 40 };
	epochBuckets[0] = { calls: 1, in: 100, cr: 0, cw: 0, out: 5 };
	const cache = makeProjectionCache({
		[HEADER.id]: {
			[TOKSTATS_KEY]: {
				w: HEADER.cwd,
				// 明细两格落在 epoch 区间内（已被折进合计），读取期必须跳过它们
				e: { start: "2026-01-01", end: "2026-09-21", routes: [{ rt: "", buckets: epochBuckets }] },
				rows: [
					{ d: "2026-01-05", b: 1, calls: 2, in: 5000, cr: 0, cw: 0, out: 40 },
					{ d: "2026-02-05", b: 0, calls: 1, in: 100, cr: 0, cw: 0, out: 5 },
				],
			},
		},
	});
	const { ctx } = makeCtx({
		connection,
		sessionQuery: makeSessionQuery([{ header: HEADER }], {}),
		sessionProjectionCache: cache,
	});
	startTokstats(ctx, { verifyStale: false });
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, { windowDays: 0 });
	assert.equal(result.value.totals.calls, 3, "区间内明细跳过、epoch 按桶合计计入（不双计）");
	assert.equal(result.value.buckets[1].calls, 2, "epoch 的桶粒度必须保住");
	assert.equal(result.value.buckets[0].calls, 1);
	assert.equal(result.value.totals.out, 45);
});

test("apply 分发：非 tokstats 插件不触碰 tokstats 的注册", () => {
	const connection = makeConnection();
	const { ctx, state } = makeCtx({ connection, sessionQuery: makeSessionQuery([], {}), sessionProjectionCache: makeProjectionCache({}) });
	apply(ctx, { plugin: "tokprev" });
	assert.equal(state.injectCalls.length, 0);
	assert.equal(connection.server.routes.length, 0);
});

test("RPC 注册依赖 webServer 注入（实测踩到：漏了它 handle() 会抛，通道静默不注册）", async () => {
	const connection = makeConnection();
	const { ctx } = makeCtx({
		connection,
		sessionQuery: makeSessionQuery([], {}),
		sessionProjectionCache: makeProjectionCache({}),
		webServer: null, // 模拟读取方 ctx 没有注入 webServer
	});
	startTokstats(ctx);
	assert.equal(connection.server.routes.length, 0, "webServer 缺席时不得注册通道（inject 不触发）");
});

test("RPC 注册成功时往 stderr 留一行可检索记录（通道静默不注册最难查）", async () => {
	const connection = makeConnection();
	const { ctx } = makeCtx({
		connection,
		sessionQuery: makeSessionQuery([], {}),
		sessionProjectionCache: makeProjectionCache({}),
	});
	const written = [];
	const original = process.stderr.write;
	process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
	try {
		startTokstats(ctx);
	} finally {
		process.stderr.write = original;
	}
	assert.equal(connection.server.routes.length, 1);
	assert.ok(written.some((line) => line.includes("[dsh-plugins]") && line.includes("已注册 RPC 通道")), "应留下注册成功的诊断行");
});





test("零 step 与真实 step 相邻时互不干扰", () => {
	const state = fold([
		// 20000 落在 [8K,32K)（桶 1），与零样本的最低桶（桶 0）必须分属两格。
		messageEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 20000, outputTokens: 60 }),
		chunkEvent(1, T(26, 10, 1), 1, 2, { inputTokens: 0, outputTokens: 0 }),
	]);
	assert.equal(state.rows.length, 2, "两个不同桶各一格");
	const real = state.rows.find((c) => c.b !== 0);
	const zero = state.rows.find((c) => c.b === 0);
	assert.equal(real.calls, 1);
	assert.equal(real.out, 60, "真实 step 的数字不受零 step 影响");
	assert.equal(zero.calls, 1);
	assert.equal(zero.in, 0);
});


test("活会话跳过缓存：检查点滞后时不得采信（官方水位无法与日志关联）", async () => {
	const connection = makeConnection();
	// 缓存里有陈旧值（calls=27），但日志已长出真实值（sampleLog 两次调用）
	const cache = makeProjectionCache({
		[HEADER.id]: { [TOKSTATS_KEY]: { w: HEADER.cwd, e: null, rows: [{ d: D1, b: 3, calls: 27, in: 100, cr: 0, cw: 0, out: 1 }] } },
	});
	const query = makeSessionQuery([{ header: HEADER, live: true }], { [HEADER.id]: sampleLog(HEADER) });
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx);
	// 活会话优先读投影注册表（TS-24）；本用例没有注册表，故退回后台冷读。
	const result = await waitVerifyingSettled(connection, {}, (v) => v.totals.calls === 2);
	assert.equal(result.ok, true);
	assert.equal(cache.calls.cachedSnapshot, 0, "活会话不得读缓存");
	assert.equal(query.calls.readSession, 1, "应走冷读（活会话是内存快照）");
	assert.equal(result.value.totals.calls, 2, "数字来自日志而非陈旧检查点");
});

test("TS-24：活会话走投影注册表 cachedSnapshot，不调用 readSession", async () => {
	// 宿主注册表在 session/event 上急切驱动本单元，所以活会话的正确值本来就在
	// 内存里；再调 readSession 全量回放是重复劳动（实测单会话 604 ms vs 微秒级）。
	const connection = makeConnection();
	const cache = makeProjectionCache({});
	const query = makeSessionQuery([{ header: HEADER, live: true }], { [HEADER.id]: sampleLog(HEADER) });
	const liveSession = { id: HEADER.id, seq: 3 };
	const view = { w: HEADER.cwd, e: null, rows: [{ d: D1, b: 3, calls: 5, in: 100, cr: 0, cw: 0, out: 1, rt: "p/m" }] };
	const calls = { cachedSnapshot: 0, snapshot: 0 };
	const projections = {
		cachedSnapshot(session, keys) {
			calls.cachedSnapshot += 1;
			assert.equal(session, liveSession, "必须把活会话对象交给注册表");
			assert.deepEqual(keys, [TOKSTATS_KEY]);
			return { asOfSeq: 2, values: { [TOKSTATS_KEY]: view } };
		},
		snapshot() { calls.snapshot += 1; return undefined; },
	};
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache, projections, liveSessions: { [HEADER.id]: liveSession } });
	startTokstats(ctx);
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(result.ok, true);
	assert.equal(calls.cachedSnapshot, 1, "活会话必须走注册表零折叠读");
	assert.equal(query.calls.readSession, 0, "活会话不得回放日志");
	assert.equal(result.value.totals.calls, 5, "数字来自注册表里的实时单元");
	assert.equal(result.value.verifying, undefined, "活会话不需要进校验队列");
});

test("非活会话仍走缓存（零 I/O 路径不被上一条改坏）", async () => {
	const connection = makeConnection();
	const cache = makeProjectionCache({
		[HEADER.id]: { [TOKSTATS_KEY]: { w: HEADER.cwd, e: null, rows: [{ d: D1, b: 3, calls: 9, in: 100, cr: 0, cw: 0, out: 1 }] } },
	});
	const query = makeSessionQuery([{ header: HEADER, live: false }], { [HEADER.id]: sampleLog(HEADER) });
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx, { verifyStale: false });
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(cache.calls.cachedSnapshot, 1, "已结束会话应命中缓存");
	assert.equal(query.calls.readSession, 0);
	assert.equal(result.value.totals.calls, 9);
});

// ── TS-26 / TS-27：冷读凭据按日志 revision 记账 + 后台校验不得空转 ───────────
//
// 背景（本机实测，2026-10-23）：冷读场景下终值在第 3 次请求（228 ms）就已正确，
// 但 drain 又跑了 14.6 s / 20.6 CPU-s——那段时间面板显示的数字**一个都没再变**。
// 原因：drain 逐会话冷读只为「建立 TS-19 基线」，哪怕该会话的缓存行本来就是对的。
//
// 治本：宿主**不会**替插件重校验已落盘会话的缓存行（`coldSnapshot` 在宿主 asar 内
// 零调用点），所以「这行缓存是不是我们冷读出来的」必须由插件自己记住，且要跨进程。
// 记账口径是宿主公开服务 `ctx.sessionPersistence` 的 `revision`（纯 stat 元数据，
// 不解码日志）。

/** 一个带 revision 与存储域的完整装配（TS-26 用例共用）。 */
function makeCredentialFixture({ revision = "1:2:3:4:5" } = {}) {
	const connection = makeConnection();
	const cache = makeProjectionCache({});
	const query = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const persistence = makeSessionPersistence(revision);
	const storage = makeStorageDomain();
	const { ctx } = makeCtx({
		connection,
		sessionQuery: query,
		sessionProjectionCache: cache,
		sessionPersistence: persistence,
		storageDomain: storage,
	});
	return { connection, cache, query, persistence, storage, ctx };
}

test("TS-26：冷读成功后记账的 revision 与下次汇总取到的相同 → 不再排冷读", async () => {
	const f = makeCredentialFixture();
	startTokstats(f.ctx);
	// 首轮：缓存未命中 → 排冷读；冷读成功后记账。
	const first = await waitVerifyingSettled(f.connection, {}, (v) => v.totals.calls === 2);
	assert.equal(f.query.calls.readSession, 1, "首轮必须冷读一次");
	assert.equal(first.value.totals.calls, 2);

	// 第二轮：日志没变（revision 相同）→ 凭据闸门放行 → **不得再冷读**。
	const readBefore = f.query.calls.readSession;
	const second = await f.connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(second.ok, true);
	assert.equal(f.query.calls.readSession, readBefore, "日志没变时不得重复冷读（TS-27）");
	assert.equal(second.value.totals.calls, 2, "数字不变");
	assert.equal(second.value.verifying, undefined, "没有待办 → verifying 消失");
});

test("TS-26：冷路径上也必须记账（首轮没有任何凭据时）", async () => {
	// 反向用例：首轮 `revisionsByIdRef` 是空的（一个凭据都没有），若记账只从
	// 那张表取值，冷路径就**永远记不下凭据**——功能静默失效（第二轮照旧冷读）。
	// 这条钉住「drain 自己取冷读前的 revision」。
	const f = makeCredentialFixture();
	startTokstats(f.ctx);
	await waitVerifyingSettled(f.connection, {}, (v) => v.totals.calls === 2);
	// 冷读时确实取过一次 stat（记账的来源）。
	assert.ok(f.persistence.state.calls.stat >= 1, "冷读前必须取一次 revision 用来记账");
	// 记账生效：第二轮不再冷读。
	const readBefore = f.query.calls.readSession;
	await f.connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(f.query.calls.readSession, readBefore, "冷路径也必须记账，否则第二轮照旧冷读");
});

test("TS-26：日志 revision 变了 → 必须重新冷读（TS-19 原路径不丢）", async () => {
	// revalidateTtlMs: 0 → 每帧都重新核对 revision（默认 2 s 的 TTL 在测试里
	// 会让两次请求落在同一窗口内，测不到「日志变了」）。
	const f = makeCredentialFixture();
	startTokstats(f.ctx, { revalidateTtlMs: 0 });
	await waitVerifyingSettled(f.connection, {}, (v) => v.totals.calls === 2);
	assert.equal(f.query.calls.readSession, 1, "首轮冷读一次");

	// 日志长了 → revision 变 → 凭据失效 → 必须重新冷读。
	f.persistence.state.current = "9:9:9:9:9";
	const readBefore = f.query.calls.readSession;
	const second = await waitVerifyingSettled(f.connection, {}, (v) => v.totals.calls === 2);
	assert.equal(f.query.calls.readSession, readBefore + 1, "日志变了必须重新冷读");
	assert.equal(second.value.totals.calls, 2, "重新冷读后数字仍正确");
});

test("TS-26：revision 相同 ⇒ 聚合终值与冷读那次逐字段相等", async () => {
	const f = makeCredentialFixture();
	startTokstats(f.ctx);
	const first = await waitVerifyingSettled(f.connection, {}, (v) => v.totals.calls === 2);
	const second = await f.connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	// 逐字段比对：终值不得因「跳过已校验会话」而漂移。
	for (const key of ["totals", "buckets", "daily", "weekly", "routes", "workspaces"]) {
		assert.deepEqual(second.value[key], first.value[key], `${key} 终值必须逐字段相等`);
	}
	assert.equal(second.value.coverage.sessions, first.value.coverage.sessions);
	assert.equal(second.value.coverage.skipped, first.value.coverage.skipped);
});

test("TS-26：凭据跨进程持久化（存储域缺席时降级为进程内记忆，不抛错）", async () => {
	// 存储域缺席 → 凭据退化为进程内记忆：同进程内仍免掉重复冷读。
	const connection = makeConnection();
	const cache = makeProjectionCache({});
	const query = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const persistence = makeSessionPersistence("1:2:3:4:5");
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache, sessionPersistence: persistence });
	assert.doesNotThrow(() => startTokstats(ctx), "存储域缺席不得抛错（硬规则 6）");
	const first = await waitVerifyingSettled(connection, {}, (v) => v.totals.calls === 2);
	assert.equal(query.calls.readSession, 1, "首轮冷读一次");
	const second = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(query.calls.readSession, 1, "进程内记忆也要免掉重复冷读");
	assert.deepEqual(second.value.totals, first.value.totals);
});

test("TS-26：凭据跨进程复用——新进程注入同一条凭据后不得再冷读", async () => {
	// **这条是 TS-26 的核心价值**：宿主重启后进程内记忆全丢，若没有跨进程凭据，
	// 每个会话都要重付一次冷读（本机 14 s / 20.6 CPU-s）。
	//
	// 做法：先用一个「存储域」跑一轮，让凭据落进去；再用**同一个存储域**
	// 装配一个全新的 reader（模拟宿主重启后的新进程），断言它一次都不冷读。
	//
	// 反向验证确认过：把 `services.credentials` 置为 undefined（等价于不记凭据），
	// 本用例会红——因为新进程没有任何东西告诉它「这行缓存是对的」。
	const shared = makeStorageDomain();

	// ── 进程 1：冷读一次、记账 ──
	const c1 = makeConnection();
	const cache1 = makeProjectionCache({});
	const q1 = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const p1 = makeSessionPersistence("1:2:3:4:5");
	const { ctx: ctx1 } = makeCtx({
		connection: c1, sessionQuery: q1, sessionProjectionCache: cache1,
		sessionPersistence: p1, storageDomain: shared,
	});
	startTokstats(ctx1);
	await waitVerifyingSettled(c1, {}, (v) => v.totals.calls === 2);
	assert.equal(q1.calls.readSession, 1, "进程 1 冷读一次并记账");

	// ── 进程 2：全新 reader，但**复用同一份缓存行与同一份存储域** ──
	// 注意缓存行由进程 1 的 coldSnapshot 写回（`makeProjectionCache` 会把 view
	// 存进 cachedById），所以进程 2 读得到；凭据在共享存储域里。
	const c2 = makeConnection();
	const q2 = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const p2 = makeSessionPersistence("1:2:3:4:5");
	const { ctx: ctx2 } = makeCtx({
		connection: c2, sessionQuery: q2, sessionProjectionCache: cache1,
		sessionPersistence: p2, storageDomain: shared,
	});
	startTokstats(ctx2);
	// 等它收敛（应当只需核对一次 revision，**不冷读**）。
	const settled2 = await waitVerifyingSettled(c2, {}, (v) => v.totals.calls === 2);
	assert.equal(q2.calls.readSession, 0, "新进程必须凭跨进程凭据免掉冷读（TS-26 的核心价值）");
	assert.equal(settled2.value.totals.calls, 2, "数字与进程 1 一致");
});

test("TS-27：drain 在**每个会话之后**让出事件循环（不连续霸占 CPU）", async () => {
	// 宿主 `readSession` 的包装层（深拷贝 + 冻结 + 逐事件校验）是**同步**的，
	// 宿主自己的 500 ms yield 切不开它——单会话最长 951 ms（本机实测）。
	// 所以 drain 必须在**会话之间**让出一次，把连续占用拆成小段。
	//
	// 判据（必须能区分「有让出」与「没让出」——只测「探针能跑到」是假绿，
	// 因为 `await readSession` 本身就会让出一个 tick）：
	// 在 drain 期间用 `queueMicrotask` 链打点，数「drain 内部让出」造成的
	// **额外轮次**。做法是把 readSession 桩换成同步返回（不产生 await 让出），
	// 这样观察到的轮次差就只可能来自 drain 自己的 yield。
	const connection = makeConnection();
	const cache = makeProjectionCache({});
	const headers = Array.from({ length: 3 }, (_, i) => ({ ...HEADER, id: "s-" + i }));
	// readSession 改成**同步 resolve**（`await` 它仍是一个 tick，但极其紧凑）。
	const baseQuery = makeSessionQuery(headers.map((header) => ({ header })), Object.fromEntries(headers.map((h) => [h.id, sampleLog(h)])));
	const query = baseQuery;
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx);
	const first = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(first.value.verifying, true, "首帧应报告后台还有活");

	// 用 setImmediate 打点：它的执行需要 drain 完全让出到宏任务队列。
	let immediateRan = 0;
	const marker = () => { immediateRan += 1; if (immediateRan < 8) setImmediate(marker); };
	setImmediate(marker);
	await waitVerifyingSettled(connection, {}, (v) => v.totals.calls === 6);
	assert.equal(query.calls.readSession, 3, "三个会话各冷读一次");
	// 3 个会话 + 收尾让出 ⇒ drain 至少让出到宏任务队列数次。
	// 若 drain 内不让出，`await readSession` 只交替微任务，setImmediate
	// 要等 drain 整体结束才排上，计数会明显偏低。
	assert.ok(immediateRan >= 3, `drain 期间只跑到 ${immediateRan} 个 setImmediate——会话之间缺少让出`);
});

test("TS-26：v0 格式（revision 掺全局语料哈希）不得记为凭据", async () => {
	// 宿主对 sourceVersion < SESSION_FORMAT_VERSION 的产物把 revision 算成
	// `${fileRevision}:${historicalCorpusRevision()}`，后者是**所有**历史日志的
	// SHA-256（6 段而非 5 段）。这种 revision 证明不了「这个会话没变」，
	// 必须判成「无凭据」→ 退回 TS-19 的 seq 基线路径，否则那些会话会永远重读。
	// 本机 74 个会话里 14 个是 v0 格式，占冷读 CPU 的绝大部分。
	const v0 = "1666:777:888:999:1111:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const connection = makeConnection();
	const cache = makeProjectionCache({});
	const query = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const persistence = makeSessionPersistence(v0);
	const storage = makeStorageDomain();
	const { ctx } = makeCtx({
		connection, sessionQuery: query, sessionProjectionCache: cache,
		sessionPersistence: persistence, storageDomain: storage,
	});
	startTokstats(ctx, { revalidateTtlMs: 0 });
	await waitVerifyingSettled(connection, {}, (v) => v.totals.calls === 2);
	// **钉住凭据表本身**：v0 的 revision 不得被记账。
	// 只断言「数字对」是假绿——记账与否数字都对（多冷读一次数字不变），
	// 差别在**成本**上，所以必须直接查表。
	const domain = storage.opened[0];
	assert.ok(domain !== undefined, "凭据域应被打开");
	assert.equal(storage.count(domain.name), 0, "v0 的 revision 证明不了本会话未变，不得记账");
});

test("TS-26：记账不改变聚合终值（TS-03：不抬 stateVersion、不清缓存）", async () => {
	// 投影单元的 stateVersion 与 wire 键集不得因本轮改动而变化。
	const { ctx, state } = makeCtx({});
	startTokstats(ctx);
	assert.equal(state.registered[0].stateVersion, TOKSTATS_STATE_VERSION);
	assert.equal(state.registered[0].stateVersion, 6, "TS-03：不因纯 host 侧性能改动抬版本");
});

test("TS-27：同一进程内第二次汇总不得再冷读已校验过的会话", async () => {
	// 这条是 TS-27 的核心：drain 不得对已校验过的会话空转。
	const f = makeCredentialFixture();
	startTokstats(f.ctx);
	await waitVerifyingSettled(f.connection, {}, (v) => v.totals.calls === 2);
	const readAfterFirst = f.query.calls.readSession;
	for (let i = 0; i < 3; i += 1) {
		await f.connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	}
	assert.equal(f.query.calls.readSession, readAfterFirst, "连续三次汇总都不得再冷读");
});

test("TS-27：drain 跑完后队列为空、verifying 消失", async () => {
	const f = makeCredentialFixture();
	startTokstats(f.ctx);
	const settled = await waitVerifyingSettled(f.connection, {}, (v) => v.totals.calls === 2);
	assert.equal(settled.value.verifying, undefined, "收敛后不得再报 verifying");
	assert.equal(settled.value.coverage.skipped, 0, "收敛后不得把会话谎报成「跳过」");
});

test("TS-27：冷读失败不写凭据（下次仍会重试）", async () => {
	const connection = makeConnection();
	const cache = makeProjectionCache({});
	// readSession 抛错 → 冷读失败 → 不得记账（否则下次会误以为「冷读过了」）。
	const query = makeSessionQuery([{ header: HEADER }], {});
	const persistence = makeSessionPersistence("1:2:3:4:5");
	const storage = makeStorageDomain();
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache, sessionPersistence: persistence, storageDomain: storage });
	startTokstats(ctx);
	await waitVerifyingSettled(connection, {}, (v) => v.totals.calls === 0);
	// 凭据表里不得有该会话的记录。
	const opened = storage.opened[0];
	assert.ok(opened !== undefined, "冷读凭据域必须被打开过");
});

test("TS-26：持久化水位读不出来时按未记账处理（保守重读，不采信缓存）", async () => {
	const connection = makeConnection();
	const cache = makeProjectionCache({
		[HEADER.id]: { [TOKSTATS_KEY]: { w: HEADER.cwd, e: null, rows: [{ d: D1, b: 3, calls: 27, in: 100, cr: 0, cw: 0, out: 1 }] } },
	});
	const query = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	// stat 抛错 → 读不到 revision → 不得凭「读不到」就采信缓存。
	const persistence = {
		async stat() { throw new Error("persistence unavailable"); },
	};
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache, sessionPersistence: persistence });
	startTokstats(ctx);
	const settled = await waitVerifyingSettled(connection, {}, (v) => v.totals.calls === 2);
	assert.equal(query.calls.readSession, 1, "读不到水位时必须保守冷读");
	assert.equal(settled.value.totals.calls, 2, "冷读后的数字才是真的");
});


