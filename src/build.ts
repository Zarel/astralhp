import type * as astro from "astro";
import fs from "node:fs";
import path from "node:path";
import { generateApacheConfig } from "./apache.js";
import { compileScripts, type ScriptCache } from "./babel.js";
import type { AssetBundles } from "./bundles.js";
import { serverPort } from "./live-server.js";
import type { AstralHPResolvedRoutes, Webroot } from "./webroot.js";

type DistPaths = Pick<
	Webroot,
	"dist" | "nextDist" | "previousDist"
>;

function removeDirectory(directory: string): void {
	fs.rmSync(directory, { recursive: true, force: true });
}

function removeEmptyDirectory(directory: string): void {
	try {
		fs.rmdirSync(directory);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			!["ENOENT", "ENOTEMPTY"].includes(String(error.code))
		) {
			throw error;
		}
	}
}

export function publishDist(paths: DistPaths): void {
	if (!fs.existsSync(paths.dist) && fs.existsSync(paths.previousDist)) {
		fs.renameSync(paths.previousDist, paths.dist);
	}
	removeDirectory(paths.previousDist);

	let savedPrevious = false;
	try {
		if (fs.existsSync(paths.dist)) {
			fs.renameSync(paths.dist, paths.previousDist);
			savedPrevious = true;
		}
		fs.renameSync(paths.nextDist, paths.dist);
	} catch (error) {
		if (savedPrevious && !fs.existsSync(paths.dist)) {
			fs.renameSync(paths.previousDist, paths.dist);
		}
		throw error;
	}

	removeDirectory(paths.previousDist);
}

export async function buildSite(
	webroot: Webroot,
	config: astro.AstroInlineConfig,
	resolvedRoutes: () => AstralHPResolvedRoutes | undefined,
	legacySources: Iterable<string> = [],
	bundles?: AssetBundles,
	legacyCache?: ScriptCache,
): Promise<string> {
	process.env.ASTRO_TELEMETRY_DISABLED ||= "1";
	const { build } = await import("astro");
	if (!fs.existsSync(webroot.dist) && fs.existsSync(webroot.previousDist)) {
		fs.renameSync(webroot.previousDist, webroot.dist);
	}
	removeDirectory(webroot.nextDist);

	const fallbackAstro = path.resolve(".astro");
	const cleanupFallback = fallbackAstro !== webroot.astroCache &&
		!fs.existsSync(fallbackAstro);
	try {
		await build({
			...config,
			outDir: webroot.nextDist,
			build: {
				...config.build,
				format: "preserve",
			},
		});
	} finally {
		if (cleanupFallback) removeEmptyDirectory(fallbackAstro);
	}
	await bundles?.writeTo(webroot.nextDist, legacySources);
	await compileScripts(webroot, legacySources, webroot.nextDist, legacyCache);

	if (webroot.adapter === "apache-cgi") {
		const server = path.join(webroot.nextDist, ".server");
		for (const name of ["cgi-runtime", "cgi"]) {
			let code = fs.readFileSync(new URL(`./cgi-server/${name}.js`, import.meta.url), "utf8");
			// These modules are copied outside the package as .mjs files. Their
			// sibling imports must use the deployed extension, too.
			code = code.replace(/(["']\.\/[^"']+)\.js(["'])/g, "$1.mjs$2")
				.replace(/^\/\/# sourceMappingURL=.*$/m, "");
			if (name === "cgi") code = `#!${webroot.runtimePath ?? "/usr/bin/env bun"}\n${code}`;
			fs.writeFileSync(path.join(server, `${name}.mjs`), code, { mode: name === "cgi" ? 0o755 : 0o644 });
		}
	}
	publishDist(webroot);
	if (webroot.adapter !== "node") {
		const resolved = resolvedRoutes();
		if (!resolved) throw new Error("Astro did not resolve the AstralHP routes");
		console.log(
			generateApacheConfig(
				webroot,
				resolved,
				webroot.adapter === "apache-proxy" ? serverPort(webroot.port) : webroot.port,
			),
		);
	}
	return webroot.dist;
}
