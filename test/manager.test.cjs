"use strict";

const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const cli = path.resolve(__dirname, "../astralhp");
const exec = promisify(execFile);

async function fixture(t, webroot = "www") {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-manager-"));
	const options = {
		cwd: project,
		timeout: 20000,
		env: { ...process.env, XDG_CACHE_HOME: path.join(project, ".caches/user-cache") },
	};
	const run = (...args) => exec(process.execPath, [cli, ...args], options);
	const root = path.join(project, webroot);
	const entry = path.join(root, ".caches/dist/.server/app.mjs");
	fs.mkdirSync(path.dirname(entry), { recursive: true });
	t.after(async () => {
		try {
			await run("stop");
			await run("stop", webroot);
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
		}
	});
	const tcp = net.createServer().listen(0, "127.0.0.1");
	await once(tcp, "listening");
	const { port } = tcp.address();
	await new Promise(resolve => tcp.close(resolve));
	options.env.PORT = String(port);
	fs.writeFileSync(
		path.join(project, "astralhp.mts"),
		`export const config = { adapter: "apache-proxy", webroot: ${JSON.stringify(webroot)} };`,
	);
	function publish(version) {
		fs.writeFileSync(
			entry, `setInterval(() => {}, 60000);
export function handler(req, res) {
	res.write('${version}');
	if (req.url === '/live/slow') setTimeout(() => res.end(), 500);
	else res.end();
}`,
		);
	}
	return { project, options, run, entry, publish, url: `http://127.0.0.1:${port}/live` };
}

test("background commands wait for readiness and recover from a failed reload", async t => {
	const { run, publish, entry, options, url, project } = await fixture(t);
	await assert.rejects(run("start"), /no Astro server entrypoint/);
	publish("first");
	// Simulate a previous manager exiting without closing its control socket.
	await exec(process.execPath, [
		"-e", 'require("node:net").createServer().listen(".caches/run/control.sock", () => process.exit(0))',
	], options);
	const starts = await Promise.all([run("start"), run("start")]);
	assert.equal(starts.filter(result => result.stdout.includes("already running")).length, 1);
	for (const result of starts) assert(result.stdout.includes(new URL("/", url).href));
	assert.equal(await (await fetch(url)).text(), "first");
	const started = starts.find(result => !result.stdout.includes("already running"));
	assert(fs.readFileSync(path.join(project, ".caches/run/server.log"), "utf8").includes(started.stdout));
	delete options.env.PORT;
	const slow = await fetch(`${url}/slow`);
	publish("second");
	const [body] = await Promise.all([slow.text(), run("reload")]);
	assert.equal(body, "first");
	assert.equal(await (await fetch(url)).text(), "second");
	fs.writeFileSync(entry, 'setInterval(() => {}, 60000); throw new Error("broken build");');
	await assert.rejects(run("reload"), /broken build/);
	await assert.rejects(run("start"), /worker is stopped/);
	assert.match((await run("ps")).stdout, /\tstopped\t/);
	publish("fixed");
	await run("reload");
	assert.equal(await (await fetch(url)).text(), "fixed");
	await run("stop");
	await assert.rejects(fetch(url));
	assert.match((await run("stop")).stdout, /already stopped/);
	await assert.rejects(run("reload"), /not running/);
});

test("background start prints the URL assigned to an ephemeral port", async t => {
	const { options, run, publish } = await fixture(t);
	options.env.PORT = "0";
	publish("ephemeral");
	const { stdout } = await run("start");
	const url = stdout.match(/^AstralHP running, listening to (http:\/\/127\.0\.0\.1:[1-9]\d*\/)$/m)?.[1];
	assert(url, stdout);
	assert.equal(await (await fetch(url)).text(), "ephemeral");
});

async function serveForeground(options, ...args) {
	const child = spawn(process.execPath, [cli, "serve", ...args], { ...options, stdio: ["ignore", "pipe", "inherit"] });
	const exit = once(child, "exit");
	let output = "";
	for await (const chunk of child.stdout.iterator({ destroyOnReturn: false })) {
		output += chunk;
		if (/^Serving .+\n/m.test(output)) break;
	}
	child.stdout.resume();
	assert.match(output, /^Serving .+\n/m);
	return { child, exit, output };
}

