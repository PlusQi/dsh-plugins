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
	// chunk 落在 [0,4K)，message 终值 200000 落在 [128K,∞)：减旧加新必须把旧格清掉。
	const state = fold([
		chunkEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 1000, outputTokens: 10 }),
		messageEvent(1, T(26, 10, 0), 1, 1, { inputTokens: 200000, outputTokens: 20 }),
	]);
	assert.equal(state.rows.length, 1, "旧桶的空格必须被剔除");
	assert.equal(state.rows[0].b, 6, "终值落在最高桶");
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

test("桶边界：2 的幂对数桶（4096 / 8192 / 200000 三点必测）", () => {
	assert.equal(TOKSTATS_BUCKET_COUNT, 7);
	assert.equal(tokstatsBucketOf(0), 0);
	assert.equal(tokstatsBucketOf(4095), 0);
	assert.equal(tokstatsBucketOf(4096), 1);
	assert.equal(tokstatsBucketOf(8191), 1);
	assert.equal(tokstatsBucketOf(8192), 2);
	assert.equal(tokstatsBucketOf(16384), 3);
	assert.equal(tokstatsBucketOf(32768), 4);
	assert.equal(tokstatsBucketOf(65536), 5);
	assert.equal(tokstatsBucketOf(131072), 6);
	assert.equal(tokstatsBucketOf(200000), 6);
});

test("桶落点在 fold 里用 in+cr+cw 之和（缓存读也计入计费输入）", () => {
	// in 1000 + cr 70000 → 71000 → 桶 5
	const state = fold([messageEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 1000, cacheReadTokens: 70000, outputTokens: 5 })]);
	assert.equal(state.rows[0].b, 5);
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
	// 计费输入 4000 < 4096 → 桶 0
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

test("聚合：窗口过滤 + 工作区分组 + 周趋势分组", () => {
	const summary = {
		w: W_ALPHA,
		e: null,
		rows: [
			{ d: "2026-10-19", b: 6, calls: 2, in: 200000, cr: 0, cw: 0, out: 10 },
			{ d: "2026-10-20", b: 5, calls: 1, in: 70000, cr: 0, cw: 0, out: 5 },
			{ d: "2026-06-01", b: 0, calls: 3, in: 100, cr: 0, cw: 0, out: 1 },
		],
	};
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 30, today: "2026-10-20" });
	assert.equal(result.windowStart, "2026-09-21");
	assert.equal(result.totals.calls, 3, "窗口外的 2026-06-01 不计");
	assert.equal(result.buckets[6].calls, 2);
	assert.equal(result.buckets[5].calls, 1);
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
			{ d: "2026-10-20", b: 5, calls: 1, in: 70000, cr: 0, cw: 0, out: 5 },
			{ d: "2026-10-19", b: 6, calls: 2, in: 200000, cr: 100, cw: 7, out: 10 },
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
			{ d: "2026-10-19", b: 6, calls: 2, in: 200000, cr: 10, cw: 0, out: 10 },
			{ d: "2026-10-20", b: 5, calls: 1, in: 70000, cr: 20, cw: 5, out: 5 },
			// 跨周：2026-10-26 属于下一自然周（周一）
			{ d: "2026-10-26", b: 4, calls: 4, in: 40000, cr: 30, cw: 0, out: 9 },
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

test("聚合：workspace 过滤只留匹配的会话", () => {	const a = { w: "a", e: null, rows: [{ d: "2026-10-20", b: 0, calls: 1, in: 10, cr: 0, cw: 0, out: 1 }] };
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
	assert.equal(TOKSTATS_STATE_VERSION, 3, "由 2 提升（cell 加 rt + epoch 改结构），旧缓存行据此作废（I3 / Q9）");
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
	let result;
	await assert.doesNotReject(async () => {
		result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	});
	assert.equal(result.ok, true, "旧版本行作废后不得抛错（AC-6）");
	assert.equal(cache.calls.coldSnapshot, 1, "必须走冷折叠重建");
	assert.equal(result.value.totals.calls, 2, "重建后的数字与真实日志一致");
	assert.equal(result.value.routes, undefined, "第一批不产出 routes（产出在第二批 tka8-5a）");
});

test("第一批边界：聚合返回值的键集不含 routes（面板外观不变的机械依据）", () => {
	// 第一批「外观不变」的实质是「数据形状变了但没人消费」：client 只吃 RPC 聚合，
	// 而聚合的字段集在本批不动，故面板渲染路径零变化。第二批 tka8-5a 加 routes 时
	// 这条断言必须同步改为含 routes。
	const summary = { w: W_ALPHA, e: null, rows: [{ d: "2026-10-20", b: 0, calls: 1, in: 100, cr: 0, cw: 0, out: 1, rt: "a/b" }] };
	const result = tokstatsAggregate([{ rootWorkspace: W_ALPHA, summary }], { windowDays: 90, today: "2026-10-20" });
	assert.deepEqual(
		Object.keys(result).sort(),
		["buckets", "daily", "totals", "weekly", "windowStart", "workspaces"],
		"第一批的聚合字段集与 v0.7.0 一致（routes 是第二批的增量）",
	);
});


// ── 阶段 2：单元注册 / 汇总 / 降级 ──────────────────────────────────────────

/**
 * 伪 `ctx.sessionQuery`：只暴露真实服务面内本插件会用的成员
 * （listSessions / readSession），面外调用抛错——桩比宿主宽松会让用错 API 的实现
 * 也全绿。
 */
