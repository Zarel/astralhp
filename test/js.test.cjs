"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { build, dev, Webroot } = require("astrohp");
const { AstroHPServer } = require("../dist/live-server.js");
const { AssetBundles } = require("../dist/bundles.js");
const { EventEmitter } = require("node:events");

function fixture(t) {
	const root = fs.mkdtempSync(path.resolve(__dirname, "../.astrohp-test-js-"));
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
	fs.writeFileSync(
		path.join(root, "scripts/plain.js"),
		'import { message } from "./dependency.js"; globalThis.modernMessage = message;',
	);
	fs.writeFileSync(path.join(root, "scripts/unused.ts"), "not valid TypeScript !!!");
	fs.mkdirSync(path.join(root, ".components"));
	fs.writeFileSync(
		path.join(root, ".components/Assets.astro"),
		`---
import { JS as Script } from "astrohp/components";
---
<Script src="../scripts/app.ts" data-test="bundled" />`,
	);
	fs.writeFileSync(
		path.join(root, "index.astro"),
		`---
import Assets from "./.components/Assets.astro";
import * as Scripts from "astrohp/components";
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
	return new Webroot({ webroot: root, adapter: "apache-proxy" });
}

function bundleURL(html, name = "app") {
	const match = html.match(new RegExp(`src="(/scripts/${name}\\.js\\?v=[a-f0-9]+)"`));
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
	const css = html.match(/href="(\/scripts\/_assets\/[^\"]+\.css)"/);
	assert(css, html);
	assert(fs.existsSync(path.join(site.dist, css[1])));
	assert(!fs.existsSync(path.join(site.dist, "scripts/unused.js")));
	const source = fs.readFileSync(path.join(site.dist, "scripts/app.js"), "utf8");
	assert.match(source, /dependency-one/);
	assert.match(source, /_chunks\/lazy-/);
	assert.doesNotMatch(source, /input\?:|\.\?|\?\./);
	const module = await import(pathToFileURL(path.join(site.dist, "scripts/app.js")).href);
	assert.equal(await module.answer(), "dependency-one");
	assert.equal(module.encoded, "AAAA");
	assert.equal((await module.load()).lazy, "lazy-one");
	assert.equal(await module.answer({ value: "custom" }), "custom");
	const htaccess = fs.readFileSync(path.join(site.path, ".htaccess"), "utf8");
	assert(htaccess.indexOf("# Serve built files") < htaccess.indexOf("# Serve all other files"));
	const server = new AstroHPServer([site], { port: 0 });
	await server.listen();
	try {
		const base = `http://127.0.0.1:${server.server.address().port}`;
		assert.equal(bundleURL(await (await fetch(`${base}/live`)).text()), url);
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
	fs.writeFileSync(path.join(site.path, "scripts/dependency.js"), 'export const message = "dependency-two";');
	await build(site);
	const updated = bundleURL(fs.readFileSync(path.join(site.dist, "index.html"), "utf8"));
	assert.notEqual(updated, url);
	fs.writeFileSync(path.join(site.path, "scripts/lazy.ts"), 'export const lazy: string = "lazy-two";');
	await build(site);
	assert.notEqual(bundleURL(fs.readFileSync(path.join(site.dist, "index.html"), "utf8")), updated);
});

test("JS rejects computed sources and conflicting ES3 output paths", async t => {
	const site = fixture(t);
	fs.rmSync(path.join(site.path, "live.astro"));
	fs.writeFileSync(
		path.join(site.path, "index.astro"),
		`---
import { JS } from "astrohp/components";
const src = "/scripts/app.ts";
---
<JS src={src} />`,
	);
	await assert.rejects(build(site), /requires a literal src/);
	fs.writeFileSync(
		path.join(site.path, "index.astro"),
		`---
import { JS, ES3 } from "astrohp/components";
---
<JS src="/scripts/app.ts" /><ES3 src="/scripts/app.ts" />`,
	);
	await assert.rejects(build(site), /JS and ES3 both produce/);
});

test("JS development serves bundles at their original paths and rebuilds imported dependencies", async t => {
	const site = fixture(t);
	const reservation = net.createServer();
	await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const worker = await dev(site, { port });
	try {
		const base = `http://localhost:${port}`;
		const response = await fetch(`${base}/live`);
		assert.equal(response.status, 200);
		const before = bundleURL(await response.text());
		assert.match(await (await fetch(`${base}${before}`)).text(), /dependency-one/);
		fs.writeFileSync(path.join(site.path, "scripts/dependency.js"), 'export const message = "dev-updated";');
		let after = before;
		const deadline = Date.now() + 15000;
		while (after === before && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 100));
			after = bundleURL(await (await fetch(`${base}/live`)).text());
		}
		assert.notEqual(after, before);
		assert.match(await (await fetch(`${base}${after}`)).text(), /dev-updated/);
		assert(!fs.existsSync(path.join(site.dist, "scripts/unused.js")));
	} finally {
		await worker.close();
	}
});

test("JS development recovers after an imported dependency has a syntax error", async t => {
	const site = fixture(t);
	const watcher = new EventEmitter();
	watcher.add = () => {};
	const messages = new EventEmitter();
	const plugin = new AssetBundles(site).plugin(new Set());
	plugin.configureServer({
		watcher,
		environments: {},
		ws: { send: message => messages.emit(message.type, message) },
		config: { logger: { error() {} } },
	});
	const filename = path.join(site.path, ".components/Assets.astro");
	await plugin.transform.handler(fs.readFileSync(filename, "utf8"), filename);
	const dependency = path.join(site.path, "scripts/dependency.js");
	const failed = new Promise(resolve => messages.once("error", resolve));
	fs.writeFileSync(dependency, "export const message = ;");
	watcher.emit("all", "change", dependency);
	await failed;
	const reloaded = new Promise(resolve => messages.once("full-reload", resolve));
	fs.writeFileSync(dependency, 'export const message = "repaired";');
	watcher.emit("all", "change", dependency);
	await reloaded;
	assert.match(fs.readFileSync(path.join(site.dist, "scripts/app.js"), "utf8"), /repaired/);
});