test("serve stays in the foreground and accepts commands for its explicit webroot", async t => {
	const { options, project, run, publish, url } = await fixture(t);
	publish("foreground");
	const started = await run("start", "www");
	await run("stop", "www");
	const { exit, output } = await serveForeground(options, "www");
	const webroot = fs.realpathSync(path.join(project, "www"));
	assert.equal(output, `AstralHP running, listening to ${new URL("/", url).href}\nServing ${webroot}\n`);
	assert.equal(started.stdout, output);
	assert.equal(await (await fetch(url)).text(), "foreground");
	assert.match((await run("stop")).stdout, /already stopped/);
	await run("reload", "www");
	await run("stop", "www");
	assert.deepEqual(await exit, [0, null]);
});

test("a crashed manager releases its SQLite lock and the next start reclaims control.sock", async t => {
	const { project, options, run, entry, publish, url } = await fixture(t);
	publish("first");
	const { child, exit } = await serveForeground(options);
	const runtime = path.join(project, ".caches/run");
	const lockFile = path.join(runtime, "manager.sqlite");
	const lockInode = fs.statSync(lockFile).ino;
	const socket = path.join(runtime, "control.sock");

	// Leave the manager alive without a worker so the HTTP port is free.
	fs.writeFileSync(entry, 'throw new Error("broken build");');
	await assert.rejects(run("reload"), /broken build/);
	publish("recovered");
	await assert.rejects(run("start"), /worker is stopped/);
	child.kill("SIGKILL");
	await exit;
	assert(fs.lstatSync(socket).isSocket());
	assert.match((await run("stop")).stdout, /already stopped/);

	await run("start");
	assert.equal(await (await fetch(url)).text(), "recovered");
	assert.deepEqual(fs.readdirSync(runtime).filter(name => name.endsWith(".sock")), ["control.sock"]);
	assert.equal((await run("ps")).stdout.trim().split("\n").length, 2);
	await run("stop");
	assert(!fs.existsSync(socket));
	assert.equal(fs.statSync(lockFile).ino, lockInode);
});

test("ps discovers live managers across projects and skips stale registrations", async t => {
	const first = await fixture(t);
	const second = await fixture(t);
	second.options.env.XDG_CACHE_HOME = first.options.env.XDG_CACHE_HOME;
	first.publish("first");
	second.publish("second");
	const ps = async () =>
		(await exec(process.execPath, [cli, "ps"], {
			...first.options,
			cwd: os.tmpdir(),
		})).stdout.trim();
	assert.equal(await ps(), "No AstralHP managers running.");
	await first.run("start");
	await second.run("start", "www");
	const index = path.join(first.options.env.XDG_CACHE_HOME, "astralhp/managers");
	fs.symlinkSync(path.join(first.project, "missing.sock"), path.join(index, "stale"));
	const listed = (await ps()).split("\n");
	assert.equal(listed.length, 3);
	assert.equal(listed[0], "PID\tWORKER\tWEBROOTS");
	for (const command of ["ps", "status"]) {
		assert.deepEqual((await first.run(command)).stdout.trim().split("\n"), listed);
	}
	for (const [site, projectDir] of [[first, "."], [second, "www"]]) {
		const webroot = fs.realpathSync(path.join(site.project, "www"));
		const row = listed.find(line => line.split("\t")[2] === webroot);
		assert.match(row, /^\d+\trunning\t[^\t]+$/);
		for (const command of ["ps", "status"]) {
			assert.deepEqual((await site.run(command, projectDir)).stdout.trim().split("\n"), [listed[0], row]);
		}
	}
	assert(!fs.readdirSync(index).includes("stale"));
	await second.run("stop", "www");
	assert.equal((await ps()).split("\n").length, 2);
	await first.run("stop");
	assert.equal(await ps(), "No AstralHP managers running.");
});

test("manages a distant webroot using a short socket name and keeps the worker's launch directory", async t => {
	const webroot = "nested-site/".repeat(12) + "www";
	const { project, run, entry, url } = await fixture(t, webroot);
	const root = fs.realpathSync(path.join(project, webroot));
	const socket = path.join(root, ".caches/run/control.sock");
	fs.writeFileSync(entry, "export function handler(req, res) { res.end(process.cwd()); }");
	assert.equal((await run("status", webroot)).stdout.trim(), "No AstralHP manager running for this project.");
	await run("start", webroot);
	assert(fs.statSync(socket).isSocket());
	const status = (await run("status", root)).stdout;
	assert.equal(status.trim().split("\n")[1].split("\t")[2], root);
	assert.equal((await run("ps")).stdout, status);
	assert.equal(fs.realpathSync(await (await fetch(url)).text()), fs.realpathSync(project));
	await run("reload", webroot);
	assert.equal(fs.realpathSync(await (await fetch(url)).text()), fs.realpathSync(project));
	await run("stop", root);
	assert(!fs.existsSync(socket));
});
