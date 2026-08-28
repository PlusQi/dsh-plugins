/**
 * dsh-plugins node half. 按 config.plugin 分发（tokprev 等纯 UI 插件的 host
 * 半边为空，行只作存在/禁用锚点）；tokstats 是本包首个混合插件：host 侧扫
 * durable 会话日志聚合跨会话 token 消耗，经 session-projection 通道下发，
 * 浏览器半边见 lib/client.js。
 *
 * 模块图约束：本包经 pnpm link 安装，真实路径不在宿主 node_modules 树内，
 * npm 包 import 不可解析——host 半边只用 node: 内建 + apply(ctx, config)
 * 参数，不引运行时依赖（AGENTS 硬规则 5）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** host 侧分发框架：每个 patch 行一个 host fiber，config.plugin 是分发键。 */
function apply(ctx, config) {
	const plugin = String(config?.plugin ?? "");
	if (plugin === "tokstats") startTokstats(ctx, config);
	// 其余插件 host 半边为空，静默跳过。
}

// ── plugin: tokstats（host 聚合器） ─────────────────────────────────────────
//
// 数据口径与通道（决策见 docs/specs/active/SPEC-tokstats.md，阶段 0 契约结
// 论见 TASKS-tokstats.md 附记）：
// - usage 提取与宿主 tokenUsage 同口径：按日志序取 usage 样本，同 (turn,step)
//   的后一样本替换前一样本（chunk 递进采样 → assistant/message.usage 终值），
//   折叠采用「先减旧、再加新」的差值法，天然支持增量续算；
// - 每格（模型 × 日 × 上下文桶）累计 {calls,in,cr,cw,out}，工作区按根会话
//   cwd 归并（子会话沿 parentSession 链上溯，父日志缺失归 _orphan）；
// - checkpoint 键 (sessionId, storage revision)：启动 listSnapshots 对账，
//   revision 未变的会话直接复用已折叠 cells；
// - 增量：ctx.on("session/flush") 后从 lastSeq+1 续读活会话内存 events；
// - 下发：注册非会话级 projection unit（imageLimits 先例 + 版本号变体——
//   聚合版本变化时 apply 返回新引用，借下一个 session 事件触发 push frame）。

/** 上下文桶边界（2 的幂，计费输入 = in + cr + cw 落桶）。 */
const TOKSTATS_BUCKET_BOUNDS = [4096, 8192, 16384, 32768, 65536, 131072];

/** 内置 DeepSeek 官方价（元 / Mtok，按高峰单价估算；来源 api-docs.deepseek.com，2026-08 核对）。 */
const TOKSTATS_BUILTIN_PRICES = {
	"deepseek-official": {
		"deepseek-v4-flash": { input: 3, inputCached: 0.1, output: 9 },
		"deepseek-v4-pro": { input: 9, inputCached: 0.3, output: 27 },
		"deepseek-v4-flash-vision-exp": { input: 3, inputCached: 0.1, output: 9 },
		// 官方公告的旧模型名（日志存量）：映射 v4-flash 同价。
		"deepseek-chat": { input: 3, inputCached: 0.1, output: 9 },
		"deepseek-reasoner": { input: 3, inputCached: 0.1, output: 9 },
	},
};

/** 防抖窗口：聚合变更后延迟落盘/推送，合并短时抖动。 */
const TOKSTATS_DEBOUNCE_MS = 2000;

/** 本地时区自然日键（host 进程时区，SPEC Q5-A 裁决口径）。 */
function tokstatsDayKey(ts) {
	const d = new Date(ts);
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return d.getFullYear() + "-" + m + "-" + day;
}

/** 计费输入 → 2 的幂对数桶序号（0..6 = [0,4K)…[128K,∞)）。 */
function tokstatsBucketOf(billedInput) {
	let b = 0;
	while (b < TOKSTATS_BUCKET_BOUNDS.length && billedInput >= TOKSTATS_BUCKET_BOUNDS[b]) b += 1;
	return b;
}

