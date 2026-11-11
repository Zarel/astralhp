import type * as astro from "astro";
import fs from "node:fs";
import path from "node:path";
import { generateApacheConfig } from "./apache.js";
import { compileScripts } from "./babel.js";
import { serverPort } from "./live-server.js";
import type { AstrohpResolvedRoutes, Webroot } from "./webroot.js";

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
	resolvedRoutes: () => AstrohpResolvedRoutes | undefined,
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
	await compileScripts(webroot, webroot.nextDist);

	if (webroot.adapter === "apache-cgi") {
		const server = path.join(webroot.nextDist, ".server");
		fs.copyFileSync(new URL("./cgi.js", import.meta.url), path.join(server, "cgi.mjs"));
		const launcher = path.join(server, "astrohp.mjs");
		fs.writeFileSync(
			launcher,
			[
				`#!${webroot.runtimePath ?? "/usr/bin/env bun"}`,
				'import { runCGI } from "./cgi.mjs";',
				'try { await runCGI(() => import("./entry.mjs")); }',
				"catch (error) { console.error(error); process.exit(1); }",
				"process.exit(0);",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
	}
	publishDist(webroot);
	if (webroot.adapter === "apache-proxy" || webroot.adapter === "apache-cgi") {
		const resolved = resolvedRoutes();
		if (!resolved) throw new Error("Astro did not resolve the AstroHP routes");
		console.log(
			generateApacheConfig(
				webroot,
				resolved,
				webroot.adapter === "apache-cgi" ? webroot.port : serverPort(webroot.port),
			),
		);
	}
	return webroot.dist;
}
