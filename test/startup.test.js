import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("controller eagerly starts in order and announces transport readiness", async () => {
	const calls = [];
	let onSubmit;
	let onWorkerMessage;
	const elements = {
		"sj-form": {
			addEventListener(type, listener) {
				if (type === "submit") onSubmit = listener;
			},
		},
		"sj-address": { value: "example.com" },
		"sj-search-engine": { value: "https://search.test/?q=%s" },
		"sj-error": {},
		"sj-error-code": {},
	};
	const source = await readFile(
		new URL("../public/index.js", import.meta.url),
		"utf8"
	);
	runInNewContext(source, {
		location: { protocol: "https:", host: "proxy.test" },
		navigator: {
			serviceWorker: {
				controller: {
					postMessage(message) {
						calls.push(`postMessage:${message.type}`);
					},
				},
				addEventListener(type, listener) {
					if (type === "message") onWorkerMessage = listener;
				},
			},
		},
		document: {
			getElementById(id) {
				return elements[id];
			},
			body: {
				appendChild() {
					calls.push("append");
				},
			},
		},
		$scramjetLoadController: () => ({
			ScramjetController: class {
				async init() {
					calls.push("scramjet.init");
				}
				createFrame() {
					calls.push("createFrame");
					return {
						frame: {},
						go() {
							calls.push("go");
						},
					};
				}
			},
		}),
		BareMux: {
			BareMuxConnection: class {
				async setTransport(path) {
					calls.push(`setTransport:${path}`);
				}
			},
		},
		async registerSW() {
			calls.push("registerSW");
		},
		search() {
			return "https://example.com/";
		},
	});

	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls, [
		"setTransport:/libcurl-reliable.mjs",
		"registerSW",
		"scramjet.init",
		"postMessage:scramjet-app:ready",
	]);
	calls.length = 0;
	await onSubmit({ preventDefault() {} });
	assert.deepEqual(calls, [
		"postMessage:scramjet-app:ready",
		"createFrame",
		"append",
		"go",
	]);

	calls.length = 0;
	onWorkerMessage({ data: { type: "scramjet-app:request-ready" } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls, ["postMessage:scramjet-app:ready"]);
});

test("libcurl wrapper retries only its transient first-load WASM race", async () => {
	let attempts = 0;
	let failure = "transient";
	class MockLibcurlTransport {
		async init() {
			attempts++;
			if (failure === "permanent") throw new Error("permanent failure");
			if (attempts < 3) throw new Error("wasm not loaded yet, please wait");
			return "ready";
		}
	}
	let source = await readFile(
		new URL("../public/libcurl-reliable.mjs", import.meta.url),
		"utf8"
	);
	source = source
		.replace(
			'import LibcurlTransport from "/libcurl/index.mjs";',
			"const LibcurlTransport = MockLibcurlTransport;"
		)
		.replace(
			"export default class ReliableLibcurlTransport",
			"globalThis.ReliableLibcurlTransport = class ReliableLibcurlTransport"
		);
	const context = { MockLibcurlTransport, setTimeout };
	runInNewContext(source, context);
	assert.equal(await new context.ReliableLibcurlTransport().init(), "ready");
	assert.equal(attempts, 3);

	failure = "permanent";
	await assert.rejects(
		new context.ReliableLibcurlTransport().init(),
		/permanent failure/
	);
});

test("service worker registration waits until the worker controls the page", async () => {
	let resolveReady;
	let onControllerChange;
	const serviceWorker = {
		controller: null,
		ready: new Promise((resolve) => {
			resolveReady = resolve;
		}),
		async register() {
			return { scope: "/" };
		},
		addEventListener(type, listener) {
			if (type === "controllerchange") onControllerChange = listener;
		},
		removeEventListener() {},
	};
	const source = await readFile(
		new URL("../public/register-sw.js", import.meta.url),
		"utf8"
	);
	const context = {
		navigator: { serviceWorker },
		location: { protocol: "https:", hostname: "proxy.test" },
		setTimeout,
		clearTimeout,
		Error,
	};
	runInNewContext(source, context);
	const registrationPromise = context.registerSW();
	resolveReady();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(typeof onControllerChange, "function");
	serviceWorker.controller = {};
	onControllerChange();
	assert.deepEqual(await registrationPromise, { scope: "/" });
});
