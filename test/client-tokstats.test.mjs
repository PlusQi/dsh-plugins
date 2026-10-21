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
	rowNodesOf,
	renderDeep,
	renderWithEffects,
	setupClientBase,
	assertDictPair,
	makeRpcStub,
} from "./client-harness.mjs";

const NS = "dsh-plugins.tokstats";
const PANEL_ID = "tokstats";
const CHANNEL = "/dsh-plugins.tokstats";
const TOKSTATS_LABELS = ["[0,4K)", "[4K,8K)", "[8K,16K)", "[16K,32K)", "[32K,64K)", "[64K,128K)", "[128K,∞)"];

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
			"action.refresh": "重新统计",
			"section.bucket": "上下文长度分布（按计费输入）",
			"section.daily": "每日调用量",
			"section.trend": "趋势（按周）",
			"section.workspace": "工作区排行",
			"section.route": "模型排行",
			"route.unattributed": "未标注",
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
		// 日序列是周趋势的真源（v0.7.0）：两格都落在 2026-10-19 那一周。
		daily: [
			{ day: "2026-10-19", calls: 2, in: 200000, cr: 0, cw: 0, out: 200 },
			{ day: "2026-10-20", calls: 1, in: 1000, cr: 3000, cw: 0, out: 50 },
		],
		weekly: [{ weekStart: "2026-10-19", calls: 3, in: 201000, cr: 3000, cw: 0, out: 250 }],
		workspaces: [
			{ path: "D:\\proj\\alpha", calls: 3, in: 201000, out: 250, cr: 3000, cw: 0 },
			{ path: "D:\\proj\\beta", calls: 1, in: 4096, out: 10, cr: 0, cw: 0 },
		],
		// 模型排行（第二批）：按 calls 降序，未标注（rt === ""）在最后。
		routes: [
			{ rt: "workbuddy/deepseek-v4.1-flash", calls: 2, in: 1000, cr: 3000, cw: 0, out: 200 },
			{ rt: "deepseek-official/deepseek-v4-flash-vision-exp", calls: 1, in: 200000, cr: 0, cw: 0, out: 50 },
			{ rt: "", calls: 1, in: 100, cr: 0, cw: 0, out: 5 },
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
	// 打开时并发拉两块：主报表 + promptopt 计数器（AC-13）。
	assert.equal(rpc.calls.length, 2, "打开即各拉一次");
	const summary = rpc.calls.find((c) => c.endpoint === "summary");
	const counters = rpc.calls.find((c) => c.endpoint === "promptopt");
	assert.ok(summary, "应拉主报表");
	assert.ok(counters, "应拉 promptopt 计数器");
	assert.equal(summary.channel, CHANNEL);
	assert.equal(summary.payload.windowDays, 90, "缺省 90 天");
	assert.equal(summary.payload.workspace, undefined, "未选工作区时不传该字段");
	assert.ok(tree !== null);
});

test("AC-9：桶分布 7 行全渲染，非零桶显示数值、零桶显示破折号", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const nodes = nodesOf(tree);
	// v0.7.0 起桶行是比例条（meter），标签与数值各占一列、明细另起一行。
	const labels = nodes.filter((n) => typeof n.props.className === "string" && n.props.className === "dsh-tokstats-meterLabel").map((n) => textOf(n));
	for (const bucket of TOKSTATS_LABELS) {
		assert.ok(labels.includes(bucket), `桶 ${bucket} 应有一行`);
	}
	const dimBuckets = nodes.filter((n) => typeof n.props.className === "string"
		&& /dsh-tokstats-dim/.test(n.props.className)
		&& TOKSTATS_LABELS.some((label) => textOf(n).startsWith(label)));
	assert.equal(dimBuckets.length, 5, "零桶行加 dim（5 个空桶）");
	assert.ok(textOf(tree).includes("—"), "零桶显示破折号");
});