function tokstatsNum(v) {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** 根工作区标签：沿 parentSession 链上溯到根会话的 cwd；链断（父日志被删）归 _orphan。 */
function tokstatsRootWorkspaceOf(header, headersById) {
	let h = header;
	let depth = 0;
	while (h !== undefined && h.parentSession !== undefined) {
		if (depth >= 64) return "_orphan";
		const parent = headersById.get(h.parentSession);
		if (parent === undefined) return "_orphan";
		h = parent;
		depth += 1;
	}
	if (h === undefined || h.cwd === undefined || h.cwd === "") return "_orphan";
	return h.cwd;
}

/** 空折叠条目（每会话的增量折叠状态；持久化形态见 checkpoint）。 */
function tokstatsFreshEntry(w) {
	return { rev: null, lastSeq: -1, last: null, hdr: null, w, cells: new Map() };
}

/**
 * 单会话 usage 折叠（增量安全）：
 * - 跳过 seq <= entry.lastSeq 的已折叠事件；
 * - seq < seedLength 的样本丢弃（fork seed 复制前缀，父会话日志已计过）；
 * - 同 (turn,step) 后样本替换前样本：cells 先减旧贡献再加新贡献；
 * - request/header 维护 provider/model 兜底归因（content-less 调用），
 *   assistant/message.source 优先。
 */
function tokstatsFoldSession(entry, events, seedLength) {
	for (const ev of events) {
		if (ev.seq <= entry.lastSeq) continue;
		entry.lastSeq = ev.seq;
		if (seedLength > 0 && ev.seq < seedLength) continue;
		const data = ev.data ?? {};
		if (ev.type === "request/header") {
			const cfg = data.header?.config;
			if (cfg !== undefined && typeof cfg.provider === "string" && typeof cfg.model === "string") {
				entry.hdr = { provider: cfg.provider, model: cfg.model };
			}
			continue;
		}
		let usage;
		let src;
		if (ev.type === "assistant/chunk") {
			const chunk = data.chunk;
			if (chunk === undefined || chunk.type !== "usage") continue;
			usage = chunk.usage;
			src = null;
		} else if (ev.type === "assistant/message") {
			const message = data.message;
			const source = message?.source;
			if (source !== undefined && typeof source.provider === "string" && typeof source.model === "string") {
				entry.hdr = { provider: source.provider, model: source.model };
			}
			if (data.usage === undefined) continue;
			usage = data.usage;
			src = entry.hdr;
		} else {
			continue;
		}
		if (usage === undefined || typeof usage !== "object") continue;
		if (typeof data.turn !== "number" || typeof data.step !== "number") continue;
		const attribution = src ?? entry.hdr ?? { provider: "unknown", model: "unknown" };
		const sample = {
			turn: data.turn,
			step: data.step,
			time: ev.time,
			provider: attribution.provider,
			model: attribution.model,
			in: tokstatsNum(usage.inputTokens),
			cr: tokstatsNum(usage.cacheReadTokens),
			cw: tokstatsNum(usage.cacheWriteTokens),
			out: tokstatsNum(usage.outputTokens),
		};
		const prev = entry.last;
		if (prev !== null && prev.turn === sample.turn && prev.step === sample.step) {
			tokstatsCellAdd(entry, prev, -1);
			tokstatsCellAdd(entry, sample, 1);
		} else {
			tokstatsCellAdd(entry, sample, 1);
		}
		entry.last = sample;
	}
}

/** 样本计入/计出会话 cells（key = provider\x1fmodel\x1fday\x1fbucket）。 */
function tokstatsCellAdd(entry, sample, sign) {
	const billed = sample.in + sample.cr + sample.cw;
	const key = sample.provider + "\x1f" + sample.model + "\x1f" + tokstatsDayKey(sample.time) + "\x1f" + tokstatsBucketOf(billed);
	let cell = entry.cells.get(key);
	if (cell === undefined) {
		if (sign < 0) return;
		cell = { calls: 0, in: 0, cr: 0, cw: 0, out: 0 };
		entry.cells.set(key, cell);
	}
	cell.calls += sign;
	cell.in += sign * sample.in;
	cell.cr += sign * sample.cr;
	cell.cw += sign * sample.cw;
	cell.out += sign * sample.out;
}

/** DSH_HOME 解析（语义对齐 dsh-home-paths：显式配置 > $DSH_HOME > ~/.dsh）。 */
function tokstatsDshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
	return resolve(homedir(), ".dsh");
}

