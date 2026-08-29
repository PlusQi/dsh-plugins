// tokprev client 半边测试：预告行与徽标的文案走词典断言（中英各一遍）。
// 公共装配（react mock + locale 桩）见 test/client-harness.mjs。
import { test } from "node:test";
import assert from "node:assert/strict";
import { nodesOf, textOf, setupClientBase, assertDictPair } from "./client-harness.mjs";

const NS = "dsh-plugins.tokprev";

function setup(opts) {
	const base = setupClientBase(opts);
	return {
		...base,
		line: base.componentOf("conversation.composer.dock"),
		badge: base.componentOf("conversation.chat.assistant-actions"),
		t: base.t(NS),
	};
}

/** 预告行的三路数据源：投影（上下文压力）、会话（输出历史）、输入（草稿与排队）。 */
function lineProps(t, { pressure, breakdown, draft = "", queue = [], nodes = [], turnEnds = new Set(), running = false }) {
	return {
		t,
		useProjection: (key) => (key === "contextPressure" ? pressure : breakdown),
		useSession: (selector) => selector({ nodes, turnEnds, running }),
		useInput: (selector) => selector({ draft, queue }),
	};
}

const PRESSURE = { projectedTokens: 1000, contextWindow: 100000 };
const BREAKDOWN = { systemTokens: 500, toolsTokens: 100, messageTokens: 200 };

// ── 词典 ──────────────────────────────────────────────────────────────────

test("词典：zh/en 键集完全一致（缺键在界面上会显示裸键）", () => {
	const { dicts } = setup();
	assertDictPair(assert, NS, dicts);
});

test("注册：两个 slot 都声明 locale 命名空间（t 席位靠它注入）", () => {
	const { registrations } = setup();
	const slots = registrations.filter((r) => r.opts.id === "tok-preview" || r.opts.id === "tok-turn-badge");
	assert.equal(slots.length, 2, "tokprev 注册两个 slot");
	for (const r of slots) assert.equal(r.opts.locale, NS, `${r.opts.id} 应声明 locale 命名空间`);
});

// ── 预告行 ─────────────────────────────────────────────────────────────────

test("预告行中文：锚定态显示下一轮输入与百分比，明细含上下文与草稿", () => {
	const { line, t } = setup();
	const tree = line(lineProps(t, { pressure: PRESSURE, draft: "abcd" }));
	const text = textOf(tree);
	// 1000 + 草稿 9（ceil(4/4)+8） = 1009 → 1.0K；占 100K 窗口 1%
	assert.match(text, /下一轮输入 ≈ 1\.0K \(1%\)/, "主段");
	assert.match(text, /上下文 1\.0K/, "上下文段");
	assert.match(text, /草稿 9/, "草稿段");
	assert.match(text, /输出预估 -/, "无历史样本时的输出预估");
	assert.equal(tree.props.title, "上下文基数：提供商锚定（上次真实请求 + 增量估算）");
});

test("预告行英文：同场景走英文模板与英文语序", () => {
	const { line, t } = setup({ locale: "en" });
	const text = textOf(line(lineProps(t, { pressure: PRESSURE, draft: "abcd" })));
	assert.match(text, /Next input ≈ 1\.0K \(1%\)/);
	assert.match(text, /Context 1\.0K/);
	assert.match(text, /Draft 9/);
	assert.match(text, /Est\. output -/);
});

test("预告行中文：未锚定态以 * 标记且无百分比（无真实请求锚点）", () => {
	const { line, t } = setup();
	const tree = line(lineProps(t, { pressure: undefined, breakdown: BREAKDOWN }));
	const text = textOf(tree);
	// 500 + 100 + 200 = 800，无窗口故无百分比
	assert.match(text, /^\*?下一轮输入 ≈ 800/);
	assert.match(text, /\*上下文 800/, "未锚定的上下文段带 * 记号");
	assert.equal(tree.props.title, "尚无真实请求锚点，纯启发式估算（含系统提示与工具表）");
});

