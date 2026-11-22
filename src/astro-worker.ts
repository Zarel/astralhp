import { ApacheProxy } from "./apache-proxy.js";
import { astroConfig } from "./astro-config.js";
import type { AstralHPResolvedRoutes } from "./astro-integration.js";
import type { WorkerRequest } from "./astro-process.js";
import { buildSite } from "./build.js";
import { AssetBundles } from "./bundles.js";
import { type DevServerOptions, startDev } from "./dev-server.js";
import { ES3Scripts } from "./es3.js";
import { type LiveServerOptions, startLive } from "./live-server.js";
import { resolveServerPort } from "./utils.js";
import { Webroot } from "./webroot.js";

function send(message: object): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send) {
			reject(new Error("AstralHP worker requires an IPC channel"));
			return;
		}
		process.send(message, error => error ? reject(error) : resolve());
	});
}

function serializedError(error: unknown) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			...(error.stack === undefined ? {} : { stack: error.stack }),
		};
	}
	return {
		name: "Error",
		message: String(error),
	};
}

let close: (() => Promise<void>) | undefined;
let closing = false;

async function shutdown(): Promise<void> {
	if (closing) return;
	closing = true;
	try {
		await close?.();
		if (process.connected) process.disconnect();
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
		if (process.connected) process.disconnect();
	}
}

async function run(request: WorkerRequest): Promise<void> {
	const webroots = request.webroots.map(Webroot.fromLoadedConfig);
	switch (request.operation) {
		case "build": {
			if (webroots.length !== 1) {
				throw new Error("An AstralHP build worker requires exactly one webroot");
			}
			let resolvedRoutes: AstralHPResolvedRoutes | undefined;
			const webroot = webroots[0]!;
			const es3 = new ES3Scripts(webroot);
			const bundles = new AssetBundles(webroot, es3);
			const config = astroConfig(
				webroot, {
					onRoutesResolved(value) {
						resolvedRoutes = value;
					},
				}, es3, bundles,
			);
			const result = await buildSite(webroot, config, () => resolvedRoutes, es3, bundles);
			await send({ type: "ready", result });
			process.disconnect();
			break;
		}
		case "dev": {
			if (webroots.length !== 1) {
				throw new Error("An AstralHP dev worker requires exactly one webroot");
			}
			const options = request.options as DevServerOptions | undefined;
			const endpoints: RegExp[] = [];
			const config = astroConfig(webroots[0]!, {
				onRoutesResolved({ routes }) {
					endpoints.length = 0;
					for (const route of routes) {
						if (route.type === "endpoint") endpoints.push(route.patternRegex);
					}
				},
			});
			const server = await startDev(webroots[0]!, config, {
				...options,
				port: options?.port ?? resolveServerPort(webroots[0]!.config.port),
			}, endpoints);
			close = () => server.stop();
			await send({ type: "ready" });
			break;
		}
		case "start": {
			if (webroots.some(site => site.config.adapter === "apache-proxy")) {
				process.on("unhandledRejection", ApacheProxy.logUnhandledRejection);
			}
			const servers = await startLive(
				webroots,
				request.options as LiveServerOptions | undefined,
			);
			close = async () => {
				await Promise.all(servers.map(server => server.close()));
				process.exit(0);
			};
			await send({
				type: "ready",
				result: {
					urls: servers.map(server => server.url),
					startupMessage: servers.map(server => server.startupMessage).join("\n"),
				},
			});
			break;
		}
	}
}

process.once("message", (request: WorkerRequest) => {
	run(request).catch(async error => {
		try {
			await send({ type: "error", error: serializedError(error) });
		} catch {}
		if (request.operation === "start") process.exit(1);
		process.exitCode = 1;
		if (process.connected) process.disconnect();
	});
});

process.on("message", message => {
	if (
		message && typeof message === "object" &&
		"type" in message && message.type === "close"
	) {
		void shutdown();
	}
});

process.on("disconnect", () => {
	void shutdown();
});
