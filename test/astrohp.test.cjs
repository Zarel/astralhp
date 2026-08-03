"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const { build: buildAstroHP } = require("astrohp");

const {
	compileScripts,
	scanBabelSources,
	scriptOutputPath,
} = require("../src/babel.ts");
const {
	apacheRoute,
	apacheBlock,
	replaceApacheBlock,
	resolveApacheRoutes,
	writeApacheConfig,
} = require("../src/apache.ts");
const { publishDist } = require("../src/build.ts");
const { cachebust, cachebustScript } = require("../src/cachebuster.ts");
const {
	discoverWebroots,
	findConfigs,
	selectWebroot,
} = require("../src/config-loader.ts");
const { contentType } = require("../src/mime.ts");
const {
	AstroHPServer,
	serverPort,
} = require("../src/live-server.ts");
const { astrohpIntegration, Webroot } = require("../src/webroot.ts");

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

test("exports package entrypoints", () => {
	assert.equal(
		require.resolve("astrohp"),
		path.resolve(__dirname, "../src/index.ts"),
	);
	const astrohp = require("astrohp");
	assert.equal(typeof astrohp.build, "function");
	assert.equal(typeof astrohp.dev, "function");
	assert.equal(typeof astrohp.start, "function");
	assert.equal(typeof astrohp.Webroot, "function");
	assert.equal(
		require.resolve("astrohp/components"),
		path.resolve(__dirname, "../src/components/index.js"),
	);
	const componentIndex = fs.readFileSync(
		path.resolve(__dirname, "../src/components/index.js"),
		"utf8",
	);
	assert.match(componentIndex, /default as CSS/);
	assert.match(componentIndex, /default as JS/);
});

test("loads typed configuration from the working directory", async t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	const webroot = path.join(project, "public");
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.mkdirSync(webroot);
	const filename = path.join(project, "astrohp.mts");
	fs.writeFileSync(
		filename,
		[
			"export const config: import('astrohp').Config = {",
			"\twebroot: 'public',",
			"\tadapter: 'apache-proxy',",
			"\tport: 9001,",
			"};",
		].join("\n"),
	);

	assert.deepEqual(
		await selectWebroot(undefined, project),
		new Webroot({
			webroot: "public",
			adapter: "apache-proxy",
			port: 9001,
		}, filename),
	);
});

test("finds configurations in descendants and ancestor directories", async t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	const workspace = path.join(project, "workspace");
	const alpha = path.join(workspace, "sites", "alpha");
	const beta = path.join(workspace, "sites", "beta");
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.mkdirSync(alpha, { recursive: true });
	fs.mkdirSync(beta);
	fs.mkdirSync(path.join(workspace, "node_modules", "ignored"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".astrohp.mts"),
		"export const config = { webroot: 'parent-public' };",
	);
	fs.writeFileSync(
		path.join(alpha, "astrohp.mts"),
		"export const config = { webroot: 'public' };",
	);
	fs.writeFileSync(
		path.join(beta, ".astrohp.mts"),
		"export const config = {};",
	);
	fs.writeFileSync(
		path.join(workspace, "node_modules", "ignored", "astrohp.mts"),
		'throw new Error("ignored configuration executed");',
	);

	assert.deepEqual(findConfigs(workspace), [
		path.join(alpha, "astrohp.mts"),
		path.join(beta, ".astrohp.mts"),
		path.join(project, ".astrohp.mts"),
	]);
	assert.deepEqual(
		(await discoverWebroots(workspace)).map(webroot => webroot.path),
		[
			path.join(alpha, "public"),
			beta,
			path.join(project, "parent-public"),
		],
	);
});

test("rejects both configuration names in one directory", t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.writeFileSync(path.join(project, "astrohp.mts"), "export const config = {};");
	fs.writeFileSync(path.join(project, ".astrohp.mts"), "export const config = {};");

	assert.throws(
		() => findConfigs(project),
		/Found both astrohp\.mts and \.astrohp\.mts/,
	);
});

test("uses the requested directory and node adapter without configuration", async t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));

	assert.deepEqual(
		await selectWebroot(webroot, webroot),
		new Webroot({ webroot }),
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
	const alpha = new Webroot({ webroot: example });
	assert.equal(new AstroHPServer([alpha], { port: 0 }).webrootForRequest(undefined), alpha);
	const beta = new Webroot({ webroot: path.dirname(example) });
	assert.throws(
		() => new AstroHPServer([alpha, beta], { port: 0 }),
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
	const server = new AstroHPServer([alpha, beta], { port: 0 });

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
	const node = new Webroot({ webroot: path.dirname(example) });
	const server = new AstroHPServer([apache, node], { port: 0 });

	assert.equal(server.webrootForRequest(undefined), node);
	assert.equal(server.webrootForRequest("/unknown"), null);
});

