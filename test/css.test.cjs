"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { build, dev, Webroot } = require("astrohp");
const { assetReferences } = require("../dist/asset-references.js");
const { AstroHPServer } = require("../dist/live-server.js");

function fixture(t) {
	const project = fs.mkdtempSync(path.resolve(__dirname, "../.astrohp-test-css-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	const root = path.join(project, "www");
	fs.mkdirSync(root);
	const configFile = path.join(project, "astrohp.mts");
	fs.writeFileSync(configFile, 'export const config = { webroot: "www" };');
	for (const directory of ["styles", ".components", "nested", "images"]) fs.mkdirSync(path.join(root, directory));
	fs.writeFileSync(path.join(root, "styles/plain.css"), "/* keep this */ body { margin: 0; }\n");
	fs.writeFileSync(path.join(root, "styles/_tokens.scss"), "$color: #123456;");
	fs.writeFileSync(path.join(root, "styles/_theme.scss"), '@forward "tokens";');
	fs.writeFileSync(
		path.join(root, "styles/main.scss"),
		'@use "theme"; .panel { color: theme.$color; a { background: url("../images/icon.svg"); } }',
	);
	fs.writeFileSync(path.join(root, "styles/unused.scss"), "this is invalid SCSS {");
	fs.writeFileSync(path.join(root, "images/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
	fs.writeFileSync(
		path.join(root, ".components/Styles.astro"),
		`---
import { CSS as Style } from "astrohp/components";
import * as Assets from "astrohp/components";
---
<Style src="../styles/main.scss" media="screen" />
<Assets.CSS src="../styles/plain.css" />`,
	);
	fs.writeFileSync(
		path.join(root, "index.astro"),
		`---
import Styles from "./.components/Styles.astro";
export const prerender = true;
---
<Styles />`,
	);
	fs.writeFileSync(
		path.join(root, "nested/[id].astro"),
		`---
import Styles from "../.components/Styles.astro";
---
<Styles />`,
	);
	return new Webroot({ webroot: "www" }, configFile);
}

function stylesheetURL(html) {
	const match = html.match(/href="(\/styles\/main.css\?v=[a-f0-9]+)"/);
	assert(match, html);
	return match[1];
}

test("CSS validates literal local sources with the same path rules as JS", t => {
	const site = fixture(t);
	const filename = path.join(site.path, "nested/page.astro");
	const parse = tag =>
		assetReferences(site, filename, `---\nimport { CSS } from "astrohp/components";\n---\n${tag}`, "CSS");
	const relative = parse('<CSS src="../styles/plain.css" />');
	assert.match(relative.code, /src=\{"\/styles\/plain.css"\}/);
	assert.equal(parse('<CSS src="/styles/main.scss" />').assets[0].source, path.join(site.path, "styles/main.scss"));
	assert.throws(() => parse("<CSS src={filename} />"), /literal src/);
	assert.throws(() => parse('<CSS src="../../outside.css" />'), /inside the webroot/);
	assert.throws(() => parse('<CSS src="/missing.scss" />'), /does not exist/);
	assert.throws(() => parse('<CSS src="https://example.test/style.css" />'), /local path/);
	fs.symlinkSync(__filename, path.join(site.path, "styles/escape.css"));
	assert.throws(() => parse('<CSS src="/styles/escape.css" />'), /inside the webroot/);
});

test("CSS keeps plain files intact and compiles SCSS for prerendered and dynamic pages", async t => {
	const site = fixture(t);
	const plain = fs.readFileSync(path.join(site.path, "styles/plain.css"), "utf8");
	await build(site);
	let html = fs.readFileSync(path.join(site.dist, "index.html"), "utf8");
	const before = stylesheetURL(html);
	assert.match(html, /media="screen"/);
	assert.match(html, /href="\/styles\/plain.css\?v=[a-f0-9]{16}"/);
	assert(!fs.existsSync(path.join(site.dist, "styles/plain.css")));
	assert(!fs.existsSync(path.join(site.dist, "styles/unused.css")));
	const css = fs.readFileSync(path.join(site.dist, "styles/main.css"), "utf8");
	assert.match(css, /color:#123456/);
	assert.match(css, /\.panel a/);
	assert.match(css, /\.\.\/images\/icon.svg/);
	assert(fs.existsSync(path.join(site.dist, "styles/main.css.map")));
	// A source-only comment changes the map, but not the served stylesheet.
	fs.appendFileSync(path.join(site.path, "styles/_tokens.scss"), "\n// No output change\n");
	await build(site);
	assert.equal(stylesheetURL(fs.readFileSync(path.join(site.dist, "index.html"), "utf8")), before);
	fs.writeFileSync(path.join(site.path, "styles/_tokens.scss"), "$color: #654321;");
	await build(site);
	html = fs.readFileSync(path.join(site.dist, "index.html"), "utf8");
	assert.notEqual(stylesheetURL(html), before);
	fs.rmSync(path.join(site.path, "styles/main.scss"));
	const server = new AstroHPServer([site], { port: 0 });
	await server.listen();
	try {
		const base = `http://127.0.0.1:${server.server.address().port}`;
		const response = await fetch(`${base}/nested/anything`);
		assert.equal(response.status, 200);
		assert.equal(stylesheetURL(await response.text()), stylesheetURL(html));
		assert.match(await (await fetch(`${base}${stylesheetURL(html)}`)).text(), /color:#654321/);
		assert.equal(await (await fetch(`${base}/styles/plain.css`)).text(), plain);
	} finally {
		await server.close();
	}
});

test("CSS rejects two sources that would use the same compiled stylesheet URL", async t => {
	const site = fixture(t);
	fs.writeFileSync(path.join(site.path, "styles/main.css"), "body { color: red; }");
	fs.writeFileSync(
		path.join(site.path, "index.astro"),
		`---
import { CSS } from "astrohp/components";
---
<CSS src="/styles/main.css" /><CSS src="/styles/main.scss" />`,
	);
	await assert.rejects(build(site), /Asset output collision/);
});

test("CSS development rebuilds SCSS when a forwarded partial changes", async t => {
	const site = fixture(t);
	const reservation = net.createServer();
	await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const worker = await dev(site, { port });
	try {
		const base = `http://localhost:${port}`;
		const response = await fetch(`${base}/nested/test`);
		assert.equal(response.status, 200);
		const before = stylesheetURL(await response.text());
		assert(fs.statSync(path.join(site.astroCache, "types.d.ts")).isFile());
		assert(fs.statSync(site.viteCache).isDirectory());
		assert.equal(fs.existsSync(path.join(site.caches, ".astro")), false);
		assert.equal(fs.existsSync(path.join(site.caches, ".vite")), false);
		assert.match(await (await fetch(`${base}${before}`)).text(), /color:#123456/);
		fs.writeFileSync(path.join(site.path, "styles/_tokens.scss"), "$color: #654321;");
		let after = before;
		const deadline = Date.now() + 15000;
		while (after === before && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 100));
			after = stylesheetURL(await (await fetch(`${base}/nested/test`)).text());
		}
		assert.notEqual(after, before);
		assert.match(await (await fetch(`${base}${after}`)).text(), /color:#654321/);
	} finally {
		await worker.close();
	}
});
