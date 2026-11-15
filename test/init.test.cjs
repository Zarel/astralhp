"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { createConfig } = require("../dist/config-loader.js");
const { Webroot } = require("astrohp");

const cli = path.resolve(__dirname, "../astrohp");

function fixture(t) {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-init-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	return project;
}

function run(project, input, args = []) {
	return spawnSync(process.execPath, [cli, "init", ...args], {
		cwd: project, input, encoding: "utf8", timeout: 10000,
	});
}

async function readConfig(project) {
	return (await import(pathToFileURL(path.join(project, "astrohp.mts")).href)).config;
}

test("init defaults to an empty www/.htaccess without a config file", async t => {
	const project = fixture(t);
	const result = run(project, "\n\n\n");
	assert.equal(result.status, 0, result.stderr || result.error);
	assert.match(result.stdout, /Webroot directory \(www\)/);
	assert.match(result.stdout, /Webroot directory can be \./);
	assert.match(result.stdout, /Adapter \(apache-static\)/);
	assert.doesNotMatch(result.stdout, /Port \(|Interpreter path:/);
	assert.doesNotMatch(result.stdout, /prerender/i);
	assert.match(result.stdout, /Ready\. This will:\n- create `www`\n- create `www\/\.htaccess`\n\nGo\? \(yes\):/);
	assert.doesNotMatch(result.stdout, /export const config|astrohp\.mts/);
	assert.deepEqual(fs.readdirSync(project), ["www"]);
	assert.equal(fs.readFileSync(path.join(project, "www/.htaccess"), "utf8"), "");
	const site = await Webroot.requireOne(project);
	assert.equal(site.path, path.join(project, "www"));
	assert.equal(site.adapter, "apache-static");
	assert.equal(site.configFile, null);
	assert(fs.statSync(path.join(project, "www")).isDirectory());
	assert.equal(fs.existsSync(path.join(project, "www/.caches")), false);
});

test("init respects the project directory argument and preserves existing Apache rules", async t => {
	const project = fixture(t);
	const target = path.join(project, "site");
	fs.mkdirSync(path.join(target, "public"), { recursive: true });
	const apache = path.join(target, "public/.htaccess");
	fs.writeFileSync(apache, "# existing Apache rules\n");
	const result = run(project, "public\n\n\n", ["site"]);
	assert.equal(result.status, 0, result.stderr || result.error);
	assert.match(result.stdout, /Adapter \(apache-static\)/);
	assert.doesNotMatch(result.stdout, /Port \(|Interpreter path:/);
	assert.equal(fs.existsSync(path.join(target, "astrohp.mts")), false);
	assert.match(result.stdout, /- use existing `public`\n- use existing `public\/\.htaccess`/);
	assert.equal(fs.readFileSync(apache, "utf8"), "# existing Apache rules\n");
	assert.equal(fs.existsSync(path.join(project, "astrohp.mts")), false);
});

test("init can explicitly select apache-static with the project directory as webroot", t => {
	const project = fixture(t);
	const result = run(project, ".\napache-static\nyes\n");
	assert.equal(result.status, 0, result.stderr || result.error);
	assert.deepEqual(fs.readdirSync(project), [".htaccess"]);
	assert.equal(fs.readFileSync(path.join(project, ".htaccess"), "utf8"), "");
});

test("init retries invalid answers and saves proxy settings", async t => {
	const project = fixture(t);
	fs.writeFileSync(path.join(project, "file"), "not a directory");
	const result = run(project, "file\n.\ninvalid\napache-proxy\n0\n9001\nmaybe\nyes\n");
	assert.equal(result.status, 0, result.stderr || result.error);
	assert.match(result.stdout, /Webroot must be a directory/);
	assert.match(result.stdout, /adapter must be/);
	assert.match(result.stdout, /Please answer yes or no/);
	assert.match(result.stdout, /Port must be an integer from 1 to 65535/);
	assert(result.stdout.indexOf('export const config: import("astrohp").Config') < result.stdout.indexOf("Go?"));
	assert.match(result.stdout, /- create `\.htaccess`\n- create `astrohp\.mts`, containing:/);
	assert.equal(fs.readFileSync(path.join(project, ".htaccess"), "utf8"), "");
	assert.deepEqual(await readConfig(project), { webroot: ".", adapter: "apache-proxy", port: 9001 });
	assert.equal(fs.existsSync(path.join(project, "www")), false);
});

test("init still supports selecting Node and its default port", async t => {
	const project = fixture(t);
	const result = run(project, "\nnode\n\n\n");
	assert.equal(result.status, 0, result.stderr || result.error);
	assert.deepEqual(await readConfig(project), { webroot: "www", adapter: "node", port: 4321 });
	assert.doesNotMatch(result.stdout, /\.htaccess/);
	assert.equal(fs.existsSync(path.join(project, "www/.htaccess")), false);
});

test("init prompts for CGI interpreter paths and allows the PATH default", async t => {
	for (const runtimePath of [undefined, "/home/example/bin/bun"]) {
		const project = fixture(t);
		const answers = runtimePath ? `relative\n${runtimePath}\n` : "\n";
		const result = run(project, `\napache-cgi\n${answers}yes\n`);
		assert.equal(result.status, 0, result.stderr || result.error);
		assert.doesNotMatch(result.stdout, /Port \(/);
		assert.match(result.stdout, /Ready\. This will:\n- create `www`\n- create `www\/\.htaccess`\n- create `astrohp\.mts`, containing:/);
		assert.equal(fs.readFileSync(path.join(project, "www/.htaccess"), "utf8"), "");
		if (runtimePath) assert.match(result.stdout, /runtimePath must be an absolute path/);
		assert.deepEqual(await readConfig(project), {
			webroot: "www", adapter: "apache-cgi",
			...(runtimePath ? { runtimePath } : {}),
		});
	}
});

test("init cancels without writing on rejection or end of input", t => {
	for (const input of ["\n\nno\n", "\n\n", ""]) {
		const project = fixture(t);
		const result = run(project, input);
		assert.equal(result.status, 0, result.stderr || result.error);
		assert.match(result.stdout, /Cancelled. No configuration written/);
		assert.deepEqual(fs.readdirSync(project), []);
	}
});

test("init refuses existing config files and dangling symlinks without executing them", t => {
	for (const name of ["astrohp.mts", ".astrohp.mts", "symlink"]) {
		const project = fixture(t);
		const filename = path.join(project, name === "symlink" ? "astrohp.mts" : name);
		const source = 'throw new Error("configuration executed");';
		if (name === "symlink") fs.symlinkSync(path.join(project, "missing"), filename);
		else fs.writeFileSync(filename, source);
		const result = run(project, "\n\n\n\n");
		assert.equal(result.status, 1, result.stderr || result.error);
		assert.match(result.stderr, /Configuration already exists/);
		assert.doesNotMatch(result.stderr, /configuration executed/);
		assert.doesNotMatch(result.stdout, /Webroot directory/);
		if (name === "symlink") assert(fs.lstatSync(filename).isSymbolicLink());
		else assert.equal(fs.readFileSync(filename, "utf8"), source);
	}
});

test("config creation escapes data, supports webroots arrays, and never overwrites", async t => {
	const project = fixture(t);
	const config = { adapter: "apache-proxy", webroots: ['a"quote', { webroot: "`template${literal}", port: 9002 }] };
	const filename = createConfig(project, config);
	assert.deepEqual(await readConfig(project), config);
	const source = fs.readFileSync(filename, "utf8");
	assert.throws(() => createConfig(project, { webroot: "replacement" }), /already exists/);
	assert.equal(fs.readFileSync(filename, "utf8"), source);
});
