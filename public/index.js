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

navigator.serviceWorker.addEventListener("message", (event) => {
	if (event.data?.type !== "scramjet-app:request-ready") return;
	startAndAnnounce().catch(showStartupError);
});

// Initialize as soon as the controller page loads. Scramjet's service worker
// cannot create a SharedWorker itself, so it must not receive a proxied request
// before this page has created and configured BareMux.
startAndAnnounce().catch(showStartupError);

form.addEventListener("submit", async (event) => {
	event.preventDefault();

	try {
		await startAndAnnounce();
	} catch (err) {
		showStartupError(err);
		throw err;
	}

	const url = search(address.value, searchEngine.value);
	const frame = scramjet.createFrame();
	frame.frame.id = "sj-frame";
	document.body.appendChild(frame.frame);
	frame.go(url);
});
