// tokstats client 半边测试：eval 真实 lib/client.js 产物，mock react + 伪
// ctx.slots/locale 浅渲染组件树断言。公共装配见 test/client-harness.mjs。
//
// v0.6.0 第一批起形态是**全局面板**（sidebar.panellist + root `main` keyed slot），
// 不再是侧栏脚按钮 + 弹层：panellist 的 id 与 main 的 key 必须一致（p0-b，否则
// ctx.layout.selectPanel 会抛错）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	injectedStyleTags,
	nodesOf,
	textOf,
	renderDeep,
	renderWithEffects,
	setupClientBase,
	assertDictPair,
	makeRpcStub,
} from "./client-harness.mjs";

const NS = "dsh-plugins.tokstats";
const PANEL_ID = "tokstats";
const CHANNEL = "/dsh-plugins.tokstats";

// ── 测试装配 ───────────────────────────────────────────────────────────────

/**
 * factory(react) → apply(伪 ctx) → 捕获 main / sidebar.panellist 两处注册。
 * connection 是可选的：不传即模拟「宿主无 connection 服务」，断言降级成空态。
 * 宿主形态是 `ctx.connection.rpc.call(...)`（rpc 在 connection 子对象上），
 * 故这里统一把桩包成 `{ rpc }`——直接传扁平桩会让「实现写错调用路径」测不出来。
 */
function setupClient(opts = {}) {
	const connection = opts.rpc === undefined ? opts.connection : { rpc: opts.rpc };
	const base = setupClientBase({ ...opts, connection });
	const main = base.registrations.find((r) => r.opts.name === "main");
	const list = base.registrations.find((r) => r.opts.name === "sidebar.panellist");
	return { ...base, main, list, t: base.t(NS) };
}

function panelPropsOf(rpc) {
	return { t: (key, params) => {
		const table = {
			"panel.title": "Token 分析",
			"state.pending": "统计中…",
			"range.days": "近 {count} 天",
			"range.all": "全部",
			"section.bucket": "上下文长度分布（按计费输入）",
			"section.trend": "趋势（按周）",
			"workspace.all": "全部工作区",
			"empty.noService": "统计服务不可用，无法读取会话数据",
			"empty.noData": "暂无数据（还没有 usage 记录）",
			"foot.generated": "生成于 {time}",
		};
		const template = table[key] ?? key;
		if (params === undefined) return template;
		return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
	} };
}

/** 一份合法的 RPC 聚合返回值（host 侧 tokstatsAggregate 的形状）。 */
function makeSummary(overrides = {}) {
	const buckets = [];
	for (let i = 0; i < 7; i += 1) buckets.push({ calls: 0, in: 0, cr: 0, cw: 0, out: 0 });
	buckets[0] = { calls: 2, in: 1000, cr: 3000, cw: 0, out: 200 };
	buckets[6] = { calls: 1, in: 200000, cr: 0, cw: 0, out: 50 };
	return {
		buckets,
		weekly: [{ weekStart: "2026-10-19", calls: 3, in: 201000, out: 250 }],
		workspaces: [
			{ path: "D:\\proj\\alpha", calls: 3, in: 201000, out: 250 },
			{ path: "D:\\proj\\beta", calls: 1, in: 4096, out: 10 },
		],
		totals: { calls: 3, in: 201000, cr: 3000, cw: 0, out: 250 },
		windowStart: "2026-07-23",
		generatedAt: 1787000000000,
		windowDays: 90,
		...overrides,
	};
}

/** 渲染面板并跑掉 effects（effect 里发起 RPC），最后深度展开函数组件。 */
async function renderPanel(react, main, props) {
	// 第一次渲染：收集 effect（effect 里发起 RPC）。
	main.comp(props);
	react.runEffects();
	// 等 RPC 兑现（setPhase / setData 落在 stateValues 上）。
	for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
	react.reset();
	// 第二次渲染：反映 effect 写入的状态。深度展开 TokstatsSection / TokstatsRow。
	return renderDeep(react, main.comp(props));
}

// ── 模块 / 注册 ────────────────────────────────────────────────────────────

test("client 产物：导出 { inject: [slots, locale], apply }；tokstats 改成 panellist + main 两处注册", () => {
	const { exportsObj, registrations } = setupClient();
	// locale 是硬依赖（与官方 UI 包同构）：宿主无 locale 服务时整包不加载。
	assert.deepEqual(exportsObj.inject, ["slots", "locale"]);
	const names = registrations.map((r) => r.opts.name).sort();
	assert.ok(names.includes("main"), "应注册 root main slot");
	assert.ok(names.includes("sidebar.panellist"), "应注册侧栏列表项");
	assert.ok(!names.includes("sidebar.footer.action"), "footer 按钮已删除（P11：该 slot 被官方 cordis-panel 占用）");
});

