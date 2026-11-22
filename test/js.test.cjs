"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { build, dev, start, Webroot } = require("astralhp");
const { AstralHPServer } = require("../dist/live-server.js");
const { ES3Scripts } = require("../dist/es3.js");
const { AssetBundles } = require("../dist/bundles.js");
const { EventEmitter } = require("node:events");

const plainJS = 'import { message } from "./dependency.js"; globalThis.modernMessage = message;';

function fixture(t, options = {}) {
	const root = fs.mkdtempSync(path.resolve(__dirname, "../.astralhp-test-js-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "scripts"));
	fs.writeFileSync(path.join(root, "scripts/dependency.js"), 'export const message = "dependency-one";');
	fs.writeFileSync(path.join(root, "scripts/lazy.ts"), 'export const lazy: string = "lazy-one";');
	fs.writeFileSync(path.join(root, "scripts/style.css"), "body { color: rgb(10, 20, 30); }");
	fs.writeFileSync(
		path.join(root, "scripts/app.ts"),
		`
import { message } from "./dependency.js";
import { encode } from "@jridgewell/sourcemap-codec";
import "./style.css";
export const encoded = encode([[[0, 0, 0, 0]]]);
export async function answer(input?: { value?: string }) {
  const values = new Set([input?.value ?? message]);
  for (const value of values) return await Promise.resolve(value);
}
export const load = () => import("./lazy.ts");
`,
	);
	fs.writeFileSync(path.join(root, "scripts/plain.js"), plainJS);
	fs.writeFileSync(path.join(root, "scripts/unused.ts"), "not valid TypeScript !!!");
	fs.mkdirSync(path.join(root, ".components"));
	fs.writeFileSync(
		path.join(root, ".components/Assets.astro"),
		`---
import { JS as Script } from "astralhp/components";
---
<Script src="../scripts/app.ts" data-test="bundled" />`,
	);
	fs.writeFileSync(
		path.join(root, "index.astro"),
		`---
import Assets from "./.components/Assets.astro";
import * as Scripts from "astralhp/components";
export const prerender = true;
---
<Assets /><Scripts.JS src="/scripts/plain.js" />`,
	);
	fs.writeFileSync(
		path.join(root, "live.astro"),
		`---
import Assets from "./.components/Assets.astro";
export const prerender = false;
---
<Assets />`,
	);
	return new Webroot({ webroot: root, adapter: "apache-proxy", ...options });
}

function bundleURL(html, name = "app") {
	const match = html.match(new RegExp(`src="(/scripts/${name}\\.min\\.js\\?v=[a-f0-9]+)"`));
	assert(match, html);
	return match[1];
}

test("JS bundles use stable paths, include dependencies and CSS, and render on static and dynamic pages", async t => {
	const site = fixture(t);
	await build(site);
	const html = fs.readFileSync(path.join(site.dist, "index.html"), "utf8");
	const url = bundleURL(html);
	assert.match(html, /type="module"/);
	assert.match(html, /data-test="bundled"/);
	const css = html.match(/href="(\/scripts\/_assets\/[^"]+\.css)"/);
	assert(css, html);
	assert(fs.existsSync(path.join(site.dist, css[1])));
	assert(!fs.existsSync(path.join(site.dist, "scripts/unused.min.js")));
	const source = fs.readFileSync(path.join(site.dist, "scripts/app.min.js"), "utf8");
	assert.match(source, /sourceMappingURL=app\.min\.js\.map/);
	const map = JSON.parse(fs.readFileSync(path.join(site.dist, "scripts/app.min.js.map"), "utf8"));
	assert(map.sources.some(filename => path.basename(filename) === "app.ts"));
	assert.match(source, /dependency-one/);
	assert.match(source, /_chunks\/lazy-/);
	assert.doesNotMatch(source, /input\?:|\.\?|\?\./);
	const module = await import(pathToFileURL(path.join(site.dist, "scripts/app.min.js")).href);
	assert.equal(await module.answer(), "dependency-one");
	assert.equal(module.encoded, "AAAA");
	assert.equal((await module.load()).lazy, "lazy-one");
	assert.equal(await module.answer({ value: "custom" }), "custom");
	const htaccess = fs.readFileSync(path.join(site.config.webroot, ".htaccess"), "utf8");
	assert(htaccess.indexOf("# Serve built files") < htaccess.indexOf("# Serve all other files"));
	const server = new AstralHPServer([site], { port: 0 });
	await server.listen();
	try {
		const base = `http://127.0.0.1:${server.server.address().port}`;
		assert.equal(bundleURL(await (await fetch(`${base}/live`)).text()), url);
		assert.equal(await (await fetch(`${base}/scripts/plain.js`)).text(), plainJS);
		const response = await fetch(`${base}${bundleURL(html, "plain")}`);
		assert.equal(response.status, 200);
		assert.doesNotMatch(await response.text(), /from ["']\.\/dependency.js/);
	} finally {
		await server.close();
	}

	// The entry name stays stable; editing a dependency, including a lazy
	// dependency, changes the rendered cache-busting URL.
	await build(site);
	assert.equal(bundleURL(fs.readFileSync(path.join(site.dist, "index.html"), "utf8")), url);
	fs.writeFileSync(path.join(site.config.webroot, "scripts/dependency.js"), 'export const message = "dependency-two";');
	await build(site);
	const updated = bundleURL(fs.readFileSync(path.join(site.dist, "index.html"), "utf8"));
	assert.notEqual(updated, url);
	fs.writeFileSync(path.join(site.config.webroot, "scripts/lazy.ts"), 'export const lazy: string = "lazy-two";');
	await build(site);
	assert.notEqual(bundleURL(fs.readFileSync(path.join(site.dist, "index.html"), "utf8")), updated);
});

test("serveSourceFiles can hide sources and maps while serving bundles, chunks, and minified files", async t => {
	const site = fixture(t, { serveSourceFiles: false });
	fs.writeFileSync(path.join(site.config.webroot, "rules.md"), "# Rules");
	for (const file of ["vendor.min.js", "theme.scss", "view.tsx", "vendor.min.js.map"]) {
		fs.writeFileSync(path.join(site.config.webroot, file), "fixture");
	}
	fs.writeFileSync(
		path.join(site.config.webroot, "version.js.astro.js"), 'export const GET = () => new Response("v1");',
	);
	await build(site);
	const chunk = fs.readdirSync(path.join(site.dist, "scripts/_chunks")).find(file => file.endsWith(".js"));
	assert(chunk);
	const rules = fs.readFileSync(path.join(site.config.webroot, ".htaccess"), "utf8");
	const mapRule = rules.split("\n").findIndex(line => {
		const pattern = line.match(/^RewriteRule "([^"]+)" "-" \[R=404,END,NC\]$/)?.[1];
		return pattern && new RegExp(pattern, "i").test("app.js.map");
	});
	const distRule = rules.split("\n").findIndex(line => line.includes('".caches/dist/$1" [END]'));
	const jsRule = rules.split("\n").findIndex(line => line.startsWith("RewriteRule") && line.includes("(?<!"));
	assert(mapRule >= 0 && mapRule < distRule && distRule < jsRule);

	const reservation = net.createServer();
	await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	for (const launch of [dev, start]) {
		const worker = await launch(site, { port });
		try {
			const get = pathname => fetch(`http://localhost:${port}/${pathname}`);
			const html = await (await get("")).text();
			assert.match(await (await get(bundleURL(html).slice(1))).text(), /dependency-one/);
			assert.match(await (await get("scripts/_chunks/" + chunk)).text(), /lazy-one/);
			assert.equal(await (await get("vendor.min.js")).text(), "fixture");
			assert.equal(await (await get("version.js")).text(), "v1");
			assert.match(await (await get("rules")).text(), /<h1[^>]*>Rules<\/h1>/);
			for (const file of [
				"scripts/app.ts", "view.tsx", "scripts/plain.js?v=1", "theme.scss",
				"rules.md", "vendor.min.js.map", "scripts/app.min.js.map", "scripts/_chunks/" + chunk + ".map",
			]) {
				assert([403, 404].includes((await get(file)).status), file);
			}
		} finally {
			await worker.close();
		}
	}
});

test("JS rejects computed sources and conflicting ES3 output paths", async t => {
	const site = fixture(t);
	fs.rmSync(path.join(site.config.webroot, "live.astro"));
	fs.writeFileSync(
		path.join(site.config.webroot, "index.astro"),
		`---
import { JS } from "astralhp/components";
const src = "/scripts/app.ts";
---
<JS src={src} />`,
	);
	await assert.rejects(build(site), /requires a literal src/);
	fs.writeFileSync(path.join(site.config.webroot, "scripts/app.min.ts"), "console.log(1);");
	fs.writeFileSync(
		path.join(site.config.webroot, "index.astro"),
		`---
import { JS, ES3 } from "astralhp/components";
---
<JS src="/scripts/app.ts" /><ES3 src="/scripts/app.min.ts" />`,
	);
	await assert.rejects(build(site), /JS and ES3 both produce/);
});

test("JS inline embeds the bundle and imported CSS while preserving lazy imports and script text", async t => {
	const site = fixture(t);
	fs.appendFileSync(
		path.join(site.config.webroot, "scripts/app.ts"),
		`
export const text = "</ScRiPt><script>bad()</script><!--<script>";
export const location = import.meta.url;
`,
	);
	fs.writeFileSync(
		path.join(site.config.webroot, ".components/Assets.astro"),
		`---
import { JS } from "astralhp/components";
const inline = !Astro.url.searchParams.has("external");
---
<JS src="../scripts/app.ts" inline={inline} nonce="test-nonce" data-test="inline" />`,
	);
	fs.mkdirSync(path.join(site.config.webroot, "nested"));
	fs.writeFileSync(
		path.join(site.config.webroot, "nested/live.astro"),
		`---
import Assets from "../.components/Assets.astro";
export const prerender = false;
---
<Assets />`,
	);
	await build(site);
	const check = async html => {
		const script = html.match(/<script\b([^>]*)>([\s\S]*?)<\/script>/);
		assert(script, html);
		assert.match(script[1], /type="module"/);
		assert.match(script[1], /nonce="test-nonce"/);
		assert.doesNotMatch(script[1], /\bsrc=|\binline=/);
		assert.match(script[2], /dependency-one/);
		assert.match(script[2], /import\("\/scripts\/_chunks\/lazy-/);
		assert.doesNotMatch(script[2], /sourceMappingURL|<\/script|<!--/i);
		assert.match(html, /<style[^>]*>body\{/);
		assert.doesNotMatch(html, /<link\b/);
		globalThis.document = { baseURI: "https://example.test/nested/live" };
		try {
			const module = await import(`data:text/javascript;base64,${Buffer.from(script[2]).toString("base64")}`);
			assert.equal(await module.answer(), "dependency-one");
			assert.equal(module.text, "</ScRiPt><script>bad()</script><!--<script>");
			assert.equal(module.location, "https://example.test/scripts/app.min.js");
		} finally {
			delete globalThis.document;
		}
	};
	await check(fs.readFileSync(path.join(site.dist, "index.html"), "utf8"));
	fs.rmSync(path.join(site.config.webroot, "scripts"), { recursive: true });
	const server = new AstralHPServer([site], { port: 0 });
	await server.listen();
	try {
		const base = `http://127.0.0.1:${server.server.address().port}`;
		const html = await (await fetch(`${base}/nested/live`)).text();
		await check(html);
		assert.equal((html.match(/<script\b/g) ?? []).length, 1);
		const lazyURL = html.match(/import\("([^"]+_chunks\/lazy-[^"]+)"/)[1];
		const lazy = await fetch(base + lazyURL);
		assert.equal(lazy.status, 200);
		assert.match(await lazy.text(), /lazy-one/);
		const external = await (await fetch(`${base}/nested/live?external`)).text();
		assert.match(external, /<link\b/);
		assert(bundleURL(external));
		assert.doesNotMatch(external, /dependency-one/);
	} finally {
		await server.close();
	}
});

test("JS development serves sources and minified bundles and rebuilds imported dependencies", async t => {
	const site = fixture(t);
	fs.appendFileSync(
		path.join(site.config.webroot, ".components/Assets.astro"), '\n<Script src="../scripts/app.ts" inline />',
	);
	await build(site);
	const productionFile = path.join(site.dist, "scripts/app.min.js");
	const productionBundle = fs.readFileSync(productionFile);
	const devDist = path.join(site.caches, "dev-dist");
	fs.mkdirSync(devDist);
	fs.writeFileSync(path.join(devDist, "stale.js"), "from an earlier dev session");
	const reservation = net.createServer();
	await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const worker = await dev(site, { port });
	try {
		const base = `http://localhost:${port}`;
		const response = await fetch(`${base}/live`);
		assert.equal(response.status, 200);
		const initial = await response.text();
		assert.match(initial, /dependency-one/);
		const before = bundleURL(initial);
		const home = await (await fetch(base)).text();
		assert.match(await (await fetch(base + bundleURL(home, "plain"))).text(), /dependency-one/);
		assert.equal(await (await fetch(`${base}/scripts/plain.js`)).text(), plainJS);
		assert.match(await (await fetch(`${base}${before}`)).text(), /dependency-one/);
		fs.writeFileSync(path.join(site.config.webroot, "scripts/dependency.js"), 'export const message = "dev-updated";');
		let after = before;
		const deadline = Date.now() + 15000;
		while (after === before && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 100));
			after = bundleURL(await (await fetch(`${base}/live`)).text());
		}
		assert.notEqual(after, before);
		assert.match(await (await fetch(`${base}/live`)).text(), /dev-updated/);
		assert.match(await (await fetch(`${base}${after}`)).text(), /dev-updated/);
		assert.deepEqual(fs.readFileSync(productionFile), productionBundle);
		assert(!fs.existsSync(path.join(devDist, "scripts/unused.min.js")));
		assert(!fs.existsSync(path.join(devDist, "stale.js")));
	} finally {
		await worker.close();
	}
});

test("JS development recovers after an imported dependency has a syntax error", async t => {
	const site = fixture(t);
	const watcher = new EventEmitter();
	watcher.add = () => {};
	const messages = new EventEmitter();
	const plugin = new AssetBundles(site, new ES3Scripts(site)).plugin();
	plugin.configureServer({
		watcher,
		environments: {},
		ws: { send: message => messages.emit(message.type, message) },
		config: { logger: { error() {} } },
	});
	const filename = path.join(site.config.webroot, ".components/Assets.astro");
	await plugin.transform.handler(fs.readFileSync(filename, "utf8"), filename);
	const dependency = path.join(site.config.webroot, "scripts/dependency.js");
	const failed = new Promise(resolve => messages.once("error", resolve));
	fs.writeFileSync(dependency, "export const message = ;");
	watcher.emit("all", "change", dependency);
	await failed;
	const reloaded = new Promise(resolve => messages.once("full-reload", resolve));
	fs.writeFileSync(dependency, 'export const message = "repaired";');
	watcher.emit("all", "change", dependency);
	await reloaded;
	assert.match(fs.readFileSync(path.join(site.dist, "scripts/app.min.js"), "utf8"), /repaired/);
});
