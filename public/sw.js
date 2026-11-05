importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
let scramjet;
let proxyReady = false;
let resolveProxyReady;
const proxyReadyPromise = new Promise((resolve) => {
	resolveProxyReady = resolve;
});

function markProxyReady() {
	if (proxyReady) return;
	proxyReady = true;
	resolveProxyReady();
}

function getScramjet() {
	if (!scramjet) scramjet = new ScramjetServiceWorker();
	return scramjet;
}

function shouldRoute(request) {
	const url = new URL(request.url);
	return (
		url.origin === self.location.origin &&
		(url.pathname.startsWith("/scramjet/") ||
			url.pathname === "/scram/scramjet.wasm.wasm")
	);
}

async function waitForProxyReady() {
	if (proxyReady) return;

	const windows = await self.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	for (const client of windows) {
		client.postMessage({ type: "scramjet-app:request-ready" });
	}

	let timeout;
	try {
		await Promise.race([
			proxyReadyPromise,
			new Promise((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("Proxy controller did not become ready.")),
					15000
				);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

self.addEventListener("install", (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

async function handleRequest(event) {
	await waitForProxyReady();
	const worker = getScramjet();
	await worker.loadConfig();
	if (worker.route(event)) return worker.fetch(event);
	return fetch(event.request);
}

self.addEventListener("message", (event) => {
	if (event.data?.type === "scramjet-app:ready") markProxyReady();
});

self.addEventListener("fetch", (event) => {
	// Let authentication navigations reach the server directly, even when
	// proxy initialization is pending or the session has just been revoked.
	const url = new URL(event.request.url);
	if (url.origin === self.location.origin && url.pathname.startsWith("/auth/"))
		return;
	// Do not construct Scramjet/BareMux for ordinary application navigations.
	// A service worker cannot create a SharedWorker, so construction must wait
	// until the controller page has created one and announced readiness.
	if (!shouldRoute(event.request)) return;
	event.respondWith(handleRequest(event));
});
