"use strict";
const stockSW = "./sw.js";

/**
 * List of hostnames that are allowed to run serviceworkers on http://
 */
const swAllowedHostnames = ["localhost", "127.0.0.1"];

/**
 * Global util
 * Used in 404.html and index.html
 */
async function registerSW() {
	if (!navigator.serviceWorker) {
		if (
			location.protocol !== "https:" &&
			!swAllowedHostnames.includes(location.hostname)
		)
			throw new Error("Service workers cannot be registered without https.");

		throw new Error("Your browser doesn't support service workers.");
	}

	const registration = await navigator.serviceWorker.register(stockSW);
	await navigator.serviceWorker.ready;

	if (!navigator.serviceWorker.controller) {
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				navigator.serviceWorker.removeEventListener(
					"controllerchange",
					onControllerChange
				);
				reject(new Error("Service worker did not take control in time."));
			}, 10000);
			function onControllerChange() {
				clearTimeout(timeout);
				resolve();
			}
			navigator.serviceWorker.addEventListener(
				"controllerchange",
				onControllerChange,
				{ once: true }
			);
		});
	}

	return registration;
}
