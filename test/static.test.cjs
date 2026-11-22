"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { build, dev, start, Webroot } = require("astralhp");
const { apacheBlock, writeApacheConfig } = require("../dist/apache.js");
const { astralhpIntegration } = require("../dist/astro-integration.js");

function fixture(t) {
	const root = fs.mkdtempSync(path.resolve(__dirname, "../.astralhp-test-static-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return new Webroot({ webroot: root, port: 0 });
}

test("static Apache rules require neither a proxy port nor a CGI handler", t => {
	const site = fixture(t);
	const original = process.env.PORT;
	process.env.PORT = "invalid";
	t.after(() => original === undefined ? delete process.env.PORT : process.env.PORT = original);
	const block = apacheBlock(site.config);
	assert.doesNotMatch(block, /RewriteRule "\^\$"/);
	assert.match(block, /Serve built files/);
	assert.match(block, /Remove .html from URLs/);
	assert.doesNotMatch(block, /ProxyPass|ProxyPreserveHost|RequestHeader|ExecCGI|cgi-script|127\.0\.0\.1/);
	assert.equal(fs.readFileSync(writeApacheConfig(site), "utf8"), `${block}\n`);
	assert.throws(
		() => apacheBlock(site.config, [{ pattern: "/live", regex: "^live$" }]), /apache-static.*\/live/,
	);
});

test("apache-static builds default and parameterized static pages with compiled assets", async t => {
	const site = fixture(t);
	fs.writeFileSync(
		path.join(site.config.webroot, "index.astro"), `---
import { CSS, JS, ES3 } from "astralhp/components";
---
<h1>Static home</h1>
<CSS src="/style.scss" /><JS src="/app.ts" /><ES3 src="/legacy.ts" />`,
	);
	fs.writeFileSync(path.join(site.config.webroot, "app.ts"), 'console.log("modern");');
	fs.writeFileSync(path.join(site.config.webroot, "legacy.ts"), 'const legacy: string = "legacy";');
	fs.writeFileSync(path.join(site.config.webroot, "style.scss"), "$color: red; body { color: $color; }");
	fs.writeFileSync(
		path.join(site.config.webroot, "feed.xml.astro.ts"), 'export const GET = () => new Response("<feed/>");',
	);
	fs.writeFileSync(
		path.join(site.config.webroot, "[id].astro"), `---
export function getStaticPaths() { return [{ params: { id: "about" } }]; }
---
<p>{Astro.params.id}</p>`,
	);
	await build(site);
	const html = fs.readFileSync(path.join(site.dist, "index.html"), "utf8");
	assert.match(html, /Static home/);
	assert.equal(fs.readFileSync(path.join(site.dist, "feed.xml"), "utf8"), "<feed/>");
	for (const file of ["style.css", "app.min.js", "legacy.js"]) {
		assert(fs.statSync(path.join(site.dist, file)).isFile());
		assert(html.includes(`/${file}?v=`));
	}
	assert.match(fs.readFileSync(path.join(site.dist, "about.html"), "utf8"), /<p>about<\/p>/);
	assert.equal(fs.existsSync(path.join(site.dist, ".server")), false);
	const htaccess = fs.readFileSync(path.join(site.config.webroot, ".htaccess"), "utf8");
	assert.doesNotMatch(htaccess, /ProxyPreserveHost|ExecCGI|cgi-script/);
	await assert.rejects(start(site), /apache-static sites are served by Apache/);
	// A failed rebuild must retain the previous deployed site and Apache rules.
	fs.writeFileSync(path.join(site.config.webroot, "live.astro"), "---\nexport const prerender = false;\n---\nDynamic");
	await assert.rejects(build(site), /apache-static does not support dynamic routes:[\s\S]*live\.astro/);
	assert.equal(fs.readFileSync(path.join(site.dist, "index.html"), "utf8"), html);
	assert.equal(fs.readFileSync(path.join(site.config.webroot, ".htaccess"), "utf8"), htaccess);
});

test("apache-static also rejects injected dynamic endpoints", () => {
	const integration = astralhpIntegration([], { staticOnly: true });
	assert.doesNotThrow(() => integration.hooks["astro:routes:resolved"]({
		routes: [{
			type: "endpoint",
			origin: "internal",
			isPrerendered: false,
			entrypoint: "/_image",
		}],
	}));
	assert.throws(() => integration.hooks["astro:routes:resolved"]({
		routes: [{
			type: "endpoint",
			origin: "project",
			isPrerendered: false,
			entrypoint: "/injected/api.ts",
		}],
	}), /apache-static does not support dynamic routes:[\s\S]*api\.ts/);
});

test("apache-static prerenders a JSON endpoint at / and replaces it on rebuild", async t => {
	const site = fixture(t);
	const source = path.join(site.config.webroot, "index.astro.ts");
	fs.writeFileSync(
		source, `
export function GET({ request, url, routePattern }) {
	return Response.json([new URL(request.url).pathname, url.pathname, routePattern]);
}
`,
	);
	await build(site);
	const body = site.lookup("/").filename;
	assert.equal(path.relative(site.dist, body), "index");
	assert.deepEqual(JSON.parse(fs.readFileSync(body)), ["/index", "/index", "/"]);
	assert.ok(
		fs.readFileSync(path.join(site.config.webroot, ".htaccess"), "utf8").includes(
			'RewriteRule "^$" ".caches/dist/index"',
		),
	);

	fs.unlinkSync(source);
	fs.writeFileSync(path.join(site.config.webroot, "index.astro"), "<h1>Home</h1>");
	await build(site);
	assert.match(fs.readFileSync(site.lookup("/").filename, "utf8"), /<h1>Home<\/h1>/);
	assert.equal(fs.existsSync(body), false);
	const rules = fs.readFileSync(path.join(site.config.webroot, ".htaccess"), "utf8");
	assert.ok(rules.includes('RewriteRule "^$" ".caches/dist/index.html" [END]'));
	assert.ok(!rules.includes('RewriteRule "^$" ".caches/dist/index" [END]'));
});

test("Apache aliases a built index.json endpoint when there is no homepage", async t => {
	const site = fixture(t);
	const source = path.join(site.config.webroot, "index.json.astro.ts");
	const rules = () => fs.readFileSync(path.join(site.config.webroot, ".htaccess"), "utf8");
	fs.writeFileSync(source, "export const GET = () => Response.json({ ready: true });");
	await build(site);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(site.dist, "index.json"))), { ready: true });
	assert.ok(rules().includes('RewriteRule "^$" ".caches/dist/index.json" [END]'));

	const home = path.join(site.config.webroot, "index.astro");
	fs.writeFileSync(home, "<h1>Home</h1>");
	await build(site);
	assert.deepEqual(rules().match(/^RewriteRule "\^\$".*$/gm), ['RewriteRule "^$" ".caches/dist/index.html" [END]']);

	fs.unlinkSync(home);
	fs.writeFileSync(source, "export const GET = () => new Response(null, { status: 204 });");
	await build(site);
	assert.equal(fs.existsSync(path.join(site.dist, "index.json")), false);
	assert.doesNotMatch(rules(), /RewriteRule "\^\$"/);
});