test("桶行：计数与四桶明细分两行（条形图长度不被长数值挤压）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const meters = nodesOf(tree).filter((n) => typeof n.props.className === "string" && n.props.className === "dsh-tokstats-meter");
	const bigBucket = meters.find((n) => textOf(n).startsWith("[128K,∞)"));
	assert.ok(bigBucket, "最高桶行应存在");
	const value = nodesOf(bigBucket).find((n) => n.props.className === "dsh-tokstats-meterValue");
	const detail = nodesOf(bigBucket).find((n) => n.props.className === "dsh-tokstats-meterDetail");
	assert.equal(textOf(value), "1 次", "数值列只放计数");
	assert.match(textOf(detail), /输入 200K · 输出 50 · 命中 0%/, "四桶明细在第二行");
	// 比例条按调用次数占比：1/3 ≈ 33.3%
	const fill = nodesOf(bigBucket).find((n) => n.props.className === "dsh-tokstats-meterFill");
	assert.equal(fill.props.style.width, "33.3%");
});

test("AC-9：趋势分区渲染周行（四列表：周起点 / 次数 / 输入 / 输出）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const text = textOf(tree);
	assert.ok(text.includes("趋势（按周）"), "趋势分区标题");
	assert.ok(text.includes("10/19"), "周起点按 M/D 显示");
	// 周行的「输入」是 in+cr+cw = 204K，不是未缓存的 201K（TS-17）。
	// 断言必须落在周行节点上：整树 includes 会被 KPI 的 hint「未缓存 201K」误命中，
	// 那样即使周行退回未缓存口径也照样绿（正是本次要防的回归）。
	const weekRow = rowNodesOf(tree).find((n) => textOf(n).startsWith("10/19"));
	assert.ok(weekRow !== undefined, "周行应存在");
	const cells = nodesOf(weekRow)
		.filter((n) => n.props.className === "dsh-tokstats-cellNum")
		.map((n) => textOf(n));
	assert.deepEqual(cells, ["3", "204K", "250"], "次数 / 输入（计费口径）/ 输出");
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
	// 首轮：主报表 + 计数器各一次
	assert.equal(rpc.calls.filter((c) => c.endpoint === "summary").length, 1);

	// 找到「全部」按钮并点击 → 触发 setWindowDays(0)，重渲染后 effect 再发一次。
	react.reset();
	const buttons = nodesOf(tree).filter((n) => n.type === "button" && typeof n.props.className === "string" && n.props.className.includes("dsh-tokstats-switch"));
	assert.equal(buttons.length, 3, "三个窗口档位");
	buttons[2].props.onClick();
	react.reset();
	tree = main.comp(props);
	react.runEffects();
	await new Promise((r) => setImmediate(r));
	const summaries = rpc.calls.filter((c) => c.endpoint === "summary");
	assert.equal(summaries.length, 2, "切档各发一次");
	assert.equal(summaries[1].payload.windowDays, 0, "「全部」档发 0");
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
	rpc.respond(() => ({ ok: true, value: makeSummary({
		buckets: Array.from({ length: 7 }, () => ({ calls: 0, in: 0, cr: 0, cw: 0, out: 0 })),
		daily: [],
		weekly: [],
		workspaces: [],
		totals: { calls: 0, in: 0, cr: 0, cw: 0, out: 0 },
	}) }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	assert.ok(textOf(tree).includes("暂无数据"));
});

// ── v0.7.0 统计面板：KPI / 每日柱 / 工作区排行 / 刷新 ────────────────────────

test("KPI 四卡：调用次数 / 输入 / 输出 / 缓存命中率，数值来自 totals", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const kpis = nodesOf(tree).filter((n) => typeof n.props.className === "string" && n.props.className === "dsh-tokstats-kpi");
	assert.equal(kpis.length, 4, "四张指标卡");
	const values = kpis.map((n) => textOf(n));
	// totals: calls 3 / in 201000 / cr 3000 / cw 0 / out 250 → 输入 204K，命中率 1%
	assert.ok(values[0].includes("3"), "调用次数");
	assert.ok(values[1].includes("204K"), "输入 = in + cr + cw");
	assert.ok(values[2].includes("250"), "输出合计");
	assert.ok(values[3].includes("1%"), "命中率 = cr / (in+cr+cw)");
	// 面板不再有两个「输入」：卡名是「输入」，hint 拆未缓存 / 缓存读（TS-17）。
	assert.ok(values[1].startsWith("输入204K"), `卡名应为「输入」，实际 ${values[1]}`);
	assert.ok(!values[1].includes("计费输入"), "不再用「计费输入」这个名字");
	assert.match(values[1], /未缓存 201K · 缓存读 3\.0K/, "hint 拆出未缓存与缓存读");
});

