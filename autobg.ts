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
		return "(日志不可读)";
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
							`${mark} [${id}] 后台命令结束:exit ${exitCode},用时 ${dur}\n` +
								`命令:${head}\n日志尾部:\n${tail || "(无输出)"}\n` +
								`(完整日志 ${logPath};若该命令服务于此前的任务,请基于结果继续收尾)`,
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
							startedAt: Date.now(),
							logPath: path.join(BG_DIR, `${id}.log`),
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
							note: "运行中",
							updated: nowSec(),
							...(owner ? { owner } : {}),
						});
						task.touch = setInterval(() => {
							const t = tasks.get(id);
							if (!t) return;
							void writeStatus(id, {
								note: `运行 ${fmtDur(Date.now() - t.startedAt)}`,
								updated: nowSec(),
							});
						}, TOUCH_S * 1000);
						task.touch.unref?.();

						onData(
							Buffer.from(
								`\n[autobg] 命令已运行 ${fmtDur(demoteMs)} 仍未结束,自动转后台继续执行(pid ${child.pid},未被杀死):\n` +
									`- 任务 id:${id}(footer chip 可见;/task-status 查看)\n` +
									`- 完整日志:${task.logPath}\n` +
									`- 结束时会自动通知(exit code + 日志尾部),届时再根据结果继续\n` +
									`- 现在可以继续做其他工作;需要中途查看可 tail 日志;不要重复启动同一命令\n`,
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
				`⏱ 工具 ${w.toolName} 已运行 ${fmtDur(now - w.startedAt)}(其中 ${fmtDur(silent)} 无进展)。` +
					(ABORT_S > 0 && !NEVER_ABORT.has(w.toolName)
						? `若持续静默至 ${fmtDur(ABORT_S * 1000)} 将自动中止本次运行并唤醒模型调整。`
						: `该工具不会自动中止;确认挂死可 Esc。`),
				"warning",
			);
			wake(
				pi,
				w.toolCallId,
				`[autobg] 提示:工具 ${w.toolName} 在本次调用中已静默 ${fmtDur(silent)} 无进展。` +
					`若它最终正常完成,此条仅作回顾——此类调用建议改为分步执行或可后台化的方式;` +
					`若被中止,请结合中止说明调整方案。`,
			);
		}
		if (ABORT_S > 0 && !NEVER_ABORT.has(w.toolName) && silent >= ABORT_S * 1000 && !w.aborted) {
			w.aborted = true; // one verdict per call — settle either branch below
			const n = abortCount.get(w.toolName) ?? 0;
			if (n < MAX_AUTO_ABORTS) {
				abortCount.set(w.toolName, n + 1);
				const cap = n + 1 >= MAX_AUTO_ABORTS ? `本会话该工具自动中止已达上限(${n + 1} 次),之后不再自动中止。` : "";
				wake(
					pi,
					w.toolCallId,
					`[autobg] 工具 ${w.toolName} 静默 ${fmtDur(silent)},判定挂死,已自动中止本次运行` +
						`(已完成的工具结果与会话历史均保留)。请换一种方式推进:检查该工具是否适用/参数是否触发交互等待/依赖服务是否在线;` +
						`必要时明确告知用户当前状况。${cap}`,
				);
				try {
					uiCtx?.abort?.();
				} catch (e) {
					safeNotify(`[autobg] abort failed for ${w.toolName}: ${String(e).slice(0, 120)}`, "error");
				}
			} else {
				// cap reached: no more auto-aborts, but never silently — say so once
				safeNotify(`⏱ 工具 ${w.toolName} 再次静默 ${fmtDur(silent)},自动中止已达上限(${n} 次),不再自动中止;确认挂死可 Esc。`, "warning");
				wake(
					pi,
					w.toolCallId,
					`[autobg] 工具 ${w.toolName} 再次静默 ${fmtDur(silent)}。本会话该工具的自动中止已达上限(${n} 次),本次不再自动中止。` +
						`请自行决断:换一种方式推进、排查该工具的依赖,或明确请用户 Esc。`,
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
					`[autobg] 以下 MCP server 未配置 timeout,挂死时工具调用会无限等待:${missing.join(", ")}。` +
						`在 mcp.json 为它们加 "timeout"(秒)后,超时会返回错误结果,模型可自行继续。`,
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
				ctx.ui.notify("没有运行中的后台命令", "info");
				return;
			}
			const now = Date.now();
			const lines = [...tasks.values()].map(
				(t) =>
					`${t.id} · pid ${t.pid} · ${fmtDur(now - t.startedAt)}\n` +
					`  ${t.command.trim().split("\n")[0]?.slice(0, 100)}\n` +
					`  日志:${t.logPath}`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
