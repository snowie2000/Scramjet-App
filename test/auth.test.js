import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { createAuth } from "../src/auth.js";

async function fixture(t, options = {}) {
	const auth = createAuth({ password: "test-secret", ...options });
	const server = createServer(async (req, res) => {
		if (!(await auth.handle(req, res))) res.end("protected");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const base = `http://127.0.0.1:${server.address().port}`;
	const request = (path, options = {}) =>
		fetch(base + path, { redirect: "manual", ...options });
	const login = (password = "test-secret") =>
		request("/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ password }),
		});
	return { auth, request, login, host: new URL(base).host, base };
}

test("missing password fails closed", () => {
	assert.throws(() => createAuth({}), /PROXY_PASSWORD/);
	assert.throws(() => createAuth({ password: "  " }), /PROXY_PASSWORD/);
});

test("all HTTP routes require a session; login, cookie flags, logout and WebSocket revocation", async (t) => {
	const { auth, request, login, host, base } = await fixture(t);
	for (const path of [
		"/",
		"/index.html",
		"/sw.js",
		"/scram/scramjet.all.js",
		"/libcurl/index.mjs",
		"/baremux/worker.js",
		"/wisp/",
		"/missing",
	]) {
		assert.equal((await request(path)).status, 303);
	}
	assert.equal((await request("/auth/login")).status, 200);
	assert.equal((await login("wrong")).status, 401);
	const response = await login();
	assert.equal(response.status, 303);
	const cookie = response.headers.get("set-cookie");
	assert.match(cookie, /HttpOnly; SameSite=Strict/);
	const headers = { cookie: cookie.split(";")[0] };
	assert.equal(
		await (await request("/scram/test", { headers })).text(),
		"protected"
	);
	assert.equal(
		(await request("/", { headers: { cookie: "scramjet_session=forged" } }))
			.status,
		303
	);
	const socket = new EventEmitter();
	socket.destroy = () => {
		socket.destroyed = true;
	};
	socket.end = (value) => {
		socket.rejection = value;
	};
	assert.equal(
		auth.upgrade(
			{ headers: { ...headers, host, origin: "https://attacker.invalid" } },
			socket
		),
		false
	);
	assert.match(socket.rejection, /401/);
	assert.equal(
		auth.upgrade({ headers: { host, origin: base } }, socket),
		false
	);
	assert.equal(
		auth.upgrade({ headers: { ...headers, host, origin: base } }, socket),
		true
	);
	assert.equal(
		(
			await request("/auth/logout", {
				method: "POST",
				headers: { ...headers, origin: "https://attacker.invalid" },
			})
		).status,
		403
	);
	const logout = await request("/auth/logout", { method: "POST", headers });
	assert.equal(logout.status, 303);
	assert.equal(logout.headers.get("location"), "/auth/login");
	assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
	// Clearing storage here can kill the worker delivering this redirect.
	assert.equal(logout.headers.get("clear-site-data"), null);
	assert.equal(socket.destroyed, true);
	assert.equal((await request("/", { headers })).status, 303);
});

test("rate limits guesses and rejects oversized forms", async (t) => {
	const { login, request } = await fixture(t);
	assert.equal(
		(
			await request("/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: "password=" + "x".repeat(9000),
			})
		).status,
		413
	);
	for (let i = 0; i < 9; i++) assert.equal((await login("wrong")).status, 401);
	assert.equal((await login()).status, 429);
});

test("secure cookies and expired sessions", async (t) => {
	const { request, login } = await fixture(t, { secure: true, lifetime: 40 });
	const response = await login();
	assert.match(response.headers.get("set-cookie"), /; Secure/);
	const cookie = response.headers.get("set-cookie").split(";")[0];
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal((await request("/", { headers: { cookie } })).status, 303);
});

test("public HTTPS origin supports rewritten proxy Host and secures cookies", async (t) => {
	const origin = "https://proxy.example.com:8443";
	const { auth, request, host } = await fixture(t, { publicOrigin: origin });
	const headers = {
		origin,
		"content-type": "application/x-www-form-urlencoded",
	};
	const wrong = await request("/auth/login", {
		method: "POST",
		headers,
		body: "password=wrong",
	});
	assert.equal(wrong.status, 401);
	const response = await request("/auth/login", {
		method: "POST",
		headers,
		body: "password=test-secret",
	});
	assert.equal(response.status, 303);
	assert.match(response.headers.get("set-cookie"), /; Secure/);
	const cookie = response.headers.get("set-cookie").split(";")[0];
	const socket = new EventEmitter();
	socket.destroy = () => {};
	socket.end = () => {};
	assert.equal(
		auth.upgrade({ headers: { origin, host, cookie } }, socket),
		true
	);
	for (const invalid of [
		"https://attacker.invalid",
		"http://proxy.example.com:8443",
		"https://proxy.example.com",
	]) {
		assert.equal(
			auth.upgrade({ headers: { origin: invalid, host, cookie } }, socket),
			false
		);
		assert.equal(
			(
				await request("/auth/logout", {
					method: "POST",
					headers: {
						origin: invalid,
						cookie,
						"x-forwarded-host": "proxy.example.com:8443",
						"x-forwarded-proto": "https",
					},
				})
			).status,
			403
		);
	}
	assert.equal(
		(
			await request("/auth/logout", {
				method: "POST",
				headers: { origin, cookie },
			})
		).status,
		303
	);
});
