/**
 * autobg.ts — long-running tool calls must not stall the agent
 *
 * ─────────────────────────────────────────────────────────────
 * §1 bash auto-detach (the full fix)
 *
 *    bash commands run synchronously exactly like the built-in tool
 *    (streaming output, Esc kills the tree). Past PI_AUTOBG_DEMOTE_MS
 *    (default 120 s) the process is NOT killed: output is redirected to
 *    ~/.pi/agent/bg/<taskId>.log, the tool returns immediately with an
 *    explanation, and the model gets control back to do other work.
 *    When the process exits, a followUp message wakes the model with the
 *    exit code, duration and output tail. A kind:"bg" status file (same
 *    convention as taskwatcher core, §-interface) shows the footer chip;
 *    core's stale-nudge skips kind:"bg" — completion has its own notice.
 *
 *    Implemented at the official BashOperations seam (ssh.ts pattern);
 *    re-registered under the same name as the built-in bash
 *    (bash-spawn-hook.ts pattern). cwd/env/PI_* exposure, truncation and
 *    exit-code conventions are the built-in tool's.
 *
 * ─────────────────────────────────────────────────────────────
 * §2 generic tool stall watch (MCP / other extensions)
 *
 *    Only bash has an execution seam; for every other tool pi exposes no
 *    execute(), no per-call cancel. While such a tool hangs, the run never
 *    ends and NO message can reach the model. So:
 *
 *    - silent ≥ PI_AUTOBG_STALL_S (default 180 s):
 *        · notify the user (informational, no decision asked)
 *        · queue a followUp message for the model — it is delivered when
 *          the run ends: a retrospective if the tool eventually returned
 *          (teaching: split / background such calls), context if aborted.
 *    - silent ≥ PI_AUTOBG_ABORT_S (default 600 s, 0 disables):
 *        · abort the run (the ONLY channel to un-stick the model) and
 *          queue an explanation so the model wakes up and adjusts:
 *          different approach, check dependencies, or report to the user.
 *        · per-tool cap PI_AUTOBG_MAX_AUTO_ABORTS (default 2) prevents a
 *          retry loop; afterwards only notifications.
 *        · PI_AUTOBG_NEVER_ABORT (comma list) exempts tools that are
 *          legitimately slow without streaming updates (e.g. hear).
 *
 * ─────────────────────────────────────────────────────────────
 * §3 MCP timeout watchdog (prevention)
 *
 *    On session_start / mcp_servers_change, servers configured without a
 *    timeout are announced once: a hung MCP call would otherwise wait
 *    forever; with "timeout" in mcp.json it returns an error result and
 *    the model continues on its own.
 *
 * ─────────────────────────────────────────────────────────────
 * §4 hardening (repo invariants)
 *
 *    - all filesystem access async (fs/promises); no *Sync in hot paths
 *    - every env number sanitized via envNum(); bad values reported once
 *    - all timers unref()ed; session_start re-entry clears old timers
 *    - no silent catch: status-write failures count and are announced;
 *      wake failures announce per task id
 *    - demote never kills a process; only the synchronous-phase Esc abort
 *      does (built-in semantics)
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type BashOperations,
	type ExtensionAPI,
	createBashTool,
	getShellConfig,
} from "@earendil-works/pi-coding-agent";

// ── config: sanitized env ────────────────────────────────────────────────
const envIssues: string[] = [];
function envNum(name: string, def: number, min: number, max: number): number {
	const raw = process.env[name];
	if (raw === undefined) return def;
	if (raw.trim() === "") {
		envIssues.push(`${name}="" → ${def}`);
		return def;
	}
	const v = Number(raw);
	if (!Number.isFinite(v) || v < min) {
		envIssues.push(`${name}="${raw}" invalid/below ${min} → ${def}`);
		return def;
	}
	if (v > max) {
		envIssues.push(`${name}=${raw} above max ${max} → clamped`);
		return max;
	}
	return v;
}

const DEMOTE_MS = envNum("PI_AUTOBG_DEMOTE_MS", 120_000, 10_000, 36_000_000);
const STALL_S = envNum("PI_AUTOBG_STALL_S", 180, 30, 86_400);
const ABORT_S = envNum("PI_AUTOBG_ABORT_S", 600, 60, 86_400); // 0 → disabled below
const MAX_AUTO_ABORTS = envNum("PI_AUTOBG_MAX_AUTO_ABORTS", 2, 1, 100);
const TOUCH_S = envNum("PI_AUTOBG_TOUCH_S", 30, 10, 600);
/** bg task: still running AND log silent for this long → one check-up wake (0 disables) */
const BG_STUCK_S = envNum("PI_AUTOBG_BG_STUCK_S", 1800, 60, 86400);
const TICK_MS = envNum("PI_AUTOBG_TICK_MS", 5_000, 1_000, 60_000);
const TAIL_BYTES = 32_768;
const EXIT_GRACE_MS = 100; // sync finish: stdio wind-down (mirrors built-in)
const BG_EXIT_GRACE_MS = 500; // bg finish: let the log flush
const NEVER_ABORT = new Set(
	(process.env.PI_AUTOBG_NEVER_ABORT ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
);
const SKIP_WATCH = new Set(["bash", "powershell", "read", "write", "edit", "grep", "find", "ls"]);
const BG_DIR = process.env.PI_AUTOBG_DIR
	? process.env.PI_AUTOBG_DIR.replace(/^~/, os.homedir())
	: path.join(os.homedir(), ".pi", "agent", "bg");
const STATUS_DIR = process.env.PI_TASK_STATUS_DIR
	? process.env.PI_TASK_STATUS_DIR.replace(/^~/, os.homedir())
	: path.join(os.homedir(), ".pi", "agent", "status");
const STATUS_KEY = "autobg";

// ── shared state (per extension instance) ────────────────────────────────
interface BgTask {
	id: string;
	command: string;
	pid?: number;
	startedAt: number;
	logPath: string;
	touch?: ReturnType<typeof setInterval>;
	/** stuck-watch state: last log-growth time and one-notice-per-silence flag */
	lastLogGrowthAt: number;
	logSize: number;
	stuckNotified: boolean;
}
interface Watch {
	toolName: string;
	toolCallId: string;
	startedAt: number;
	lastActivityAt: number;
	stalledNotified: boolean; // one stall notice per silent period
	aborted: boolean; // one abort per call
}

let sessionId: string | undefined;
let shuttingDown = false;
let counter = 0;
let statusWriteFails = 0;
let statusFailAnnounced = false;
const tasks = new Map<string, BgTask>();
const watched = new Map<string, Watch>();
const abortCount = new Map<string, number>();
const wakeFailAnnounced = new Set<string>();
let uiCtx: any;
let tickTimer: ReturnType<typeof setInterval> | undefined;

const nowSec = () => Math.floor(Date.now() / 1000);

function safeNotify(msg: string, kind: "info" | "warning" | "error" = "info") {
	try {
		uiCtx?.ui?.notify?.(msg, kind);
	} catch {
		/* notification must never take the loop down */
	}
}

function fmtDur(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

function killTree(pid: number) {
	try {
		process.kill(-pid, "SIGKILL"); // detached process group
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already dead — not silent: the caller's close handler reports */
		}
	}
}

/** Wake the model (queued; never interrupts). Failures are announced (§4). */
function wake(pi: ExtensionAPI, key: string, msg: string) {
	try {
		if (typeof pi.sendUserMessage !== "function") {
			if (!wakeFailAnnounced.has(key)) {
				wakeFailAnnounced.add(key);
				safeNotify(`[autobg] sendUserMessage unavailable — cannot wake agent for ${key}`, "warning");
			}
			return;
		}
		pi.sendUserMessage(msg, { deliverAs: "followUp" });
	} catch (e) {
		if (!wakeFailAnnounced.has(key)) {
			wakeFailAnnounced.add(key);
			safeNotify(`[autobg] wake for ${key} failed: ${String(e).slice(0, 120)}`, "error");
		}
	}
}

// ── status file (taskwatcher convention; kind:"bg" exempts from stale nudge)
async function writeStatus(id: string, fields: Record<string, unknown>) {
	try {
		const file = path.join(STATUS_DIR, `${id}.json`);
		let cur: Record<string, unknown> = {};
		try {
			cur = JSON.parse(await fsp.readFile(file, "utf-8"));
		} catch {
			/* first write */
		}
		await fsp.mkdir(STATUS_DIR, { recursive: true });
		const tmp = `${file}.tmp`;
		await fsp.writeFile(tmp, JSON.stringify({ ...cur, ...fields, kind: "bg" }));
		await fsp.rename(tmp, file);
		statusWriteFails = 0;
	} catch (e) {
		// §4: no silent catch — count, then announce once per episode
		statusWriteFails++;
		if (statusWriteFails >= 3 && !statusFailAnnounced) {
			statusFailAnnounced = true;
			safeNotify(`[autobg] status writes keep failing (${String(e).slice(0, 120)}) — footer chip may be stale; see /task-status`, "error");
		}
	}
}

async function readTail(logPath: string): Promise<string> {
	try {
		const fh = await fsp.open(logPath, "r");
		try {
			const { size } = await fh.stat();
			const len = Math.min(size, TAIL_BYTES);
			const buf = Buffer.alloc(len);
			await fh.read(buf, 0, len, size - len);
			return buf.toString("utf-8");
		} finally {
			await fh.close();
		}
	} catch {
		return "(log unreadable)";
	}
}

const childExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Wait for exit; grace period after exit for stdio held by detached descendants. */
function waitWithGrace(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let exited = false;
		let code: number | null = null;
		let grace: ReturnType<typeof setTimeout> | undefined;
		const arm = () => {
			if (!exited) return;
			if (grace) clearTimeout(grace);
			grace = setTimeout(() => resolve(code), EXIT_GRACE_MS);
			grace.unref?.();
		};
		child.on("exit", (c) => {
			exited = true;
			code = c;
			arm();
		});
		child.on("error", (e) => {
			exited = true;
			if (grace) clearTimeout(grace);
			reject(e);
		});
		// data arriving after exit postpones resolution (built-in semantics)
		child.stdout?.on("data", arm);
		child.stderr?.on("data", arm);
	});
}

