import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("auth navigations bypass the worker even while proxy initialization is stalled", async () => {
	let onFetch;
	let onInstall;
	let onActivate;
	let onMessage;
	let configLoads = 0;
	let skippedWaiting = 0;
	let claimedClients = 0;
	const source = await readFile(
		new URL("../public/sw.js", import.meta.url),
		"utf8"
	);
	runInNewContext(source, {
		URL,
		importScripts() {},
		$scramjetLoadWorker: () => ({
			ScramjetServiceWorker: class {
				loadConfig() {
					configLoads++;
					return new Promise(() => {});
				}
			},
		}),
		self: {
			location: { origin: "https://proxy.test" },
			addEventListener(type, listener) {
				if (type === "fetch") onFetch = listener;
				if (type === "install") onInstall = listener;
				if (type === "activate") onActivate = listener;
				if (type === "message") onMessage = listener;
			},
			skipWaiting() {
				skippedWaiting++;
			},
			clients: {
				claim() {
					claimedClients++;
				},
			},
		},
	});
	let installPromise;
	onInstall({
		waitUntil(promise) {
			installPromise = promise;
		},
	});
	await installPromise;
	let activatePromise;
	onActivate({
		waitUntil(promise) {
			activatePromise = promise;
		},
	});
	await activatePromise;
	assert.equal(skippedWaiting, 1);
	assert.equal(claimedClients, 1);
	for (const [path, method] of [
		["/auth/logout", "POST"],
		["/auth/login", "GET"],
		["/auth/login", "POST"],
	]) {
		onFetch({
			request: { url: `https://proxy.test${path}`, method },
			respondWith() {
				assert.fail(
					"Authentication must use the browser's native network navigation"
				);
			},
		});
	}
	assert.equal(configLoads, 0);
	onMessage({ data: { type: "scramjet-app:ready" } });
	let intercepted = false;
	onFetch({
		request: { url: "https://proxy.test/scramjet/https://example.com" },
		respondWith() {
			intercepted = true;
		},
	});
	assert.equal(intercepted, true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(configLoads, 1);
});

test("proxied fetches wait for a controller page to announce BareMux readiness", async () => {
	const listeners = {};
	let readyRequests = 0;
	let proxyFetches = 0;
	let workerConstructions = 0;
	const source = await readFile(
		new URL("../public/sw.js", import.meta.url),
		"utf8"
	);
	runInNewContext(source, {
		URL,
		setTimeout,
		clearTimeout,
		importScripts() {},
		$scramjetLoadWorker: () => ({
			ScramjetServiceWorker: class {
				constructor() {
					workerConstructions++;
				}
				async loadConfig() {}
				route() {
					return true;
				}
				async fetch() {
					proxyFetches++;
					return "proxied response";
				}
			},
		}),
		self: {
			location: { origin: "https://proxy.test" },
			addEventListener(type, listener) {
				listeners[type] = listener;
			},
			clients: {
				async matchAll() {
					return [
						{
							postMessage(message) {
								assert.equal(
									message.type,
									"scramjet-app:request-ready"
								);
								readyRequests++;
							},
						},
					];
				},
			},
		},
	});

	let responsePromise;
	listeners.fetch({
		request: { url: "https://proxy.test/scramjet/https://example.com" },
		respondWith(promise) {
			responsePromise = promise;
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(readyRequests, 1);
	assert.equal(workerConstructions, 0);
	assert.equal(proxyFetches, 0);

	listeners.message({ data: { type: "scramjet-app:ready" } });
	assert.equal(await responsePromise, "proxied response");
	assert.equal(workerConstructions, 1);
	assert.equal(proxyFetches, 1);
});
