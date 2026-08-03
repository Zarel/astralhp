import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentType } from "./mime.ts";
import type { Webroot } from "./webroot.ts";

const DOCUMENT_ROOT_HEADER = "x-astrohp-document-root";

type RequestHandler = (
	request: http.IncomingMessage,
	response: http.ServerResponse,
	next?: (error?: unknown) => void,
	locals?: object,
) => void | Promise<void>;

export interface LiveServerOptions {
	host?: string;
	port?: number;
}

function canonicalDirectory(directory: string): string {
	try {
		return fs.realpathSync.native(path.resolve(directory));
	} catch {
		return path.resolve(directory);
	}
}

export function serverPort(defaultPort = 4321): number {
	const value = process.env.PORT;
	if (value === undefined) return defaultPort;

	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`Invalid PORT: ${value}`);
	}
	return port;
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

export class AstroHPServer {
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
			throw new Error("AstroHPServer requires at least one webroot");
		}
		this.webroots = [...webroots];
		this.host = options.host ?? process.env.HOST ?? "127.0.0.1";
		this.port = options.port ?? serverPort(webroots[0]!.port);
		if (
			options.port === undefined &&
			webroots.some(webroot => serverPort(webroot.port) !== this.port)
		) {
			throw new Error(
				"Webroots with different ports require separate AstroHPServer listeners",
			);
		}
		const nodeWebroots = webroots.filter(webroot => webroot.adapter === "node");
		if (nodeWebroots.length > 1) {
			throw new Error(
				`Node webroots sharing port ${this.port} must use different ports`,
			);
		}
		this.nodeWebroot = nodeWebroots[0] ?? null;

		for (const webroot of webroots) {
			if (webroot.adapter === "apache-proxy") {
				const documentRoot = canonicalDirectory(webroot.path);
				const existing = this.webrootsByDocumentRoot.get(documentRoot);
				if (existing && existing !== webroot) {
					throw new Error(
						`Document root ${documentRoot} is configured by both ${existing.configFile ?? existing.path} and ${
							webroot.configFile ?? webroot.path
						}`,
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
		return this.webrootsByDocumentRoot.get(canonicalDirectory(documentRoot)) ?? null;
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
		if (webroot.isPrivateRequest(request.url)) {
			response.statusCode = 403;
			response.end();
			return;
		}
		const filename = (
			request.method === "GET" || request.method === "HEAD"
		) && (
			webroot.resolveDistFile(request.url) || webroot.resolveStaticFile(request.url)
		);
		if (filename) {
			sendFile(request, response, filename);
			return;
		}

		const handler = this.handlers.get(webroot);
		if (!handler) throw new Error(`No Astro handler loaded for ${webroot.path}`);
		let nextCalled = false;
		let nextError: unknown;
		await handler(request, response, error => {
			nextCalled = true;
			nextError = error;
		});
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
					`No build found. Run "astrohp build ${webroot.path}" first.`,
				);
			}
			const entrypoint = path.join(webroot.dist, ".server", "entry.mjs");
			if (!fs.existsSync(entrypoint)) {
				throw new Error(
					`Build for ${webroot.path} has no Astro server entrypoint. Run "astrohp build ${webroot.path}" again.`,
				);
			}
			const module = await import(pathToFileURL(entrypoint).href) as {
				handler?: RequestHandler;
			};
			if (typeof module.handler !== "function") {
				throw new Error(`Astro server entrypoint for ${webroot.path} has no handler`);
			}
			this.handlers.set(webroot, module.handler);
		}

		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.port, this.host, () => {
				this.server.off("error", reject);
				resolve();
			});
		});

		const address = this.server.address() as AddressInfo;
		const displayHost = address.address.includes(":") ?
			`[${address.address}]` :
			address.address;
		const sites = this.webroots.length === 1 ?
			"" :
			` (${this.webroots.map(webroot => webroot.path).join(", ")})`;
		console.log(
			`astrohp live at http://${displayHost}:${address.port}/${sites}`,
		);
		return this;
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
): Promise<AstroHPServer[]> {
	const roots: readonly Webroot[] = Array.isArray(webroots) ?
		webroots :
		[webroots as Webroot];
	if (!roots.length) throw new Error("No AstroHP webroots found");

	const groups = new Map<number, Webroot[]>();
	for (const webroot of roots) {
		const port = options.port ?? serverPort(webroot.port);
		const group = groups.get(port) ?? [];
		group.push(webroot);
		groups.set(port, group);
	}

	const servers: AstroHPServer[] = [];
	try {
		for (const [port, group] of groups) {
			const server = new AstroHPServer(group, { ...options, port });
			await server.listen();
			servers.push(server);
		}
	} catch (error) {
		await Promise.all(servers.map(server => server.close()));
		throw error;
	}
	return servers;
}