// ── §1 demotable bash operations ─────────────────────────────────────────
function createDemotableOps(pi: ExtensionAPI): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) =>
			new Promise<{ exitCode: number }>((resolve, reject) => {
				void (async () => {
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					try {
						await fsp.access(cwd);
					} catch {
						reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
						return;
					}

					const shell = getShellConfig();
					const fromStdin = shell.commandTransport === "stdin";
					const child = spawn(shell.shell, fromStdin ? shell.args : [...shell.args, command], {
						cwd,
						detached: process.platform !== "win32",
						env: env ?? process.env,
						stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
						windowsHide: true,
					});
					if (fromStdin) {
						child.stdin?.on("error", () => {});
						child.stdin?.end(command);
					}

					// small explicit timeout demotes earlier; timeout NEVER kills here
					const demoteMs = timeout !== undefined ? Math.min(timeout * 1000, DEMOTE_MS) : DEMOTE_MS;
	const t0 = Date.now(); // command start — durations report the FULL run
					let demoted = false;
					let logStream: WriteStream | undefined;
					const id = `bg-${(sessionId ?? "x").slice(0, 4)}${Date.now().toString(36).slice(-4)}-${++counter}`;

					const onDataChunk = (d: Buffer) => {
						if (demoted) logStream?.write(d);
						else onData(d);
					};
					child.stdout?.on("data", onDataChunk);
					child.stderr?.on("data", onDataChunk);

					// abort kills only in the synchronous phase; a detached task is independent
					const onAbort = () => {
						if (!demoted && child.pid) killTree(child.pid);
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					const bgFinish = async () => {
						const t = tasks.get(id);
						if (t?.touch) clearInterval(t.touch);
						tasks.delete(id);
						const dur = fmtDur(Date.now() - (t?.startedAt ?? Date.now()));
						const exitCode = child.exitCode;
						const mark = exitCode === 0 ? "✅" : "⚠️";
						await writeStatus(id, {
							done: 1,
							total: 1,
							note: `exit ${exitCode} · ${dur}`,
							updated: nowSec(),
						}); // label merges through (writeStatus keeps existing fields)
						if (shuttingDown) return; // session gone: file writes continue, no wake
						const head = command.trim().split("\n")[0]?.slice(0, 72) ?? "";
						const logPath = t?.logPath ?? path.join(BG_DIR, `${id}.log`);
						const tail = (await readTail(logPath)).trimEnd().slice(-2048);
						wake(
							pi,
							id,
							`${mark} [${id}] Background command finished: exit ${exitCode}, total ${dur}\n` +
							`command: ${head}\noutput tail:\n${tail || "(no output)"}\n` +
							`(full log ${logPath}; if it served an earlier task, wrap that up with this result)`,
						);
					};
					child.once("exit", () => {
						if (!demoted) return; // synchronous finish handled below
						const t = setTimeout(() => void bgFinish(), BG_EXIT_GRACE_MS);
						t.unref?.();
					});

					const demote = () => {
						// race guard: the command finished right at the threshold
						if (demoted || childExited(child)) return;
						demoted = true;
						const task: BgTask = {
							id,
							command,
							pid: child.pid,
							startedAt: t0,
							logPath: path.join(BG_DIR, `${id}.log`),
							lastLogGrowthAt: Date.now(),
							logSize: 0,
							stuckNotified: false,
						};
						tasks.set(id, task);
						void fsp.mkdir(BG_DIR, { recursive: true }).catch(() => {
							safeNotify(`[autobg] cannot create ${BG_DIR} — bg log for ${id} will be lost`, "error");
						});
						logStream = createWriteStream(task.logPath, { flags: "a" });
						logStream.on("error", () => {
							safeNotify(`[autobg] log write failed for ${id} — output of the bg command is being lost`, "error");
						});

						const label = `bg·${command.trim().split(/\s+/)[0]?.slice(0, 8) || "cmd"}`;
						const owner = env?.PI_SESSION_ID ?? sessionId;
						void writeStatus(id, {
							id,
							label,
							done: 0,
							total: 1,
							note: "running",
							updated: nowSec(),
							...(owner ? { owner } : {}),
						});
						task.touch = setInterval(() => {
							const t = tasks.get(id);
							if (!t) return;
							void writeStatus(id, {
								note: `running ${fmtDur(Date.now() - t.startedAt)}`,
								updated: nowSec(),
							});
							if (BG_STUCK_S <= 0) return;
							void (async () => {
								try {
									const st = await fsp.stat(t.logPath);
									if (st.size !== t.logSize) {
										t.logSize = st.size;
										t.lastLogGrowthAt = Date.now();
										t.stuckNotified = false; // log alive → re-arm
										return;
									}
									const silent = Date.now() - t.lastLogGrowthAt;
									if (silent < BG_STUCK_S * 1000 || t.stuckNotified) return;
									t.stuckNotified = true; // one notice per silent period
									safeNotify(
										`⏱ [autobg] ${t.id} still running after ${fmtDur(Date.now() - t.startedAt)} with no log output for ${fmtDur(silent)} — check it (/autobg, log ${t.logPath}).`,
										"warning",
									);
									wake(
										pi,
										t.id,
										`[autobg] Background task ${t.id} (pid ${t.pid}) has run ${fmtDur(Date.now() - t.startedAt)} with no log output for ${fmtDur(silent)}. ` +
											`command: ${t.command.trim().split("\n")[0]?.slice(0, 72)}\n` +
											`If this is expected (quiet long run: sleep, training, transfer), ignore. ` +
											`If suspicious: inspect the process (ps; the log at ${t.logPath}), and if it is stuck, kill ${t.pid} and proceed differently.`,
									);
								} catch {
									/* stat raced with log removal at finish — nothing to guard */
								}
							})();
						}, TOUCH_S * 1000);
						task.touch.unref?.();

						onData(
							Buffer.from(
						`
[autobg] Command still running after ${fmtDur(demoteMs)} — detached to background (pid ${child.pid}, NOT killed):\n` +
							`- task id: ${id} (footer chip; /autobg, /task-status)\n` +
							`- full log: ${task.logPath}\n` +
							`- you will be notified on exit (exit code + output tail); pick up from there\n` +
								`- sanity-check now if you expected this to finish much sooner: tail the log once — it may be stuck (waiting on input/network) rather than slow; slow-but-alive is fine to leave running\n` +
							`- proceed with other work meanwhile; tail the log to check on it; do NOT re-run this command\n`,
							),
						);
						signal?.removeEventListener("abort", onAbort);
						resolve({ exitCode: 0 }); // hand control back immediately
					};
					const demoteTimer = setTimeout(demote, demoteMs); // ref: execution path

					const code = await waitWithGrace(child);
					if (demoted) return; // bg finish owns the epilogue
					clearTimeout(demoteTimer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					// signal-killed shell has no exit code: shell convention (built-in parity)
					const sc = child.signalCode;
					resolve({ exitCode: code ?? (sc ? 128 + (os.constants.signals[sc] ?? 0) : 1) });
				})().catch((e) => reject(e instanceof Error ? e : new Error(String(e))));
			}),
	};
}

