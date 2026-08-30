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
 * connection 服务桩：捕获 rpc.handle 的注册参数，并可事后驱动 handler。
 *
 * 复用宿主真实形态（rpc 子对象）而不是拍平，是为了让「实现写错调用路径」
 * 这类 bug 在测试里立刻暴露——写成 ctx.connection.handle 会直接 TypeError。
 */
export function makeConnectionStub() {
	const registrations = [];
	return {
		registrations,
		rpc: {
			handle(channel, handler, options) {
				registrations.push({ channel, handler, options });
				return () => Promise.resolve();
			},
		},
		/** 驱动第 index 个注册的 handler（默认唯一注册）。 */
		invoke(endpoint, payload, signal, index = 0) {
			const entry = registrations[index];
			if (entry === undefined) throw new Error(`connection 桩尚无第 ${index} 个注册`);
			return entry.handler(endpoint, payload, signal);
		},
	};
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
 */
export function makeHostCtx({ connection, llm, loggerWarns } = {}) {
	const state = { effects: [], injectCalls: [] };
	const ctx = {
		logger: { warn: (...args) => { loggerWarns?.push(args.join(" ")); } },
		inject(names, cb) {
			state.injectCalls.push(names);
			const pctx = {};
			for (const name of names) {
				if (name === "connection" && connection !== undefined) pctx.connection = connection;
				if (name === "llm" && llm !== undefined) pctx.llm = llm;
			}
			if (Object.keys(pctx).length === names.length) cb(pctx);
		},
		on() { return () => {}; },
		effect(fn, label) {
			const disposer = fn();
			state.effects.push({ label, disposer });
			return () => {};
		},
	};
	return { ctx, state };
}
