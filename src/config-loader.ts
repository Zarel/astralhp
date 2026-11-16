import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Adapter, Config, WebrootConfig } from "./config.d.ts";

const CONFIG_FILENAMES = ["astrohp.mts", ".astrohp.mts"] as const;
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".caches"]);
const ADAPTERS = new Set<Adapter>(["node", "apache-proxy", "apache-cgi", "apache-static"]);

/** Check without importing executable configuration or following symlinks. */
export function assertCanCreateConfig(directory: string): void {
	for (const basename of CONFIG_FILENAMES) {
		const filename = path.resolve(directory, basename);
		try {
			fs.lstatSync(filename);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		throw new Error(`Configuration already exists: ${filename}`);
	}
}

export function formatConfig(config: Config): string {
	validateConfig(config, "Configuration");
	return `export const config: import("astrohp").Config = ${JSON.stringify(config, null, "\t")};\n`;
}

/** Create a config; existing executable configs must not be serialized over. */
export function createConfig(directory: string, config: Config): string {
	const source = formatConfig(config);
	assertCanCreateConfig(directory);
	const filename = path.resolve(directory, "astrohp.mts");
	fs.writeFileSync(filename, source, { flag: "wx" });
	return filename;
}

export function validateConfig(value: any, filename: string): Config {
	// note to self: if this gets too complicated later, switch to Zod
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${filename} must export a configuration object named "config"`);
	}

	for (const key of Object.keys(value)) {
		if (key !== "webroot" && key !== "adapter" && key !== "port" && key !== "runtimePath" && key !== "prerender") {
			throw new Error(`Unknown AstroHP configuration option: ${key}`);
		}
	}
	if (Array.isArray(value.webroot)) {
		if (!value.webroot.length) {
			throw new Error("AstroHP configuration option webroot must not be an empty array");
		}
		for (const [index, entry] of value.webroot.entries()) {
			const label = `${filename}: webroot[${index}]`;
			const options = typeof entry === "string" ? { webroot: entry } : entry;
			if (
				!options || typeof options !== "object" || Array.isArray(options) ||
				typeof options.webroot !== "string" || !options.webroot
			) {
				throw new Error(`${label} must be a non-empty path or an object with a non-empty webroot`);
			}
			validateConfig(options, label);
		}
	} else if (
		value.webroot !== undefined &&
		(typeof value.webroot !== "string" || !value.webroot)
	) {
		throw new Error("AstroHP configuration option webroot must be a non-empty string or array");
	}
	if (
		value.adapter !== undefined &&
		(typeof value.adapter !== "string" || !ADAPTERS.has(value.adapter as Adapter))
	) {
		throw new Error(
			'AstroHP configuration option adapter must be "node", "apache-proxy", "apache-cgi", or "apache-static"',
		);
	}
	if (value.prerender !== undefined && typeof value.prerender !== "boolean") {
		throw new Error("AstroHP configuration option prerender must be a boolean");
	}
	if (
		value.port !== undefined &&
		(typeof value.port !== "number" || !Number.isInteger(value.port) ||
			value.port < 0 || value.port > 65535)
	) {
		throw new Error("AstroHP configuration option port must be an integer from 0 to 65535");
	}
	if (
		value.runtimePath !== undefined && (typeof value.runtimePath !== "string" ||
			!path.isAbsolute(value.runtimePath) || /[\s\0]/.test(value.runtimePath))
	) {
		throw new Error("AstroHP configuration option runtimePath must be an absolute path without whitespace");
	}
	return value as Config;
}

/** One selected webroot, with its path resolved relative to its config file. */
export interface LoadedWebrootConfig {
	config: WebrootConfig & { webroot: string };
	configFile: string | null;
	isolatedCache: boolean;
}

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

function findConfigMarkers(directory: string, configs: string[], apacheRoots: string[]): void {
	const config = configIn(directory);
	if (config) {
		configs.push(config);
		return;
	}
	try {
		if (fs.statSync(path.join(directory, ".htaccess")).isFile()) apacheRoots.push(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function findChildConfigs(
	directory: string,
	configs: string[],
	apacheRoots: string[],
): void {
	findConfigMarkers(directory, configs, apacheRoots);

	const entries = fs.readdirSync(directory, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
		findChildConfigs(path.join(directory, entry.name), configs, apacheRoots);
	}
}

async function importConfig(filename: string): Promise<Config> {
	const url = pathToFileURL(filename);
	url.searchParams.set("mtime", String(fs.statSync(filename).mtimeMs));
	const module = await import(/* @vite-ignore */ url.href) as Record<string, unknown>;
	if (!("config" in module)) {
		throw new Error(
			`${filename} must export a configuration object named "config"`,
		);
	}
	return validateConfig(module.config, filename);
}

async function loadConfig(filename: string): Promise<LoadedWebrootConfig[]> {
	const { webroot, ...defaults } = await importConfig(filename);
	const multiple = typeof webroot !== "string" && webroot !== undefined;
	const entries = multiple ? webroot.map(entry => ({
		...defaults,
		...(typeof entry === "string" ? { webroot: entry } : entry),
	})) : [{ ...defaults, webroot: webroot ?? "." }];
	return entries.map(config => ({
		config: { ...config, webroot: path.resolve(path.dirname(filename), config.webroot ?? ".") },
		configFile: filename,
		isolatedCache: multiple,
	}));
}

export async function searchConfigs(directory: string = process.cwd()): Promise<LoadedWebrootConfig[]> {
	directory = path.resolve(directory);
	const configs: string[] = [];
	const apacheRoots: string[] = [];
	findChildConfigs(directory, configs, apacheRoots);

	let parent = path.dirname(directory);
	while (parent !== directory) {
		findConfigMarkers(parent, configs, apacheRoots);
		const nextParent = path.dirname(parent);
		if (nextParent === parent) break;
		parent = nextParent;
	}

	const webroots = (await Promise.all(configs.map(loadConfig))).flat();
	const webrootsByPath = new Map<string, LoadedWebrootConfig>();
	for (const webroot of webroots) {
		const webrootPath = webroot.config.webroot;
		const existing = webrootsByPath.get(webrootPath);
		if (existing) {
			if (existing.configFile === webroot.configFile) {
				throw new Error(`Webroot ${webrootPath} is configured more than once in ${webroot.configFile}`);
			}
			throw new Error(
				`Webroot ${webrootPath} is configured by both ${existing.configFile} and ${webroot.configFile}`,
			);
		}
		webrootsByPath.set(webrootPath, webroot);
	}
	const inside = (root: string, candidate: string): boolean => {
		const relative = path.relative(root, candidate);
		return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	};
	// Consider outer roots first: nested .htaccess files usually configure a
	// subdirectory of a site, rather than a separate site. Explicit configs win.
	for (
		const root of apacheRoots.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))
	) {
		if (webroots.some(webroot => inside(webroot.config.webroot, root))) continue;
		webroots.push({ config: { webroot: root }, configFile: null, isolatedCache: false });
	}
	return webroots;
}

export async function requireConfigs(directory: string = process.cwd()): Promise<LoadedWebrootConfig[]> {
	const configs = await searchConfigs(directory);
	if (!configs.length) {
		throw new Error(`Could not find ${CONFIG_FILENAMES.join(" or ")} or .htaccess; specify a webroot directory`);
	}
	return configs;
}

export async function requireConfig(directory: string = process.cwd()): Promise<LoadedWebrootConfig> {
	const configs = await requireConfigs(directory);
	if (configs.length > 1) {
		throw new Error(
			`Found multiple AstroHP webroots; specify one:\n${configs.map(config => config.config.webroot).join("\n")}`,
		);
	}
	return configs[0]!;
}

export async function resolveConfig(
	root: string,
	workingDirectory: string = process.cwd(),
): Promise<LoadedWebrootConfig> {
	const requestedRoot = path.resolve(workingDirectory, root);
	const matches = (await searchConfigs(requestedRoot))
		.filter(config => config.config.webroot === requestedRoot);
	if (matches.length > 1) throw new Error(`Found multiple configurations for ${requestedRoot}`);
	return matches[0] ?? { config: { webroot: requestedRoot }, configFile: null, isolatedCache: false };
}
