import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { DevServerOptions } from "./dev-server.js";
import type { LiveServerOptions } from "./live-server.js";
import type { Webroot } from "./webroot.js";

interface SerializedWebroot {
	path: string;
	configFile: string | null;
	isolatedCache: boolean;
	adapter: Webroot["adapter"];
	prerender: boolean;
	port: number;
	runtimePath?: string;
}

interface WorkerRequest {
	operation: "build" | "dev" | "start";
	webroots: SerializedWebroot[];
	options?: DevServerOptions | LiveServerOptions;
}

interface SerializedError {
	name: string;
	message: string;
	stack?: string;
}

type WorkerMessage =
	| { type: "ready"; result?: unknown }
	| { type: "error"; error: SerializedError };

const WORKER_ENTRYPOINT = fileURLToPath(
	new URL("./astro-worker.js", import.meta.url),
);

function serializeWebroot(webroot: Webroot): SerializedWebroot {
	return {
		path: webroot.path,
		configFile: webroot.configFile,
		isolatedCache: webroot.isolatedCache,
		adapter: webroot.adapter,
		prerender: webroot.prerender,
		port: webroot.port,
		...(webroot.runtimePath === undefined ? {} : { runtimePath: webroot.runtimePath }),
	};
}

function workerError(error: SerializedError): Error {
	const result = new Error(error.message);
	result.name = error.name;
	if (error.stack) result.stack = error.stack;
	return result;
}

export interface AstroHPProcess {
	readonly finished: Promise<void>;
	close(): Promise<void>;
}

class WorkerProcess implements AstroHPProcess {
	readonly finished: Promise<void>;
	private readonly child: ChildProcess;
	private readonly ready: Promise<unknown>;

	constructor(request: WorkerRequest) {
		const child = fork(WORKER_ENTRYPOINT, [], {
			stdio: ["inherit", "inherit", "inherit", "ipc"],
		});
		this.child = child;

		let resolveReady!: (result: unknown) => void;
		let rejectReady!: (error: Error) => void;
		this.ready = new Promise((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		// A caller may only care about the process finishing.
		this.ready.catch(() => {});

		let ready = false;
		let reportedError: Error | undefined;
		this.finished = new Promise((resolve, reject) => {
			child.on("message", (message: WorkerMessage) => {
				if (message.type === "ready") {
					ready = true;
					resolveReady(message.result);
				} else if (message.type === "error") {
					reportedError = workerError(message.error);
					rejectReady(reportedError);
				}
			});
			child.once("error", error => {
				reportedError = error;
				rejectReady(error);
				reject(error);
			});
			child.once("exit", (code, signal) => {
				if (reportedError) {
					reject(reportedError);
					return;
				}
				if (!ready) {
					const error = new Error(
						signal ?
							`AstroHP worker was terminated by ${signal}` :
							`AstroHP worker exited with status ${code}`,
					);
					rejectReady(error);
					reject(error);
					return;
				}
				if (code === 0) {
					resolve();
				} else {
					reject(
						new Error(
							signal ?
								`AstroHP worker was terminated by ${signal}` :
								`AstroHP worker exited with status ${code}`,
						),
					);
				}
			});
		});
		// Startup callers observe `ready`; runtime callers can observe `finished`.
		this.finished.catch(() => {});

		child.send(request);
	}

	waitUntilReady(): Promise<unknown> {
		return this.ready;
	}

	async close(): Promise<void> {
		if (this.child.connected) this.child.send({ type: "close" });
		await this.finished;
	}
}

function run(
	operation: WorkerRequest["operation"],
	webroots: Webroot | readonly Webroot[],
	options?: WorkerRequest["options"],
): WorkerProcess {
	const roots: readonly Webroot[] = Array.isArray(webroots) ?
		webroots :
		[webroots as Webroot];
	if (!roots.length) throw new Error("No AstroHP webroots found");
	return new WorkerProcess({
		operation,
		webroots: roots.map(serializeWebroot),
		...(options === undefined ? {} : { options }),
	});
}

export async function build(webroot: Webroot): Promise<string> {
	const worker = run("build", webroot);
	const result = await worker.waitUntilReady();
	await worker.finished;
	return String(result);
}

export async function dev(
	webroot: Webroot,
	options: DevServerOptions = {},
): Promise<AstroHPProcess> {
	const worker = run("dev", webroot, options);
	await worker.waitUntilReady();
	return worker;
}

export async function start(
	webroots: Webroot | readonly Webroot[],
	options: LiveServerOptions = {},
): Promise<AstroHPProcess> {
	const worker = run("start", webroots, options);
	await worker.waitUntilReady();
	return worker;
}