test("面板所有「输入」显示值统一为 in+cr+cw（KPI / 周行 / 日柱 tooltip / 工作区 / 模型排行）", async () => {
	// 这条是 TS-17 的聚合断言：夹具四桶非零且互不相等，任何一处退回「只显示未缓存
	// 输入」都会落到不同的数字上（201K vs 204K、1.0K vs 4.0K），因此能真正区分口径。
	// 只断言某一处不够：本次缺陷正是「同一面板 8 处里 6 处漏了 cr/cw」。
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });

	// 1) KPI 卡值 = totals 的 billed
	const kpis = nodesOf(tree).filter((n) => typeof n.props.className === "string" && n.props.className === "dsh-tokstats-kpi");
	assert.match(textOf(kpis[1]), /^输入204K/, "KPI 值 = billed(totals) = 204K");

	// 2) 周行 = weekly 的 billed（201000 + 3000）
	const weekRow = rowNodesOf(tree).find((n) => textOf(n).startsWith("10/19"));
	const weekCells = nodesOf(weekRow)
		.filter((n) => n.props.className === "dsh-tokstats-cellNum").map((n) => textOf(n));
	assert.deepEqual(weekCells, ["3", "204K", "250"], "周行「输入」= billed(weekly)");

	// 3) 日柱 tooltip = daily 各日的 billed（列聚合必须带 cr/cw）
	const barTitles = nodesOf(tree)
		.filter((n) => typeof n.props.className === "string" && /(?:^|\s)dsh-tokstats-bar(?:\s|$)/.test(n.props.className))
		.map((n) => String(n.props.title ?? ""))
		.filter((title) => title.length > 0);
	assert.equal(barTitles.length, 2, "两天有数据 → 两根柱各有 tooltip");
	assert.ok(barTitles[0].includes("输入 200K"), `10/19 的输入 = billed = 200K，实际 ${barTitles[0]}`);
	assert.ok(barTitles[1].includes("输入 4.0K"), `10/20 的输入 = 1000+3000 = 4.0K，实际 ${barTitles[1]}`);
	// 若列聚合漏了 cr（缺陷形态），10/20 会显示「输入 1.0K」——这一条专门钉住它。
	assert.ok(!barTitles.some((title) => title.includes("输入 1.0K")), "日柱不得退回未缓存口径");

	// 4) 工作区排行 detail 与 tooltip 同口径
	const meters = nodesOf(tree).filter((n) => typeof n.props.className === "string"
		&& /(?:^|\s)dsh-tokstats-meter(?:\s|$)/.test(n.props.className));
	const meterByLabel = (label) => meters.find((n) => {
		const el = nodesOf(n).find((c) => c.props.className === "dsh-tokstats-meterLabel");
		return el !== undefined && textOf(el) === label;
	});
	const detailOf = (meter) => textOf(nodesOf(meter).find((c) => c.props.className === "dsh-tokstats-meterDetail"));
	const alpha = meterByLabel("…\\proj\\alpha");
	const beta = meterByLabel("…\\proj\\beta");
	assert.match(detailOf(alpha), /^输入 204K · 输出 250/, "工作区 alpha = billed 204K");
	assert.match(detailOf(beta), /^输入 4\.1K · 输出 10/, "工作区 beta = 4096 + 0 = 4.1K");
	assert.ok(String(alpha.props.title).includes("输入 204K"), "工作区 tooltip 与 detail 同口径");
	assert.ok(String(beta.props.title).includes("输入 4.1K"), "工作区 tooltip 与 detail 同口径");

	// 5) 模型排行 detail 与 tooltip 同口径
	const workbuddy = meterByLabel("workbuddy/deepseek-v4.1-flash");
	const official = meterByLabel("deepseek-official/deepseek-v4-flash-vision-exp");
	assert.match(detailOf(workbuddy), /^输入 4\.0K · 输出 200 · 命中 75%/, "workbuddy = 1000 + 3000 = 4.0K");
	assert.match(detailOf(official), /^输入 200K · 输出 50 · 命中 0%/, "official = 200000 + 0 = 200K");
	assert.ok(String(workbuddy.props.title).includes("输入 4.0K"), "模型排行 tooltip 与 detail 同口径");
	assert.ok(String(official.props.title).includes("输入 200K"), "模型排行 tooltip 与 detail 同口径");

	// 6) 反向：整棵树里不得出现未缓存口径被当成「输入」的旧值
	const text = textOf(tree);
	assert.ok(!/输入 201K/.test(text), "不得出现未缓存口径的「输入 201K」（缺陷形态）");
	assert.ok(!/输入 1\.0K/.test(text), "不得出现未缓存口径的「输入 1.0K」（缺陷形态）");
});