test("rejects invalid executable configuration", async t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.writeFileSync(
		path.join(project, "astrohp.mts"),
		"export const config = { unknown: true };",
	);

	await assert.rejects(
		() => selectWebroot(undefined, project),
		/Unknown AstroHP configuration option: unknown/,
	);
});

test("cachebusts a local asset with its base-36 modification time", t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	const site = new Webroot({ webroot });
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));

	const filename = path.join(webroot, "style.css");
	fs.writeFileSync(filename, "style");
	fs.utimesSync(filename, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
	assert.equal(
		cachebust(site, "/style.css", new URL("https://example.test/page")),
		`/style.css?${(1_700_000_000_000).toString(36)}`,
	);

	fs.utimesSync(filename, new Date(1_700_000_001_000), new Date(1_700_000_001_000));
	assert.equal(
		cachebust(site, "/style.css", new URL("https://example.test/page")),
		`/style.css?${(1_700_000_001_000).toString(36)}`,
	);
});

test("maps TypeScript script URLs to cachebusted JavaScript", t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	const site = new Webroot({ webroot });
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));

	const filename = path.join(webroot, "script.tsx");
	fs.writeFileSync(filename, "script");
	fs.utimesSync(filename, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
	assert.equal(
		cachebustScript(
			site,
			"script.tsx",
			new URL("https://example.test/page"),
		),
		`script.js?${(1_700_000_000_000).toString(36)}`,
	);
});

test("resolves cachebusted assets relative to the rendered page", t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	const site = new Webroot({ webroot });
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));

	fs.mkdirSync(path.join(webroot, "articles"));
	const filename = path.join(webroot, "articles", "style.css");
	fs.writeFileSync(filename, "style");
	fs.utimesSync(filename, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
	const suffix = (1_700_000_000_000).toString(36);

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
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	const site = new Webroot({ webroot });
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));
	const base = new URL("https://example.test/");

	assert.throws(() => cachebust(site, "", base), /relative or root-relative URL/);
	assert.throws(() => cachebust(site, "//example.com/style.css", base), /relative or root-relative URL/);
	assert.throws(() => cachebust(site, "https://example.com/style.css", base), /relative or root-relative URL/);
	assert.throws(() => cachebust(site, "/style.css?old", base), /query or fragment/);
	assert.throws(() => cachebust(site, "/missing.css", base), /does not exist/);
});

test("compiles directory TypeScript targets into the build", async t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));
	t.after(() => fs.rmSync(distRoot, { recursive: true, force: true }));

	const source = path.join(webroot, "scripts", "script.tsx");
	fs.mkdirSync(path.dirname(source));
	fs.copyFileSync(path.join(example, "script.tsx"), source);
	fs.writeFileSync(
		path.join(webroot, ".babelrc"),
		JSON.stringify({ plugins: ["intentionally-not-installed"] }),
	);

	assert.deepEqual(scanBabelSources(webroot), [source]);
	assert.equal(
		scriptOutputPath(webroot, distRoot, source),
		path.join(distRoot, "scripts", "script.js"),
	);

	const outputs = await compileScripts(new Webroot({ webroot }), distRoot);
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
	astrohpIntegration([page]).hooks["astro:config:setup"]({
		injectRoute(value) {
			route = value;
		},
	});

	assert.deepEqual(route, page);
});

test("scans nested and dynamic Astro pages", t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
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
	assert.equal(contentType("unknown.astrohp"), "application/octet-stream");
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
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));

	const privateDir = path.join(webroot, "node_modules");
	fs.mkdirSync(privateDir);
	fs.writeFileSync(path.join(privateDir, "secret.txt"), "secret");
	fs.symlinkSync(path.join(privateDir, "secret.txt"), path.join(webroot, "public.txt"));

	assert.equal(new Webroot({ webroot }).resolveStaticFile("/public.txt"), null);
});

test("identifies private directories at any URL depth", () => {
	assert.equal(exampleWebroot.isPrivateRequest("/.caches/file.txt"), true);
	assert.equal(exampleWebroot.isPrivateRequest("/.server/entry.mjs"), true);
	assert.equal(exampleWebroot.isPrivateRequest("/assets/node_modules/file.js"), true);
	assert.equal(exampleWebroot.isPrivateRequest("/assets/Node_Modules/file.js"), true);
	assert.equal(exampleWebroot.isPrivateRequest("/assets/file.js"), false);
});

