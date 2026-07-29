import { startDev } from "./dev-server.ts";

function usage() {
	return "Usage: astrohp dev [directory]";
}

async function main(argv: string[]) {
	const [command, directory, ...extra] = argv;
	if (command === "help" || command === "--help" || command === "-h") {
		console.log(usage());
		return;
	}
	if (command !== "dev" || extra.length) {
		throw new Error(usage());
	}
	await startDev(directory);
}

main(process.argv.slice(2)).catch(error => {
	console.error(`astrohp: ${error.message}`);
	process.exitCode = 1;
});
