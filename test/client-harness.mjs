// client 半边测试公共装配：eval 真实 lib/client.js 产物（window.__ModuleLoader__
// 捕获 factory），mock react + 伪 ctx.slots/locale 浅渲染组件树断言。零依赖。
//
// locale 桩是这里的关键设施：词典定义在 factory 闭包里、不导出，测试拿不到真
// 字典就无从断言文案。桩的 register 把真实字典接住，bind 吐出走真实回退链的
// t（ns 当前语言 → ns 的 en → 裸键），于是中文断言与英文断言共用同一套词典。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, "..", "lib", "client.js");

/** 捕获 ensurePluginStyles 注入的 style tag（回归断言 CSS 关键声明用）。 */
export const injectedStyleTags = [];

export const clientDef = (() => {
	let captured = null;
	globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
	// 组件 effect 会触碰 window/document（真实浏览器 API），提供最小桩。
	globalThis.window.innerHeight = 800;
	globalThis.window.innerWidth = 1280;
	globalThis.window.addEventListener = () => {};
	globalThis.window.removeEventListener = () => {};
	globalThis.document = {
		addEventListener: () => {},
		removeEventListener: () => {},
		querySelector: () => null,
		createElement: () => ({ dataset: {}, style: {} }),
		head: { appendChild: (tag) => { injectedStyleTags.push(tag); } },
	};
	new Function(readFileSync(clientPath, "utf8"))();
	if (captured === null) throw new Error("client.js 应被 __ModuleLoader__ 捕获");
	return captured;
})();

// ── react mock：createElement 出普通对象树；hooks 做最小状态机 ─────────────

export function makeReactMock({ initialStates = [] } = {}) {
	const react = {
		Fragment: Symbol.for("react.fragment"),
		initialStates,
		stateValues: [],
		_effects: [],
		_idx: 0,
		reset() { react._idx = 0; },
		clearStates() { react.stateValues.length = 0; react._idx = 0; },
		runEffects() {
			for (const fn of react._effects.splice(0)) {
				try { fn(); } catch { /* effect 内部异常不阻断断言 */ }
			}
		},
	};
	// 对齐 React.createElement 语义：子元素同时挂到 props.children（函数组件解构用）。
	react.createElement = (type, props, ...children) => {
		const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true);
		const merged = { ...(props ?? {}) };
		if (flat.length > 0 && merged.children === undefined) merged.children = flat.length === 1 ? flat[0] : flat;
		return { type, props: merged, children: flat };
	};
	react.useState = (init) => {
		const i = react._idx++;
		if (!(i in react.stateValues)) {
			react.stateValues[i] = i < react.initialStates.length && react.initialStates[i] !== undefined
				? react.initialStates[i]
				: typeof init === "function" ? init() : init;
		}
		return [react.stateValues[i], (v) => {
			react.stateValues[i] = typeof v === "function" ? v(react.stateValues[i]) : v;
		}];
	};
	react.useMemo = (f) => f();
	react.useRef = () => ({ current: { getBoundingClientRect: () => ({ left: 12, top: 340 }), contains: () => false } });
	react.useEffect = (fn) => { react._effects.push(fn); };
	react.useLayoutEffect = (fn) => { react._effects.push(fn); };
	return react;
}

// ── 树遍历 / 文本提取 ─────────────────────────────────────────────────────

export function nodesOf(root) {
	const out = [];
	(function walk(n) {
		if (n && typeof n === "object" && n.type !== undefined) {
			out.push(n);
			for (const c of n.children ?? []) walk(c);
		}
	})(root);
	return out;
}

export function textOf(node) {
	const parts = [];
	(function walk(n) {
		if (typeof n === "string" || typeof n === "number") { parts.push(String(n)); return; }
		if (Array.isArray(n)) { n.forEach(walk); return; }
		if (n && typeof n === "object") for (const c of n.children ?? []) walk(c);
	})(node);
	return parts.join("");
}

