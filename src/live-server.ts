import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ApacheProxy } from "./apache-proxy.js";
import { contentType } from "./mime.js";
import { canonicalPath, resolveServerPort } from "./utils.js";
import type { Webroot } from "./webroot.js";

const DOCUMENT_ROOT_HEADER = "x-astralhp-document-root";

type RequestHandler = (
	request: http.IncomingMessage,
	response: http.ServerResponse,
	next: (error?: unknown) => void,
	fromApache: boolean,
) => void | Promise<void>;

export interface LiveServerOptions {
	host?: string;
	port?: number;
}

function sendFile(
	request: http.IncomingMessage,
	response: http.ServerResponse,
	filename: string,
): void {
	response.statusCode = 200;
	response.setHeader("Content-Type", contentType(filename));
	response.setHeader("Content-Length", fs.statSync(filename).size);
	response.setHeader("Cache-Control", "no-cache");

	if (request.method === "HEAD") {
		response.end();
		return;
	}

	const stream = fs.createReadStream(filename);
	stream.on("error", () => {
		if (!response.headersSent) response.statusCode = 500;
		response.end();
	});
	stream.pipe(response);
}

export class AstralHPServer {
	readonly webroots: readonly Webroot[];
	readonly server: http.Server;
	readonly host: string;
	readonly port: number;
	private readonly webrootsByDocumentRoot = new Map<string, Webroot>();
	private readonly nodeWebroot: Webroot | null;
	private readonly handlers = new Map<Webroot, RequestHandler>();

	constructor(
		webroots: readonly Webroot[],
		options: LiveServerOptions = {},
	) {
		if (!webroots.length) {
			throw new Error("AstralHPServer requires at least one webroot");
		}
		if (webroots.some(webroot => webroot.config.adapter === "apache-cgi")) {
			throw new Error("apache-cgi sites run under Apache; use astralhp dev for local development");
		}
		if (webroots.some(webroot => webroot.config.adapter === "apache-static")) {
			throw new Error("apache-static sites are served by Apache; use astralhp dev for local development");
		}
		this.webroots = [...webroots];
		this.host = options.host ?? process.env.HOST ?? "127.0.0.1";
		this.port = options.port ?? resolveServerPort(webroots[0]!.config.port);
		if (
			options.port === undefined &&
			webroots.some(webroot => resolveServerPort(webroot.config.port) !== this.port)
		) {
			throw new Error(
				"Webroots with different ports require separate AstralHPServer listeners",
			);
		}
		const nodeWebroots = webroots.filter(webroot => webroot.config.adapter === "node");
		if (nodeWebroots.length > 1) {
			throw new Error(
				`Node webroots sharing port ${this.port} must use different ports`,
			);
		}
		this.nodeWebroot = nodeWebroots[0] ?? null;

		for (const webroot of webroots) {
			if (webroot.config.adapter === "apache-proxy") {
				const documentRoot = canonicalPath(webroot.config.webroot);
				const existing = this.webrootsByDocumentRoot.get(documentRoot);
				if (existing && existing !== webroot) {
					throw new Error(
						`Document root ${documentRoot} is configured by both ${
							existing.configFile ?? existing.config.webroot
						} and ${webroot.configFile ?? webroot.config.webroot}`,
					);
				}
				this.webrootsByDocumentRoot.set(documentRoot, webroot);
			}
		}

		this.server = http.createServer((request, response) => {
			this.handle(request, response).catch(error => {
				console.error(error);
				if (!response.headersSent) response.statusCode = 500;
				response.end();
			});
		});
	}

	webrootForDocumentRoot(documentRoot: string): Webroot | null {
		return this.webrootsByDocumentRoot.get(canonicalPath(documentRoot)) ?? null;
	}

	webrootForRequest(
		documentRoot: string | string[] | undefined,
	): Webroot | null {
		if (documentRoot !== undefined) {
			if (typeof documentRoot !== "string") return null;
			return this.webrootForDocumentRoot(documentRoot);
		}
		if (this.nodeWebroot) return this.nodeWebroot;
		return this.webroots.length === 1 ? this.webroots[0]! : null;
	}

