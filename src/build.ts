import fs from "node:fs";
import path from "node:path";
import { compileScripts } from "./babel.ts";
import { astroConfig, getWebrootPaths } from "./webroot.ts";

export async function buildSite(root = process.cwd()): Promise<string> {
	process.env.ASTRO_TELEMETRY_DISABLED ||= "1";
	const paths = getWebrootPaths(root);
	const { build } = await import("astro");

	await build({
		...astroConfig(root),
		outDir: paths.build,
		build: {
			format: "preserve",
		},
	});
	await compileScripts(paths);

	if (!fs.existsSync(path.join(paths.build, "index.html"))) {
		throw new Error(`Build did not produce ${path.join(paths.build, "index.html")}`);
	}
	return paths.build;
}
