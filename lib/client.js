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
		/** promptopt 计数器读数（跨插件观测面，AC-13）。 */
		const TOKSTATS_PROMPTOPT_ENDPOINT = "promptopt";

		/**
		 * 桶标签：对齐市面「按输入长度分档计费」的真实边界（见 host 侧
		 * `TOKSTATS_BUCKET_BOUNDS` 的口径说明与 TS-18）。是非语言记号（区间边界），
		 * 按 AGENTS 规则 7 不进词典；与 host 边界数组逐项对应，改一边必须改另一边。
		 *
		 * 最高桶是 `[512K,∞)`：1M 已是市面所有模型上下文窗口的最大值，单请求 prompt
		 * 结构上超不过它，再切 `[1M,∞)` 只是多一行永远为空的格子。
		 */
		const TOKSTATS_BUCKET_LABELS = ["[0,8K)", "[8K,32K)", "[32K,128K)", "[128K,256K)", "[256K,512K)", "[512K,∞)"];

		/**
		 * 时间窗口档位（按日期统计）：近 7 天 / 本月 / 近 30 天 / 全部。
		 *
		 * `days` 是发给 host 的 rolling 天数（host 语义：`today - (days - 1)` 起算；
		 * 0 / 非正数 = 不设窗口）。`days: null` 表示**按当天日期折算**——「本月」就是
		 * 「当月 1 日到今天」，正好等于今天的日期数，因此不必给 host 增加一种新的
		 * 窗口口径，四档共用同一个 `windowDays` 入参（TS-20）。
		 *
		 * 档位按 id 而非天数寻址：两个档位的 `days` 可能随时间取到相同值（「本月」
		 * 在 7 号正好也是 7 天），用天数当选中态会让两个按钮同时高亮。
		 */
		const TOKSTATS_RANGES = [
			{ id: "days7", days: 7 },
			{ id: "month", days: null },
			{ id: "days30", days: 30 },
			{ id: "all", days: 0 },
		];

		/**
		 * 缺省档位：近 7 天。
		 *
		 * 不取「本月」：月初打开面板时窗口只有 1–2 天，KPI 与日柱都近乎空图，容易
		 * 被读成「统计坏了」。7 天固定跨度在月初月末都有稳定形状。
		 */
		const TOKSTATS_DEFAULT_RANGE = "days7";

		/**
		 * 每日柱状图的最大列数。
		 *
		 * 上限不是「为了好看」而是「还读得出来」的边界：列宽低于约 3px 时相邻柱
		 * 已经糊成一片。日卡片占满整行（约 800–1200px），60 列约合每列 13–20px，
		 * 因此 60 天以内的窗口保持**逐日**分辨率；更长的窗口才按整日合并。
		 */
		const TOKSTATS_DAILY_COLUMNS = 60;

		/**
		 * 后台校验未完成时的重拉间隔（毫秒，TS-24）。
		 *
		 * host 首帧秒开、把滞后会话的冷读排进后台；本面板据此按此间隔自动重拉，
		 * 直到 `verifying` 消失。取 1500：本机 70 会话后台校验约 4–5 s 收敛，
		 * 1.5 s 的粒度让「变成准确值」的观感是「几秒后自己刷新」，同时不会把
		 * 面板刷成轮询器（最坏情况 3–4 次请求）。
		 */
		const TOKSTATS_VERIFY_RETRY_MS = 1500;

		/**
		 * 后台自动重拉的最小间隔（毫秒，TS-25）。
		 *
		 * 与 `TOKSTATS_VERIFY_RETRY_MS` 分开：那个是「多久后重拉一次」，这个是
		 * 「两次后台重拉之间至少隔多久」。分开的原因是**后台重拉不能刷屏**——
		 * TS-25 修的正是「面板整块被换成『统计中…』再挂回来」的高频闪烁，
		 * 1.5 s 一次、连续 3–4 轮时用户根本来不及看清任何一帧数据。
		 *
		 * 取 3000：后台校验本机实测 4–5 s 收敛，3 s 的间隔让重拉次数从 3–4 次
		 * 降到 1–2 次，同时「数字几秒后自己变准」的观感不变（页脚的「校验中…」
		 * 全程在场，读者始终知道「这是过渡态，不是终值」）。
		 */
		const TOKSTATS_VERIFY_BACKOFF_MS = 3000;

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

		/**
		 * 一次汇总请求；connection 缺席或传输失败都返回 undefined（调用方转空态）。
		 */
		async function tokstatsRpc(ctx, endpoint, request, signal) {
			const rpc = tokstatsConnection(ctx)?.rpc;
			if (rpc === undefined || rpc === null || typeof rpc.call !== "function") return undefined;
			try {
				const response = await rpc.call(TOKSTATS_CHANNEL, endpoint, request, signal);
				if (response === undefined || response === null) return undefined;
				if (response.ok === true) return response.value;
				return null;
			} catch {
				return null;
			}
		}

		const tokstatsFetchSummary = (ctx, request, signal) => tokstatsRpc(ctx, TOKSTATS_ENDPOINT, request, signal);
		/** promptopt 计数器（AC-13）；不可用时返回 null，面板隐藏该区块。 */
		const tokstatsFetchPromptopt = (ctx, signal) => tokstatsRpc(ctx, TOKSTATS_PROMPTOPT_ENDPOINT, {}, signal);

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

		/**
		 * 面板上「输入」的唯一口径 = 输入 + 缓存读 + 缓存写（与 host 侧落桶口径一致）。
		 *
		 * 所有显示「输入」的地方都必须过这个函数（TS-17）：实测缓存读占输入的
		 * 97–99%，只显示 `in` 会让排行/趋势与 KPI 卡差 1–2 个数量级。三列分开存
		 * 是对的（命中率 `cr / billed` 与对账都需要原始桶），只是显示要合计。
		 */
		function tokstatsBilled(cell) {
			return (cell?.in ?? 0) + (cell?.cr ?? 0) + (cell?.cw ?? 0);
		}

		/** 缓存命中率（整数百分比）；计费输入为 0 时按 0 计。 */
		function tokstatsHit(cell) {
			const billed = tokstatsBilled(cell);
			if (billed <= 0) return 0;
			return Math.round(((cell?.cr ?? 0) / billed) * 100);
		}

		/**
		 * 占比（百分比文本，自适应精度）——只用于 KPI 副值这类「比值口径」。
		 *
		 * 精度按量级自适应：输出占计费输入实测只有 0.1% 量级，固定一位小数会
		 * 全部显示成 `0.0%`（看起来像假零）。分母为 0 时返回 null，由调用方
		 * 决定「不渲染副值」而不是编一个 0%（那个比值在数学上无定义）。
		 */
		function tokstatsPct(part, whole) {
			const p = Number.isFinite(part) ? part : 0;
			if (!Number.isFinite(whole) || whole <= 0) return null;
			const pct = (p / whole) * 100;
			if (pct >= 10) return String(Math.round(pct));
			if (pct >= 1) return pct.toFixed(1);
			return pct.toFixed(2);
		}

		/** 日键（浏览器本地自然日）——只用于把日序列摆到时间轴上。 */
		function tokstatsDayKeyLocal(ts) {
			const d = new Date(ts);
			const pad = (v) => String(v).padStart(2, "0");
			return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
		}

		/** 日键减一天（UTC 解析，不随宿主时区漂移）——与 host 的 `tokstatsDayBefore` 同口径。 */
		function tokstatsDayBeforeLocal(day) {
			const d = new Date(day + "T00:00:00Z");
			if (!Number.isFinite(d.getTime())) return null;
			d.setUTCDate(d.getUTCDate() - 1);
			return d.toISOString().slice(0, 10);
		}

		/** 日键 → 毫秒（UTC 解析，只用来算天数差，与 host 侧 windowStart 同口径）。 */
		function tokstatsDayMs(day) {
			return Date.parse(day + "T00:00:00Z");
		}

		/**
		 * 档位 → 发给 host 的 `windowDays`（`0` = 全部）。
		 *
		 * 固定天数档直接返回；`days: null` 的档位（「本月」）按**浏览器本地自然日**
		 * 折算成「今天是几号」——host 侧 `tokstatsWindowStart` 的定义是
		 * `today - (windowDays - 1)`，取当天日期数代入即得当月 1 日。
		 *
		 * 这里按浏览器本地日期而非 host 日期算：跨时区的理论上限是一天偏差，而
		 * 本面板是单机自用工具（host 与浏览器同机同时区），没必要为它引入时区协商。
		 */
		function tokstatsRangeDays(range, ts) {
			if (range === undefined || range === null) return 0;
			if (typeof range.days === "number") return range.days;
			const d = new Date(Number.isFinite(ts) ? ts : Date.now());
			return d.getDate();
		}

		/**
		 * 每日序列 → 图表列（最多 24 列）。
		 *
		 * 逐日一根柱在「90 天窗口 + 稀疏活跃日」下会退化成一排 2px 的零柱，所以按
		 * 需要的跨度合并相邻若干天成一列；列标题仍给精确数字（合并列给区间）。
		 *
		 * 起点取 `windowStart` 与**首个有数据的日**的较大者：实测本机只有两个活跃
		 * 周，从窗口下界画起会让左侧 1/3 全是空柱，看起来像「图表没加载」。
		 * 末列右端钳到今天，否则合并列会越过当天（轴上出现未来日期）。
		 *
		 * 四桶必须逐列累加：`in` 只是未缓存部分，缓存读/写占了实测输入的 97–99%，
		 * 只累加 `in` 会让日柱 tooltip 与其他卡片的「输入」差两个数量级（TS-17）。
		 *
		 * @returns `{ startDay, endDay, calls, in, cr, cw, out }[]`，按时间升序。
		 */
		function tokstatsDailyColumns(daily, windowStart, generatedAt) {
			const DAY = 86400000;
			const rows = Array.isArray(daily) ? daily : [];
			// 没有日序列就不画图：补一串零柱会让「无数据」看起来像「有数据但为零」。
			if (rows.length === 0) return [];
			const today = tokstatsDayKeyLocal(Number.isFinite(generatedAt) ? generatedAt : Date.now());
			const last = rows.length > 0 && rows[rows.length - 1].day > today ? rows[rows.length - 1].day : today;
			const first = rows[0].day;
			const start = typeof windowStart === "string" && windowStart.length > 0 && windowStart > first
				? windowStart
				: first;
			const startMs = tokstatsDayMs(start);
			const lastMs = tokstatsDayMs(last);
			if (!Number.isFinite(startMs) || !Number.isFinite(lastMs) || startMs > lastMs) return [];
			const totalDays = Math.round((lastMs - startMs) / DAY) + 1;
			const span = Math.max(1, Math.ceil(totalDays / TOKSTATS_DAILY_COLUMNS));
			const count = Math.ceil(totalDays / span);
			const columns = [];
			for (let i = 0; i < count; i += 1) {
				const colStart = startMs + i * span * DAY;
				const colEnd = Math.min(colStart + (span - 1) * DAY, lastMs);
				columns.push({
					startDay: new Date(colStart).toISOString().slice(0, 10),
					endDay: new Date(colEnd).toISOString().slice(0, 10),
					calls: 0, in: 0, cr: 0, cw: 0, out: 0,
				});
			}
			for (const row of rows) {
				const offset = Math.round((tokstatsDayMs(row.day) - startMs) / DAY);
				if (!Number.isFinite(offset) || offset < 0) continue;
				const col = columns[Math.floor(offset / span)];
				if (col === undefined) continue;
				col.calls += row.calls ?? 0;
				col.in += row.in ?? 0;
				col.cr += row.cr ?? 0;
				col.cw += row.cw ?? 0;
				col.out += row.out ?? 0;
			}
			return columns;
		}

		function TokstatsKpi({ label, value, hint }) {
			return react.createElement("div", { className: "dsh-tokstats-kpi" },
				react.createElement("span", { className: "dsh-tokstats-kpiLabel" }, label),
				react.createElement("span", { className: "dsh-tokstats-kpiValue" }, value),
				react.createElement("span", { className: "dsh-tokstats-kpiHint" }, hint));
		}

		function TokstatsCard({ title, extra, children }) {
			return react.createElement("section", { className: "dsh-tokstats-card" },
				react.createElement("div", { className: "dsh-tokstats-cardHead" },
					react.createElement("span", { className: "dsh-tokstats-cardTitle" }, title),
					extra === undefined ? null : react.createElement("span", { className: "dsh-tokstats-cardExtra" }, extra)),
				children);
		}

		/**
		 * 一行「标签 · 比例条 · 数值 + 明细」——桶分布与工作区排行共用。
		 *
		 * 数值只放计数（短），四桶明细落到第二行：把 `输入 407M · 输出 971K · 命中
		 * 98%` 塞在同一行会把比例条挤成一小段，条长就失去可比性。
		 */
		function TokstatsMeter({ label, value, detail, ratio, title, dim }) {
			const width = Math.max(0, Math.min(100, (Number.isFinite(ratio) ? ratio : 0) * 100));
			return react.createElement("div", {
				className: "dsh-tokstats-meter" + (dim ? " dsh-tokstats-dim" : ""), title: title
			},
				react.createElement("span", { className: "dsh-tokstats-meterLabel" }, label),
				react.createElement("span", { className: "dsh-tokstats-meterTrack" },
					// 零值行不画填充：min-width 会让 0% 也留一截，看起来像「有数据」。
					width > 0
						? react.createElement("span", {
							className: "dsh-tokstats-meterFill", style: { width: width.toFixed(1) + "%" }
						})
						: null),
				react.createElement("span", { className: "dsh-tokstats-meterValue" }, value),
				detail === undefined || detail === null || detail === ""
					? null
					: react.createElement("span", { className: "dsh-tokstats-meterDetail" }, detail));
		}

		/**
		 * 工作区路径的可读尾段：末两段目录（`…\JavaScript\dsh-plugins`）。
		 *
		 * 排行表里要的是「哪个项目」，前缀对每一行都相同，占满列宽反而把差异挤没了；
		 * 完整路径仍在 tooltip 里。
		 */
		function tokstatsPathTail(path) {
			const parts = String(path ?? "").split(/[\\/]+/).filter((part) => part.length > 0);
			if (parts.length <= 2) return String(path ?? "");
			return "\u2026\\" + parts.slice(-2).join("\\");
		}

		function TokstatsRow({ label, value, title, dim }) {
			return react.createElement("div", {
				className: "dsh-tokstats-row" + (dim ? " dsh-tokstats-dim" : ""), title: title
			},
				react.createElement("span", { className: "dsh-tokstats-rowLabel" }, label),
				react.createElement("span", { className: "dsh-tokstats-rowValue" }, value));
		}

		function TokstatsRefreshIcon() {
			return react.createElement("svg", {
				width: 14, height: 14, viewBox: "0 0 16 16", fill: "none",
				"aria-hidden": "true", style: { display: "block" }
			},
				react.createElement("path", {
					d: "M13.2 8a5.2 5.2 0 1 1-1.7-3.9M13.4 2.6v2.8h-2.8",
					stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round",
					strokeLinejoin: "round", fill: "none"
				}));
		}

		/**
		 * 全局面板（root `main` keyed slot，id = TOKSTATS_PANEL_ID）。
		 *
		 * 主体只有两块独有价值（Q5：用法健康度）：上下文桶分布 + 周粒度趋势；
		 * 工作区是分组维度。模型与成本维度整体删除（Q6），故不渲染模型表、不含金额。
		 */
		function TokstatsPanel({ t }) {
			const [rangeId, setRangeId] = react.useState(TOKSTATS_DEFAULT_RANGE);
			const [workspace, setWorkspace] = react.useState("");
			const [phase, setPhase] = react.useState("loading");
			const [data, setData] = react.useState(null);
			// promptopt 计数器（AC-13）：与主报表分开拉，取不到就整块不渲染——
			// 它只是「这个功能用没用起来」的旁证，不该拖累桶分布。
			const [promptopt, setPromptopt] = react.useState(null);
			// 手动刷新计数：只用来把 effect 再跑一遍（窗口/工作区未变时按钮仍要能拉一次）。
			const [nonce, setNonce] = react.useState(0);
			// ctx 在 apply 时由闭包持有（slot 组件不接收 ctx）；每次请求取一份新控制器，
			// effect 清理时 abort 掉在飞请求。
			const ctxRef = react.useRef(tokstatsCtx);
			// 「这次 effect 是后台自动重拉」的标记（TS-25）。
			//
			// 它是 ref 而不是 state：它只影响**本次 effect 的行为**（要不要把
			// 已有内容换成「统计中…」），不需要触发渲染——真正要渲染的「有没有
			// 数据」由 `data` 承担。
			//
			// 为什么要这个标记：自动重拉期间**旧数据仍然有效**（它就是 host 手头
			// 能给出的最好值，只是可能偏低），把它换成「统计中…」会让整块内容
			// 卸载再挂回——1.5 s 一轮、连续 3–4 轮时用户看到的是高频闪烁，而
			// 闪烁期间一行数字都读不到。改成「保留旧内容 + 页脚提示校验中」后，
			// 数据始终在屏上，只是数值随后台校验逐步变准。
			const backgroundRef = react.useRef(false);

			const range = TOKSTATS_RANGES.find((r) => r.id === rangeId) ?? TOKSTATS_RANGES[0];
			// 请求期的折算时刻：同一档位内多次重拉要用同一个 `today`，否则跨零点
			// 前后算出的 windowDays 会差一天（「本月」在 1 号零点最明显）。
			const rangeDays = tokstatsRangeDays(range, Date.now());

			react.useEffect(() => {
				const controller = new AbortController();
				// 后台自动重拉：**不**把 phase 打回 loading，已有内容继续留在屏上。
				// 首次加载与用户主动操作（切档位/切工作区/点刷新）才走 loading。
				const background = backgroundRef.current;
				if (!background) setPhase("loading");
				void (async () => {
					const request = { windowDays: rangeDays };
					if (workspace !== "") request.workspace = workspace;
					const [value, counters] = await Promise.all([
						tokstatsFetchSummary(ctxRef.current, request, controller.signal),
						tokstatsFetchPromptopt(ctxRef.current, controller.signal),
					]);
					if (controller.signal.aborted) return;
					setPromptopt(counters === undefined || counters === null ? null : counters);
					if (value === undefined || value === null) {
						setPhase("empty");
						setData(null);
						return;
					}
					setData(value);
					if (!background) setPhase("ready");
					// 后台校验未完成（TS-24）：host 先用缓存秒开、把滞后会话的冷读排进
					// 后台队列。这里按退避自动重拉一次，直到 `verifying` 消失——用户看到的
					// 是「立刻有数 → 几秒后自动变成准确值」，而不是十几秒空等。
					//
					// 只在 `verifying === true` 时重拉：旧 host 没有该字段（undefined），
					// 不能因此陷入无限重拉（硬规则 6）。`nonce` 是手动刷新计数，也参与
					// 依赖，避免重拉时把用户的刷新意图丢掉。
					if (value.verifying === true) {
						const timer = setTimeout(() => {
							if (controller.signal.aborted) return;
							// 标记下一次 effect 是后台重拉：不卸载已有内容（TS-25）。
							backgroundRef.current = true;
							setNonce((n) => n + 1);
						}, background ? TOKSTATS_VERIFY_BACKOFF_MS : TOKSTATS_VERIFY_RETRY_MS);
						// 清理时取消重拉：组件卸载或档位切换后不该再打旧请求。
						controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
					}
				})();
				return () => controller.abort();
			}, [rangeDays, workspace, nonce]);

			const rangeButton = (entry) => react.createElement("button", {
				key: entry.id,
				type: "button",
				className: "dsh-tokstats-switch" + (rangeId === entry.id ? " dsh-tokstats-switchOn" : ""),
				// 用户主动切档位：清掉「后台重拉」标记（TS-25）。新窗口的旧数据与
				// 新窗口口径不同，留着会显示「上一个窗口的数字」——那种错比闪烁更糟。
				onClick: () => { backgroundRef.current = false; setRangeId(entry.id); }
			}, t("range." + entry.id));

			const buckets = data !== null && Array.isArray(data.buckets) ? data.buckets : [];
			const weekly = data !== null && Array.isArray(data.weekly) ? data.weekly : [];
			const daily = data !== null && Array.isArray(data.daily) ? data.daily : [];
			const workspaces = data !== null && Array.isArray(data.workspaces) ? data.workspaces : [];
			// `routes` 是第二批才有的字段：旧 host 返回没有它时这里拿到空数组，
			// 整卡不渲染（与 daily 同一手法，硬规则 6 的优雅降级）。
			const routes = data !== null && Array.isArray(data.routes) ? data.routes : [];
			const totals = data !== null && data.totals !== null && typeof data.totals === "object"
				? data.totals
				: { calls: 0, in: 0, cr: 0, cw: 0, out: 0 };

			const hasBuckets = buckets.some((b) => (b?.calls ?? 0) > 0);
			const hasWeekly = weekly.length > 0;
			const hasData = hasBuckets || hasWeekly || daily.length > 0 || (totals.calls ?? 0) > 0;

			const billedTotal = tokstatsBilled(totals);
			const hitTotal = tokstatsHit(totals);
			const totalCalls = totals.calls ?? 0;
			const days = data !== null && Number.isFinite(data.windowDays) ? data.windowDays : rangeDays;
			const perDay = days > 0 && totalCalls > 0 ? totalCalls / days : 0;
			const windowStart = data !== null && typeof data.windowStart === "string" ? data.windowStart : "";

			// ── 覆盖率披露（TS-21 / AC-2）──────────────────────────────────────
			//
			// `coverage` 是 batch 1 才有的字段：旧 host 返回没有它时拿到 undefined，
			// 整句不渲染（与 routes / daily 同一手法，硬规则 6 的优雅降级）——**不得**
			// 退化成「已统计 0 个会话」，那是假零。
			//
			// `skipped === 0` 时也不渲染「跳过」半句：把「一个都没跳过」写成「跳过 0 个」
			// 会让读者以为这条路走过、只是恰好没问题，而动过它。
			const coverage = data !== null && data.coverage !== null && typeof data.coverage === "object"
				? data.coverage
				: null;
			const coverageSessions = coverage !== null && Number.isFinite(coverage.sessions) ? coverage.sessions : null;
			// 后台校验中（TS-24）时**不得**把待校验的会话算进「跳过（日志不可读）」：
			// 它们的 summary 只是还没读出来，不是读不出来。首帧实测会把 68 个待校验
			// 会话写成「跳过 68 个（日志不可读）」——那是对用户谎报故障。
			const verifying = data !== null && data.verifying === true;
			const coverageSkipped = !verifying && coverage !== null && Number.isFinite(coverage.skipped)
				? coverage.skipped
				: 0;

			// ── 折叠历史代表日（TS-22 / AC-3）──────────────────────────────────
			//
			// host 的 epoch.end 是折叠区间末端，明细在读取期被挂到**前一天**当代表日
			// （host 侧 tokstatsDayBefore 同口径）。这里必须用同一条式子算那个日键，
			// 才能在图里找到对应列——两边各写一份时，一边改成「end 当天」就打不中。
			//
			// 只有 epoch 非 null 且有 calls 才算有折叠历史；host 已经在三种边角
			// （代表日窗口外 / 全零 / 无格被计入）返回 null，这里不重复判断窗口。
			const epoch = data !== null && data.epoch !== null && typeof data.epoch === "object"
				&& typeof data.epoch.end === "string"
				? data.epoch
				: null;
			const epochDay = epoch === null ? null : tokstatsDayBeforeLocal(epoch.end);
			const epochCalls = epoch !== null && Number.isFinite(epoch.calls) ? epoch.calls : 0;

			const peakBucketIndex = buckets.reduce(
				(best, cell, i) => ((cell?.calls ?? 0) > (buckets[best]?.calls ?? 0) ? i : best), 0);
			const dailyColumns = tokstatsDailyColumns(daily, windowStart, data?.generatedAt);
			const peakDay = dailyColumns.reduce((max, col) => Math.max(max, col.calls), 0);
			const peakDayLabel = dailyColumns.reduce(
				(best, col) => (col.calls > (best?.calls ?? 0) ? col : best), null);
			// 峰值柱的**唯一**标识：并列峰值时只标第一根（见柱渲染处的说明）。
			const peakDayKey = peakDay > 0 && peakDayLabel !== null ? peakDayLabel.startDay : null;
			const workspaceTotalCalls = workspaces.reduce((sum, entry) => sum + (entry.calls ?? 0), 0);
			const routeTotalCalls = routes.reduce((sum, entry) => sum + (entry.calls ?? 0), 0);
			// 输出占计费输入的比例（TS-17 的「输出」副值）：分母为 0 时返回 null，
			// 副值渲染破折号而不是编一个 0%。
			const outputShare = tokstatsPct(totals.out ?? 0, billedTotal);

			const kpis = react.createElement("div", { className: "dsh-tokstats-kpiGrid" },
				react.createElement(TokstatsKpi, {
					label: t("kpi.calls"),
					value: fmtTok(totalCalls),
					hint: days > 0 ? t("kpi.callsHintDays", { rate: perDay.toFixed(1) }) : t("kpi.callsHintAll"),
				}),
				react.createElement(TokstatsKpi, {
					label: t("kpi.billed"),
					value: fmtTok(billedTotal),
					hint: t("kpi.billedHint", { uncached: fmtTok(totals.in ?? 0), cached: fmtTok(totals.cr ?? 0) }),
				}),
				// 「输出」副值 = 输出占计费输入的比值（TS-17）：它拆的是本卡的主值，
				// 而不是复述别的卡。此前写的是「缓存写 N」——那是输入侧的第三个桶，
				// 与「输出」毫无关系，四张卡因此只剩三份信息。
				react.createElement(TokstatsKpi, {
					label: t("kpi.output"),
					value: fmtTok(totals.out ?? 0),
					hint: outputShare === null ? "\u2014" : t("kpi.outputHint", { pct: outputShare }),
				}),
				// 「缓存命中率」副值 = 这个百分比的分子与分母（命中 tokens / 计费输入），
				// 让人能心算校验 1% 是怎么来的。此前写「缓存读 N」，与「输入」卡的
				// 拆分是同一条信息，等于复述。
				react.createElement(TokstatsKpi, {
					label: t("kpi.hit"),
					value: hitTotal + "%",
					hint: t("kpi.hitHint", { cached: fmtTok(totals.cr ?? 0), billed: fmtTok(billedTotal) }),
				}));

			const bucketCard = react.createElement(TokstatsCard, {
				title: t("section.bucket"),
				extra: hasBuckets ? t("extra.peakBucket", { bucket: TOKSTATS_BUCKET_LABELS[peakBucketIndex] }) : undefined,
			},
				TOKSTATS_BUCKET_LABELS.map((label, i) => {
					const cell = buckets[i] ?? { calls: 0, in: 0, cr: 0, cw: 0, out: 0 };
					const billed = tokstatsBilled(cell);
					const hit = tokstatsHit(cell);
					const calls = cell.calls ?? 0;
					const ratio = totalCalls > 0 ? calls / totalCalls : 0;
					return react.createElement(TokstatsMeter, {
						key: label,
						label: label,
						dim: calls === 0,
						ratio: ratio,
						value: calls > 0 ? tCount(t, "cell.calls", calls, {}) : "\u2014",
						detail: calls > 0
							? t("cell.bucketDetail", {
								input: fmtTok(billed), output: fmtTok(cell.out ?? 0), hit: hit
							})
							: undefined,
						title: tCount(t, "tip.bucket", calls, {
							bucket: label, input: fmtTok(billed), output: fmtTok(cell.out ?? 0), hit: hit
						}),
					});
				}));

			const dailyCard = dailyColumns.length > 0
				? react.createElement(TokstatsCard, {
					title: t("section.daily"),
					extra: peakDay > 0
						? tCount(t, "extra.peakDay", peakDay, { day: peakDayLabel?.startDay ?? "" })
						: undefined,
				},
					react.createElement("div", { className: "dsh-tokstats-chart" },
						// 左轴：三个刻度值（0 / 峰值÷2 / 峰值）。**位置按平方根刻度算**，
						// 而不是均分——柱高是 `sqrt(calls / peak)`，把「峰值÷2」画在
						// 绘图区正中间会让读者按线性比例读出一个不存在的值（那个位置
						// 实际是峰值÷4）。`sqrt(0.5) ≈ 70.7%` 就是峰值÷2 的真实高度。
						//
						// `fmtTok` 负责 K/M 记号；记号本身不进词典（AGENTS 硬规则 7）。
						// 窄窗（≤900px）隐藏中间刻度：三行标签在 40px 宽轴里会互相挤压，
						// 留首末两个仍能读出量级（见 CSS 的 @media）。
						react.createElement("div", { className: "dsh-tokstats-axisY" },
							react.createElement("span", { className: "dsh-tokstats-axisTick dsh-tokstats-axisTickTop" },
								fmtTok(peakDay)),
							react.createElement("span", { className: "dsh-tokstats-axisTick dsh-tokstats-axisTickMid" },
								fmtTok(peakDay / 2)),
							react.createElement("span", { className: "dsh-tokstats-axisTick dsh-tokstats-axisTickBase" },
								"0")),
						react.createElement("div", { className: "dsh-tokstats-chartMain" },
							// 绘图区：网格线绝对定位在绘图区底边之上，柱体照常按 flex 排。
							// `title` 是 TS-23 要求的刻度口径说明——`Math.sqrt` 未声明时
							// 读者会按线性误读「三根差不多高 = 三天差不多量」。
							react.createElement("div", {
								className: "dsh-tokstats-chartPlot",
								title: t("tip.dailyScale")
							},
								react.createElement("span", { className: "dsh-tokstats-gridLine dsh-tokstats-gridLineTop" }),
								react.createElement("span", { className: "dsh-tokstats-gridLine dsh-tokstats-gridLineMid" }),
								react.createElement("div", { className: "dsh-tokstats-bars" },
									dailyColumns.map((col) => {
										// 平方根刻度：实测日量差异可达 100 倍（单日 1286 次 vs 12 次），
										// 线性刻度下除峰值外全部压成 1–2px 的细线，趋势就看不出来了。
										// 精确数值在 tooltip 与页脚，柱子只负责表达形状。
										const ratio = peakDay > 0 ? Math.sqrt(Math.max(0, col.calls) / peakDay) : 0;
										const height = ratio > 0 ? Math.max(4, Math.round(ratio * 100)) : 0;
										const span = col.startDay === col.endDay
											? col.startDay
											: t("daily.span", { start: tokstatsDayLabel(col.startDay), end: tokstatsDayLabel(col.endDay) });
										// 折叠历史标记（TS-22）：这一列含 epoch 归并进来的历史明细，
										// 它的高度不代表那一天真的用了这么多。判据是「代表日落在该列的
										// [startDay, endDay] 区间内」——列会被合并（跨度大于一天），只比
										// startDay 会在合并列上漏标。
										const hasEpochHistory = epochDay !== null && epochDay >= col.startDay && epochDay <= col.endDay;
										const tipParams = { span: span, input: fmtTok(tokstatsBilled(col)), output: fmtTok(col.out ?? 0) };
										const baseTip = tCount(t, "tip.day", col.calls, tipParams);
										// 峰值柱顶标数值（TS-23）：其余柱只在 hover 时给 tooltip，
										// 峰值那根是读者第一眼要读的数，不该要求他去悬停。
										// 并列峰值只标第一根：同一屏上出现两个同值标签会让读者
										// 以为「两根都标了 = 都值得看」，而它们本来就是同一个数。
										const isPeak = peakDayKey !== null && col.startDay === peakDayKey;
										return react.createElement("span", {
											key: col.startDay,
											className: "dsh-tokstats-bar" + (hasEpochHistory ? " dsh-tokstats-barEpoch" : ""),
											title: hasEpochHistory
												? tCount(t, "tip.dayEpoch", col.calls, { ...tipParams, epochCalls: epochCalls })
												: baseTip,
										},
											// 零列不画柱：基线由容器底边承担，画 2px 灰柱会连成虚线，
											// 看起来像「有很小的数据」。
											height > 0
												? react.createElement("span", {
													className: "dsh-tokstats-barFill",
													style: { height: height + "%" }
												},
													isPeak
														? react.createElement("span", {
															className: "dsh-tokstats-barPeak"
														}, fmtTok(col.calls))
														: null)
												: null);
									})),
								),
								// 横轴（首末日期）留在绘图区**下方**，与绘图区左对齐；纵轴刻度
								// 是绘图区左侧的独立一列，两者不共用容器——共用时 `bottom`
								// 定位的刻度会以「绘图区 + 横轴」为基准，刻度会漂到柱体中部。
								react.createElement("div", { className: "dsh-tokstats-axis" },
									react.createElement("span", null, tokstatsDayLabel(dailyColumns[0].startDay)),
									react.createElement("span", null, tokstatsDayLabel(dailyColumns[dailyColumns.length - 1].endDay)))))) : null;

			const weeklyCard = hasWeekly
				? react.createElement(TokstatsCard, {
					title: t("section.trend"),
					extra: tCount(t, "extra.weeks", weekly.length, {}),
				},
					react.createElement("div", { className: "dsh-tokstats-table" },
						react.createElement("div", { className: "dsh-tokstats-tableHead" },
							react.createElement("span", null, t("col.week")),
							react.createElement("span", null, t("col.calls")),
							react.createElement("span", null, t("col.input")),
							react.createElement("span", null, t("col.output"))),
						weekly.map((week) => react.createElement("div", {
							key: week.weekStart, className: "dsh-tokstats-row"
						},
							react.createElement("span", { className: "dsh-tokstats-rowLabel" }, tokstatsDayLabel(week.weekStart)),
							react.createElement("span", { className: "dsh-tokstats-cellNum" }, fmtTok(week.calls ?? 0)),
							react.createElement("span", { className: "dsh-tokstats-cellNum" }, fmtTok(tokstatsBilled(week))),
							react.createElement("span", { className: "dsh-tokstats-cellNum" }, fmtTok(week.out ?? 0))))))
				: null;

			const workspaceCard = workspaces.length > 0
				? react.createElement(TokstatsCard, {
					title: t("section.workspace"),
					extra: tCount(t, "extra.workspaces", workspaces.length, {}),
				},
					workspaces.map((entry) => react.createElement(TokstatsMeter, {
						key: entry.path,
						label: tokstatsPathTail(entry.path),
						ratio: workspaceTotalCalls > 0 ? (entry.calls ?? 0) / workspaceTotalCalls : 0,
						value: tCount(t, "cell.calls", entry.calls ?? 0, {}),
						detail: t("cell.workspaceDetail", {
							input: fmtTok(tokstatsBilled(entry)), output: fmtTok(entry.out ?? 0)
						}),
						title: tCount(t, "tip.workspace", entry.calls ?? 0, {
							path: entry.path, input: fmtTok(tokstatsBilled(entry)), output: fmtTok(entry.out ?? 0)
						}),
					})))
				: null;

			// 模型排行（Q11/Q13）：与工作区卡同构——全量列出、占比条、次数、明细。
			// 标签是 host 拼好的不透明串（client 不拆、不解释，I1′）；空串行是
			// 「未标注」，文案走词典并加 dim（既有的 .dsh-tokstats-dim）。
			const routeCard = routes.length > 0
				? react.createElement(TokstatsCard, {
					title: t("section.route"),
					extra: tCount(t, "extra.routes", routes.length, {}),
				},
					routes.map((entry) => {
						const unattributed = entry.rt === "";
						const label = unattributed ? t("route.unattributed") : entry.rt;
						const hit = tokstatsHit(entry);
						const billed = tokstatsBilled(entry);
						return react.createElement(TokstatsMeter, {
							// 空串不能当 React key（重复 key 警告且会错配行），换固定非空串。
							key: unattributed ? "\u0000unattributed" : entry.rt,
							label: label,
							dim: unattributed,
							ratio: routeTotalCalls > 0 ? (entry.calls ?? 0) / routeTotalCalls : 0,
							value: tCount(t, "cell.calls", entry.calls ?? 0, {}),
							detail: t("cell.routeDetail", {
								input: fmtTok(billed), output: fmtTok(entry.out ?? 0), hit: hit
							}),
							title: tCount(t, "tip.route", entry.calls ?? 0, {
								route: label,
								input: fmtTok(billed),
								output: fmtTok(entry.out ?? 0),
								hit: hit,
							}),
						});
					}))
				: null;

			// promptopt 使用情况（AC-13）：只有计数可用时才渲染整块。
			const promptoptCounters = promptopt !== null && typeof promptopt === "object" ? promptopt : null;
			const promptoptStarted = promptoptCounters?.started ?? 0;
			const promptoptAdopted = promptoptCounters?.adopted ?? 0;
			const promptoptRate = promptoptStarted > 0 ? Math.round((promptoptAdopted / promptoptStarted) * 100) : 0;
			const promptoptCard = promptoptCounters !== null
				? react.createElement(TokstatsCard, {
					title: t("section.promptopt"),
					extra: promptoptStarted > 0 ? t("extra.adoptRate", { rate: promptoptRate }) : undefined,
				},
					react.createElement("div", { className: "dsh-tokstats-miniGrid" },
						react.createElement(TokstatsRow, {
							label: t("row.promptopt"),
							value: t("value.promptopt", {
								started: promptoptStarted,
								adopted: promptoptAdopted,
								dismissed: promptoptCounters.dismissed ?? 0,
							}),
							title: t("tip.promptopt", {
								started: promptoptStarted,
								adopted: promptoptAdopted,
								dismissed: promptoptCounters.dismissed ?? 0,
								delta: (promptoptCounters.charsDelta ?? 0) >= 0
									? "+" + String(promptoptCounters.charsDelta ?? 0)
									: String(promptoptCounters.charsDelta ?? 0),
							}),
						}),
						react.createElement(TokstatsRow, {
							label: t("row.charsDelta"),
							dim: (promptoptCounters.charsDelta ?? 0) === 0,
							value: ((promptoptCounters.charsDelta ?? 0) >= 0 ? "+" : "") + String(promptoptCounters.charsDelta ?? 0),
							title: t("tip.charsDelta"),
						})))
				: null;

			const cards = react.createElement("div", { className: "dsh-tokstats-grid" },
				dailyCard,
				// 桶分布 2 份宽、周趋势 1 份宽：桶行是六条带明细的条，周趋势只有
				// 两个数字列，等宽会把条挤成半屏。
				react.createElement("div", { className: "dsh-tokstats-rowGrid" },
					bucketCard, weeklyCard),
				// 模型排行 2 份宽、工作区 1 份宽（Q13）：排行标签最长 42 字符
				// （deepseek-official/deepseek-v4-flash-vision-exp），而工作区标签取
				// 路径末两段、本来就短。promptopt 独占第四行。
				react.createElement("div", { className: "dsh-tokstats-rowGrid" },
					routeCard, workspaceCard),
				react.createElement("div", { className: "dsh-tokstats-rowGrid" },
					promptoptCard));

			const body = phase === "loading"
				? react.createElement("div", { className: "dsh-tokstats-empty" }, t("state.pending"))
				: phase === "empty"
					? react.createElement("div", { className: "dsh-tokstats-empty" }, t("empty.noService"))
					: !hasData
						? react.createElement("div", { className: "dsh-tokstats-empty" }, t("empty.noData"))
						: react.createElement(react.Fragment, null, kpis, cards);

			const rangeLabel = windowStart.length > 0
				? t("foot.range", { start: tokstatsDayLabel(windowStart), end: tokstatsDayLabel(tokstatsDayKeyLocal(Date.now())) })
				: t("foot.rangeAll");

			return react.createElement("div", { className: "dsh-tokstats-page", role: "region", "aria-label": t("panel.title") },
				react.createElement("div", { className: "dsh-tokstats-pageHeader" },
					react.createElement("span", { className: "dsh-tokstats-title" }, t("panel.title")),
					react.createElement("span", { className: "dsh-tokstats-badge" }, phase === "loading" ? t("state.pending") : ""),
					react.createElement("button", {
						type: "button",
						className: "dsh-tokstats-refresh" + (phase === "loading" ? " dsh-tokstats-refreshBusy" : ""),
						title: t("action.refresh"),
						"aria-label": t("action.refresh"),
						disabled: phase === "loading",
						// 用户主动刷新：清掉「后台重拉」标记（TS-25）。手动刷新是
						// 「我要最新的」，此刻旧数据已无参考价值，该换成 loading 态。
						onClick: () => { backgroundRef.current = false; setNonce(nonce + 1); },
					}, react.createElement(TokstatsRefreshIcon, null))),
				react.createElement("div", { className: "dsh-tokstats-toolbar" },
					react.createElement("div", { className: "dsh-tokstats-switches" },
						TOKSTATS_RANGES.map((entry) => rangeButton(entry))),
					workspaces.length > 0
						? react.createElement("select", {
							className: "dsh-tokstats-select",
							value: workspace,
							// 用户主动切工作区：同样清掉后台标记（TS-25），口径变了就
							// 不能留着旧工作区的数字。
							onChange: (event) => {
								backgroundRef.current = false;
								setWorkspace(event?.target?.value ?? "");
							}
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
						: "",
					// 后台校验中（TS-24）：这一帧用的是缓存值，滞后会话正在后台冷读。
					// 必须显式说出来，否则读者会把偏低的数字当成终值（那正是 TS-19
					// 当初要修的谎报，只是从「静默少报」变成「有时限的过渡态」）。
					// 旧 host 无该字段时不渲染。
					verifying
						? react.createElement("span", { className: "dsh-tokstats-footVerifying" }, t("foot.verifying"))
						: null,
					// 覆盖率披露（TS-21 / AC-2）：sessions 缺失（旧 host）时整句不渲染。
					// 计数走 .one/.other 成对键（硬规则 7），不是把数字拼进固定句子。
					coverageSessions !== null
						? react.createElement("span", {
							className: "dsh-tokstats-footCoverage",
							// tooltip 一句话说清「覆盖了多少、其中多少读不出来」。两个数都要，
							// 但计数键走 tCount（注入 count），会话总数走显式参数。
							title: coverageSkipped > 0
								? tCount(t, "tip.coverageSkipped", coverageSkipped, { sessions: coverageSessions })
								: tCount(t, "tip.coverage", coverageSessions, {}),
						},
							tCount(t, "foot.coverage", coverageSessions, {}),
							coverageSkipped > 0
								? react.createElement("span", { className: "dsh-tokstats-footSkipped" },
									tCount(t, "foot.skipped", coverageSkipped, {}))
								: null)
						: null,
					data !== null ? react.createElement("span", { className: "dsh-tokstats-footRange" }, rangeLabel) : null));
		}

		const tokstatsCss = [
			// 页面骨架：头部（标题 + 角标 + 刷新）/ 工具条（窗口档位 + 工作区）/ 可滚主体 / 页脚。
			".dsh-tokstats-page{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-secondary);flex-direction:column;display:flex;font-size:13px;line-height:20px;overflow:hidden}",
			".dsh-tokstats-pageHeader{box-sizing:border-box;align-items:center;gap:8px;min-height:52px;padding:12px 24px;display:flex;flex:none}",
			".dsh-tokstats-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:22px}",
			".dsh-tokstats-badge{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".dsh-tokstats-badge:empty{display:none}",
			".dsh-tokstats-refresh{margin-left:auto;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:7px;width:26px;height:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;flex:none}",
			".dsh-tokstats-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-tokstats-refresh:disabled{cursor:default;opacity:.5}",
			".dsh-tokstats-refreshBusy svg{animation:dsh-tokstats-spin 1s linear infinite}",
			"@keyframes dsh-tokstats-spin{to{transform:rotate(360deg)}}",
			".dsh-tokstats-toolbar{align-items:center;gap:12px;padding:0 24px 12px;display:flex;flex:none;flex-wrap:wrap}",
			".dsh-tokstats-switches{gap:2px;display:flex;background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:2px}",
			".dsh-tokstats-switch{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;padding:3px 10px;font:inherit;font-size:12px;line-height:16px}",
			".dsh-tokstats-switch:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			// 选中态（AC-7）：此前用 bg-layer-2 做底，与容器底只差 9 级灰度，实测
			// 「不知道当前在哪个档位」。改用品牌色实心 + 反色文字，明暗主题各自成立
			// （浅色下品牌色近黑、反色为白；深色下相反）。
			//
			// `:hover` 那条必须紧跟其后：`.dsh-tokstats-switch:hover` 是「一个类 +
			// 伪类」，特异性高于单个类选择器，不补这一条时鼠标停在选中项上会把
			// 品牌色底覆盖回 hover 灰，选中态在悬停时消失。
			".dsh-tokstats-switchOn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);box-shadow:var(--dsw-shadow-lv1,0 1px 2px rgba(0,0,0,.12))}",
			".dsh-tokstats-switchOn:hover{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}",
			".dsh-tokstats-select{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-button-elevated-fill);border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;padding:3px 8px;font:inherit;font-size:12px;line-height:16px;max-width:320px}",
			".dsh-tokstats-body{flex:1;min-height:0;padding:0 24px 16px;overflow-y:auto}",
			".dsh-tokstats-empty{color:var(--dsw-alias-label-tertiary);padding:48px 8px;text-align:center}",
			// KPI 行：四个指标卡，窄屏自动折成两列。
			".dsh-tokstats-kpiGrid{gap:12px;margin:0 0 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}",
			".dsh-tokstats-kpi{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;flex-direction:column;gap:2px;min-width:0;padding:10px 12px;display:flex}",
			".dsh-tokstats-kpiLabel{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden;font-size:11px;line-height:16px}",
			".dsh-tokstats-kpiValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-size:20px;font-weight:600;line-height:26px}",
			".dsh-tokstats-kpiHint{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden;font-size:11px;line-height:16px}",
			// 卡片栅格：每日图独占整行（时间序列要横向空间），其余按 2:1 分栏，
			// 窄屏（单栏不足 320px）时自动折成单列。
			".dsh-tokstats-grid{gap:12px;display:grid;grid-template-columns:1fr}",
			// 2:1 行用 stretch 而非 start（AC-6）：桶分布卡天然高于「趋势（按周）」，
			// start 会让右列在卡片下方留一大片空洞（实测约 218px），两卡的边框高
			// 度也对不齐。stretch 让两张卡等高，短的那张把内容顶部对齐、空白留在
			// 卡内而不是卡外。
			".dsh-tokstats-rowGrid{gap:12px;display:grid;grid-template-columns:2fr 1fr;align-items:stretch}",
			"@media (max-width:900px){.dsh-tokstats-rowGrid{grid-template-columns:1fr}}",
			".dsh-tokstats-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;flex-direction:column;min-width:0;padding:12px;display:flex}",
			".dsh-tokstats-cardHead{align-items:center;gap:8px;margin-bottom:8px;display:flex}",
			".dsh-tokstats-cardTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px}",
			".dsh-tokstats-cardExtra{color:var(--dsw-alias-label-tertiary);margin-left:auto;font-variant-numeric:tabular-nums;font-size:11px;line-height:16px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-tokstats-row{align-items:center;gap:12px;padding:3px 0;display:flex}",
			".dsh-tokstats-rowLabel{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;min-width:0;text-overflow:ellipsis;white-space:nowrap;flex:none;max-width:42%;overflow:hidden}",
			".dsh-tokstats-rowValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
			// 比例条：桶分布与工作区排行共用。轨道用 layer-2 底，填充用品牌色。
			// 标签列定宽、数值列定宽，轨道 flex:1 吃满中间——三行的条长才可比。
			".dsh-tokstats-meter{align-items:center;column-gap:10px;row-gap:0;padding:5px 0;display:grid;grid-template-columns:minmax(0,12.5em) minmax(40px,1fr) auto;grid-template-areas:'label track value' 'detail detail detail'}",
			".dsh-tokstats-meterLabel{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;grid-area:label;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}",
			".dsh-tokstats-meterTrack{background:var(--dsw-alias-bg-layer-2);border-radius:3px;grid-area:track;height:6px;overflow:hidden}",
			".dsh-tokstats-meterFill{background:var(--dsw-alias-brand-primary);border-radius:3px;display:block;height:100%}",
			".dsh-tokstats-meterValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;grid-area:value;text-align:right;white-space:nowrap}",
			".dsh-tokstats-meterDetail{color:var(--dsw-alias-label-tertiary);grid-area:detail;font-variant-numeric:tabular-nums;font-size:11px;line-height:15px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			// ── 每日柱状图（TS-23：可读性下限）────────────────────────────────
			//
			// 结构：`.chart` = 纵轴刻度列 + 绘图区；绘图区内 = 网格线层 + 柱容器，
			// 横轴（首末日期）在绘图区下方。纵轴刻意不放进绘图区：绘图区的高度是
			// 「柱高 100%」的参照系，刻度也要按同一参照系绝对定位，两者必须是同一
			// 个盒子（否则刻度会以「绘图区 + 横轴」为基准而整体上移）。
			".dsh-tokstats-chart{display:flex;align-items:stretch;gap:6px;margin-top:4px}",
			".dsh-tokstats-chartMain{flex:1;min-width:0;display:flex;flex-direction:column}",
			// 绘图区：柱容器撑满高度，网格线绝对定位在底边之上。底边那条 1px 边框
			// 就是「0 刻度」，因此网格线只画 70.7%（峰值÷2）与 100%（峰值）两条就
			// 够读出量级。
			".dsh-tokstats-chartPlot{position:relative;height:112px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
			// 网格线：主题变量、不写死颜色（深色主题下 --border-l1 是白色低透明度）。
			// 中间那条对应「峰值÷2」在**平方根刻度**下的真实位置 sqrt(0.5)=70.7%，
			// 不是 50%——与纵轴刻度共用同一个位置值，改一处必须改另一处。
			".dsh-tokstats-gridLine{position:absolute;left:0;right:0;border-top:1px dashed var(--dsw-alias-border-l1);pointer-events:none}",
			".dsh-tokstats-gridLineTop{bottom:100%}",
			".dsh-tokstats-gridLineMid{bottom:70.7%}",
			// 纵轴刻度：定宽右对齐，三个 span 按 bottom 绝对定位在刻度列内。刻度列
			// 的高度必须等于绘图区的 112px，故单独给高度（它是绘图区的兄弟节点）。
			".dsh-tokstats-axisY{position:relative;flex:none;width:44px;height:112px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:10px;line-height:14px}",
			".dsh-tokstats-axisTick{position:absolute;right:0;text-align:right;white-space:nowrap;transform:translateY(50%)}",
			// 三个刻度与网格线共用同一组位置（100% / 70.7% / 0）：轴列的高度与绘图区
			// 同为 112px，百分比因此等价于像素。用百分比而不是写死像素，改图高时
			// 刻度与网格线一起跟随。
			".dsh-tokstats-axisTickTop{bottom:100%}",
			".dsh-tokstats-axisTickMid{bottom:70.7%}",
			".dsh-tokstats-axisTickBase{bottom:0;transform:translateY(0)}",
			// 柱容器：`justify-content:center` 让少列时整组柱居中而不是挤在左侧
			// （`max-width` 触顶后 flex 无法再把剩余空间分给柱体，只能由容器决定
			// 余量落在哪）。60 列时每列约 13–20px，远低于 48px 上限，该上限对
			// 密排无影响。
			".dsh-tokstats-bars{align-items:flex-end;gap:2px;height:100%;display:flex;justify-content:center}",
			// 柱宽上限（TS-23 / AC-4）：近 7 天窗口只有 3 个活跃日时，纯 `flex:1`
			// 会把每列拉到约 306 CSS px——柱宽从此表达的是「窗口里没几天」而不是
			// 「数据有多大」。48px 是「看得出是一根柱」的上限。
			".dsh-tokstats-bar{box-sizing:border-box;flex:1;min-width:3px;max-width:48px;height:100%;display:flex;align-items:flex-end;position:relative}",
			".dsh-tokstats-barFill{background:var(--dsw-alias-brand-primary);border-radius:2px 2px 0 0;width:100%;display:block;opacity:.85;position:relative}",
			".dsh-tokstats-bar:hover .dsh-tokstats-barFill{opacity:1}",
			// 峰值柱顶标数值（TS-23）：绝对定位在柱顶上方，不改变柱高；用主题
			// 次要文字色而不是品牌色——它标的是数字，不是数据长度。
			".dsh-tokstats-barPeak{position:absolute;left:50%;bottom:calc(100% + 2px);transform:translateX(-50%);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:10px;line-height:12px;white-space:nowrap;pointer-events:none}",
			// 折叠历史列（TS-22）：斜纹 + 次要色，与真实日区分。用 repeating-linear-gradient
			// 而不是换颜色，因为「柱高不代表当天」这件事不能用「颜色深浅」表达（会被读成
			// 数据大小）。纹理由透明层叠加，柱体本身的品牌色仍在，仍能看出量级。
			".dsh-tokstats-barEpoch .dsh-tokstats-barFill{background:repeating-linear-gradient(135deg,var(--dsw-alias-brand-primary) 0 4px,transparent 4px 8px),var(--dsw-alias-bg-layer-2);opacity:.7;outline:1px dashed var(--dsw-alias-border-l1);outline-offset:-1px}",
			// 横轴（首末日期）：与绘图区左对齐，故左边留出纵轴刻度的宽度 + gap。
			".dsh-tokstats-axis{color:var(--dsw-alias-label-tertiary);margin-top:6px;font-variant-numeric:tabular-nums;font-size:10px;line-height:14px;justify-content:space-between;display:flex}",
			// 窄窗（≤900px）：三行纵轴标签在 44px 列里会互相挤压，隐藏中间那个，
			// 留首末两个仍能读出量级（au3-7f）。
			"@media (max-width:900px){.dsh-tokstats-axisTickMid{display:none}}",
			// 周趋势表：四列等宽数字（周起点 / 次数 / 输入 / 输出）。
			".dsh-tokstats-table{flex-direction:column;display:flex}",
			".dsh-tokstats-tableHead{color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1);gap:12px;padding:0 0 4px;margin-bottom:2px;font-size:11px;line-height:16px;display:flex}",
			".dsh-tokstats-tableHead>span{flex:1;min-width:0}",
			".dsh-tokstats-tableHead>span:first-child{flex:0 0 42%}",
			".dsh-tokstats-tableHead>span:not(:first-child){text-align:right}",
			".dsh-tokstats-cellNum{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);text-align:right;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			// promptopt 计数器：两行（三计数 + 字符增减）。窄栏里标签允许换行——
			// 这两行的标签较长（英文尤其），单行省略会截成「started / adopted / dis…」。
			".dsh-tokstats-miniGrid{flex-direction:column;display:flex}",
			".dsh-tokstats-miniGrid .dsh-tokstats-rowLabel{max-width:none;flex:1 1 auto;white-space:normal;overflow:visible}",
			".dsh-tokstats-dim{opacity:.55}",
			".dsh-tokstats-foot{color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l2);gap:12px;padding:8px 24px;font-size:11px;line-height:16px;flex:none;min-height:16px;display:flex;flex-wrap:wrap}",
			// 覆盖率披露（TS-21）：允许收缩并省略，窄窗下不许把右侧区间挤掉。
			".dsh-tokstats-footCoverage{min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}",
			".dsh-tokstats-footSkipped{color:var(--dsw-alias-label-secondary)}",
			// 后台校验中（TS-24）：用次要色 + 不抢版面，明确是过渡态而不是终值。
			".dsh-tokstats-footVerifying{color:var(--dsw-alias-label-secondary)}",
			".dsh-tokstats-footRange{margin-left:auto;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
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
			"range.days7": "近 7 天",
			"range.month": "本月",
			"range.days30": "近 30 天",
			"range.all": "全部",
			"action.refresh": "重新统计",
			"kpi.calls": "调用次数",
			"kpi.callsHintDays": "日均 {rate} 次",
			"kpi.callsHintAll": "全部历史",
			"kpi.billed": "输入",
			"kpi.billedHint": "未缓存 {uncached} · 缓存读 {cached}",
			"kpi.output": "输出",
			"kpi.outputHint": "占输入 {pct}%",
			"kpi.hit": "缓存命中率",
			"kpi.hitHint": "命中 {cached} / {billed}",
			"section.bucket": "上下文长度分布（按计费输入）",
			"section.daily": "每日调用量",
			// 刻度口径说明（TS-23）：挂在绘图区的 tooltip 上。`Math.sqrt` 不在界面上
			// 出现，读者按线性直觉会把「三根差不多高」读成「三天差不多量」。
			//
			// 不写具体比例（如「峰值÷2 在 70% 高」）：那是 sqrt(0.5) 的推导结果，
			// 写进词典等于把刻度算式抄成文案，改刻度就得记得来改句子。轴上的中间
			// 刻度本身已经标着「峰值÷2」且画在正确高度，那句话由图形承担。
			"tip.dailyScale": "柱高按调用次数的平方根绘制（非线性刻度）；精确数值见各柱悬停提示",
			"section.trend": "趋势（按周）",
			"section.workspace": "工作区排行",
			"section.route": "模型排行",
			"section.promptopt": "提示词整理使用情况",
			"extra.peakBucket": "峰值 {bucket}",
			"extra.peakDay.one": "峰值 {day} · {count} 次",
			"extra.peakDay.other": "峰值 {day} · {count} 次",
			"extra.weeks.one": "{count} 周",
			"extra.weeks.other": "{count} 周",
			"extra.workspaces.one": "{count} 个",
			"extra.workspaces.other": "{count} 个",
			"extra.routes.one": "{count} 个",
			"extra.routes.other": "{count} 个",
			"route.unattributed": "未标注",
			"cell.routeDetail": "输入 {input} · 输出 {output} · 命中 {hit}%",
			"extra.adoptRate": "采纳率 {rate}%",
			"daily.span": "{start}–{end}",
			"tip.day.one": "{span}：{count} 次调用，输入 {input}，输出 {output}",
			"tip.day.other": "{span}：{count} 次调用，输入 {input}，输出 {output}",
			"col.week": "周起点",
			"col.calls": "次数",
			"col.input": "输入",
			"col.output": "输出",
			"row.promptopt": "发起 / 采纳 / 放弃",
			"row.charsDelta": "采纳后字符增减",
			"tip.charsDelta": "采纳的整理结果相对原文的字符增减合计",
			"value.promptopt": "{started} / {adopted} / {dismissed}",
			"tip.promptopt": "提示词整理：发起 {started} 次，采纳 {adopted} 次，放弃 {dismissed} 次；采纳后字符增减 {delta}",
			"workspace.all": "全部工作区",
			"workspace.item.one": "{path}（{count} 次）",
			"workspace.item.other": "{path}（{count} 次）",
			"row.bucket.one": "{count} 次 · 输入 {input} · 输出 {output} · 命中 {hit}%",
			"row.bucket.other": "{count} 次 · 输入 {input} · 输出 {output} · 命中 {hit}%",
			"cell.calls.one": "{count} 次",
			"cell.calls.other": "{count} 次",
			"cell.bucketDetail": "输入 {input} · 输出 {output} · 命中 {hit}%",
			"cell.workspaceDetail": "输入 {input} · 输出 {output}",
			"tip.bucket.one": "计费输入 {bucket} 的请求：{count} 次，计费输入 {input}，输出 {output}，缓存命中 {hit}%",
			"tip.bucket.other": "计费输入 {bucket} 的请求：{count} 次，计费输入 {input}，输出 {output}，缓存命中 {hit}%",
			"row.workspace.one": "{count} 次 · 输入 {input} · 输出 {output}",
			"row.workspace.other": "{count} 次 · 输入 {input} · 输出 {output}",
			"tip.workspace.one": "{path}：{count} 次调用，输入 {input}，输出 {output}",
			"tip.workspace.other": "{path}：{count} 次调用，输入 {input}，输出 {output}",
			"tip.route.one": "{route}：{count} 次调用，输入 {input}，输出 {output}，缓存命中 {hit}%",
			"tip.route.other": "{route}：{count} 次调用，输入 {input}，输出 {output}，缓存命中 {hit}%",
			"empty.noService": "统计服务不可用，无法读取会话数据",
			"empty.noData": "暂无数据（还没有 usage 记录）",
			"foot.generated": "生成于 {time}",
			"foot.verifying": "校验中…",
			"foot.range": "{start} – {end}",
			"foot.rangeAll": "全部历史",
			"foot.coverage.one": "已统计 {count} 个会话",
			"foot.coverage.other": "已统计 {count} 个会话",
			"foot.skipped.one": " · 跳过 {count} 个（日志不可读）",
			"foot.skipped.other": " · 跳过 {count} 个（日志不可读）",
			"tip.coverage.one": "本次统计覆盖 {count} 个会话的全部可读日志",
			"tip.coverage.other": "本次统计覆盖 {count} 个会话的全部可读日志",
			"tip.coverageSkipped.one": "本次统计覆盖 {sessions} 个会话；{count} 个会话日志不可读，其用量未计入",
			"tip.coverageSkipped.other": "本次统计覆盖 {sessions} 个会话；{count} 个会话日志不可读，其用量未计入",
			"tip.dayEpoch.one": "{span}：{count} 次调用，输入 {input}，输出 {output}。含折叠历史（区间末归并）· {epochCalls} 次",
			"tip.dayEpoch.other": "{span}：{count} 次调用，输入 {input}，输出 {output}。含折叠历史（区间末归并）· {epochCalls} 次",
		};

		const tokstatsEn = {
			"panel.title": "Token analytics",
			"panel.aria": "Token analytics",
			"state.pending": "Scanning…",
			"range.days7": "Last 7 days",
			"range.month": "This month",
			"range.days30": "Last 30 days",
			"range.all": "All time",
			"action.refresh": "Rescan",
			"kpi.calls": "Calls",
			"kpi.callsHintDays": "{rate} per day",
			"kpi.callsHintAll": "All history",
			"kpi.billed": "Input",
			"kpi.billedHint": "{uncached} uncached · {cached} cache read",
			"kpi.output": "Output",
			"kpi.outputHint": "{pct}% of input",
			"kpi.hit": "Cache hit rate",
			"kpi.hitHint": "{cached} cached / {billed}",
			"section.bucket": "Context length distribution (by billed input)",
			"section.daily": "Daily calls",
			"tip.dailyScale": "Bar height follows the square root of calls (non-linear scale); exact values are in each bar's tooltip",
			"section.trend": "Trend (weekly)",
			"section.workspace": "Workspaces",
			"section.route": "Models",
			"section.promptopt": "Prompt restructure usage",
			"extra.peakBucket": "Peak {bucket}",
			"extra.peakDay.one": "Peak {day} · {count} call",
			"extra.peakDay.other": "Peak {day} · {count} calls",
			"extra.weeks.one": "{count} week",
			"extra.weeks.other": "{count} weeks",
			"extra.workspaces.one": "{count} workspace",
			"extra.workspaces.other": "{count} workspaces",
			"extra.routes.one": "{count} route",
			"extra.routes.other": "{count} routes",
			"route.unattributed": "Unattributed",
			"cell.routeDetail": "{input} in · {output} out · {hit}% cached",
			"extra.adoptRate": "{rate}% adopted",
			"daily.span": "{start}–{end}",
			"tip.day.one": "{span}: {count} call · {input} in · {output} out",
			"tip.day.other": "{span}: {count} calls · {input} in · {output} out",
			"col.week": "Week of",
			"col.calls": "Calls",
			"col.input": "In",
			"col.output": "Out",
			"row.promptopt": "started / adopted / dismissed",
			"row.charsDelta": "Characters changed on adoption",
			"tip.charsDelta": "Total characters added or removed by adopted restructures",
			"value.promptopt": "{started} / {adopted} / {dismissed}",
			"tip.promptopt": "Prompt restructure: {started} started, {adopted} adopted, {dismissed} dismissed; characters changed on adoption {delta}",
			"workspace.all": "All workspaces",
			"workspace.item.one": "{path} ({count} call)",
			"workspace.item.other": "{path} ({count} calls)",
			"row.bucket.one": "{count} call · {input} in · {output} out · {hit}% cached",
			"row.bucket.other": "{count} calls · {input} in · {output} out · {hit}% cached",
			"cell.calls.one": "{count} call",
			"cell.calls.other": "{count} calls",
			"cell.bucketDetail": "{input} in · {output} out · {hit}% cached",
			"cell.workspaceDetail": "{input} in · {output} out",
			"tip.bucket.one": "Requests billed at {bucket} input: {count}, billed input {input}, output {output}, cache hit {hit}%",
			"tip.bucket.other": "Requests billed at {bucket} input: {count}, billed input {input}, output {output}, cache hit {hit}%",
			"row.workspace.one": "{count} call · {input} in · {output} out",
			"row.workspace.other": "{count} calls · {input} in · {output} out",
			"tip.workspace.one": "{path}: {count} call, {input} in, {output} out",
			"tip.workspace.other": "{path}: {count} calls, {input} in, {output} out",
			"tip.route.one": "{route}: {count} call, {input} in, {output} out, cache hit {hit}%",
			"tip.route.other": "{route}: {count} calls, {input} in, {output} out, cache hit {hit}%",
			"empty.noService": "Statistics service unavailable: session data cannot be read",
			"empty.noData": "No data yet (no usage recorded)",
			"foot.generated": "Generated at {time}",
			"foot.verifying": "Verifying…",
			"foot.range": "{start} – {end}",
			"foot.rangeAll": "All history",
			"foot.coverage.one": "{count} session included",
			"foot.coverage.other": "{count} sessions included",
			"foot.skipped.one": " · {count} skipped (unreadable log)",
			"foot.skipped.other": " · {count} skipped (unreadable log)",
			"tip.coverage.one": "This scan covers every readable log of {count} session",
			"tip.coverage.other": "This scan covers every readable log of {count} sessions",
			"tip.coverageSkipped.one": "This scan covers {sessions} sessions; {count} session has an unreadable log, so its usage is not counted",
			"tip.coverageSkipped.other": "This scan covers {sessions} sessions; {count} sessions have unreadable logs, so their usage is not counted",
			"tip.dayEpoch.one": "{span}: {count} call · {input} in · {output} out. Includes folded history (merged at the window end) · {epochCalls} call",
			"tip.dayEpoch.other": "{span}: {count} calls · {input} in · {output} out. Includes folded history (merged at the window end) · {epochCalls} calls",
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
		/** 上报一次采纳 / 放弃（计数器在 host 侧，浏览器只发事件）。 */
		const PROMPTOPT_EVENT_ENDPOINT = "event";

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

		/** 弹层：pending（转圈）/ ready（原文·重排文对照 + 采纳）/ error（按码查词典）。 */
		function PromptoptPopup({ snapshot, phase, result, onAdopt, onClose, anchor, panelRef, t }) {
			const ready = phase === "ready" && result !== null && result !== undefined;
			// F4：模型判定无需整理 → 采纳无意义，禁用按钮并说明原因。
			const noChange = ready && result.noChange === true;
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
						react.createElement("div", { className: "dsh-promptopt-label" }, t("panel.structured")),
						react.createElement("div", { className: "dsh-promptopt-optimized" }, result.text),
						noChange
							? react.createElement("div", { className: "dsh-promptopt-nochange" }, t("state.noChange"))
							: null)
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
							disabled: noChange,
							title: noChange ? t("tip.needless") : t("action.adopt"),
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
			// F4：模型判定原文已足够结构化时原样返回，此时采纳等于什么都不做，
			// 故禁用采纳按钮并给出提示。
			const noChange = result !== null && result !== undefined && result.noChange === true;

			/**
			 * 上报一次计数器事件（采纳 / 放弃）。
			 *
			 * 这是观测面而不是功能面：通道缺席、传输失败、宿主拒收都不影响交互——
			 * 计数丢一次远好于让用户点不动按钮。Promise 必须显式收尾：被遗弃的
			 * rejection 会冒成 unhandledRejection。
			 */
			function reportCounter(event, detail) {
				const rpc = promptoptConnection()?.rpc;
				if (rpc === undefined || rpc === null || typeof rpc.call !== "function") return;
				try {
					const pending = rpc.call(PROMPTOPT_CHANNEL, PROMPTOPT_EVENT_ENDPOINT, { event, ...(detail ?? {}) });
					if (pending !== undefined && pending !== null && typeof pending.catch === "function") pending.catch(() => {});
				} catch {
					/* 降级：计数失败静默 */
				}
			}

			/**
			 * 结果是否已经产出（放弃判定用）。
			 *
			 * 必须读 ref 而不是闭包里的 `result`：Esc/点外的监听器是 effect 注册的，
			 * 闭包捕获的是**注册那一轮**的 result（那时还是 null），直接用会让
			 * 「关掉已出结果的弹层」永远不计入放弃。
			 */
			const resultRef = react.useRef(null);

			/** 中止并收摊（关闭 / Esc / 点外共用）。已出结果时的关闭算「放弃」。 */
			function close() {
				const controller = controllerRef.current;
				if (controller !== null && controller !== undefined && typeof controller.abort === "function") controller.abort();
				controllerRef.current = null;
				// 只有「已拿到结果却没采纳」才算放弃：请求在飞时关闭是取消，不是放弃。
				if (resultRef.current !== null && resultRef.current !== undefined) reportCounter("dismissed");
				resultRef.current = null;
				setOpen(false);
				setPhase("idle");
				setResult(null);
			}

			/** 采纳：无条件写回优化文（快照胜出，没有二次确认）。 */
			function adopt() {
				const current = resultRef.current ?? result;
				if (current !== null && current !== undefined && typeof current.text === "string" && current.noChange !== true) {
					inputActions.setDraft(current.text);
					reportCounter("adopted", { before: snapshot.length, after: current.text.length });
				}
				resultRef.current = null;
				controllerRef.current = null;
				setOpen(false);
				setPhase("idle");
				setResult(null);
			}

			async function run() {
				const controller = new AbortController();
				controllerRef.current = controller;
				setSnapshot(draft);
				// 新一轮开始必须先把「上一轮的结果」清掉：否则请求在飞时关闭会被
				// close() 误判成「已出结果的放弃」。
				resultRef.current = null;
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
					resultRef.current = response.value;
					setPhase("ready");
					setResult(response.value);
					return;
				}
				const failure = { code: response.error?.code ?? "llm" };
				resultRef.current = failure;
				setPhase("error");
				setResult(failure);
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
			".dsh-promptopt-adopt:hover:not(:disabled){filter:brightness(1.08)}",
			".dsh-promptopt-adopt:disabled{opacity:.45;cursor:not-allowed}",
			".dsh-promptopt-nochange{color:var(--dsw-alias-label-tertiary);margin-top:8px;font-size:12px;line-height:18px}",
			".dsh-promptopt-foot{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}"
		].join("\n");

		const LOCALE_NS_PROMPTOPT = "dsh-plugins.promptopt";

		// 术语（两轴分离里只管 UI 轴）：整理 restructure / 采纳 adopt / 草稿 draft /
		// 原文 original / 整理结果 structured / 引用或图片 reference or image。
		// 按钮是纯图标位，功能靠 button.aria（同时用作 title 与 aria-label）表达。
		const promptoptZh = {
			"button.aria": "把这段草稿整理成结构化提示词",
			"disabled.empty": "先输入草稿再整理",
			"disabled.chips": "草稿含引用或图片，暂不支持整理",
			"panel.title": "提示词整理",
			"panel.close": "关闭",
			"panel.original": "原文",
			"panel.structured": "整理结果",
			"state.pending": "整理中…",
			"state.noChange": "原文已足够清晰，无需整理",
			"tip.needless": "整理结果与原文一致，无需采纳",
			"action.adopt": "采纳",
			"foot.done": "耗时 {seconds}s",
			"error.llm": "模型调用失败，请稍后重试",
			"error.timeout": "整理超时（60s），请重试",
			"error.badDraft": "草稿为空或过长，无法整理"
		};

		const promptoptEn = {
			"button.aria": "Restructure this draft into a structured prompt",
			"disabled.empty": "Type a draft first",
			"disabled.chips": "Drafts with references or images cannot be restructured",
			"panel.title": "Prompt restructure",
			"panel.close": "Close",
			"panel.original": "Original",
			"panel.structured": "Restructured",
			"state.pending": "Restructuring…",
			"state.noChange": "The draft is already clear — nothing to restructure",
			"tip.needless": "The result matches the original, so there is nothing to adopt",
			"action.adopt": "Adopt",
			"foot.done": "Took {seconds}s",
			"error.llm": "The model call failed — please try again",
			"error.timeout": "Restructuring timed out (60s) — please try again",
			"error.badDraft": "The draft is empty or too long to restructure"
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