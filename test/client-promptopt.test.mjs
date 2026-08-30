// promptopt client 半边测试：真实 lib/client.js 产物 + react / slots / locale /
// connection 桩，浅渲染断言。零依赖（AGENTS 硬规则 5）。
//
// 断言聚焦 SPEC 不变量里「客户端这一半」：按钮态机、采纳路径唯一、关闭即
// abort、错误码→词典映射、降级不白屏、词典键集一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	assertDictPair,
	fireDocument,
	injectedStyleTags,
	makeRpcStub,
	nodesOf,
	renderDeep,
	renderWithEffects,
	setupClientBase,
	textOf,
} from "./client-harness.mjs";

const NS = "dsh-plugins.promptopt";
const SLOT = "conversation.composer.dock";
const ID = "promptopt-button";

/** 排空微任务：onClick 是 void run()，等 run() 的 await 链走完。 */
async function settle() {
	for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
}

/**
 * 装配一次渲染环境。
 * @param opts.input 输入机状态（draft / imageIds / occurrences / claim）
 * @param opts.connection connection 桩；不传即模拟宿主无该服务。
 */
function mount({ draft = "写个排序函数", imageIds, occurrences, claim, connection, locale = "zh" } = {}) {
	const base = setupClientBase({ connection, locale });
	const registration = base.registrations.find((r) => r.opts.id === ID);
	assert.ok(registration, `${ID} 应已注册`);
	const writes = [];
	const props = {
		useInput: (selector) => selector({ draft, imageIds, occurrences, claim }),
		inputActions: { setDraft: (text) => writes.push(text) },
		t: base.t(NS),
	};
	const o = { ...base, comp: registration.comp, props, writes };
	o.render = () => {
		const tree = renderWithEffects(o.react, o.comp, o.props);
		return renderDeep(o.react, tree);
	};
	return o;
}

/** 按 className 找节点（className 是全量匹配，避免 contains 类前缀误命中）。 */
const byClass = (tree, cls) => nodesOf(tree).find((n) => n.props?.className === cls);

// ── 注册与词典 ─────────────────────────────────────────────────────────────

test("注册：dock 座位 + order 30 + locale 声明（t 席位靠 ns 取得）", () => {
	const { registrations } = setupClientBase();
	const entry = registrations.find((r) => r.opts.id === ID);
	assert.ok(entry);
	assert.equal(entry.opts.name, SLOT);
	assert.equal(entry.opts.order, 30, "避开 tokprev 的 20");
	assert.equal(entry.opts.locale, NS, "声明 ns 才有 t 席位");
});

test("词典：zh/en 键集一致（硬规则 7，缺键在英文界面会显示裸键）", () => {
	const { dicts } = setupClientBase();
	assertDictPair(assert, NS, dicts);
});

test("样式：按插件分 tag 注入，弹层绝对定位挂在按钮上方（硬规则 4）", () => {
	setupClientBase();
	const tag = injectedStyleTags.find((t) => t.dataset.pluginCss === "dsh-plugins/promptopt");
	assert.ok(tag, "promptopt 应有自己的 style tag，不与其他插件共用");
	assert.match(tag.textContent, /\.dsh-promptopt-panel\{[^}]*position:absolute/, "弹层是 absolute 而非 fixed：它锚在按钮上方，不跟视口");
	assert.match(tag.textContent, /@keyframes dsh-promptopt-spin/, "pending 转圈要有动画定义");
});

// ── 按钮态机（三 fixture） ──────────────────────────────────────────────────

test("态机：纯文本草稿可点", () => {
	const o = mount();
	const trigger = byClass(o.render(), "dsh-promptopt-trigger");
	assert.equal(trigger.props.disabled, false);
	assert.equal(trigger.props.title, o.props.t("button.aria"));
});

test("态机：空草稿禁用（含纯空白）", () => {
	for (const draft of ["", "   ", "\n\t"]) {
		const o = mount({ draft });
		const trigger = byClass(o.render(), "dsh-promptopt-trigger");
		assert.equal(trigger.props.disabled, true, `draft ${JSON.stringify(draft)} 应禁用`);
		assert.equal(trigger.props.title, o.props.t("disabled.empty"));
	}
});

