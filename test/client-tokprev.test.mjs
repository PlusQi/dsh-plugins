// tokprev client 半边测试（v0.6.0 第二批）：三点式预告行，文案走词典断言（中英各一遍）。
// 公共装配（react mock + locale 桩）见 test/client-harness.mjs。
//
// 收缩后的不变量：只注册 conversation.composer.dock、只读 contextPressure 一个投影
// （I9/I10）。原来覆盖 TurnBadge 的用例随该组件一并删除——它测的是已移除的行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import { textOf, setupClientBase, assertDictPair } from "./client-harness.mjs";

const NS = "dsh-plugins.tokprev";

function setup(opts) {
	const base = setupClientBase(opts);
	return {
		...base,
		line: base.componentOf("conversation.composer.dock"),
		t: base.t(NS),
	};
}

/**
 * 预告行的三路数据源：投影（上下文压力）、会话（输出历史）、输入（草稿）。
 * `useProjection` 已不支持 contextBreakdown —— 这里对任何非 contextPressure 的
 * key 都返回 undefined，与收缩后的实现口径一致。
 */
function lineProps(t, { pressure, draft = "", nodes = [], turnEnds = new Set(), running = false } = {}) {
	return {
		t,
		useProjection: (key) => (key === "contextPressure" ? pressure : undefined),
		useSession: (selector) => selector({ nodes, turnEnds, running }),
		useInput: (selector) => selector({ draft }),
	};
}

const PRESSURE = { projectedTokens: 1000, contextWindow: 100000 };

// ── 注册形态 ───────────────────────────────────────────────────────────────

test("I9：只注册 composer.dock，不再注册 assistant-actions", () => {
	const { registrations } = setup();
	const ids = registrations.map((r) => r.opts.id);
	assert.ok(ids.includes("tok-preview"), "预告行仍在");
	assert.ok(!ids.includes("tok-turn-badge"), "TurnBadge 已删除（I9）");
	const names = registrations.map((r) => r.opts.name);
	assert.ok(!names.includes("conversation.chat.assistant-actions"), "不得再注册 assistant-actions（I9）");
});

test("注册：composer.dock 声明 locale 命名空间（t 席位靠它注入）", () => {
	const { registrations } = setup();
	const slot = registrations.find((r) => r.opts.id === "tok-preview");
	assert.ok(slot, "tok-preview 应已注册");
	assert.equal(slot.opts.name, "conversation.composer.dock");
	assert.equal(slot.opts.locale, NS, "应声明 locale 命名空间");
});

test("I10：组件只依赖 contextPressure 一个投影键", () => {
	const { line, t } = setup();
	const asked = [];
	const props = lineProps(t, { pressure: PRESSURE });
	props.useProjection = (key) => {
		asked.push(key);
		return key === "contextPressure" ? PRESSURE : undefined;
	};
	line(props);
	assert.deepEqual(asked, ["contextPressure"], "只应询问 contextPressure，不再读 contextBreakdown/queue");
});

test("词典：zh/en 键集完全一致（缺键在界面上会显示裸键）", () => {
	const { dicts } = setup();
	assertDictPair(assert, NS, dicts);
});

test("词典收缩到三点式所需的最小键集", () => {
	const { dicts } = setup();
	const keys = Object.keys(dicts[NS].zh).sort();
	assert.deepEqual(keys, ["line.draft", "line.next", "line.output", "tip.anchored", "tip.estimated"]);
	for (const gone of ["line.nextPct", "line.context", "line.queue", "badge.line", "badge.title", "badge.calls.one"]) {
		assert.ok(!keys.includes(gone), `已删除的键 ${gone} 不应残留`);
	}
});

// ── 预告行 ─────────────────────────────────────────────────────────────────

