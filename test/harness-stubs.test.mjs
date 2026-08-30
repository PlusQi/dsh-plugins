// 测试设施自测：先证明桩本身的语义对，再拿它去测被测行为。
//
// 桩有两类失败会污染结论：一是「假绿」（桩太宽松，实现错了照样过），二是「假
// 红」（桩自己的 bug 被读成实现 bug）。这里锁死的是后者尤其致命的几条——
// abort 传播、handler 捕获、inject 的齐备语义。
import { test } from "node:test";
import assert from "node:assert/strict";
import { abortError, makeConnectionStub, makeHostCtx, makeLlmStub, textStream } from "./host-harness.mjs";
import { fireDocument, fireWindow, makeReactMock, makeRpcStub } from "./client-harness.mjs";

async function collect(stream) {
	const out = [];
	for await (const chunk of stream) out.push(chunk);
	return out;
}

test("connection 桩：rpc.handle 捕获注册参数，invoke 驱动 handler 并透传 signal", async () => {
	const conn = makeConnectionStub();
	const seen = [];
	conn.rpc.handle("/chan", async (endpoint, payload, signal) => {
		seen.push({ endpoint, payload, aborted: signal?.aborted === true });
		return { ok: true, echoed: payload };
	}, { authority: "trusted-host" });

	assert.equal(conn.registrations.length, 1);
	assert.equal(conn.registrations[0].channel, "/chan");
	assert.deepEqual(conn.registrations[0].options, { authority: "trusted-host" });

	const controller = new AbortController();
	const result = await conn.invoke("optimize", { text: "hi" }, controller.signal);
	assert.deepEqual(result, { ok: true, echoed: { text: "hi" } });
	assert.deepEqual(seen, [{ endpoint: "optimize", payload: { text: "hi" }, aborted: false }]);
});

test("connection 桩：未注册时 invoke 抛错（实现漏注册不能被静默吞掉）", () => {
	const conn = makeConnectionStub();
	assert.throws(() => conn.invoke("optimize", {}), /尚无第 0 个注册/);
});

test("llm 桩：正常流产出全部 chunk 并结算 settled", async () => {
	const llm = makeLlmStub().push(textStream("hello", { inputTokens: 10, outputTokens: 4 }));
	const chunks = await collect(llm.stream({ provider: "p", model: "m" }));
	assert.equal(chunks.length, 5, "block-start + text-delta + block-end + usage + finish");
	assert.equal(llm.calls[0].chunks, 5);
	assert.equal(llm.calls[0].settled, true);
	assert.equal(llm.calls[0].aborted, false);
});

test("llm 桩：signal 中途 abort → 停止产出并标记 aborted", async () => {
	const llm = makeLlmStub().push(textStream("a much longer response that keeps going"));
	const controller = new AbortController();
	const chunks = await collect((async function* () {
		for await (const chunk of llm.stream({ provider: "p", model: "m", signal: controller.signal })) {
			yield chunk;
			controller.abort();
		}
	})());
	assert.equal(chunks.length, 1, "abort 后的 chunk 不应继续产出");
	assert.equal(llm.calls[0].aborted, true);
});

test('llm 桩：hang 脚本挂起等 abort（模拟 60s 超时链路）', async () => {
	const llm = makeLlmStub().push("hang");
	const controller = new AbortController();
	const pending = collect(llm.stream({ provider: "p", model: "m", signal: controller.signal }));
	// 没 abort 时不该结束：微任务排空后仍在挂起。
	for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
	assert.equal(llm.calls[0].settled, false, "abort 前流应仍挂起");
	controller.abort();
	assert.deepEqual(await pending, []);
	assert.equal(llm.calls[0].aborted, true);
});

test("llm 桩：Error 脚本在流中抛出（实现必须能 catch 成错误码）", async () => {
	const llm = makeLlmStub().push(new Error("provider down"));
	await assert.rejects(() => collect(llm.stream({ provider: "p", model: "m" })), /provider down/);
});

test("host ctx：inject 的服务齐备才回调，缺一个则永不回调（降级路径）", () => {
	const llm = makeLlmStub();
	const { ctx, state } = makeHostCtx({ llm });
	let called = 0;
	ctx.inject(["connection", "llm"], () => { called += 1; });
	assert.equal(called, 0, "connection 缺席 → 回调不该触发");

	const conn = makeConnectionStub();
	const ready = makeHostCtx({ llm, connection: conn });
	ready.ctx.inject(["connection", "llm"], () => { called += 1; });
	assert.equal(called, 1);
	assert.deepEqual(state.injectCalls, [["connection", "llm"]]);
});

test("client rpc 桩：hang 的调用在 abort 后 reject AbortError（弹层关闭路径）", async () => {
	const rpc = makeRpcStub().hang();
	const controller = new AbortController();
	const pending = rpc.call("/chan", "optimize", { text: "x" }, controller.signal);
	assert.equal(rpc.calls.length, 1);
	controller.abort();
	await assert.rejects(() => pending, (error) => error.name === "AbortError");
});

test("abortError 形态与浏览器一致（name 是判定取消的依据）", () => {
	const error = abortError();
	assert.equal(error.name, "AbortError");
	assert.ok(error instanceof Error);
});

test("document 事件桩：监听器可派发、可摘除（Esc / 点外关闭要靠它断言）", () => {
	const seen = [];
	const onKey = (e) => seen.push(e.key);
	document.addEventListener("keydown", onKey);
	assert.equal(fireDocument("keydown", { key: "Escape" }), 1, "应有且仅有一个监听器被调用");
	assert.deepEqual(seen, ["Escape"]);
	document.removeEventListener("keydown", onKey);
	assert.equal(fireDocument("keydown", { key: "Escape" }), 0, "摘除后不该再被派发");
	assert.deepEqual(seen, ["Escape"]);
	assert.equal(fireWindow("resize"), 0, "window 与 document 的监听器互不干扰");
});

test("react mock useRef：传值原样保留，传 null 给 DOM 桩（兼容既有定位 effect）", () => {
	const react = makeReactMock();
	const marker = { tag: "abort-controller" };
	assert.equal(react.useRef(marker).current, marker, "跨渲染的可变对象必须拿得回来");
	const domRef = react.useRef(null);
	assert.equal(typeof domRef.current.getBoundingClientRect, "function");
	assert.equal(domRef.current.contains({}), false);
});

test("react mock useRef：跨渲染返回同一对象（否则组件写进 ref 的值下次渲染就丢）", () => {
	const react = makeReactMock();
	// 模拟一个组件的两次渲染：hook 调用顺序恒定，ref 槽位应命中同一个。
	const first = react.useRef(null);
	first.current = { aborted: false };
	react.reset();
	const second = react.useRef(null);
	assert.equal(second, first, "同一 hook 序号必须复用同一个 ref 对象");
	assert.deepEqual(second.current, { aborted: false });
});
