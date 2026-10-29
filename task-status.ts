/**
 * task-status.ts — generic background-task progress chips for Pi's footer
 *
 * ─────────────────────────────────────────────────────────────
 * 1. Data convention (any process can report; no pi-side wiring)
 *
 *    ~/.pi/agent/status/<id>.json
 *    {
 *      "id":      "asr-batch",        // unique id (= filename, overwrites)
 *      "label":   "Transcribe batch", // footer display name (≤10 chars advised)
 *      "done":    16,                 // completed units
 *      "total":   153,                // total units
 *      "note":    "RTF 0.06 · 3.4h left",  // optional suffix (≤24 chars advised)
 *      "updated": 1761234567          // unix seconds; missing = never expires
 *    }
 *
 *    Writers (any of these):
 *      python: json.dump({...}, open(path, "w"))
 *      shell:  echo '{"id":"x","label":"L","done":1,"total":10,"updated":'$(date +%s)'}' > path
 *    Atomic writes recommended (tmp + rename); transient half-written JSON is
 *    tolerated for a few ticks, then surfaced (see §7).
 *    A companion CLI ships in scripts/task_status.py (set/bump/done/sync/rm/ls).
 *
 * ─────────────────────────────────────────────────────────────
 * 2. Rendering rules
 *
 *    ✓  green   done >= total
 *    ◆  accent  in progress
 *    ·  yellow  "stale": no update for STALE_AFTER_S seconds and not done
 *    auto-hide: no update for HIDE_AFTER_S seconds (default 30 min)
 *    at most MAX_TASKS chips, newest first
 *
 * ─────────────────────────────────────────────────────────────
 * 3. Command
 *
 *    /task-status           refresh + list all tasks (incl. hidden) + problem files
 *    /task-status clear     delete every status file
 *
 * ─────────────────────────────────────────────────────────────
 * 4. Environment overrides (all sanitized: garbage/0/negative fall back to
 *    the default, and the ignored value is reported once at session start —
 *    a bad PI_TASK_REFRESH_MS can never spin the loop at 0 ms)
 *
 *    PI_TASK_STATUS_DIR     status dir (default ~/.pi/agent/status)
 *    PI_TASK_MAX            max chips shown (default 3, min 1, max 20)
 *    PI_TASK_REFRESH_MS     poll interval ms (default 5000, min 500, max 600000)
 *    PI_TASK_HIDE_MIN       hide threshold minutes (default 30)
 *    PI_TASK_STALE_SEC      stale threshold seconds (default 180)
 *    PI_TASK_WAKE           "0" disables the watchdog (default on)
 *    PI_TASK_WAKE_MIN       nudge threshold minutes (default 5)
 *    PI_TASK_MAX_FILE_KB    per-file size cap before flagging (default 64)
 *    PI_TASK_MAX_FILES      max status files read per tick (default 200)
 *
 * ─────────────────────────────────────────────────────────────
 * 5. Agent tool `task_progress` (set | bump | done | remove)
 *
 *    Registered via registerTool so the agent can drive the same status
 *    files without knowing the CLI path. The "set" result embeds the wiring
 *    recipe (script-side bump / direct JSON writes) — point-of-use
 *    education, not just a confirmation. promptGuidelines adds one bullet
 *    to the system prompt so batch tasks surface the tool unprompted.
 *
 * ─────────────────────────────────────────────────────────────
 * 6. Stale wakeup — the watchdog half of the loop
 *
 *    A visible task with no update for PI_TASK_WAKE_MIN minutes (default 5)
 *    and not done gets ONE nudge per update-level: pi.sendUserMessage(...,
 *    {deliverAs:"followUp"}) wakes the idle agent (or queues behind a busy
 *    run — never interrupts) with the stalled facts + remediation hints.
 *    Progress on the task re-arms the nudge. This turns "check on stuck
 *    jobs" from model habit into extension behavior.
 *
 * ─────────────────────────────────────────────────────────────
 * 7. Conversation isolation (multi-session safety)
 *
 *    STATUS_DIR is machine-global, but tasks belong to the conversation
 *    that created them. The extension stamps owner=<sessionId> on every
 *    tool write (and the educator recipe teaches scripts to preserve it).
 *    STRICT isolation: the footer and watchdog consider only tasks owned
 *    by THIS conversation. Ownerless files (legacy writers, manual echoes)
 *    are ignored unless claimed (/task-status claim <id> — adoption also
 *    happens implicitly on any tool bump/done) or opted in globally with
 *    PI_TASK_SHOW_OWNERLESS=1 (legacy display + claim-then-nudge).
 *    /task-status still lists everything, marking foreign rows [other] and
 *    unowned rows [ownerless]. PI_TASK_ISOLATION=0 disables isolation
 *    entirely (also off when no session id is available, e.g. harnesses).
 *
 * ─────────────────────────────────────────────────────────────
 * 8. Hardening: never block, never spin, never fail silently
 *
 *    - All filesystem access is async (fs/promises): the TUI event loop is
 *      never blocked by a slow or networked STATUS_DIR.
 *    - The poll loop is a self-rescheduling setTimeout (never overlapping),
 *      timer.unref()'d (a leaked timer can never keep the process alive),
 *      and re-armed defensively on repeated session_start.
 *    - Per-file size cap and per-tick file-count cap bound worst-case work.
 *    - Repeated refresh failures back off to 30 s and notify the user on
 *      every 3rd consecutive failure.
 *    - Problem files (persistently unparseable, oversized, wrong schema)
 *      are counted per tick, listed by /task-status, and announced once.
 *    - Watchdog delivery failures are announced, not swallowed.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Config: sanitized env — garbage/0/negative would spin or kill semantics ──
const envIssues: string[] = [];

function envNum(name: string, def: number, min: number, max: number): number {
	const raw = process.env[name];
	if (raw === undefined) return def;
	if (raw.trim() === "") {
		envIssues.push(`${name}="" → ${def}`);
		return def;
	}
	const v = Number(raw);
	if (!Number.isFinite(v)) {
		envIssues.push(`${name}="${raw}" not a number → ${def}`);
		return def;
	}
	if (v < min) {
		envIssues.push(`${name}=${raw} below min ${min} → ${def}`);
		return def;
	}
	if (v > max) {
		envIssues.push(`${name}=${raw} above max ${max} → clamped to ${max}`);
		return max;
	}
	return v;
}

const STATUS_DIR = process.env.PI_TASK_STATUS_DIR
	? process.env.PI_TASK_STATUS_DIR.replace(/^~/, os.homedir())
	: path.join(os.homedir(), ".pi", "agent", "status");

const STATUS_KEY = "task-progress";
const MAX_TASKS = envNum("PI_TASK_MAX", 3, 1, 20);
const REFRESH_MS = envNum("PI_TASK_REFRESH_MS", 5000, 500, 600_000);
const HIDE_AFTER_S = envNum("PI_TASK_HIDE_MIN", 30, 1, 1440) * 60;
const STALE_AFTER_S = envNum("PI_TASK_STALE_SEC", 180, 5, 86_400);
const WAKE_ENABLED = (process.env.PI_TASK_WAKE ?? "1") !== "0";
const WAKE_AFTER_S = envNum("PI_TASK_WAKE_MIN", 5, 1, 1440) * 60;
const MAX_FILE_BYTES = envNum("PI_TASK_MAX_FILE_KB", 64, 1, 4096) * 1024;
const MAX_FILES = envNum("PI_TASK_MAX_FILES", 200, 1, 10_000);

const BAD_AFTER_TICKS = 5; // consecutive problem ticks before a file is announced
const FAIL_NOTIFY_EVERY = 3; // notify on every Nth consecutive refresh failure
const BACKOFF_MS = 30_000; // refresh cadence while repeatedly failing
const MAX_NUDGES_PER_TICK = 1; // watchdog flood control
const MAX_ANNOUNCE_PER_TICK = 3; // problem-file announcements per tick

type Task = {
	id?: string;
	label?: string;
	done?: number;
	total?: number;
	note?: string;
	updated?: number;
	/** Owning conversation id (conversation isolation, §7); absent = ownerless */
	owner?: string;
	/** Optional unit ("lec", "posts", "MB"); only shown by /task-status listing */
	unit?: string;
};

