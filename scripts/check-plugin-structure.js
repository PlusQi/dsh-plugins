#!/usr/bin/env node
/**
 * L1 静态 guard：校验多插件结构不变量（AGENTS.md 硬规则 1/2/3/4）。
 * 只读、零依赖、无环境要求。违规输出「不变量 + 位置 + 修复指引」。
 * 用法：node scripts/check-plugin-structure.js
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";

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
			// ns 的两种写法都要能取出值：标识符引用（`ns: LOCALE_NS_X`）或字符串字面量
			// （`ns: "dsh-plugins.x"`）。只认标识符会放过字面量写法，等于留一个后门。
			nsRef: (m[2].match(/\bns:\s*([A-Za-z_$][\w$]*)/) || [])[1] ?? null,
			nsLiteral: (m[2].match(/\bns:\s*["']([^"']+)["']/) || [])[1] ?? null,
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
	// PK-07 的 ns **值**校验：字段在不在是一回事，值对不对是另一回事。
	// 规范要求 ns 带包前缀（`dsh-plugins.<键>`）防撞车——撞车时重复注册同 (ns, locale)
	// 会抛，整个包在浏览器侧起不来。漏前缀的 ns 与插件键同名时同样会撞。
	//
	// 两种写法都查：`ns: LOCALE_NS_X`（标识符引用，去 client 里找字面量）与
	// `ns: "dsh-plugins.x"`（直接字面量）。只查前者会留下后者这个后门。
	if (!meta.nsNull && meta.ns) {
		let nsValue = meta.nsLiteral;
		if (nsValue === null && meta.nsRef !== null) {
			const decl = new RegExp(`const\\s+${meta.nsRef.replace(/\$/g, "\\$")}\\s*=\\s*["']([^"']+)["']`).exec(clientText);
			if (decl === null) {
				problems.push(`lib/client.js PLUGINS.${key}: ns 引用了 ${meta.nsRef}，但找不到它的字符串字面量声明 —— 无法校验命名空间是否带包前缀`);
			} else {
				nsValue = decl[1];
			}
		}
		if (nsValue !== null && nsValue !== `dsh-plugins.${key}`) {
			problems.push(`lib/client.js PLUGINS.${key}: ns 值为 '${nsValue}'，必须是 'dsh-plugins.${key}'（硬规则 7 要求带包前缀防撞车；重复注册同 (ns, locale) 会抛，整包在浏览器侧起不来）`);
		}
	}
}

// ── 硬规则 2（require 部分）：factory 内禁止相对路径 require ──
for (const [i, line] of clientText.split("\n").entries()) {
	if (/require\(\s*["']\.\.?\//.test(line)) {
		problems.push(`lib/client.js L${i + 1}: 相对路径 require（模块表只认包名/模块词，运行时直接抛错）`);
	}
}

// ── host 半边源码（PK-05 / PK-08 共用） ──
const indexPath = join(root, "lib", "index.js");
const indexText = readFileSync(indexPath, "utf8");

// ── PK-05：host 半边零运行时依赖（只许 node: 内建） ──
//
// 硬规则 5 的 host 延伸此前只靠评审（AGENTS.md 自己写着「规则 5 依赖评审」），
// 但这条恰恰是**装不上的**：pnpm link 安装下插件真实路径不在宿主 node_modules
// 树内，npm 包 import 在运行期不可解析——错了不是降级，是整个包加载失败。
// 现在补上静态项，把「依赖评审」换成 L1。
//
// 逐行扫而不是全文正则：全文正则给不出行号（本脚本其余各项都给行号），
// 且会把注释里的示例 import 也当成违规。注释行跳过，与 DIMENSION_USE 同策略。
// 只认 ESM 形态（`import ... from "x"` / `import "x"` / `import("x")`）：
// 本包 host 半边是 ESM；若将来改成 CJS `require("x")`，这一项会漏，需同步补。
const INDEX_IMPORT_RE = /\bimport\s*(?:\(\s*)?(?:[^"'()]*?\bfrom\s*)?["']([^"']+)["']/;
for (const [i, line] of indexText.split("\n").entries()) {
	if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
	const m = INDEX_IMPORT_RE.exec(line);
	if (m === null) continue;
	if (!m[1].startsWith("node:")) {
		problems.push(`lib/index.js L${i + 1}: import '${m[1]}' —— PK-05 要求 host 半边只 import node: 内建；npm 包（含 cordis/zod）在 pnpm link 安装路径下不可解析，整个包会加载失败`);
	}
}

// ── PK-08：host 半边不得写盘（持久化只经官方缓存） ──
//
// 违规形态是「自己落一个 checkpoint 文件」，故拦的是写/改名/建目录这一组调用。
// 只查调用形态而非 import：`readFileSync` 这类只读 API 不在本项范围，但 v0.6.0
// 交付后 lib/index.js 连 node:fs 都不再 import——留一条 WARN 记录这一状态。
const WRITE_CALL_RE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rename|mkdirSync|mkdir|createWriteStream|truncateSync)\s*\(/;
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

// ── CHANGELOG 版本段 ↔ 底部链接区一一对应（PK-11） ──
//
// 为什么需要这条静态检查：Keep a Changelog 的链接区是**手工维护**的，但它不属于
// 「写变更段落」那一步，也不属于「改版本号」那一步。0.4.0–0.7.0 六次发布都写了段
// 落，链接区却从 0.3.0 起再没动过——因为写段落与改版本被拆进了两个提交，没有任何
// 一步会顺带想起它。这类「孤儿维护点」只能靠机器盯。
//
// 判据是双向的：
//   · 每个 `## [X.Y.Z]` 段落必须有对应的 `[X.Y.Z]:` 链接行（否则该版本在底部无链接）；
//   · 每个 `[X.Y.Z]:` 链接行必须有对应的段落（否则残留已删版本的悬空链接）。
// `[Unreleased]` 单独查：它必须存在，且基线指向**最新已发布版本**——停在旧版本上
// 时 GitHub 的 compare 会横跨多个版本，看起来像「一次发布了六个版本」。
const changelogText = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const sectionVersions = [];
for (const [i, line] of changelogText.split(/\r?\n/).entries()) {
	const m = line.match(/^##\s+\[(\d+\.\d+\.\d+)\]/);
	if (m !== null) sectionVersions.push({ version: m[1], line: i + 1 });
}
const linkVersions = new Map();
let unreleasedLine = null;
let unreleasedBase = null;
for (const [i, line] of changelogText.split(/\r?\n/).entries()) {
	const link = line.match(/^\[(\d+\.\d+\.\d+)\]:\s*(\S+)/);
	if (link !== null) { linkVersions.set(link[1], { url: link[2], line: i + 1 }); continue; }
	const unrel = line.match(/^\[Unreleased\]:\s*(\S+)/);
	if (unrel !== null) { unreleasedLine = i + 1; unreleasedBase = unrel[1]; }
}

for (const { version, line } of sectionVersions) {
	if (!linkVersions.has(version)) {
		problems.push(`CHANGELOG.md L${line}: 版本段 [${version}] 缺少底部链接行 —— 补 \`[${version}]: ...compare/v<前一版>...v${version}\`（PK-11）`);
	}
}
const sectionSet = new Set(sectionVersions.map((s) => s.version));
for (const [version, info] of linkVersions) {
	if (!sectionSet.has(version)) {
		problems.push(`CHANGELOG.md L${info.line}: 链接行 [${version}] 没有对应版本段 —— 悬空链接，版本段被删时链接要同步删（PK-11）`);
	}
}
if (unreleasedLine === null) {
	problems.push("CHANGELOG.md: 缺少 [Unreleased] 链接行 —— Keep a Changelog 要求它存在并指向最新已发布版本（PK-11）");
} else if (sectionVersions.length > 0) {
	// 段落在文件里是从新到旧排列的，第一段即最新发布版本。
	const newest = sectionVersions[0].version;
	const baseMatch = unreleasedBase === null ? null : unreleasedBase.match(/\.\.\.HEAD$/);
	if (baseMatch === null) {
		problems.push(`CHANGELOG.md L${unreleasedLine}: [Unreleased] 链接不以 \`...HEAD\` 结尾 —— 应形如 \`...compare/v${newest}...HEAD\`（PK-11）`);
	} else if (!unreleasedBase.includes(`/v${newest}...HEAD`)) {
		problems.push(`CHANGELOG.md L${unreleasedLine}: [Unreleased] 基线不是最新版本 v${newest}（当前 ${unreleasedBase}）—— 停在旧版本上会让 compare 横跨多个版本（PK-11）`);
	}
}

// ── 链接行引用的 tag 必须真实存在（PK-11 第 4 条） ──
//
// 这一条是补链接区时**自己踩出来的**：把 0.7.0 / 0.7.1 写成版本段并补了 compare
// 链接，但那两个版本按维护者裁决不打 tag，于是链接指向不存在的 ref——GitHub 上
// 是硬 404，且不会随时间自愈（除非事后补 tag）。「段落与链接一一对应」查不出这种
// 情况：段落和链接都在，只是它们指向的 ref 不存在。
//
// 读 tag 不走子进程（零依赖、无 git 二进制假设）：直接读 `refs/tags/` 与
// `packed-refs`。两处陷阱都要处理：
//   · 主仓库：`.git` 是目录，refs 就在其下；
//   · worktree / 子模块：`.git` 是**文件**，内容是 `gitdir: <路径>`，而那路径是
//     **该 worktree 私有的** git 目录（只放 HEAD、index 等），tag 等共享引用在它
//     的 `commondir` 文件所指的主仓库 git 目录里——只读 gitdir 会一个 tag 都读不到，
//     表现为「全部链接都指向不存在的 tag」的假报。
function readLocalTags(gitDir) {
	// 键统一为**不带 v 前缀**的版本号：比对侧的正则 `/v(\d+\.\d+\.\d+)/` 只捕获
	// 数字部分，两边口径必须一致，否则每个 tag 都会被判成「不存在」。
	const tags = new Set();
	const add = (name) => {
		const m = name.match(/^v?(\d+\.\d+\.\d+)$/);
		if (m !== null) tags.add(m[1]);
	};
	let base;
	try {
		if (statSync(gitDir).isFile()) {
			const pointer = readFileSync(gitDir, "utf8").match(/^gitdir:\s*(.+)$/m);
			if (pointer === null) return null;
			const gitdir = pointer[1].trim();
			// worktree 的共享引用在主仓库；commondir 可能是相对 gitdir 的路径。
			let common = gitdir;
			try {
				const rel = readFileSync(join(gitdir, "commondir"), "utf8").trim();
				if (rel.length > 0) common = isAbsolute(rel) ? rel : join(gitdir, rel);
			} catch { /* 非 worktree：gitdir 即主目录 */ }
			base = common;
		} else {
			base = gitDir;
		}
	} catch {
		return null;
	}
	try {
		for (const name of readdirSync(join(base, "refs", "tags"))) add(name);
	} catch { /* 无 loose tag，可能全在 packed-refs 里 */ }
	try {
		for (const line of readFileSync(join(base, "packed-refs"), "utf8").split(/\r?\n/)) {
			const m = line.match(/^[0-9a-f]{40,64}\s+refs\/tags\/(\S+)$/);
			if (m !== null) add(m[1]);
		}
	} catch { /* 无 packed-refs */ }
	return tags;
}

