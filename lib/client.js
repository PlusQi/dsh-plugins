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

		function PredictionLine({ useSession, useProjection, useInput }) {
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
			parts.push("\u4e0b\u4e00\u8f6e\u8f93\u5165 \u2248 " + fmtTok(nextInput) + (pct > 0 ? " (" + pct + "%)" : ""));
			const detail = [];
			detail.push((anchored ? "" : "*") + "\u4e0a\u4e0b\u6587 " + fmtTok(base));
			if (queueTokens > 0) detail.push("\u6392\u961f " + fmtTok(queueTokens));
			if (draftTokens > 0) detail.push("\u8349\u7a3f " + fmtTok(draftTokens));
			parts.push(detail.join(" + "));
			parts.push("\u8f93\u51fa\u9884\u4f30 " + outLabel);
			const title = anchored
				? "\u4e0a\u4e0b\u6587\u57fa\u5ea6\uff1a\u63d0\u4f9b\u5546\u951a\u5b9a\uff08\u4e0a\u6b21\u771f\u5b9e\u8bf7\u6c42 + \u589e\u91cf\u4f30\u7b97\uff09"
				: "\u5c1a\u65e0\u771f\u5b9e\u8bf7\u6c42\u951a\u70b9\uff0c\u7eaf\u542f\u53d1\u5f0f\u4f30\u7b97\uff08\u542b\u7cfb\u7edf\u63d0\u793a\u4e0e\u5de5\u5177\u8868\uff09";

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

		function TurnBadge({ useSession, messageId }) {
			const info = useSession(function (s) { return selectBadge(s, messageId); });
			if (info === null || info === undefined) return null;
			const meta = info.calls + " \u6b21\u8c03\u7528" + (info.cacheRead > 0 ? " \u00b7 \u7f13\u5b58 " + fmtTok(info.cacheRead) : "");
			const label = "\u672c\u8f6e \u8f93\u5165 " + fmtTok(info.input) +
				"\uff08" + meta + "\uff09" +
				" \u00b7 \u8f93\u51fa " + fmtTok(info.output);
			return react.createElement("span", {
				className: "dsh-tokprev-badge",
				title: "\u672c\u8f6e\u5b9e\u9645\u6d88\u8017\uff08\u63d0\u4f9b\u5546\u4e0a\u62a5\uff0c" + info.calls + " \u6b21\u8c03\u7528\uff09\uff1a\u8f93\u5165 " + info.input + " tok\uff0c\u8f93\u51fa " + info.output + " tok"
			}, label);
		}

		const tokprevCss = [
			".dsh-tokprev-line{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;white-space:nowrap;overflow:hidden;user-select:none}",
			".dsh-tokprev-dim{opacity:.55}",
			".dsh-tokprev-badge{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:28px;white-space:nowrap;padding:0 2px;user-select:none}",
			".dsh-tokprev-badge:hover{color:var(--dsw-alias-label-secondary)}"
		].join("\n");

		/**
		 * tokprev registration body:
		 * - conversation.composer.dock (list): the pre-send prediction line.
		 * - conversation.chat.assistant-actions (list): per-turn real-usage
		 *   badge, rendered only on the closing assistant message of a
		 *   completed turn.
		 */
		function tokprevApply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register(
				{ name: "conversation.composer.dock", id: "tok-preview", order: 20 },
				PredictionLine
			));
			ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register(
				{ name: "conversation.chat.assistant-actions", id: "tok-turn-badge", order: 5 },
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

		/** 总览行值：纯 token 口径，不含计价（金额只在「按模型」区展示）。 */
		function tokstatsTotalLine(t) {
			return "输入 " + fmtTok(t.in) + " · 输出 " + fmtTok(t.out);
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
		function TokstatsPanel({ value, onClose, anchor, panelRef }) {
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

			const rangeButton = (key, label) => react.createElement("button", {
				key: key,
				type: "button",
				className: "dsh-tokstats-switch" + (range === key ? " dsh-tokstats-switchOn" : ""),
				onClick: () => setRange(key)
			}, label);

			const overviewRow = (key, label) => {
				const t = view.periods[key];
				return react.createElement(TokstatsRow, {
					key: key, label: label, value: t.calls + " 次 · " + tokstatsTotalLine(t),
					title: "输入(未命中) " + fmtTok(t.in) + " · 缓存读 " + fmtTok(t.cr) + " · 缓存写 " + fmtTok(t.cw) + " · 输出 " + fmtTok(t.out) + (t.cost !== null ? " · 估算 " + fmtCNY(t.cost) : "（未配价）")
				});
			};

			let emptyHint = null;
			if (value.reason === "no-persistence") emptyHint = "持久化服务不可用，无法扫描会话日志";
			else if (cells.length === 0) emptyHint = value.complete ? "暂无数据（还没有 usage 记录）" : "统计中…";

			return react.createElement("div", {
				className: "dsh-tokstats-panel", ref: panelRef, role: "dialog", "aria-label": "Token 统计",
				style: { left: anchor.left, bottom: anchor.bottom }
			},
				react.createElement("div", { className: "dsh-tokstats-header" },
					react.createElement("span", { className: "dsh-tokstats-title" }, "Token 统计"),
					react.createElement("span", { className: "dsh-tokstats-badge" }, value.complete ? "" : "统计中…"),
					react.createElement("button", { type: "button", className: "dsh-tokstats-close", onClick: onClose, "aria-label": "关闭" }, "✕")),
				react.createElement("div", { className: "dsh-tokstats-switches" },
					rangeButton("today", "今日"), rangeButton("week", "本周"), rangeButton("total", "累计")),
				react.createElement("div", { className: "dsh-tokstats-body" },
					emptyHint !== null
						? react.createElement("div", { className: "dsh-tokstats-empty" }, emptyHint)
						: react.createElement(react.Fragment, null,
							react.createElement(TokstatsSection, { title: "总览" },
								overviewRow("today", "今日"),
								overviewRow("week", "本周"),
								overviewRow("total", "累计")),
							workspaces.top.length > 0 ? react.createElement(TokstatsSection, { title: "按工作区" },
								workspaces.top.map(([w, t]) => react.createElement(TokstatsRow, {
									key: w, label: w, value: "输入 " + fmtTok(t.in) + " · 输出 " + fmtTok(t.out),
									title: w + "：输入 " + fmtTok(t.in) + " · 输出 " + fmtTok(t.out) + " · " + t.calls + " 次调用"
								})),
								workspaces.rest.length > 0 ? react.createElement(TokstatsRow, {
									key: "__rest", dim: true, label: "其余 " + workspaces.rest.length + " 个工作区",
									value: "输入 " + fmtTok(workspaces.rest.reduce((sum, entry) => sum + entry[1].in, 0)) + " · 输出 " + fmtTok(workspaces.rest.reduce((sum, entry) => sum + entry[1].out, 0))
								}) : null) : null,
							models.length > 0 ? react.createElement(TokstatsSection, { title: "按模型" },
								models.map((row) => react.createElement(TokstatsRow, {
									key: row.p + TOKSTATS_MODEL_SEP + row.m, label: row.p + "/" + row.m,
									value: "输入 " + fmtTok(row.totals.in) + " · 输出 " + fmtTok(row.totals.out) + (row.totals.cost !== null ? " · " + fmtCNY(row.totals.cost) : " · 未配价"),
									title: row.p + "/" + row.m + "：输入 " + fmtTok(row.totals.in) + " · 输出 " + fmtTok(row.totals.out) + " · " + row.totals.calls + " 次调用" + (row.totals.cost === null ? " · 未配价，仅 token" : " · 按所配定价估算")
								}))) : null,
							react.createElement(TokstatsSection, { title: "上下文长度分布（按计费输入）" },
								scoped.byBucket.map((t, i) => {
									const billed = t.in + t.cr + t.cw;
									const hit = billed > 0 ? Math.round((t.cr / billed) * 100) : 0;
									return react.createElement(TokstatsRow, {
										key: i, label: TOKSTATS_BUCKET_LABELS[i], dim: t.calls === 0,
										value: t.calls > 0 ? t.calls + " 次 · 输入 " + fmtTok(billed) + " · 输出 " + fmtTok(t.out) + " · 命中 " + hit + "%" : "—",
										title: "计费输入 " + TOKSTATS_BUCKET_LABELS[i] + " 的请求：" + t.calls + " 次，计费输入 " + fmtTok(billed) + "，输出 " + fmtTok(t.out) + "，缓存命中 " + hit + "%"
									});
								})))),
				react.createElement("div", { className: "dsh-tokstats-foot" },
					"金额为按所配定价的估算（内置为 DeepSeek 官方高峰单价）· 生成于 ",
					new Date(value.generatedAt).toLocaleTimeString()));
		}

		/** 侧栏脚按钮：wide = 展开侧栏（图标行），false = 56px rail（图标位）。 */
		function TokstatsButton({ wide, useSessions }) {
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
					title: "跨会话 Token 统计",
					"aria-label": "跨会话 Token 统计",
					"aria-expanded": open ? "true" : "false"
				},
					react.createElement(TokstatsIcon, { size: wide ? 16 : 18 }),
					wide ? react.createElement("span", { className: "dsh-tokstats-triggerLabel" }, "Token 统计") : null),
				open && value !== undefined && anchor !== undefined
					? react.createElement(TokstatsPanel, {
						value: value, onClose: () => setOpen(false), anchor: anchor, panelRef: panelRef
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

		/** tokstats 注册体：sidebar.footer.action（list，root scope）图标按钮 + 弹层四表。 */
		function tokstatsApply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "tokstats-panel", order: 30 },
				TokstatsButton
			));
		}

		// ── plugin registry ────────────────────────────────────────────────────────

		/** One entry per pack plugin: its styles plus the registration body. */
		const PLUGINS = {
			tokprev: { css: tokprevCss, apply: tokprevApply },
			tokstats: { css: tokstatsCss, apply: tokstatsApply }
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
