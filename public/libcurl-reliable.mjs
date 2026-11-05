import LibcurlTransport from "/libcurl/index.mjs";

const WASM_NOT_READY = "wasm not loaded yet";
const INIT_TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 25;

export default class ReliableLibcurlTransport extends LibcurlTransport {
	async init() {
		const deadline = Date.now() + INIT_TIMEOUT_MS;

		for (;;) {
			try {
				return await super.init();
			} catch (error) {
				const message = String(error?.message || error);
				if (!message.includes(WASM_NOT_READY) || Date.now() >= deadline) {
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
			}
		}
	}
}