test("KPI：窗口天数参与日均换算（近 90 天 → 3/90 ≈ 0.0）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary({ windowDays: 1 }) }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const kpis = nodesOf(tree).filter((n) => typeof n.props.className === "string" && n.props.className === "dsh-tokstats-kpi");
	assert.ok(textOf(kpis[0]).includes("3.0"), "1 天窗口下日均 = 3.0");
});

test("每日柱状图：按窗口跨度压缩成至多 60 列，柱高按峰值归一", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const bars = nodesOf(tree).filter((n) => typeof n.props.className === "string" && /(?:^|\s)dsh-tokstats-bar(?:\s|$)/.test(n.props.className));
	assert.ok(bars.length > 0, "应有柱位");
	assert.ok(bars.length <= 60, `列数应 ≤ 60，实际 ${bars.length}`);
	assert.ok(textOf(tree).includes("每日调用量"), "每日分区标题");
	const fills = nodesOf(tree).filter((n) => typeof n.props.className === "string" && n.props.className === "dsh-tokstats-barFill");
	const heights = fills.map((n) => Number.parseFloat(n.props.style.height));
	assert.ok(heights.includes(100), "峰值列应为 100%");
	assert.ok(heights.every((h) => h > 0 && h <= 100), "柱高在 (0,100] 内");
});

test("每日柱：零调用列不画柱（只有柱位，不画 2px 假数据）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const bars = nodesOf(tree).filter((n) => typeof n.props.className === "string" && /(?:^|\s)dsh-tokstats-bar(?:\s|$)/.test(n.props.className));
	const fills = nodesOf(tree).filter((n) => typeof n.props.className === "string" && n.props.className === "dsh-tokstats-barFill");
	// fixture 只有 10/19、10/20 两天有数据，但图表从首个数据日画到今天（含零日）
	assert.ok(bars.length >= fills.length, "柱位不少于填充柱");
	assert.equal(fills.length, 2, "只有两天有数据 → 只有两根柱");
});

test("每日柱：起点不早于首个数据日（避免整段空窗口）", async () => {
	const rpc = makeRpcStub();
	// 数据只有 10/19–10/20 两天，windowStart 却是 90 天前：图表应从 10/19 画起。
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const axis = nodesOf(tree).find((n) => typeof n.props.className === "string" && n.props.className === "dsh-tokstats-axis");
	const axisText = textOf(axis);
	assert.ok(axisText.startsWith("10/19"), `左轴应为首个数据日 10/19，实际 ${axisText}`);
});

test("每日柱：无 daily 字段时整卡不渲染（兼容旧 host 返回值）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary({ daily: undefined }) }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	assert.ok(!textOf(tree).includes("每日调用量"), "无日序列时不显示空图");
	assert.ok(textOf(tree).includes("趋势（按周）"), "其余卡片照常");
});

test("工作区排行：按调用次数排序并显示占比条", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const text = textOf(tree);
	assert.ok(text.includes("工作区排行"), "工作区卡片标题");
	const meters = nodesOf(tree).filter((n) => typeof n.props.className === "string" && n.props.className === "dsh-tokstats-meter");
	const workspaceMeters = meters.filter((n) => textOf(n).includes("proj"));
	assert.equal(workspaceMeters.length, 2, "两个工作区各一行");
	// alpha 3 次 / beta 1 次 → 占比 75% / 25%
	const fills = nodesOf(workspaceMeters[0]).filter((n) => n.props.className === "dsh-tokstats-meterFill");
	assert.equal(fills[0].props.style.width, "75.0%");
});

