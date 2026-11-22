"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { build, start, Webroot } = require("astralhp");
const { validateConfig } = require("../dist/config-loader.js");

for (const adapter of ["node", "apache-proxy", "apache-cgi"]) {
	test(`${adapter} prerenders by default and respects config and page overrides`, async t => {
		const root = fs.mkdtempSync(path.resolve(__dirname, "../.astralhp-test-prerender-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		fs.writeFileSync(path.join(root, "index.astro"), "Default page");
		fs.writeFileSync(path.join(root, "static.astro"), "---\nexport const prerender = true;\n---\nAlways static");
		fs.writeFileSync(path.join(root, "dynamic.astro"), "---\nexport const prerender = false;\n---\nAlways dynamic");
		const site = new Webroot({ webroot: root, adapter });
		await build(site);
		assert.match(fs.readFileSync(path.join(site.dist, "index.html"), "utf8"), /Default page/);
		assert.match(fs.readFileSync(path.join(site.dist, "static.html"), "utf8"), /Always static/);
		assert.equal(fs.existsSync(path.join(site.dist, "dynamic.html")), false);
		if (adapter !== "node") {
			const rules = fs.readFileSync(path.join(root, ".htaccess"), "utf8");
			assert.match(rules, /RewriteRule "\^dynamic\/\?\$"/);
			assert.doesNotMatch(rules, /RewriteRule "\^static\/\?\$"/);
		}
		const dynamicDefault = new Webroot({ webroot: root, adapter, prerender: false });
		await build(dynamicDefault);
		assert.equal(fs.existsSync(path.join(site.dist, "index.html")), false);
		assert.match(fs.readFileSync(path.join(site.dist, "static.html"), "utf8"), /Always static/);
		assert.equal(fs.existsSync(path.join(site.dist, "dynamic.html")), false);
	});
}

test("apache-static honors a false default but requires every page to opt back into prerendering", async t => {
	const root = fs.mkdtempSync(path.resolve(__dirname, "../.astralhp-test-prerender-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const site = new Webroot({ webroot: root, adapter: "apache-static", prerender: false });
	fs.writeFileSync(path.join(root, "index.astro"), "Dynamic by config");
	await assert.rejects(build(site), /apache-static does not support dynamic routes:[\s\S]*index\.astro/);
	fs.writeFileSync(path.join(root, "index.astro"), "---\nexport const prerender = true;\n---\nExplicitly static");
	await build(site);
	assert.match(fs.readFileSync(path.join(site.dist, "index.html"), "utf8"), /Explicitly static/);
	assert.equal(fs.existsSync(path.join(site.dist, ".server")), false);
});

test("prerender config requires a boolean", () => {
	for (const prerender of [null, "false", 0, 1, {}, []]) {
		assert.throws(() => validateConfig({ prerender }, "config"), /prerender must be a boolean/);
	}
});

test("prerendered and relocated server modules read files beside their sources", async t => {
	const fixture = fs.mkdtempSync(path.resolve(__dirname, "../.astralhp-test-dirname-"));
	t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
	const project = path.join(fixture, "build");
	const webroot = path.join(project, "www");
	const shared = path.join(project, "shared");
	fs.mkdirSync(webroot, { recursive: true });
	fs.mkdirSync(shared);
	fs.writeFileSync(path.join(project, "package.json"), "{}");
	fs.writeFileSync(path.join(shared, "value.txt"), "shared");
	fs.writeFileSync(path.join(webroot, "value.txt"), "www");
	fs.writeFileSync(
		path.join(shared, "read.ts"), `
		import { readFileSync } from "node:fs";
		export const shared = () => readFileSync(import.meta.dirname + "/value.txt", "utf8");
		export const sharedFilename = import.meta.filename;
	`,
	);
	fs.writeFileSync(
		path.join(webroot, "index.astro"), `---
import { shared } from "../shared/read.ts";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
---
<p>{basename(import.meta.filename)} / {shared()} / {readFileSync(resolve(import.meta.filename, "../value.txt"), "utf8")}</p>
`,
	);
	fs.writeFileSync(
		path.join(webroot, "read.json.astro.ts"), `
		import { shared, sharedFilename } from "../shared/read.ts";
		import { readFileSync } from "node:fs";
		import { resolve } from "node:path";
		export const prerender = false;
		export const GET = () => Response.json([
			shared(), readFileSync(import.meta.dirname + "/value.txt", "utf8"), "import.meta.dirname",
			resolve(sharedFilename), resolve(import.meta.filename), "import.meta.filename",
		]);
	`,
	);
	const site = new Webroot({ webroot, adapter: "node" });
	await build(site);
	assert.match(fs.readFileSync(path.join(site.dist, "index.html"), "utf8"), /index\.astro \/ shared \/ www/);

	const deployed = path.join(fixture, "deployment");
	fs.renameSync(project, deployed);
	fs.writeFileSync(path.join(deployed, "shared/value.txt"), "deployed");
	const server = await start(
		new Webroot({ webroot: path.join(deployed, "www"), adapter: "node" }), { port: 0 }, fixture,
	);
	try {
		const response = await fetch(new URL("/read.json", server.urls[0]));
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), [
			"deployed", "www", "import.meta.dirname",
			path.join(deployed, "shared/read.ts"), path.join(deployed, "www/read.json.astro.ts"), "import.meta.filename",
		]);
	} finally {
		await server.close();
	}
});