type BadFile = { why: string; count: number };

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

/** Completion percent (0-100; 0 when total = 0). */
function pctOf(t: Task): number {
	const total = t.total ?? 0;
	if (total <= 0) return 0;
	const done = Math.min(t.done ?? 0, total);
	return Math.round((done / total) * 100);
}

function isDone(t: Task): boolean {
	return (t.total ?? 0) > 0 && (t.done ?? 0) >= (t.total ?? 0);
}

function isStale(t: Task): boolean {
	if (!t.updated || isDone(t)) return false;
	return nowSec() - t.updated > STALE_AFTER_S;
}

function isVisible(t: Task): boolean {
	return !t.updated || nowSec() - t.updated <= HIDE_AFTER_S;
}

function bumpBad(bad: Map<string, BadFile>, file: string, why: string): void {
	const e = bad.get(file);
	if (e) {
		e.count++;
		e.why = why;
	} else {
		bad.set(file, { why, count: 1 });
	}
}

/**
 * One async pass over STATUS_DIR. Never throws: directory-level errors
 * return an empty result (missing dir legitimately means "no tasks");
 * per-file problems are accumulated into `bad` with consecutive counts.
 */
async function readStatusDir(bad: Map<string, BadFile>): Promise<{ tasks: Task[]; truncated: number }> {
	const tasks: Task[] = [];
	let names: string[];
	try {
		names = await fsp.readdir(STATUS_DIR);
	} catch {
		bad.clear();
		return { tasks, truncated: 0 };
	}
	const jsons = names.filter((n) => n.endsWith(".json"));
	const truncated = Math.max(0, jsons.length - MAX_FILES);
	const nameSet = new Set(jsons);
	for (const k of [...bad.keys()]) if (!nameSet.has(k)) bad.delete(k);

	for (const n of jsons.slice(0, MAX_FILES)) {
		const fp = path.join(STATUS_DIR, n);
		try {
			const st = await fsp.stat(fp);
			if (st.size > MAX_FILE_BYTES) {
				bumpBad(bad, n, `oversized ${st.size} B > ${MAX_FILE_BYTES} B`);
				continue;
			}
			const t = JSON.parse(await fsp.readFile(fp, "utf-8")) as Task;
			if (typeof t.done === "number" && typeof t.total === "number") {
				bad.delete(n);
				if (!t.id) t.id = path.basename(n, ".json");
				tasks.push(t);
			} else {
				bumpBad(bad, n, "JSON lacks numeric done/total");
			}
		} catch {
			// half-written file mid atomic-rename is normal; count and surface
			// only when the problem persists (BAD_AFTER_TICKS consecutive ticks)
			bumpBad(bad, n, "unreadable / invalid JSON");
		}
	}
	tasks.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
	return { tasks, truncated };
}

