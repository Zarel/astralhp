import { generateApacheConfig } from "./apache.ts";
import { buildSite } from "./build.ts";
import { startDev } from "./dev-server.ts";
import { startLive } from "./live-server.ts";

function usage() {
	return "Usage: astrohp <dev|build|start|apache-proxy> [directory]";
}

async function main(argv: string[]) {
	const [command, directory, ...extra] = argv;
	if (command === "help" || command === "--help" || command === "-h") {
		console.log(usage());
		return;
	}
	if (extra.length) {
		throw new Error(usage());
	}
	switch (command) {
		case "dev":
			await startDev(directory);
			break;
		case "build":
			await buildSite(directory);
			break;
		case "start":
			await startLive(directory);
			break;
		case "apache-proxy":
			await buildSite(directory);
			console.log(await generateApacheConfig(directory));
			break;
		default:
			throw new Error(usage());
	}
}

main(process.argv.slice(2)).catch(error => {
	console.error(`astrohp: ${error.message}`);
	process.exitCode = 1;
});
