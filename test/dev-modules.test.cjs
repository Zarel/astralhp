"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { staticFiles } = require("../dist/dev-server.js");
const { Webroot } = require("../dist/webroot.js");

test("serves transformed TypeScript modules alongside classic compiled scripts", async t => {
	const { createServer } = await import("vite");
	const root = fs.mkdtempSync(path.resolve(__dirname, "../.astrohp-test-modules-"));
	const site = new Webroot({ webroot: root });
	fs.writeFileSync(path.join(root, "answer.ts"), "export const answer: number = 42;");
	fs.writeFileSync(
		path.join(root, "app.ts"),
		'import { answer } from "./answer"; const value: number = answer; console.log(value);',
	);
	fs.mkdirSync(site.dist, { recursive: true });
	fs.writeFileSync(path.join(site.dist, "app.js"), "console.log(answer);");
	const server = await createServer({
		configFile: false,
		root,
		plugins: [staticFiles(site)],
		server: { host: "127.0.0.1", port: 0 },
	});
	t.after(async () => {
		await server.close();
		fs.rmSync(root, { recursive: true, force: true });
	});
	await server.listen();
	const base = `http://127.0.0.1:${server.httpServer.address().port}`;
	const response = await fetch(`${base}/app.ts`);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type"), /javascript/);
	const source = await response.text();
	assert.match(source, /import .*answer.*from ["']\/answer.ts["']/);
	assert.doesNotMatch(source, /value: number/);
	const dependency = await fetch(`${base}/answer.ts`);
	assert.equal(dependency.status, 200);
	assert.match(await dependency.text(), /export const answer = 42/);
	const classic = await fetch(`${base}/app.js`);
	assert.equal(classic.status, 200);
	assert.equal(await classic.text(), "console.log(answer);");
	assert.equal((await fetch(`${base}/.caches/dist/app.js`)).status, 404);
});
