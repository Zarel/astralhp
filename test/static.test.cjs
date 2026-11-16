"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { build, dev, start, Webroot } = require("astrohp");
const { apacheBlock, writeApacheConfig } = require("../dist/apache.js");
const { astrohpIntegration } = require("../dist/webroot.js");

function fixture(t) {
	const root = fs.mkdtempSync(path.resolve(__dirname, "../.astrohp-test-static-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return new Webroot({ webroot: root, port: 0 });
}

test("static Apache rules require neither a proxy port nor a CGI handler", t => {
	const site = fixture(t);
	const original = process.env.PORT;
	process.env.PORT = "invalid";
	t.after(() => original === undefined ? delete process.env.PORT : process.env.PORT = original);
	const block = apacheBlock(undefined, [], "apache-static");
	assert.match(block, /Serve built files/);
	assert.match(block, /Remove .html from URLs/);
	assert.doesNotMatch(block, /ProxyPass|ProxyPreserveHost|RequestHeader|ExecCGI|cgi-script|127\.0\.0\.1/);
	assert.equal(fs.readFileSync(writeApacheConfig(site), "utf8"), `${block}\n`);
	assert.throws(
		() => apacheBlock(0, [{ pattern: "/live", regex: "^live$" }], "apache-static"), /apache-static.*\/live/,
	);
});

test("apache-static builds default and parameterized static pages with compiled assets", async t => {
	const site = fixture(t);
	fs.writeFileSync(
		path.join(site.path, "index.astro"), `---
import { CSS, JS, ES3 } from "astrohp/components";
---
<h1>Static home</h1>
<CSS src="/style.scss" /><JS src="/app.ts" /><ES3 src="/legacy.ts" />`,
	);
	fs.writeFileSync(path.join(site.path, "app.ts"), 'console.log("modern");');
	fs.writeFileSync(path.join(site.path, "legacy.ts"), 'const legacy: string = "legacy";');
	fs.writeFileSync(path.join(site.path, "style.scss"), "$color: red; body { color: $color; }");
	fs.writeFileSync(
		path.join(site.path, "[id].astro"), `---
export function getStaticPaths() { return [{ params: { id: "about" } }]; }
---
<p>{Astro.params.id}</p>`,
	);
	await build(site);
	const html = fs.readFileSync(path.join(site.dist, "index.html"), "utf8");
	assert.match(html, /Static home/);
	for (const file of ["style.css", "app.js", "legacy.js"]) {
		assert(fs.statSync(path.join(site.dist, file)).isFile());
		assert(html.includes(`/${file}?v=`));
	}
	assert.match(fs.readFileSync(path.join(site.dist, "about.html"), "utf8"), /<p>about<\/p>/);
	assert.equal(fs.existsSync(path.join(site.dist, ".server")), false);
	const htaccess = fs.readFileSync(path.join(site.path, ".htaccess"), "utf8");
	assert.doesNotMatch(htaccess, /ProxyPreserveHost|ExecCGI|cgi-script/);
	await assert.rejects(start(site), /apache-static sites are served by Apache/);
	// A failed rebuild must retain the previous deployed site and Apache rules.
	fs.writeFileSync(path.join(site.path, "live.astro"), "---\nexport const prerender = false;\n---\nDynamic");
	await assert.rejects(build(site), /apache-static does not support dynamic routes:[\s\S]*live\.astro/);
	assert.equal(fs.readFileSync(path.join(site.dist, "index.html"), "utf8"), html);
	assert.equal(fs.readFileSync(path.join(site.path, ".htaccess"), "utf8"), htaccess);
});

test("apache-static also rejects injected dynamic endpoints", () => {
	const integration = astrohpIntegration([], { staticOnly: true });
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

test("apache-static supports local dev and rejects dynamic pages at startup", async t => {
	const site = fixture(t);
	fs.writeFileSync(path.join(site.path, "index.astro"), "Static development");
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
	fs.writeFileSync(path.join(site.path, "index.astro"), "---\nexport const prerender = false;\n---\nDynamic");
	await assert.rejects(dev(site, { port }), /apache-static does not support dynamic routes:[\s\S]*index\.astro/);
});
