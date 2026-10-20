// promptopt host 半边测试：伪 cordis ctx + connection / llm 桩（test/host-harness.mjs），
// 走 lib/index.js 的真实 apply 管线。零依赖（AGENTS 硬规则 5）。
//
// 断言重点是「通道契约」而不是「优化质量」：质量是主观的、验收走目检，这里
// 钉的是宿主契约能不能站住——信封形状、错误码闭集、abort 是否贯穿、超时归谁。
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeConnectionStub, makeHostCtx, makeLlmStub, makeWebServerStub, textStream } from "./host-harness.mjs";

const mod = await import("../lib/index.js");

const CHANNEL = "/dsh-plugins.promptopt";
const USAGE = { inputTokens: 120, outputTokens: 40 };

/** 排空 async 微任务（路由解析 / 流消费的 await 链）。 */
async function settle() {
	for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
}

/** 起一个带 promptopt 通道的 host fiber。 */
async function boot({ llm, timeoutMs } = {}) {
	const server = makeWebServerStub();
	const connection = makeConnectionStub(server);
	const { ctx } = makeHostCtx({ connection, llm: llm ?? makeLlmStub().push(textStream("optimized", USAGE)), webServer: server });
	mod.apply(ctx, { plugin: "promptopt", ...(timeoutMs === undefined ? {} : { timeoutMs }) });
	await settle();
	return { connection, server };
}

// ── 分发与通道注册 ─────────────────────────────────────────────────────────

test("分发框架：config.plugin=promptopt 才注册通道，其他插件静默跳过", async () => {
	const server = makeWebServerStub();
	const connection = makeConnectionStub(server);
	const llm = makeLlmStub().push(textStream("x"));
	const { ctx } = makeHostCtx({ connection, llm, webServer: server });
	mod.apply(ctx, { plugin: "tokprev" });
	mod.apply(ctx, { plugin: "tokstats" });
	mod.apply(ctx, undefined);
	await settle();
	assert.equal(server.routes.length, 0, "非 promptopt 行不应注册通道");

	mod.apply(ctx, { plugin: "promptopt" });
	await settle();
	assert.equal(server.routes.length, 1);
});

test("通道名带 /dsh-plugins. 包前缀，且挂在 webServer 的 prefix 路由上", async () => {
	const { server } = await boot();
	assert.equal(server.routes.length, 1);
	const [entry] = server.routes;
	assert.equal(entry.path, CHANNEL);
	assert.equal(entry.kind, "prefix", "前缀挂载，端点由通道自己认领（与官方 RPC 通道同构）");
	assert.ok(entry.path.startsWith("/dsh-plugins."), "包前缀防第三方撞名（/api 是宿主保留字）");
	assert.equal(typeof entry.handler, "function");
});

test("connection 缺席 → 通道不注册，不抛错（硬规则 6 降级）", async () => {
	const llm = makeLlmStub().push(textStream("x"));
	const { ctx } = makeHostCtx({ llm }); // 只给 llm
	assert.doesNotThrow(() => mod.apply(ctx, { plugin: "promptopt" }));
	await settle();
});

test("llm 缺席 → 通道不注册，不抛错（硬规则 6 降级）", async () => {
	const server = makeWebServerStub();
	const connection = makeConnectionStub(server);
	// 只给 connection + webServer，不给 llm → inject 不触发
	const { ctx } = makeHostCtx({ connection, webServer: server });
	assert.doesNotThrow(() => mod.apply(ctx, { plugin: "promptopt" }));
	await settle();
	assert.equal(server.routes.length, 0);
});

// ── 成功路径 ───────────────────────────────────────────────────────────────

test("成功：value 信封承载优化文 / 耗时 / usage（摊平会被客户端 zod strip）", async () => {
	const llm = makeLlmStub().push(textStream("更好的提示词", USAGE));
	const { connection } = await boot({ llm });
	const result = await connection.invoke(CHANNEL, "optimize", { text: "帮我写点东西" });
	assert.equal(result.ok, true);
	assert.equal(result.value.text, "更好的提示词");
	assert.equal(typeof result.value.durationMs, "number");
	assert.deepEqual(result.value.usage, USAGE);
});

