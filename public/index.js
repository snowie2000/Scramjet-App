"use strict";
/**
 * @type {HTMLFormElement}
 */
const form = document.getElementById("sj-form");
/**
 * @type {HTMLInputElement}
 */
const address = document.getElementById("sj-address");
/**
 * @type {HTMLInputElement}
 */
const searchEngine = document.getElementById("sj-search-engine");
/**
 * @type {HTMLParagraphElement}
 */
const error = document.getElementById("sj-error");
/**
 * @type {HTMLPreElement}
 */
const errorCode = document.getElementById("sj-error-code");

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
	files: {
		wasm: "/scram/scramjet.wasm.wasm",
		all: "/scram/scramjet.all.js",
		sync: "/scram/scramjet.sync.js",
	},
});

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
let startupPromise;

function startProxy() {
	if (!startupPromise) {
		startupPromise = (async () => {
			let wispUrl =
				(location.protocol === "https:" ? "wss" : "ws") +
				"://" +
				location.host +
				"/wisp/";

			// BareMux recommends selecting the transport before the service worker
			// becomes ready. The wrapper also waits out libcurl's first-load WASM
			// compilation race before allowing the first proxied request through.
			await connection.setTransport("/libcurl-reliable.mjs", [
				{ websocket: wispUrl },
			]);
			await registerSW();
			await scramjet.init();
		})().catch((err) => {
			startupPromise = undefined;
			throw err;
		});
	}

	return startupPromise;
}

function announceProxyReady() {
	const worker = navigator.serviceWorker.controller;
	if (!worker) throw new Error("No controlling service worker is available.");
	worker.postMessage({ type: "scramjet-app:ready" });
}

function showStartupError(err) {
	error.textContent = "Failed to initialize proxy.";
	errorCode.textContent = err.toString();
}

function startAndAnnounce() {
	return startProxy().then(() => announceProxyReady());
}

let activeFrame;

function urlFromAddressBar() {
	if (!location.hash.startsWith("#")) return null;
	try {
		return decodeURIComponent(location.hash.slice(1)) || null;
	} catch {
		return null;
	}
}

function addressBarUrl(url) {
	return `#${encodeURIComponent(url)}`;
}

function updateBrowserHistory(url, replace = false) {
	address.value = url;
	if (urlFromAddressBar() === url) return;
	const method = replace ? "replaceState" : "pushState";
	history[method]({ scramjetUrl: url }, "", addressBarUrl(url));
}

function getFrame() {
	if (activeFrame) return activeFrame;
	activeFrame = scramjet.createFrame();
	activeFrame.frame.id = "sj-frame";
	activeFrame.addEventListener("urlchange", (event) => {
		updateBrowserHistory(event.url.toString());
	});
	document.body.appendChild(activeFrame.frame);
	return activeFrame;
}

function closeFrame() {
	if (!activeFrame) return;
	activeFrame.frame.remove();
	activeFrame = undefined;
}

navigator.serviceWorker.addEventListener("message", (event) => {
	if (event.data?.type !== "scramjet-app:request-ready") return;
	startAndAnnounce().catch(showStartupError);
});

// Initialize as soon as the controller page loads. Scramjet's service worker
// cannot create a SharedWorker itself, so it must not receive a proxied request
// before this page has created and configured BareMux.
startAndAnnounce().catch(showStartupError);

window.addEventListener("popstate", (event) => {
	const url = event.state?.scramjetUrl || urlFromAddressBar();
	if (!url) {
		closeFrame();
		return;
	}
	startAndAnnounce()
		.then(() => getFrame().go(url))
		.catch(showStartupError);
});

const restoredUrl = urlFromAddressBar();
if (restoredUrl) {
	history.replaceState(
		{ scramjetUrl: restoredUrl },
		"",
		addressBarUrl(restoredUrl)
	);
	address.value = restoredUrl;
	startAndAnnounce()
		.then(() => getFrame().go(restoredUrl))
		.catch(showStartupError);
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();

	try {
		await startAndAnnounce();
	} catch (err) {
		showStartupError(err);
		throw err;
	}

	const url = search(address.value, searchEngine.value);
	updateBrowserHistory(url);
	getFrame().go(url);
});
