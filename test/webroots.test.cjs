"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { Webroot, dev, start } = require("astralhp");
const { validateConfig } = require("../dist/config-loader.js");

const cli = path.resolve(__dirname, "../astralhp");

function fixture(t, config) {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-webroots-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.writeFileSync(path.join(project, "astralhp.mts"), `export const config = ${JSON.stringify(config)};`);
	return project;
}

async function freePort() {
	const server = net.createServer();
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

test("discovers .htaccess webroots in descendants and ancestors without treating nested rules as sites", async t => {
	const project = fixture(t, {});
	fs.rmSync(path.join(project, "astralhp.mts"));
	for (const name of ["first", "first/private", "second", "node_modules/ignored", ".git/ignored", ".caches/ignored"]) {
		fs.mkdirSync(path.join(project, name), { recursive: true });
		fs.writeFileSync(path.join(project, name, ".htaccess"), "");
	}
	// A directory with this name is not a marker, and directory symlinks are not traversed.
	fs.mkdirSync(path.join(project, "not-a-site/.htaccess"), { recursive: true });
	fs.symlinkSync(project, path.join(project, "loop"));
	const sites = await Webroot.requireAll(project);
	assert.deepEqual(sites.map(site => site.path), ["first", "second"].map(name => path.join(project, name)));
	for (const site of sites) {
		assert.equal(site.adapter, "apache-static");
		assert.equal(site.configFile, null);
		assert.equal(site.prerender, true);
	}
	assert.deepEqual(await Webroot.requireOne(path.join(project, "first/private")), sites[0]);
	assert.deepEqual(await Webroot.resolve("first", project), sites[0]);
	await assert.rejects(Webroot.requireOne(project), /Found multiple AstralHP webroots/);
});

test("workers resolve project directories from configs and package manifests", t => {
	const project = fixture(t, {});
	const site = name => new Webroot({ webroot: path.join(project, name) });
	const first = site("sites/first/www");
	assert.equal(first.projectDir, project);
	for (const name of ["sites/first", "sites/second"]) {
		fs.mkdirSync(path.join(project, name, "www"), { recursive: true });
		fs.writeFileSync(path.join(project, name, "package.json"), "{}");
	}
	const sites = [site("sites/first/www"), site("sites/second/www")];
	assert.equal(sites[0].projectDir, path.join(project, "sites/first"));
	assert.equal(Webroot.workerDirectory(sites), project);
	const configured = new Webroot({ webroot: sites[0].path }, path.join(project, "astralhp.mts"));
	assert.equal(configured.projectDir, project);
	fs.unlinkSync(path.join(project, "astralhp.mts"));
	assert.equal(Webroot.workerDirectory(sites), path.join(project, "sites"));
	assert.equal(site("standalone").projectDir, path.join(project, "standalone"));
});

test("explicit configurations take precedence over .htaccess markers", async t => {
	const project = fixture(t, {
		adapter: "apache-proxy",
		port: 9001,
		webroot: ["first", { webroot: "second", adapter: "node" }],
	});
	for (const name of [".", "first", "first/private", "second", "third"]) {
		fs.mkdirSync(path.join(project, name), { recursive: true });
		fs.writeFileSync(path.join(project, name, ".htaccess"), "");
	}
	const sites = await Webroot.requireAll(project);
	assert.deepEqual(sites.map(site => [path.relative(project, site.path), site.adapter]), [
		["first", "apache-proxy"], ["second", "node"], ["third", "apache-static"],
	]);
	assert.equal(sites[0].port, 9001);
	assert.equal(sites[0].configFile, path.join(project, "astralhp.mts"));
	assert.equal(sites[2].configFile, null);
	assert.deepEqual(await Webroot.resolve(path.join(project, "first")), sites[0]);
});

test("an empty .htaccess is sufficient for CLI discovery, builds, and local development", async t => {
	const project = fixture(t, {});
	fs.rmSync(path.join(project, "astralhp.mts"));
	const root = path.join(project, "www");
	fs.mkdirSync(root);
	fs.writeFileSync(path.join(root, ".htaccess"), "");
	fs.writeFileSync(path.join(root, "index.astro"), "<h1>Zero config</h1>");
	const listed = spawnSync(process.execPath, [cli], { cwd: project, encoding: "utf8" });
	assert.equal(listed.status, 0, listed.stderr);
	assert.equal(listed.stdout.trim(), "AstralHP webroots:\n  www");
	const built = spawnSync(process.execPath, [cli, "build"], { cwd: project, encoding: "utf8" });
	assert.equal(built.status, 0, built.stderr);
	assert.match(fs.readFileSync(path.join(root, ".caches/dist/index.html"), "utf8"), /Zero config/);
	assert.match(fs.readFileSync(path.join(root, ".htaccess"), "utf8"), /BEGIN ASTRALHP/);
	assert.equal(fs.existsSync(path.join(root, ".caches/dist/.server")), false);
	const site = await Webroot.requireOne(project);
	const port = await freePort();
	const worker = await dev(site, { port });
	try {
		const response = await fetch(`http://localhost:${port}/`);
		assert.equal(response.status, 200);
		assert.match(await response.text(), /Zero config/);
	} finally {
		await worker.close();
	}
});

test("expands paths and overrides, resolves selected webroots, and keeps stable isolated caches", async t => {
	const project = fixture(t, {
		adapter: "apache-proxy",
		port: 9001,
		runtimePath: process.execPath,
		prerender: false,
		webroot: ["first/www", { webroot: "second/www", adapter: "apache-cgi", port: 9002, prerender: true }],
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
	await assert.rejects(Webroot.requireOne(project), /Found multiple AstralHP webroots/);
	// A second config avoids module-import caching while using the same project directory.
	fs.rmSync(path.join(project, "astralhp.mts"));
	fs.writeFileSync(
		path.join(project, ".astralhp.mts"),
		'export const config = { webroot: ["./second/www", "first/../first/www", "third"] };',
	);
	const reordered = await Webroot.search(project);
	assert.deepEqual(reordered.map(site => site.adapter), ["apache-static", "apache-static", "apache-static"]);
	assert.equal(reordered[0].projectCaches, sites[1].projectCaches);
	assert.equal(reordered[1].projectCaches, sites[0].projectCaches);
});

test("rejects malformed multi-webroot configurations", () => {
	for (const value of [null, 42, "", {}, [], [""], [null], [42], [{}], [{ webroot: "" }], [["www"]]]) {
		assert.throws(() => validateConfig({ webroot: value }, "config"), /webroot/);
	}
	assert.throws(() => validateConfig({ webroot: [{ webroot: ["other"] }] }, "config"), /non-empty webroot/);
	for (const entry of [
		{ adapter: "unknown" }, { port: -1 }, { runtimePath: "bun" }, { prerender: "false" }, { typo: true },
	]) {
		assert.throws(() => validateConfig({ webroot: [{ webroot: "www", ...entry }] }, "config"));
	}
	assert.throws(() => new Webroot({ webroot: ["www"] }, "/tmp/astralhp.mts"), /represents one directory/);
});

test("rejects duplicate webroots within an array and across configs", async t => {
	const project = fixture(t, { webroot: ["www", "./www/"] });
	await assert.rejects(Webroot.search(project), /configured more than once/);
	fs.rmSync(path.join(project, "astralhp.mts"));
	fs.writeFileSync(path.join(project, ".astralhp.mts"), 'export const config = { webroot: ["www"] };');
	fs.mkdirSync(path.join(project, "www"));
	fs.writeFileSync(path.join(project, "www/astralhp.mts"), "export const config = {};");
	await assert.rejects(Webroot.search(project), /configured by both/);
});

test("CLI lists and builds array entries, then serves both through a shared proxy listener", async t => {
	const project = fixture(t, { adapter: "apache-proxy", webroot: ["first", { webroot: "second" }] });
	for (const name of ["first", "second"]) {
		fs.mkdirSync(path.join(project, name));
		fs.writeFileSync(
			path.join(project, name, "index.astro"), `---\nexport const prerender = true;\n---\n${name} static`,
		);
		fs.writeFileSync(
			path.join(project, name, "live.astro"),
			`---\nexport const prerender = false;\n---\n${name} dynamic {process.cwd()}`,
		);
	}
	const listed = spawnSync(process.execPath, [cli], { cwd: project, encoding: "utf8" });
	assert.equal(listed.status, 0, listed.stderr);
	assert.equal(listed.stdout.trim(), "AstralHP webroots:\n  first\n  second");
	const ambiguous = spawnSync(process.execPath, [cli, "dev"], { cwd: project, encoding: "utf8" });
	assert.equal(ambiguous.status, 1);
	assert.match(ambiguous.stderr, /Found multiple AstralHP webroots; specify one/);
	const built = spawnSync(process.execPath, [cli, "build"], { cwd: project, encoding: "utf8" });
	assert.equal(built.status, 0, built.stderr);
	const sites = await Webroot.search(project);
	for (const site of sites) {
		assert(fs.statSync(path.join(site.astroCache, "types.d.ts")).isFile());
		assert(fs.statSync(path.join(site.dist, ".server/app.mjs")).isFile());
		assert.match(
			fs.readFileSync(path.join(site.dist, "index.html"), "utf8"), new RegExp(`${path.basename(site.path)} static`),
		);
	}
	const port = await freePort();
	const worker = await start(sites, { port, host: "127.0.0.1" });
	try {
		for (const site of sites) {
			const response = await fetch(`http://127.0.0.1:${port}/live`, {
				headers: { "X-AstralHP-Document-Root": site.path },
			});
			assert.equal(response.status, 200);
			assert((await response.text()).includes(`${path.basename(site.path)} dynamic ${fs.realpathSync(project)}`));
		}
	} finally {
		await worker.close();
	}
});

test("selected webroots can run concurrent dev servers with separate Astro and Vite caches", async t => {
	const project = fixture(t, { webroot: ["first", "second"] });
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
	} finally {
		await Promise.all(workers.map(({ worker }) => worker.close()));
	}
});
