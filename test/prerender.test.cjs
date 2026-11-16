"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { build, Webroot } = require("astralhp");
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