test("AC-9 / p0-b：panellist 的 id 必须等于 main 的 key（否则 selectPanel 抛错）", () => {
	const { main, list } = setupClient();
	assert.ok(main, "main 注册应存在");
	assert.ok(list, "panellist 注册应存在");
	assert.equal(main.opts.key, PANEL_ID);
	assert.equal(list.opts.id, PANEL_ID);
	assert.equal(main.opts.key, list.opts.id, "两处寻址键必须一致");
});

test("注册形态：label 是函数（locale 切换时侧栏重取），order 排在官方面板之后", () => {
	const { list } = setupClient();
	assert.equal(typeof list.opts.label, "function", "label 必须是函数：sidebar 用 resolveSlotLabel 调用它");
	assert.equal(list.opts.label(), "Token 分析");
	assert.equal(typeof list.opts.order, "number");
	assert.ok(list.opts.order >= 10, "plugins=0 / schedules=10 之后，取 30");
	assert.equal(list.opts.locale, NS, "locale 声明是 t 席位的来源");
});

test("两处注册都声明 locale 命名空间（t 席位靠它注入）", () => {
	const { main, list } = setupClient();
	assert.equal(main.opts.locale, NS);
	assert.equal(list.opts.locale, NS);
});

test("词典：zh/en 键集逐键对应（I13）", () => {
	const { dicts } = setupClient();
	assertDictPair(assert, NS, dicts);
});

test("词典不含成本/模型维度键（Q6 删除）", () => {
	const { dicts } = setupClient();
	const keys = Object.keys(dicts[NS].zh);
	for (const banned of ["section.model", "value.model", "unit.noPrice", "unit.noPriceParen", "tip.cost", "tip.model", "tip.noPriceOnly", "tip.estimated", "foot.note", "tip.overview", "value.inOut"]) {
		assert.ok(!keys.includes(banned), `已删除的键 ${banned} 不应残留`);
	}
	assert.ok(keys.includes("section.bucket"), "桶分布分区标题保留");
	assert.ok(keys.includes("section.trend"), "新增趋势分区标题");
});

test("I1：client 产物无 prices 字面量（成本维度已整体删除）", () => {
	const { exportsObj } = setupClient();
	assert.ok(exportsObj !== undefined);
	// 直接读产物文本：词典与组件里都不该再出现 prices。
	const text = injectedStyleTags.map((t) => t.textContent).join("");
	assert.ok(!text.includes("prices"));
});

// ── 样式 ───────────────────────────────────────────────────────────────────

test("样式回归：全局面板是页面级容器，且不再有弹层的 position:fixed", () => {
	setupClient();
	const tag = injectedStyleTags.find((t) => t.dataset.pluginCss === "dsh-plugins/tokstats");
	assert.ok(tag, "tokstats 样式 tag 应已注入");
	assert.match(tag.textContent, /\.dsh-tokstats-page\{/, "页面级容器规则应存在");
	assert.match(tag.textContent, /height:100%/, "全局面板撑满主区");
	assert.ok(!/position:fixed/.test(tag.textContent), "弹层定位（fixed + anchor）已随旧实现删除");
});

test("每插件样式 tag 独立（硬规则 4）", () => {
	// injectedStyleTags 是模块级累积数组：先清掉别的用例注入的，只看本次 apply。
	injectedStyleTags.length = 0;
	setupClient();
	const tags = injectedStyleTags.filter((t) => t.dataset.pluginCss !== undefined);
	assert.equal(tags.length, 3, "三个插件各一个 tag");
	const ids = new Set(tags.map((t) => t.dataset.pluginCss));
	assert.equal(ids.size, tags.length, "同一 id 不应重复注入");
	assert.ok(ids.has("dsh-plugins/tokstats"));
});

// ── 数据通道 ───────────────────────────────────────────────────────────────

test("面板打开时发一次 RPC（channel / endpoint / 缺省窗口）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	assert.equal(rpc.calls.length, 1, "打开即拉一次");
	assert.equal(rpc.calls[0].channel, CHANNEL);
	assert.equal(rpc.calls[0].endpoint, "summary");
	assert.equal(rpc.calls[0].payload.windowDays, 90, "缺省 90 天");
	assert.equal(rpc.calls[0].payload.workspace, undefined, "未选工作区时不传该字段");
	assert.ok(tree !== null);
});

