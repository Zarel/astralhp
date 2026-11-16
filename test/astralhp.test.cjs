"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const { build: buildAstralHP } = require("astralhp");
const { DatabaseTable, MySQLDatabase, PGDatabase, SQL, SQLStatement, SQLiteDatabase } = require("astralhp/database");

const {
	compileScripts,
	scriptOutputPath,
} = require("../dist/babel.js");
const {
	apacheRoute,
	apacheBlock,
	replaceApacheBlock,
	resolveApacheRoutes,
	writeApacheConfig,
} = require("../dist/apache.js");
const { publishDist } = require("../dist/build.js");
const { cachebust, cachebustScript } = require("../dist/cachebuster.js");
const { contentType } = require("../dist/mime.js");
const {
	AstralHPServer,
	serverPort,
} = require("../dist/live-server.js");
const { astralhpIntegration, Webroot } = require("../dist/webroot.js");

const example = path.resolve(__dirname, "../example");
const exampleWebroot = new Webroot({ webroot: example });
const dynamicApacheRoute = {
	pattern: "/[id]",
	regex: "^[^/]+?/?$",
};
const dynamicAstroRoute = {
	pattern: "/[id]",
	type: "page",
	isPrerendered: false,
	segments: [[{ content: "id", dynamic: true, spread: false }]],
};

test("loads the compiled package from node_modules", t => {
	const project = fs.mkdtempSync(path.join(__dirname, "../.astralhp-test-installed-"));
	const installed = path.join(project, "node_modules", "astralhp");
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.mkdirSync(installed, { recursive: true });
	fs.copyFileSync(
		path.resolve(__dirname, "../package.json"),
		path.join(installed, "package.json"),
	);
	fs.cpSync(
		path.resolve(__dirname, "../dist"),
		path.join(installed, "dist"),
		{ recursive: true },
	);

	const source = path.join(project, "index.ts");
	fs.writeFileSync(
		source,
		[
			'import { Webroot, type Config } from "astralhp";',
			'import { Database, SQL } from "astralhp/database";',
			'const config: Config = { webroot: "/tmp" };',
			"new Webroot(config);",
			'const multiple: Config = { adapter: "apache-proxy", webroot: ["www", { webroot: "admin", port: 9002 }] };',
			"void multiple;",
			"// @ts-expect-error object entries must specify a webroot",
			"const missingPath: Config = { webroot: [{ port: 9002 }] };",
			"const database: typeof Database = Database;",
			"SQL`SELECT ${database.name}`;",
			'SQL`SELECT ${1} ${SQL.raw("AS result")}`;',
			"// @ts-expect-error SQL requires a tagged template",
			'SQL("SELECT 1");',
			"// @ts-expect-error plain arrays are not tagged templates",
			'SQL(["SELECT ", ""], 1);',
			"// @ts-expect-error raw SQL accepts only a string",
			"SQL.raw(1);",
			"// @ts-expect-error raw SQL does not accept interpolation arguments",
			'SQL.raw("SELECT ?", 1);',
		].join("\n"),
	);
	const typecheck = spawnSync(
		path.resolve(__dirname, "../node_modules/.bin/tsc"),
		[
			"--noEmit",
			"--ignoreConfig",
			"--skipLibCheck",
			"--strict",
			"--module",
			"ESNext",
			"--moduleResolution",
			"Bundler",
			"--target",
			"ES2024",
			source,
		],
		{ cwd: project, encoding: "utf8" },
	);
	assert.equal(typecheck.status, 0, typecheck.stderr || typecheck.stdout);

	const componentSource = path.join(project, "component.ts");
	fs.writeFileSync(
		componentSource,
		'import { CSS, ES3, JS } from "astralhp/components"; void [CSS, ES3, JS];',
	);
	const componentTypecheck = spawnSync(
		path.resolve(__dirname, "../node_modules/.bin/tsc"),
		[
			"--noEmit",
			"--ignoreConfig",
			"--strict",
			"--module",
			"ESNext",
			"--moduleResolution",
			"Bundler",
			"--target",
			"ES2024",
			componentSource,
		],
		{ cwd: project, encoding: "utf8" },
	);
	assert.equal(
		componentTypecheck.status,
		0,
		componentTypecheck.stderr || componentTypecheck.stdout,
	);

	const runtime = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			[
				'import { Webroot } from "astralhp";',
				'import { Database } from "astralhp/database";',
				"if (!Webroot || !Database) process.exit(1);",
			].join("\n"),
		],
		{ cwd: project, encoding: "utf8" },
	);
	assert.equal(runtime.status, 0, runtime.stderr);
});

