import type * as astro from "astro";
import fs from "node:fs";
import path from "node:path";
import { generateApacheConfig } from "./apache.ts";
import { compileScripts } from "./babel.ts";
import { serverPort } from "./live-server.ts";
import type { AstrohpResolvedRoutes, Webroot } from "./webroot.ts";

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

	if (!fs.existsSync(path.join(webroot.nextDist, "index.html"))) {
		throw new Error(
			`Build did not produce ${path.join(webroot.nextDist, "index.html")}`,
		);
	}
	publishDist(webroot);
	if (webroot.adapter === "apache-proxy") {
		const resolved = resolvedRoutes();
		if (!resolved) throw new Error("Astro did not resolve the AstroHP routes");
		console.log(
			generateApacheConfig(webroot, resolved, serverPort(webroot.port)),
		);
	}
	return webroot.dist;
}