const localTags = readLocalTags(join(root, ".git"));
if (localTags === null) {
	warnings.push("CHANGELOG.md: 读不到本地 tag 列表（.git 不可解析）—— 跳过「链接引用的 tag 是否存在」检查（PK-11 第 4 条未执行）");
} else {
	const linkLines = [
		...(unreleasedLine === null ? [] : [{ name: "Unreleased", url: unreleasedBase, line: unreleasedLine }]),
		...[...linkVersions.entries()].map(([version, info]) => ({ name: version, url: info.url, line: info.line })),
	];
	for (const { name, url, line } of linkLines) {
		// compare/vA...vB 与 releases/tag/vX 都会出现 vX.Y.Z 形态的 ref
		const refs = [...new Set([...url.matchAll(/v(\d+\.\d+\.\d+)/g)].map((m) => m[1]))];
		const missing = refs.filter((ref) => !localTags.has(ref));
		if (missing.length > 0) {
			problems.push(`CHANGELOG.md L${line}: 链接 [${name}] 引用了不存在的 tag ${missing.map((r) => "v" + r).join(", ")} —— GitHub 上该链接是 404，且不会自愈。要么补打 tag，要么把未发布内容折回 [Unreleased] 段（PK-11）`);
		}
	}
}

// ── package.json 版本 ↔ CHANGELOG 最新已发布段（PK-12） ──
//
// CHANGELOG 开头自称「版本号对齐 `package.json`」，但此前没有任何检查兜它，于是
// 出现过一个自相矛盾的状态：`package.json` 写着 0.7.1，CHANGELOG 最新段是
// `[Unreleased]`（即最新**已发布**版本是 0.6.0），而 v0.7.1 这个 tag 并不存在。
//
// 语义：`package.json.version` 是「这个工作树自称的版本」，它必须等于最新**已发布**
// 版本段（即第一个 `## [X.Y.Z]` 段）——未发布改动挂在 `[Unreleased]` 下，不抬版本号。
// 打 tag 时两件事一起做：段落定版 + 抬版本号，这条检查因此天然对齐发布动作。
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (typeof pkgVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(pkgVersion)) {
	problems.push(`package.json: version 不是 X.Y.Z 形态（当前 ${JSON.stringify(pkgVersion)}）（PK-12）`);
} else if (sectionVersions.length === 0) {
	problems.push("CHANGELOG.md: 找不到任何 `## [X.Y.Z]` 版本段 —— 无法核对 package.json 版本（PK-12）");
} else {
	// 段落在文件里从新到旧排列，第一段即最新已发布版本。
	const newestPublished = sectionVersions[0].version;
	if (newestPublished !== pkgVersion) {
		problems.push(`package.json version 为 ${pkgVersion}，但 CHANGELOG 最新已发布版本段是 ${newestPublished} —— 二者必须一致；未发布改动挂 [Unreleased]，打 tag 时同时抬版本号并把段落定版（PK-12）`);
	}
}