test("preserves SQL template segments and nested statements", () => {
	const statement = SQL`SELECT ${1} + ${SQL`${2} * ${3}`} AS result${undefined}`;
	assert.deepEqual(statement.sql, ["SELECT ", " + ", " * ", " AS result"]);
	assert.deepEqual(statement.values, [1, 2, 3]);

	const structuralStatement = {
		__isSQLStatement: true,
		sql: [" AND third = ", ""],
		values: [3],
	};
	assert.equal(SQL.isSQL(structuralStatement), true);
	assert.equal(SQL.isSQL({ sql: [], values: [] }), false);
	const fragments = SQL`WHERE ${[
		SQL`first = ${1}`,
		SQL` AND second = ${2}`,
		structuralStatement,
	]}`;
	assert.deepEqual(fragments.sql, ["WHERE first = ", " AND second = ", " AND third = ", ""]);
	assert.deepEqual(fragments.values, [1, 2, 3]);

	const appended = SQL``.append(1).appendRaw(" + ").append(2);
	assert.deepEqual(appended.sql, ["", " + ", ""]);
	assert.deepEqual(appended.values, [1, 2]);
});

test("requires explicit raw SQL and preserves parameters around raw fragments", () => {
	assert.throws(() => SQL("SELECT 1"), /SQL must be used as a template tag/);
	assert.throws(() => SQL(["SELECT ", ""], 1), /SQL must be used as a template tag/);
	assert.throws(() => SQL.raw(1), /SQL.raw\(\) requires exactly one string/);
	assert.throws(() => SQL.raw("SELECT ?", 1), /SQL.raw\(\) requires exactly one string/);
	assert.throws(() => SQL.raw`SELECT ${1}`, /SQL.raw\(\) requires exactly one string/);
	assert.deepEqual(SQL.raw("SELECT 1"), new SQLStatement(["SELECT 1"], []));
	assert.deepEqual(SQL.raw(""), SQL``);
	const value = "'; DROP TABLE entries; --";
	const statement = SQL`SELECT ${value} ${SQL.raw("AS result")} WHERE ${1} = ${1}`;
	assert.deepEqual(statement.sql, ["SELECT ", " AS result WHERE ", " = ", ""]);
	assert.deepEqual(statement.values, [value, 1, 1]);
});

test("rejects null identifiers while preserving null values in every database driver", () => {
	for (const Driver of [MySQLDatabase, PGDatabase, SQLiteDatabase]) {
		// SQL resolution does not need an open database connection.
		const database = Object.create(Driver.prototype);
		for (const quote of ['"', "`"]) {
			assert.throws(
				() => database._resolveSQL(new SQLStatement([`SELECT * FROM ${quote}`, quote], [null])),
				/SQL identifiers cannot be null/,
			);
		}
		assert.deepEqual(database._resolveSQL(SQL`SELECT ${null}`), [
			Driver === PGDatabase ? "SELECT $1" : "SELECT ?",
			[null],
		]);
		assert.deepEqual(database._resolveSQL(SQL`SELECT "${"null"}"`), [
			`SELECT ${database.escapeId("null")}`,
			[],
		]);
	}
});

test("generates portable PostgreSQL table mutations", () => {
	const database = {
		type: "pg",
		prefix: "",
		queryExec(statement) {
			if (statement) return statement;
			return (strings, ...values) => new SQLStatement(strings, values);
		},
	};
	const table = new DatabaseTable(database, "entries", "id");
	const shape = statement => statement.sql.join("?");

	assert.match(
		shape(table.upsert({ id: 1, name: "test" })),
		/ON CONFLICT \("\?"\) DO UPDATE SET/,
	);
	assert.match(
		shape(table.replace({ id: 1, name: "test" })),
		/ON CONFLICT \("\?"\) DO UPDATE SET/,
	);
	assert.doesNotMatch(shape(table.update(1, { name: "test" })), /LIMIT/);
	assert.doesNotMatch(shape(table.delete(1)), /LIMIT/);
	assert.doesNotMatch(
		shape(table.updateOne(SQL`"name" = ${"test"}`)`WHERE "id" = ${1}`),
		/LIMIT/,
	);
	assert.doesNotMatch(shape(table.deleteOne()`WHERE "id" = ${1}`), /LIMIT/);
});

test("does not load database drivers when importing the database module", () => {
	const databaseURL = pathToFileURL(path.resolve(__dirname, "../dist/database.js")).href;
	const script = [
		'import { createRequire } from "node:module";',
		"const require = createRequire(import.meta.url);",
		`await import(${JSON.stringify(databaseURL)});`,
		"const loaded = {",
		'	mysql: Boolean(require.cache[require.resolve("mysql2")]),',
		'	pg: Boolean(require.cache[require.resolve("pg")]),',
		'\tsqlite: process.moduleLoadList.some(name => name.toLowerCase().includes("sqlite")),',
		"};",
		"console.log(JSON.stringify(loaded));",
	].join("\n");
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		cwd: path.resolve(__dirname, ".."),
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		mysql: false,
		pg: false,
		sqlite: false,
	});
});