test("llm 桩收到 meta-prompt 与草稿全文，且不带会话上下文（Q4）", async () => {
	const llm = makeLlmStub().push(textStream("optimized"));
	const { connection } = await boot({ llm });
	await connection.invoke(CHANNEL, "optimize", { text: "写个排序函数" });
	const options = llm.calls[0].options;

	assert.equal(llm.calls.length, 1, "一次 optimize 只应触发一次模型调用");
	assert.equal(options.messages.length, 1, "只送一条 user message，无会话历史");
	assert.equal(options.messages[0].role, "user");
	assert.deepEqual(options.messages[0].content, [{ type: "text", text: "写个排序函数" }]);
	assert.equal(options.messages[0].source.kind, "plugin");
	assert.equal(typeof options.messages[0].id, "string", "Message.id 必填");

	// meta-prompt 走 system 槽位（内容轴不进词典，故按特征断言）。
	assert.equal(typeof options.system, "string");
	// I11：五条约束齐备，且禁新增条款必须在场。
	for (const marker of ["1.", "2.", "3.", "4.", "5.", "same language as the draft", "Do not add facts"]) {
		assert.ok(options.system.includes(marker), `meta-prompt 应含 ${marker}`);
	}
	// I11 的反向断言：旧「补充缺失上下文」句必须消失。它的存在与「禁新增事实」
	// 直接冲突——两句同时在场时模型会照着前一句补内容。
	assert.ok(!options.system.includes("add the context"), "不得再要求模型补充原文没有的上下文");
	assert.ok(!options.system.includes("1.5x"), "长度倍数约束已由「只重排不扩写」取代");
	assert.match(options.system, /leave it exactly as written/, "F1 保守失败条款在场");
	assert.match(options.system, /already structured enough/, "F4 无需整理条款在场");
	// purpose 是 'compaction' | 'session-title' 闭集，自定义值会被拒 → 必须省略。
	assert.equal(options.purpose, undefined);
});

test("路由按注册序取首个可用 provider/model（零配置面，Q6）", async () => {
	const llm = makeLlmStub().push(textStream("optimized"));
	llm.providers = [{ id: "p-first", name: "First" }, { id: "p-second", name: "Second" }];
	llm.models = [
		{ provider: "p-first", id: "m-a", name: "A" },
		{ provider: "p-first", id: "m-b", name: "B" },
		{ provider: "p-second", id: "m-c", name: "C" },
	];
	const { connection } = await boot({ llm });
	await connection.invoke(CHANNEL, "optimize", { text: "draft" });
	assert.equal(llm.calls[0].options.provider, "p-first");
	assert.equal(llm.calls[0].options.model, "m-a");
});

test("usage 缺席时不下发该字段（允许差异：拿不到就不显示）", async () => {
	const llm = makeLlmStub().push(textStream("optimized")); // textStream 不传 usage
	const { connection } = await boot({ llm });
	const result = await connection.invoke(CHANNEL, "optimize", { text: "draft" });
	assert.equal(result.ok, true);
	assert.equal("usage" in result.value, false);
});

// ── 错误码映射 ─────────────────────────────────────────────────────────────

test("草稿预检：空 / 非字符串 / 超长 → bad-request", async () => {
	const llm = makeLlmStub().push(textStream("optimized"));
	const { connection } = await boot({ llm });
	for (const payload of [{ text: "" }, { text: "   " }, {}, { text: 42 }, { text: "x".repeat(65537) }, null]) {
		const result = await connection.invoke(CHANNEL, "optimize", payload);
		assert.equal(result.ok, false, `payload ${JSON.stringify(payload)} 应被拒`);
		assert.equal(result.error.code, "bad-request");
	}
	assert.equal(llm.calls.length, 0, "预检失败不应触发模型调用");
});

