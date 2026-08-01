import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Config } from "./config.d.ts";
import { Webroot } from "./webroot.ts";

const CONFIG_FILENAMES = ["astrohp.mts", ".astrohp.mts"] as const;
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".caches"]);

function configIn(directory: string): string | null {
	const matches: string[] = [];
	for (const basename of CONFIG_FILENAMES) {
		const filename = path.join(directory, basename);
		try {
			if (fs.statSync(filename).isFile()) matches.push(filename);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (matches.length > 1) {
		throw new Error(
			`Found both ${CONFIG_FILENAMES.join(" and ")} in ${directory}`,
		);
	}
	return matches[0] ?? null;
}

function findChildConfigs(directory: string, configs: string[]): void {
	const config = configIn(directory);
	if (config) configs.push(config);

	const entries = fs.readdirSync(directory, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
		findChildConfigs(path.join(directory, entry.name), configs);
	}
}

export function findConfigs(workingDirectory = process.cwd()): string[] {
	workingDirectory = path.resolve(workingDirectory);
	const configs: string[] = [];
	findChildConfigs(workingDirectory, configs);

	let directory = path.dirname(workingDirectory);
	while (directory !== workingDirectory) {
		const config = configIn(directory);
		if (config) configs.push(config);
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return configs;
}

async function importConfig(filename: string): Promise<Config> {
	const url = pathToFileURL(filename);
	url.searchParams.set("mtime", String(fs.statSync(filename).mtimeMs));
	const module = await import(url.href) as Record<string, unknown>;
	if (!("config" in module)) {
		throw new Error(`${filename} must export a configuration object named "config"`);
	}
	return module.config as Config;
}

export async function selectWebroot(
	root?: string,
	workingDirectory = process.cwd(),
): Promise<Webroot> {
	workingDirectory = path.resolve(workingDirectory);
	const webroots = await discoverWebroots(workingDirectory);
	if (root !== undefined) {
		const requestedRoot = path.resolve(workingDirectory, root);
		const matches = webroots.filter(webroot => webroot.path === requestedRoot);
		if (matches.length > 1) {
			throw new Error(`Found multiple configurations for ${requestedRoot}`);
		}
		if (matches[0]) return matches[0];
		return new Webroot({ webroot: requestedRoot });
	}
	if (!webroots.length) {
		throw new Error(
			`Could not find ${CONFIG_FILENAMES.join(" or ")}; specify a webroot directory`,
		);
	}
	if (webroots.length > 1) {
		throw new Error(
			`Found multiple AstroHP webroots; specify one:\n${webroots.map(webroot => webroot.path).join("\n")}`,
		);
	}
	return webroots[0]!;
}

export async function discoverWebroots(
	workingDirectory = process.cwd(),
): Promise<Webroot[]> {
	return Promise.all(
		findConfigs(workingDirectory).map(async filename => {
			const config = await importConfig(filename);
			return new Webroot(config, filename);
		}),
	);
}
