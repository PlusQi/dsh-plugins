// tokstats host 半边测试：伪 cordis ctx + 伪 persistence，走 lib/index.js 的
// 真实 apply 管线（纯函数不单独导出，经管线输出反推——测的就是真实入口）。
// 零依赖：node:test + node:assert（AGENTS 硬规则 5）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mod = await import("../lib/index.js");

// ── 伪事件 / fixture 构造 ─────────────────────────────────────────────────

/** 独立 seq 计数的事件构造器（每份日志从 seq 0 连续编号）。 */
function makeLog() {
	let s = -1;
	return (type, time, data) => {
		s += 1;
		return { type, seq: s, time, data };
	};
}

/** 本地时区 2026-08-26（周三）的指定时刻。 */
const T = (h, m) => new Date(2026, 7, 26, h, m, 0).getTime();
const D1 = "2026-08-26";
const D2 = "2026-08-25";

function rootEvents(log) {
	return [
		log("session/start", T(10, 0), {}),
		log("request/header", T(10, 0), { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash" } } }),
		log("turn/start", T(10, 0), { turn: 1 }),
		// usage chunk 采样（将被同 (turn,step) 的 message.usage 终值替换）
		log("assistant/chunk", T(10, 0), { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 50 } } }),
		log("assistant/message", T(10, 0), { turn: 1, step: 1, message: { source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 1000, outputTokens: 60 } }),
		// content-less 失败调用：只有 usage chunk、无 message → 归因回落 request/header
		log("assistant/chunk", T(10, 1), { turn: 1, step: 2, chunk: { type: "usage", usage: { inputTokens: 500, outputTokens: 10, cacheReadTokens: 200 } } }),
		// 第三方模型调用（message.source 归因）
		log("assistant/message", T(11, 0), { turn: 1, step: 3, message: { source: { kind: "model", provider: "third-party-x", model: "some-model" } }, usage: { inputTokens: 200000, outputTokens: 30 } }),
		// 跨日：昨天 23:59 的调用
		log("assistant/message", new Date(2026, 7, 25, 23, 59, 0).getTime(), { turn: 1, step: 4, message: { source: { kind: "model", provider: "third-party-x", model: "some-model" } }, usage: { inputTokens: 8192, outputTokens: 5 } }),
	];
}

/**
 * 真实 `ctx.sessionPersistence` 的公开面（`SessionPersistence` 抽象类；
 * dsh-session-persistence 0.1.1-rc.2 与 0.1.2-alpha.3 一致）。
 * 桩只能提供这个集合内的方法：多提供一个，就等于给「调了宿主没有的方法」这类
 * 缺陷发通行证——2026-09-01 的 `readStoredRevision` 正是靠桩自己造出来才全绿。
 */
const SESSION_PERSISTENCE_SURFACE = [
	"locate", "supportsRawArtifacts", "readRaw", "create", "append",
	"prepare", "load", "inspect", "readFrom", "list", "listSnapshots",
];

/**
 * 伪 persistence：可配置的快照集 + 调用计数（inspect 计数用于对账断言）。
 * 读面外的方法名直接抛错：桩比真实宿主宽松时，缺陷会以「全绿」伪装过去。
 * headersById 供「有日志但不在快照表」的活会话补折场景给 inspect 兜 meta。
 */
function makePersistence(snapshots, logsById, headersById) {
	const calls = { listSnapshots: 0, inspect: 0 };
	const stub = {
		calls,
		async listSnapshots() {
			calls.listSnapshots += 1;
			return snapshots;
		},
		async inspect(id) {
			calls.inspect += 1;
			const events = logsById[id];
			if (events === undefined) throw new Error("not found: " + id);
			const meta = snapshots.find((s) => s.header.id === id)?.header ?? headersById?.[id] ?? { id };
			return { meta, events };
		},
	};
	return new Proxy(stub, {
		get(obj, key) {
			if (typeof key === "symbol" || key in obj) return Reflect.get(obj, key);
			throw new Error(`tokstats 调了 persistence.${String(key)}：真实 ctx.sessionPersistence 面上没有这个方法`);
		},
	});
}