test("上限按 UTF-16 长度卡（与浏览器 String.length 同口径）", async () => {
	const { connection } = await boot();
	const atLimit = await connection.invoke(CHANNEL, "optimize", { text: "x".repeat(65536) });
	assert.equal(atLimit.ok, true, "恰好等于上限应放行");
});

test("llm 流抛错 → model-unavailable（不占用只留给超时的 internal）", async () => {
	const llm = makeLlmStub().push(new Error("provider down"));
	const { connection } = await boot({ llm });
	const result = await connection.invoke(CHANNEL, "optimize", { text: "draft" });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "model-unavailable");
	assert.deepEqual(result.error.details, { provider: "deepseek-official", model: "deepseek-v4-flash" });
});

test("模型产出为空 / finish 非 stop → model-unavailable", async () => {
	const empty = makeLlmStub().push([
		{ type: "text-delta", index: 0, text: "   " },
		{ type: "finish", reason: { kind: "stop" } },
	]);
	const { connection: c1 } = await boot({ llm: empty });
	assert.equal((await c1.invoke(CHANNEL, "optimize", { text: "d" })).error.code, "model-unavailable");

	const truncated = makeLlmStub().push([
		{ type: "text-delta", index: 0, text: "partial" },
		{ type: "finish", reason: { kind: "max-tokens" } },
	]);
	const { connection: c2 } = await boot({ llm: truncated });
	assert.equal((await c2.invoke(CHANNEL, "optimize", { text: "d" })).error.code, "model-unavailable");
});

test("无已注册路由 → model-unavailable（details 用 unknown 占位满足 schema）", async () => {
	const llm = makeLlmStub().push(textStream("optimized"));
	llm.providers = [];
	const { connection } = await boot({ llm });
	const result = await connection.invoke(CHANNEL, "optimize", { text: "draft" });
	assert.equal(result.error.code, "model-unavailable");
	assert.deepEqual(result.error.details, { provider: "unknown", model: "unknown" });
	assert.equal(llm.calls.length, 0, "无路由不应发起调用");
});

test("端点不匹配 → bad-request（通道是前缀挂载，端点要自己认领）", async () => {
	const { connection } = await boot();
	// 通道前缀认领后，未知端点由实现自己判 bad-request
	const result = await connection.invoke(CHANNEL, "something-else", { text: "draft" });
	assert.equal(result.error.code, "bad-request");
});

test("错误响应不含人类可读文案：message 就是机器码（不变量 3）", async () => {
	const llm = makeLlmStub().push(new Error("boom"));
	const { connection } = await boot({ llm });
	const result = await connection.invoke(CHANNEL, "optimize", { text: "draft" });
	assert.equal(result.error.message, result.error.code, "host 侧无 locale 服务，不得拼人类可读串");
});

// ── 取消与超时 ─────────────────────────────────────────────────────────────

test("abort 贯穿：浏览器取消 → model 调用被中止，返回 cancelled", async () => {
	const llm = makeLlmStub().push("hang");
	const { connection } = await boot({ llm });
	const controller = new AbortController();
	const pending = connection.invoke(CHANNEL, "optimize", { text: "draft" }, controller.signal);
	await settle();
	assert.equal(llm.calls.length, 1, "调用应已发起");
	controller.abort();
	await settle();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "cancelled");
	assert.equal(llm.calls[0].aborted, true, "llm 调用必须感知到中止（不留残余调用）");
});

test("进入时已 abort → cancelled，且不发起模型调用", async () => {
	const llm = makeLlmStub().push(textStream("optimized"));
	const { connection } = await boot({ llm });
	const controller = new AbortController();
	controller.abort();
	const result = await connection.invoke(CHANNEL, "optimize", { text: "draft" }, controller.signal);
	assert.equal(result.error.code, "cancelled");
	assert.equal(llm.calls.length, 0, "已取消的请求不该烧 token");
});

