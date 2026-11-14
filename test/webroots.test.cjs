"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { Webroot, dev, start } = require("astrohp");
const { validateConfig } = require("../dist/config-loader.js");

const cli = path.resolve(__dirname, "../astrohp");

function fixture(t, config) {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-webroots-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.writeFileSync(path.join(project, "astrohp.mts"), `export const config = ${JSON.stringify(config)};`);
	return project;
}

async function freePort() {
	const server = net.createServer();
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

test("expands paths and overrides, resolves selected webroots, and keeps stable isolated caches", async t => {
	const project = fixture(t, {
		adapter: "apache-proxy", port: 9001, runtimePath: process.execPath, prerender: false,
		webroots: ["first/www", { webroot: "second/www", adapter: "apache-cgi", port: 9002, prerender: true }],
	});
	for (const directory of ["first/www", "second/www"]) fs.mkdirSync(path.join(project, directory), { recursive: true });
	const sites = await Webroot.search(project);
	assert.equal(sites.length, 2);
	assert.deepEqual(sites.map(site => site.prerender), [false, true]);
	assert.deepEqual(sites.map(site => [site.path, site.adapter, site.port, site.runtimePath]), [
		[path.join(project, "first/www"), "apache-proxy", 9001, process.execPath],
		[path.join(project, "second/www"), "apache-cgi", 9002, process.execPath],
	]);
	assert.notEqual(sites[0].projectCaches, sites[1].projectCaches);
	for (const site of sites) {
		assert.equal(path.dirname(site.projectCaches), path.join(project, ".caches"));
		assert.equal(site.astroCache, path.join(site.projectCaches, ".astro"));
		assert.equal(site.viteCache, path.join(site.astroCache, "vite"));
		assert.equal(site.dist, path.join(site.path, ".caches/dist"));
		assert.deepEqual(await Webroot.resolve(site.path), site);
	}
	await assert.rejects(Webroot.requireOne(project), /Found multiple AstroHP webroots/);
	// A second config avoids module-import caching while using the same project directory.
	fs.rmSync(path.join(project, "astrohp.mts"));
	fs.writeFileSync(path.join(project, ".astrohp.mts"),
		'export const config = { webroots: ["./second/www", "first/../first/www", "third"] };');
	const reordered = await Webroot.search(project);
	assert.equal(reordered[0].projectCaches, sites[1].projectCaches);
	assert.equal(reordered[1].projectCaches, sites[0].projectCaches);
});

test("rejects malformed multi-webroot configurations", () => {
	for (const value of [null, "www", [], [""], [null], [42], [{}], [{ webroot: "" }]]) {
		assert.throws(() => validateConfig({ webroots: value }, "config"), /webroots/);
	}
	assert.throws(() => validateConfig({ webroot: "www", webroots: ["other"] }, "config"), /not both/);
	assert.throws(() => validateConfig({ webroots: [{ webroot: "www", webroots: ["other"] }] }, "config"), /nested/);
	for (const entry of [{ adapter: "unknown" }, { port: -1 }, { runtimePath: "bun" }, { prerender: "false" }, { typo: true }]) {
		assert.throws(() => validateConfig({ webroots: [{ webroot: "www", ...entry }] }, "config"));
	}
	assert.throws(() => new Webroot({ webroots: ["www"] }, "/tmp/astrohp.mts"), /represents one directory/);
});

test("rejects duplicate webroots within an array and across configs", async t => {
	const project = fixture(t, { webroots: ["www", "./www/"] });
	await assert.rejects(Webroot.search(project), /configured more than once/);
	fs.rmSync(path.join(project, "astrohp.mts"));
	fs.writeFileSync(path.join(project, ".astrohp.mts"), 'export const config = { webroots: ["www"] };');
	fs.mkdirSync(path.join(project, "www"));
	fs.writeFileSync(path.join(project, "www/astrohp.mts"), "export const config = {};");
	await assert.rejects(Webroot.search(project), /configured by both/);
});

test("CLI lists and builds array entries, then serves both through a shared proxy listener", async t => {
	const project = fixture(t, { adapter: "apache-proxy", webroots: ["first", { webroot: "second" }] });
	for (const name of ["first", "second"]) {
		fs.mkdirSync(path.join(project, name));
		fs.writeFileSync(path.join(project, name, "index.astro"), `---\nexport const prerender = true;\n---\n${name} static`);
		fs.writeFileSync(path.join(project, name, "live.astro"), `---\nexport const prerender = false;\n---\n${name} dynamic`);
	}
	const listed = spawnSync(process.execPath, [cli], { cwd: project, encoding: "utf8" });
	assert.equal(listed.status, 0, listed.stderr);
	assert.equal(listed.stdout.trim(), "AstroHP webroots:\n  first\n  second");
	const ambiguous = spawnSync(process.execPath, [cli, "dev"], { cwd: project, encoding: "utf8" });
	assert.equal(ambiguous.status, 1);
	assert.match(ambiguous.stderr, /Found multiple AstroHP webroots; specify one/);
	const built = spawnSync(process.execPath, [cli, "build"], { cwd: project, encoding: "utf8" });
	assert.equal(built.status, 0, built.stderr);
	const sites = await Webroot.search(project);
	for (const site of sites) {
		assert(fs.statSync(path.join(site.astroCache, "types.d.ts")).isFile());
		assert(fs.statSync(path.join(site.dist, ".server/app.mjs")).isFile());
		assert.match(fs.readFileSync(path.join(site.dist, "index.html"), "utf8"), new RegExp(`${path.basename(site.path)} static`));
	}
	assert.equal(fs.existsSync(path.join(project, ".caches/.astro")), false);
	const port = await freePort();
	const worker = await start(sites, { port, host: "127.0.0.1" });
	try {
		for (const site of sites) {
			const response = await fetch(`http://127.0.0.1:${port}/live`, { headers: { "X-AstroHP-Document-Root": site.path } });
			assert.equal(response.status, 200);
			assert.match(await response.text(), new RegExp(`${path.basename(site.path)} dynamic`));
		}
	} finally {
		await worker.close();
	}
});

test("selected webroots can run concurrent dev servers with separate Astro and Vite caches", async t => {
	const project = fixture(t, { webroots: ["first", "second"] });
	for (const name of ["first", "second"]) {
		fs.mkdirSync(path.join(project, name));
		fs.writeFileSync(path.join(project, name, "index.astro"), `${name} development`);
	}
	const sites = await Webroot.search(project);
	const workers = [];
	try {
		for (const site of sites) {
			const port = await freePort();
			workers.push({ worker: await dev(await Webroot.resolve(site.path), { port }), port, site });
		}
		for (const { port, site } of workers) {
			const response = await fetch(`http://localhost:${port}/`);
			assert.equal(response.status, 200);
			assert.match(await response.text(), new RegExp(`${path.basename(site.path)} development`));
			assert(fs.statSync(path.join(site.astroCache, "types.d.ts")).isFile());
			assert(fs.statSync(site.viteCache).isDirectory());
		}
		assert.equal(fs.existsSync(path.join(project, ".caches/.astro")), false);
	} finally {
		await Promise.all(workers.map(({ worker }) => worker.close()));
	}
});