/** 伪 cordis ctx：inject 按就绪情况回调（缺席的依赖永不回调，模拟服务未注册）。 */
function makeCtx({ persistence, projections = true, loggerWarns } = {}) {
	const state = { registered: null, flushHandler: null };
	const ctx = {
		logger: { warn: (...args) => { if (loggerWarns !== undefined) loggerWarns.push(args.join(" ")); } },
		inject(names, cb) {
			const pctx = {};
			for (const name of names) {
				if (name === "sessionPersistence" && persistence !== undefined && persistence !== null) pctx.sessionPersistence = persistence;
				if (name === "sessionProjections" && projections !== false) pctx.sessionProjections = { register: (def) => { state.registered = def; return () => {}; } };
			}
			if (Object.keys(pctx).length === names.length) cb(pctx);
		},
		on(name, cb) {
			if (name === "session/flush") state.flushHandler = cb;
			return () => {};
		},
		effect() { return () => {}; },
	};
	return { ctx, state };
}

/** 独立临时 DSH_HOME + mock 计时器（吸收 5s 启动检查挂钟）。 */
function setup(t) {
	const home = mkdtempSync(join(tmpdir(), "tokstats-test-"));
	process.env.DSH_HOME = home;
	t.mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => {
		rmSync(home, { recursive: true, force: true });
	});
	return { home, cpPath: join(home, "storages", "tokstats-checkpoint.json") };
}

/** 排空 async 微任务（flushCheckpoint / runScan 的 await 链）。 */
async function settle() {
	for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
}

const W_ALPHA = "D:\\proj\\alpha";

// ── 测试桩保真度 ───────────────────────────────────────────────────────────

test("伪 persistence 只提供真实服务面内的方法", () => {
	const stub = makePersistence([], {});
	const extra = Object.keys(stub).filter((k) => k !== "calls" && !SESSION_PERSISTENCE_SURFACE.includes(k));
	assert.deepEqual(extra, [], "桩造出宿主没有的方法，会让用错 API 的实现也全绿");
});

test("读面外方法抛错：桩不替宿主兜底", () => {
	const stub = makePersistence([], {});
	assert.throws(() => stub.readStoredRevision, /persistence\.readStoredRevision/);
});

// ── 分发框架 ───────────────────────────────────────────────────────────────

test("apply 分发框架：非 tokstats 插件静默跳过（host 半边为空）", async (t) => {
	setup(t);
	const { ctx, state } = makeCtx({ persistence: makePersistence([], {}) });
	mod.apply(ctx, { plugin: "tokprev" });
	mod.apply(ctx, { plugin: "whatever" });
	mod.apply(ctx, undefined);
	await settle();
	assert.equal(state.registered, null, "不应注册任何 projection unit");
});

// ── usage 折叠口径 ─────────────────────────────────────────────────────────

