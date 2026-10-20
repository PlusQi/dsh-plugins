window.__ModuleLoader__.load({
	id: "dsh-plugins",
	factory: (require) => {
		const react = require("react");

		// ── pack bootstrap ─────────────────────────────────────────────────────────
		// One pack = ONE client bundle: the client module graph is flat per package
		// (a bundle factory's require only knows module-table words, so the pack
		// cannot split into multiple files without a build step).
		// Server-side: cordis.patch.yml carries one row per pack plugin, each row
		// keeps name 'dsh-plugins' and config.plugin dispatches to the right block.
		// Client-side: the boot manifest creates ONE entry per package with no
		// config, so the client apply registers ALL plugins' UI unconditionally.
		// Adding a plugin: one block below + one patch row (see docs/MAINTAINING.md).
		// Locale: each plugin owns one namespace `dsh-plugins.<id>`, registered by
		// apply from the PLUGINS entry (zh is the key-set source of truth; the
		// language itself follows the host preference — Settings → General →
		// Language). `ctx.locale` is a hard dependency (as in every official UI
		// pack): when the host has no locale service, this bundle does not load
		// at all rather than showing half-translated copy.

		/** Per-plugin style tag: idempotent insert, fiber-scoped removal. */
		function ensurePluginStyles(pluginId, css) {
			if (typeof document === "undefined") return () => {};
			const selector = 'style[data-plugin-css="dsh-plugins/' + pluginId + '"]';
			let tag = document.querySelector(selector);
			if (tag === null) {
				tag = document.createElement("style");
				tag.dataset.pluginCss = "dsh-plugins/" + pluginId;
				tag.textContent = css;
				document.head.appendChild(tag);
			}
			return () => {
				if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag);
			};
		}

		/**
		 * 复数键选择：英文有 one/other 两形，中文同形。词典里 one/other 必须成对
		 * 出现（键集一致性由测试断言，我们无 TS 可校验）。
		 */
		function tCount(t, base, count, params) {
			return t(count === 1 ? base + ".one" : base + ".other", { ...params, count });
		}

		// ── plugin: tokprev ────────────────────────────────────────────────────────
		//
		// 只保留官方结构上给不了的增量（SPEC §方案 3，Q8 = P1）：官方 ContextMeter 已
		// 给上下文绝对数与三段明细、TurnUsagePanel 给逐轮四桶与命中率，故本插件删掉
		// 「上下文基线 / 窗口占比 / 排队估算 / 每轮徽标」四项重复信息，只留：
		//   下一轮输入合计 · 草稿增量 · 输出预估区间
		// 投影依赖因此只剩 contextPressure（I10）；草稿用本地启发式（estimateText）。

		function fmtTok(n) {
			if (!Number.isFinite(n)) return "?";
			if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + "M";
			if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "K";
			return String(Math.round(n));
		}

		/** Same fixed-density heuristic as dsh-token-meter's estimate.ts (CHARS_PER_TOKEN 4, block overhead 4, role overhead 4). */
		function estimateText(text) {
			if (typeof text !== "string" || text.length === 0) return 0;
			return Math.ceil(text.length / 4) + 8;
		}

		function percentile(sorted, q) {
			const n = sorted.length;
			if (n === 0) return undefined;
			return sorted[Math.min(n - 1, Math.floor(q * (n - 1)))];
		}

		/** Per-turn output totals over completed turns, newest 5, oldest-to-newest. */
		function selectOutputHistory(s) {
			const nodes = s.nodes;
			const turnEnds = s.turnEnds;
			if (!Array.isArray(nodes) || !turnEnds) return [];
			const byTurn = new Map();
			for (const n of nodes) {
				if (n === null || n.kind !== "assistant" || n.usage === undefined) continue;
				if (!turnEnds.has(n.turn)) continue;
				const out = Number(n.usage.outputTokens);
				if (!Number.isFinite(out) || out <= 0) continue;
				byTurn.set(n.turn, (byTurn.get(n.turn) || 0) + out);
			}
			const turns = [];
			for (const t of byTurn.keys()) turns.push(t);
			turns.sort((a, b) => a - b);
			const recent = turns.slice(-5);
			const values = [];
			for (const t of recent) values.push(byTurn.get(t));
			return values;
		}

		/**
		 * 三点式预告行：`下一轮输入 ≈ N · 草稿 M · 输出预估 X–Y`。
		 *
		 * 只读 contextPressure 一个投影（I10）；不再读 contextBreakdown、不再排队估算
		 * （官方 ContextMeter 已给绝对数，重复显示反而是噪音）。
		 */
		function PredictionLine({ useSession, useProjection, useInput, t }) {
			const pressure = useProjection("contextPressure");
			const hist = useSession(selectOutputHistory);
			const running = useSession((s) => s.running);
			const draft = useInput((s) => s.draft) ?? "";

			if (running) return null;

			const draftTokens = estimateText(draft);
			const anchored = pressure !== undefined
				&& (Number.isFinite(pressure.projectedTokens) || Number.isFinite(pressure.pressureTokens));
			const base = anchored
				? (Number.isFinite(pressure.projectedTokens) ? pressure.projectedTokens : pressure.pressureTokens)
				: 0;
			const nextInput = base + draftTokens;

			const sorted = hist.slice().sort((a, b) => a - b);
			let outLabel = "-";
			if (sorted.length === 1) outLabel = "\u2248" + fmtTok(sorted[0]);
			else if (sorted.length > 1) {
				const lo = percentile(sorted, 0.25);
				const hi = percentile(sorted, 0.75);
				outLabel = fmtTok(lo) + "\u2013" + fmtTok(hi);
			}

			// "*" 是「无真实请求锚点」的记号，不是语言的一部分，留在模板外。
			const parts = [
				(anchored ? "" : "*") + t("line.next", { tokens: fmtTok(nextInput) }),
				t("line.draft", { tokens: fmtTok(draftTokens) }),
				t("line.output", { range: outLabel }),
			];
			const title = t(anchored ? "tip.anchored" : "tip.estimated");

			return react.createElement("div", { className: "dsh-tokprev-line", title: title },
				parts.map((p, i) => react.createElement("span", {
					key: String(i),
					className: i === 0 ? "" : "dsh-tokprev-dim"
				}, (i > 0 ? "\u00b7 " : "") + p))
			);
		}

		const tokprevCss = [
			".dsh-tokprev-line{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;white-space:nowrap;overflow:hidden;user-select:none}",
			".dsh-tokprev-dim{opacity:.55}"
		].join("\n");

		/**
		 * tokprev 词典（zh 为键集真源，en 必须逐键对应）。
		 * 术语：输入 in / 输出 out / 草稿 draft / 估算 est.。
		 *
		 * 英文文案刻意避开「提供商」这个词的英文形式——guard 的 I1 规则对整个
		 * client 产物做字面量扫描，保留文案里出现该词会让规则长期失效。
		 */
		const LOCALE_NS_TOKPREV = "dsh-plugins.tokprev";

		const tokprevZh = {
			"line.next": "下一轮输入 ≈ {tokens}",
			"line.draft": "草稿 {tokens}",
			"line.output": "输出预估 {range}",
			"tip.anchored": "下一轮输入：锚定上次真实请求 + 草稿增量估算",
			"tip.estimated": "尚无真实请求锚点：仅按启发式估算（不含系统提示与工具定义）",
		};

		const tokprevEn = {
			"line.next": "Next input ≈ {tokens}",
			"line.draft": "Draft {tokens}",
			"line.output": "Est. output {range}",
			"tip.anchored": "Next input: anchored to the last real request plus the draft estimate",
			"tip.estimated": "No real request anchor yet: heuristic estimate only (system prompt and tool schemas excluded)",
		};

		/**
		 * tokprev registration body: conversation.composer.dock (list) —— 发送前的
		 * 三点式预告行。
		 *
		 * 不再注册 conversation.chat.assistant-actions（I9）：每轮真实消耗官方
		 * TurnUsagePanel 已经给了，重复实现只会与宿主口径漂移。
		 *
		 * 声明 locale 命名空间才会拿到 `t` 席位（renderer 对已声明命名空间的组件
		 * 要求 locale 服务存在——这就是 inject 里那条硬依赖）。
		 */
		function tokprevApply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register(
				{ name: "conversation.composer.dock", id: "tok-preview", order: 20, locale: LOCALE_NS_TOKPREV },
				PredictionLine
			));
		}

		// ── plugin: tokstats ────────────────────────────────────────────────────────
		//
		// 形态（SPEC-v0.6.0 §方案 2，决策 Q13 = U1）：侧栏 panellist 列表项 + root
		// `main` keyed slot 全局面板。`sidebar.footer.action` 已被官方 cordis-panel
		// 占用（P11），全局面板的正路是 `main`。
		//
		// 数据通道：面板打开 / 切窗口 / 切工作区各向 host 发一次 RPC，返回已汇总的
		// 桶分布 + 周趋势 + 工作区分组。不做推送、不做轮询、不常驻订阅（Q3）——面板
		// 不需要实时跳动，浏览器侧也不再持有「全部会话 cells」（I1）。

		/** 主面板 id：panellist 的 id 与 `main` 的 key 必须一致（p0-b，否则 selectPanel 抛错）。 */
		const TOKSTATS_PANEL_ID = "tokstats";
		const TOKSTATS_CHANNEL = "/dsh-plugins.tokstats";
		const TOKSTATS_ENDPOINT = "summary";

		/** 桶标签是非语言记号（区间边界），按 AGENTS 规则 7 不进词典。 */
		const TOKSTATS_BUCKET_LABELS = ["[0,4K)", "[4K,8K)", "[8K,16K)", "[16K,32K)", "[32K,64K)", "[64K,128K)", "[128K,∞)"];

		/** 窗口档位：90 天为缺省（host 侧 config.windowDays），0 = 全部。 */
		const TOKSTATS_WINDOWS = [90, 30, 0];

		/**
		 * 固定 24 小时制时钟。不跟浏览器 locale：`t` 席位只给翻译函数、不给当前
		 * 语言 id，用 toLocaleTimeString 会与 dsh 的语言偏好打架（中文界面配英文
		 * 浏览器会显示英文时间格式）。
		 */
		function tokstatsClock(ts) {
			const d = new Date(ts);
			const pad = (v) => String(v).padStart(2, "0");
			return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
		}

		/** 周粒度标签：在本机时区把周起点日键格式化成 M/D。 */
		function tokstatsDayLabel(day) {
			const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
			if (m === null) return day;
			return String(Number(m[2])) + "/" + String(Number(m[3]));
		}

		/**
		 * 惰性取 connection 服务。
		 *
		 * 刻意不放进 inject：inject 是「齐备才加载」的硬依赖，connection 一旦缺席
		 * 会连带 tokprev / promptopt 一起不加载。用 ctx.get 惰性取则只有 tokstats
		 * 降级成空态（硬规则 6）。
		 */
		function tokstatsConnection(ctx) {
			if (ctx === null || ctx === undefined || typeof ctx.get !== "function") return undefined;
			try {
				return ctx.get("connection");
			} catch {
				return undefined;
			}
		}

		/** 一次汇总请求；connection 缺席或传输失败都返回 undefined（调用方转空态）。 */
		async function tokstatsFetchSummary(ctx, request, signal) {
			const rpc = tokstatsConnection(ctx)?.rpc;
			if (rpc === undefined || rpc === null || typeof rpc.call !== "function") return undefined;
			try {
				const response = await rpc.call(TOKSTATS_CHANNEL, TOKSTATS_ENDPOINT, request, signal);
				if (response === undefined || response === null) return undefined;
				if (response.ok === true) return response.value;
				return null;
			} catch {
				return null;
			}
		}

		/** 侧栏列表项图标（自绘 inline SVG：三柱直方 + 基线，宿主无图标库约定）。 */
		function TokstatsIcon({ size }) {
			return react.createElement("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none",
				"aria-hidden": "true", style: { display: "block" }
			},
				react.createElement("path", {
					d: "M2.5 13.5h11M4 11V7.5M7.5 11V3.5M11 11V6",
					stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", fill: "none"
				}));
		}

		function TokstatsRow({ label, value, title, dim }) {
			return react.createElement("div", {
				className: "dsh-tokstats-row" + (dim ? " dsh-tokstats-dim" : ""), title: title
			},
				react.createElement("span", { className: "dsh-tokstats-rowLabel" }, label),
				react.createElement("span", { className: "dsh-tokstats-rowValue" }, value));
		}

		function TokstatsSection({ title, children }) {
			return react.createElement("div", { className: "dsh-tokstats-section" },
				react.createElement("div", { className: "dsh-tokstats-sectionTitle" }, title),
				children);
		}

		/**
		 * 全局面板（root `main` keyed slot，id = TOKSTATS_PANEL_ID）。
		 *
		 * 主体只有两块独有价值（Q5：用法健康度）：上下文桶分布 + 周粒度趋势；
		 * 工作区是分组维度。模型与成本维度整体删除（Q6），故不渲染模型表、不含金额。
		 */
		function TokstatsPanel({ t }) {
			const [windowDays, setWindowDays] = react.useState(TOKSTATS_WINDOWS[0]);
			const [workspace, setWorkspace] = react.useState("");
			const [phase, setPhase] = react.useState("loading");
			const [data, setData] = react.useState(null);
			// ctx 在 apply 时由闭包持有（slot 组件不接收 ctx）；每次请求取一份新控制器，
			// effect 清理时 abort 掉在飞请求。
			const ctxRef = react.useRef(tokstatsCtx);

			react.useEffect(() => {
				const controller = new AbortController();
				setPhase("loading");
				void (async () => {
					const request = { windowDays: windowDays };
					if (workspace !== "") request.workspace = workspace;
					const value = await tokstatsFetchSummary(ctxRef.current, request, controller.signal);
					if (controller.signal.aborted) return;
					if (value === undefined || value === null) {
						setPhase("empty");
						setData(null);
						return;
					}
					setData(value);
					setPhase("ready");
				})();
				return () => controller.abort();
			}, [windowDays, workspace]);

			const windowButton = (days) => react.createElement("button", {
				key: String(days),
				type: "button",
				className: "dsh-tokstats-switch" + (windowDays === days ? " dsh-tokstats-switchOn" : ""),
				onClick: () => setWindowDays(days)
			}, days === 0 ? t("range.all") : t("range.days", { count: days }));

			const buckets = data !== null && Array.isArray(data.buckets) ? data.buckets : [];
			const weekly = data !== null && Array.isArray(data.weekly) ? data.weekly : [];
			const workspaces = data !== null && Array.isArray(data.workspaces) ? data.workspaces : [];

			const hasBuckets = buckets.some((b) => (b?.calls ?? 0) > 0);
			const hasWeekly = weekly.length > 0;

			const body = phase === "loading"
				? react.createElement("div", { className: "dsh-tokstats-empty" }, t("state.pending"))
				: phase === "empty"
					? react.createElement("div", { className: "dsh-tokstats-empty" }, t("empty.noService"))
					: !hasBuckets && !hasWeekly
						? react.createElement("div", { className: "dsh-tokstats-empty" }, t("empty.noData"))
						: react.createElement(react.Fragment, null,
							react.createElement(TokstatsSection, { title: t("section.bucket") },
								TOKSTATS_BUCKET_LABELS.map((label, i) => {
									const cell = buckets[i] ?? { calls: 0, in: 0, cr: 0, cw: 0, out: 0 };
									const billed = (cell.in ?? 0) + (cell.cr ?? 0) + (cell.cw ?? 0);
									const hit = billed > 0 ? Math.round(((cell.cr ?? 0) / billed) * 100) : 0;
									return react.createElement(TokstatsRow, {
										key: label,
										label: label,
										dim: (cell.calls ?? 0) === 0,
										value: (cell.calls ?? 0) > 0
											? tCount(t, "row.bucket", cell.calls, {
												input: fmtTok(billed), output: fmtTok(cell.out ?? 0), hit: hit
											})
											: "\u2014",
										title: tCount(t, "tip.bucket", cell.calls ?? 0, {
											bucket: label, input: fmtTok(billed), output: fmtTok(cell.out ?? 0), hit: hit
										})
									});
								})),
							hasWeekly ? react.createElement(TokstatsSection, { title: t("section.trend") },
								weekly.map((week) => react.createElement(TokstatsRow, {
									key: week.weekStart,
									label: tokstatsDayLabel(week.weekStart),
									value: tCount(t, "row.week", week.calls, {
										input: fmtTok(week.in ?? 0), output: fmtTok(week.out ?? 0)
									})
								}))) : null);

			return react.createElement("div", { className: "dsh-tokstats-page", role: "region", "aria-label": t("panel.title") },
				react.createElement("div", { className: "dsh-tokstats-pageHeader" },
					react.createElement("span", { className: "dsh-tokstats-title" }, t("panel.title")),
					react.createElement("span", { className: "dsh-tokstats-badge" }, phase === "loading" ? t("state.pending") : "")),
				react.createElement("div", { className: "dsh-tokstats-toolbar" },
					react.createElement("div", { className: "dsh-tokstats-switches" },
						TOKSTATS_WINDOWS.map((days) => windowButton(days))),
					workspaces.length > 0
						? react.createElement("select", {
							className: "dsh-tokstats-select",
							value: workspace,
							onChange: (event) => setWorkspace(event?.target?.value ?? "")
						},
							react.createElement("option", { value: "" }, t("workspace.all")),
							workspaces.map((entry) => react.createElement("option", {
								key: entry.path, value: entry.path
							}, tCount(t, "workspace.item", entry.calls, { path: entry.path }))))
						: null),
				react.createElement("div", { className: "dsh-tokstats-body" }, body),
				react.createElement("div", { className: "dsh-tokstats-foot" },
					data !== null && Number.isFinite(data.generatedAt)
						? t("foot.generated", { time: tokstatsClock(data.generatedAt) })
						: ""));
		}

		const tokstatsCss = [
			".dsh-tokstats-page{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-secondary);flex-direction:column;display:flex;font-size:13px;line-height:20px;overflow:hidden}",
			".dsh-tokstats-pageHeader{box-sizing:border-box;align-items:center;gap:8px;min-height:52px;padding:12px 24px;display:flex;flex:none}",
			".dsh-tokstats-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:22px}",
			".dsh-tokstats-badge{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".dsh-tokstats-badge:empty{display:none}",
			".dsh-tokstats-toolbar{align-items:center;gap:12px;padding:0 24px 12px;display:flex;flex:none;flex-wrap:wrap}",
			".dsh-tokstats-switches{gap:2px;display:flex}",
			".dsh-tokstats-switch{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:7px;padding:3px 10px;font:inherit;font-size:12px;line-height:16px}",
			".dsh-tokstats-switch:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dsh-tokstats-switchOn{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-tokstats-select{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-button-elevated-fill);border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;padding:3px 8px;font:inherit;font-size:12px;line-height:16px;max-width:320px}",
			".dsh-tokstats-body{flex:1;min-height:0;padding:0 24px 12px;overflow-y:auto}",
			".dsh-tokstats-empty{color:var(--dsw-alias-label-tertiary);padding:24px 8px;text-align:center}",
			".dsh-tokstats-section{margin:8px 0 16px;max-width:640px}",
			".dsh-tokstats-sectionTitle{color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:.04em;margin:8px 0 4px;font-size:11px;font-weight:500;line-height:16px}",
			".dsh-tokstats-row{align-items:center;gap:12px;padding:3px 0;display:flex}",
			".dsh-tokstats-rowLabel{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;min-width:0;text-overflow:ellipsis;white-space:nowrap;flex:none;max-width:42%;overflow:hidden}",
			".dsh-tokstats-rowValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
			".dsh-tokstats-dim{opacity:.55}",
			".dsh-tokstats-foot{color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l2);padding:8px 24px;font-size:11px;line-height:16px;flex:none;min-height:16px}"
		].join("\n");

		/**
		 * tokstats 词典（zh 为键集真源，en 必须逐键对应）。
		 *
		 * 术语：输入 in / 输出 out / 缓存读 cache read / 缓存写 cache write /
		 * 命中 cached / 工作区 workspace / 上下文长度分布 context length distribution /
		 * 统计中… Scanning…。桶区间与 K/M 是记号，不进词典。
		 */
		const LOCALE_NS_TOKSTATS = "dsh-plugins.tokstats";

		const tokstatsZh = {
			"panel.title": "Token 分析",
			"panel.aria": "Token 分析",
			"state.pending": "统计中…",
			"range.days": "近 {count} 天",
			"range.all": "全部",
			"section.bucket": "上下文长度分布（按计费输入）",
			"section.trend": "趋势（按周）",
			"workspace.all": "全部工作区",
			"workspace.item.one": "{path}（{count} 次）",
			"workspace.item.other": "{path}（{count} 次）",
			"row.bucket.one": "{count} 次 · 输入 {input} · 输出 {output} · 命中 {hit}%",
			"row.bucket.other": "{count} 次 · 输入 {input} · 输出 {output} · 命中 {hit}%",
			"tip.bucket.one": "计费输入 {bucket} 的请求：{count} 次，计费输入 {input}，输出 {output}，缓存命中 {hit}%",
			"tip.bucket.other": "计费输入 {bucket} 的请求：{count} 次，计费输入 {input}，输出 {output}，缓存命中 {hit}%",
			"row.week.one": "{count} 次 · 输入 {input} · 输出 {output}",
			"row.week.other": "{count} 次 · 输入 {input} · 输出 {output}",
			"empty.noService": "统计服务不可用，无法读取会话数据",
			"empty.noData": "暂无数据（还没有 usage 记录）",
			"foot.generated": "生成于 {time}",
		};

		const tokstatsEn = {
			"panel.title": "Token analytics",
			"panel.aria": "Token analytics",
			"state.pending": "Scanning…",
			"range.days": "Last {count} days",
			"range.all": "All time",
			"section.bucket": "Context length distribution (by billed input)",
			"section.trend": "Trend (weekly)",
			"workspace.all": "All workspaces",
			"workspace.item.one": "{path} ({count} call)",
			"workspace.item.other": "{path} ({count} calls)",
			"row.bucket.one": "{count} call · {input} in · {output} out · {hit}% cached",
			"row.bucket.other": "{count} calls · {input} in · {output} out · {hit}% cached",
			"tip.bucket.one": "Requests billed at {bucket} input: {count}, billed input {input}, output {output}, cache hit {hit}%",
			"tip.bucket.other": "Requests billed at {bucket} input: {count}, billed input {input}, output {output}, cache hit {hit}%",
			"row.week.one": "{count} call · {input} in · {output} out",
			"row.week.other": "{count} calls · {input} in · {output} out",
			"empty.noService": "Statistics service unavailable: session data cannot be read",
			"empty.noData": "No data yet (no usage recorded)",
			"foot.generated": "Generated at {time}",
		};

		/** apply 时的 ctx：RPC 通道要惰性取（见 tokstatsConnection）。 */
		let tokstatsCtx = null;

		/**
		 * tokstats 注册体。
		 *
		 * 两处注册必须同 id（p0-b）：`sidebar.panellist` 的 `id` 与 `main` 的 `key`
		 * 是同一个寻址键——`ctx.layout.selectPanel(id)` 在 `main` 里找不到同名 key
		 * 会直接抛错，并保留当前面板。`label` 是函数形式（locale 切换时侧栏重取），
		 * `order` 升序排在官方 plugins(0) / schedules(10) 之后。
		 */
		function tokstatsApply(ctx) {
			tokstatsCtx = ctx;
			ctx.slots.inject("main", () => ctx.slots.register(
				{ name: "main", key: TOKSTATS_PANEL_ID, locale: LOCALE_NS_TOKSTATS },
				TokstatsPanel
			));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
				{
					name: "sidebar.panellist",
					id: TOKSTATS_PANEL_ID,
					order: 30,
					label: () => ctx.locale.bind(LOCALE_NS_TOKSTATS)("panel.title"),
					locale: LOCALE_NS_TOKSTATS,
				},
				TokstatsIcon
			));
		}

		// ── plugin: promptopt ──────────────────────────────────────────────────────
		//
		// composer 草稿的 AI 重写：点按钮 → host 侧一次旁路模型调用 → 原文/优化文
		// 对照 → 采纳才写回草稿。host 半边（通道 + llm）见 lib/index.js；两侧是
		// 两个模块图，没有共享常量的地方，通道名各写一份。
		//
		// 两轴分离（SPEC §3.5）：界面文案走词典跟随宿主语言；优化产物跟随草稿
		// 语言（meta-prompt 约束③承载），与 UI 语言无关——英文界面照样出中文优化文。

		const PROMPTOPT_CHANNEL = "/dsh-plugins.promptopt";
		const PROMPTOPT_ENDPOINT = "optimize";

		/** apply 时的 ctx：connection 服务要惰性取（见 promptoptConnection）。 */
		let promptoptCtx = null;

		/**
		 * 草稿含富内容判定（SPEC Q9）：occurrence / 图片 id / 命令 token。
		 * setDraft 是全量文本替换，模型重排会破坏 occurrence 坐标与图片归属，
		 * 而用户对此毫无感知——这类草稿直接禁用按钮而不是事后修补。
		 */
		function promptoptHasRichDraft(imageIds, occurrences, claim) {
			if (Array.isArray(imageIds) && imageIds.length > 0) return true;
			if (Array.isArray(occurrences) && occurrences.length > 0) return true;
			return claim !== undefined && claim !== null;
		}

		/** host 错误码 → 词典键后缀（host 侧每个 wire 码只有一个生产者，不会两义）。 */
		function promptoptErrorKey(code) {
			if (code === "bad-request") return "badDraft";
			if (code === "internal") return "timeout";
			return "llm";
		}

		/**
		 * 惰性取 connection 服务。
		 *
		 * 刻意不放进 inject：inject 是「齐备才加载」的硬依赖，connection 一旦
		 * 缺席会连带 tokprev / tokstats 一起不加载。用 ctx.get 惰性取则只有
		 * promptopt 降级成报错（硬规则 6）。
		 */
		function promptoptConnection() {
			const ctx = promptoptCtx;
			if (ctx === null || typeof ctx.get !== "function") return undefined;
			try {
				return ctx.get("connection");
			} catch {
				return undefined;
			}
		}

		/**
		 * 发起一次 optimize。走宿主官方 caller（自带 rpcId 关联、响应信封校验、
		 * signal 透传、__DSH_TRANSPORT__ 覆盖），不手搓 fetch。
		 * @returns RpcResult；connection 缺席时返回 undefined（调用方转成 error.llm）。
		 */
		async function promptoptOptimize(text, signal) {
			const rpc = promptoptConnection()?.rpc;
			if (rpc === undefined || rpc === null || typeof rpc.call !== "function") return undefined;
			return rpc.call(PROMPTOPT_CHANNEL, PROMPTOPT_ENDPOINT, { text }, signal);
		}

		function PromptoptIcon() {
			return react.createElement("svg", {
				width: 13, height: 13, viewBox: "0 0 16 16", fill: "none",
				"aria-hidden": "true", style: { display: "block" }
			},
				react.createElement("path", {
					d: "M8 1.8l1.5 3.4 3.7.4-2.7 2.5.7 3.6L8 9.8l-3.2 1.9.7-3.6L2.8 5.6l3.7-.4z",
					stroke: "currentColor", strokeWidth: "1.3", strokeLinejoin: "round", fill: "none"
				}));
		}

		/** 弹层：pending（转圈）/ ready（原文·优化文对照 + 采纳）/ error（按码查词典）。 */
		function PromptoptPopup({ snapshot, phase, result, onAdopt, onClose, anchor, panelRef, t }) {
			const ready = phase === "ready" && result !== null && result !== undefined;
			return react.createElement("div", {
				className: "dsh-promptopt-panel",
				ref: panelRef,
				style: { left: anchor.left, bottom: anchor.bottom }
			},
				react.createElement("div", { className: "dsh-promptopt-header" },
					react.createElement("span", { className: "dsh-promptopt-title" }, t("panel.title")),
					react.createElement("button", {
						type: "button",
						className: "dsh-promptopt-close",
						onClick: onClose,
						title: t("panel.close"),
						"aria-label": t("panel.close")
					}, "×")),
				phase === "pending"
					? react.createElement("div", { className: "dsh-promptopt-body" },
						react.createElement("span", { className: "dsh-promptopt-spinner" }),
						react.createElement("span", { className: "dsh-promptopt-pending" }, t("state.pending")))
					: null,
				ready
					? react.createElement("div", { className: "dsh-promptopt-body" },
						react.createElement("div", { className: "dsh-promptopt-label" }, t("panel.original")),
						react.createElement("div", { className: "dsh-promptopt-original" }, snapshot),
						react.createElement("div", { className: "dsh-promptopt-label" }, t("panel.optimized")),
						react.createElement("div", { className: "dsh-promptopt-optimized" }, result.text))
					: null,
				phase === "error" && result !== null && result !== undefined
					? react.createElement("div", { className: "dsh-promptopt-body" },
						react.createElement("div", { className: "dsh-promptopt-error" }, t("error." + promptoptErrorKey(result.code))))
					: null,
				ready
					? react.createElement("div", { className: "dsh-promptopt-actions" },
						react.createElement("button", {
							type: "button",
							className: "dsh-promptopt-adopt",
							onClick: onAdopt
						}, t("action.adopt")),
						react.createElement("span", { className: "dsh-promptopt-foot" },
							t("foot.done", { seconds: ((result.durationMs ?? 0) / 1000).toFixed(1) })))
					: null);
		}

		/**
		 * dock 按钮 + 弹层的容器组件（session-scope，收 useInput 与 inputActions）。
		 * 关闭语义：关闭 / Esc / 点外 → abort 在飞请求（不变量 6）；采纳 → 无条件
		 * setDraft 后关弹层（不变量 5，快照胜出——等待期间的编辑被覆盖）。
		 */
		function PromptoptButton({ useInput, inputActions, t }) {
			const draft = useInput((s) => s.draft) ?? "";
			const imageIds = useInput((s) => s.imageIds);
			const occurrences = useInput((s) => s.occurrences);
			const claim = useInput((s) => s.claim);

			const [open, setOpen] = react.useState(false);
			const [phase, setPhase] = react.useState("idle");
			const [result, setResult] = react.useState(null);
			const [snapshot, setSnapshot] = react.useState("");
			const [anchor, setAnchor] = react.useState(undefined);
			// 在飞请求的控制器：关闭即 abort。初值可能是测试桩的 DOM ref 对象，
			// 故按「有 abort 方法」判定而不是非 null。
			const controllerRef = react.useRef(null);
			// 按钮挪进 composer 工具行后，弹层不能再用 absolute 挂在自己上方：
			// 工具行与 composer 卡片的祖先有 overflow:hidden，absolute 会被裁剪
			//（面板在 DOM 里存在但肉眼不可见——v0.3.0 tokstats 踩过同一个坑）。
			// 改 fixed + 按钮矩形锚定，与 tokstats 面板同款。
			const buttonRef = react.useRef(null);
			const panelRef = react.useRef(null);

			const rich = promptoptHasRichDraft(imageIds, occurrences, claim);
			const empty = draft.trim().length === 0;
			const disabled = empty || rich;

			/** 中止并收摊（关闭 / Esc / 点外共用）。 */
			function close() {
				const controller = controllerRef.current;
				if (controller !== null && controller !== undefined && typeof controller.abort === "function") controller.abort();
				controllerRef.current = null;
				setOpen(false);
				setPhase("idle");
				setResult(null);
			}

			/** 采纳：无条件写回优化文（快照胜出，没有二次确认）。 */
			function adopt() {
				if (result !== null && result !== undefined && typeof result.text === "string") {
					inputActions.setDraft(result.text);
				}
				controllerRef.current = null;
				setOpen(false);
				setPhase("idle");
				setResult(null);
			}

			async function run() {
				const controller = new AbortController();
				controllerRef.current = controller;
				setSnapshot(draft);
				setResult(null);
				setPhase("pending");
				setOpen(true);
				let response;
				try {
					response = await promptoptOptimize(draft, controller.signal);
				} catch {
					// 传输失败（通道未注册 / 网络 / 信封校验不过）统一降级，不白屏。
					response = undefined;
				}
				// 弹层已关：结果作废，也不该再覆盖任何状态。
				if (controller.signal.aborted) return;
				controllerRef.current = null;
				if (response === undefined || response === null) {
					setPhase("error");
					setResult({ code: "llm" });
					return;
				}
				if (response.ok === true) {
					setPhase("ready");
					setResult(response.value);
					return;
				}
				setPhase("error");
				setResult({ code: response.error?.code ?? "llm" });
			}

			// 弹层锚定：fixed 定位需要自己的坐标，按按钮矩形算，并钳制不越视口
			// 右缘（窄窗口时面板不能跑出去）。
			react.useLayoutEffect(() => {
				if (!open) return;
				const place = () => {
					const rect = buttonRef.current.getBoundingClientRect();
					// 420 = 面板宽；面板与按钮左缘对齐，越界则贴右缘留 12px。
					const left = Math.max(8, Math.min(rect.left, window.innerWidth - 420 - 12));
					setAnchor({ left, bottom: window.innerHeight - rect.top + 8 });
				};
				place();
				window.addEventListener("resize", place);
				return () => window.removeEventListener("resize", place);
			}, [open]);

			// Esc 与点外关闭。点外判定走事件目标的 closest 而不是 ref.contains：
			// 判定逻辑与渲染树解耦，也不用为了取引用多挂一个 ref。
			react.useEffect(() => {
				if (!open) return;
				const onKey = (event) => {
					if (event?.key === "Escape") close();
				};
				const onPointer = (event) => {
					const target = event?.target;
					if (target !== null && target !== undefined && typeof target.closest === "function") {
						if (target.closest(".dsh-promptopt-root") !== null) return;
					}
					close();
				};
				document.addEventListener("keydown", onKey);
				document.addEventListener("pointerdown", onPointer);
				return () => {
					document.removeEventListener("keydown", onKey);
					document.removeEventListener("pointerdown", onPointer);
				};
			}, [open]);

			return react.createElement("div", { className: "dsh-promptopt-root" },
				react.createElement("button", {
					type: "button",
					className: "dsh-promptopt-trigger",
					disabled: disabled,
					ref: buttonRef,
					onClick: () => { void run(); },
					title: rich ? t("disabled.chips") : empty ? t("disabled.empty") : t("button.aria"),
					"aria-label": t("button.aria")
				},
					// 纯图标：工具行里其他按钮（引用 / 计划 / 模型选择）都是图标位，
					// 带文字会占掉 92px 把这一行撑长。功能靠 title 与 aria-label 表达。
					react.createElement(PromptoptIcon, null)),
				open && anchor !== undefined
					? react.createElement(PromptoptPopup, {
						snapshot: snapshot, phase: phase, result: result, onAdopt: adopt, onClose: close,
						anchor: anchor, panelRef: panelRef, t: t
					})
					: null);
		}

		const promptoptCss = [
			// 垂直齐平：宿主工具行是 flex 时靠 align-self:center，inline 布局时靠
			// vertical-align:middle（两条都写，容器用哪种都居中，不必猜宿主实现）。
			// 水平间距只留 2px：宿主工具行自带 gap，多给会把按钮推离 model select。
			".dsh-promptopt-root{position:relative;display:inline-flex;align-items:center;align-self:center;vertical-align:middle;flex:none;margin:0 2px}",
			// 28x28 图标位，与工具行里宿主自己的按钮同规格（引用 / 计划等）。
			".dsh-promptopt-trigger{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:8px;align-items:center;justify-content:center;padding:0;width:28px;height:28px;font:inherit;font-size:12px;display:inline-flex;flex:none}",
			".dsh-promptopt-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dsh-promptopt-trigger:disabled{opacity:.45;cursor:not-allowed}",
			// position:fixed + JS 锚定（见 PromptoptButton 的 useLayoutEffect）：
			// 座位在 composer 工具行里，absolute 会被祖先 overflow:hidden 裁剪。
			".dsh-promptopt-panel{z-index:30;box-sizing:border-box;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:420px;max-width:calc(100vw - 24px);max-height:60vh;box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-secondary);border-radius:12px;flex-direction:column;display:flex;position:fixed;left:0;bottom:0;overflow:hidden;font-size:12px;line-height:20px}",
			".dsh-promptopt-header{box-sizing:border-box;align-items:center;gap:8px;min-height:40px;padding:8px 12px;display:flex;flex:none}",
			".dsh-promptopt-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}",
			".dsh-promptopt-close{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;width:24px;height:24px;padding:0;margin-left:auto;font:inherit;font-size:14px;display:inline-flex;align-items:center;justify-content:center}",
			".dsh-promptopt-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dsh-promptopt-body{flex:1;min-height:0;padding:0 12px 12px;overflow-y:auto}",
			".dsh-promptopt-label{color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:.04em;margin:8px 0 4px;font-size:11px;font-weight:500;line-height:16px}",
			".dsh-promptopt-original{color:var(--dsw-alias-label-tertiary);opacity:.75;white-space:pre-wrap;word-break:break-word;max-height:14vh;overflow-y:auto}",
			".dsh-promptopt-optimized{color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;max-height:26vh;overflow-y:auto}",
			".dsh-promptopt-error{color:var(--dsw-alias-label-secondary);padding:8px 0}",
			".dsh-promptopt-pending{color:var(--dsw-alias-label-tertiary)}",
			".dsh-promptopt-spinner{width:12px;height:12px;margin-right:6px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-tertiary);border-radius:50%;display:inline-block;animation:dsh-promptopt-spin .7s linear infinite;vertical-align:-1px}",
			"@keyframes dsh-promptopt-spin{to{transform:rotate(360deg)}}",
			".dsh-promptopt-actions{align-items:center;gap:10px;border-top:1px solid var(--dsw-alias-border-l2);padding:8px 12px;display:flex;flex:none}",
			".dsh-promptopt-adopt{color:var(--dsw-alias-label-primary);cursor:pointer;background:var(--dsw-alias-interactive-bg-hover);border:none;border-radius:7px;padding:4px 12px;font:inherit;font-size:12px;line-height:18px}",
			".dsh-promptopt-adopt:hover{filter:brightness(1.08)}",
			".dsh-promptopt-foot{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}"
		].join("\n");

		const LOCALE_NS_PROMPTOPT = "dsh-plugins.promptopt";

		// 术语（两轴分离里只管 UI 轴）：优化 optimize / 采纳 adopt / 草稿 draft /
		// 原文 original / 优化文 optimized / 引用或图片 reference or image。
		// 按钮是纯图标位，功能靠 button.aria（同时用作 title 与 aria-label）表达。
		const promptoptZh = {
			"button.aria": "AI 优化这段提示词",
			"disabled.empty": "先输入草稿再优化",
			"disabled.chips": "草稿含引用或图片，暂不支持优化",
			"panel.title": "提示词优化",
			"panel.close": "关闭",
			"panel.original": "原文",
			"panel.optimized": "优化文",
			"state.pending": "优化中…",
			"action.adopt": "采纳",
			"foot.done": "耗时 {seconds}s",
			"error.llm": "模型调用失败，请稍后重试",
			"error.timeout": "优化超时（60s），请重试",
			"error.badDraft": "草稿为空或过长，无法优化"
		};

		const promptoptEn = {
			"button.aria": "Rewrite this prompt with AI",
			"disabled.empty": "Type a draft first",
			"disabled.chips": "Drafts with references or images cannot be optimized",
			"panel.title": "Prompt optimizer",
			"panel.close": "Close",
			"panel.original": "Original",
			"panel.optimized": "Optimized",
			"state.pending": "Optimizing…",
			"action.adopt": "Adopt",
			"foot.done": "Took {seconds}s",
			"error.llm": "The model call failed — please try again",
			"error.timeout": "Optimization timed out (60s) — please try again",
			"error.badDraft": "The draft is empty or too long to optimize"
		};

		/**
		 * promptopt 注册体：conversation.input.right（list，session scope）——
		 * composer 卡片**内部**工具行的右端，在模型选择座位之后、发送按钮之前。
		 *
		 * 这是宿主契约给可点控件的位置（dock 是「环境读数带」，宿主注释明确写着
		 * 可点控件应放 tool row）。用户实际用起来也确认：按钮在输入框里、挨着
		 * 模型选择，才符合「发送前顺手点一下」的操作逻辑。
		 */
		function promptoptApply(ctx) {
			promptoptCtx = ctx;
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register(
				{ name: "conversation.input.right", id: "promptopt-button", order: 30, locale: LOCALE_NS_PROMPTOPT },
				PromptoptButton
			));
		}

		// ── plugin registry ────────────────────────────────────────────────────────

	/** One entry per pack plugin: its styles, locale namespace and registration body. */
	const PLUGINS = {
		tokprev: { css: tokprevCss, apply: tokprevApply, ns: LOCALE_NS_TOKPREV, dicts: { zh: tokprevZh, en: tokprevEn } },
		tokstats: { css: tokstatsCss, apply: tokstatsApply, ns: LOCALE_NS_TOKSTATS, dicts: { zh: tokstatsZh, en: tokstatsEn } },
		promptopt: { css: promptoptCss, apply: promptoptApply, ns: LOCALE_NS_PROMPTOPT, dicts: { zh: promptoptZh, en: promptoptEn } }
	};

	const inject = ["slots", "locale"];
	/**
	 * Browser plugin body.
	 *
	 * Client-side cordis creates ONE entry per package (from the boot manifest)
	 * with no config, so we register ALL plugins' UI here unconditionally.
	 * Server-side dispatch by config.plugin is not needed for client-only UI
	 * packs — the client bundle is a singleton and components return null when
	 * their data isn't available.
	 */
	function apply(ctx) {
		for (const [id, plugin] of Object.entries(PLUGINS)) {
			const disposeStyles = ensurePluginStyles(id, plugin.css);
			ctx.effect(() => () => disposeStyles(), "dsh-plugins/" + id + ": styles");
			if (plugin.ns !== undefined) {
				// A namespace has exactly one owner: re-registering the same
				// (ns, locale) throws. Losing the dictionaries degrades copy to
				// bare keys, which must not cost the plugin its slots.
				try {
					const disposeDicts = ctx.locale.register(plugin.ns, plugin.dicts);
					ctx.effect(() => disposeDicts, "dsh-plugins/" + id + ": dictionaries");
				} catch (error) {
					console.error("[dsh-plugins] plugin " + id + " failed to register dictionaries:", error);
				}
			}
			try {
				plugin.apply(ctx);
			} catch (error) {
				// One plugin's failure must not fail the whole pack fiber: cordis
				// would unload every sibling's slots and styles on throw.
				console.error("[dsh-plugins] plugin " + id + " failed to register:", error);
			}
		}
	}

		return { inject, apply };
	}
});