import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("auth navigations bypass the worker even while proxy initialization is stalled", async () => {
	let onFetch;
	let onInstall;
	let onActivate;
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
	let intercepted = false;
	onFetch({
		request: { url: "https://proxy.test/scramjet/https://example.com" },
		respondWith() {
			intercepted = true;
		},
	});
	assert.equal(intercepted, true);
	assert.equal(configLoads, 1);
});