test("parses PostgreSQL int8 values as numbers", async t => {
	const pg = require("pg");
	t.after(() => {
		pg.defaults.parseInt8 = false;
	});
	const database = new PGDatabase({});
	t.after(() => database.close());

	const parseInt8 = pg.types.getTypeParser(pg.types.builtins.INT8, "text");
	const parseInt8Array = pg.types.getTypeParser(1016, "text");
	assert.equal(parseInt8("42"), 42);
	assert.deepEqual(parseInt8Array("{1,2,NULL}"), [1, 2, null]);
});

test("queries SQLite through the database abstraction", async t => {
	const database = new SQLiteDatabase();
	t.after(() => database.close());

	await database.queryExec(SQL`CREATE TABLE entries (id INTEGER PRIMARY KEY, name TEXT)`);
	const result = await database.queryExec(SQL`INSERT INTO entries (name) VALUES (${"test"})`);
	assert.deepEqual(result, { affectedRows: 1, insertId: 1 });
	assert.deepEqual(
		await database.query(SQL`SELECT name FROM entries WHERE id = ${result.insertId}`),
		[{ name: "test" }],
	);
});

test("loads typed configuration from the working directory", async t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	const webroot = path.join(project, "public");
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.mkdirSync(webroot);
	const filename = path.join(project, "astralhp.mts");
	fs.writeFileSync(
		filename,
		[
			"export const config: import('astralhp').Config = {",
			"\twebroot: 'public',",
			"\tadapter: 'apache-proxy',",
			"\tport: 9001,",
			"};",
		].join("\n"),
	);

	const expected = new Webroot({
		webroot: "public",
		adapter: "apache-proxy",
		port: 9001,
	}, filename);
	assert.deepEqual(
		await Webroot.requireOne(project),
		expected,
	);
	assert.deepEqual(await Webroot.resolve(webroot, project), expected);
});

test("finds configurations in descendants and ancestor directories", async t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	const workspace = path.join(project, "workspace");
	const alpha = path.join(workspace, "sites", "alpha");
	const beta = path.join(workspace, "sites", "beta");
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.mkdirSync(alpha, { recursive: true });
	fs.mkdirSync(beta);
	fs.mkdirSync(path.join(workspace, "node_modules", "ignored"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".astralhp.mts"),
		"export const config = { webroot: 'parent-public' };",
	);
	fs.writeFileSync(
		path.join(alpha, "astralhp.mts"),
		"export const config = { webroot: 'public' };",
	);
	fs.writeFileSync(
		path.join(beta, ".astralhp.mts"),
		"export const config = {};",
	);
	fs.writeFileSync(
		path.join(workspace, "node_modules", "ignored", "astralhp.mts"),
		'throw new Error("ignored configuration executed");',
	);

	const paths = [
		path.join(alpha, "public"),
		beta,
		path.join(project, "parent-public"),
	];
	assert.deepEqual(
		(await Webroot.search(workspace)).map(webroot => webroot.path),
		paths,
	);
	assert.deepEqual(
		(await Webroot.requireAll(workspace)).map(webroot => webroot.path),
		paths,
	);
	await assert.rejects(
		() => Webroot.requireOne(workspace),
		/Found multiple AstralHP webroots/,
	);
});

test("rejects both configuration names in one directory", async t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.writeFileSync(path.join(project, "astralhp.mts"), "export const config = {};");
	fs.writeFileSync(path.join(project, ".astralhp.mts"), "export const config = {};");

	await assert.rejects(
		() => Webroot.search(project),
		/Found both astralhp\.mts and \.astralhp\.mts/,
	);
});

test("uses the requested directory and apache-static adapter without configuration", async t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));

	assert.deepEqual(
		await Webroot.resolve(webroot, webroot),
		new Webroot({ webroot, adapter: "apache-static" }),
	);
});

test("requires at least one discovered webroot", async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

	assert.deepEqual(await Webroot.search(directory), []);
	await assert.rejects(
		() => Webroot.requireAll(directory),
		/Could not find astralhp\.mts or \.astralhp\.mts/,
	);
});

test("uses the configured port unless PORT overrides it", t => {
	const originalPort = process.env.PORT;
	t.after(() => {
		if (originalPort === undefined) {
			delete process.env.PORT;
		} else {
			process.env.PORT = originalPort;
		}
	});

	delete process.env.PORT;
	assert.equal(serverPort(9001), 9001);
	process.env.PORT = "8000";
	assert.equal(serverPort(9001), 8000);
});