test("同 (turn,step) 终值替换：chunk 采样被 message.usage 替换，不双计", async (t) => {
	setup(t);
	const log = makeLog();
	const events = rootEvents(log);
	const persistence = makePersistence([{ header: { id: "s1", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { s1: events });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	const cell = state.registered.wire.view().cells.find((c) => c.p === "deepseek-official" && c.m === "deepseek-v4-flash" && c.d === D1 && c.b === 0);
	assert.ok(cell, "应有官方模型桶 0 格");
	// step1 终值 out=60（非 50+60=110）+ step2 out=10 → 70；in 1000+500；cr 200。
	assert.equal(cell.out, 70);
	assert.equal(cell.in, 1500);
	assert.equal(cell.cr, 200);
	assert.equal(cell.calls, 2);
});

test("流式递进采样：同 (turn,step) 多个 usage chunk 只计最后一个", async (t) => {
	setup(t);
	const log = makeLog();
	const events = [
		log("request/header", T(10, 0), { header: { config: { provider: "p1", model: "m1" } } }),
		log("assistant/chunk", T(10, 0), { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } } }),
		log("assistant/chunk", T(10, 0), { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 300, outputTokens: 40 } } }),
		log("assistant/chunk", T(10, 0), { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 300, outputTokens: 70 } } }),
	];
	const persistence = makePersistence([{ header: { id: "s1", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { s1: events });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	const cell = state.registered.wire.view().cells[0];
	assert.equal(cell.in, 300, "递进采样取最后值（100→300→300，差值法累计 300）");
	assert.equal(cell.out, 70, "输出取最后值");
	assert.equal(cell.calls, 1);
});

test("content-less 调用归因回落 request/header 的 provider/model", async (t) => {
	setup(t);
	const log = makeLog();
	const events = [
		log("request/header", T(10, 0), { header: { config: { provider: "fallback-provider", model: "fb-model" } } }),
		log("assistant/chunk", T(10, 0), { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } } }),
	];
	const persistence = makePersistence([{ header: { id: "s1", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { s1: events });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	const cell = state.registered.wire.view().cells[0];
	assert.equal(cell.p, "fallback-provider");
	assert.equal(cell.m, "fb-model");
});

test("provider/model 归因以 assistant/message.source 为准（会话中切换模型）", async (t) => {
	setup(t);
	const log = makeLog();
	const events = [
		log("request/header", T(10, 0), { header: { config: { provider: "old-provider", model: "old-model" } } }),
		log("assistant/message", T(10, 0), { turn: 1, step: 1, message: { source: { kind: "model", provider: "new-provider", model: "new-model" } }, usage: { inputTokens: 5, outputTokens: 1 } }),
	];
	const persistence = makePersistence([{ header: { id: "s1", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { s1: events });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	const cell = state.registered.wire.view().cells[0];
	assert.equal(cell.p, "new-provider");
	assert.equal(cell.m, "new-model");
});

// ── 工作区归并 / seed 去重 ────────────────────────────────────────────────

test("fork 子会话：seed 前缀跳过 + 消耗归并到根工作区", async (t) => {
	setup(t);
	const log = makeLog();
	const root = rootEvents(log);
	// seed 前缀 = 父日志 seq 0..4 的浅拷贝（seq 重映射为子日志自己的 0..4），随后是子会话自身的新事件。
	const child = [
		...root.slice(0, 5).map((e, i) => ({ ...e, seq: i })),
		{ type: "assistant/message", seq: 5, time: T(11, 30), data: { turn: 1, step: 9, message: { source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 100, outputTokens: 5 } } },
	];
	const persistence = makePersistence([
		{ header: { id: "root", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "rr" },
		{ header: { id: "child", createdAt: T(10, 0), parentSession: "root", seedLength: 5, delegationDepth: 1 }, revision: "rc" },
	], { root, child });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	const cell = state.registered.wire.view().cells.find((c) => c.w === W_ALPHA && c.p === "deepseek-official" && c.b === 0 && c.d === D1);
	// 根：step1(60) + step2(10) = 70；子：step9 = 5 → 75。seed 前缀（child 的 seq<5）不计。
	assert.equal(cell.out, 75);
	assert.equal(cell.in, 1600);
	assert.equal(cell.calls, 3);
});

test("父链断裂的孤儿子会话归 _orphan；深链归并到顶层 cwd", async (t) => {
	setup(t);
	const log = makeLog();
	const events = [
		log("request/header", T(10, 0), { header: { config: { provider: "p", model: "m" } } }),
		log("assistant/message", T(10, 0), { turn: 1, step: 1, message: { source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 7, outputTokens: 1 } }),
	];
	const grandchild = [
		log("request/header", T(10, 0), { header: { config: { provider: "p", model: "m" } } }),
		log("assistant/message", T(10, 0), { turn: 1, step: 1, message: { source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 11, outputTokens: 2 } }),
	];
	const persistence = makePersistence([
		{ header: { id: "top", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" },
		{ header: { id: "mid", createdAt: T(10, 0), parentSession: "top", delegationDepth: 1 }, revision: "r2" },
		{ header: { id: "deep", createdAt: T(10, 0), parentSession: "mid", delegationDepth: 2 }, revision: "r3" },
		{ header: { id: "orphan", createdAt: T(10, 0), parentSession: "gone", delegationDepth: 1 }, revision: "r4" },
	], { top: events, mid: [], deep: grandchild, orphan: [] });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	const cells = state.registered.wire.view().cells;
	const alphaIn = cells.filter((c) => c.w === W_ALPHA).reduce((s, c) => s + c.in, 0);
	assert.equal(alphaIn, 18, "深链（top←mid←deep）归并顶层 cwd：top 7 + deep 11");
	assert.ok(cells.every((c) => c.w !== "_orphan"), "孤儿空日志无 cell 但不抛错");
});

test("孤儿会话有日志时归 _orphan 工作区（总量保真、归因降级）", async (t) => {
	setup(t);
	const log = makeLog();
	const events = [
		log("assistant/chunk", T(10, 0), { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 9, outputTokens: 1 } } }),
	];
	const persistence = makePersistence([
		{ header: { id: "orphan", createdAt: T(10, 0), parentSession: "gone", delegationDepth: 1 }, revision: "r1" },
	], { orphan: events });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	const cell = state.registered.wire.view().cells.find((c) => c.w === "_orphan");
	assert.ok(cell, "孤儿样本归 _orphan");
	assert.equal(cell.in, 9);
});

// ── 桶边界 / 日键 ─────────────────────────────────────────────────────────

test("上下文桶边界：2 的幂对数桶（计费输入 = in+cr+cw）", async (t) => {
	setup(t);
	const log = makeLog();
	const sizes = [0, 4095, 4096, 8191, 8192, 131071, 131072, 200000];
	const events = sizes.map((n, i) => log("assistant/message", T(10, i), { turn: 1, step: i + 1, message: { source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: n, outputTokens: 0 } }));
	const persistence = makePersistence([{ header: { id: "s1", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { s1: events });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	const byBucket = new Map(state.registered.wire.view().cells.map((c) => [c.b, c]));
	const expected = { 0: [0, 4095], 1: [4096, 8191], 2: [8192], 5: [131071], 6: [131072, 200000] };
	for (const [b, ins] of Object.entries(expected)) {
		assert.equal(byBucket.get(Number(b)).in, ins.reduce((s, v) => s + v, 0), "桶 " + b);
	}
	assert.equal(byBucket.size, 5, "只出现 5 个桶（3、4 桶无样本）");
});

test("日键按本地时区自然日：23:59 与 00:01 分属两日", async (t) => {
	setup(t);
	const log = makeLog();
	const events = [
		log("assistant/message", new Date(2026, 7, 25, 23, 59, 0).getTime(), { turn: 1, step: 1, message: { source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 1, outputTokens: 1 } }),
		log("assistant/message", new Date(2026, 7, 26, 0, 1, 0).getTime(), { turn: 1, step: 2, message: { source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 2, outputTokens: 1 } }),
	];
	const persistence = makePersistence([{ header: { id: "s1", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { s1: events });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	const days = new Set(state.registered.wire.view().cells.map((c) => c.d));
	assert.deepEqual([...days].sort(), [D2, D1]);
});

// ── prices 合并 ────────────────────────────────────────────────────────────

test("prices 快照：内置官方价 ⊕ config.prices 覆盖/追加", async (t) => {
	setup(t);
	const log = makeLog();
	const events = [
		log("assistant/chunk", T(10, 0), { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } } }),
	];
	const persistence = makePersistence([{ header: { id: "s1", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { s1: events });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, {
		plugin: "tokstats",
		prices: {
			"third-party-x": { "some-model": { input: 2, inputCached: 0.2, output: 4 } },
			"deepseek-official": { "deepseek-v4-flash": { input: 99 } },
		},
	});
	await settle();
	const prices = state.registered.wire.view().prices;
	assert.equal(prices["deepseek-official"]["deepseek-v4-flash"].input, 99, "覆盖内置价");
	assert.equal(prices["deepseek-official"]["deepseek-v4-flash"].output, 9, "未覆盖字段保留内置值");
	assert.equal(prices["deepseek-official"]["deepseek-v4-pro"].input, 9, "未触碰的内置模型保留");
	assert.equal(prices["third-party-x"]["some-model"].output, 4, "追加第三方价");
});

// ── checkpoint / 对账 ─────────────────────────────────────────────────────

test("checkpoint 防抖落盘 + 二次启动 rev 命中零重扫 + 数据一致", async (t) => {
	const { cpPath } = setup(t);
	const log = makeLog();
	const root = rootEvents(log);
	const persistence = makePersistence([
		{ header: { id: "root", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" },
	], { root });
	const first = makeCtx({ persistence });
	mod.apply(first.ctx, { plugin: "tokstats" });
	await settle();
	assert.ok(existsSync(cpPath) === false, "防抖窗口内未落盘");
	t.mock.timers.tick(2000);
	await settle();
	assert.ok(existsSync(cpPath), "防抖后落盘");
	const cp = JSON.parse(readFileSync(cpPath, "utf8"));
	assert.equal(cp.schema, 1);
	assert.deepEqual(Object.keys(cp.sessions), ["root"]);
	assert.equal(cp.sessions.root.rev, "r1");

	// 二次启动：同 revision → inspect 计数不变
	const before = persistence.calls.inspect;
	const second = makeCtx({ persistence });
	mod.apply(second.ctx, { plugin: "tokstats" });
	await settle();
	assert.equal(persistence.calls.inspect, before, "rev 命中不重扫");
	const cells2 = second.state.registered.wire.view().cells;
	const official = cells2.find((c) => c.p === "deepseek-official");
	assert.ok(official && official.out === 70, "数据一致（终值替换语义随 checkpoint 往返保持）");
});

test("rev 变更的会话重扫，未变的复用", async (t) => {
	const { cpPath } = setup(t);
	const log1 = makeLog();
	const eventsA = [
		log1("request/header", T(10, 0), { header: { config: { provider: "p", model: "m" } } }),
		log1("assistant/message", T(10, 0), { turn: 1, step: 1, message: { source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 10, outputTokens: 1 } }),
	];
	const log2 = makeLog();
	const eventsB = [
		log2("request/header", T(10, 0), { header: { config: { provider: "p", model: "m" } } }),
		log2("assistant/message", T(10, 0), { turn: 1, step: 1, message: { source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 20, outputTokens: 2 } }),
	];
	const snapshots = [
		{ header: { id: "a", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "ra" },
		{ header: { id: "b", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "rb" },
	];
	const logsById = { a: eventsA, b: eventsB };
	const first = makeCtx({ persistence: makePersistence(snapshots, logsById) });
	mod.apply(first.ctx, { plugin: "tokstats" });
	await settle();
	t.mock.timers.tick(2000);
	await settle();

	// 二次启动：a 的 rev 变更（日志也变长），b 不变
	const snapshots2 = [snapshots[0], { ...snapshots[1], revision: "rb" }];
	snapshots2[0] = { ...snapshots[0], revision: "ra2" };
	logsById.a = [...eventsA, log1("assistant/message", T(11, 0), { turn: 1, step: 2, message: { source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 5, outputTokens: 1 } })];
	const second = makeCtx({ persistence: makePersistence(snapshots2, logsById) });
	mod.apply(second.ctx, { plugin: "tokstats" });
	await settle();
	const cells = second.state.registered.wire.view().cells;
	const totalIn = cells.reduce((s, c) => s + c.in, 0);
	assert.equal(totalIn, 10 + 5 + 20, "a 用新日志重折（15），b 复用旧折叠（20）");
});

test("checkpoint 损坏：丢弃并全量重扫（不抛错）", async (t) => {
	const { cpPath } = setup(t);
	mkdirSync(join(cpPath, ".."), { recursive: true });
	writeFileSync(cpPath, "{ broken json", "utf8");
	const warnCalls = [];
	const log = makeLog();
	const events = rootEvents(log);
	const persistence = makePersistence([{ header: { id: "root", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { root: events });
	t.mock.method(console, "warn", (...args) => { warnCalls.push(args.join(" ")); });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	assert.ok(warnCalls.some((w) => w.includes("checkpoint")), "损坏告警走 console.warn");
	const cell = state.registered.wire.view().cells.find((c) => c.p === "deepseek-official");
	assert.ok(cell, "全量重扫后数据完整");
	assert.equal(cell.out, 70);
	t.mock.timers.tick(2000);
	await settle();
	assert.equal(JSON.parse(readFileSync(cpPath, "utf8")).schema, 1, "重扫后写回合法 checkpoint");
});

// ── flush 增量 ────────────────────────────────────────────────────────────

test("session/flush 增量：lastSeq 续折不重扫，终值替换语义保持", async (t) => {
	setup(t);
	const log = makeLog();
	const root = rootEvents(log);
	const persistence = makePersistence([{ header: { id: "root", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { root });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();

	const flushedEvents = [
		...root,
		log("assistant/message", T(12, 0), { turn: 2, step: 1, message: { source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 10, outputTokens: 2 } }),
	];
	state.flushHandler({ id: "root", header: { id: "root", createdAt: T(10, 0), cwd: W_ALPHA }, events: flushedEvents });
	let cell = state.registered.wire.view().cells.find((c) => c.p === "deepseek-official" && c.b === 0);
	assert.equal(cell.calls, 3, "新增一步（旧 2 + 新 1）");
	assert.equal(cell.in, 1510);
	assert.equal(cell.out, 72);

	// flush 追加同 (turn,step) 终值：out 2 → 9（替换非叠加）
	state.flushHandler({
		id: "root",
		header: { id: "root", createdAt: T(10, 0), cwd: W_ALPHA },
		events: [...flushedEvents, log("assistant/message", T(12, 1), { turn: 2, step: 1, message: { source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 10, outputTokens: 9 } })],
	});
	cell = state.registered.wire.view().cells.find((c) => c.p === "deepseek-official" && c.b === 0);
	assert.equal(cell.calls, 3);
	assert.equal(cell.out, 79, "终值替换：72 - 2 + 9");
});

// ── projection 单元语义 ───────────────────────────────────────────────────

test("版本回声 apply：聚合版本变化返回新引用，未变返回同引用", async (t) => {
	setup(t);
	const log = makeLog();
	const events = rootEvents(log);
	const persistence = makePersistence([{ header: { id: "s1", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { s1: events });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	const def = state.registered;
	const s0 = def.init();
	const s1 = def.apply(s0, { type: "x", seq: 99, time: T(10, 0), data: {} });
	assert.notEqual(s1, s0, "初始状态落后于聚合版本 → 新引用");
	assert.ok(s1.v > 0);
	const s2 = def.apply(s1, { type: "x", seq: 100, time: T(10, 0), data: {} });
	assert.equal(s2, s1, "版本未变 → 同引用（零下游工作）");
	// 聚合变化（flush）后 apply 产生新引用
	state.flushHandler({ id: "s1", header: { id: "s1", createdAt: T(10, 0), cwd: W_ALPHA }, events: [...events, log("assistant/message", T(12, 0), { turn: 2, step: 1, message: { source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 1, outputTokens: 1 } })] });
	const s3 = def.apply(s2, { type: "x", seq: 101, time: T(10, 0), data: {} });
	assert.notEqual(s3, s2, "聚合版本变化 → 新引用（触发 push frame）");
	assert.ok(def.wire.viewSchema.parse(state.registered.wire.view()), "duck-type viewSchema 恒等通过");
});

// ── 降级矩阵（硬规则 6） ──────────────────────────────────────────────────

test("persistence 缺席：5s 后发布 no-persistence 完成态空数据", async (t) => {
	setup(t);
	const { ctx, state } = makeCtx({ persistence: null });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	assert.equal(state.registered.wire.view().complete, false, "宽限期内是统计中");
	t.mock.timers.tick(5000);
	const value = state.registered.wire.view();
	assert.equal(value.complete, true);
	assert.equal(value.reason, "no-persistence");
	assert.deepEqual(value.cells, []);
});

test("projection 缺席：聚合照跑、checkpoint 照写、仅 console 警告", async (t) => {
	const { cpPath } = setup(t);
	const log = makeLog();
	const events = rootEvents(log);
	const warns = [];
	const persistence = makePersistence([{ header: { id: "root", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { root: events });
	const { ctx, state } = makeCtx({ persistence, projections: false, loggerWarns: warns });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	assert.equal(state.registered, null, "无 projection 注册");
	t.mock.timers.tick(2000);
	await settle();
	assert.ok(existsSync(cpPath), "checkpoint 照写");
	assert.equal(JSON.parse(readFileSync(cpPath, "utf8")).sessions.root.cells !== undefined, true);
	t.mock.timers.tick(3000);
	assert.ok(warns.some((w) => w.includes("sessionProjections")), "缺席告警");
});

test("单会话 inspect 失败：跳过该会话，其余正常", async (t) => {
	setup(t);
	const log = makeLog();
	const events = rootEvents(log);
	const persistence = makePersistence([
		{ header: { id: "bad", createdAt: T(10, 0), cwd: "D:\\bad" }, revision: "r1" },
		{ header: { id: "good", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r2" },
	], { good: events }); // bad 的日志缺席 → inspect throw
	const warns = [];
	const { ctx, state } = makeCtx({ persistence, loggerWarns: warns });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	assert.ok(warns.some((w) => w.includes("bad")), "失败会话有日志告警");
	const cells = state.registered.wire.view().cells;
	assert.ok(cells.every((c) => c.w === W_ALPHA), "只有 good 的数据，bad 不在场");
	assert.equal(cells.find((c) => c.p === "deepseek-official").out, 70);
});

test("listSnapshots 失败：发布 scan-error 完成态空数据", async (t) => {
	setup(t);
	const persistence = makePersistence([], {});
	persistence.listSnapshots = async () => { throw new Error("disk gone"); };
	const warns = [];
	const { ctx, state } = makeCtx({ persistence, loggerWarns: warns });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	const value = state.registered.wire.view();
	assert.equal(value.complete, true);
	assert.equal(value.reason, "scan-error");
	assert.deepEqual(value.cells, []);
	assert.ok(warns.some((w) => w.includes("扫盘失败")));
});
