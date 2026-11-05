importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

self.addEventListener("install", (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

async function handleRequest(event) {
	await scramjet.loadConfig();
	if (scramjet.route(event)) {
		return scramjet.fetch(event);
	}
	return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
	// Let authentication navigations reach the server directly, even when
	// proxy initialization is pending or the session has just been revoked.
	const url = new URL(event.request.url);
	if (url.origin === self.location.origin && url.pathname.startsWith("/auth/"))
		return;
	event.respondWith(handleRequest(event));
});
