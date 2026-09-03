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
		// Adding a plugin: one block below + one patch row (see README).
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
		function estimateBlocks(blocks) {
			if (!Array.isArray(blocks)) return 0;
			let tokens = 4;
			for (const block of blocks) {
				if (block === null || typeof block !== "object") continue;
				if (block.type === "text" || block.type === "reasoning") {
					tokens += Math.ceil(String(block.text == null ? "" : block.text).length / 4) + 4;
				} else {
					try { tokens += 4 + Math.ceil(JSON.stringify(block).length / 4); } catch (e) { tokens += 8; }
				}
			}
			return tokens;
		}
		function estimateQueue(queue) {
			if (!Array.isArray(queue)) return 0;
			let tokens = 0;
			for (const m of queue) {
				if (m === null || typeof m !== "object") continue;
				if (typeof m.text === "string") tokens += estimateText(m.text);
				else tokens += estimateBlocks(m.content);
			}
			return tokens;
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

		function PredictionLine({ useSession, useProjection, useInput, t }) {
			const pressure = useProjection("contextPressure");
			const breakdown = useProjection("contextBreakdown");
			const hist = useSession(selectOutputHistory);
			const running = useSession((s) => s.running);
			const draft = useInput((s) => s.draft) ?? "";
			const queue = useInput((s) => s.queue) ?? [];

			if (running) return null;

			const draftTokens = estimateText(draft);
			const queueTokens = estimateQueue(queue);

			let base = 0;
			let anchored = false;
			if (pressure !== undefined && Number.isFinite(pressure.projectedTokens)) {
				base = pressure.projectedTokens;
				anchored = true;
			} else if (pressure !== undefined && Number.isFinite(pressure.pressureTokens)) {
				base = pressure.pressureTokens;
				anchored = true;
			} else if (breakdown !== undefined) {
				base = (breakdown.systemTokens || 0) + (breakdown.toolsTokens || 0) + (breakdown.messageTokens || 0);
			}

			const nextInput = base + queueTokens + draftTokens;
			const windowSize = pressure !== undefined && Number.isFinite(pressure.contextWindow) ? pressure.contextWindow : 0;
			const pct = windowSize > 0 ? Math.round((nextInput / windowSize) * 100) : 0;

			const sorted = hist.slice().sort((a, b) => a - b);
			let outLabel = "-";
			if (sorted.length === 1) outLabel = "\u2248" + fmtTok(sorted[0]);
			else if (sorted.length > 1) {
				const lo = percentile(sorted, 0.25);
				const hi = percentile(sorted, 0.75);
				outLabel = fmtTok(lo) + "\u2013" + fmtTok(hi);
			}

		const parts = [];
		parts.push(pct > 0
			? t("line.nextPct", { tokens: fmtTok(nextInput), pct })
			: t("line.next", { tokens: fmtTok(nextInput) }));
		const detail = [];
		// "*" 是「无真实请求锚点」的记号，不是语言的一部分，留在模板外。
		detail.push((anchored ? "" : "*") + t("line.context", { tokens: fmtTok(base) }));
		if (queueTokens > 0) detail.push(t("line.queue", { tokens: fmtTok(queueTokens) }));
		if (draftTokens > 0) detail.push(t("line.draft", { tokens: fmtTok(draftTokens) }));
		parts.push(detail.join(" + "));
		parts.push(t("line.output", { range: outLabel }));
		const title = anchored ? t("tip.anchored") : t("tip.estimated");

			return react.createElement("div", { className: "dsh-tokprev-line", title: title },
				parts.map((p, i) => react.createElement("span", {
					key: String(i),
					className: i === 0 ? "" : "dsh-tokprev-dim"
				}, (i > 0 ? "\u00b7 " : "") + p))
			);
		}

		/** Real provider-reported usage for one completed turn, addressed by its closing assistant message. */
		function selectBadge(s, messageId) {
			const nodes = s.nodes;
			const turnEnds = s.turnEnds;
			if (!Array.isArray(nodes) || !turnEnds) return null;
			let me = null;
			for (const n of nodes) {
				if (n !== null && n.kind === "assistant" && n.messageId === messageId) { me = n; break; }
			}
			if (me === null || me.usage === undefined) return null;
			if (!turnEnds.has(me.turn)) return null;
			let maxSeq = me.seq;
			for (const n of nodes) {
				if (n === null || n.kind !== "assistant" || n.turn !== me.turn) continue;
				if (n.seq > maxSeq) maxSeq = n.seq;
			}
			if (me.seq !== maxSeq) return null;
			let input = 0, cacheRead = 0, output = 0, calls = 0, has = false;
			for (const n of nodes) {
				if (n === null || n.kind !== "assistant" || n.turn !== me.turn || n.usage === undefined) continue;
				const u = n.usage;
				const i = (Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheWriteTokens) || 0);
				const o = Number(u.outputTokens);
				input += i;
				cacheRead += Number(u.cacheReadTokens) || 0;
				output += Number.isFinite(o) ? o : 0;
				calls += 1;
				if (u.inputTokens !== undefined || u.outputTokens !== undefined) has = true;
			}
			if (!has || (input === 0 && output === 0)) return null;
			return { input: input, cacheRead: cacheRead, output: output, calls: calls };
		}

	function TurnBadge({ useSession, messageId, t }) {
		const info = useSession(function (s) { return selectBadge(s, messageId); });
		if (info === null || info === undefined) return null;
		const calls = tCount(t, "badge.calls", info.calls);
		const meta = info.cacheRead > 0
			? tCount(t, "badge.callsCache", info.calls, { cacheRead: fmtTok(info.cacheRead) })
			: calls;
		const label = t("badge.line", { input: fmtTok(info.input), meta, output: fmtTok(info.output) });
		return react.createElement("span", {
			className: "dsh-tokprev-badge",
			title: t("badge.title", { meta: calls, input: info.input, output: info.output })
		}, label);
	}

		const tokprevCss = [
			".dsh-tokprev-line{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;white-space:nowrap;overflow:hidden;user-select:none}",
			".dsh-tokprev-dim{opacity:.55}",
			".dsh-tokprev-badge{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:28px;white-space:nowrap;padding:0 2px;user-select:none}",
			".dsh-tokprev-badge:hover{color:var(--dsw-alias-label-secondary)}"
		].join("\n");

		/**
		 * tokprev 词典（zh 为键集真源，en 必须逐键对应）。
		 * 术语：输入 in / 输出 out / 缓存 cache / 排队 queued / 草稿 draft。
		 */
		const LOCALE_NS_TOKPREV = "dsh-plugins.tokprev";

		const tokprevZh = {
			"line.next": "下一轮输入 ≈ {tokens}",
			"line.nextPct": "下一轮输入 ≈ {tokens} ({pct}%)",
			"line.context": "上下文 {tokens}",
			"line.queue": "排队 {tokens}",
			"line.draft": "草稿 {tokens}",
			"line.output": "输出预估 {range}",
			"tip.anchored": "上下文基数：提供商锚定（上次真实请求 + 增量估算）",
			"tip.estimated": "尚无真实请求锚点，纯启发式估算（含系统提示与工具表）",
			"badge.calls.one": "{count} 次调用",
			"badge.calls.other": "{count} 次调用",
			"badge.callsCache.one": "{count} 次调用 · 缓存 {cacheRead}",
			"badge.callsCache.other": "{count} 次调用 · 缓存 {cacheRead}",
			"badge.line": "本轮 输入 {input}（{meta}） · 输出 {output}",
			"badge.title": "本轮实际消耗（提供商上报，{meta}）：输入 {input} tok，输出 {output} tok",
		};

		const tokprevEn = {
			"line.next": "Next input ≈ {tokens}",
			"line.nextPct": "Next input ≈ {tokens} ({pct}%)",
			"line.context": "Context {tokens}",
			"line.queue": "Queued {tokens}",
			"line.draft": "Draft {tokens}",
			"line.output": "Est. output {range}",
			"tip.anchored": "Context baseline: provider-anchored (last real request + incremental estimate)",
			"tip.estimated": "No real request anchor yet: heuristic estimate only (system prompt and tool schemas included)",
			"badge.calls.one": "{count} call",
			"badge.calls.other": "{count} calls",
			"badge.callsCache.one": "{count} call · cache {cacheRead}",
			"badge.callsCache.other": "{count} calls · cache {cacheRead}",
			"badge.line": "{input} in ({meta}) · {output} out",
			"badge.title": "Actual usage this turn (provider-reported, {meta}): {input} tok in, {output} tok out",
		};

		/**
		 * tokprev registration body:
		 * - conversation.composer.dock (list): the pre-send prediction line.
		 * - conversation.chat.assistant-actions (list): per-turn real-usage
		 *   badge, rendered only on the closing assistant message of a
		 *   completed turn.
		 *
		 * Both entries declare the locale namespace: that is what puts the `t`
		 * seat into the component props (the renderer throws for a declared
		 * namespace when no locale service is installed — hence the hard
		 * dependency in `inject`).
		 */
		function tokprevApply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register(
				{ name: "conversation.composer.dock", id: "tok-preview", order: 20, locale: LOCALE_NS_TOKPREV },
				PredictionLine
			));
			ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register(
				{ name: "conversation.chat.assistant-actions", id: "tok-turn-badge", order: 5, locale: LOCALE_NS_TOKPREV },
				TurnBadge
			));
		}

		// ── plugin: tokstats ────────────────────────────────────────────────────────

		// 数据通道：host 聚合器经 session-projection 下发（projection 值随各会话
		// store 走）；root scope 组件没有 useProjection 标准位，改从会话列表快照的
		// projectionValues 读（当前会话优先，任一会话兜底——值是全局聚合，语义一致）。

		function tokstatsDayKey(ts) {
			const d = new Date(ts);
			const m = String(d.getMonth() + 1).padStart(2, "0");
			const day = String(d.getDate()).padStart(2, "0");
			return d.getFullYear() + "-" + m + "-" + day;
		}

		/** 本周一 00:00（本地时区）的日键。 */
		function tokstatsWeekStartKey() {
			const now = new Date();
			const day = (now.getDay() + 6) % 7;
			return tokstatsDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - day).getTime());
		}

		/**
		 * 固定 24 小时制时钟。不跟浏览器 locale：`t` 席位只给翻译函数、不给当前
		 * 语言 id，用 toLocaleTimeString 会与 dsh 的语言偏好打架（中文界面配英文
		 * 浏览器会显示英文时间格式）。
		 */
		function fmtClock(ts) {
			const d = new Date(ts);
			const pad = (v) => String(v).padStart(2, "0");
			return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
		}

		function fmtCNY(cost) {
			if (!Number.isFinite(cost)) return "?";
			if (cost >= 1) return "¥" + cost.toFixed(2);
			if (cost >= 0.01) return "¥" + cost.toFixed(3);
			if (cost >= 0.0001) return "¥" + cost.toFixed(4);
			return "¥0";
		}

		/** 单格成本（元；null = 未配价）。缓存写按未命中输入价计（官方计费口径）。 */
		function tokstatsCellCost(cell, prices) {
			const provider = prices !== undefined && prices !== null ? prices[cell.p] : undefined;
			const model = typeof provider === "object" && provider !== null ? provider[cell.m] : undefined;
			if (model === undefined || model === null || typeof model !== "object") return null;
			let cost = 0;
			let has = false;
			if (typeof model.input === "number") {
				cost += (cell.in + cell.cw) * model.input / 1e6;
				has = true;
			}
			if (typeof model.inputCached === "number") {
				cost += cell.cr * model.inputCached / 1e6;
				has = true;
			}
			if (typeof model.output === "number") {
				cost += cell.out * model.output / 1e6;
				has = true;
			}
			return has ? cost : null;
		}

		const TOKSTATS_BUCKET_LABELS = ["[0,4K)", "[4K,8K)", "[8K,16K)", "[16K,32K)", "[32K,64K)", "[64K,128K)", "[128K,∞)"];
		const TOKSTATS_MODEL_SEP = "\u0001";

		function tokstatsEmptyTotals() {
			return { calls: 0, in: 0, cr: 0, cw: 0, out: 0, cost: null };
		}

		function tokstatsAccumulate(t, cell, prices) {
			t.calls += cell.calls;
			t.in += cell.in;
			t.cr += cell.cr;
			t.cw += cell.cw;
			t.out += cell.out;
			const cost = tokstatsCellCost(cell, prices);
			if (cost !== null) t.cost = (t.cost ?? 0) + cost;
		}

		function tokstatsGroupCells(cells, prices, from, to) {
			const byWorkspace = new Map();
			const byModel = new Map();
			const byBucket = [];
			for (let i = 0; i < TOKSTATS_BUCKET_LABELS.length; i += 1) byBucket.push(tokstatsEmptyTotals());
			for (const cell of cells) {
				if (from !== null && (cell.d < from || cell.d > to)) continue;
				let w = byWorkspace.get(cell.w);
				if (w === undefined) {
					w = tokstatsEmptyTotals();
					byWorkspace.set(cell.w, w);
				}
				tokstatsAccumulate(w, cell, prices);
				const modelKey = cell.p + TOKSTATS_MODEL_SEP + cell.m;
				let mrow = byModel.get(modelKey);
				if (mrow === undefined) {
					mrow = { p: cell.p, m: cell.m, totals: tokstatsEmptyTotals() };
					byModel.set(modelKey, mrow);
				}
				tokstatsAccumulate(mrow.totals, cell, prices);
				tokstatsAccumulate(byBucket[cell.b] ?? byBucket[byBucket.length - 1], cell, prices);
			}
			return { byWorkspace, byModel, byBucket };
		}

		/**
		 * cells → 视图：总览三档（不受时间开关影响）+ 工作区/模型/桶三表（受开
		 * 关过滤）。day 是 host 进程本地时区的自然日键，浏览器同机同区（SPEC Q5-A）。
		 */
		function tokstatsView(cells, prices) {
			const today = tokstatsDayKey(Date.now());
			const weekStart = tokstatsWeekStartKey();
			const periods = { today: tokstatsEmptyTotals(), week: tokstatsEmptyTotals(), total: tokstatsEmptyTotals() };
			for (const cell of cells) {
				tokstatsAccumulate(periods.total, cell, prices);
				if (cell.d === today) tokstatsAccumulate(periods.today, cell, prices);
				if (cell.d >= weekStart && cell.d <= today) tokstatsAccumulate(periods.week, cell, prices);
			}
			return { periods, today, weekStart };
		}

		/** 从会话列表快照读 tokstats projection 值（当前会话优先，任一行兜底）。 */
		function selectTokstatsValue(s) {
			const current = s.current;
			if (current !== undefined) {
				const row = s.byId[current];
				if (row !== undefined && row.projectionValues !== undefined && row.projectionValues.tokstats !== undefined) {
					return row.projectionValues.tokstats;
				}
			}
			const ids = s.ids;
			if (!Array.isArray(ids)) return undefined;
			for (const id of ids) {
				const row = s.byId[id];
				if (row === undefined || row.projectionValues === undefined) continue;
				if (row.projectionValues.tokstats !== undefined) return row.projectionValues.tokstats;
			}
			return undefined;
		}

		/** 侧栏脚部图标（自绘 inline SVG：三柱直方 + 基线，宿主无图标库约定）。 */
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

		/** 弹层面板：时间开关 + 总览 + 工作区/模型/上下文桶三表。 */
		function TokstatsPanel({ value, onClose, anchor, panelRef, t }) {
			const [range, setRange] = react.useState("total");
			const cells = Array.isArray(value.cells) ? value.cells : [];
			const prices = value.prices;
			const view = react.useMemo(() => tokstatsView(cells, prices), [value]);
			const scoped = react.useMemo(() => tokstatsGroupCells(cells, prices, range === "total" ? null : range === "today" ? view.today : view.weekStart, view.today), [value, range]);
			const workspaces = react.useMemo(() => {
				const rows = [...scoped.byWorkspace.entries()].sort((a, b) => b[1].in - a[1].in);
				return { top: rows.slice(0, 8), rest: rows.slice(8) };
			}, [scoped]);
			const models = react.useMemo(() => [...scoped.byModel.values()].sort((a, b) => b.totals.in - a.totals.in), [scoped]);

			react.useEffect(() => {
				const onKey = (e) => {
					if (e.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);

			const rangeButton = (key) => react.createElement("button", {
				key: key,
				type: "button",
				className: "dsh-tokstats-switch" + (range === key ? " dsh-tokstats-switchOn" : ""),
				onClick: () => setRange(key)
			}, t("range." + key));

			/** 纯 token 口径的输入/输出对（金额只在「按模型」区出现）。 */
			const inOut = (totals) => t("value.inOut", { input: fmtTok(totals.in), output: fmtTok(totals.out) });

			const overviewRow = (key) => {
				const totals = view.periods[key];
				return react.createElement(TokstatsRow, {
					key: key,
					label: t("range." + key),
					value: tCount(t, "row.overview", totals.calls, { input: fmtTok(totals.in), output: fmtTok(totals.out) }),
					title: t("tip.overview", {
						input: fmtTok(totals.in),
						cacheRead: fmtTok(totals.cr),
						cacheWrite: fmtTok(totals.cw),
						output: fmtTok(totals.out),
						cost: totals.cost === null ? t("unit.noPriceParen") : t("tip.cost", { cost: fmtCNY(totals.cost) }),
					})
				});
			};

			let emptyHint = null;
			if (value.reason === "no-persistence") emptyHint = t("empty.noPersistence");
			else if (cells.length === 0) emptyHint = value.complete ? t("empty.noData") : t("state.pending");

			return react.createElement("div", {
				className: "dsh-tokstats-panel", ref: panelRef, role: "dialog", "aria-label": t("panel.aria"),
				style: { left: anchor.left, bottom: anchor.bottom }
			},
				react.createElement("div", { className: "dsh-tokstats-header" },
					react.createElement("span", { className: "dsh-tokstats-title" }, t("panel.title")),
					react.createElement("span", { className: "dsh-tokstats-badge" }, value.complete ? "" : t("state.pending")),
					react.createElement("button", { type: "button", className: "dsh-tokstats-close", onClick: onClose, "aria-label": t("panel.close") }, "\u2715")),
				react.createElement("div", { className: "dsh-tokstats-switches" },
					rangeButton("today"), rangeButton("week"), rangeButton("total")),
				react.createElement("div", { className: "dsh-tokstats-body" },
					emptyHint !== null
						? react.createElement("div", { className: "dsh-tokstats-empty" }, emptyHint)
						: react.createElement(react.Fragment, null,
							react.createElement(TokstatsSection, { title: t("section.overview") },
								overviewRow("today"),
								overviewRow("week"),
								overviewRow("total")),
							workspaces.top.length > 0 ? react.createElement(TokstatsSection, { title: t("section.workspace") },
								workspaces.top.map(([w, totals]) => react.createElement(TokstatsRow, {
									key: w, label: w, value: inOut(totals),
									title: t("tip.workspace", {
										label: w, input: fmtTok(totals.in), output: fmtTok(totals.out),
										calls: tCount(t, "unit.calls", totals.calls)
									})
								})),
								workspaces.rest.length > 0 ? react.createElement(TokstatsRow, {
									key: "__rest", dim: true, label: tCount(t, "workspace.rest", workspaces.rest.length),
									value: inOut(workspaces.rest.reduce((acc, entry) => ({
										in: acc.in + entry[1].in,
										out: acc.out + entry[1].out,
									}), { in: 0, out: 0 }))
								}) : null) : null,
							models.length > 0 ? react.createElement(TokstatsSection, { title: t("section.model") },
								models.map((row) => react.createElement(TokstatsRow, {
									key: row.p + TOKSTATS_MODEL_SEP + row.m, label: row.p + "/" + row.m,
									value: t("value.model", {
										input: fmtTok(row.totals.in),
										output: fmtTok(row.totals.out),
										cost: row.totals.cost === null ? t("unit.noPrice") : fmtCNY(row.totals.cost),
									}),
									title: t("tip.model", {
										label: row.p + "/" + row.m,
										input: fmtTok(row.totals.in),
										output: fmtTok(row.totals.out),
										calls: tCount(t, "unit.calls", row.totals.calls),
										cost: row.totals.cost === null ? t("tip.noPriceOnly") : t("tip.estimated"),
									})
								}))) : null,
							react.createElement(TokstatsSection, { title: t("section.bucket") },
								scoped.byBucket.map((totals, i) => {
									const billed = totals.in + totals.cr + totals.cw;
									const hit = billed > 0 ? Math.round((totals.cr / billed) * 100) : 0;
									return react.createElement(TokstatsRow, {
										key: i, label: TOKSTATS_BUCKET_LABELS[i], dim: totals.calls === 0,
										value: totals.calls > 0
											? tCount(t, "row.bucket", totals.calls, { input: fmtTok(billed), output: fmtTok(totals.out), hit })
											: "\u2014",
										title: tCount(t, "tip.bucket", totals.calls, {
											bucket: TOKSTATS_BUCKET_LABELS[i], input: fmtTok(billed), output: fmtTok(totals.out), hit
										})
									});
								})))),
				react.createElement("div", { className: "dsh-tokstats-foot" },
					t("foot.note", { time: fmtClock(value.generatedAt) })));
		}

		/** 侧栏脚按钮：wide = 展开侧栏（图标行），false = 56px rail（图标位）。 */
	function TokstatsButton({ wide, useSessions, t }) {
		const value = useSessions(selectTokstatsValue);
			const [open, setOpen] = react.useState(false);
			const buttonRef = react.useRef(null);
			const panelRef = react.useRef(null);
			const [anchor, setAnchor] = react.useState(undefined);

			react.useLayoutEffect(() => {
				if (!open) return;
				const place = () => {
					const rect = buttonRef.current.getBoundingClientRect();
					// 404 = 面板宽 380 + 24 边距；钳制不越过视口右缘（rail 态按钮贴左，宽屏不受影响）。
					const left = Math.max(8, Math.min(rect.left, window.innerWidth - 404));
					setAnchor({ left, bottom: window.innerHeight - rect.top + 8 });
				};
				place();
				window.addEventListener("resize", place);
				return () => window.removeEventListener("resize", place);
			}, [open]);

			react.useEffect(() => {
				if (!open) return;
				const onPointer = (e) => {
					if (buttonRef.current !== null && buttonRef.current.contains(e.target)) return;
					if (panelRef.current !== null && panelRef.current.contains(e.target)) return;
					setOpen(false);
				};
				document.addEventListener("pointerdown", onPointer);
				return () => document.removeEventListener("pointerdown", onPointer);
			}, [open]);

			return react.createElement("div", { className: "dsh-tokstats-root" + (wide ? "" : " dsh-tokstats-rail") },
				react.createElement("button", {
					type: "button",
					className: "dsh-tokstats-trigger",
					ref: buttonRef,
				onClick: () => setOpen(!open),
				title: t("button.aria"),
				"aria-label": t("button.aria"),
				"aria-expanded": open ? "true" : "false"
			},
				react.createElement(TokstatsIcon, { size: wide ? 16 : 18 }),
				wide ? react.createElement("span", { className: "dsh-tokstats-triggerLabel" }, t("button.label")) : null),
			open && value !== undefined && anchor !== undefined
				? react.createElement(TokstatsPanel, {
					value: value, onClose: () => setOpen(false), anchor: anchor, panelRef: panelRef, t: t
				})
				: null);
		}

		const tokstatsCss = [
			".dsh-tokstats-root{position:relative;display:inline-flex;align-items:center}",
			".dsh-tokstats-rail{width:36px;height:36px;justify-content:center}",
			".dsh-tokstats-trigger{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;padding:0 8px;height:28px;font:inherit;font-size:12px;display:inline-flex}",
			".dsh-tokstats-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dsh-tokstats-triggerLabel{color:var(--dsw-alias-label-secondary)}",
			".dsh-tokstats-rail .dsh-tokstats-trigger{border-radius:50%;justify-content:center;width:36px;height:36px;padding:0}",
			".dsh-tokstats-panel{z-index:30;box-sizing:border-box;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:380px;max-width:calc(100vw - 24px);max-height:64vh;box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-secondary);border-radius:12px;flex-direction:column;display:flex;position:fixed;left:0;bottom:0;overflow:hidden;font-size:12px;line-height:20px}",
			".dsh-tokstats-header{box-sizing:border-box;align-items:center;gap:8px;min-height:44px;padding:10px 12px;display:flex;flex:none}",
			".dsh-tokstats-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px}",
			".dsh-tokstats-badge{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".dsh-tokstats-badge:empty{display:none}",
			".dsh-tokstats-close{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;width:24px;height:24px;padding:0;font:inherit;font-size:12px;display:inline-flex;align-items:center;justify-content:center}",
			".dsh-tokstats-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dsh-tokstats-switches{gap:2px;padding:0 12px 10px;display:flex;flex:none}",
			".dsh-tokstats-switch{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:7px;padding:3px 10px;font:inherit;font-size:12px;line-height:16px}",
			".dsh-tokstats-switch:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dsh-tokstats-switchOn{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-tokstats-body{flex:1;min-height:0;padding:0 12px 12px;overflow-y:auto}",
			".dsh-tokstats-empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px;text-align:center}",
			".dsh-tokstats-section{margin:8px 0 12px}",
			".dsh-tokstats-sectionTitle{color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:.04em;margin:8px 0 4px;font-size:11px;font-weight:500;line-height:16px}",
			".dsh-tokstats-row{align-items:center;gap:12px;padding:2px 0;display:flex}",
			".dsh-tokstats-rowLabel{color:var(--dsw-alias-label-secondary);min-width:0;text-overflow:ellipsis;white-space:nowrap;flex:none;max-width:42%;overflow:hidden}",
			".dsh-tokstats-rowValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
			".dsh-tokstats-dim{opacity:.55}",
			".dsh-tokstats-foot{color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l2);padding:8px 12px;font-size:11px;line-height:16px;flex:none}"
		].join("\n");

		/**
		 * tokstats 词典（zh 为键集真源，en 必须逐键对应）。
		 * 术语：输入 in / 输出 out / 缓存读 cache read / 缓存写 cache write /
		 * 命中 cached / 未配价 no price / 估算 est. / 工作区 workspace /
		 * 上下文长度分布 context length distribution。
		 */
		const LOCALE_NS_TOKSTATS = "dsh-plugins.tokstats";

		const tokstatsZh = {
			"panel.aria": "Token 统计",
			"panel.title": "Token 统计",
			"panel.close": "关闭",
			"state.pending": "统计中…",
			"button.aria": "跨会话 Token 统计",
			"button.label": "Token 统计",
			"range.today": "今日",
			"range.week": "本周",
			"range.total": "累计",
			"section.overview": "总览",
			"section.workspace": "按工作区",
			"section.model": "按模型",
			"section.bucket": "上下文长度分布（按计费输入）",
			"empty.noPersistence": "持久化服务不可用，无法扫描会话日志",
			"empty.noData": "暂无数据（还没有 usage 记录）",
			"row.overview.one": "{count} 次 · 输入 {input} · 输出 {output}",
			"row.overview.other": "{count} 次 · 输入 {input} · 输出 {output}",
			"value.inOut": "输入 {input} · 输出 {output}",
			"value.model": "输入 {input} · 输出 {output} · {cost}",
			"unit.calls.one": "{count} 次调用",
			"unit.calls.other": "{count} 次调用",
			"unit.noPrice": "未配价",
			"unit.noPriceParen": "（未配价）",
			"workspace.rest.one": "其余 {count} 个工作区",
			"workspace.rest.other": "其余 {count} 个工作区",
			"tip.overview": "输入(未命中) {input} · 缓存读 {cacheRead} · 缓存写 {cacheWrite} · 输出 {output}{cost}",
			"tip.cost": " · 估算 {cost}",
			"tip.workspace": "{label}：输入 {input} · 输出 {output} · {calls}",
			"tip.model": "{label}：输入 {input} · 输出 {output} · {calls}{cost}",
			"tip.noPriceOnly": " · 未配价，仅 token",
			"tip.estimated": " · 按所配定价估算",
			"row.bucket.one": "{count} 次 · 输入 {input} · 输出 {output} · 命中 {hit}%",
			"row.bucket.other": "{count} 次 · 输入 {input} · 输出 {output} · 命中 {hit}%",
			"tip.bucket.one": "计费输入 {bucket} 的请求：{count} 次，计费输入 {input}，输出 {output}，缓存命中 {hit}%",
			"tip.bucket.other": "计费输入 {bucket} 的请求：{count} 次，计费输入 {input}，输出 {output}，缓存命中 {hit}%",
			"foot.note": "金额为按所配定价的估算（内置为 DeepSeek 官方高峰单价）· 生成于 {time}",
		};

		const tokstatsEn = {
			"panel.aria": "Token statistics",
			"panel.title": "Token statistics",
			"panel.close": "Close",
			"state.pending": "Scanning…",
			"button.aria": "Cross-session token statistics",
			"button.label": "Token stats",
			"range.today": "Today",
			"range.week": "This week",
			"range.total": "All time",
			"section.overview": "Overview",
			"section.workspace": "By workspace",
			"section.model": "By model",
			"section.bucket": "Context length distribution (by billed input)",
			"empty.noPersistence": "Persistence unavailable: session logs cannot be scanned",
			"empty.noData": "No data yet (no usage recorded)",
			"row.overview.one": "{count} call · {input} in · {output} out",
			"row.overview.other": "{count} calls · {input} in · {output} out",
			"value.inOut": "{input} in · {output} out",
			"value.model": "{input} in · {output} out · {cost}",
			"unit.calls.one": "{count} call",
			"unit.calls.other": "{count} calls",
			"unit.noPrice": "no price",
			"unit.noPriceParen": " (no price configured)",
			"workspace.rest.one": "{count} more workspace",
			"workspace.rest.other": "{count} more workspaces",
			"tip.overview": "Input (miss) {input} · cache read {cacheRead} · cache write {cacheWrite} · output {output}{cost}",
			"tip.cost": " · est. {cost}",
			"tip.workspace": "{label}: {input} in · {output} out · {calls}",
			"tip.model": "{label}: {input} in · {output} out · {calls}{cost}",
			"tip.noPriceOnly": " · no price configured, tokens only",
			"tip.estimated": " · estimated at configured prices",
			"row.bucket.one": "{count} call · {input} in · {output} out · {hit}% cached",
			"row.bucket.other": "{count} calls · {input} in · {output} out · {hit}% cached",
			"tip.bucket.one": "Requests billed at {bucket} input: {count}, billed input {input}, output {output}, cache hit {hit}%",
			"tip.bucket.other": "Requests billed at {bucket} input: {count}, billed input {input}, output {output}, cache hit {hit}%",
			"foot.note": "Amounts are estimates at configured prices (built-in: DeepSeek official peak rates) · generated at {time}",
		};

		/** tokstats 注册体：sidebar.footer.action（list，root scope）图标按钮 + 弹层四表。 */
		function tokstatsApply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "tokstats-panel", order: 30, locale: LOCALE_NS_TOKSTATS },
				TokstatsButton
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
