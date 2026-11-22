import path from "node:path";

import { build, dev } from "./index.js";
import { init } from "./init.js";
import { RemoteManager, serve } from "./manager.js";
import { Webroot } from "./webroot.js";

function usage() {
	return "Usage:\n" +
		" ([dir] is always optional)\n" +
		" astralhp               Show any detected AstralHP webroots.\n" +
		" astralhp init [dir]    Create a new AstralHP webroot and project.\n" +
		" astralhp dev [dir]     Start a development server.\n" +
		" astralhp build [dir]   Build for production.\n" +
		" astralhp serve [dir]   Start a prod server.\n" +
		" astralhp start [dir]   Start a prod server in the background.\n" +
		" astralhp reload [dir]  Reload the prod server.\n" +
		" astralhp stop [dir]    Stop the prod server.\n" +
		" astralhp status [dir]  Show the status of any running prod servers.\n" +
		" astralhp help          Show this help.";
}

const COMMANDS = new Set(["init", "dev", "build", "serve", "start", "reload", "stop", "status", "ps"]);

function printManagers(managers: RemoteManager[]) {
	console.log("PID\tWORKER\tWEBROOTS");
	for (const manager of managers) {
		console.log([manager.pid, manager.worker, manager.webroots.join(", ")].join("\t"));
	}
}

async function main(argv: string[]) {
	const [command, directory, ...extra] = argv;
	if (!command) {
		const webroots = await Webroot.search();
		if (!webroots.length) {
			console.log("No AstralHP webroots found.");
			console.log("For help, use: astralhp help");
			return;
		}
		console.log("AstralHP webroots:");
		for (const webroot of webroots) {
			const webrootPath = path.relative(process.cwd(), webroot.config.webroot) || ".";
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
	if (command === "init") {
		await init(directory);
		return;
	}
	switch (command) {
		case "dev": {
			const webroot = directory === undefined ? await Webroot.requireOne() : await Webroot.resolve(directory);
			await (await dev(webroot)).finished;
			break;
		}
		case "build": {
			const webroots = directory === undefined ? await Webroot.requireAll() : [await Webroot.resolve(directory)];
			for (const webroot of webroots) await build(webroot);
			break;
		}
		case "serve": {
			const message = await serve(directory);
			console.log(message);
			if (process.send) process.send({ message });
			break;
		}
		case "ps":
		case "status": {
			if (directory === undefined) {
				const managers = await RemoteManager.list();
				if (managers.length) printManagers(managers);
				else console.log("No AstralHP managers running.");
			} else {
				const manager = await RemoteManager.status(directory);
				if (manager) printManagers([manager]);
				else console.log("No AstralHP manager running for this project.");
			}
			break;
		}
		case "start":
			console.log(await serve(directory, true));
			break;
		case "reload":
		case "stop":
			console.log(await RemoteManager.control(command, directory));
			break;
	}
}

main(process.argv.slice(2)).catch(error => {
	if (process.send) process.send({ failed: true, message: error.message });
	console.error(`astralhp: ${error.message}`);
	process.exitCode = 1;
});