test("态机：含 occurrence 的草稿禁用（setDraft 会破坏 chip 坐标）", () => {
	const o = mount({ occurrences: [{ id: 1, from: 0, to: 4 }] });
	const trigger = byClass(o.render(), "dsh-promptopt-trigger");
	assert.equal(trigger.props.disabled, true);
	assert.equal(trigger.props.title, o.props.t("disabled.chips"));
});

test("态机：含图片附件的草稿禁用", () => {
	const o = mount({ imageIds: ["img-1"] });
	assert.equal(byClass(o.render(), "dsh-promptopt-trigger").props.disabled, true);
});

test("态机：命令 token 已认领（claim）时禁用", () => {
	const o = mount({ claim: { token: "/compact" } });
	assert.equal(byClass(o.render(), "dsh-promptopt-trigger").props.disabled, true);
});

// ── pending → ready → 采纳 ──────────────────────────────────────────────────

test("点击：发起到正确通道，带草稿全文与 signal", async () => {
	const rpc = makeRpcStub();
	const o = mount({ connection: { rpc }, draft: "帮我写个快排" });
	await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
	await settle();
	assert.equal(rpc.calls.length, 1);
	const [call] = rpc.calls;
	assert.equal(call.channel, "/dsh-plugins.promptopt", "包前缀防第三方撞名");
	assert.equal(call.endpoint, "optimize");
	assert.deepEqual(call.payload, { text: "帮我写个快排" });
	assert.ok(call.signal !== undefined, "signal 是关闭即中止的唯一抓手");
});

test("pending 态：转圈 + state.pending 文案", async () => {
	const rpc = makeRpcStub().hang();
	const o = mount({ connection: { rpc } });
	await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
	await settle();
	const tree = o.render();
	assert.ok(byClass(tree, "dsh-promptopt-spinner"), "pending 应有转圈");
	assert.equal(textOf(byClass(tree, "dsh-promptopt-pending")), o.props.t("state.pending"));
	assert.equal(byClass(tree, "dsh-promptopt-adopt"), undefined, "未就绪不给出采纳按钮");
});

test("ready 态：原文/优化文对照 + 耗时脚注", async () => {
	const rpc = makeRpcStub().respond(() => ({ ok: true, value: { text: "优化后的提示词", durationMs: 1234 } }));
	const o = mount({ connection: { rpc }, draft: "原始草稿" });
	await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
	await settle();
	const tree = o.render();
	assert.equal(textOf(byClass(tree, "dsh-promptopt-original")), "原始草稿");
	assert.equal(textOf(byClass(tree, "dsh-promptopt-optimized")), "优化后的提示词");
	assert.equal(textOf(byClass(tree, "dsh-promptopt-foot")), o.props.t("foot.done", { seconds: "1.2" }));
});

test("采纳：唯一写回路径是 setDraft(优化文)，且无条件（不变量 5）", async () => {
	const rpc = makeRpcStub().respond(() => ({ ok: true, value: { text: "优化文", durationMs: 10 } }));
	const o = mount({ connection: { rpc } });
	await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
	await settle();
	const tree = o.render();
	await byClass(tree, "dsh-promptopt-adopt").props.onClick();
	await settle();
	assert.deepEqual(o.writes, ["优化文"], "采纳只写一次，且写的是优化文");
	assert.equal(byClass(o.render(), "dsh-promptopt-panel"), undefined, "采纳后弹层应关闭");
});

// ── 关闭语义（不变量 6） ────────────────────────────────────────────────────

test("关闭按钮：abort 在飞请求", async () => {
	const rpc = makeRpcStub().hang();
	const o = mount({ connection: { rpc } });
	await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
	await settle();
	const tree = o.render();
	byClass(tree, "dsh-promptopt-close").props.onClick();
	assert.equal(rpc.calls[0].signal.aborted, true, "关闭必须中止请求");
	assert.equal(byClass(o.render(), "dsh-promptopt-panel"), undefined);
});

test("Esc 关闭：abort 在飞请求", async () => {
	const rpc = makeRpcStub().hang();
	const o = mount({ connection: { rpc } });
	await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
	await settle();
	o.render(); // 让 open=true 的 effect 注册上监听器
	fireDocument("keydown", { key: "Escape" });
	assert.equal(rpc.calls[0].signal.aborted, true);
});

