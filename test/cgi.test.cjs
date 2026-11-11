"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { build, Webroot } = require("astrohp");
const { cgiRequest } = require("../dist/cgi.js");
const { apacheBlock } = require("../dist/apache.js");
const { AstroHPServer } = require("../dist/live-server.js");

const environment = {
	REQUEST_METHOD: "GET",
	REQUEST_URI: "/live?q=%E6%97%A5",
	QUERY_STRING: "q=%E6%97%A5",
	HTTP_HOST: "example.test:8443",
	HTTPS: "on",
	REMOTE_ADDR: "192.0.2.4",
};

test("CGI reconstructs the public URL and authoritative content headers", () => {
	const request = cgiRequest({
		...environment,
		HTTP_COOKIE: "session=test",
		HTTP_X_FORWARDED_HOST: "untrusted.test",
		HTTP_CONTENT_LENGTH: "123",
		CONTENT_LENGTH: "0",
		CONTENT_TYPE: "application/octet-stream",
	});
	assert.equal(request.url, "https://example.test:8443/live?q=%E6%97%A5");
	assert.equal(request.headers.get("cookie"), "session=test");
	assert.equal(request.headers.get("content-length"), "0");
	assert.equal(request.headers.get("content-type"), "application/octet-stream");
	assert.equal(
		cgiRequest({ ...environment, REQUEST_URI: "//other.test/path", QUERY_STRING: "" }).url,
		"https://example.test:8443//other.test/path",
	);
	assert.throws(() => cgiRequest({ ...environment, CONTENT_LENGTH: "-1" }), /CONTENT_LENGTH/);
	assert.throws(() => cgiRequest({ ...environment, CONTENT_LENGTH: "99999999999999999999" }), /CONTENT_LENGTH/);
	assert.throws(() => cgiRequest({ ...environment, HTTP_HOST: "example.test/invalid" }), /host/);
});

test("CGI reads exactly CONTENT_LENGTH bytes and preserves binary input", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-cgi-body-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const filename = path.join(root, "body");
	fs.writeFileSync(filename, Buffer.from([0, 255, 128, 13, 10, 42]));
	const input = fs.openSync(filename, "r");
	t.after(() => fs.closeSync(input));
	const request = cgiRequest({ ...environment, REQUEST_METHOD: "POST", CONTENT_LENGTH: "5" }, input);
	assert.deepEqual(Buffer.from(await request.arrayBuffer()), Buffer.from([0, 255, 128, 13, 10]));
	const truncated = cgiRequest({ ...environment, REQUEST_METHOD: "POST", CONTENT_LENGTH: "2" }, input);
	await assert.rejects(truncated.arrayBuffer(), /Incomplete CGI request body/);
});

test("CGI Apache rules preserve static routing without requiring proxy modules", () => {
	const block = apacheBlock(0, [{ pattern: "/live", regex: "^live/?$" }], "apache-cgi");
	assert.match(block, /Options \+ExecCGI/);
	assert.match(block, /SetHandler cgi-script/);
	assert.match(block, /"\.caches\/dist\/\.server\/astrohp\.mjs" \[END\]/);
	assert.doesNotMatch(block, /ProxyPreserveHost|RequestHeader|127\.0\.0\.1/);
	assert.doesNotMatch(apacheBlock(0, [], "apache-cgi"), /ExecCGI|cgi-script/);
	assert.throws(() => new Webroot({ webroot: "/tmp", runtimePath: "/bin/bun\ninvalid" }), /runtimePath/);
	assert.throws(() => new AstroHPServer([new Webroot({ webroot: "/tmp", adapter: "apache-cgi" })]), /run under Apache/);
});