// ── §2 generic stall watch + §3 MCP timeout advice ───────────────────────
function tick(pi: ExtensionAPI) {
	if (watched.size === 0) {
		if (tickTimer !== undefined) {
			clearInterval(tickTimer);
			tickTimer = undefined;
		}
		return;
	}
	const now = Date.now();
	for (const w of watched.values()) {
		const silent = now - w.lastActivityAt;
		if (silent >= STALL_S * 1000 && !w.stalledNotified) {
			w.stalledNotified = true;
			safeNotify(
				`⏱ Tool ${w.toolName} has run ${fmtDur(now - w.startedAt)} (${fmtDur(silent)} with no progress).` +
					(ABORT_S > 0 && !NEVER_ABORT.has(w.toolName)
						? `If it stays silent for ${fmtDur(ABORT_S * 1000)}, the run will be auto-aborted and the agent woken to adjust.`
						: `This tool is never auto-aborted; press Esc if you are sure it hung.`),
				"warning",
			);
			wake(
				pi,
				w.toolCallId,
				`[autobg] Note: tool ${w.toolName} went silent for ${fmtDur(silent)} during this call. ` +
					`If it eventually completed, treat this as a retrospective — prefer stepwise or backgroundable calls for this kind of work; ` +
					`if it was aborted, adjust per the abort notice.`,
			);
		}
		if (ABORT_S > 0 && !NEVER_ABORT.has(w.toolName) && silent >= ABORT_S * 1000 && !w.aborted) {
			w.aborted = true; // one verdict per call — settle either branch below
			const n = abortCount.get(w.toolName) ?? 0;
			if (n < MAX_AUTO_ABORTS) {
				abortCount.set(w.toolName, n + 1);
				const cap = n + 1 >= MAX_AUTO_ABORTS ? `Auto-abort cap for this tool reached (${n + 1}); no further auto-aborts this session.` : "";
				wake(
					pi,
					w.toolCallId,
					`[autobg] Tool ${w.toolName} has been silent for ${fmtDur(silent)} — judged hung; the run was auto-aborted ` +
						`(completed tool results and session history are preserved). Proceed differently: check whether the tool applies / its args trigger an interactive wait / its backing service is up; ` +
						`tell the user the situation when needed. ${cap}`,
				);
				try {
					uiCtx?.abort?.();
				} catch (e) {
					safeNotify(`[autobg] abort failed for ${w.toolName}: ${String(e).slice(0, 120)}`, "error");
				}
			} else {
				// cap reached: no more auto-aborts, but never silently — say so once
				safeNotify(`⏱ Tool ${w.toolName} silent again for ${fmtDur(silent)}; auto-abort cap reached (${n}), no further auto-aborts — press Esc if you are sure it hung.`, "warning");
				wake(
					pi,
					w.toolCallId,
					`[autobg] Tool ${w.toolName} is silent again for ${fmtDur(silent)}. Its auto-abort cap (${n}) is reached; this call will not be aborted. ` +
						`Decide yourself: take a different approach, check the tool's dependencies, or ask the user to press Esc.`,
				);
			}
		}
	}
}


