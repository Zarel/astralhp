import { generateApacheConfig } from "./apache.ts";
import { buildSite } from "./build.ts";
import { loadConfig } from "./config-loader.ts";
import { startDev } from "./dev-server.ts";
import { serverPort, startLive } from "./live-server.ts";

function usage() {
	return "Usage: astrohp <dev|build|start> [directory]";
}

const COMMANDS = new Set(["dev", "build", "start"]);

async function main(argv: string[]) {
	const [command, directory, ...extra] = argv;
	if (command === "help" || command === "--help" || command === "-h") {
		console.log(usage());
		return;
	}
	if (extra.length || !command || !COMMANDS.has(command)) {
		throw new Error(usage());
	}
	const config = await loadConfig(directory);
	switch (command) {
		case "dev":
			await startDev(config.webroot, { port: serverPort(config.port) });
			break;
		case "build":
			await buildSite(config.webroot);
			if (config.adapter === "apache-proxy") {
				console.log(
					await generateApacheConfig(config.webroot, serverPort(config.port)),
				);
			}
			break;
		case "start":
			await startLive(config.webroot, { port: serverPort(config.port) });
			break;
	}
}

main(process.argv.slice(2)).catch(error => {
	console.error(`astrohp: ${error.message}`);
	process.exitCode = 1;
});