test("预告行英文：未锚定态", () => {
	const { line, t } = setup({ locale: "en" });
	const text = textOf(line(lineProps(t, { pressure: undefined, breakdown: BREAKDOWN })));
	assert.match(text, /\*Context 800/);
});

// ── 徽标 ──────────────────────────────────────────────────────────────────

/** 构造 selectBadge 认可的会话快照：assistant 节点 + 已收尾的 turn 集合。 */
function sessionOf(nodes, turns) {
	return { nodes, turnEnds: new Set(turns) };
}

function badgeProps(t, session, messageId) {
	return { t, useSession: (selector) => selector(session), messageId };
}

test("徽标中文：单次调用带缓存读（1 次调用 · 缓存 3.0K）", () => {
	const { badge, t } = setup();
	const session = sessionOf([
		{ kind: "assistant", messageId: "m1", turn: 1, seq: 5, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 3000 } },
	], [1]);
	const tree = badge(badgeProps(t, session, "m1"));
	// 计费输入 = 1000 + 3000 = 4000 → 4.0K
	assert.equal(textOf(tree), "本轮 输入 4.0K（1 次调用 · 缓存 3.0K） · 输出 100");
	assert.equal(tree.props.title, "本轮实际消耗（提供商上报，1 次调用）：输入 4000 tok，输出 100 tok");
});

test("徽标英文：单复数分形（1 call / 2 calls）", () => {
	const { badge, t } = setup({ locale: "en" });
	// 计费输入含缓存读：1000 + 3000 = 4000 → 4.0K
	const one = sessionOf([
		{ kind: "assistant", messageId: "m1", turn: 1, seq: 5, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 3000 } },
	], [1]);
	assert.equal(textOf(badge(badgeProps(t, one, "m1"))), "4.0K in (1 call · cache 3.0K) · 100 out");

	// 同 turn 两次调用：seq 1 的早样本与 seq 5 的收尾消息合计
	const two = sessionOf([
		{ kind: "assistant", messageId: "m0", turn: 1, seq: 1, usage: { inputTokens: 1000, outputTokens: 100 } },
		{ kind: "assistant", messageId: "m1", turn: 1, seq: 5, usage: { inputTokens: 500, outputTokens: 100 } },
	], [1]);
	const tree = badge(badgeProps(t, two, "m1"));
	assert.equal(textOf(tree), "1.5K in (2 calls) · 200 out");
	assert.equal(tree.props.title, "Actual usage this turn (provider-reported, 2 calls): 1500 tok in, 200 tok out");
});

test("徽标中文：两次调用（复数同形）", () => {
	const { badge, t } = setup();
	const session = sessionOf([
		{ kind: "assistant", messageId: "m0", turn: 1, seq: 1, usage: { inputTokens: 1000, outputTokens: 100 } },
		{ kind: "assistant", messageId: "m1", turn: 1, seq: 5, usage: { inputTokens: 500, outputTokens: 100 } },
	], [1]);
	assert.equal(textOf(badge(badgeProps(t, session, "m1"))), "本轮 输入 1.5K（2 次调用） · 输出 200");
});

test("徽标：非收尾消息不渲染（同一 turn 内只落在最后一条上）", () => {
	const { badge, t } = setup();
	const session = sessionOf([
		{ kind: "assistant", messageId: "m0", turn: 1, seq: 1, usage: { inputTokens: 1000, outputTokens: 100 } },
		{ kind: "assistant", messageId: "m1", turn: 1, seq: 5, usage: { inputTokens: 500, outputTokens: 100 } },
	], [1]);
	assert.equal(badge(badgeProps(t, session, "m0")), null);
});

test("徽标中文：缺少 usage 时不渲染（不抛错）", () => {
	const { badge, t } = setup();
	const session = sessionOf([{ kind: "assistant", messageId: "m1", turn: 1, seq: 5 }], [1]);
	assert.equal(badge(badgeProps(t, session, "m1")), null);
	assert.ok(nodesOf({ type: "div", children: [] }).length >= 0, "不渲染即无节点");
});
