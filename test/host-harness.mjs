// host 半边测试公共装配：伪 cordis ctx + connection / llm 服务桩。
//
// 为什么单独成文件：host 侧的服务桩比 client 的 react 桩更讲究——connection
// 的 handle 是「注册时捕获、事后驱动」，llm 的 stream 是「异步生成器 + signal
// 中止」。这两块的语义（尤其是 abort 怎么传播）如果和被测行为混在一个提交里
// 写，桩本身的 bug 会伪装成实现 bug。零依赖（AGENTS 硬规则 5）。
//
// 契约出处（@deepseek-ai/dsh@0.1.1-rc.2）：
// - ctx.connection.rpc.handle(channel, handler, options) —— 注意 handle 在
//   rpc 子对象上（dsh-client-connection/lib/index.js:220），options.authority
//   必填；handler 签名 (endpoint, payload, signal) => Promise<RpcResult>。
// - ctx.llm.stream(options) —— options.provider / .model 必填（无默认路由）；
//   产出 StreamChunk 流：text-delta / usage / finish（dsh-llm/lib/types/types.d.ts）。
// - ctx.llm.listProviders() / listModels(provider) —— 取路由用。

/** 与浏览器/宿主一致的 abort 错误形态（name 是判定「被取消」的依据）。 */
export function abortError(message = "This operation was aborted") {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

/**
 * 伪 `webServer`：捕获注册的路由，并能模拟一次真实请求驱动它。
 *
 * 为什么必须这样测：本包不复用 `connection.rpc.handle`（它在 0.2.1-rc.2 上从第三方
 * context 调用会抛 cannot get property "webServer"），而是自己 `webServer.register`
 * 一条 prefix 路由。若桩只记 `rpc.handle`，测到的是一条根本不存在的路径。
 */
export function makeWebServerStub() {
	const routes = [];
	const stub = {
		routes,
		register(route) {
			routes.push(route);
			return () => {};
		},
		/**
		 * 驱动一条已注册的 prefix 路由，模拟浏览器发出一次 RPC。
		 * `options.signal` 会像浏览器 abort fetch 一样触发 req 的 aborted，
		 * 从而让实现里的 AbortController 中止 in-flight 调用。
		 * @returns 解析后的信封（`{ type, rpcId, result }`），或 `{ status }`（非 200）。
		 */
		async invoke(channel, endpoint, payload, options = {}) {
			// 允许把 AbortSignal 直接当第 4 参传（`invoke(ch, ep, payload, signal)`），
			// 与 old RPC handler 的 `(endpoint, payload, signal)` 写法保持阅读一致。
			const opts = options !== null && typeof options === "object" && typeof options.addEventListener === "function"
				? { signal: options }
				: options;
			const route = routes.find((r) => r.path === channel);
			if (route === undefined) throw new Error(`没有注册通道 ${channel}`);
			const body = JSON.stringify({
				type: "client-request",
				rpcId: opts.rpcId ?? "test-rpc-id",
				method: endpoint,
				payload,
			});
			const abortHandlers = [];
			const alreadyAborted = opts.signal !== undefined && opts.signal.aborted === true;
			const req = {
				method: "POST",
				url: `${channel}/${endpoint}`,
				headers: { "content-type": opts.contentType ?? "application/json" },
				on(name, handler) {
					if (name !== "aborted") return req;
					abortHandlers.push(handler);
					// 请求进来时就已经被取消：注册即触发，等价于浏览器在发出前 abort。
					if (alreadyAborted) handler();
					return req;
				},
				async *[Symbol.asyncIterator]() {
					yield Buffer.from(body, "utf8");
				},
			};
			let status = 200;
			let text = "";
			const res = {
				writableEnded: false,
				writeHead(code) { status = code; },
				end(chunk) { text = chunk === undefined ? "" : String(chunk); res.writableEnded = true; },
				on() { return res; },
			};
			if (opts.signal !== undefined) {
				const fire = () => { for (const h of abortHandlers) h(); };
				if (opts.signal.aborted) fire();
				else opts.signal.addEventListener("abort", fire, { once: true });
			}
			await route.handler(req, res);
			if (status !== 200) return { status };
			return JSON.parse(text);
		},
		/** 只取 result（多数用例不关心信封外壳）。 */
		async result(channel, endpoint, payload, options) {
			const envelope = await stub.invoke(channel, endpoint, payload, options);
			return envelope.result;
		},
	};
	return stub;
}

/**
 * 伪 connection 服务：只提供真实服务面上本包会用的成员（`admit`），面外调用抛错。
 *
 * `invoke` 委托给 webServer 桩，让用例继续以「驱动一次 RPC」的写法表达意图。
 */
export function makeConnectionStub(webServer, { admitResult } = {}) {
	const calls = { admit: 0, rpcHandle: 0 };
	const stub = {
		calls,
		admit(request) {
			calls.admit += 1;
			return admitResult === undefined ? {} : admitResult;
		},
		invoke(channel, endpoint, payload, options) {
			if (webServer === undefined) throw new Error("connection 桩未绑定 webServer");
			return webServer.result(channel, endpoint, payload, options);
		},
		/** 取完整信封（少数用例要断言 rpcId 回显或非 200 状态）。 */
		envelope(channel, endpoint, payload, options) {
			if (webServer === undefined) throw new Error("connection 桩未绑定 webServer");
			return webServer.invoke(channel, endpoint, payload, options);
		},
		result(channel, endpoint, payload, options) {
			if (webServer === undefined) throw new Error("connection 桩未绑定 webServer");
			return webServer.result(channel, endpoint, payload, options);
		},
	};
	return new Proxy(stub, {
		get(obj, key) {
			if (key === "then") return undefined;
			if (typeof key === "symbol" || key in obj) return Reflect.get(obj, key);
			throw new Error(`调了 connection.${String(key)}：本包只用 admit + webServer 路由`);
		},
	});
}

/** 一条 llm 流脚本：chunks 数组（正常产出）｜ Error（流中抛）｜ "hang"（挂起等 abort）。 */
export function makeLlmStub() {
	const calls = [];
	const scripts = [];
	const stub = {
		calls,
		providers: [{ id: "deepseek-official", name: "DeepSeek" }],
		models: [{ provider: "deepseek-official", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
		/** 排队一段脚本；只有一段时每次调用都复用它。 */
		push(script) { scripts.push(script); return stub; },
		listProviders() { return stub.providers; },
		async listModels(provider) { return stub.models.filter((m) => m.provider === provider); },
		stream(options) {
			const script = scripts.length > 1 ? scripts.shift() : scripts[0];
			const record = { options, aborted: false, chunks: 0, settled: false };
			calls.push(record);
			return (async function* () {
				const signal = options?.signal;
				const onAbort = () => { record.aborted = true; };
				if (signal !== undefined && signal !== null) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				try {
					if (script instanceof Error) {
						record.settled = true;
						throw script;
					}
					if (script === "hang") {
						await new Promise((resolve) => {
							if (signal === undefined || signal === null) throw new Error('"hang" 脚本必须搭配 signal');
							if (signal.aborted) { resolve(); return; }
							signal.addEventListener("abort", resolve, { once: true });
						});
						record.aborted = true;
						record.settled = true;
						return;
					}
					for (const chunk of script ?? []) {
						if (signal?.aborted === true) { record.aborted = true; return; }
						record.chunks += 1;
						yield chunk;
					}
					record.settled = true;
				} finally {
					record.settled = true;
				}
			})();
		},
	};
	return stub;
}

/** 一条「正常完成」的文本流脚本：text-delta ×n → usage → finish(stop)。 */
export function textStream(text, usage) {
	return [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "text", text } },
		...(usage === undefined ? [] : [{ type: "usage", usage }]),
		{ type: "finish", reason: { kind: "stop" } },
	];
}

/**
 * 伪 host ctx。inject 只在全部服务到齐时回调（对齐 cordis 语义），缺席的服务
 * 让回调永不触发——这正是被测代码要能扛住的降级路径。
 *
 * `webServer` 默认在场（真实桩，能驱动路由）：通道挂载走它。传 `webServer: null`
 * 可模拟缺席——那时 inject 不触发，通道不注册。
 */
export function makeHostCtx({ connection, llm, webServer, loggerWarns } = {}) {
	const state = { effects: [], injectCalls: [] };
	const hasWebServer = webServer !== null;
	const server = webServer ?? makeWebServerStub();
	const ctx = {
		logger: {
			warn: (...args) => { loggerWarns?.push(args.join(" ")); },
			error: (...args) => { loggerWarns?.push(args.join(" ")); },
		},
		inject(names, cb) {
			state.injectCalls.push(names);
			// 真实 cordis 的 inject 子 ctx 也带 effect/on/get；缺了它们，
			// `pctx.effect(() => pctx.webServer.register(...))` 会抛，路由静默不注册。
			const pctx = {
				effect: (fn, label) => ctx.effect(fn, label),
				on: (name, handler) => ctx.on(name, handler),
				get: () => undefined,
			};
			for (const name of names) {
				if (name === "connection" && connection !== undefined) pctx.connection = connection;
				if (name === "llm" && llm !== undefined) pctx.llm = llm;
				if (name === "webServer" && hasWebServer) pctx.webServer = server;
			}
			const ready = names.every((name) => {
				if (name === "webServer") return hasWebServer;
				if (name === "connection") return connection !== undefined;
				if (name === "llm") return llm !== undefined;
				return false;
			});
			if (ready) cb(pctx);
		},
		on() { return () => {}; },
		effect(fn, label) {
			const disposer = fn();
			state.effects.push({ label, disposer });
			return () => {};
		},
	};
	return { ctx, state, webServer: server };
}