function makeSessionQuery(records, logsById) {
	const calls = { listSessions: 0, readSession: 0 };
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
 * 伪 `ctx.sessionProjectionCache`：cachedSnapshot / coldSnapshot 两个读面。
 * coldSnapshot 真的把日志折一遍（走同一套纯函数），这样「冷折叠兜底」测的是真实
 * 折叠语义而不是桩返回的常量。
 */
function makeProjectionCache(cachedById) {
	const calls = { cachedSnapshot: 0, coldSnapshot: 0 };
	const stub = {
		calls,
		cachedSnapshot(meta, keys) {
			calls.cachedSnapshot += 1;
			const keyed = cachedById[meta.id];
			if (keyed === undefined) return undefined;
			const values = {};
			for (const key of keys ?? []) {
				if (keyed[key] !== undefined) values[key] = keyed[key];
			}
			return Object.keys(values).length === 0 ? undefined : { asOfSeq: 0, values };
		},
		coldSnapshot(meta, inheritedEventCount, events) {
			calls.coldSnapshot += 1;
			let state = tokstatsInit(meta, inheritedEventCount);
			for (const event of events) state = tokstatsFoldUsage(state, event, 90);
			return { asOfSeq: -1, values: { [TOKSTATS_KEY]: tokstatsDefinition(90).wire.view(state) } };
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
function makeCtx({ connection, sessionQuery, sessionProjectionCache, projections = true, webServer, loggerWarns } = {}) {
	const state = { registered: [], injectCalls: [], effects: [] };
	const hasWebServer = webServer !== null;
	// 默认用 connection 自带的那份 webServer 桩：用例既能 `connection.invoke(...)`
	// 驱动路由，又不必显式传两层桩。
	const server = webServer ?? connection?.server ?? makeWebServerStub();
	const provided = { connection, sessionQuery, sessionProjectionCache, webServer: hasWebServer ? server : null };
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
					pctx.sessionProjections = { register: (def) => { state.registered.push(def); return () => {}; } };
					continue;
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
	assert.equal(state.registered[0].stateVersion, 3);
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
		[HEADER.id]: { [TOKSTATS_KEY]: { w: HEADER.cwd, e: null, rows: [{ d: D1, b: 6, calls: 2, in: 200000, cr: 0, cw: 0, out: 90 }] } },
	});
	const query = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx);
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(result.ok, true);
	assert.equal(cache.calls.coldSnapshot, 0, "缓存命中不得触发冷折叠");
	assert.equal(query.calls.readSession, 0, "缓存命中不得读日志");
	assert.equal(result.value.buckets[6].calls, 2);
	assert.equal(result.value.buckets[6].out, 90);
});

test("冷折叠兜底：缓存未命中时 readSession + coldSnapshot，数字与折叠一致", async () => {
	const connection = makeConnection();
	const cache = makeProjectionCache({}); // 全部未命中
	const query = makeSessionQuery([{ header: HEADER }], { [HEADER.id]: sampleLog(HEADER) });
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx);
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(result.ok, true);
	assert.equal(cache.calls.coldSnapshot, 1);
	assert.equal(query.calls.readSession, 1);
	// 200000 → 桶 6；1000 → 桶 0
	assert.equal(result.value.buckets[6].calls, 1);
	assert.equal(result.value.buckets[0].calls, 1);
	assert.equal(result.value.totals.calls, 2);
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
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(result.ok, true, "单会话失败不得让整次汇总失败");
	assert.equal(result.value.totals.calls, 2, "另一会话仍被计入");
	assert.ok(loggerWarns.some((line) => line.includes(HEADER.id)), "失败会话应有告警");
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
	startTokstats(ctx);
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
	startTokstats(ctx);
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
	startTokstats(ctx, { windowDays: 10 });
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
	startTokstats(ctx);
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
		messageEvent(0, T(26, 10, 0), 1, 1, { inputTokens: 5000, outputTokens: 60 }),
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
		[HEADER.id]: { [TOKSTATS_KEY]: { w: HEADER.cwd, e: null, rows: [{ d: D1, b: 6, calls: 27, in: 100, cr: 0, cw: 0, out: 1 }] } },
	});
	const query = makeSessionQuery([{ header: HEADER, live: true }], { [HEADER.id]: sampleLog(HEADER) });
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx);
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(result.ok, true);
	assert.equal(cache.calls.cachedSnapshot, 0, "活会话不得读缓存");
	assert.equal(query.calls.readSession, 1, "应走冷读（活会话是内存快照）");
	assert.equal(result.value.totals.calls, 2, "数字来自日志而非陈旧检查点");
});

test("非活会话仍走缓存（零 I/O 路径不被上一条改坏）", async () => {
	const connection = makeConnection();
	const cache = makeProjectionCache({
		[HEADER.id]: { [TOKSTATS_KEY]: { w: HEADER.cwd, e: null, rows: [{ d: D1, b: 6, calls: 9, in: 100, cr: 0, cw: 0, out: 1 }] } },
	});
	const query = makeSessionQuery([{ header: HEADER, live: false }], { [HEADER.id]: sampleLog(HEADER) });
	const { ctx } = makeCtx({ connection, sessionQuery: query, sessionProjectionCache: cache });
	startTokstats(ctx);
	const result = await connection.invoke(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, {});
	assert.equal(cache.calls.cachedSnapshot, 1, "已结束会话应命中缓存");
	assert.equal(query.calls.readSession, 0);
	assert.equal(result.value.totals.calls, 9);
});