test("requires separate ports for direct node webroots", () => {
	const alpha = new Webroot({ webroot: example, adapter: "node" });
	assert.equal(new AstralHPServer([alpha], { port: 0 }).webrootForRequest(undefined), alpha);
	const beta = new Webroot({ webroot: path.dirname(example), adapter: "node" });
	assert.throws(
		() => new AstralHPServer([alpha, beta], { port: 0 }),
		/Node webroots sharing port 0 must use different ports/,
	);
});

test("dispatches Apache proxy requests by document root", () => {
	const alpha = new Webroot({
		webroot: example,
		adapter: "apache-proxy",
	});
	const beta = new Webroot({
		webroot: path.dirname(example),
		adapter: "apache-proxy",
	});
	const server = new AstralHPServer([alpha, beta], { port: 0 });

	assert.equal(server.webrootForRequest(alpha.path), alpha);
	assert.equal(server.webrootForRequest(beta.path), beta);
	assert.equal(
		server.webrootForRequest(path.join(beta.path, "missing")),
		null,
	);
	assert.equal(server.webrootForRequest(undefined), null);
});

test("does not fall back from an unknown Apache document root", () => {
	const apache = new Webroot({
		webroot: example,
		adapter: "apache-proxy",
	});
	const node = new Webroot({ webroot: path.dirname(example), adapter: "node" });
	const server = new AstralHPServer([apache, node], { port: 0 });

	assert.equal(server.webrootForRequest(undefined), node);
	assert.equal(server.webrootForRequest("/unknown"), null);
});

test("rejects invalid executable configuration", async t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.writeFileSync(
		path.join(project, "astralhp.mts"),
		"export const config = { unknown: true };",
	);

	await assert.rejects(
		() => Webroot.requireOne(project),
		/Unknown AstralHP configuration option: unknown/,
	);
});

test("cachebusts file contents regardless of modification time", t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	const site = new Webroot({ webroot });
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));

	const filename = path.join(webroot, "style.css");
	fs.writeFileSync(filename, "style");
	fs.utimesSync(filename, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
	assert.equal(
		cachebust(site, "/style.css", new URL("https://example.test/page")),
		`/style.css?v=${createHash("sha256").update("style").digest("hex").slice(0, 16)}`,
	);

	fs.utimesSync(filename, new Date(1_700_000_001_000), new Date(1_700_000_001_000));
	assert.equal(
		cachebust(site, "/style.css", new URL("https://example.test/page")),
		`/style.css?v=${createHash("sha256").update("style").digest("hex").slice(0, 16)}`,
	);
	fs.writeFileSync(filename, "changed");
	fs.utimesSync(filename, new Date(1_700_000_001_000), new Date(1_700_000_001_000));
	assert.equal(
		cachebust(site, "/style.css", new URL("https://example.test/page")),
		`/style.css?v=${createHash("sha256").update("changed").digest("hex").slice(0, 16)}`,
	);
});

test("maps TypeScript script URLs to hashes of compiled JavaScript", async t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	const site = new Webroot({ webroot });
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));

	const filename = path.join(webroot, "script.tsx");
	fs.writeFileSync(filename, "script");
	await compileScripts(site, [filename]);
	const compiled = fs.readFileSync(path.join(site.dist, "script.js"));
	fs.rmSync(filename);
	assert.equal(
		cachebustScript(
			site,
			"script.tsx",
			new URL("https://example.test/page"),
		),
		`script.js?v=${createHash("sha256").update(compiled).digest("hex").slice(0, 16)}`,
	);
});

test("resolves cachebusted assets relative to the rendered page", t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	const site = new Webroot({ webroot });
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));

	fs.mkdirSync(path.join(webroot, "articles"));
	const filename = path.join(webroot, "articles", "style.css");
	fs.writeFileSync(filename, "style");
	fs.utimesSync(filename, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
	const suffix = `v=${createHash("sha256").update("style").digest("hex").slice(0, 16)}`;

	assert.equal(
		cachebust(
			site,
			"style.css",
			new URL("https://example.test/articles/post"),
		),
		`style.css?${suffix}`,
	);
	assert.equal(
		cachebust(
			site,
			"./style.css",
			new URL("https://example.test/articles/post"),
		),
		`./style.css?${suffix}`,
	);
});

test("rejects assets that cannot be cachebusted locally", t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	const site = new Webroot({ webroot });
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));
	const base = new URL("https://example.test/");

	assert.throws(() => cachebust(site, "", base), /relative or root-relative URL/);
	assert.throws(() => cachebust(site, "//example.com/style.css", base), /relative or root-relative URL/);
	assert.throws(() => cachebust(site, "https://example.com/style.css", base), /relative or root-relative URL/);
	assert.throws(() => cachebust(site, "/style.css?old", base), /query or fragment/);
	assert.throws(() => cachebust(site, "/missing.css", base), /does not exist/);
});

