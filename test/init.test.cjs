"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { createConfig } = require("../dist/config-loader.js");
const { Webroot } = require("astralhp");

const cli = path.resolve(__dirname, "../astralhp");

function fixture(t) {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-init-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	return project;
}

function run(project, input, args = [], { npmExitCode = 0 } = {}) {
	const bin = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-npm-"));
	const log = path.join(bin, "calls.json");
	const script = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
process.exit(${npmExitCode});
`;
	fs.writeFileSync(path.join(bin, "npm"), script, { mode: 0o755 });
	if (process.platform === "win32") {
		fs.writeFileSync(path.join(bin, "npm.cmd"), `@"${process.execPath}" "%~dp0npm" %*\r\n`);
	}
	try {
		const result = spawnSync(process.execPath, [cli, "init", ...args], {
			cwd: project,
			input,
			encoding: "utf8",
			timeout: 10000,
			env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
		});
		return { ...result, npmCall: fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : null };
	} finally {
		fs.rmSync(bin, { recursive: true, force: true });
	}
}

function assertInstall(result, project) {
	assert.deepEqual(result.npmCall, {
		cwd: fs.realpathSync(project),
		args: ["install", "--save-dev", "astralhp", "--prefix", "."],
	});
}

async function readConfig(project) {
	return (await import(pathToFileURL(path.join(project, "astralhp.mts")).href)).config;
}

test("init defaults to an empty www/.htaccess without a config file", async t => {
	const project = fixture(t);
	const result = run(project, "\n\n\n");
	assert.equal(result.status, 0, result.stderr || result.error);
	assert.match(result.stdout, /Webroot directory \(www\)/);
	assert.match(result.stdout, /Adapter \(apache-static\)/);
	assert.doesNotMatch(result.stdout, /Port \(|Interpreter path:/);
	assert.match(
		result.stdout,
		/Ready\. This will:\n- create `www`\n- create `www\/\.htaccess`\n- create `package\.json` with astralhp and install it\n\nGo\? \(yes\):/,
	);
	assertInstall(result, project);
	assert.doesNotMatch(result.stdout, /export const config|astralhp\.mts/);
	assert.deepEqual(fs.readdirSync(project), ["www"]);
	assert.equal(fs.readFileSync(path.join(project, "www/.htaccess"), "utf8"), "");
	const site = await Webroot.requireOne(project);
	assert.equal(site.config.webroot, path.join(project, "www"));
	assert.equal(site.config.adapter, "apache-static");
	assert.equal(site.configFile, null);
	assert(fs.statSync(path.join(project, "www")).isDirectory());
});

test("init respects the project directory argument and preserves existing Apache rules", async t => {
	const project = fixture(t);
	fs.writeFileSync(path.join(project, "package.json"), '{"private":true}');
	const target = path.join(project, "site");
	fs.mkdirSync(path.join(target, "public"), { recursive: true });
	const apache = path.join(target, "public/.htaccess");
	fs.writeFileSync(apache, "# existing Apache rules\n");
	const result = run(project, "public\n\n\n", ["site"]);
	assert.equal(result.status, 0, result.stderr || result.error);
	assert.match(result.stdout, /Adapter \(apache-static\)/);
	assert.doesNotMatch(result.stdout, /Port \(|Interpreter path:/);
	assert.equal(fs.existsSync(path.join(target, "astralhp.mts")), false);
	assert.match(result.stdout, /- use existing `public`\n- use existing `public\/\.htaccess`/);
	assert.equal(fs.readFileSync(apache, "utf8"), "# existing Apache rules\n");
	assert.equal(fs.existsSync(path.join(project, "astralhp.mts")), false);
	assertInstall(result, project);
	assert.match(result.stdout, /- add astralhp to `\.\.[/\\]package\.json` and install it/);
});

test("init installs at the nearest npm project boundary", t => {
	for (const marker of ["package.json", "node_modules"]) {
		const project = fixture(t);
		fs.writeFileSync(path.join(project, "package.json"), '{"private":true}');
		const nearest = path.join(project, "nested");
		const target = path.join(nearest, "site");
		fs.mkdirSync(target, { recursive: true });
		if (marker === "package.json") fs.writeFileSync(path.join(nearest, marker), '{"private":true}');
		else fs.mkdirSync(path.join(nearest, marker));
		const result = run(target, "\n\n\n");
		assert.equal(result.status, 0, result.stderr || result.error);
		assertInstall(result, nearest);
		assert.match(
			result.stdout,
			marker === "package.json" ?
				/- add astralhp to `\.\.[/\\]package\.json` and install it/ :
				/- create `\.\.[/\\]package\.json` with astralhp and install it/,
		);
		assert(fs.existsSync(path.join(target, "www/.htaccess")));
	}
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
	assert(result.stdout.indexOf('export const config: import("astralhp").Config') < result.stdout.indexOf("Go?"));
	assert.match(result.stdout, /- create `astralhp\.mts`, containing:/);
	assert.equal(fs.readFileSync(path.join(project, ".htaccess"), "utf8"), "");
	assert.deepEqual(await readConfig(project), { webroot: ".", adapter: "apache-proxy", port: 9001 });
	assert.equal(fs.existsSync(path.join(project, "www")), false);
});

test("init saves Node settings without creating .htaccess", async t => {
	const project = fixture(t);
	fs.writeFileSync(path.join(project, "package.json"), '{"private":true}');
	const result = run(project, "\nnode\n\n\n");
	assert.equal(result.status, 0, result.stderr || result.error);
	assert.deepEqual(await readConfig(project), { webroot: "www", adapter: "node", port: 4321 });
	assert.doesNotMatch(result.stdout, /\.htaccess/);
	assert.match(result.stdout, /- add astralhp to `package\.json` and install it/);
	assert.equal(fs.existsSync(path.join(project, "www/.htaccess")), false);
});

test("init prompts for CGI interpreter paths and allows the PATH default", async t => {
	for (const runtimePath of [undefined, "/home/example/bin/bun"]) {
		const project = fixture(t);
		const answers = runtimePath ? `relative\n${runtimePath}\n` : "\n";
		const result = run(project, `\napache-cgi\n${answers}yes\n`);
		assert.equal(result.status, 0, result.stderr || result.error);
		assert.doesNotMatch(result.stdout, /Port \(/);
		assert.match(
			result.stdout,
			/Ready\. This will:\n- create `www`\n- create `www\/\.htaccess`\n- create `package\.json` with astralhp and install it\n- create `astralhp\.mts`, containing:/,
		);
		assert.equal(fs.readFileSync(path.join(project, "www/.htaccess"), "utf8"), "");
		if (runtimePath) assert.match(result.stdout, /runtimePath must be an absolute path/);
		assert.deepEqual(await readConfig(project), {
			webroot: "www",
			adapter: "apache-cgi",
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
		assert.equal(result.npmCall, null);
	}
});

test("init refuses existing config files and dangling symlinks without executing them", t => {
	for (const name of ["astralhp.mts", ".astralhp.mts", "symlink"]) {
		const project = fixture(t);
		const filename = path.join(project, name === "symlink" ? "astralhp.mts" : name);
		const source = 'throw new Error("configuration executed");';
		if (name === "symlink") fs.symlinkSync(path.join(project, "missing"), filename);
		else fs.writeFileSync(filename, source);
		const result = run(project, "\n\n\n\n");
		assert.equal(result.status, 1, result.stderr || result.error);
		assert.match(result.stderr, /Configuration already exists/);
		assert.doesNotMatch(result.stderr, /configuration executed/);
		assert.doesNotMatch(result.stdout, /Webroot directory/);
		assert.equal(result.npmCall, null);
		if (name === "symlink") assert(fs.lstatSync(filename).isSymbolicLink());
		else assert.equal(fs.readFileSync(filename, "utf8"), source);
	}
});

test("init reports npm failures and keeps the generated setup for retrying installation", async t => {
	const project = fixture(t);
	const result = run(project, "\nnode\n\n\n", [], { npmExitCode: 1 });
	assert.equal(result.status, 1, result.stderr || result.error);
	assertInstall(result, project);
	assert.match(result.stderr, /npm exited with status 1/);
	assert.match(result.stderr, /Setup files have been kept/);
	assert.match(result.stderr, /npm install --save-dev astralhp/);
	assert(result.stderr.includes(project));
	assert.deepEqual(await readConfig(project), { webroot: "www", adapter: "node", port: 4321 });
	assert(fs.statSync(path.join(project, "www")).isDirectory());
});

test("config creation escapes data, supports webroot arrays, and never overwrites", async t => {
	const project = fixture(t);
	const config = { adapter: "apache-proxy", webroot: ['a"quote', { webroot: "`template${literal}", port: 9002 }] };
	const filename = createConfig(project, config);
	assert.deepEqual(await readConfig(project), config);
	const source = fs.readFileSync(filename, "utf8");
	assert.throws(() => createConfig(project, { webroot: "replacement" }), /already exists/);
	assert.equal(fs.readFileSync(filename, "utf8"), source);
});