test("60s 截止（测试注入 5ms）：超时 → internal，且链路被中止", async () => {
	const llm = makeLlmStub().push("hang");
	const { connection } = await boot({ llm, timeoutMs: 5 });
	const controller = new AbortController();
	const result = await connection.invoke(CHANNEL, "optimize", { text: "draft" }, controller.signal);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "internal");
	assert.equal(llm.calls[0].aborted, true, "超时必须中止 in-flight 调用，不能继续烧");
	controller.abort(); // 收尾：确认宿主 signal 上的监听已摘除，不残留
});

test("超时与用户取消同时发生时，取消优先（弹层已关，超时文案无意义）", async () => {
	const llm = makeLlmStub().push("hang");
	const { connection } = await boot({ llm, timeoutMs: 5 });
	const controller = new AbortController();
	const pending = connection.invoke(CHANNEL, "optimize", { text: "draft" }, controller.signal);
	controller.abort();
	await settle();
	const result = await pending;
	assert.equal(result.error.code, "cancelled");
});

// ── noChange 形态（F4 / AC-12） ────────────────────────────────────────────

test("noChange：产出与原文等价时置真（弹层据此禁用采纳）", async () => {
	const draft = "改一下 README 的标题";
	// 模型原样返回（含首尾空白差异）→ 视为无需整理
	const llm = makeLlmStub().push(textStream("  " + draft + "  "));
	const { connection } = await boot({ llm });
	const result = await connection.invoke(CHANNEL, "optimize", { text: draft });
	assert.equal(result.ok, true);
	assert.equal(result.value.noChange, true, "产出与原文等价");
	assert.equal(result.value.text, draft);
});

test("noChange：产出确有变化时为假", async () => {
	const llm = makeLlmStub().push(textStream("- 改标题\n- 保持正文"));
	const { connection } = await boot({ llm });
	const result = await connection.invoke(CHANNEL, "optimize", { text: "帮我改下标题，正文别动" });
	assert.equal(result.ok, true);
	assert.equal(result.value.noChange, false);
});

// ── 计数器（候选 A：storageDomain；AC-13） ─────────────────────────────────

/** 伪 storageDomain：内存表 + open 计数；open 可配置为抛错。 */
function makeStorageDomain({ failOpen = false } = {}) {
	const records = new Map();
	const calls = { open: 0, put: 0, close: 0 };
	const table = {
		get: (key) => records.get(key),
		put: async (key, value) => {
			calls.put += 1;
			records.set(key, value);
		},
	};
	const stub = {
		calls,
		records,
		async open(spec) {
			calls.open += 1;
			if (failOpen) throw new Error("version-mismatch");
			return {
				table: () => table,
				close: async () => { calls.close += 1; },
			};
		},
	};
	return stub;
}

/** 起一个同时挂上 storageDomain 的 host fiber。 */
async function bootWithDomain({ domain, llm } = {}) {
	const server = makeWebServerStub();
	const connection = makeConnectionStub(server);
	const { ctx } = makeHostCtx({ connection, llm: llm ?? makeLlmStub().push(textStream("optimized")), webServer: server });
	// makeHostCtx 只认识 connection/llm/webServer；storageDomain 走 patch 注入面补上。
	const inject = ctx.inject;
	ctx.inject = (names, cb) => {
		if (names.includes("storageDomain")) {
			const pctx = { storageDomain: domain };
			return cb(pctx);
		}
		return inject(names, cb);
	};
	mod.apply(ctx, { plugin: "promptopt" });
	await settle();
	return connection;
}

