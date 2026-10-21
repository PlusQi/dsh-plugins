#!/usr/bin/env node
/**
 * L1 静态 guard：校验多插件结构不变量（AGENTS.md 硬规则 1/2/3/4）。
 * 只读、零依赖、无环境要求。违规输出「不变量 + 位置 + 修复指引」。
 * 用法：node scripts/check-plugin-structure.js
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const warnings = [];

// ── 解析 cordis.patch.yml 的插件条目（行级轻量解析，格式固定三字段） ──
const patchPath = join(root, "cordis.patch.yml");
const patchText = readFileSync(patchPath, "utf8");
const rows = [];
let current = null;
for (const [i, line] of patchText.split(/\r?\n/).entries()) {
	if (line.trim().startsWith("#") || line.trim() === "") continue;
	const idMatch = line.match(/^\s*-\s*id:\s*(\S+)/);
	if (idMatch) { current = { line: i + 1, id: idMatch[1], name: null, plugin: null }; rows.push(current); continue; }
	const nameMatch = line.match(/^\s*name:\s*'?([^'"\s]+)'?/);
	if (nameMatch && current) { current.name = nameMatch[1]; continue; }
	const pluginMatch = line.match(/^\s*plugin:\s*(\S+)/);
	if (pluginMatch && current) { current.plugin = pluginMatch[1]; }
}

// ── 提取 lib/client.js 的 PLUGINS 注册表键 ──
const clientPath = join(root, "lib", "client.js");
const clientText = readFileSync(clientPath, "utf8");
const registered = new Map(); // 键 -> { css, apply, ns, dicts, nsNull }
const pluginsBlock = clientText.match(/const PLUGINS = \{([\s\S]*?)\n\t+\};/);
if (pluginsBlock === null) {
	problems.push("lib/client.js: 找不到 `const PLUGINS = { ... }` 注册表 —— 客户端 apply 的唯一注册来源（硬规则 3），检查是否被误删或改名");
} else {
	for (const m of pluginsBlock[1].matchAll(/^\t+(\w+):\s*\{(.*)\}/gm)) {
		registered.set(m[1], {
			css: /\bcss\b/.test(m[2]),
			apply: /\bapply\b/.test(m[2]),
			ns: /\bns\b/.test(m[2]),
			dicts: /\bdicts\b/.test(m[2]),
			nsNull: /\bns:\s*null\b/.test(m[2]),
		});
	}
}

// ── 硬规则 1：patch 行 name 必须是裸包名 'dsh-plugins' ──
for (const row of rows) {
	if (row.name === null) {
		problems.push(`cordis.patch.yml L${row.line} (id: ${row.id}): 缺少 name 字段 —— client 半边无法按包名发现`);
	} else if (row.name !== "dsh-plugins") {
		problems.push(`cordis.patch.yml L${row.line} (id: ${row.id}): name 为 '${row.name}'，必须是裸包名 'dsh-plugins'（子路径只剩 host 半边）`);
	}
}

// ── 硬规则 3：config.plugin 必须已在 PLUGINS 注册 ──
for (const row of rows) {
	if (row.plugin === null) {
		problems.push(`cordis.patch.yml L${row.line} (id: ${row.id}): 缺少 config.plugin 分发键 —— host 侧分发/禁用锚点失效，且无法交叉校验 PLUGINS 注册表`);
	} else if (!registered.has(row.plugin)) {
		problems.push(`cordis.patch.yml L${row.line} (id: ${row.id}): config.plugin '${row.plugin}' 未在 lib/client.js 的 PLUGINS 注册表注册 —— 行与注册表漂移（host 半边按该键分发时会落空；客户端不消费此键，此为一致性校验）`);
	}
}

// ── 硬规则 4：样式必须经 ensurePluginStyles 按插件分 tag ──
if (!clientText.includes('data-plugin-css="dsh-plugins/')) {
	problems.push("lib/client.js: 未找到 data-plugin-css=\"dsh-plugins/<id>\" 样式 tag 机制 —— 硬规则 4（样式按插件分 tag）被破坏");
}
for (const [key, meta] of registered) {
	if (!meta.css || !meta.apply) {
		problems.push(`lib/client.js PLUGINS.${key}: 注册块缺少 ${!meta.css ? "css" : "apply"} 字段 —— 客户端 apply 将注入 undefined（样式 tag 写入 'undefined' / 注册抛错跳过该插件）`);
	}
	// 硬规则 7 的静态兜底：新插件漏带词典时没有任何运行时报错（只是文案不翻译），
	// 必须在这里拦。无 UI 文案的插件（纯 host 半边）显式写 ns: null 声明。
	if (!meta.nsNull && (!meta.ns || !meta.dicts)) {
		problems.push(`lib/client.js PLUGINS.${key}: 缺 ${!meta.ns ? "ns" : "dicts"} 字段 —— 硬规则 7 要求每插件自带词典（ns = "dsh-plugins.${key}"、dicts = { zh, en }）；该插件确无任何界面文案时显式写 ns: null`);
	}
}

// ── 硬规则 2（require 部分）：factory 内禁止相对路径 require ──
for (const [i, line] of clientText.split("\n").entries()) {
	if (/require\(\s*["']\.\.?\//.test(line)) {
		problems.push(`lib/client.js L${i + 1}: 相对路径 require（模块表只认包名/模块词，运行时直接抛错）`);
	}
}

// ── I2 / AC-15：host 半边不得写盘（持久化只经官方缓存） ──
//
// 违规形态是「自己落一个 checkpoint 文件」，故拦的是写/改名/建目录这一组调用。
// 只查调用形态而非 import：`readFileSync` 这类只读 API 不在本项范围，但 v0.6.0
// 交付后 lib/index.js 连 node:fs 都不再 import——留一条 WARN 记录这一状态。
const WRITE_CALL_RE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rename|mkdirSync|mkdir|createWriteStream|truncateSync)\s*\(/;
const indexPath = join(root, "lib", "index.js");
const indexText = readFileSync(indexPath, "utf8");
for (const [i, line] of indexText.split("\n").entries()) {
	if (WRITE_CALL_RE.test(line)) {
		problems.push(`lib/index.js L${i + 1}: 写盘调用 —— I2/AC-15 要求持久化只经官方 session-projection-cache，本包不得写 DSH_HOME/storages/ 下任何自有文件：${line.trim().slice(0, 80)}`);
	}
}
if (!/from\s+"node:fs"/.test(indexText) && !/from\s+'node:fs'/.test(indexText)) {
	// 不是问题，只是把「已彻底不依赖 node:fs」这一状态记下来（v0.6.0 的成果）。
	console.log("[INFO] lib/index.js 未 import node:fs —— 持久化已完全交给官方管线（I2）");
}

// ── I1：client 半边不得持有价格/模型维度 ──
//
// `prices` 是已删除的配置面，任何残留都意味着成本维度没删干净。
for (const [i, line] of clientText.split("\n").entries()) {
	if (/\bprices\b/.test(line)) {
		problems.push(`lib/client.js L${i + 1}: 出现 prices 字面量 —— Q6 已删除成本维度，界面不得再持有定价（I1）`);
	}
}

// `provider` / `model` 是已删除的维度字段名。v0.6.0 两批都落地后，整个 client 产物
// 都不该再把它们当**字段**用：第一批删了 tokstats 的模型维度，第二批删了 tokprev 的
// TurnBadge（其文案原本写着 provider-reported）。
//
// 规则针对「维度用法」而不是这个词本身——`model` 在普通英文里是「模型」的意思，
// 「The model call failed」「model select」这类文案与维度无关，按单词拦会逼着把
// 用户可读的句子改坏。维度用法的形态是可枚举的：属性访问、下标、赋值键、对象字面量键。
const DIMENSION_USE = [
	/\bprovider\s*[:,]/,          // { provider: ... } / provider:
	/\bmodel\s*[:,]/,             // { model: ... } / model:
	/\.\s*(provider|model)\b/,    // x.provider / x.model
	/\[\s*["'](provider|model)["']\s*\]/, // x["provider"]
];
for (const [i, line] of clientText.split("\n").entries()) {
	// 注释行不算维度用法（维度相关的说明文字是允许的）
	if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
	const hit = DIMENSION_USE.find((re) => re.test(line));
	if (hit !== undefined) {
		problems.push(`lib/client.js L${i + 1}: 出现 provider/model 维度用法 —— Q6 已删除该维度，wire 摘要与面板都不得含它（I1）：${line.trim().slice(0, 80)}`);
	}
}

// ── I11：路由来源只有 assistant/message.source，不得回落到请求侧事件 ──
//
// 请求侧事件带的是**配置快照**（`data.header.config`，且有 initial / change /
// series / resume 四种 reason），与 usage 的结算语义不同源。读它会让「路由」与
// 「用量」来自两条独立路径，正是 SPEC Q7 明确排除的耦合——它只能补上极少数
// 未标注样本（实测 0.18%），代价是数字从此不可对账。
//
// 与 `DIMENSION_USE`（跳过注释行）相反，这里**注释行也扫**：这个约束太容易在后续
// 维护里被一句「顺便从那里补一下」破坏，而它的形式又极具体（就一个词）。代价是
// 实现里连说明文字都不能写这个词——lib/index.js 的注释改用「请求侧的事件」表述。
const FORBIDDEN_ROUTE_SOURCE = /request\/header/;
for (const [i, line] of indexText.split("\n").entries()) {
	if (FORBIDDEN_ROUTE_SOURCE.test(line)) {
		problems.push(`lib/index.js L${i + 1}: 出现 request/header —— 路由只允许来自 assistant/message.source（I11），请求侧是配置快照、与 usage 结算不同源`);
	}
}
// 同一约束的代码形态兜底：即使换个词，读 header.config 也一样越界。
if (/\bheader\s*\.\s*config\b/.test(indexText)) {
	problems.push("lib/index.js: 出现 header.config 读取 —— 请求侧配置快照不得作为路由来源（I11）");
}

// ── 孤儿插件（注册但无 patch 行，缺 host 锚点）：提示不阻塞 ──
const activated = new Set(rows.map((r) => r.plugin));
for (const key of registered.keys()) {
	if (!activated.has(key)) {
		warnings.push(`lib/client.js PLUGINS.${key}: 已注册但 cordis.patch.yml 无对应行 —— 无 host 侧存在/禁用锚点（客户端 UI 仍随任一存活行激活，但无法按行禁用；若在准备中可忽略）`);
	}
}

// ── 汇总输出 ──
for (const w of warnings) console.log("[WARN] " + w);
if (problems.length > 0) {
	for (const p of problems) console.error("[FAIL] " + p);
	console.error(`\n${problems.length} 项违反 AGENTS.md 硬规则（详见上方各条指引）。`);
	process.exit(1);
}
console.log(`OK: ${rows.length} 个 patch 行 / ${registered.size} 个注册插件，结构不变量全部通过。`);