let dirEnsured = false;

/** Atomic status write (tmp + rename), per the documented convention. */
async function writeStatusAtomic(t: Task): Promise<void> {
	if (!dirEnsured) {
		await fsp.mkdir(STATUS_DIR, { recursive: true });
		dirEnsured = true;
	}
	const fp = path.join(STATUS_DIR, `${t.id}.json`);
	const tmp = `${fp}.${process.pid}.tmp`;
	try {
		await fsp.writeFile(tmp, JSON.stringify(t));
		await fsp.rename(tmp, fp);
	} catch (e) {
		dirEnsured = false; // dir may have vanished — re-ensure next time
		throw e;
	}
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function toolError(msg: string) {
	return { content: [{ type: "text" as const, text: `ERROR: ${msg}` }], details: {}, isError: true };
}

/** Locate the companion CLI for the educator text (probe known installs). */
function resolveCli(): string {
	const cands = [
		path.join(os.homedir(), ".pi", "agent", "scripts", "task_status.py"),
		path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-task-status", "scripts", "task_status.py"),
	];
	for (const c of cands) {
		try {
			fs.accessSync(c);
			return c;
		} catch {
			/* try next */
		}
	}
	return cands[0]; // canonical path; the JSON recipe still works without it
}

export default function (pi: ExtensionAPI) {
	// ── loop state (all per-instance) ─────────────────────────────────────
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let uiCtx: any;
	let lastLine = "";
	let inFlight = false;
	let consecFails = 0;
	let mySession: string | undefined; // owning conversation id (§7)
	const badFiles = new Map<string, BadFile>();
	const announcedBad = new Set<string>();
	const announcedNoown = new Set<string>(); // un-attributed tasks already announced (§7)
	const announcedTrunc = new Set<string>(); // single-element use: dir truncation
	const nudgedFor = new Map<string, number>(); // id → task.updated at nudge time
	const wakeFailAnnounced = new Set<string>();
	const cliPath = resolveCli();

	// Conversation isolation (§7): off when no session id or opted out.
	// STRICT by default: only this conversation's tasks are rendered/nudged;
	// ownerless files need PI_TASK_SHOW_OWNERLESS=1 or an explicit claim.
	const isolationOn = () => !!mySession && (process.env.PI_TASK_ISOLATION ?? "1") !== "0";
	const showOwnerless = () => (process.env.PI_TASK_SHOW_OWNERLESS ?? "0") === "1";
	/** True when this session may display/nudge the task. */
	const ownTask = (t: Task) =>
		!isolationOn() || t.owner === mySession || (!t.owner && showOwnerless());
	/** Stamp this session as owner on CREATION only — an existing un-stamped
	 *  file may belong to another conversation (legacy writer) and must never
	 *  be adopted implicitly; explicit adoption is /task-status claim. */
	const stampOwner = (t: Task) => {
		if (isolationOn() && !t.owner) t.owner = mySession;
	};

	const safeNotify = (ctx: any, msg: string, kind: "info" | "warning" | "error" = "info") => {
		try {
			ctx?.ui?.notify?.(msg, kind);
		} catch {
			/* notification must never take the loop down */
		}
	};

	// ── render: pure, in-memory — zero filesystem work ────────────────────
	const renderTasks = (ctx: any, visibleTasks: Task[]) => {
		const tasks = visibleTasks.slice(0, MAX_TASKS);
		if (tasks.length === 0) {
			if (lastLine !== "") {
				try {
					ctx.ui.setStatus(STATUS_KEY, undefined);
				} catch {
					/* ctx invalidated */
				}
				lastLine = "";
			}
			return;
		}
		const theme = ctx.ui.theme;
		const parts = tasks.map((t) => {
			const done = t.done ?? 0;
			const total = t.total ?? 0;
			const doneNow = isDone(t);
			const marker = doneNow ? theme.fg("success", "✓") : theme.fg("accent", "◆");
			const label = theme.fg(doneNow ? "dim" : "text", t.label ?? t.id ?? "task");
			const counts = theme.fg(doneNow ? "success" : "dim", ` ${done}/${total} ${pctOf(t)}%`);
			const note = t.note ? theme.fg("dim", ` · ${t.note}`) : "";
			const warn = isStale(t) ? theme.fg("warning", " · stale") : "";
			return `${marker} ${label}${counts}${note}${warn}`;
		});
		const line = parts.join(theme.fg("dim", "   "));
		if (line !== lastLine) {
			// Skip identical updates to avoid needless TUI redraws
			try {
				ctx.ui.setStatus(STATUS_KEY, line);
			} catch {
				/* ctx invalidated */
			}
			lastLine = line;
		}
	};

	// ── watchdog: one nudge per update-level, re-armed by progress, session-scoped ──
	const wakeStale = async (ctx: any, visibleTasks: Task[]) => {
		if (!WAKE_ENABLED || typeof pi.sendUserMessage !== "function") return;
		let sent = 0;
		const alive = new Set<string>();
		for (const t of visibleTasks) {
			const id = t.id ?? "";
			if (!id) continue;
			alive.add(id);
			if (isDone(t) || !t.updated) continue;
			if (!ownTask(t)) continue; // foreign conversations handle their own
			const idleS = nowSec() - t.updated;
			if (idleS < WAKE_AFTER_S) continue;
			if (nudgedFor.get(id) === t.updated) continue; // already nudged at this level
			if (sent >= MAX_NUDGES_PER_TICK) continue; // next tick drains the rest
			// Claim ownerless tasks before nudging: exactly one session wakes.
			// Re-read after the write; losing the claim race means skip (tiny
			// window, worst case one duplicate nudge — documented trade-off).
			if (isolationOn() && !t.owner) {
				try {
					stampOwner(t);
					await writeStatusAtomic(t);
					const reread = JSON.parse(await fsp.readFile(path.join(STATUS_DIR, `${id}.json`), "utf-8")) as Task;
					if (reread.owner && reread.owner !== mySession) continue; // lost the race
				} catch {
					/* claim failed: nudge anyway — degraded but visible */
				}
			}
			const label = t.label ?? id;
			const counts = (t.total ?? 0) > 0 ? ` ${t.done ?? 0}/${t.total}` : "";
			const note = t.note ? ` · ${t.note}` : "";
			const min = Math.max(1, Math.round(idleS / 60));
			try {
				pi.sendUserMessage(
					`⚠️ [task-status] "${label}"${counts}${note} has shown no progress for ${min} min. ` +
						`If it should still be running: check the process (ps aux | grep …) and its logs for the stall cause, then resume reporting with task_progress. ` +
						`If it finished silently or was abandoned: close it out with task_progress {"action":"done"|"remove","id":"${id}"}.`,
					{ deliverAs: "followUp" },
				);
				nudgedFor.set(id, t.updated);
				sent++;
			} catch (e) {
				if (!wakeFailAnnounced.has(id)) {
					wakeFailAnnounced.add(id);
					safeNotify(ctx, `[task-status] watchdog nudge for "${id}" failed: ${String(e).slice(0, 120)}`, "error");
				}
			}
		}
		for (const id of [...nudgedFor.keys()]) {
			if (!alive.has(id)) nudgedFor.delete(id);
		}
	};

	// ── problem announcement: first sight only, bounded per tick ───────────
	const announceProblems = (ctx: any, truncated: number) => {
		let announced = 0;
		for (const [file, e] of badFiles) {
			if (e.count < BAD_AFTER_TICKS || announcedBad.has(file) || announced >= MAX_ANNOUNCE_PER_TICK) continue;
			announcedBad.add(file);
			announced++;
			safeNotify(ctx, `[task-status] ignoring ${file}: ${e.why} (×${e.count} ticks) — see /task-status`, "error");
		}
		if (truncated > 0 && !announcedTrunc.has("t")) {
			announcedTrunc.add("t");
			safeNotify(ctx, `[task-status] ${truncated} status file(s) beyond PI_TASK_MAX_FILES=${MAX_FILES} are not being read`, "error");
		}
	};

	// ── un-attributed tasks: hidden by default, but never silently — announce
	//    once per file with the claim recipe (§7; user: “不能静默无视，需要提醒”) ──
	const announceUnattributed = (ctx: any, allTasks: Task[]) => {
		if (!isolationOn() || showOwnerless()) return;
		let announced = 0;
		const present = new Set<string>();
		for (const t of allTasks) {
			const id = t.id ?? "";
			if (!id) continue;
			if (t.owner) { present.add(id); continue; }
			present.add(id);
			if (announcedNoown.has(id) || announced >= MAX_ANNOUNCE_PER_TICK) continue;
			announcedNoown.add(id);
			announced++;
			const counts = (t.total ?? 0) > 0 ? ` ${t.done ?? 0}/${t.total}` : "";
			const note = t.note ? ` · ${t.note}` : "";
			safeNotify(
				ctx,
				`[task-status] un-attributed task "${t.label ?? id}"${counts}${note} — not shown or watched in this session. ` +
					`If it belongs here: /task-status claim ${id} · otherwise it's another conversation's (legacy writer). Full list: /task-status`,
				"warning",
			);
		}
		for (const id of [...announcedNoown.keys()]) {
			if (!present.has(id)) announcedNoown.delete(id); // file gone → re-arm
		}
	};

	// ── one async refresh pass: read once, feed render + watchdog + announce ──
	const refresh = async (ctx: any) => {
		if (inFlight) return; // never overlap passes
		inFlight = true;
		;(globalThis as any).__taskStatusTestHook?.("refresh"); // test seam: cadence/failure observation
		try {
			const { tasks, truncated } = await readStatusDir(badFiles);
			consecFails = 0;
			announceUnattributed(ctx, tasks);
			const visibleTasks = tasks.filter(isVisible).filter(ownTask); // §7: own only (strict)
			announceProblems(ctx, truncated);
			renderTasks(ctx, visibleTasks);
			await wakeStale(ctx, visibleTasks);
		} catch (e) {
			// readStatusDir is designed not to throw; this is a belt-and-braces net
			consecFails++;
			if (consecFails % FAIL_NOTIFY_EVERY === 0) {
				safeNotify(
					ctx,
					`[task-status] refresh failed ${consecFails}× (${String(e).slice(0, 120)}) — backing off to ${BACKOFF_MS / 1000}s`,
					"error",
				);
			}
		} finally {
			inFlight = false;
		}
	};

	// ── self-rescheduling timer: no overlap possible, unref'd, re-arm-safe ──
	let stopped = false;
	const schedule = (ctx: any, immediate = false) => {
		if (stopped) return; // session_shutdown must be final — no zombie re-arm
		if (refreshTimer) clearTimeout(refreshTimer);
		const delay = consecFails >= FAIL_NOTIFY_EVERY ? BACKOFF_MS : REFRESH_MS;
		refreshTimer = setTimeout(async () => {
			await refresh(ctx);
			schedule(ctx);
		}, immediate ? 0 : delay);
		refreshTimer.unref?.(); // a leaked timer must never keep the process alive
	};

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		try {
			mySession = ctx?.sessionManager?.getSessionId?.();
		} catch {
			mySession = undefined; // isolation degrades to global (old behaviour)
		}
		// Defensive re-arm: repeated session_start must not stack timers
		schedule(ctx, true);
		if (envIssues.length > 0) {
			safeNotify(ctx, `[task-status] ignored invalid env: ${envIssues.join("; ")}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		stopped = true; // beats the race: a callback mid-flight cannot re-arm
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = undefined;
		}
	});

	pi.registerCommand("task-status", {
		description: "Show background task progress; 'clear' removes all status files",
		handler: async (args: string, ctx: any) => {
			const arg = (args ?? "").trim();
			const sub = arg.split(/\s+/);
			if (arg === "clear") {
				let n = 0;
				try {
					for (const f of await fsp.readdir(STATUS_DIR)) {
						if (!f.endsWith(".json")) continue;
						try {
							await fsp.unlink(path.join(STATUS_DIR, f));
							n++;
						} catch {
							/* count what we could remove */
						}
					}
				} catch {
					/* dir missing: nothing to clear */
				}
				badFiles.clear();
				announcedBad.clear();
				announcedNoown.clear();
				announcedTrunc.clear();
				await refresh(ctx);
				ctx.ui.notify(`Removed ${n} task status file(s)`, "info");
				return;
			}

			// claim <id> / release <id>: adopt an ownerless task into this
			// conversation (or give it back) — the chip appears only for the owner
			if ((sub[0] === "claim" || sub[0] === "release") && sub[1]) {
				const id = sub[1];
				if (!ID_RE.test(id)) {
					ctx.ui.notify(`invalid id "${id}"`, "error");
					return;
				}
				if (!mySession) {
					ctx.ui.notify("claim needs a session id (isolation unavailable)", "error");
					return;
				}
				let t: Task | undefined;
				try {
					t = JSON.parse(await fsp.readFile(path.join(STATUS_DIR, `${id}.json`), "utf-8")) as Task;
				} catch {
					t = undefined;
				}
				if (!t || typeof t.done !== "number" || typeof t.total !== "number") {
					ctx.ui.notify(`no readable task "${id}" — see /task-status`, "error");
					return;
				}
				if (sub[0] === "claim") {
					if (t.owner && t.owner !== mySession) {
						ctx.ui.notify(`"${id}" belongs to another conversation — claim only works on [ownerless] rows`, "error");
						return;
					}
					t.owner = mySession;
					await writeStatusAtomic(t);
					await refresh(ctx);
					ctx.ui.notify(`claimed "${id}" — its chip now belongs to this conversation`, "info");
				} else {
					delete t.owner; // give it back to ownerless
					await writeStatusAtomic(t);
					await refresh(ctx);
					ctx.ui.notify(`released "${id}" — ownerless again (hidden here unless PI_TASK_SHOW_OWNERLESS=1)`, "info");
				}
				return;
			}

			await refresh(ctx);
			const { tasks, truncated } = await readStatusDir(badFiles);
			const rows: string[] = [];
			if (tasks.length === 0 && badFiles.size === 0) {
				rows.push(`No task statuses (dir: ${STATUS_DIR})`);
			}
			for (const t of tasks) {
				const stale = isStale(t) ? " [stale]" : "";
				const hid = t.updated && nowSec() - t.updated > HIDE_AFTER_S ? " [hidden]" : "";
				const other = t.owner && mySession && t.owner !== mySession ? " [other]" : "";
				const noown = !t.owner && mySession ? " [ownerless]" : "";
				const unit = t.unit ? t.unit : "";
				const note = t.note ? `  ${t.note}` : "";
				rows.push(`${isDone(t) ? "✓" : "◆"} ${t.label ?? t.id}  ${t.done}/${t.total}${unit} ${pctOf(t)}%${stale}${hid}${other}${noown}${note}`);
			}
			if (mySession && tasks.some((t) => !t.owner)) {
				rows.push("  ℹ ownerless rows: /task-status claim <id> to adopt into this conversation");
			}
			if (badFiles.size > 0) {
				rows.push("");
				rows.push("Problem files:");
				for (const [file, e] of badFiles) rows.push(`  ✗ ${file} — ${e.why} (×${e.count})`);
			}
			if (truncated > 0) rows.push(`  ⚠ ${truncated} file(s) beyond PI_TASK_MAX_FILES=${MAX_FILES} unread`);
			if (envIssues.length > 0) rows.push(`  ⚠ env ignored: ${envIssues.join("; ")}`);
			ctx.ui.notify(rows.join("\n"), "info");
		},
	});

	// ── 5. Agent tool: same status files, driven by the model ──────────────
	pi.registerTool({
		name: "task_progress",
		label: "Task Progress",
		description:
			"Live footer progress bar for long-running batch work (transcription, media conversion, " +
			"downloads, multi-item loops). Call action=set BEFORE launching the job; per-unit updates " +
			"must come from inside the running script (tools cannot fire mid-script) — the set result " +
			"contains the exact wiring recipe; call action=done when finished.",
		promptSnippet: "task_progress — live footer progress bar for long-running batch tasks (set/bump/done/remove)",
		promptGuidelines: [
			"Before launching any long-running batch job (transcription, media conversion, batch downloads, " +
				"multi-item processing loops), call task_progress with action=set so the user gets a live footer " +
				"progress bar; wire per-unit updates into the script itself (task_status.py bump or direct JSON " +
				"writes — recipe in the set result); call action=done when the job finishes.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("set"), Type.Literal("bump"), Type.Literal("done"), Type.Literal("remove")],
				{ description: "set = create/replace task; bump = done += n; done = mark complete; remove = delete status file" },
			),
			id: Type.String({ description: "unique task id, filename-safe [A-Za-z0-9._-] (e.g. asr-batch); becomes the status filename" }),
			label: Type.Optional(Type.String({ description: "footer display name (≤12 chars advised; default = id or previous label)" })),
			total: Type.Optional(Type.Number({ description: "total units (required for set; also creates/updates on bump/done)", minimum: 1 })),
			done: Type.Optional(Type.Number({ description: "set: initial completed count (default 0)", minimum: 0 })),
			n: Type.Optional(Type.Number({ description: "bump: increment per call (default 1)", minimum: 1 })),
			note: Type.Optional(Type.String({ description: "short suffix after counts, e.g. \"RTF 0.06 · 3.4h left\" (≤24 chars advised)" })),
		}),
		async execute(_toolCallId, params) {
			const id = String(params.id ?? "").trim();
			if (!ID_RE.test(id)) {
				return toolError(`invalid id "${id}" — use filename-safe [A-Za-z0-9][A-Za-z0-9._-]{0,63}`);
			}
			let prev: Task | undefined;
			try {
				const parsed = JSON.parse(await fsp.readFile(path.join(STATUS_DIR, `${id}.json`), "utf-8")) as Task;
				// Schema-check: a corrupt/partial existing file must not leak garbage
				// into bump/done math — treat it as absent (error paths handle it)
				if (typeof parsed.done === "number" && typeof parsed.total === "number") prev = parsed;
			} catch {
				prev = undefined; // absent task is normal, not an error
			}
			const fp = path.join(STATUS_DIR, `${id}.json`);
			let text: string;

			switch (params.action) {
				case "set": {
					const total = params.total;
					if (!total || total < 1) return toolError('action "set" requires total >= 1');
					const label = params.label ?? prev?.label ?? id;
					const done = Math.max(0, Math.min(params.done ?? prev?.done ?? 0, total));
					const t: Task = { id, label, done, total, updated: nowSec() };
					if (params.note) t.note = params.note;
					stampOwner(t); // §7: this conversation owns tool-created tasks
					try {
						await writeStatusAtomic(t);
					} catch (e) {
						return toolError(`cannot write status file ${fp}: ${String(e).slice(0, 160)}`);
					}
					await refresh(uiCtx);
					const ownerField = t.owner ? `,"owner":"${t.owner}"` : "";
					text = [
						`✓ Progress chip live in footer: ◆ ${label} ${done}/${total} ${Math.round((done / total) * 100)}%`,
						``,
						`A tool call cannot fire mid-script — wire live updates into the job itself:`,
						`  per completed unit, inside the script, run ONE of:`,
						`    python3 ${cliPath} bump ${id}${t.owner ? ` --owner ${t.owner}` : ""}`,
						`    or write JSON directly (atomic tmp+rename; unix-seconds timestamp):`,
						`      {"id":"${id}","label":"${label}","done":N,"total":${total}${ownerField},"note":"...","updated":$(date +%s)} → ${fp}`,
						`When finished: task_progress {"action":"done","id":"${id}"} (✓ green; auto-hides 30 min after last update; >${STALE_AFTER_S}s idle shows "· stale").`,
						`Watchdog: if this task shows no update for ${Math.round(WAKE_AFTER_S / 60)} min, the extension wakes the agent (queued, never interrupts) to investigate — script-side bumps keep it quiet.`,
					].join("\n");
					break;
				}
				case "bump": {
					let t = prev;
					if (!t) {
						if (params.total && params.total >= 1) {
							t = { id, label: params.label ?? id, done: 0, total: params.total };
							stampOwner(t); // creation path only
						} else return toolError(`unknown task "${id}" — call action "set" first (or pass total to create it here)`);
					}
					if (params.total && params.total >= 1) t.total = params.total;
					if (params.label) t.label = params.label;
					if (params.note) t.note = params.note;
					const step = params.n && params.n >= 1 ? params.n : 1;
					t.done = Math.min((t.done ?? 0) + step, t.total ?? (t.done ?? 0) + step);
					t.updated = nowSec();
					try {
						await writeStatusAtomic(t);
					} catch (e) {
						return toolError(`cannot write status file ${fp}: ${String(e).slice(0, 160)}`);
					}
					await refresh(uiCtx);
					text = isDone(t)
						? `✓ ${t.label}: ${t.done}/${t.total} — complete (call action=done or remove to close out)`
						: `◆ ${t.label}: ${t.done}/${t.total} ${pctOf(t)}%`;
					break;
				}
				case "done": {
					let t = prev;
					if (!t) {
						if (params.total && params.total >= 1) t = { id, label: params.label ?? id, done: params.total, total: params.total };
						else return toolError(`unknown task "${id}" — call action "set" first`);
					}
					t.done = t.total ?? params.total ?? 0;
					if (params.note) t.note = params.note;
					t.updated = nowSec();
					try {
						await writeStatusAtomic(t);
					} catch (e) {
						return toolError(`cannot write status file ${fp}: ${String(e).slice(0, 160)}`);
					}
					await refresh(uiCtx);
					text = `✓ ${t.label}: ${t.done}/${t.total} — complete (chip auto-hides after ${Math.round(HIDE_AFTER_S / 60)} min)`;
					break;
				}
				case "remove": {
					try {
						await fsp.unlink(fp);
					} catch (e) {
						if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
							return toolError(`cannot remove status file ${fp}: ${String(e).slice(0, 160)}`);
						}
						/* already gone: fine */
					}
					await refresh(uiCtx);
					text = `removed status for "${id}"`;
					break;
				}
				default:
					return toolError(`unknown action "${params.action}"`);
			}
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});
}
