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
const registered = new Map(); // 键 -> { line, css, apply }
const pluginsBlock = clientText.match(/const PLUGINS = \{([\s\S]*?)\n\t+\};/);
if (pluginsBlock === null) {
	problems.push("lib/client.js: 找不到 `const PLUGINS = { ... }` 注册表 —— 客户端 apply 的唯一注册来源（硬规则 3），检查是否被误删或改名");
} else {
	for (const m of pluginsBlock[1].matchAll(/^\t+(\w+):\s*\{(.*)\}/gm)) {
		registered.set(m[1], {
			css: /\bcss\b/.test(m[2]),
			apply: /\bapply\b/.test(m[2]),
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
}

// ── 硬规则 2（require 部分）：factory 内禁止相对路径 require ──
for (const [i, line] of clientText.split("\n").entries()) {
	if (/require\(\s*["']\.\.?\//.test(line)) {
		problems.push(`lib/client.js L${i + 1}: 相对路径 require（模块表只认包名/模块词，运行时直接抛错）`);
	}
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
