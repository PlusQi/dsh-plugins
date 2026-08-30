// promptopt host 半边测试：伪 cordis ctx + connection / llm 桩（test/host-harness.mjs），
// 走 lib/index.js 的真实 apply 管线。零依赖（AGENTS 硬规则 5）。
//
// 断言重点是「通道契约」而不是「优化质量」：质量是主观的、验收走目检，这里
// 钉的是宿主契约能不能站住——信封形状、错误码闭集、abort 是否贯穿、超时归谁。
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeConnectionStub, makeHostCtx, makeLlmStub, textStream } from "./host-harness.mjs";

const mod = await import("../lib/index.js");

const CHANNEL = "/dsh-plugins.promptopt";
const USAGE = { inputTokens: 120, outputTokens: 40 };

/** 排空 async 微任务（路由解析 / 流消费的 await 链）。 */
async function settle() {
	for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
}

/** 起一个带 promptopt 通道的 host fiber。 */
async function boot({ llm, timeoutMs } = {}) {
	const connection = makeConnectionStub();
	const { ctx } = makeHostCtx({ connection, llm: llm ?? makeLlmStub().push(textStream("optimized", USAGE)) });
	mod.apply(ctx, { plugin: "promptopt", ...(timeoutMs === undefined ? {} : { timeoutMs }) });
	await settle();
	return connection;
}

// ── 分发与通道注册 ─────────────────────────────────────────────────────────

test("分发框架：config.plugin=promptopt 才注册通道，其他插件静默跳过", async () => {
	const connection = makeConnectionStub();
	const llm = makeLlmStub().push(textStream("x"));
	const { ctx } = makeHostCtx({ connection, llm });
	mod.apply(ctx, { plugin: "tokprev" });
	mod.apply(ctx, { plugin: "tokstats" });
	mod.apply(ctx, undefined);
	await settle();
	assert.equal(connection.registrations.length, 0, "非 promptopt 行不应注册通道");

	mod.apply(ctx, { plugin: "promptopt" });
	await settle();
	assert.equal(connection.registrations.length, 1);
});

test("通道名带 /dsh-plugins. 包前缀且 authority 必填（不变量 8 + 位置事实）", async () => {
	const connection = await boot();
	const [entry] = connection.registrations;
	assert.equal(entry.channel, CHANNEL);
	assert.ok(entry.channel.startsWith("/dsh-plugins."), "包前缀防第三方撞名（/api 是宿主保留字）");
	assert.deepEqual(entry.options, { authority: "trusted-host" });
	assert.equal(typeof entry.handler, "function");
});

test("connection 缺席 → 通道不注册，不抛错（硬规则 6 降级）", async () => {
	const llm = makeLlmStub().push(textStream("x"));
	const { ctx } = makeHostCtx({ llm }); // 只给 llm
	assert.doesNotThrow(() => mod.apply(ctx, { plugin: "promptopt" }));
	await settle();
});

test("llm 缺席 → 通道不注册，不抛错（硬规则 6 降级）", async () => {
	const connection = makeConnectionStub();
	const { ctx } = makeHostCtx({ connection }); // 只给 connection
	assert.doesNotThrow(() => mod.apply(ctx, { plugin: "promptopt" }));
	await settle();
	assert.equal(connection.registrations.length, 0);
});

// ── 成功路径 ───────────────────────────────────────────────────────────────

test("成功：value 信封承载优化文 / 耗时 / usage（摊平会被客户端 zod strip）", async () => {
	const llm = makeLlmStub().push(textStream("更好的提示词", USAGE));
	const connection = await boot({ llm });
	const result = await connection.invoke("optimize", { text: "帮我写点东西" });
	assert.equal(result.ok, true);
	assert.equal(result.value.text, "更好的提示词");
	assert.equal(typeof result.value.durationMs, "number");
	assert.deepEqual(result.value.usage, USAGE);
});

test("llm 桩收到 meta-prompt 与草稿全文，且不带会话上下文（Q4）", async () => {
	const llm = makeLlmStub().push(textStream("optimized"));
	const connection = await boot({ llm });
	await connection.invoke("optimize", { text: "写个排序函数" });
	const options = llm.calls[0].options;

	assert.equal(llm.calls.length, 1, "一次 optimize 只应触发一次模型调用");
	assert.equal(options.messages.length, 1, "只送一条 user message，无会话历史");
	assert.equal(options.messages[0].role, "user");
	assert.deepEqual(options.messages[0].content, [{ type: "text", text: "写个排序函数" }]);
	assert.equal(options.messages[0].source.kind, "plugin");
	assert.equal(typeof options.messages[0].id, "string", "Message.id 必填");

	// meta-prompt 走 system 槽位：五条约束齐全（内容轴不进词典，故按特征断言）。
	assert.equal(typeof options.system, "string");
	for (const marker of ["1.", "2.", "3.", "4.", "5.", "same language as the draft", "1.5x"]) {
		assert.ok(options.system.includes(marker), `meta-prompt 应含 ${marker}`);
	}
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
	const connection = await boot({ llm });
	await connection.invoke("optimize", { text: "draft" });
	assert.equal(llm.calls[0].options.provider, "p-first");
	assert.equal(llm.calls[0].options.model, "m-a");
});

