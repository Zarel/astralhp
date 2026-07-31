import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Adapter, Config } from "./config.d.ts";

const CONFIG_FILENAME = "astrohp.mts";
const ADAPTERS = new Set<Adapter>(["node", "apache-proxy"]);

export interface ResolvedConfig {
	filename: string | null;
	webroot: string;
	adapter: Adapter;
	port: number;
}

function findConfig(workingDirectory: string): string | null {
	const filename = path.join(workingDirectory, CONFIG_FILENAME);
	try {
		if (fs.statSync(filename).isFile()) return filename;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return null;
}

function validateConfig(value: unknown, filename: string): Config {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${filename} must export a configuration object named "config"`);
	}

	const config = value as Record<string, unknown>;
	for (const key of Object.keys(config)) {
		if (key !== "webroot" && key !== "adapter" && key !== "port") {
			throw new Error(`Unknown AstroHP configuration option: ${key}`);
		}
	}
	if (
		config.webroot !== undefined &&
		(typeof config.webroot !== "string" || !config.webroot)
	) {
		throw new Error("AstroHP configuration option webroot must be a non-empty string");
	}
	if (
		config.adapter !== undefined &&
		(typeof config.adapter !== "string" || !ADAPTERS.has(config.adapter as Adapter))
	) {
		throw new Error(
			'AstroHP configuration option adapter must be "node" or "apache-proxy"',
		);
	}
	if (
		config.port !== undefined &&
		(typeof config.port !== "number" ||
			!Number.isInteger(config.port) ||
			config.port < 0 ||
			config.port > 65535)
	) {
		throw new Error(
			"AstroHP configuration option port must be an integer from 0 to 65535",
		);
	}
	return value as Config;
}

async function importConfig(filename: string): Promise<Config> {
	const url = pathToFileURL(filename);
	url.searchParams.set("mtime", String(fs.statSync(filename).mtimeMs));
	const module = await import(url.href) as Record<string, unknown>;
	if (!("config" in module)) {
		throw new Error(`${filename} must export a configuration object named "config"`);
	}
	return validateConfig(module.config, filename);
}

export async function loadConfig(
	root?: string,
	workingDirectory = process.cwd(),
): Promise<ResolvedConfig> {
	workingDirectory = path.resolve(workingDirectory);
	const requestedRoot = path.resolve(workingDirectory, root ?? ".");
	const filename = findConfig(workingDirectory);
	if (!filename) {
		if (root === undefined) {
			throw new Error(
				`Could not find ${CONFIG_FILENAME}; specify a webroot directory`,
			);
		}
		return {
			filename: null,
			webroot: requestedRoot,
			adapter: "node",
			port: 4321,
		};
	}

	const config = await importConfig(filename);
	return {
		filename,
		webroot: root !== undefined ?
			requestedRoot :
			path.resolve(workingDirectory, config.webroot ?? "."),
		adapter: config.adapter ?? "node",
		port: config.port ?? 4321,
	};
}
