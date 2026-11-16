"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const test = require("node:test");
const { build, dev, Webroot } = require("astrohp");
const { assetReferences } = require("../dist/asset-references.js");
const { AstroHPServer } = require("../dist/live-server.js");

function scriptURL(site, name) {
	const hash = createHash("sha256").update(fs.readFileSync(path.join(site.dist, `scripts/${name}.js`)))
		.digest("hex").slice(0, 16);
	return `/scripts/${name}.js?v=${hash}`;
}

function fixture(t) {
	const root = fs.mkdtempSync(path.resolve(__dirname, "../.astrohp-test-es3-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "scripts"));
	fs.writeFileSync(path.join(root, "scripts/legacy.ts"), "const value: number = 1;");
	return new Webroot({ webroot: root, adapter: "node" });
}

test("collects imported ES3 tags, including aliases, namespaces, and conditional references", t => {
	const site = fixture(t);
	const source = `---
import { ES3 as Legacy } from "astrohp/components";
import * as Assets from "astrohp/components";
import ES3 from "./unrelated.astro";
---
😀<!-- <Legacy src="missing.ts" /> -->
<ES3 src={anything} />
{false && <Legacy src="../scripts/legacy.ts" defer />}
<Assets.ES3 src="/scripts/legacy.ts" />`;
	const result = assetReferences(site, path.join(site.path, "nested/page.astro"), source);
	assert.deepEqual(result.sources, [path.join(site.path, "scripts/legacy.ts")]);
	assert.match(result.code, /<Legacy src=\{"\/scripts\/legacy.ts"\} defer/);
	assert.match(result.code, /😀<!-- <Legacy src="missing.ts" \/> -->/);
	assert.match(result.code, /<ES3 src=\{anything\}/);
});

test("rejects dynamic, missing, external, and escaping ES3 sources", t => {
	const site = fixture(t);
	const filename = path.join(site.path, "index.astro");
	const check = tag => assetReferences(site, filename, `---\nimport { ES3 } from "astrohp/components";\n---\n${tag}`);
	for (const tag of ["<ES3 src={name} />", "<ES3 {...props} />", '<ES3 src="/scripts/legacy.ts" src="other.ts" />']) {
		assert.throws(() => check(tag), /requires a literal src/);
	}
	assert.throws(() => check('<ES3 src="/scripts/legacy.ts" {...props} />'), /spreads to appear before src/);
	assert.doesNotThrow(() => check('<ES3 {...props} src="/scripts/legacy.ts" />'));
	for (
		const src of [
			"https://example.test/script.js",
			"//example.test/script.js",
			"/scripts/legacy.ts?x",
			"/scripts/legacy.ts#x",
		]
	) {
		assert.throws(() => check(`<ES3 src="${src}" />`), /local path/);
	}
	assert.throws(() => check('<ES3 src="missing.ts" />'), /does not exist/);
	assert.throws(() => check('<ES3 src="../outside.ts" />'), /inside the webroot/);
});

test("builds only ES3 references from prerendered pages and dynamic shared components", async t => {
	const site = fixture(t);
	fs.mkdirSync(path.join(site.path, ".components"));
	fs.writeFileSync(path.join(site.path, "scripts/unused.ts"), "THIS IS NOT VALID TYPESCRIPT");
	fs.writeFileSync(path.join(site.path, "scripts/static.ts"), "const prerendered: number = 2;");
	fs.writeFileSync(path.join(site.path, "scripts/conditional.ts"), "const conditional: number = 3;");
	fs.writeFileSync(
		path.join(site.path, ".components/Shared.astro"),
		`---
import { ES3 } from "astrohp/components";
---
<ES3 src="../scripts/legacy.ts" defer data-test="shared" />`,
	);
	fs.writeFileSync(
		path.join(site.path, "index.astro"),
		`---
import Shared from "./.components/Shared.astro";
import { ES3 } from "astrohp/components";
export const prerender = false;
---
<Shared />
{Astro.url.searchParams.has("legacy") && <ES3 src="/scripts/conditional.ts" />}`,
	);
	fs.writeFileSync(
		path.join(site.path, "about.astro"),
		`---
import { ES3 } from "astrohp/components";
export const prerender = true;
---
<ES3 src="scripts/static.ts" />`,
	);
	await build(site);
	for (const name of ["legacy", "static", "conditional"]) {
		assert(fs.existsSync(path.join(site.dist, `scripts/${name}.js`)));
	}
	assert(!fs.existsSync(path.join(site.dist, "scripts/unused.js")));
	assert(!fs.existsSync(path.join(site.dist, "index.html")));
	assert.match(
		fs.readFileSync(path.join(site.dist, "about.html"), "utf8"), /src="\/scripts\/static.js\?v=[a-f0-9]{16}"/,
	);
	const originalURL = scriptURL(site, "static");
	assert(fs.readFileSync(path.join(site.dist, "about.html"), "utf8").includes(`src="${originalURL}"`));
	// Dynamic pages use the compiled hash without requiring the TypeScript source.
	fs.rmSync(path.join(site.path, "scripts/legacy.ts"));
	const server = new AstroHPServer([site], { port: 0 });
	await server.listen();
	try {
		const base = `http://127.0.0.1:${server.server.address().port}`;
		const response = await fetch(`${base}/?legacy=1`);
		assert.equal(response.status, 200);
		const html = await response.text();
		assert.match(html, /src="\/scripts\/legacy.js\?v=[a-f0-9]{16}"/);
		assert.match(html, /data-test="shared"/);
		assert.match(html, /src="\/scripts\/conditional.js\?v=[a-f0-9]{16}"/);
		for (const name of ["legacy", "conditional"]) assert(html.includes(`src="${scriptURL(site, name)}"`));
	} finally {
		await server.close();
	}
	// Rebuilding after removing a reference must not retain its old output.
	fs.writeFileSync(path.join(site.path, "index.astro"), "No legacy scripts");
	fs.writeFileSync(path.join(site.path, "scripts/static.ts"), "const prerendered: number | string = 2;");
	await build(site);
	assert(!fs.existsSync(path.join(site.dist, "scripts/legacy.js")));
	assert(!fs.existsSync(path.join(site.dist, "scripts/conditional.js")));
	assert(fs.existsSync(path.join(site.dist, "scripts/static.js")));
	assert.equal(scriptURL(site, "static"), originalURL);
	assert(fs.readFileSync(path.join(site.dist, "about.html"), "utf8").includes(`src="${originalURL}"`));
	fs.writeFileSync(path.join(site.path, "scripts/static.ts"), "const prerendered: number = 3;");
	await build(site);
	assert.notEqual(scriptURL(site, "static"), originalURL);
	assert(fs.readFileSync(path.join(site.dist, "about.html"), "utf8").includes(`src="${scriptURL(site, "static")}"`));
});

async function until(check) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.fail("Timed out waiting for development compilation");
}

test("development compiles and watches ES3 references without compiling unrelated TypeScript", async t => {
	const site = fixture(t);
	fs.writeFileSync(path.join(site.path, "unused.ts"), "THIS IS NOT VALID TYPESCRIPT");
	const page = path.join(site.path, "index.astro");
	fs.writeFileSync(page, `---\nimport { ES3 } from "astrohp/components";\n---\n<ES3 src="scripts/legacy.ts" />`);
	const reservation = net.createServer();
	await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const worker = await dev(site, { port });
	try {
		const base = `http://localhost:${port}`;
		const response = await fetch(base);
		assert.equal(response.status, 200);
		assert((await response.text()).includes(`src="${scriptURL(site, "legacy")}"`));
		const originalURL = scriptURL(site, "legacy");
		const output = path.join(site.dist, "scripts/legacy.js");
		assert.match(fs.readFileSync(output, "utf8"), /var value=1/);
		assert(!fs.existsSync(path.join(site.dist, "unused.js")));
		fs.writeFileSync(path.join(site.path, "scripts/legacy.ts"), "const value: number = 42;");
		await until(() => /var value=42/.test(fs.readFileSync(output, "utf8")));
		await until(async () => (await (await fetch(base)).text()).includes(`src="${scriptURL(site, "legacy")}"`));
		assert.notEqual(scriptURL(site, "legacy"), originalURL);
		assert.match(await (await fetch(`${base}/scripts/legacy.js`)).text(), /var value=42/);
		fs.writeFileSync(page, "No legacy scripts");
		await until(async () => (await (await fetch(base)).text()).includes("No legacy scripts") && !fs.existsSync(output));
	} finally {
		await worker.close();
	}
});
