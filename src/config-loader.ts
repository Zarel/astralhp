import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Adapter, Config, WebrootConfig } from "./config.d.ts";

const CONFIG_FILENAMES = ["astralhp.mts", ".astralhp.mts"] as const;
const PROJECT_MARKERS = [...CONFIG_FILENAMES, "package.json"];
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
	return `export const config: import("astralhp").Config = ${JSON.stringify(config, null, "\t")};\n`;
}

/** Create a config; existing executable configs must not be serialized over. */
export function createConfig(directory: string, config: Config): string {
	const source = formatConfig(config);
	assertCanCreateConfig(directory);
	const filename = path.resolve(directory, "astralhp.mts");
	fs.writeFileSync(filename, source, { flag: "wx" });
	return filename;
}

export function validateConfig(value: any, filename: string): Config {
	// note to self: if this gets too complicated later, switch to Zod
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${filename} must export a configuration object named "config"`);
	}

	for (const key of Object.keys(value)) {
		if (
			![
				"webroot", "adapter", "port", "runtimePath", "prerender", "markdownLayout", "excludePages",
				"markdownAddTargetBlank",
			].includes(key)
		) {
			throw new Error(`Unknown AstralHP configuration option: ${key}`);
		}
	}
	if (Array.isArray(value.webroot)) {
		if (!value.webroot.length) {
			throw new Error("AstralHP configuration option webroot must not be an empty array");
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
		throw new Error("AstralHP configuration option webroot must be a non-empty string or array");
	}
	if (
		value.adapter !== undefined &&
		(typeof value.adapter !== "string" || !ADAPTERS.has(value.adapter as Adapter))
	) {
		throw new Error(
			'AstralHP configuration option adapter must be "node", "apache-proxy", "apache-cgi", or "apache-static"',
		);
	}
	if (value.prerender !== undefined && typeof value.prerender !== "boolean") {
		throw new Error("AstralHP configuration option prerender must be a boolean");
	}
	if (value.markdownAddTargetBlank !== undefined && typeof value.markdownAddTargetBlank !== "boolean") {
		throw new Error("AstralHP configuration option markdownAddTargetBlank must be a boolean");
	}
	if (
		value.excludePages !== undefined && (
			!Array.isArray(value.excludePages) ||
			value.excludePages.some((entry: unknown) => typeof entry !== "string" || !entry.trim() || path.isAbsolute(entry))
		)
	) {
		throw new Error("AstralHP configuration option excludePages must be an array of webroot-relative paths");
	}
	if (
		value.markdownLayout !== undefined &&
		(typeof value.markdownLayout !== "string" || !value.markdownLayout.trim())
	) {
		throw new Error("AstralHP configuration option markdownLayout must be a non-empty path");
	}
	if (
		value.port !== undefined &&
		(typeof value.port !== "number" || !Number.isInteger(value.port) ||
			value.port < 0 || value.port > 65535)
	) {
		throw new Error("AstralHP configuration option port must be an integer from 0 to 65535");
	}
	if (
		value.runtimePath !== undefined && (typeof value.runtimePath !== "string" ||
			!path.isAbsolute(value.runtimePath) || /[\s\0]/.test(value.runtimePath))
	) {
		throw new Error("AstralHP configuration option runtimePath must be an absolute path without whitespace");
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

/** Marker-free sites use their webroot as a standalone project. */
export function findProjectDir(directory: string, configFile?: string | null): string {
	if (configFile) return path.dirname(configFile);
	let current = directory;
	while (true) {
		for (const name of PROJECT_MARKERS) {
			if (fs.statSync(path.join(current, name), { throwIfNoEntry: false })?.isFile()) return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return directory;
		current = parent;
	}
}

function findChildConfigs(directory: string, configs: string[], apacheRoots: string[]): void {
	const entries = fs.readdirSync(directory, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
		const child = path.join(directory, entry.name);
		const config = configIn(child);
		if (config) {
			configs.push(config);
		} else {
			findChildConfigs(child, configs, apacheRoots);
		}
	}
	if (fs.statSync(path.join(directory, ".htaccess"), { throwIfNoEntry: false })?.isFile()) apacheRoots.push(directory);
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

async function loadConfiguredWebroots(configs: string[]): Promise<LoadedWebrootConfig[]> {
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
	return webroots;
}

export async function searchConfigs(directory: string = process.cwd()): Promise<LoadedWebrootConfig[]> {
	directory = path.resolve(directory);
	const ancestors: string[] = [];
	for (let current = directory;; current = path.dirname(current)) {
		const config = configIn(current);
		if (config) return loadConfiguredWebroots([config]);
		if (current !== directory) ancestors.push(current);
		if (current === path.dirname(current)) break;
	}

	const configs: string[] = [];
	const apacheRoots: string[] = [];
	findChildConfigs(directory, configs, apacheRoots);
	if (configs.length) return loadConfiguredWebroots(configs);
	for (const ancestor of ancestors) {
		if (fs.statSync(path.join(ancestor, ".htaccess"), { throwIfNoEntry: false })?.isFile()) apacheRoots.push(ancestor);
	}

	const webroots: LoadedWebrootConfig[] = [];
	const inside = (root: string, candidate: string): boolean => {
		const relative = path.relative(root, candidate);
		return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	};
	// Consider outer roots first: nested .htaccess files usually configure a
	// subdirectory of a site, rather than a separate site.
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
			`Found multiple AstralHP webroots; specify one:\n${configs.map(config => config.config.webroot).join("\n")}`,
		);
	}
	return configs[0]!;
}

export async function resolveConfig(
	webroot: string,
	workingDirectory: string = process.cwd(),
): Promise<LoadedWebrootConfig> {
	const requestedRoot = path.resolve(workingDirectory, webroot);
	const matches = (await searchConfigs(requestedRoot))
		.filter(config => config.config.webroot === requestedRoot);
	if (matches.length > 1) throw new Error(`Found multiple configurations for ${requestedRoot}`);
	return matches[0] ?? { config: { webroot: requestedRoot }, configFile: null, isolatedCache: false };
}

export interface ManagedProject {
	projectDir: string;
	configs: LoadedWebrootConfig[];
	lookupDirectories: string[];
}

export function canonicalPath(filename: string): string {
	try {
		return fs.realpathSync.native(path.resolve(filename));
	} catch {
		return path.resolve(filename);
	}
}

export async function managedProject(webroot?: string): Promise<ManagedProject> {
	const directory = path.resolve(webroot ?? ".");
	const target = canonicalPath(directory);
	const matchesTarget = (site: LoadedWebrootConfig) => canonicalPath(site.config.webroot) === target;
	const projectOf = (site: LoadedWebrootConfig) => canonicalPath(findProjectDir(site.config.webroot, site.configFile));
	let configs = webroot === undefined ? await requireConfigs(directory) : await searchConfigs(directory);
	let selected = configs.find(matchesTarget);
	if (webroot !== undefined && !selected?.configFile) {
		// A config in the caller's project can declare a webroot outside that project.
		const callerConfig = configIn(findProjectDir(process.cwd()));
		if (callerConfig && !configs.some(site => site.configFile === callerConfig)) {
			const callerSites = await loadConfig(callerConfig);
			const external = callerSites.find(matchesTarget);
			if (external) {
				selected = external;
				configs = callerSites;
			}
		}
		if (!selected && !configs.some(site => projectOf(site) === target)) {
			selected = { config: { webroot: directory }, configFile: null, isolatedCache: false };
			configs.push(selected);
		}
	}
	const projects = Map.groupBy(configs, projectOf);
	let projectDir = selected ? projectOf(selected) : findProjectDir(target);
	if (!projects.has(projectDir)) {
		if (projects.size !== 1) {
			throw new Error(
				`Found multiple AstralHP projects. Start each project separately:\n${[...projects.keys()].join("\n")}`,
			);
		}
		projectDir = projects.keys().next().value!;
	}
	const sites = projects.get(projectDir)!;
	return {
		projectDir,
		configs: webroot !== undefined && selected ? [selected] : sites,
		lookupDirectories: [...new Set([target, ...sites.map(site => canonicalPath(site.config.webroot))])],
	};
}
