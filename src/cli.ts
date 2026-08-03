import path from "node:path";

import { build, dev, start } from "./index.ts";
import { Webroot } from "./webroot.ts";

function usage() {
	return "Usage: astrohp [<dev|build|start> [directory]]";
}

const COMMANDS = new Set(["dev", "build", "start"]);

async function main(argv: string[]) {
	const [command, directory, ...extra] = argv;
	if (!command) {
		const webroots = await Webroot.search();
		if (!webroots.length) {
			console.log("No AstroHP webroots found.");
			return;
		}
		console.log("AstroHP webroots:");
		for (const webroot of webroots) {
			const webrootPath = path.relative(process.cwd(), webroot.path) || ".";
			console.log("  " + webrootPath);
		}
		return;
	}
	if (command === "help" || command === "--help" || command === "-h") {
		console.log(usage());
		return;
	}
	if (extra.length || !COMMANDS.has(command)) {
		throw new Error(usage());
	}
	if (directory === undefined && (command === "build" || command === "start")) {
		const webroots = await Webroot.requireAll();
		if (command === "build") {
			for (const webroot of webroots) {
				await build(webroot);
			}
		} else {
			const worker = await start(webroots);
			await worker.finished;
		}
		return;
	}
	const webroot = directory === undefined ?
		await Webroot.requireOne() :
		await Webroot.resolve(directory);
	switch (command) {
		case "dev":
			await (await dev(webroot)).finished;
			break;
		case "build":
			await build(webroot);
			break;
		case "start":
			await (await start(webroot)).finished;
			break;
	}
}

main(process.argv.slice(2)).catch(error => {
	console.error(`astrohp: ${error.message}`);
	process.exitCode = 1;
});