test("Node serves the prerendered root endpoint as an extensionless static file", async t => {
	const site = new Webroot({ webroot: fixture(t).config.webroot, adapter: "node" });
	const source = path.join(site.config.webroot, "index.astro.js");
	fs.writeFileSync(
		source, `export const GET = () => new Response(new Uint8Array([0, 255, 128]), {
	headers: { "content-type": "application/vnd.astralhp.test" }
});`,
	);
	await build(site);
	fs.unlinkSync(source);
	const server = await start(site, { port: 0 });
	try {
		const response = await fetch(server.urls[0]);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "application/octet-stream");
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 255, 128]));
		const head = await fetch(server.urls[0], { method: "HEAD" });
		assert.equal(head.headers.get("content-type"), "application/octet-stream");
		assert.equal(head.headers.get("content-length"), "3");
		assert.equal(await head.text(), "");
	} finally {
		await server.close();
	}
});

test("dev serves the Vite client imports and Astro's injected component modules", async t => {
	const site = new Webroot({ webroot: fixture(t).config.webroot, serveSourceFiles: false });
	fs.mkdirSync(path.join(site.config.webroot, "node_modules"));
	fs.writeFileSync(path.join(site.config.webroot, "node_modules/unimported.js"), "");
	fs.writeFileSync(
		path.join(site.config.webroot, "index.astro"), `---
import { ClientRouter } from "astro:transitions";
---
<html><head><ClientRouter /></head><body>Dev</body></html>`,
	);
	const reservation = net.createServer();
	await new Promise(resolve => reservation.listen(0, "localhost", resolve));
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const worker = await dev(site, { port });
	t.after(() => worker.close());
	const base = `http://localhost:${port}`;
	const html = await (await fetch(base)).text();
	const scripts = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g), match => match[1].replaceAll("&amp;", "&"));
	assert(scripts.includes("/@vite/client"));
	assert(scripts.some(src => src.includes("ClientRouter.astro?astro&type=script")));
	assert(scripts.some(src => src.includes("ClientRouter.astro?astro&type=style")));
	const pending = new Set(scripts.map(src => new URL(src, base).href));
	for (const src of pending) {
		const response = await fetch(src);
		assert.equal(response.status, 200, src);
		assert.match(response.headers.get("content-type"), /javascript/, src);
		const code = await response.text();
		for (const [, dependency] of code.matchAll(/(?:\bimport\s*|\bfrom\s*)["']((?:\/|\.\.?\/)[^"']+)["']/g)) {
			pending.add(new URL(dependency, src).href);
		}
	}
	assert.equal((await fetch(base + "/node_modules/unimported.js")).status, 404);
});

test("apache-static supports local dev and rejects dynamic pages at startup", async t => {
	const site = fixture(t);
	fs.writeFileSync(path.join(site.config.webroot, "index.astro"), "Static development");
	const reservation = net.createServer();
	await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const worker = await dev(site, { port });
	try {
		const response = await fetch(`http://localhost:${port}/`);
		assert.equal(response.status, 200);
		assert.match(await response.text(), /Static development/);
	} finally {
		await worker.close();
	}
	fs.writeFileSync(path.join(site.config.webroot, "index.astro"), "---\nexport const prerender = false;\n---\nDynamic");
	await assert.rejects(dev(site, { port }), /apache-static does not support dynamic routes:[\s\S]*index\.astro/);
});