test("刷新按钮：点击后重跑一次 RPC（窗口/工作区不变也生效）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const props = { t };
	let tree = main.comp(props);
	react.runEffects();
	await new Promise((r) => setImmediate(r));
	assert.equal(rpc.calls.filter((c) => c.endpoint === "summary").length, 1);

	react.reset();
	const refresh = nodesOf(tree).find((n) => typeof n.props.className === "string" && n.props.className.includes("dsh-tokstats-refresh"));
	assert.ok(refresh, "刷新按钮应渲染");
	assert.equal(refresh.props["aria-label"], "重新统计");
	refresh.props.onClick();
	react.reset();
	tree = main.comp(props);
	react.runEffects();
	await new Promise((r) => setImmediate(r));
	assert.equal(rpc.calls.filter((c) => c.endpoint === "summary").length, 2, "刷新再发一次");
});

test("页脚：右侧显示统计区间（窗口下界 – 今天）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const range = nodesOf(tree).find((n) => typeof n.props.className === "string" && n.props.className === "dsh-tokstats-footRange");
	assert.ok(range, "页脚区间应渲染");
	assert.match(textOf(range), /7\/23 – \d{1,2}\/\d{1,2}/, "窗口下界 2026-07-23 → 7/23");
});

test("页脚：windowStart 为空（全部档）时显示「全部历史」", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary({ windowStart: "" }) }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const range = nodesOf(tree).find((n) => typeof n.props.className === "string" && n.props.className === "dsh-tokstats-footRange");
	assert.equal(textOf(range), "全部历史");
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

test("不渲染成本列（Q6 已删成本维度；模型排行是另一回事）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const text = textOf(tree);
	// 「按模型」这一条已随第二批删除：新卡的标题就是「模型排行」，两者必然冲突
	// （tka8-7f 的裁决）。成本维度仍由下面三条 + guard 的 prices 拦截守住。
	assert.ok(!text.includes("¥"), "无金额");
	assert.ok(!text.includes("未配价"), "无未配价标注");
	assert.ok(!text.includes("成本"), "无成本列");
});





// ── 模型排行卡（第二批 tka8-6/7） ───────────────────────────────────────────

test("AC-13 / tka8-7a：排行卡渲染 rt 作为标签、占比条与次数", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const text = textOf(tree);
	assert.ok(text.includes("模型排行"), "卡片标题");
	assert.ok(text.includes("3 个"), "右上角显示路由数（extra.routes）");
	// 标签是 host 拼好的整串，client 不拆（I1′）
	assert.ok(text.includes("workbuddy/deepseek-v4.1-flash"), "rt 整串作为标签");
	// 词边界正则（与既有柱状图用例同写法）：精确相等会漏掉带 `dsh-tokstats-dim`
	// 的未标注行，纯 includes 又会命中 meterLabel / meterTrack 这些子元素。
	const METER = /(?:^|\s)dsh-tokstats-meter(?:\s|$)/;
	const meters = nodesOf(tree).filter((n) => typeof n.props.className === "string" && METER.test(n.props.className));
	const routeMeters = meters.filter((n) => {
		const text = textOf(n);
		return text.includes("workbuddy/") || text.includes("deepseek-official/deepseek-v4-flash-vision-exp") || text.includes("未标注");
	});
	assert.equal(routeMeters.length, 3, "三条路由各一行（含未标注）");
	// 2 / 4 = 50%
	const fills = nodesOf(routeMeters[0]).filter((n) => n.props.className === "dsh-tokstats-meterFill");
	assert.equal(fills[0].props.style.width, "50.0%", "占比 = calls / 各行次数之和");
});

test("AC-13 / tka8-7b：未标注行渲染 route.unattributed 文案并带 dim", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const dimMeters = nodesOf(tree).filter((n) => typeof n.props.className === "string"
		&& n.props.className.includes("dsh-tokstats-meter")
		&& n.props.className.includes("dsh-tokstats-dim"));
	const labelled = dimMeters.map((n) => textOf(n));
	const unattributed = labelled.find((text) => text.includes("未标注"));
	assert.ok(unattributed !== undefined, "未标注行必须用词典文案（不是裸空串）");
	assert.ok(!labelled.some((text) => text.startsWith(" 次")), "不得渲染成空标签");
});

test("AC-13：长 rt 标签整串保留在 DOM（截断交给 CSS ellipsis + tooltip）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary() }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const long = "deepseek-official/deepseek-v4-flash-vision-exp";
	const meter = nodesOf(tree).find((n) => typeof n.props.className === "string"
		&& n.props.className.includes("dsh-tokstats-meter")
		&& textOf(n).includes(long));
	assert.ok(meter !== undefined, "42 字符的 rt 必须原样渲染（Q14：不拆字符串）");
	assert.ok(String(meter.props.title ?? "").includes(long), "完整 rt 进 tooltip");
});

