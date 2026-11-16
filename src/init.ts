import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { assertCanCreateConfig, createConfig, formatConfig, validateConfig } from "./config-loader.js";
import type { Adapter, WebrootConfig } from "./config.d.ts";

class Cancelled extends Error {}

function stat(filename: string): fs.Stats | undefined {
	try {
		return fs.statSync(filename);
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
		throw error;
	}
}

function booleanAnswer(answer: string): boolean {
	if (["y", "yes", "true"].includes(answer.toLowerCase())) return true;
	if (["n", "no", "false"].includes(answer.toLowerCase())) return false;
	throw new Error("Please answer yes or no.");
}

export async function init(directory: string = process.cwd()): Promise<void> {
	directory = path.resolve(directory);
	if (!stat(directory)?.isDirectory()) throw new Error(`Project directory does not exist: ${directory}`);
	assertCanCreateConfig(directory);
	const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const readline = createInterface({ input: process.stdin, output: process.stdout, terminal });
	// Keep a single iterator so pasted or piped answers aren't lost between prompts.
	const answers = readline[Symbol.asyncIterator]();
	let interrupted = false;
	readline.on("SIGINT", () => {
		interrupted = true;
		readline.close();
	});
	async function ask<T>(label: string, fallback: string, parse: (answer: string) => T): Promise<T> {
		while (true) {
			if (interrupted) throw new Cancelled();
			const prompt = `${label}${fallback ? ` (${fallback})` : ""}: `;
			if (terminal) {
				readline.setPrompt(prompt);
				readline.prompt();
			} else {
				process.stdout.write(prompt);
			}
			const answer = await answers.next();
			if (answer.done || interrupted) throw new Cancelled();
			try {
				return parse(answer.value.trim() || fallback);
			} catch (error) {
				console.log((error as Error).message);
			}
		}
	}

	try {
		console.log(`AstralHP: Setting up ${directory}`);
		console.log("Enter = accept a default. Ctrl+C = cancel anytime.\n");
		console.log("Webroot directory can be . (uses the current directory) or nonexistent (will be created).");
		const webroot = await ask("Webroot directory", "www", value => {
			if (value.includes("\0")) throw new Error("Webroot path must not contain a null character.");
			const target = stat(path.resolve(directory, value));
			if (target && !target.isDirectory()) throw new Error("Webroot must be a directory.");
			return value;
		});
		console.log("\nSupported adapters:");
		console.log("  apache-static Apache serves static pages only");
		console.log("  apache-proxy  Apache forwards dynamic requests to Node");
		console.log("  apache-cgi    Apache runs dynamic pages through CGI");
		console.log("  node          Node directly serves the site\n");
		const adapter = await ask("Adapter", "apache-static", value => {
			validateConfig({ adapter: value }, "Configuration");
			return value as Adapter;
		});
		const config: WebrootConfig = { webroot, adapter };
		if (adapter === "node" || adapter === "apache-proxy") {
			config.port = await ask("Port", "4321", value => {
				const port = Number(value);
				const minimum = adapter === "apache-proxy" ? 1 : 0;
				if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < minimum || port > 65535) {
					throw new Error(`Port must be an integer from ${minimum} to 65535.`);
				}
				return port;
			});
		} else if (adapter === "apache-cgi") {
			console.log("Interpreter path can be blank (falls back to /usr/bin/env bun)");
			const runtimePath = await ask("Interpreter path", "", value => {
				if (value) validateConfig({ runtimePath: value }, "Configuration");
				return value;
			});
			if (runtimePath) config.runtimePath = runtimePath;
		}
		const staticOnly = adapter === "apache-static";
		const apache = adapter !== "node";
		const root = path.resolve(directory, webroot);
		const apacheFile = path.resolve(directory, webroot, ".htaccess");
		const displayPath = (filename: string): string => path.relative(directory, filename) || ".";
		console.log("\nReady. This will:");
		console.log(`- ${stat(root) ? "use existing" : "create"} \`${displayPath(root)}\``);
		if (apache) {
			const existing = stat(apacheFile);
			if (existing && !existing.isFile()) throw new Error(`Expected a file: ${apacheFile}`);
			console.log(`- ${existing ? "use existing" : "create"} \`${displayPath(apacheFile)}\``);
		}
		if (!staticOnly) {
			console.log(`- create \`astralhp.mts\`, containing:\n${formatConfig(config)}`);
		} else {
			console.log();
		}
		if (!await ask("Go?", "yes", booleanAnswer)) {
			throw new Cancelled();
		}
		assertCanCreateConfig(directory);
		fs.mkdirSync(root, { recursive: true });
		if (apache) {
			try {
				fs.writeFileSync(apacheFile, "", { flag: "wx" });
				console.log(`\nCreated ${apacheFile}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !stat(apacheFile)?.isFile()) throw error;
				console.log(`\nUsing existing ${apacheFile}`);
			}
		}
		if (!staticOnly) {
			const filename = createConfig(directory, config);
			console.log(`\nCreated ${filename}`);
		}
	} catch (error) {
		if (!(error instanceof Cancelled)) throw error;
		console.log("\nCancelled. No configuration written.");
		if (interrupted) process.exitCode = 130;
	} finally {
		readline.close();
	}
}