test("compiles explicitly selected TypeScript targets", async t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));
	t.after(() => fs.rmSync(distRoot, { recursive: true, force: true }));

	const source = path.join(webroot, "scripts", "script.tsx");
	fs.mkdirSync(path.dirname(source));
	fs.copyFileSync(path.join(example, "script.tsx"), source);
	fs.writeFileSync(
		path.join(webroot, ".babelrc"),
		JSON.stringify({ plugins: ["intentionally-not-installed"] }),
	);

	assert.equal(
		scriptOutputPath(webroot, distRoot, source),
		path.join(distRoot, "scripts", "script.js"),
	);

	const outputs = await compileScripts(new Webroot({ webroot }), [source], distRoot);
	assert.deepEqual(outputs, [path.join(distRoot, "scripts", "script.js")]);

	const compiled = fs.readFileSync(
		path.join(distRoot, "scripts", "script.js"),
		"utf8",
	);
	assert.match(compiled, /document\.body\.appendChild\(h\("div"/);
	assert.match(compiled, /THIS_IS_A_GLOBAL/);
	assert.doesNotMatch(compiled, /\bdeclare\b|\bnamespace\b|\bexport\b/);
	assert.match(compiled, /sourceMappingURL=script\.js\.map/);
	assert(fs.statSync(path.join(distRoot, "scripts", "script.js.map")).isFile());
});

test("injects index.astro at the root route", () => {
	let route;
	const page = {
		pattern: "/",
		entrypoint: path.join(example, "index.astro"),
	};
	astralhpIntegration([page]).hooks["astro:config:setup"]({
		injectRoute(value) {
			route = value;
		},
	});

	assert.deepEqual(route, { ...page, prerender: true });
});

test("scans nested and dynamic Astro pages", t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));
	fs.mkdirSync(path.join(webroot, "articles"));
	fs.writeFileSync(path.join(webroot, "index.astro"), "");
	fs.writeFileSync(path.join(webroot, "articles", "index.astro"), "");
	fs.writeFileSync(path.join(webroot, "articles", "[id].astro"), "");

	assert.deepEqual(new Webroot({ webroot }).scanPages(), [
		{
			pattern: "/",
			entrypoint: path.join(webroot, "index.astro"),
		},
		{
			pattern: "/articles",
			entrypoint: path.join(webroot, "articles", "index.astro"),
		},
		{
			pattern: "/articles/[id]",
			entrypoint: path.join(webroot, "articles", "[id].astro"),
		},
	]);
});

test("serves an existing static file from its original location", () => {
	assert.equal(
		exampleWebroot.resolveStaticFile("/square.png"),
		path.join(example, "square.png"),
	);
});

test("uses Apache's MIME type registry", () => {
	assert.equal(contentType("page.HTML"), "text/html");
	assert.equal(contentType("module.js"), "text/javascript");
	assert.equal(contentType("module.wasm"), "application/wasm");
	assert.equal(contentType("unknown.astralhp"), "application/octet-stream");
});

test("does not expose source, private directories, or files outside the web root", () => {
	assert.equal(exampleWebroot.resolveStaticFile("/index.astro"), null);
	assert.equal(exampleWebroot.resolveStaticFile("/script.tsx"), null);
	assert.equal(exampleWebroot.resolveStaticFile("/%2e%2e/package.json"), null);
	assert.equal(exampleWebroot.resolveStaticFile("/.hidden"), null);
	assert.equal(exampleWebroot.resolveStaticFile("/.caches/file.txt"), null);
	assert.equal(exampleWebroot.resolveStaticFile("/assets/node_modules/file.js"), null);
});

test("does not follow a public-looking symlink into a private directory", t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));

	const privateDir = path.join(webroot, "node_modules");
	fs.mkdirSync(privateDir);
	fs.writeFileSync(path.join(privateDir, "secret.txt"), "secret");
	fs.symlinkSync(path.join(privateDir, "secret.txt"), path.join(webroot, "public.txt"));

	assert.equal(new Webroot({ webroot }).resolveStaticFile("/public.txt"), null);
});

test("identifies private directories at any URL depth", () => {
	assert.equal(exampleWebroot.isPrivateRequest("/.caches/file.txt"), true);
	assert.equal(exampleWebroot.isPrivateRequest("/.server/app.mjs"), true);
	assert.equal(exampleWebroot.isPrivateRequest("/assets/node_modules/file.js"), true);
	assert.equal(exampleWebroot.isPrivateRequest("/assets/Node_Modules/file.js"), true);
	assert.equal(exampleWebroot.isPrivateRequest("/assets/file.js"), false);
});