test("places generated files in a hidden directory inside the webroot", t => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
	const webroot = path.join(parent, "project");
	fs.mkdirSync(webroot, { recursive: true });
	const cache = path.join(webroot, ".caches");

	assert.deepEqual({ ...new Webroot({ webroot }) }, {
		path: webroot,
		configFile: null,
		adapter: "node",
		port: 4321,
		caches: cache,
		astroCache: path.join(cache, ".astro"),
		dist: path.join(cache, "dist"),
		nextDist: path.join(cache, "next-dist"),
		previousDist: path.join(cache, "previous-dist"),
		publicDir: path.join(cache, ".astro", "public"),
		viteCache: path.join(cache, ".astro", "vite"),
	});
});

test("publishes a completed dist with a quick directory swap", t => {
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
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
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	const webroot = new Webroot({ webroot: root });
	const distRoot = webroot.dist;
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(distRoot, { recursive: true });

	fs.writeFileSync(path.join(distRoot, "index.html"), "index");
	fs.writeFileSync(path.join(distRoot, "download.html"), "download");
	fs.mkdirSync(path.join(distRoot, ".server"));
	fs.writeFileSync(path.join(distRoot, ".server", "entry.mjs"), "server");

	assert.equal(
		webroot.resolveDistFile("/"),
		fs.realpathSync(path.join(distRoot, "index.html")),
	);
	assert.equal(
		webroot.resolveDistFile("/download"),
		fs.realpathSync(path.join(distRoot, "download.html")),
	);
	assert.equal(webroot.resolveDistFile("/.server/entry.mjs"), null);
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

test("generates Apache rules in static, built, proxy order", () => {
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
		/^RequestHeader set X-AstroHP-Document-Root "expr=%\{DOCUMENT_ROOT\}"$/m,
	);
	assert.match(block, /^ProxyPreserveHost On$/m);
	assert(physical > 0);
	assert(built > physical);
	assert(proxy > built);
	assert.doesNotMatch(block, /RewriteRule "\^" "http:/);
	assert.doesNotMatch(block, /\d{8}-[a-z\d]+/i);
});

test("omits proxy rules when every Astro route is prerendered", () => {
	assert.doesNotMatch(apacheBlock(9001), /http:\/\/127\.0\.0\.1/);
	assert.doesNotMatch(apacheBlock(9001), /X-AstroHP-Document-Root/);
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
		path.resolve(__dirname, "../.astrohp-test-worker-"),
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
	assert.equal(await buildAstroHP(site), site.dist);
	const html = fs.readFileSync(path.join(site.dist, "index.html"), "utf8");
	const pid = html.match(/<p id="pid">(\d+)<\/p>/)?.[1];
	assert(pid);
	assert.notEqual(Number(pid), process.pid);
});

test("builds the configured Apache proxy adapter", async t => {
	const project = fs.mkdtempSync(
		path.resolve(__dirname, "../.astrohp-test-project-"),
	);
	const webroot = path.join(project, "public");
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.mkdirSync(webroot);
	fs.writeFileSync(
		path.join(project, "astrohp.mts"),
		[
			"export const config: import('astrohp').Config = {",
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
			'import { CSS } from "astrohp/components";',
			"export const prerender = true;",
			"---",
			'<CSS src="style.css" />',
			"Built by AstroHP",
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
		[path.resolve(__dirname, "../astrohp"), "build", "public"],
		{
			cwd: project,
			encoding: "utf8",
			env: environment,
		},
	);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.existsSync(path.join(project, ".astro")), false);
	assert.match(
		fs.readFileSync(path.join(webroot, ".caches/dist/index.html"), "utf8"),
		/Built by AstroHP$/,
	);
	const serverEntrypoint = path.join(
		webroot,
		".caches/dist/.server/entry.mjs",
	);
	assert(fs.statSync(serverEntrypoint).isFile());
	assert.equal(
		typeof (await import(pathToFileURL(serverEntrypoint).href)).handler,
		"function",
	);
	const htaccess = fs.readFileSync(path.join(webroot, ".htaccess"), "utf8");
	assert.match(
		htaccess,
		/^# ===== BEGIN ASTROHP =====$/m,
	);
	assert.match(htaccess, /RewriteRule "\^live\/\?\$"/);
	assert.match(htaccess, /X-AstroHP-Document-Root/);
});

test("replaces only AstroHP's managed Apache section", t => {
	const webroot = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	const site = new Webroot({ webroot });
	t.after(() => fs.rmSync(webroot, { recursive: true, force: true }));
	const filename = path.join(webroot, ".htaccess");
	fs.writeFileSync(
		filename,
		[
			"# user rule before",
			"# ===== BEGIN ASTROHP =====",
			"old generated rule",
			"# ===== END ASTROHP =====",
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

test("upgrades legacy AstroHP section markers", () => {
	const updated = replaceApacheBlock(
		"# BEGIN ASTROHP\nold generated rule\n# END ASTROHP\n",
		apacheBlock(9001),
	);

	assert.match(updated, /^# ===== BEGIN ASTROHP =====$/m);
	assert.match(updated, /^# ===== END ASTROHP =====$/m);
	assert.doesNotMatch(updated, /^# (?:BEGIN|END) ASTROHP$/m);
	assert.doesNotMatch(updated, /old generated rule/);
});

test("appends an AstroHP section when none can be located", () => {
	const updated = replaceApacheBlock(
		"# user rule\n",
		apacheBlock(9001, [dynamicApacheRoute]),
	);

	assert.match(updated, /^# user rule\n\n# ===== BEGIN ASTROHP =====/);
	assert.match(updated, /127\.0\.0\.1:9001/);
	assert.match(updated, /# ===== END ASTROHP =====\n$/);
});

test("rejects malformed managed Apache sections", () => {
	assert.throws(
		() => replaceApacheBlock("# ===== BEGIN ASTROHP =====\n", apacheBlock()),
		/exactly one/,
	);
	assert.throws(
		() =>
			replaceApacheBlock(
				[
					"# ===== BEGIN ASTROHP =====",
					"# ===== END ASTROHP =====",
					"# ===== END ASTROHP =====",
					"",
				].join("\n"),
				apacheBlock(),
			),
		/exactly one/,
	);
});

test("documents all commands", () => {
	const result = spawnSync(process.execPath, [path.resolve(__dirname, "../astrohp"), "--help"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0);
	assert.equal(
		result.stdout.trim(),
		"Usage: astrohp [<dev|build|start> [directory]]",
	);
	assert.equal(result.stderr, "");
});

test("lists every discovered webroot when no command is given", t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	const first = path.join(project, "first");
	const second = path.join(project, "second");
	fs.mkdirSync(first);
	fs.mkdirSync(second);
	fs.writeFileSync(
		path.join(first, "astrohp.mts"),
		"export const config = { webroot: 'public' };",
	);
	fs.writeFileSync(
		path.join(second, ".astrohp.mts"),
		"export const config = {};",
	);

	const result = spawnSync(
		process.execPath,
		[path.resolve(__dirname, "../astrohp")],
		{ cwd: project, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		result.stdout.trim(),
		["AstroHP webroots:", "  first/public", "  second"].join("\n"),
	);
	assert.equal(result.stderr, "");
});

test("builds every discovered webroot", t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	const first = path.join(project, "first");
	const second = path.join(project, "second");
	for (const webroot of [first, second]) {
		fs.mkdirSync(webroot);
		fs.writeFileSync(
			path.join(webroot, "astrohp.mts"),
			"export const config = {};",
		);
		fs.writeFileSync(
			path.join(webroot, "index.astro"),
			"---\nexport const prerender = true;\n---\nBuilt",
		);
	}

	const result = spawnSync(
		process.execPath,
		[path.resolve(__dirname, "../astrohp"), "build"],
		{ cwd: project, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	for (const webroot of [first, second]) {
		assert(fs.statSync(path.join(webroot, ".caches/dist/index.html")).isFile());
		assert(fs.statSync(path.join(webroot, ".caches/dist/.server/entry.mjs")).isFile());
	}
});

test("requires a discovered config when the webroot is omitted", t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

	const result = spawnSync(
		process.execPath,
		[path.resolve(__dirname, "../astrohp"), "build"],
		{ cwd: directory, encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Could not find astrohp\.mts or \.astrohp\.mts/);
	assert.match(result.stderr, /specify a webroot directory/);
	assert.equal(fs.existsSync(path.join(directory, ".caches")), false);
});

test("does not load executable configuration for an invalid command", t => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "astrohp-test-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	fs.writeFileSync(
		path.join(project, "astrohp.mts"),
		'throw new Error("configuration executed");',
	);

	const result = spawnSync(
		process.execPath,
		[path.resolve(__dirname, "../astrohp"), "invalid"],
		{ cwd: project, encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Usage: astrohp/);
	assert.doesNotMatch(result.stderr, /configuration executed/);
});