test("旧 host 兼容：无 routes 字段时整卡不渲染、不抛错（I10 / 硬规则 6）", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary({ routes: undefined }) }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	assert.ok(!textOf(tree).includes("模型排行"), "无 routes 时不渲染空卡");
	assert.ok(textOf(tree).includes("工作区排行"), "其余卡片照常");
});

test("旧 host 兼容：routes 为空数组时同样整卡不渲染", async () => {
	const rpc = makeRpcStub();
	rpc.respond(() => ({ ok: true, value: makeSummary({ routes: [] }) }));
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	assert.ok(!textOf(tree).includes("模型排行"));
});

test("AC-13 / tka8-6e：词典 7 个新键 zh/en 成对且值里不出现 provider / model 两词", () => {
	// 值里不能出现这两个词：guard 的 DIMENSION_USE 会扫 client 产物，标题取
	// 「模型排行 / Models」正是为了不与 `provider:` / `model:` 形态撞车（R6）。
	const { dicts } = setupClient();
	const pair = dicts[NS];
	assert.ok(pair !== undefined, `${NS} 词典应已注册`);
	const zh = pair.zh;
	const en = pair.en;
	const added = [
		"section.route",
		"extra.routes.one", "extra.routes.other",
		"route.unattributed",
		"cell.routeDetail",
		"tip.route.one", "tip.route.other",
	];
	for (const key of added) {
		assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `zh 缺键 ${key}`);
		assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en 缺键 ${key}`);
		assert.ok(!/\bprovider\b/i.test(zh[key]), `zh ${key} 不得出现 provider`);
		assert.ok(!/\bmodel\b/i.test(zh[key]), `zh ${key} 不得出现 model`);
		assert.ok(!/\bprovider\b/i.test(en[key]), `en ${key} 不得出现 provider`);
		assert.ok(!/\bmodel\b/i.test(en[key]), `en ${key} 不得出现 model`);
	}
	assert.equal(zh["section.route"], "模型排行");
	assert.equal(en["section.route"], "Models");
	assert.equal(zh["route.unattributed"], "未标注");
	assert.equal(en["route.unattributed"], "Unattributed");
});


// ── promptopt 计数器区块（AC-13） ──────────────────────────────────────────

test("AC-13：计数器可用时渲染使用情况区块", async () => {
	const rpc = makeRpcStub();
	rpc.respond((call) => call.endpoint === "promptopt"
		? { ok: true, value: { started: 3, adopted: 2, dismissed: 1, charsDelta: -12 } }
		: { ok: true, value: makeSummary() });
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const text = textOf(tree);
	assert.ok(text.includes("提示词整理使用情况"), "应渲染计数器分区");
	assert.ok(text.includes("3 / 2 / 1"), "发起 / 采纳 / 放弃三个数");
	const row = nodesOf(tree).find((n) => typeof n.props.className === "string" && n.props.className.includes("dsh-tokstats-row") && String(n.props.title ?? "").includes("字符增减"));
	assert.ok(row, "行 tooltip 应带字符增减量");
	assert.match(row.props.title, /-12/);
});

test("AC-13：计数器不可用（null）时整块不渲染，不显示假零", async () => {
	const rpc = makeRpcStub();
	rpc.respond((call) => call.endpoint === "promptopt"
		? { ok: false, error: { code: "model-unavailable", message: "x", details: {} } }
		: { ok: true, value: makeSummary() });
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	assert.ok(!textOf(tree).includes("提示词整理使用情况"), "计数器不可用时隐藏该分区");
});

test("AC-13：正增量带 + 号，零增量不带", async () => {
	const rpc = makeRpcStub();
	rpc.respond((call) => call.endpoint === "promptopt"
		? { ok: true, value: { started: 1, adopted: 1, dismissed: 0, charsDelta: 40 } }
		: { ok: true, value: makeSummary() });
	const { react, main, t } = setupClient({ rpc });
	const tree = await renderPanel(react, main, { t });
	const row = nodesOf(tree).find((n) => typeof n.props.className === "string" && n.props.className.includes("dsh-tokstats-row") && String(n.props.title ?? "").includes("字符增减"));
	assert.match(row.props.title, /\+40/);
});