test("keeps tooling caches beside the config and build output inside the webroot", () => {
	const project = path.resolve("project");
	const configFile = path.join(project, "astralhp.mts");
	const site = new Webroot({ webroot: "www" }, configFile);
	assert.equal(site.projectCaches, path.join(project, ".caches"));
	assert.equal(site.astroCache, path.join(project, ".caches/.astro"));
	assert.equal(site.viteCache, path.join(project, ".caches/.astro/vite"));
	assert.equal(site.publicDir, path.join(project, ".caches/.astro/public"));
	assert.equal(site.dist, path.join(project, "www/.caches/dist"));
	assert.equal(site.nextDist, path.join(project, "www/.caches/next-dist"));
	assert.equal(site.previousDist, path.join(project, "www/.caches/previous-dist"));
	for (const sameRoot of [new Webroot({ webroot: "." }, configFile), new Webroot({ webroot: project })]) {
		assert.equal(sameRoot.projectCaches, sameRoot.caches);
		assert.equal(sameRoot.astroCache, path.join(project, ".caches/.astro"));
		assert.equal(sameRoot.viteCache, path.join(sameRoot.astroCache, "vite"));
		assert.equal(sameRoot.dist, path.join(project, ".caches/dist"));
	}
});

test("publishes a completed dist with a quick directory swap", t => {
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
	const paths = {
		dist: path.join(cache, "dist"),
		nextDist: path.join(cache, "next-dist"),
		previousDist: path.join(cache, "previous-dist"),
	};

	fs.mkdirSync(paths.dist);
	fs.writeFileSync(path.join(paths.dist, "index.html"), "old");
	fs.mkdirSync(paths.nextDist);
	fs.writeFileSync(path.join(paths.nextDist, "index.html"), "new");

	publishDist(paths);
	assert.equal(fs.readFileSync(path.join(paths.dist, "index.html"), "utf8"), "new");
	assert.equal(fs.existsSync(paths.nextDist), false);
	assert.equal(fs.existsSync(paths.previousDist), false);
});

test("restores the current dist when publication fails", t => {
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
	const paths = {
		dist: path.join(cache, "dist"),
		nextDist: path.join(cache, "missing-next-dist"),
		previousDist: path.join(cache, "previous-dist"),
	};

	fs.mkdirSync(paths.dist);
	fs.writeFileSync(path.join(paths.dist, "index.html"), "current");

	assert.throws(() => publishDist(paths), /ENOENT/);
	assert.equal(
		fs.readFileSync(path.join(paths.dist, "index.html"), "utf8"),
		"current",
	);
	assert.equal(fs.existsSync(paths.previousDist), false);
});

test("resolves preserve-format dist output", t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	const webroot = new Webroot({ webroot: root });
	const distRoot = webroot.dist;
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(distRoot, { recursive: true });

	fs.writeFileSync(path.join(distRoot, "index.html"), "index");
	fs.writeFileSync(path.join(distRoot, "download.html"), "download");
	fs.mkdirSync(path.join(distRoot, ".server"));
	fs.writeFileSync(path.join(distRoot, ".server", "app.mjs"), "server");

	assert.equal(
		webroot.resolveDistFile("/"),
		fs.realpathSync(path.join(distRoot, "index.html")),
	);
	assert.equal(
		webroot.resolveDistFile("/download"),
		fs.realpathSync(path.join(distRoot, "download.html")),
	);
	assert.equal(webroot.resolveDistFile("/.server/app.mjs"), null);
	assert.equal(webroot.resolveDistFile("/.caches/file.html"), null);
});

test("translates Astro route segments to Apache patterns", () => {
	const translated = (segments, trailingSlash = "ignore") =>
		apacheRoute({ pattern: "/test", segments }, trailingSlash).regex;

	assert.equal(
		translated([
			[{ content: "users", dynamic: false, spread: false }],
			[{ content: "id", dynamic: true, spread: false }],
		]),
		"^users/[^/]+?/?$",
	);
	assert.equal(
		translated([
			[{ content: "files", dynamic: false, spread: false }],
			[{ content: "...path", dynamic: true, spread: true }],
		]),
		"^files(?:/.*?)?/?$",
	);
	assert.equal(
		translated([[
			{ content: "id", dynamic: true, spread: false },
			{ content: ".json", dynamic: false, spread: false },
		]], "never"),
		"^[^/]+?\\.json$",
	);
	assert.equal(
		translated([[
			{ content: "...path", dynamic: true, spread: true },
		]], "always"),
		"^(?:.*?/)?$",
	);
});

