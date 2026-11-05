import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { loadEnvFile } from "node:process";

export function loadAuthEnvironment() {
	try {
		loadEnvFile();
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

export function createAuth({
	password,
	publicOrigin,
	secure = false,
	lifetime = 8 * 60 * 60 * 1000,
}) {
	let origin;
	if (publicOrigin) {
		const url = new URL(publicOrigin);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			throw new Error(
				"PUBLIC_ORIGIN must be an HTTP(S) origin without a path, credentials, query, or fragment."
			);
		origin = url.origin;
		if (url.protocol === "https:") secure = true;
	}
	const expectedOrigin = (req) =>
		origin || `${secure ? "https" : "http"}://${req.headers.host}`;
	if (!password || !password.trim())
		throw new Error(
			"Set PROXY_PASSWORD in the environment or .env before starting the server."
		);
	const digest = (value) => createHash("sha256").update(value).digest();
	const expected = digest(password);
	const sessions = new Map();
	const attempts = new Map();
	const cookieName = "scramjet_session";
	// Scramjet's service worker outlives an authentication session. When it is
	// revived, it must be able to reload these static runtime files before any
	// page can ask the user to sign in again. Protecting them with a redirect
	// causes the login HTML to be consumed as the rewriter WASM and leaves the
	// worker broken until all browser storage is cleared.
	function isPublicRuntimePath(path) {
		return (
			path === "/sw.js" ||
			path === "/libcurl-reliable.mjs" ||
			path.startsWith("/scram/") ||
			path.startsWith("/baremux/") ||
			path.startsWith("/libcurl/")
		);
	}
	function revoke(token) {
		const session = sessions.get(token);
		if (!session) return;
		clearTimeout(session.timer);
		for (const socket of session.sockets) socket.destroy();
		sessions.delete(token);
	}
	function token(req) {
		return (req.headers.cookie || "")
			.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith(`${cookieName}=`))
			?.slice(cookieName.length + 1);
	}
	function session(req) {
		const key = token(req);
		const found = sessions.get(key);
		if (found && found.expires > Date.now()) return found;
		revoke(key);
		return null;
	}
	function cookie(value, maxAge) {
		return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
	}
	function send(res, status, body, headers = {}) {
		res.writeHead(status, {
			"Cache-Control": "no-store",
			"Content-Type": "text/html; charset=utf-8",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy":
				"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
			...headers,
		});
		res.end(body);
	}
	function login(res, message = "", status = 200) {
		send(
			res,
			status,
			`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · Scramjet</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10121b;color:#eef0ff;font:16px system-ui}main{width:min(360px,80vw);padding:36px;background:#1a1e2e;border:1px solid #343b54;border-radius:20px}h1{margin-top:0}p{color:#b9c0d9}label,input,button{display:block;box-sizing:border-box;width:100%}input,button{padding:14px;margin-top:10px;border-radius:9px;border:1px solid #535d7b;font:inherit}input{background:#10121b;color:white}button{background:#abb9ff;color:#10121b;font-weight:700;cursor:pointer}.error{color:#ffb8b8}</style><main><h1>Scramjet</h1><p>Enter the service password to continue.</p><p class="error" role="alert">${message}</p><form method="post" action="/auth/login"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus maxlength="1024"><button>Sign in</button></form></main></html>`
		);
	}
	async function handle(req, res) {
		const path = new URL(req.url, "http://localhost").pathname;
		if (
			(req.method === "GET" || req.method === "HEAD") &&
			isPublicRuntimePath(path)
		) {
			res.setHeader("Cache-Control", "no-store");
			return false;
		}
		if (path === "/auth/login" && req.method === "GET") {
			login(res);
			return true;
		}
		if (
			(path === "/auth/login" || path === "/auth/logout") &&
			req.method === "POST"
		) {
			if (
				req.headers["sec-fetch-site"] === "cross-site" ||
				(req.headers.origin && req.headers.origin !== expectedOrigin(req))
			) {
				send(
					res,
					403,
					"Forbidden: request origin does not match this service. Configure PUBLIC_ORIGIN to match the browser address (scheme, hostname, and port)."
				);
				return true;
			}
			if (path === "/auth/logout") {
				revoke(token(req));
				send(res, 303, "", {
					Location: "/auth/login",
					"Set-Cookie": cookie("", 0),
				});
				return true;
			}
			const ip = req.socket.remoteAddress;
			const now = Date.now();
			for (const [key, value] of attempts)
				if (value.until <= now) attempts.delete(key);
			const attempt = attempts.get(ip) || {
				count: 0,
				until: now + 15 * 60 * 1000,
			};
			if (attempt.count >= 10 || attempts.size >= 10000) {
				send(res, 429, "Too many attempts. Try again in 15 minutes.", {
					"Retry-After": "900",
				});
				return true;
			}
			attempt.count++;
			attempts.set(ip, attempt);
			if (
				!req.headers["content-type"]?.startsWith(
					"application/x-www-form-urlencoded"
				)
			) {
				send(res, 415, "Unsupported form type");
				return true;
			}
			let body = "";
			for await (const chunk of req) {
				body += chunk.toString();
				if (Buffer.byteLength(body) > 8192) {
					send(res, 413, "Form too large");
					return true;
				}
			}
			const supplied = new URLSearchParams(body).get("password") || "";
			if (!timingSafeEqual(expected, digest(supplied))) {
				login(res, "Incorrect password.", 401);
				return true;
			}
			attempts.delete(ip);
			revoke(token(req));
			if (sessions.size >= 10000) {
				send(res, 503, "Session limit reached");
				return true;
			}
			const key = randomBytes(32).toString("hex");
			const timer = setTimeout(() => revoke(key), lifetime);
			timer.unref();
			sessions.set(key, {
				expires: Date.now() + lifetime,
				timer,
				sockets: new Set(),
			});
			send(res, 303, "", {
				Location: "/",
				"Set-Cookie": cookie(key, Math.floor(lifetime / 1000)),
			});
			return true;
		}
		if (!session(req)) {
			send(res, 303, "", { Location: "/auth/login" });
			return true;
		}
		res.setHeader("Cache-Control", "no-store");
		return false;
	}
	function upgrade(req, socket) {
		const current = session(req);
		// Browser WebSockets must originate from this application.
		if (!current || req.headers.origin !== expectedOrigin(req)) {
			socket.end(
				"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
			);
			return false;
		}
		current.sockets.add(socket);
		socket.once("close", () => current.sockets.delete(socket));
		return true;
	}
	return { handle, upgrade };
}