test("计数器：发起 / 采纳 / 放弃各记一次，采纳累加字符增减量", async () => {
	const domain = makeStorageDomain();
	const connection = await bootWithDomain({ domain });

	// 两次发起（各一次成功 optimize）
	await connection.invoke(CHANNEL, "optimize", { text: "abcd" });
	await connection.invoke(CHANNEL, "optimize", { text: "efgh" });
	// 一次采纳：原文 4 字符 → 产出 10 字符，+6
	await connection.invoke(CHANNEL, "event", { event: "adopted", before: 4, after: 10 });
	// 一次放弃
	await connection.invoke(CHANNEL, "event", { event: "dismissed" });

	const counters = await connection.invoke(CHANNEL, "counters");
	assert.equal(counters.ok, true);
	assert.equal(counters.value.started, 2);
	assert.equal(counters.value.adopted, 1);
	assert.equal(counters.value.dismissed, 1);
	assert.equal(counters.value.charsDelta, 6);
});

test("计数器：字符增减量可为负（结构化重排往往更短）", async () => {
	const domain = makeStorageDomain();
	const connection = await bootWithDomain({ domain });
	await connection.invoke(CHANNEL, "event", { event: "adopted", before: 40, after: 25 });
	const counters = await connection.invoke(CHANNEL, "counters");
	assert.equal(counters.value.charsDelta, -15);
});

test("计数器：storageDomain 缺席时端点仍在、计数全零（I8 软依赖降级）", async () => {
	const { connection } = await boot();
	const counters = await connection.invoke(CHANNEL, "counters");
	assert.equal(counters.ok, true, "无计数器域也必须能应答");
	assert.deepEqual(counters.value, { started: 0, adopted: 0, dismissed: 0, charsDelta: 0 });
});

test("计数器：域打不开（版本不符）时记警告并停用，不阻断 optimize", async () => {
	const warns = [];
	const domain = makeStorageDomain({ failOpen: true });
	const server = makeWebServerStub();
	const connection = makeConnectionStub(server);
	const llm = makeLlmStub().push(textStream("optimized"));
	const { ctx } = makeHostCtx({ connection, llm, webServer: server, loggerWarns: warns });
	const inject = ctx.inject;
	ctx.inject = (names, cb) => {
		if (names.includes("storageDomain")) return cb({ storageDomain: domain });
		return inject(names, cb);
	};
	mod.apply(ctx, { plugin: "promptopt" });
	await settle();

	assert.ok(warns.some((w) => w.includes("计数器域不可用")), "应记录降级原因");
	const result = await connection.invoke(CHANNEL, "optimize", { text: "draft" });
	assert.equal(result.ok, true, "计数器坏掉不得阻断优化");
});

test("计数器：未知事件名返回 bad-request 且不计数", async () => {
	const domain = makeStorageDomain();
	const connection = await bootWithDomain({ domain });
	const result = await connection.invoke(CHANNEL, "event", { event: "bogus" });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "bad-request");
	const counters = await connection.invoke(CHANNEL, "counters");
	assert.equal(counters.value.adopted, 0);
});

test("计数器：非整数长度参数按 0 处理（不写入 NaN）", async () => {
	const domain = makeStorageDomain();
	const connection = await bootWithDomain({ domain });
	await connection.invoke(CHANNEL, "event", { event: "adopted", before: Number.NaN, after: "x" });
	const counters = await connection.invoke(CHANNEL, "counters");
	assert.equal(counters.value.charsDelta, 0);
	assert.equal(counters.value.adopted, 1);
});

test("计数器域打不开时往 stderr 写一行诊断（logger.warn 不落宿主 stdout，静默失败最难查）", async () => {
	const domain = makeStorageDomain({ failOpen: true });
	const server = makeWebServerStub();
	const connection = makeConnectionStub(server);
	const { ctx } = makeHostCtx({ connection, llm: makeLlmStub().push(textStream("x")), webServer: server });
	const inject = ctx.inject;
	ctx.inject = (names, cb) => (names.includes("storageDomain") ? cb({ storageDomain: domain }) : inject(names, cb));

	const written = [];
	const original = process.stderr.write;
	process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
	try {
		mod.apply(ctx, { plugin: "promptopt" });
		await settle();
	} finally {
		process.stderr.write = original;
	}
	assert.ok(written.some((line) => line.includes("[dsh-plugins]") && line.includes("计数器域不可用")), "应留下可检索的诊断行");
});