test("AC-10 中文：三点式 = 下一轮输入 · 草稿 · 输出预估", () => {
	const { line, t } = setup();
	const tree = line(lineProps(t, { pressure: PRESSURE, draft: "abcd" }));
	const text = textOf(tree);
	// 1000 + 草稿 9（ceil(4/4)+8） = 1009 → 1.0K
	assert.match(text, /下一轮输入 ≈ 1\.0K/, "第一段：下一轮输入");
	assert.match(text, /草稿 9/, "第二段：草稿增量");
	assert.match(text, /输出预估 -/, "第三段：输出预估（无历史样本）");
	assert.equal(tree.props.title, "下一轮输入：锚定上次真实请求 + 草稿增量估算");
});

test("AC-10 英文：同场景走英文模板与英文语序", () => {
	const { line, t } = setup({ locale: "en" });
	const text = textOf(line(lineProps(t, { pressure: PRESSURE, draft: "abcd" })));
	assert.match(text, /Next input ≈ 1\.0K/);
	assert.match(text, /Draft 9/);
	assert.match(text, /Est\. output -/);
});

test("三点式恰好三段，且以 · 分隔", () => {
	const { line, t } = setup();
	const tree = line(lineProps(t, { pressure: PRESSURE, draft: "abcd" }));
	assert.equal(tree.children.length, 3, "三段");
	const spans = tree.children.map(textOf);
	assert.equal(spans[0], "下一轮输入 ≈ 1.0K", "首段无前缀");
	assert.ok(spans[1].startsWith("\u00b7 "), "第二段带 · 前缀");
	assert.ok(spans[2].startsWith("\u00b7 "), "第三段带 · 前缀");
});

test("未锚定态：以 * 标记（无真实请求锚点），草稿仍计入", () => {
	const { line, t } = setup();
	const tree = line(lineProps(t, { pressure: undefined, draft: "abcd" }));
	const spans = tree.children.map(textOf);
	assert.match(spans[0], /^\*下一轮输入 ≈ 9/, "无锚点时基数 0，只有草稿");
	assert.match(spans[1], /草稿 9/);
	assert.equal(tree.props.title, "尚无真实请求锚点：仅按启发式估算（不含系统提示与工具定义）");
});

test("未锚定态英文", () => {
	const { line, t } = setup({ locale: "en" });
	const text = textOf(line(lineProps(t, { pressure: undefined, draft: "abcd" })));
	assert.match(text, /\*Next input ≈ 9/);
});

test("pressureTokens 兜底（projectedTokens 缺席时用它）", () => {
	const { line, t } = setup();
	const text = textOf(line(lineProps(t, { pressure: { pressureTokens: 2000 }, draft: "" })));
	assert.match(text, /下一轮输入 ≈ 2\.0K/);
});

test("输出预估：单样本给 ≈ 值，多样本给 P25–P75 区间", () => {
	const { line, t } = setup();
	const one = textOf(line(lineProps(t, { pressure: PRESSURE, nodes: [
		{ kind: "assistant", turn: 1, usage: { outputTokens: 500 } },
	], turnEnds: new Set([1]) })));
	assert.match(one, /输出预估 ≈500/);

	const many = textOf(line(lineProps(t, { pressure: PRESSURE, nodes: [
		{ kind: "assistant", turn: 1, usage: { outputTokens: 100 } },
		{ kind: "assistant", turn: 2, usage: { outputTokens: 200 } },
		{ kind: "assistant", turn: 3, usage: { outputTokens: 300 } },
		{ kind: "assistant", turn: 4, usage: { outputTokens: 400 } },
		{ kind: "assistant", turn: 5, usage: { outputTokens: 500 } },
	], turnEnds: new Set([1, 2, 3, 4, 5]) })));
	assert.match(many, /输出预估 200\u2013400/, "P25=200 P75=400");
});

test("运行中不渲染（正在生成时预告无意义）", () => {
	const { line, t } = setup();
	assert.equal(line(lineProps(t, { pressure: PRESSURE, running: true })), null);
});

test("降级：pressure 缺席时按未锚定处理，不抛错（I8）", () => {
	const { line, t } = setup();
	assert.doesNotThrow(() => line(lineProps(t, { pressure: undefined })));
});