// ── 孤儿插件（注册但无 patch 行，缺 host 锚点）：提示不阻塞 ──
const activated = new Set(rows.map((r) => r.plugin));
for (const key of registered.keys()) {
	if (!activated.has(key)) {
		warnings.push(`lib/client.js PLUGINS.${key}: 已注册但 cordis.patch.yml 无对应行 —— 无 host 侧存在/禁用锚点（客户端 UI 仍随任一存活行激活，但无法按行禁用；若在准备中可忽略）`);
	}
}

// ── PK-13：包级展示元数据可被宿主解析 ──
//
// 宿主的插件页标题不是读 client 词典，而是 `dsh-app-boot` 的 `readPluginMeta`：
//
//   barePackageName(specifier)                      ← 必须裸包名
//     ↓ optionalResourcePath(`${spec}/locale/en.json`)  ← exports 必须放行，否则整段退化为包名
//     ↓ dictionariesOf(dirname(en.json))            ← 语言文件同目录，文件名必须是语言 id
//     ↓ localizedText("title" / "description")      ← 只读 meta.title / meta.description
//
// 打包侧还有第四道：`files` 必须含 `locale`，否则 git / npm 安装拿不到文件。本机是
// junction 的 link 安装，`files` 完全不生效——只有 `npm pack --dry-run` 能验，所以
// 这条 guard 必须静态查 `files`，不能指望「本地装上去看着正常」。
//
// 最隐蔽的是 `meta` 外壳：写成 `{"title": …}` 时 JSON 完全合法、测试也全绿，宿主却
// 静默把字典当成全空、回退到 `package.json.name`（插件页显示原始包名）。这正是
// AC-15③ 反向验证要锁住的形态，所以这里显式查两层结构，而不是只查「能解析」。
const LANG_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const localeDir = join(root, "locale");
const englishLocalePath = join(localeDir, "en.json");
let localeFiles = [];
try {
	localeFiles = readdirSync(localeDir).filter((name) => name.endsWith(".json")).sort();
} catch {
	problems.push("locale/en.json 不存在 —— 宿主 readPluginMeta 找不到包级字典，插件页标题回退为 package.json.name（显示原始包名「dsh-plugins」）（PK-13）");
}
if (localeFiles.length > 0 && !localeFiles.includes("en.json")) {
	problems.push(`locale/: 缺少 en.json（现有 ${localeFiles.join(", ")}）—— 宿主只以 en.json 为入口探测字典，其它语言文件会被整目录忽略（PK-13）`);
}
for (const name of localeFiles) {
	const language = name.slice(0, -5);
	if (!LANG_ID.test(language)) {
		problems.push(`locale/${name}: 文件名不是语言 id（须匹配 ${LANG_ID}）—— 宿主 dictionariesOf 会直接抛错，整段元数据退化为包名（PK-13）`);
		continue;
	}
	const file = join(localeDir, name);
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		problems.push(`locale/${name}: 不是合法 JSON（${String(error).split("\n")[0]}）—— 宿主 readObject 抛错后整段元数据只剩错误诊断，插件页无标题（PK-13）`);
		continue;
	}
	const meta = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed.meta : undefined;
	const shellMissing = typeof meta !== "object" || meta === null || Array.isArray(meta);
	if (shellMissing) {
		// 缺 meta 外壳是最容易被「顺手简化」破坏的一条：JSON 合法、测试全绿、宿主不报错。
		problems.push(`locale/${name}: 缺少 meta 外壳（形如 {"meta":{"title":…,"description":…}}，当前顶层键 ${Object.keys(parsed ?? {}).join(", ") || "无"}）—— 宿主 dictionariesOf 只读 meta.title / meta.description，会静默回退到 package.json.name，插件页标题显示原始包名（PK-13）`);
		continue;
	}
	for (const field of ["title", "description"]) {
		const value = meta[field];
		if (typeof value !== "string" || value.trim() === "") {
			problems.push(`locale/${name}: 缺少 meta.${field}（须为非空字符串）—— 宿主 readPluginMeta 会静默回退到 package.json 的 ${field === "title" ? "name（显示原始包名）" : "description（中文长句在英文界面照显示）"}（PK-13）`);
		}
	}
	const extra = Object.keys(meta).filter((key) => key !== "title" && key !== "description");
	if (extra.length > 0) {
		warnings.push(`locale/${name}: meta 含宿主不读的键 ${extra.join(", ")} —— readPluginMeta 只消费 title / description，其余是死字段（PK-13）`);
	}
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const exportKeys = typeof pkg.exports === "object" && pkg.exports !== null ? Object.keys(pkg.exports) : [];
if (!exportKeys.includes("./locale/*.json")) {
	problems.push(`package.json exports: 缺少 "./locale/*.json"（现有键 ${exportKeys.join(", ") || "无"}）—— optionalResourcePath 走 Node ESM 解析器，未放行的子路径抛 ERR_PACKAGE_PATH_NOT_EXPORTED，宿主读不到字典、标题回退为包名（PK-13）`);
}
const filesList = Array.isArray(pkg.files) ? pkg.files : [];
// 覆盖判定按打包语义：`locale`、`locale/**`、`locale/*.json` 都覆盖到 locale 目录；
// 反向用例（从 files 删掉）走的是「一条都不覆盖」，所以这里只需认出这些形态。
const localeCovered = filesList.some((entry) => typeof entry === "string" && /^\.?\/?locale(\/|$)/.test(entry));
if (!localeCovered) {
	problems.push(`package.json files: 缺少 "locale"（现有 ${filesList.join(", ") || "空"}）—— npm / git 安装按 files 白名单打包，locale 会被丢掉；本机 link 安装是 junction 直通仓库、看不出这个问题，只能靠 "npm pack --dry-run" 验（PK-13）`);
}

// ── 汇总输出 ──
for (const w of warnings) console.log("[WARN] " + w);
if (problems.length > 0) {
	for (const p of problems) console.error("[FAIL] " + p);
	console.error(`\n${problems.length} 项违反 AGENTS.md 硬规则（详见上方各条指引）。`);
	process.exit(1);
}
console.log(`OK: ${rows.length} 个 patch 行 / ${registered.size} 个注册插件，结构不变量全部通过。`);
