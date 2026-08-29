// tokstats client 半边测试：eval 真实 lib/client.js 产物，mock react + 伪
// ctx.slots/locale 浅渲染组件树断言。公共装配见 test/client-harness.mjs。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	injectedStyleTags,
	nodesOf,
	textOf,
	rowNodesOf,
	renderDeep,
	renderWithEffects,
	setupClientBase,
	assertDictPair,
} from "./client-harness.mjs";

// ── react mock：createElement 出普通对象树；hooks 做最小状态机 ─────────────

// ── 测试装配 ───────────────────────────────────────────────────────────────

/** factory(react) → apply(伪 ctx) → 捕获 sidebar.footer.action 的按钮组件。 */
function setupClient(opts) {
	const base = setupClientBase(opts);
	const button = base.componentOf("sidebar.footer.action");
	assert.ok(button, "应注册 sidebar.footer.action");
	return { ...base, button };
}

/** 渲染按钮（含 effects 执行 + 一次重渲以反映 setAnchor），返回第二次树。 */
const renderButton = (react, button, props) => renderWithEffects(react, button, props);

/** 从按钮树中取出 Panel 组件引用（open=true 时才渲染）。 */
function panelComponentOf(tree) {
	const node = nodesOf(tree).find((n) => typeof n.type === "function" && n.type.name === "TokstatsPanel");
	return node === undefined ? undefined : { Comp: node.type, props: node.props };
}

// ── 测试数据 ───────────────────────────────────────────────────────────────

function dayKeyOf(ts) {
	const d = new Date(ts);
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return d.getFullYear() + "-" + m + "-" + day;
}
const TODAY = dayKeyOf(Date.now());
const OLD = dayKeyOf(Date.now() - 8 * 86400000);
const W_A = "D:\\proj\\alpha";
const W_B = "D:\\proj\\beta";

function makeValue() {
	return {
		schema: 1,
		complete: true,
		generatedAt: 1787000000000,
		prices: { "deepseek-official": { "deepseek-v4-flash": { input: 3, inputCached: 0.1, output: 9 } } },
		cells: [
			{ w: W_A, p: "deepseek-official", m: "deepseek-v4-flash", d: TODAY, b: 0, calls: 2, in: 1000, cr: 3000, cw: 0, out: 200 },
			{ w: W_A, p: "third-party-x", m: "some-model", d: TODAY, b: 6, calls: 1, in: 200000, cr: 0, cw: 0, out: 50 },
			{ w: W_B, p: "deepseek-official", m: "deepseek-v4-flash", d: OLD, b: 1, calls: 1, in: 4096, cr: 0, cw: 0, out: 10 },
		],
	};
}

const useSessionsOf = (snapshot) => (selector) => selector(snapshot);

// ── 模块 / 注册 ────────────────────────────────────────────────────────────

test("client 产物：导出 { inject: [slots, locale], apply }，apply 后注册两个插件的全部 slot", () => {
	const { exportsObj, registrations } = setupClient();
	// locale 是硬依赖（与官方 UI 包同构）：宿主无 locale 服务时整包不加载。
	assert.deepEqual(exportsObj.inject, ["slots", "locale"]);
	const names = registrations.map((r) => r.opts.name + "#" + r.opts.id).sort();
	assert.deepEqual(names, [
		"conversation.chat.assistant-actions#tok-turn-badge",
		"conversation.composer.dock#tok-preview",
		"sidebar.footer.action#tokstats-panel",
	]);
});

test("样式回归：面板必须 position:fixed（否则被侧栏列 overflow:hidden 裁剪、数值列不可见）", () => {
	setupClient();
	const tag = injectedStyleTags.find((t) => t.dataset.pluginCss === "dsh-plugins/tokstats");
	assert.ok(tag, "tokstats 样式 tag 应已注入");
	const panelRule = tag.textContent.match(/\.dsh-tokstats-panel\{[^}]*\}/)?.[0];
	assert.ok(panelRule, "面板 CSS 规则应存在");
	assert.match(panelRule, /(?:^|;)position:fixed/, "position:fixed 曾在块重写时丢失——面板退化成侧栏内的普通流元素，被 pI_x6G_sidebarCol 的 overflow:hidden 裁剪（rail 态 18px 宽、展开态右侧数值列被裁）");
	assert.match(panelRule, /width:380px/, "面板宽度声明");
});

