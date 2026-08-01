import path from "node:path";

import { generateApacheConfig } from "./apache.ts";
import { buildSite } from "./build.ts";
import { discoverWebroots, selectWebroot } from "./config-loader.ts";
import { startDev } from "./dev-server.ts";
import { serverPort, startLive } from "./live-server.ts";

function usage() {
	return "Usage: astrohp [<dev|build|start> [directory]]";
}

const COMMANDS = new Set(["dev", "build", "start"]);

async function main(argv: string[]) {
	const [command, directory, ...extra] = argv;
	if (!command) {
		const webroots = await discoverWebroots();
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
	const webroot = await selectWebroot(directory);
	switch (command) {
		case "dev":
			await startDev(webroot, { port: serverPort(webroot.port) });
			break;
		case "build":
			await buildSite(webroot);
			if (webroot.adapter === "apache-proxy") {
				console.log(
					await generateApacheConfig(webroot, serverPort(webroot.port)),
				);
			}
			break;
		case "start":
			await startLive(webroot, { port: serverPort(webroot.port) });
			break;
	}
}

main(process.argv.slice(2)).catch(error => {
	console.error(`astrohp: ${error.message}`);
	process.exitCode = 1;
});