/** checkpoint 读取：损坏/缺字段 → 丢弃全量重扫（硬规则 6 精神，不抛错）。 */
function tokstatsLoadCheckpoint(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed === null || typeof parsed !== "object" || parsed.schema !== 1 || typeof parsed.sessions !== "object" || parsed.sessions === null) {
			throw new Error("schema mismatch");
		}
		const sessions = {};
		for (const [id, raw] of Object.entries(parsed.sessions)) {
			if (raw === null || typeof raw !== "object" || typeof raw.lastSeq !== "number" || typeof raw.w !== "string") throw new Error("bad session entry");
			sessions[id] = {
				rev: typeof raw.rev === "string" ? raw.rev : null,
				lastSeq: raw.lastSeq,
				last: raw.last === null || raw.last === undefined ? null : raw.last,
				hdr: raw.hdr === null || raw.hdr === undefined ? null : raw.hdr,
				w: raw.w,
				cells: new Map(Object.entries(raw.cells ?? {})),
			};
		}
		return sessions;
	} catch (error) {
		console.warn(`[dsh-plugins] tokstats checkpoint 不可用，将全量重扫: ${String(error)}`);
		return {};
	}
}

/** checkpoint 原子写：临时文件 + rename（Windows 下 rename 覆盖同目录文件）。 */
function tokstatsSaveCheckpoint(path, sessions) {
	const payload = { schema: 1, sessions: {} };
	for (const [id, entry] of Object.entries(sessions)) {
		payload.sessions[id] = {
			rev: entry.rev,
			lastSeq: entry.lastSeq,
			last: entry.last,
			hdr: entry.hdr,
			w: entry.w,
			cells: Object.fromEntries(entry.cells),
		};
	}
	const tmp = path + ".tmp";
	writeFileSync(tmp, JSON.stringify(payload), "utf8");
	renameSync(tmp, path);
}

/** 内置价 ⊕ config.prices 覆盖（值为 { input, inputCached?, output? } 元/Mtok；字段级合并——只调 input 时保留内置 output 等未覆盖字段）。 */
function tokstatsMergePrices(overrides) {
	const merged = {};
	for (const [provider, models] of Object.entries(TOKSTATS_BUILTIN_PRICES)) {
		merged[provider] = { ...models };
	}
	if (overrides !== null && typeof overrides === "object") {
		for (const [provider, models] of Object.entries(overrides)) {
			if (models === null || typeof models !== "object") continue;
			const slot = merged[provider] ?? {};
			for (const [model, price] of Object.entries(models)) {
				if (price === null || typeof price !== "object") continue;
				const base = slot[model] ?? {};
				slot[model] = {
					input: tokstatsNum(price.input) || base.input,
					inputCached: tokstatsNum(price.inputCached) || base.inputCached,
					output: tokstatsNum(price.output) || base.output,
				};
			}
			merged[provider] = slot;
		}
	}
	return merged;
}

/**
 * tokstats 聚合器组装。聚合器是纯闭包对象（不注册具名服务——本包模块图不
 * 能 import cordis 的 Service 基类，也没有第三方消费者需要 ctx.get 到它）。
 */