for (const runtime of ["Node", "Bun"]) {
	test(`builds and executes the ${runtime} CGI application`, async t => {
		let runtimePath = process.execPath;
		if (runtime === "Bun") {
			const bun = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" });
			if (bun.error?.code === "ENOENT") {
				t.skip("Bun is not installed");
				return;
			}
			assert.equal(bun.status, 0, bun.stderr);
			runtimePath = bun.stdout;
		}
		const root = fs.mkdtempSync(path.resolve(__dirname, "../.astrohp-test-cgi-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		fs.writeFileSync(
			path.join(root, "astrohp.mts"),
			`export const config = ${JSON.stringify({ webroot: ".", adapter: "apache-cgi", runtimePath })};`,
		);
		const webroot = await Webroot.resolve(root);
		assert.equal(webroot.runtimePath, runtimePath);
		fs.writeFileSync(path.join(root, "index.astro"), '<p>{Astro.url.searchParams.get("message")}</p>');
		fs.writeFileSync(path.join(root, "about.astro"), "---\nexport const prerender = true;\n---\nStatic about");
		fs.writeFileSync(
			path.join(root, "live.astro"),
			`---
export const prerender = false;
console.log("CGI application log");
if (Astro.url.searchParams.has("proxy")) return new Response(String(process.env.HTTP_PROXY));
if (Astro.url.searchParams.has("redirect")) return Astro.redirect("/destination", 303);
if (Astro.url.searchParams.has("binary")) return new Response(new Uint8Array([0, 255, 128, 13, 10]));
if (Astro.url.searchParams.has("error")) throw new Error("private failure details");
Astro.cookies.set("first", "one");
Astro.cookies.set("second", "two");
Astro.response.headers.set("X-CGI-Test", "yes");
const body = Astro.request.method === "POST" ? (await Astro.request.formData()).get("message") : "";
---
<p>{Astro.url.href}</p><p>{Astro.clientAddress}</p><p>{body}</p>
`,
		);
		await build(webroot);
		const launcher = path.join(webroot.dist, ".server/astrohp.mjs");
		assert.equal(fs.statSync(launcher).mode & 0o777, 0o755);
		assert.equal(fs.readFileSync(launcher, "utf8").split("\n")[0], `#!${runtimePath}`);
		assert.match(fs.readFileSync(path.join(root, ".htaccess"), "utf8"), /SetHandler cgi-script/);
		assert.equal(fs.existsSync(path.join(webroot.dist, "index.html")), false);
		assert.match(fs.readFileSync(path.join(webroot.dist, "about.html"), "utf8"), /Static about/);
		assert.match(
			fs.readFileSync(path.join(root, ".htaccess"), "utf8"),
			/RewriteRule "\^\$" "\.caches\/dist\/\.server\/astrohp\.mjs" \[END\]/,
		);
		function request(overrides = {}, body = "") {
			const result = spawnSync(launcher, [], {
				cwd: os.tmpdir(),
				env: { ...process.env, ...environment, ...overrides },
				input: body,
				timeout: 10000,
			});
			assert.equal(result.status, 0, String(result.stderr || result.error));
			const end = result.stdout.indexOf("\r\n\r\n");
			assert(end > 0, String(result.stdout));
			return {
				headers: result.stdout.subarray(0, end).toString(),
				body: result.stdout.subarray(end + 4),
				stderr: String(result.stderr),
			};
		}
		for (const message of ["first", "second"]) {
			const home = request({ REQUEST_URI: "/", QUERY_STRING: `message=${message}` });
			assert.match(home.headers, /^Status: 200 OK/);
			assert.equal(String(home.body), `<!DOCTYPE html><p>${message}</p>`);
		}
		const get = request();
		assert.equal(String(request({ QUERY_STRING: "proxy=1", HTTP_PROXY: "http://untrusted.test" }).body), "undefined");
		assert.match(get.headers, /^Status: 200 OK/);
		assert.match(get.headers, /x-cgi-test: yes/);
		assert.equal((get.headers.match(/Set-Cookie:/g) || []).length, 2);
		assert.match(String(get.body), /https:\/\/example.test:8443\/live\?q=%E6%97%A5/);
		assert.match(String(get.body), /192\.0\.2\.4/);
		assert.doesNotMatch(String(get.body), /CGI application log/);
		assert.match(get.stderr, /CGI application log/);
		const body = new URLSearchParams({ message: "日本語 & <test>" }).toString();
		const post = request({
			REQUEST_METHOD: "POST",
			CONTENT_LENGTH: String(Buffer.byteLength(body)),
			CONTENT_TYPE: "application/x-www-form-urlencoded",
			HTTP_ORIGIN: "https://example.test:8443",
		}, body);
		assert.match(post.headers, /^Status: 200/);
		assert.match(String(post.body), /日本語 &amp; &lt;test&gt;/);
		assert.equal(request({ REQUEST_METHOD: "HEAD" }).body.length, 0);
		const redirect = request({ QUERY_STRING: "redirect=1" });
		assert.match(redirect.headers, /^Status: 303/);
		assert.match(redirect.headers, /location: \/destination/);
		assert.deepEqual(request({ QUERY_STRING: "binary=1" }).body, Buffer.from([0, 255, 128, 13, 10]));
		assert.match(request({ CONTENT_LENGTH: "bad" }).headers, /^Status: 400/);
		assert.match(request({ REQUEST_URI: "/missing", QUERY_STRING: "" }).headers, /^Status: 404/);
		const error = request({ QUERY_STRING: "error=1" });
		assert.match(error.headers, /^Status: 500/);
		assert.doesNotMatch(String(error.body), /private failure details/);
	});
}
