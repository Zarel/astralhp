import fs from "node:fs";
import path from "node:path";
import { compileScripts } from "./babel.ts";
import { astroConfig, getWebrootPaths, type WebrootPaths } from "./webroot.ts";

type DistPaths = Pick<
	WebrootPaths,
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

export async function buildSite(root = process.cwd()): Promise<string> {
	process.env.ASTRO_TELEMETRY_DISABLED ||= "1";
	const paths = getWebrootPaths(root);
	const config = astroConfig(paths.webroot);
	const { build } = await import("astro");
	if (!fs.existsSync(paths.dist) && fs.existsSync(paths.previousDist)) {
		fs.renameSync(paths.previousDist, paths.dist);
	}
	removeDirectory(paths.nextDist);

	const fallbackAstro = path.resolve(".astro");
	const cleanupFallback = (
		fallbackAstro !== paths.astro &&
		!fs.existsSync(fallbackAstro)
	);
	try {
		await build({
			...config,
			outDir: paths.nextDist,
			build: {
				format: "preserve",
			},
		});
	} finally {
		if (cleanupFallback) removeEmptyDirectory(fallbackAstro);
	}
	await compileScripts({ webroot: paths.webroot, dist: paths.nextDist });

	if (!fs.existsSync(path.join(paths.nextDist, "index.html"))) {
		throw new Error(
			`Build did not produce ${path.join(paths.nextDist, "index.html")}`,
		);
	}
	publishDist(paths);
	return paths.dist;
}
