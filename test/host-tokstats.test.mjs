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
 *
 * `list` 如实建模 rc.2 语义（返回不含 revision 的 `SessionHeader[]`）并计数：
 * 0.1.3-alpha.2 起同名方法改成返回带 revision 的快照，实现若图省事把
 * `listSnapshots()` 直接改名为 `list()`，在 rc.2 上会静默丢掉全部 revision——
 * 有计数就能把这条钉死。
 */
function makePersistence(snapshots, logsById, headersById) {
	const calls = { listSnapshots: 0, inspect: 0, list: 0 };
	const stub = {
		calls,
		async listSnapshots() {
			calls.listSnapshots += 1;
			return snapshots;
		},
		async list() {
			calls.list += 1;
			return snapshots.map((s) => s.header);
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
			// 同 handle 桩：`then` 是引擎的 thenable 探测，不是插件在调方法。
			if (key === "then") return undefined;
			if (typeof key === "symbol" || key in obj) return Reflect.get(obj, key);
			throw new Error(`tokstats 调了 persistence.${String(key)}：真实 ctx.sessionPersistence 面上没有这个方法`);
		},
	});
}

/**
 * 新服务面（`SessionPersistence`，dsh-session-persistence 0.1.3-alpha.2 起）。
 * 逐项抄自 `verify-host-contract.py --surface SessionPersistence` 在 0.1.5-rc.1 的输出。
 * 与 rc.2 是**硬差异**而非子集：`inspect` / `listSnapshots` 被移除，`list()` 改成
 * 返回带 revision 的快照（0.1.2-rc.1 共 13 个成员收尾于 `inspect`，0.1.3-alpha.2 起
 * 只剩这 5 个且带 `open`——两代无共存窗口，故可用 `"open" in persistence` 当版本哨兵）。
 */
const SESSION_PERSISTENCE_SURFACE_V2 = ["create", "open", "flush", "stat", "list"];

/** `SessionHandle` 成员面（同版本 `--file package/lib/types/handle.d.ts --surface SessionHandle`）。 */
const SESSION_HANDLE_SURFACE = ["id", "header", "inheritedEventCount", "access", "read", "append", "flush", "close"];

/**
 * 伪 `SessionHandle`：成员面按真实声明写全，面外成员一律抛错。
 * `inheritedEventCount` 刻意从独立的 inheritById 取而不是读 `header.seedLength`——
 * 新版把 fork 前缀长度从 header 挪到了这个手柄字段上，若从 header 兜，
 * 「实现漏改、继续读 meta.seedLength」这条静默错误就测不出来了。
 */
function makeHandleStub(id, header, events, calls, access, inheritedEventCount) {
	const handle = {
		id,
		header,
		inheritedEventCount,
		access,
		async read() {
			calls.read += 1;
			if (calls.failRead === true) throw new Error("read failed: " + id);
			return { eventState: "shared", events };
		},
		async append() {
			throw new Error("本桩不覆盖写路径");
		},
		async flush() {
			throw new Error("本桩不覆盖写路径");
		},
		async close() {
			calls.close += 1;
			if (calls.failClose === true) throw new Error("close failed: " + id);
		},
	};
	return new Proxy(handle, {
		get(obj, key) {
			// `then` 是 JS 引擎的 thenable 探测（async 函数 return 值、await 都会读它），
			// 不是本插件在调方法；真实对象没有 then 只会得到 undefined，不会抛。
			if (key === "then") return undefined;
			if (typeof key === "symbol" || key in obj) return Reflect.get(obj, key);
			throw new Error(`tokstats 调了 handle.${String(key)}：真实 SessionHandle 面上没有这个成员`);
		},
	});
}

/**
 * 伪 persistence（新服务面）：会话读取走 `open(id,'read')` 手柄。
 * 同款保真度闸门（面外方法抛错）；`accesses` 记账供断言读路径只用 read 权限
 * （误用 'write' 会抢单写所有权，是真实存在的并发缺陷）。
 */
