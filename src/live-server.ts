import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { contentType } from "./mime.ts";
import { getWebrootPaths, isPrivateRequest, resolveDistFile, resolveStaticFile } from "./webroot.ts";

export interface LiveServerOptions {
	host?: string;
	port?: number;
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

export async function startLive(
	root = process.cwd(),
	options: LiveServerOptions = {},
): Promise<http.Server> {
	const paths = getWebrootPaths(root);
	if (!fs.existsSync(paths.dist)) {
		throw new Error(`No build found. Run "astrohp build ${paths.webroot}" first.`);
	}

	const server = http.createServer((request, response) => {
		if (isPrivateRequest(request.url)) {
			response.statusCode = 403;
			response.end();
			return;
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.statusCode = 405;
			response.setHeader("Allow", "GET, HEAD");
			response.end();
			return;
		}

		const filename = resolveDistFile(paths.dist, request.url) ||
			resolveStaticFile(paths.webroot, request.url);
		if (filename) {
			sendFile(request, response, filename);
			return;
		}

		response.statusCode = 404;
		response.setHeader("Content-Type", "text/plain; charset=utf-8");
		response.end("Not Found");
	});

	const host = options.host ?? process.env.HOST ?? "127.0.0.1";
	const port = options.port ?? serverPort();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address() as AddressInfo;
	const displayHost = address.address.includes(":") ?
		`[${address.address}]` :
		address.address;
	console.log(`astrohp live at http://${displayHost}:${address.port}/`);
	return server;
}