/** 行节点判定：className 按词边界匹配（rowLabel/rowValue 是别的 class，不能靠 includes）。 */
const ROW_CLASS = /(?:^|\s)dsh-tokstats-row(?:\s|$)/;
export function rowNodesOf(root) {
	return nodesOf(root).filter((n) => typeof n.props.className === "string" && ROW_CLASS.test(n.props.className));
}

/** 深渲染：递归执行树中的函数型组件节点（mock createElement 不自动执行组件）。 */
export function renderDeep(react, node, depth = 0) {
	if (node === null || node === undefined || typeof node !== "object") return node;
	if (typeof node.type === "function" && depth < 24) {
		return renderDeep(react, node.type(node.props), depth + 1);
	}
	return { ...node, children: (node.children ?? []).map((c) => renderDeep(react, c, depth)) };
}

/** 渲染两次并跑掉 effects：第一次收集 effect，第二次反映 effect 写入的状态（如锚点）。 */
export function renderWithEffects(react, comp, props) {
	let tree = comp(props);
	react.runEffects();
	react.reset();
	tree = comp(props);
	react.reset();
	return tree;
}

// ── locale 桩 ─────────────────────────────────────────────────────────────

/**
 * 按宿主真实回退链查词：ns 当前语言 → ns 的 en → 裸键。
 * 注意官方链里没有「en 缺键回落 zh」一档，缺键直接显示键名（故意 fail loud），
 * 测试因此能一眼看出英文词典漏键。
 */
function makeT(dicts, ns, active) {
	return (key, params) => {
		const table = dicts[ns] ?? {};
		const template = (table[active] ?? {})[key] ?? (table.en ?? {})[key] ?? key;
		if (params === undefined) return template;
		return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
	};
}

/**
 * factory(react) → apply(伪 ctx) → 返回注册记录、捕获到的真实词典与该语言的 t。
 * @param opts.locale 当前语言（"zh" | "en"），决定 bind 吐出的 t 走哪套字典。
 */
export function setupClientBase({ initialStates, locale = "zh" } = {}) {
	const react = makeReactMock({ initialStates });
	const exportsObj = clientDef.factory(() => react);
	const registrations = [];
	const dicts = {};
	const ctx = {
		slots: {
			inject: (name, fn) => { fn(); return () => {}; },
			register: (opts, comp) => { registrations.push({ opts, comp }); return () => {}; },
		},
		effect: () => () => {},
		locale: {
			// 一个 ns 只有一个 owner：重复注册同 ns 要抛（与宿主实现一致，撞车是真失败）。
			register: (ns, dict) => {
				if (dicts[ns] !== undefined) throw new Error(`locale namespace "${ns}" already registered`);
				dicts[ns] = dict;
				return () => { delete dicts[ns]; };
			},
			bind: (ns) => makeT(dicts, ns, locale),
		},
	};
	exportsObj.apply(ctx);
	const componentOf = (slotName) => registrations.find((r) => r.opts.name === slotName)?.comp;
	return { react, exportsObj, registrations, dicts, componentOf, t: (ns) => makeT(dicts, ns, locale) };
}

/** 词典键集双向一致断言：多键、少键、空值都 fail（替代官方 TS 的编译期保障）。 */
export function assertDictPair(assert, ns, dicts) {
	const pair = dicts[ns];
	assert.ok(pair !== undefined, `${ns} 词典应已注册`);
	assert.deepEqual(Object.keys(pair), ["zh", "en"], `${ns} 应同时注册 zh 与 en`);
	const zhKeys = Object.keys(pair.zh).sort();
	const enKeys = Object.keys(pair.en).sort();
	assert.deepEqual(enKeys, zhKeys, `${ns} 的 en 与 zh 键集必须一致（缺键在英文界面会显示裸键）`);
	for (const key of zhKeys) {
		assert.equal(typeof pair.zh[key], "string", `${ns}.zh.${key} 应为字符串`);
		assert.ok(pair.zh[key].length > 0, `${ns}.zh.${key} 不应为空`);
		assert.equal(typeof pair.en[key], "string", `${ns}.en.${key} 应为字符串`);
		assert.ok(pair.en[key].length > 0, `${ns}.en.${key} 不应为空`);
	}
}