	private async handle(
		request: http.IncomingMessage,
		response: http.ServerResponse,
	): Promise<void> {
		const documentRoot = request.headers[DOCUMENT_ROOT_HEADER];
		delete request.headers[DOCUMENT_ROOT_HEADER];
		const webroot = this.webrootForRequest(documentRoot);
		if (!webroot) {
			response.statusCode = 404;
			response.setHeader("Content-Type", "text/plain; charset=utf-8");
			response.end("Unknown Webroot");
			return;
		}
		const lookup = webroot.lookup(request.url);
		if (lookup.kind === "private") {
			response.statusCode = 403;
			response.end();
			return;
		}
		if (lookup.kind === "file" && (request.method === "GET" || request.method === "HEAD")) {
			sendFile(request, response, lookup.filename);
			return;
		}

		const handler = this.handlers.get(webroot);
		if (!handler) throw new Error(`No Astro handler loaded for ${webroot.config.webroot}`);
		let nextCalled = false;
		let nextError: unknown;
		// The generated Apache rules connect to 127.0.0.1 and identify the selected webroot.
		const peer = request.socket.remoteAddress;
		const fromApache = documentRoot !== undefined && (peer === "127.0.0.1" || peer === "::ffff:127.0.0.1");
		await handler(request, response, error => {
			nextCalled = true;
			nextError = error;
		}, fromApache);
		if (nextError) throw nextError;
		if (nextCalled && !response.writableEnded) {
			response.statusCode = 404;
			response.setHeader("Content-Type", "text/plain; charset=utf-8");
			response.end("Not Found");
		}
	}

	async listen(): Promise<this> {
		for (const webroot of this.webroots) {
			if (!fs.existsSync(webroot.dist)) {
				throw new Error(
					`No build found. Run "astralhp build ${webroot.config.webroot}" first.`,
				);
			}
			const entrypoint = path.join(webroot.dist, ".server", "app.mjs");
			if (!fs.existsSync(entrypoint)) {
				throw new Error(
					`Build for ${webroot.config.webroot} has no Astro server entrypoint. Run "astralhp build ${webroot.config.webroot}" again.`,
				);
			}
			const module = await import(pathToFileURL(entrypoint).href) as {
				app?: ApacheProxy["app"];
				handler?: (
					req: http.IncomingMessage, res: http.ServerResponse, next: (error?: unknown) => void,
				) => Promise<void>;
			};
			if (module.app && webroot.config.adapter === "apache-proxy") {
				const proxy = new ApacheProxy(module.app, webroot);
				this.handlers.set(webroot, proxy.handle.bind(proxy));
			} else if (typeof module.handler === "function") {
				const handler = module.handler;
				this.handlers.set(webroot, (req, res, next) => handler(req, res, next));
			} else {
				throw new Error(`Astro server entrypoint for ${webroot.config.webroot} has no handler`);
			}
		}

		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.port, this.host, () => {
				this.server.off("error", reject);
				resolve();
			});
		});

		return this;
	}

	get startupMessage(): string {
		return [
			`AstralHP running, listening to ${this.url}`,
			...this.webroots.map(webroot => `Serving ${webroot.config.webroot}`),
		].join("\n");
	}

	get url(): string {
		const address = this.server.address() as AddressInfo;
		const displayHost = address.address.includes(":") ?
			`[${address.address}]` :
			address.address;
		return `http://${displayHost}:${address.port}/`;
	}

	async close(): Promise<void> {
		if (!this.server.listening) return;
		await new Promise<void>((resolve, reject) => {
			this.server.close(error => error ? reject(error) : resolve());
		});
	}
}

export async function startLive(
	webroots: Webroot | readonly Webroot[],
	options: LiveServerOptions = {},
): Promise<AstralHPServer[]> {
	const roots: readonly Webroot[] = Array.isArray(webroots) ?
		webroots :
		[webroots as Webroot];
	if (!roots.length) throw new Error("No AstralHP webroots found");

	const groups = new Map<number, Webroot[]>();
	for (const webroot of roots) {
		const port = options.port ?? resolveServerPort(webroot.config.port);
		const group = groups.get(port) ?? [];
		group.push(webroot);
		groups.set(port, group);
	}

	const servers: AstralHPServer[] = [];
	try {
		for (const [port, group] of groups) {
			const server = new AstralHPServer(group, { ...options, port });
			await server.listen();
			servers.push(server);
		}
	} catch (error) {
		await Promise.all(servers.map(server => server.close()));
		throw error;
	}
	return servers;
}
