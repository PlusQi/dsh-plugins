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

		// ── plugin registry ────────────────────────────────────────────────────────
		/** One entry per pack plugin: its styles plus the registration body. */
		const PLUGINS = {
			tokprev: { css: tokprevCss, apply: tokprevApply }
		};

		const inject = ["slots"];
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