function startTokstats(ctx, config) {
	const log = (...args) => {
		try {
			ctx.logger?.warn(...args);
		} catch {
			/* 降级：logger 缺席时静默 */
		}
	};
	const prices = tokstatsMergePrices(config?.prices);

	const storagesDir = join(tokstatsDshHome(), "storages");
	const checkpointPath = join(storagesDir, "tokstats-checkpoint.json");

	const agg = {
		version: 1,
		sessions: tokstatsLoadCheckpoint(checkpointPath),
		headers: new Map(),
		scanState: "idle", // idle → scanning → done
		reason: undefined,
		dirtyLive: new Set(), // 扫描期间发生过 flush 的会话（扫尾补折）
		published: {
			schema: 1,
			complete: false,
			generatedAt: Date.now(),
			prices,
			cells: [],
		},
	};

	let persistence = null;
	let saveTimer = null;
	let disposed = false;

	/** 重建发布值（cells 汇总 + 版本号自增，供 projection view 读取）。 */
	function rebuild() {
		const cells = new Map();
		for (const entry of Object.values(agg.sessions)) {
			for (const [key, b] of entry.cells) {
				const fullKey = entry.w + "\x1f" + key;
				let cell = cells.get(fullKey);
				if (cell === undefined) {
					cell = { calls: 0, in: 0, cr: 0, cw: 0, out: 0 };
					cells.set(fullKey, cell);
				}
				cell.calls += b.calls;
				cell.in += b.in;
				cell.cr += b.cr;
				cell.cw += b.cw;
				cell.out += b.out;
			}
		}
		agg.published = {
			schema: 1,
			complete: agg.scanState === "done",
			...(agg.reason !== undefined ? { reason: agg.reason } : {}),
			generatedAt: Date.now(),
			prices,
			cells: [...cells].map(([key, b]) => {
				const [w, p, m, d, bucket] = key.split("\x1f");
				return { w, p, m, d, b: Number(bucket), calls: b.calls, in: b.in, cr: b.cr, cw: b.cw, out: b.out };
			}),
		};
		agg.version += 1;
	}

	/** 防抖 checkpoint 落盘（含 revDirty 会话的 storage revision 刷新）。 */
	async function flushCheckpoint() {
		saveTimer = null;
		if (persistence === null) return;
		const revDirty = [];
		for (const [id, entry] of Object.entries(agg.sessions)) {
			if (entry.revDirty === true) {
				entry.revDirty = false;
				revDirty.push([id, entry]);
			}
		}
		for (const [id, entry] of revDirty) {
			try {
				const rev = await persistence.readStoredRevision(id);
				if (typeof rev === "string") entry.rev = rev;
			} catch {
				// stat 失败：保持旧 rev，下次启动对账时重扫该会话。
			}
		}
		try {
			mkdirSync(storagesDir, { recursive: true });
			tokstatsSaveCheckpoint(checkpointPath, agg.sessions);
		} catch (error) {
			log(`tokstats checkpoint 写盘失败（下次启动将全量重扫）: ${String(error)}`);
		}
	}

	function scheduleSave() {
		if (saveTimer !== null || disposed) return;
		saveTimer = setTimeout(() => {
			void flushCheckpoint();
		}, TOKSTATS_DEBOUNCE_MS);
	}

	/** 扫描期间收到 flush 的会话，扫尾重新 inspect 补折（避免快照换 map 丢失增量）。 */
	async function refoldDirtyLive() {
		for (const id of agg.dirtyLive) {
			if (disposed) return;
			try {
				const view = await persistence.inspect(id);
				const entry = tokstatsFreshEntry(tokstatsRootWorkspaceOf(view.meta, agg.headers));
				tokstatsFoldSession(entry, view.events, view.meta?.seedLength);
				const rev = await persistence.readStoredRevision(id);
				entry.rev = typeof rev === "string" ? rev : null;
				agg.sessions[id] = entry;
			} catch (error) {
				log(`tokstats: 会话 ${id} 扫尾补折失败，跳过: ${String(error)}`);
			}
		}
		agg.dirtyLive.clear();
	}

	/** 启动扫盘：listSnapshots 对账，revision 未变的会话复用 checkpoint cells。 */
	async function runScan() {
		agg.scanState = "scanning";
		rebuild();
		try {
			const snapshots = await persistence.listSnapshots();
			agg.headers = new Map(snapshots.map((s) => [s.header.id, s.header]));
			const next = {};
			let processed = 0;
			for (const snap of snapshots) {
				if (disposed) return;
				const id = snap.header.id;
				const prev = agg.sessions[id];
				const w = tokstatsRootWorkspaceOf(snap.header, agg.headers);
				if (prev !== undefined && prev.rev !== null && prev.rev === snap.revision) {
					// 日志未变：复用已折叠 cells，仅刷新根工作区标签（父链可能变化）。
					next[id] = { ...prev, w };
					continue;
				}
				try {
					const view = await persistence.inspect(id);
					const entry = tokstatsFreshEntry(w);
					tokstatsFoldSession(entry, view.events, view.meta?.seedLength);
					entry.rev = snap.revision;
					next[id] = entry;
				} catch (error) {
					log(`tokstats: 会话 ${id} inspect 失败，本轮跳过: ${String(error)}`);
				}
				processed += 1;
				if (processed % 8 === 0) await new Promise((r) => setTimeout(r, 0));
			}
			agg.sessions = next;
			await refoldDirtyLive();
			agg.scanState = "done";
			agg.reason = undefined;
			rebuild();
			scheduleSave();
		} catch (error) {
			agg.scanState = "done";
			agg.reason = "scan-error";
			rebuild();
			log(`tokstats: 扫盘失败，发布空数据: ${String(error)}`);
		}
	}

	/** 活会话 flush 增量：内存 events 从 lastSeq+1 续折。 */
	function onFlush(session) {
		try {
			if (persistence === null || disposed) return;
			const id = session.id;
			const header = session.header;
			let entry = agg.sessions[id];
			if (entry === undefined) {
				entry = tokstatsFreshEntry(tokstatsRootWorkspaceOf(header, agg.headers));
				agg.sessions[id] = entry;
			}
			tokstatsFoldSession(entry, session.events, header?.seedLength);
			entry.revDirty = true;
			// flush 成功即数据在恢复：清掉启动扫盘的降级标注（no-persistence 场景到不了这里）。
			agg.reason = undefined;
			if (agg.scanState === "scanning") agg.dirtyLive.add(id);
			rebuild();
			scheduleSave();
		} catch (error) {
			log(`tokstats: flush 增量折叠失败: ${String(error)}`);
		}
	}

	// 降级矩阵：projection 缺席 → 聚合照跑、checkpoint 照写、仅无推送；
	// persistence 缺席 → 发布 no-persistence 空数据（都不抛错，硬规则 6）。
	let projected = false;
	ctx.inject(["sessionProjections"], (pctx) => {
		pctx.sessionProjections.register({
			key: "tokstats",
			stateSchema: { parse: (v) => v },
			init: () => ({ v: 0 }),
			// 版本号回声：聚合版本未变返回同引用（零下游工作），变了返回新引用
			// → 借下一个 session 事件触发 session/projection push frame。
			apply: (state) => (state !== null && typeof state === "object" && state.v === agg.version ? state : { v: agg.version }),
			wire: {
				viewSchema: { parse: (v) => v },
				view: () => agg.published,
			},
			stateVersion: 1,
		});
		projected = true;
		rebuild();
	});

	ctx.inject(["sessionPersistence"], (pctx) => {
		persistence = pctx.sessionPersistence;
		// 异步扫盘，不阻塞 boot；fiber 生命周期经 ctx.effect 清理。
		void runScan();
	});

	setTimeout(() => {
		if (disposed) return;
		if (!projected) log("tokstats: sessionProjections 服务缺席——聚合照常运行，但面板收不到推送");
		if (persistence === null) {
			// 降级矩阵：persistence 永不出场（inject 永不回调）→ 按完成态发布空数据并标注原因。
			agg.scanState = "done";
			agg.reason = "no-persistence";
			rebuild();
		}
	}, 5000);

	ctx.on("session/flush", onFlush);

	ctx.effect(() => {
		// 注册期（立即执行）：无准备工作；返回值是 fiber 停止时的清理函数。
		return () => {
			disposed = true;
			if (saveTimer !== null) {
				clearTimeout(saveTimer);
				saveTimer = null;
			}
		};
	}, "dsh-plugins/tokstats: lifecycle");
}

export { apply };