test("generates Apache rules in built, static, proxy order", () => {
	const block = apacheBlock(9001, [dynamicApacheRoute]);
	const physical = block.indexOf('RewriteCond "%{REQUEST_FILENAME}" -f');
	const built = block.indexOf(
		'RewriteCond "%{DOCUMENT_ROOT}/.caches/dist/$1" -f',
	);
	const proxy = block.indexOf(
		'RewriteRule "^[^/]+?/?$" "http://127.0.0.1:9001%{REQUEST_URI}"',
	);

	assert.match(block, /THE_REQUEST/);
	assert.match(block, /tolower\(unescape\(%\{THE_REQUEST\}\)\)/);
	assert.match(block, /\.caches\/dist\/\$1\.html/);
	assert.match(
		block,
		/^RequestHeader set X-AstralHP-Document-Root "expr=%\{DOCUMENT_ROOT\}"$/m,
	);
	assert.match(block, /^ProxyPreserveHost On$/m);
	assert(physical > 0);
	assert(built > 0);
	assert(physical > built);
	assert(proxy > physical);
	assert.doesNotMatch(block, /RewriteRule "\^" "http:/);
});

test("omits proxy rules when every Astro route is prerendered", () => {
	assert.doesNotMatch(apacheBlock(9001), /http:\/\/127\.0\.0\.1/);
	assert.doesNotMatch(apacheBlock(9001), /X-AstralHP-Document-Root/);
	assert.doesNotMatch(apacheBlock(9001), /ProxyPreserveHost/);
});

test("resolves prerendered routes without generating proxy patterns", () => {
	assert.deepEqual(
		resolveApacheRoutes({
			routes: [{ ...dynamicAstroRoute, isPrerendered: true }],
			trailingSlash: "ignore",
		}),
		[],
	);
});

test("resolves dynamic pages into specific proxy patterns", () => {
	assert.deepEqual(
		resolveApacheRoutes({
			routes: [dynamicAstroRoute],
			trailingSlash: "ignore",
		}),
		[dynamicApacheRoute],
	);
});

test("runs the JavaScript build API in an isolated worker", async t => {
	const webroot = fs.mkdtempSync(
		path.resolve(__dirname, "../.astralhp-test-worker-"),
	);
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));
	fs.writeFileSync(
		path.join(webroot, "index.astro"),
		[
			"---",
			"export const prerender = true;",
			"---",
			'<p id="pid">{process.pid}</p>',
		].join("\n"),
	);

	const site = new Webroot({ webroot });
	assert.equal(await buildAstralHP(site), site.dist);
	const html = fs.readFileSync(path.join(site.dist, "index.html"), "utf8");
	const pid = html.match(/<p id="pid">(\d+)<\/p>/)?.[1];
	assert(pid);
	assert.notEqual(Number(pid), process.pid);
});