test("点外关闭：abort 在飞请求；点面板内不关", async () => {
	const rpc = makeRpcStub().hang();
	const o = mount({ connection: { rpc } });
	await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
	await settle();
	o.render();

	// 面板内：closest 命中根容器 → 不关。
	const inside = { closest: (sel) => (sel === ".dsh-promptopt-root" ? {} : null) };
	fireDocument("pointerdown", { target: inside });
	assert.equal(rpc.calls[0].signal.aborted, false, "点面板内不该关闭");

	fireDocument("pointerdown", { target: { closest: () => null } });
	assert.equal(rpc.calls[0].signal.aborted, true, "点面板外应关闭并中止");
});

test("关闭后迟到的响应不写状态（弹层已关，结果作废）", async () => {
	let resolveLate;
	const rpc = makeRpcStub().respond(() => new Promise((r) => { resolveLate = r; }));
	const o = mount({ connection: { rpc } });
	await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
	await settle();
	byClass(o.render(), "dsh-promptopt-close").props.onClick();
	resolveLate({ ok: true, value: { text: "迟到的优化文", durationMs: 1 } });
	await settle();
	assert.deepEqual(o.writes, [], "迟到的结果不该被采纳路径捡走");
	assert.equal(byClass(o.render(), "dsh-promptopt-panel"), undefined, "弹层不该被迟到的响应重新打开");
});

// ── 错误与降级 ─────────────────────────────────────────────────────────────

test("错误码 → 词典键映射（每个 wire 码对应一条文案）", async () => {
	const cases = [
		["bad-request", "error.badDraft"],
		["internal", "error.timeout"],
		["model-unavailable", "error.llm"],
		["cancelled", "error.llm"],
		["totally-unknown", "error.llm"],
	];
	for (const [code, key] of cases) {
		const rpc = makeRpcStub().respond(() => ({ ok: false, error: { code, message: code, details: {} } }));
		const o = mount({ connection: { rpc } });
		await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
		await settle();
		const tree = o.render();
		assert.equal(textOf(byClass(tree, "dsh-promptopt-error")), o.props.t(key), `${code} 应映射到 ${key}`);
		assert.equal(byClass(tree, "dsh-promptopt-adopt"), undefined, "错误态不给采纳按钮");
	}
});

test("connection 服务缺席 → error.llm，不抛错不白屏（不变量 10）", async () => {
	const o = mount(); // 不传 connection
	await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
	await settle();
	assert.equal(textOf(byClass(o.render(), "dsh-promptopt-error")), o.props.t("error.llm"));
});

test("传输抛错（通道未注册 / 网络）→ error.llm", async () => {
	const rpc = makeRpcStub().respond(() => { throw new Error("transport failure: HTTP 404"); });
	const o = mount({ connection: { rpc } });
	await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
	await settle();
	assert.equal(textOf(byClass(o.render(), "dsh-promptopt-error")), o.props.t("error.llm"));
});

test("rpc 回 undefined（服务桩缺 rpc 面）→ error.llm", async () => {
	const o = mount({ connection: {} }); // 有 connection 但无 rpc
	await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
	await settle();
	assert.equal(textOf(byClass(o.render(), "dsh-promptopt-error")), o.props.t("error.llm"));
});

// ── 两轴分离（内容轴不受 UI 语言影响） ───────────────────────────────────────

test("英文界面下 UI 走英文词典，草稿照原样送出不改写（内容轴由模型负责）", async () => {
	const rpc = makeRpcStub().respond(() => ({ ok: true, value: { text: "写个排序函数（优化版）", durationMs: 800 } }));
	const o = mount({ connection: { rpc }, draft: "写个排序函数", locale: "en" });
	await byClass(o.render(), "dsh-promptopt-trigger").props.onClick();
	await settle();
	const tree = o.render();
	assert.equal(textOf(byClass(tree, "dsh-promptopt-title")), "Prompt optimizer");
	assert.equal(textOf(byClass(tree, "dsh-promptopt-adopt")), "Adopt");
	assert.deepEqual(rpc.calls[0].payload, { text: "写个排序函数" }, "中文草稿原样送出");
	assert.equal(textOf(byClass(tree, "dsh-promptopt-optimized")), "写个排序函数（优化版）", "英文界面照样出中文优化文");
});