test("按钮 wide 形态：图标 + 文字标签；rail 形态仅图标", () => {
	const { react, button } = setupClient();
	const snap = { current: undefined, ids: [], byId: {} };
	const wideTree = renderDeep(react, renderButton(react, button, { wide: true, useSessions: useSessionsOf(snap) }));
	const wideNodes = nodesOf(wideTree);
	assert.ok(wideNodes.some((n) => n.type === "svg"), "wide 有图标");
	assert.ok(wideNodes.some((n) => n.props.className === "dsh-tokstats-triggerLabel" && textOf(n) === "Token 统计"), "wide 有文字标签");
	assert.ok(wideTree.props.className.includes("dsh-tokstats-root") && !wideTree.props.className.includes("dsh-tokstats-rail"));

	const railTree = renderDeep(react, renderButton(react, button, { wide: false, useSessions: useSessionsOf(snap) }));
	assert.ok(railTree.props.className.includes("dsh-tokstats-rail"));
	assert.ok(!nodesOf(railTree).some((n) => n.props.className === "dsh-tokstats-triggerLabel"), "rail 无文字标签");
	assert.equal(panelComponentOf(railTree), undefined, "无值时不渲染面板");
});

// ── 面板渲染 ───────────────────────────────────────────────────────────────

test("面板四表：总览三行 / 工作区 / 模型（含成本与未配价）/ 上下文桶 + 时间开关 + 估算脚注", () => {
	const { react, button } = setupClient({ initialStates: [true] });
	const value = makeValue();
	const snap = { current: "s1", ids: ["s1"], byId: { s1: { projectionValues: { tokstats: value } } } };
	const tree = renderButton(react, button, { wide: true, useSessions: useSessionsOf(snap) });
	assert.ok(panelComponentOf(tree), "open=true 且有值时应渲染面板");
	// 深渲染前清空按钮占用的 state 槽：Panel 的 range useState 从默认 "total" 开始。
	react.clearStates();
	react.initialStates = [];
	const panelTree = renderDeep(react, tree);
	const rows = rowNodesOf(panelTree);
	const rowTexts = rows.map((r) => textOf(r));

	// 时间开关三档
	const switches = nodesOf(panelTree).filter((n) => n.type === "button" && typeof n.props.className === "string" && n.props.className.includes("dsh-tokstats-switch"));
	assert.deepEqual(switches.map((s) => textOf(s)), ["今日", "本周", "累计"]);
	assert.ok(switches[2].props.className.includes("dsh-tokstats-switchOn"), "默认累计档");

	// 总览：累计 4 次输入 205K；今日 3 次输入 201K（fmtTok(205096)="205K"）；不含计价
	assert.ok(rowTexts.some((x) => x.startsWith("累计") && x.includes("4 次") && x.includes("205K")), "累计行");
	assert.ok(rowTexts.some((x) => x.startsWith("今日") && x.includes("3 次") && x.includes("201K")), "今日行");
	assert.ok(rowTexts.some((x) => x.startsWith("本周")), "本周行");
	assert.ok(rowTexts.filter((x) => /^(今日|本周|累计)/.test(x)).every((x) => !x.includes("¥")), "总览行不含金额（计价只在按模型区）");

	// 工作区：alpha（今日 输入 201K / 输出 250）与 beta（旧 输入 4.1K / 输出 10）——中文格式、无计价
	assert.ok(rows.some((r) => textOf(r).includes("alpha") && textOf(r).includes("输入 201K") && textOf(r).includes("输出 250")), "工作区 alpha 行含输入与输出");
	assert.ok(rows.some((r) => textOf(r).includes("beta") && textOf(r).includes("输出 10")), "工作区 beta 行含输出");
	const wsRows = rows.filter((r) => /alpha|beta|其余/.test(textOf(r)));
	assert.ok(wsRows.length >= 2 && wsRows.every((r) => !textOf(r).includes("¥")), "工作区行不含金额");

	// 模型：官方行带输出与估算金额；第三方行未配价（同样必须有输出）
	assert.ok(rows.some((r) => textOf(r).startsWith("deepseek-official/deepseek-v4-flash") && textOf(r).includes("输出 210") && textOf(r).includes("¥0.017")), "官方模型行含输出与估算成本");
	assert.ok(rows.some((r) => textOf(r).startsWith("third-party-x/some-model") && textOf(r).includes("输出 50") && textOf(r).includes("未配价")), "未配价模型行含输出且显示 未配价");

	// 上下文桶：7 行全渲染，b0 命中率 75%（cr 3000 / billed 4000），行值同为中文格式
	const bucketRows = rows.filter((r) => /^\[\d+K/.test(textOf(r)) || textOf(r).startsWith("[0,4K)"));
	assert.equal(bucketRows.length, 7, "桶表 7 行");
	assert.ok(bucketRows.some((r) => textOf(r).startsWith("[0,4K)") && textOf(r).includes("2 次") && textOf(r).includes("输入 4.0K") && textOf(r).includes("输出 200") && textOf(r).includes("命中 75%")), "桶 0 行");
	assert.ok(bucketRows.some((r) => textOf(r).startsWith("[128K,∞)") && textOf(r).includes("1 次")), "桶 6 行");

	// 脚注估算标注
	assert.ok(textOf(panelTree).includes("估算"), "脚注含估算标注");
});

test("时间开关过滤：range=today 时旧日期 cell 被过滤（工作区仅 alpha）", () => {
	const { react, button } = setupClient({ initialStates: [true] });
	const value = makeValue();
	const snap = { current: "s1", ids: ["s1"], byId: { s1: { projectionValues: { tokstats: value } } } };
	const tree = renderButton(react, button, { wide: true, useSessions: useSessionsOf(snap) });
	react.clearStates();
	react.initialStates = ["today"];
	const panelTree = renderDeep(react, tree);
	const rows = rowNodesOf(panelTree);
	const texts = rows.map((r) => textOf(r));
	assert.ok(texts.some((x) => x.includes("alpha")), "今日工作区 alpha 在场");
	assert.ok(!texts.some((x) => x.includes("beta")), "8 天前的 beta 被过滤");
	assert.ok(texts.some((x) => x.startsWith("[128K,∞)")), "今日桶 6 在场");
	assert.ok(texts.some((x) => x.startsWith("[4K,8K)") && x.includes("—")), "今日无样本的桶显示 —");
});

test("空态：complete=false 显示统计中；complete=true 空 cells 显示暂无数据", () => {
	const { react, button } = setupClient({ initialStates: [true] });
	const scanning = { ...makeValue(), complete: false, cells: [] };
	const snap = { current: "s1", ids: ["s1"], byId: { s1: { projectionValues: { tokstats: scanning } } } };
	const tree1 = renderButton(react, button, { wide: true, useSessions: useSessionsOf(snap) });
	react.clearStates();
	react.initialStates = [];
	assert.ok(textOf(renderDeep(react, tree1)).includes("统计中"), "统计中角标/空态");

	const empty = { ...makeValue(), cells: [] };
	const snap2 = { current: "s1", ids: ["s1"], byId: { s1: { projectionValues: { tokstats: empty } } } };
	const tree2 = renderButton(react, button, { wide: true, useSessions: useSessionsOf(snap2) });
	react.clearStates();
	react.initialStates = [];
	assert.ok(textOf(renderDeep(react, tree2)).includes("暂无数据"), "完成态空数据显示暂无");
});

test("空态：reason=no-persistence 显示持久化不可用提示", () => {
	const { react, button } = setupClient({ initialStates: [true] });
	const noPersistence = { ...makeValue(), reason: "no-persistence", cells: [] };
	const snap = { current: "s1", ids: ["s1"], byId: { s1: { projectionValues: { tokstats: noPersistence } } } };
	const tree = renderButton(react, button, { wide: true, useSessions: useSessionsOf(snap) });
	react.clearStates();
	react.initialStates = [];
	assert.ok(textOf(renderDeep(react, tree)).includes("持久化服务不可用"));
});

// ── projection 值选择（selectTokstatsValue 语义） ──────────────────────────

test("值选择：当前会话优先于列表行兜底", () => {
	const { react, button } = setupClient({ initialStates: [true] });
	const v1 = makeValue();
	const v2 = makeValue();
	v2.cells = [{ w: W_B, p: "p2", m: "m2", d: TODAY, b: 3, calls: 9, in: 999999, cr: 0, cw: 0, out: 9 }];
	const snap = { current: "s1", ids: ["s1", "s2"], byId: { s1: { projectionValues: { tokstats: v1 } }, s2: { projectionValues: { tokstats: v2 } } } };
	const tree = renderButton(react, button, { wide: true, useSessions: useSessionsOf(snap) });
	assert.equal(panelComponentOf(tree).props.value, v1, "当前会话的值优先");
});

test("值选择：当前会话无值时回落任一列表行", () => {
	const { react, button } = setupClient({ initialStates: [true] });
	const v2 = makeValue();
	const snap = { current: "s1", ids: ["s1", "s2"], byId: { s1: { projectionValues: {} }, s2: { projectionValues: { tokstats: v2 } } } };
	const tree = renderButton(react, button, { wide: true, useSessions: useSessionsOf(snap) });
	assert.equal(panelComponentOf(tree).props.value, v2, "回落 ids[0] 的值");
});

test("值选择：全部缺席时按钮渲染但无面板（不抛错）", () => {
	const { react, button } = setupClient({ initialStates: [true] });
	const snap = { current: "s1", ids: ["s1"], byId: { s1: {} } };
	const tree = renderButton(react, button, { wide: true, useSessions: useSessionsOf(snap) });
	assert.ok(nodesOf(tree).some((n) => n.type === "button"), "按钮仍渲染");
	assert.equal(panelComponentOf(tree), undefined, "值缺席不渲染面板");
});