function makePersistenceV2(snapshots, logsById, headersById, inheritById) {
	const calls = { list: 0, open: 0, read: 0, close: 0, accesses: [], failRead: false, failClose: false };
	const stub = {
		calls,
		async create() {
			throw new Error("本桩不覆盖建会话路径");
		},
		async open(id, access) {
			calls.open += 1;
			calls.accesses.push(access);
			const events = logsById[id];
			if (events === undefined) throw new Error("not found: " + id);
			const header = snapshots.find((s) => s.header.id === id)?.header ?? headersById?.[id] ?? { id };
			return makeHandleStub(id, header, events, calls, access, inheritById?.[id] ?? 0);
		},
		async flush() {
			throw new Error("本桩不覆盖全库 flush");
		},
		async stat() {
			throw new Error("本桩不覆盖 stat");
		},
		async list() {
			calls.list += 1;
			return snapshots;
		},
	};
	return new Proxy(stub, {
		get(obj, key) {
			// 同 handle 桩：`then` 是引擎的 thenable 探测，不是插件在调方法。
			if (key === "then") return undefined;
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

test("伪 persistence（新服务面）只提供真实服务面内的方法", () => {
	const stub = makePersistenceV2([], {});
	const extra = Object.keys(stub).filter((k) => k !== "calls" && !SESSION_PERSISTENCE_SURFACE_V2.includes(k));
	assert.deepEqual(extra, [], "桩造出宿主没有的方法，会让用错 API 的实现也全绿");
});

test("两代服务面的允许清单不重叠地覆盖差异（inspect/listSnapshots ↔ open/stat）", () => {
	// 防止日后有人把两份清单合并成一份「并集」——那会让桩同时提供两代的方法，
	// 版本哨兵就再也测不出「实现写死了某一代」。
	assert.deepEqual(SESSION_PERSISTENCE_SURFACE_V2.filter((k) => SESSION_PERSISTENCE_SURFACE.includes(k)), ["create", "list"]);
	assert.ok(!SESSION_PERSISTENCE_SURFACE.includes("open"));
	assert.ok(!SESSION_PERSISTENCE_SURFACE_V2.includes("inspect"));
});

test("伪 SessionHandle 的成员面等于真实声明", async () => {
	const stub = makePersistenceV2([{ header: { id: "s1" }, revision: "r1" }], { s1: [] });
	const handle = await stub.open("s1", "read");
	assert.deepEqual(Object.keys(handle).sort(), [...SESSION_HANDLE_SURFACE].sort(), "手柄桩多/少成员都测不出真缺陷");
});

test("手柄读面外成员抛错：桩不替宿主兜底", async () => {
	const stub = makePersistenceV2([{ header: { id: "s1" }, revision: "r1" }], { s1: [] });
	const handle = await stub.open("s1", "read");
	assert.throws(() => handle.readFrom, /handle\.readFrom/);
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

test("扫尾补折：会话不在快照表时补折结果仍落盘（不因取 revision 失败而丢）", async (t) => {
	setup(t);
	const log = makeLog();
	const events = rootEvents(log);
	const liveLog = makeLog();
	const liveEvents = [
		liveLog("request/header", T(10, 0), { header: { config: { provider: "live-p", model: "live-m" } } }),
		liveLog("assistant/message", T(10, 5), { turn: 1, step: 1, message: { source: { kind: "model", provider: "live-p", model: "live-m" } }, usage: { inputTokens: 7, outputTokens: 3 } }),
	];
	const snapshots = [{ header: { id: "root", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }];
	const persistence = makePersistence(snapshots, { root: events, live: liveEvents }, { live: { id: "live", createdAt: T(10, 0), cwd: W_ALPHA } });

	// 把扫盘卡在 listSnapshots 上，制造「扫描中收到 flush」的窗口。
	let release = null;
	const gate = new Promise((r) => { release = r; });
	let gated = true;
	const inner = persistence.listSnapshots;
	persistence.listSnapshots = async () => {
		if (gated) {
			gated = false;
			await gate;
		}
		return inner();
	};

	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	assert.equal(state.registered.wire.view().complete, false, "扫盘仍停在 scanning");

	// live 不在快照表里：主循环末尾 agg.sessions = next 会把它整个抹掉，
	// 只剩扫尾补折能救回来。补折里取 revision 失败不能把这份数据一起带走。
	state.flushHandler({ id: "live", header: { id: "live", createdAt: T(10, 0), cwd: W_ALPHA }, events: liveEvents });
	release(snapshots);
	await settle();

	const cell = state.registered.wire.view().cells.find((c) => c.m === "live-m");
	assert.ok(cell, "live 会话的统计没有被扫尾补折丢掉");
	assert.equal(cell.out, 3);
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

// ── 新服务面（0.1.3-alpha.2+）路径 ────────────────────────────────────────
//
// 跨版本适配的正确性只能靠「同一份 fixture 喂两代桩、产出必须一致」来钉：
// 两代的方法名、返回形状、fork 前缀字段来源都不同，任何一处映射错了，
// 都会表现为静默的统计偏差而不是报错。

test("两代服务面产出逐格一致（list/snapshots vs inspect）", async (t) => {
	setup(t);
	const log = makeLog();
	const events = rootEvents(log);
	const snapshots = [{ header: { id: "s1", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }];
	const old = makeCtx({ persistence: makePersistence(snapshots, { s1: events }) });
	mod.apply(old.ctx, { plugin: "tokstats" });
	await settle();
	const next = makeCtx({ persistence: makePersistenceV2(snapshots, { s1: events }) });
	mod.apply(next.ctx, { plugin: "tokstats" });
	await settle();
	const cellOld = old.state.registered.wire.view().cells;
	const cellNext = next.state.registered.wire.view().cells;
	assert.ok(cellOld.length > 0, "旧路径有产出，比对才有意义");
	assert.deepEqual(cellNext, cellOld, "两代路径的折叠结果必须逐格一致");
	assert.equal(next.state.registered.wire.view().complete, true, "新路径扫盘正常收尾");
});

test("新服务面 fork 前缀去重：靠 handle.inheritedEventCount（header 已无 seedLength）", async (t) => {
	setup(t);
	const log = makeLog();
	const root = rootEvents(log);
	// seed 前缀 = 父日志 seq 0..4 的浅拷贝（seq 重映射为子日志自己的 0..4）。
	const child = [
		...root.slice(0, 5).map((e, i) => ({ ...e, seq: i })),
		{ type: "assistant/message", seq: 5, time: T(11, 30), data: { turn: 1, step: 9, message: { source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 100, outputTokens: 5 } } },
	];
	// 新版 header 只有 isSeeded，前缀长度在 storage metadata 上（手柄字段）。
	const persistence = makePersistenceV2(
		[
			{ header: { id: "root", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "rr" },
			{ header: { id: "child", createdAt: T(10, 0), parentSession: "root", isSeeded: true, delegationDepth: 1 }, revision: "rc" },
		],
		{ root, child },
		undefined,
		{ child: 5 },
	);
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	const cell = state.registered.wire.view().cells.find((c) => c.w === W_ALPHA && c.p === "deepseek-official" && c.b === 0 && c.d === D1);
	// 根 70 + 子 step9 = 5 → 75；若漏读 inheritedEventCount，子会话的 seed 前缀
	// 会被重复计入，out 会变成 75 + 70 = 145。
	assert.equal(cell.out, 75);
	assert.equal(cell.in, 1600);
	assert.equal(cell.calls, 3);
});

test("新服务面读日志只用 read 权限（误用 write 会抢单写所有权）", async (t) => {
	setup(t);
	const log = makeLog();
	const events = rootEvents(log);
	const persistence = makePersistenceV2([{ header: { id: "s1", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { s1: events });
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	assert.ok(persistence.calls.accesses.length > 0, "确实开过手柄");
	assert.deepEqual([...new Set(persistence.calls.accesses)], ["read"], "只允许 read");
	assert.ok(state.registered.wire.view().cells.length > 0);
});

test("手柄 close 抛错不掩盖已读到的日志", async (t) => {
	setup(t);
	const log = makeLog();
	const events = rootEvents(log);
	const persistence = makePersistenceV2([{ header: { id: "s1", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { s1: events });
	persistence.calls.failClose = true;
	const { ctx, state } = makeCtx({ persistence });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	assert.equal(persistence.calls.close, 1, "确实走到了 close 且它抛了");
	const cell = state.registered.wire.view().cells.find((c) => c.p === "deepseek-official");
	assert.ok(cell, "close 抖动不该把整个会话判成读取失败");
	assert.equal(cell.out, 70);
});

test("新服务面单会话 read 失败：跳过该会话，其余正常", async (t) => {
	setup(t);
	const log = makeLog();
	const events = rootEvents(log);
	const persistence = makePersistenceV2([
		{ header: { id: "bad", createdAt: T(10, 0), cwd: "D:\\bad" }, revision: "r1" },
		{ header: { id: "good", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r2" },
	], { bad: events, good: events });
	// bad 的 read 抛错、good 正常：用 id 分流。
	const inner = persistence.open;
	persistence.open = async (id, access) => {
		const handle = await inner(id, access);
		if (id === "bad") handle.read = async () => { throw new Error("read blew up: bad"); };
		return handle;
	};
	const warns = [];
	const { ctx, state } = makeCtx({ persistence, loggerWarns: warns });
	mod.apply(ctx, { plugin: "tokstats" });
	await settle();
	assert.ok(warns.some((w) => w.includes("bad")), "失败会话有日志告警");
	const cells = state.registered.wire.view().cells;
	assert.ok(cells.every((c) => c.w === W_ALPHA), "只有 good 的数据");
	assert.equal(cells.find((c) => c.p === "deepseek-official").out, 70);
});

test("旧服务面不误调 list()：rc.2 的 list 返回 header[]，认名字换名会丢掉全部 revision", async (t) => {
	const { cpPath } = setup(t);
	const log = makeLog();
	const events = rootEvents(log);
	const persistence = makePersistence([{ header: { id: "root", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "r1" }], { root: events });
	const first = makeCtx({ persistence });
	mod.apply(first.ctx, { plugin: "tokstats" });
	await settle();
	t.mock.timers.tick(2000);
	await settle();
	assert.equal(persistence.calls.list, 0, "旧路径必须走 listSnapshots");
	assert.equal(JSON.parse(readFileSync(cpPath, "utf8")).sessions.root.rev, "r1", "revision 确实落进了 checkpoint");
});

test("新服务面对账等效：rev 命中零重读，变更才重折", async (t) => {
	const { cpPath } = setup(t);
	const log1 = makeLog();
	const eventsA = [
		log1("request/header", T(10, 0), { header: { config: { provider: "p", model: "m" } } }),
		log1("assistant/message", T(10, 0), { turn: 1, step: 1, message: { source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 10, outputTokens: 1 } }),
	];
	const logsById = { a: eventsA };
	const persistence = makePersistenceV2([{ header: { id: "a", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "ra" }], logsById);
	const first = makeCtx({ persistence });
	mod.apply(first.ctx, { plugin: "tokstats" });
	await settle();
	t.mock.timers.tick(2000);
	await settle();
	assert.equal(JSON.parse(readFileSync(cpPath, "utf8")).sessions.a.rev, "ra");

	// 二次启动：同 revision → 不再开手柄读日志
	const before = persistence.calls.open;
	const second = makeCtx({ persistence });
	mod.apply(second.ctx, { plugin: "tokstats" });
	await settle();
	assert.equal(persistence.calls.open, before, "rev 命中不重读日志");
	assert.equal(second.state.registered.wire.view().cells.reduce((s, c) => s + c.in, 0), 10, "复用 checkpoint 数据");

	// rev 变更 → 重折
	logsById.a = [...eventsA, log1("assistant/message", T(11, 0), { turn: 1, step: 2, message: { source: { kind: "model", provider: "p", model: "m" } }, usage: { inputTokens: 5, outputTokens: 1 } })];
	const third = makeCtx({ persistence: makePersistenceV2([{ header: { id: "a", createdAt: T(10, 0), cwd: W_ALPHA }, revision: "ra2" }], logsById) });
	mod.apply(third.ctx, { plugin: "tokstats" });
	await settle();
	assert.equal(third.state.registered.wire.view().cells.reduce((s, c) => s + c.in, 0), 15, "rev 变更后重折");
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
