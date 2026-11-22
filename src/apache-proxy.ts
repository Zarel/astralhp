import type { createApp } from "astro/app/entrypoint";
import { createRequestFromNodeRequest, getAbortControllerCleanup, writeResponse } from "astro/app/node";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import type { Webroot } from "./webroot.js";

export class ApacheProxy {
	private static readonly requestURL = new AsyncLocalStorage<string>();
	readonly app: ReturnType<typeof createApp>;
	readonly webroot: Webroot;

	constructor(app: ReturnType<typeof createApp>, webroot: Webroot) {
		this.app = app;
		this.webroot = webroot;
	}

	static logUnhandledRejection(reason: unknown): void {
		// The stock Node adapter can install its own listener when another webroot loads.
		if (process.listenerCount("unhandledRejection") > 1) return;
		const url = ApacheProxy.requestURL.getStore();
		if (url) {
			console.error(`Unhandled rejection while rendering ${url}`, reason);
		} else {
			console.error("Unhandled rejection outside request context", reason);
			process.exitCode = 1;
		}
	}

	private static publicOrigin(request: IncomingMessage): string | null {
		const scheme = request.headers["x-forwarded-proto"];
		const host = request.headers["x-forwarded-host"];
		if (scheme !== "http" && scheme !== "https") return null;
		if (typeof host !== "string" || !/^(?:[\w.-]+|\[[\da-f:.]+\])(?::\d+)?$/i.test(host)) return null;
		return URL.parse(`${scheme}://${host}`)?.origin ?? null;
	}

	// Astro asks for prerendered error pages by URL. The build already contains them.
	private async errorPage(url: string): Promise<Response> {
		const { pathname } = new URL(url);
		if (pathname === "/404.html" || pathname === "/500.html") {
			try {
				return new Response(await fs.readFile(path.join(this.webroot.dist, pathname)), {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			} catch (error) {
				if ((error as any)?.code !== "ENOENT") throw error;
			}
		}
		return new Response(null, { status: 404 });
	}

	async handle(req: IncomingMessage, res: ServerResponse, next: () => void, fromApache: boolean): Promise<void> {
		let clientAddress = req.socket.remoteAddress;
		const forwardedFor = req.headers["x-forwarded-for"];
		if (fromApache && typeof forwardedFor === "string") {
			// mod_proxy_http appends the address Apache saw after any existing entries.
			const address = forwardedFor.split(",").at(-1)!.trim();
			if (isIP(address)) clientAddress = address;
		}
		let origin: string | null = null;
		if (fromApache && req.headers["x-forwarded-proto"] !== undefined) {
			origin = ApacheProxy.publicOrigin(req);
			if (!origin || !req.url?.startsWith("/")) {
				res.writeHead(400).end();
				return;
			}
		}

		const local = createRequestFromNodeRequest(req, {
			port: req.socket.localPort ?? this.webroot.config.port,
			bodySizeLimit: 1024 ** 3, // @astrojs/node's default
		});
		try {
			const request = origin ? new Request(origin + req.url, local) : local;
			let route = this.app.match(request, true);
			if (route?.prerender) route = this.app.match(request);
			if (!route) return next();
			await ApacheProxy.requestURL.run(request.url, async () => {
				const response = await this.app.render(request, {
					routeData: route,
					addCookieHeader: true,
					...(clientAddress && { clientAddress }),
					prerenderedErrorPageFetch: url => this.errorPage(url),
				});
				await writeResponse(response, res);
			});
		} finally {
			getAbortControllerCleanup(req)?.();
		}
	}
}