test("AC-9：桶分布 7 行全渲染，非零桶显示数值、零桶显示破折号", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const nodes = nodesOf(tree);
	const labels = nodes.filter((n) => typeof n.props.className === "string" && n.props.className.includes("dsh-tokstats-rowLabel")).map((n) => textOf(n));
	for (const bucket of ["[0,4K)", "[4K,8K)", "[8K,16K)", "[16K,32K)", "[32K,64K)", "[64K,128K)", "[128K,∞)"]) {
		assert.ok(labels.includes(bucket), `桶 ${bucket} 应有一行`);
	}
	const dim = nodes.filter((n) => typeof n.props.className === "string" && /dsh-tokstats-dim/.test(n.props.className));
	assert.equal(dim.length, 5, "零桶行加 dim（5 个空桶）");
	assert.ok(textOf(tree).includes("—"), "零桶显示破折号");
});

test("AC-9：趋势分区渲染周行", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const text = textOf(tree);
	assert.ok(text.includes("趋势（按周）"), "趋势分区标题");
	assert.ok(text.includes("10/19"), "周起点按 M/D 显示");
	assert.ok(text.includes("3 次"), "周行带调用次数");
});

test("AC-9：工作区切换器出现且含「全部工作区」与各项", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const select = nodesOf(tree).find((n) => n.type === "select");
	assert.ok(select, "工作区切换器应渲染");
	const options = nodesOf(select).filter((n) => n.type === "option").map((n) => n.props.value);
	assert.deepEqual(options, ["", "D:\\proj\\alpha", "D:\\proj\\beta"]);
	assert.ok(textOf(select).includes("全部工作区"));
});

test("切换窗口：每个档位各发一次请求（90 / 30 / 全部=0）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const props = { t };
	let tree = main.comp(props);
	react.runEffects();
	await new Promise((r) => setImmediate(r));
	assert.equal(rpc.calls.length, 1);

	// 找到「全部」按钮并点击 → 触发 setWindowDays(0)，重渲染后 effect 再发一次。
	react.reset();
	const buttons = nodesOf(tree).filter((n) => n.type === "button" && typeof n.props.className === "string" && n.props.className.includes("dsh-tokstats-switch"));
	assert.equal(buttons.length, 3, "三个窗口档位");
	buttons[2].props.onClick();
	react.reset();
	tree = main.comp(props);
	react.runEffects();
	await new Promise((r) => setImmediate(r));
	assert.equal(rpc.calls.length, 2, "切档各发一次");
	assert.equal(rpc.calls[1].payload.windowDays, 0, "「全部」档发 0");
});

test("降级：connection 缺席时显示空态文案，不抛错（I8）", async () => {
	const { react, main, t } = setupClient({ connection: undefined });
	assert.doesNotThrow(() => main.comp({ t }));
	const tree = await renderPanel(react, main, { t });
	assert.ok(textOf(tree).includes("统计服务不可用"), "无 connection 时显示服务不可用");
});

test("降级：RPC 返回 ok:false 时显示空态，不抛错", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: false, error: { code: "model-unavailable", message: "x", details: {} } }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	assert.ok(textOf(tree).includes("统计服务不可用"));
});

test("降级：传输抛异常时显示空态，不抛错", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => { throw new Error("network down"); });
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	assert.ok(textOf(tree).includes("统计服务不可用"));
});

test("空数据：buckets 全零时显示「暂无数据」", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary({ buckets: Array.from({ length: 7 }, () => ({ calls: 0, in: 0, cr: 0, cw: 0, out: 0 })), weekly: [], workspaces: [] }) }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	assert.ok(textOf(tree).includes("暂无数据"));
});

test("页脚：显示生成时刻（固定 24 小时制）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const foot = nodesOf(tree).find((n) => typeof n.props.className === "string" && n.props.className === "dsh-tokstats-foot");
	assert.ok(foot, "页脚应渲染");
	assert.match(textOf(foot), /生成于 \d{2}:\d{2}:\d{2}/, "固定 24 小时制 HH:MM:SS");
});

test("不渲染模型表与成本列（Q6 已删）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const text = textOf(tree);
	assert.ok(!text.includes("按模型"), "无模型分区");
	assert.ok(!text.includes("¥"), "无金额");
	assert.ok(!text.includes("未配价"), "无未配价标注");
});