test("builds the configured Apache proxy adapter", async t => {
	const project = fs.mkdtempSync(
		path.resolve(__dirname, "../.astralhp-test-project-"),
	);
	const webroot = path.join(project, "public");
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.mkdirSync(webroot);
	fs.writeFileSync(
		path.join(project, "astralhp.mts"),
		[
			"export const config: import('astralhp').Config = {",
			"\twebroot: 'public',",
			"\tadapter: 'apache-proxy',",
			"\tport: 9001,",
			"};",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(webroot, "index.astro"),
		[
			"---",
			'import { CSS } from "astralhp/components";',
			"export const prerender = true;",
			"---",
			'<CSS src="style.css" />',
			"Built by AstralHP",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(webroot, "live.astro"),
		[
			"---",
			"export const prerender = false;",
			"---",
			"Rendered dynamically",
		].join("\n"),
	);
	fs.writeFileSync(path.join(webroot, "style.css"), "");
	const environment = { ...process.env };
	delete environment.PORT;

	const result = spawnSync(
		process.execPath,
		[path.resolve(__dirname, "../astralhp"), "build", "public"],
		{
			cwd: project,
			encoding: "utf8",
			env: environment,
		},
	);

	assert.equal(result.status, 0, result.stderr);
	assert(fs.statSync(path.join(project, ".caches/.astro/types.d.ts")).isFile());
	assert.match(
		fs.readFileSync(path.join(webroot, ".caches/dist/index.html"), "utf8"),
		/Built by AstralHP$/,
	);
	const serverEntrypoint = path.join(
		webroot,
		".caches/dist/.server/app.mjs",
	);
	assert(fs.statSync(serverEntrypoint).isFile());
	assert.equal(
		typeof (await import(pathToFileURL(serverEntrypoint).href)).handler,
		"function",
	);
	const htaccess = fs.readFileSync(path.join(webroot, ".htaccess"), "utf8");
	assert.match(
		htaccess,
		/^# ===== BEGIN ASTRALHP =====$/m,
	);
	assert.match(htaccess, /RewriteRule "\^live\/\?\$"/);
	assert.match(htaccess, /X-AstralHP-Document-Root/);
});

test("replaces only AstralHP's managed Apache section", t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	const site = new Webroot({ webroot, adapter: "apache-proxy" });
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));
	const filename = path.join(webroot, ".htaccess");
	fs.writeFileSync(
		filename,
		[
			"# user rule before",
			"# ===== BEGIN ASTRALHP =====",
			"old generated rule",
			"# ===== END ASTRALHP =====",
			"# user rule after",
			"",
		].join("\n"),
	);

	assert.equal(
		writeApacheConfig(site, 9001, [dynamicApacheRoute]),
		filename,
	);
	const generated = fs.readFileSync(filename, "utf8");
	assert.match(generated, /^# user rule before$/m);
	assert.match(generated, /^# user rule after$/m);
	assert.doesNotMatch(generated, /old generated rule/);
	assert.match(generated, /127\.0\.0\.1:9001/);

	writeApacheConfig(site, 9001, [dynamicApacheRoute]);
	assert.equal(fs.readFileSync(filename, "utf8"), generated);
});

test("appends an AstralHP section when none can be located", () => {
	const updated = replaceApacheBlock(
		"# user rule\n",
		apacheBlock(9001, [dynamicApacheRoute]),
	);

	assert.match(updated, /^# user rule\n\n# ===== BEGIN ASTRALHP =====/);
	assert.match(updated, /127\.0\.0\.1:9001/);
	assert.match(updated, /# ===== END ASTRALHP =====\n$/);
});

test("rejects malformed managed Apache sections", () => {
	assert.throws(
		() => replaceApacheBlock("# ===== BEGIN ASTRALHP =====\n", apacheBlock()),
		/exactly one/,
	);
	assert.throws(
		() =>
			replaceApacheBlock(
				[
					"# ===== BEGIN ASTRALHP =====",
					"# ===== END ASTRALHP =====",
					"# ===== END ASTRALHP =====",
					"",
				].join("\n"),
				apacheBlock(),
			),
		/exactly one/,
	);
});

test("documents all commands", () => {
	const result = spawnSync(process.execPath, [path.resolve(__dirname, "../astralhp"), "--help"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0);
	assert.equal(
		result.stdout.trim(),
		"Usage: astralhp [<init|dev|build|start> [directory]]",
	);
	assert.equal(result.stderr, "");
});

test("lists every discovered webroot when no command is given", t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	const first = path.join(project, "first");
	const second = path.join(project, "second");
	fs.mkdirSync(first);
	fs.mkdirSync(second);
	fs.writeFileSync(
		path.join(first, "astralhp.mts"),
		"export const config = { webroot: 'public' };",
	);
	fs.writeFileSync(
		path.join(second, ".astralhp.mts"),
		"export const config = {};",
	);

	const result = spawnSync(
		process.execPath,
		[path.resolve(__dirname, "../astralhp")],
		{ cwd: project, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		result.stdout.trim(),
		["AstralHP webroots:", "  first/public", "  second"].join("\n"),
	);
	assert.equal(result.stderr, "");
});

test("builds every discovered webroot", t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	const first = path.join(project, "first");
	const second = path.join(project, "second");
	for (const webroot of [first, second]) {
		fs.mkdirSync(webroot);
		fs.writeFileSync(
			path.join(webroot, "astralhp.mts"),
			"export const config = {};",
		);
		fs.writeFileSync(
			path.join(webroot, "index.astro"),
			"---\nexport const prerender = true;\n---\nBuilt",
		);
	}

	const result = spawnSync(
		process.execPath,
		[path.resolve(__dirname, "../astralhp"), "build"],
		{ cwd: project, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	for (const webroot of [first, second]) {
		assert(fs.statSync(path.join(webroot, ".caches/dist/index.html")).isFile());
		assert.equal(fs.existsSync(path.join(webroot, ".caches/dist/.server")), false);
		assert.match(fs.readFileSync(path.join(webroot, ".htaccess"), "utf8"), /Serve built files/);
	}
});

test("requires a discoverable webroot when the directory is omitted", t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

	const result = spawnSync(
		process.execPath,
		[path.resolve(__dirname, "../astralhp"), "build"],
		{ cwd: directory, encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Could not find astralhp\.mts or \.astralhp\.mts/);
	assert.match(result.stderr, /specify a webroot directory/);
	assert.equal(fs.existsSync(path.join(directory, ".caches")), false);
});

test("does not load executable configuration for an invalid command", t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astralhp-test-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.writeFileSync(
		path.join(project, "astralhp.mts"),
		'throw new Error("configuration executed");',
	);

	const result = spawnSync(
		process.execPath,
		[path.resolve(__dirname, "../astralhp"), "invalid"],
		{ cwd: project, encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Usage: astralhp/);
	assert.doesNotMatch(result.stderr, /configuration executed/);
});