test("usage 缺席时不下发该字段（允许差异：拿不到就不显示）", async () => {
	const llm = makeLlmStub().push(textStream("optimized")); // textStream 不传 usage
	const connection = await boot({ llm });
	const result = await connection.invoke("optimize", { text: "draft" });
	assert.equal(result.ok, true);
	assert.equal("usage" in result.value, false);
});

// ── 错误码映射 ─────────────────────────────────────────────────────────────

test("草稿预检：空 / 非字符串 / 超长 → bad-request", async () => {
	const llm = makeLlmStub().push(textStream("optimized"));
	const connection = await boot({ llm });
	for (const payload of [{ text: "" }, { text: "   " }, {}, { text: 42 }, { text: "x".repeat(65537) }, null]) {
		const result = await connection.invoke("optimize", payload);
		assert.equal(result.ok, false, `payload ${JSON.stringify(payload)} 应被拒`);
		assert.equal(result.error.code, "bad-request");
	}
	assert.equal(llm.calls.length, 0, "预检失败不应触发模型调用");
});

test("上限按 UTF-16 长度卡（与浏览器 String.length 同口径）", async () => {
	const connection = await boot();
	const atLimit = await connection.invoke("optimize", { text: "x".repeat(65536) });
	assert.equal(atLimit.ok, true, "恰好等于上限应放行");
});

test("llm 流抛错 → model-unavailable（不占用只留给超时的 internal）", async () => {
	const llm = makeLlmStub().push(new Error("provider down"));
	const connection = await boot({ llm });
	const result = await connection.invoke("optimize", { text: "draft" });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "model-unavailable");
	assert.deepEqual(result.error.details, { provider: "deepseek-official", model: "deepseek-v4-flash" });
});

test("模型产出为空 / finish 非 stop → model-unavailable", async () => {
	const empty = makeLlmStub().push([
		{ type: "text-delta", index: 0, text: "   " },
		{ type: "finish", reason: { kind: "stop" } },
	]);
	const c1 = await boot({ llm: empty });
	assert.equal((await c1.invoke("optimize", { text: "d" })).error.code, "model-unavailable");

	const truncated = makeLlmStub().push([
		{ type: "text-delta", index: 0, text: "partial" },
		{ type: "finish", reason: { kind: "max-tokens" } },
	]);
	const c2 = await boot({ llm: truncated });
	assert.equal((await c2.invoke("optimize", { text: "d" })).error.code, "model-unavailable");
});

test("无已注册路由 → model-unavailable（details 用 unknown 占位满足 schema）", async () => {
	const llm = makeLlmStub().push(textStream("optimized"));
	llm.providers = [];
	const connection = await boot({ llm });
	const result = await connection.invoke("optimize", { text: "draft" });
	assert.equal(result.error.code, "model-unavailable");
	assert.deepEqual(result.error.details, { provider: "unknown", model: "unknown" });
	assert.equal(llm.calls.length, 0, "无路由不应发起调用");
});

test("端点不匹配 → bad-request（通道是前缀挂载，端点要自己认领）", async () => {
	const connection = await boot();
	const result = await connection.invoke("something-else", { text: "draft" });
	assert.equal(result.error.code, "bad-request");
});

test("错误响应不含人类可读文案：message 就是机器码（不变量 3）", async () => {
	const llm = makeLlmStub().push(new Error("boom"));
	const connection = await boot({ llm });
	const result = await connection.invoke("optimize", { text: "draft" });
	assert.equal(result.error.message, result.error.code, "host 侧无 locale 服务，不得拼人类可读串");
});

// ── 取消与超时 ─────────────────────────────────────────────────────────────

test("abort 贯穿：浏览器取消 → model 调用被中止，返回 cancelled", async () => {
	const llm = makeLlmStub().push("hang");
	const connection = await boot({ llm });
	const controller = new AbortController();
	const pending = connection.invoke("optimize", { text: "draft" }, controller.signal);
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
	const connection = await boot({ llm });
	const controller = new AbortController();
	controller.abort();
	const result = await connection.invoke("optimize", { text: "draft" }, controller.signal);
	assert.equal(result.error.code, "cancelled");
	assert.equal(llm.calls.length, 0, "已取消的请求不该烧 token");
});

test("60s 截止（测试注入 5ms）：超时 → internal，且链路被中止", async () => {
	const llm = makeLlmStub().push("hang");
	const connection = await boot({ llm, timeoutMs: 5 });
	const controller = new AbortController();
	const result = await connection.invoke("optimize", { text: "draft" }, controller.signal);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "internal");
	assert.equal(llm.calls[0].aborted, true, "超时必须中止 in-flight 调用，不能继续烧");
	controller.abort(); // 收尾：确认宿主 signal 上的监听已摘除，不残留
});

test("超时与用户取消同时发生时，取消优先（弹层已关，超时文案无意义）", async () => {
	const llm = makeLlmStub().push("hang");
	const connection = await boot({ llm, timeoutMs: 5 });
	const controller = new AbortController();
	const pending = connection.invoke("optimize", { text: "draft" }, controller.signal);
	controller.abort();
	await settle();
	const result = await pending;
	assert.equal(result.error.code, "cancelled");
});