export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const bashTool = createBashTool(cwd, { operations: createDemotableOps(pi) });

	// Same-name registration replaces the built-in bash (bash-spawn-hook
	// pattern). The guideline prevents the model from re-running a detached
	// command after seeing the detach notice.
	pi.registerTool({
		...bashTool,
		promptGuidelines: [
			...(bashTool.promptGuidelines ?? []),
			`Commands running longer than ${Math.round(DEMOTE_MS / 1000)}s are automatically detached to the background: the result you receive says so and the command keeps running (NOT killed, NOT failed). Do not re-run it. You will be notified with its exit code and output tail when it finishes; meanwhile proceed with other work or read the log file given in the result.`,
		],
	});

	// ── §2 watch every non-builtin tool ──
	pi.on("tool_execution_start", async (event, ctx) => {
		uiCtx = ctx;
		if (event.parentToolCallId || SKIP_WATCH.has(event.toolName)) return;
		watched.set(event.toolCallId, {
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
			stalledNotified: false,
			aborted: false,
		});
		if (tickTimer === undefined) {
			tickTimer = setInterval(() => tick(pi), TICK_MS);
			tickTimer.unref?.();
		}
	});
	pi.on("tool_execution_update", async (event) => {
		const w = watched.get(event.toolCallId);
		if (w) {
			w.lastActivityAt = Date.now();
			w.stalledNotified = false; // real progress re-arms the stall notice
		}
	});
	pi.on("tool_execution_end", async (event) => {
		watched.delete(event.toolCallId);
	});
	pi.on("agent_end", async () => {
		watched.clear(); // run over (incl. Esc): no orphans
		if (tickTimer !== undefined && watched.size === 0) {
			clearInterval(tickTimer);
			tickTimer = undefined;
		}
	});

	// ── §3 MCP servers without timeout: hung calls would wait forever ──
	const mcpAdvised = new Set<string>();
	const adviseMcp = (ctx: any) => {
		try {
			const servers =
				typeof (pi as any).getMcpServers === "function"
					? ((pi as any).getMcpServers() as { name: string; timeout?: number }[])
					: [];
			const missing = servers
				.filter((s) => s.timeout === undefined)
				.map((s) => s.name)
				.filter((n) => !mcpAdvised.has(n));
			if (missing.length === 0) return;
			for (const n of missing) mcpAdvised.add(n);
			try {
				ctx?.ui?.notify?.(
					`[autobg] MCP servers without a timeout — a hung tool call would wait forever: ${missing.join(", ")}. ` +
						`Add "timeout" (seconds) in mcp.json; a timed-out call returns an error result and the model continues on its own.`,
					"warning",
				);
			} catch {
				/* §4: counted announce above via list itself */
			}
		} catch {
			/* §4: best-effort probe; failures must not break session start */
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			sessionId = undefined; // isolation degrades, features still run
		}
		shuttingDown = false;
		statusFailAnnounced = false;
		adviseMcp(ctx);
		if (envIssues.length > 0) {
			safeNotify(`[autobg] ignored invalid env: ${envIssues.join("; ")}`, "error");
		}
	});
	pi.on("mcp_servers_change", async (_event, ctx) => {
		uiCtx = ctx;
		adviseMcp(ctx);
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true; // bg processes finish and log; no more wakes
		for (const t of tasks.values()) if (t.touch) clearInterval(t.touch);
		watched.clear();
		if (tickTimer !== undefined) {
			clearInterval(tickTimer);
			tickTimer = undefined;
		}
	});

	pi.registerCommand("autobg", {
		description: "List backgrounded bash tasks (autobg)",
		handler: async (_args, ctx) => {
			if (tasks.size === 0) {
				ctx.ui.notify("No backgrounded commands running.", "info");
				return;
			}
			const now = Date.now();
			const lines = [...tasks.values()].map(
				(t) =>
					`${t.id} · pid ${t.pid} · ${fmtDur(now - t.startedAt)}\n` +
					`  log: ${t.logPath}`,
					`  log: ${t.logPath}`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
