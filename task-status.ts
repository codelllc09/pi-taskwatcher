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
 *    Atomic writes recommended (tmp + rename); partial JSON is tolerated and skipped.
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
 *    /task-status           refresh + list all tasks (incl. hidden)
 *    /task-status clear     delete every status file
 *
 * ─────────────────────────────────────────────────────────────
 * 4. Environment overrides
 *
 *    PI_TASK_STATUS_DIR     status dir (default ~/.pi/agent/status)
 *    PI_TASK_MAX            max chips shown (default 3)
 *    PI_TASK_REFRESH_MS     poll interval ms (default 5000)
 *    PI_TASK_HIDE_MIN       hide threshold minutes (default 30)
 *    PI_TASK_STALE_SEC      stale threshold seconds (default 180)
 *
 * ─────────────────────────────────────────────────────────────
 * 5. Agent tool `task_progress` (set | bump | done | remove)
 *
 *    Registered via registerTool so the agent can drive the same
 *    status files without knowing the CLI path. The "set" result
 *    embeds the wiring recipe (script-side bump / direct JSON
 *    writes) — point-of-use education, not just a confirmation.
 *    promptGuidelines adds one bullet to the system prompt so batch
 *    tasks surface the tool without the user mentioning it.
 *
 * ─────────────────────────────────────────────────────────────
 * 6. Stale wakeup — the watchdog half of the loop
 *
 *    A task that has shown no update for PI_TASK_WAKE_MIN minutes
 *    (default 5) and is not done gets ONE nudge per update-level:
 *    pi.sendUserMessage(..., {deliverAs:"followUp"}) wakes the idle
 *    agent (or queues behind a busy run — never interrupts) with the
 *    stalled facts + remediation hints. Progress on the task re-arms
 *    the nudge. This turns "check on stuck jobs" from model habit
 *    into extension behavior.
 *
 *    PI_TASK_WAKE          "0" disables the watchdog (default on)
 *    PI_TASK_WAKE_MIN      nudge threshold minutes (default 5)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_DIR = process.env.PI_TASK_STATUS_DIR
	? process.env.PI_TASK_STATUS_DIR.replace(/^~/, os.homedir())
	: path.join(os.homedir(), ".pi", "agent", "status");

const STATUS_KEY = "task-progress";
const MAX_TASKS = Number(process.env.PI_TASK_MAX ?? 3);
const REFRESH_MS = Number(process.env.PI_TASK_REFRESH_MS ?? 5000);
const HIDE_AFTER_S = Number(process.env.PI_TASK_HIDE_MIN ?? 30) * 60;
const STALE_AFTER_S = Number(process.env.PI_TASK_STALE_SEC ?? 180);
const WAKE_ENABLED = (process.env.PI_TASK_WAKE ?? "1") !== "0";
const WAKE_AFTER_S = Number(process.env.PI_TASK_WAKE_MIN ?? 5) * 60;

type Task = {
	id?: string;
	label?: string;
	done?: number;
	total?: number;
	note?: string;
	updated?: number;
	/** Optional unit ("lec", "posts", "MB"); only shown by /task-status listing */
	unit?: string;
};

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

function statusFiles(): string[] {
	try {
		return fs
			.readdirSync(STATUS_DIR)
			.filter((n) => n.endsWith(".json"))
			.map((n) => path.join(STATUS_DIR, n));
	} catch {
		return [];
	}
}

function readTasks(includeHidden = false): Task[] {
	const tasks: Task[] = [];
	for (const fp of statusFiles()) {
		try {
			const t = JSON.parse(fs.readFileSync(fp, "utf-8")) as Task;
			if (typeof t.done === "number" && typeof t.total === "number") {
				if (!t.id) t.id = path.basename(fp, ".json");
				tasks.push(t);
			}
		} catch {
			// half-written JSON: skip, retry next poll
		}
	}
	const now = nowSec();
	const visible = includeHidden
		? tasks
		: tasks.filter((t) => !t.updated || now - t.updated <= HIDE_AFTER_S);
	return visible.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
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

/** Read one task by id (undefined when missing/unreadable). */
function readTask(id: string): Task | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(STATUS_DIR, `${id}.json`), "utf-8")) as Task;
	} catch {
		return undefined;
	}
}

/** Atomic status write (tmp + rename), per the documented convention. */
function writeStatus(t: Task): void {
	fs.mkdirSync(STATUS_DIR, { recursive: true });
	const fp = path.join(STATUS_DIR, `${t.id}.json`);
	const tmp = `${fp}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(t));
	fs.renameSync(tmp, fp);
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function toolError(msg: string) {
	return { content: [{ type: "text" as const, text: `ERROR: ${msg}` }], details: {}, isError: true };
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastLine = "";
	// UI context for immediate re-render from the agent tool (poll covers it within REFRESH_MS anyway)
	let uiCtx: any;

	const renderNow = () => {
		if (!uiCtx) return;
		try {
			render(uiCtx);
		} catch {
			/* ctx invalidated: poll will retry */
		}
	};

	const render = (ctx: any) => {
		const tasks = readTasks().slice(0, MAX_TASKS);
		if (tasks.length === 0) {
			if (lastLine !== "") {
				ctx.ui.setStatus(STATUS_KEY, undefined);
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
		// Skip identical updates to avoid needless TUI redraws
		if (line !== lastLine) {
			ctx.ui.setStatus(STATUS_KEY, line);
			lastLine = line;
		}
	};

	// ── 6. Stale wakeup: one nudge per update-level, re-armed by progress ──
	// Keyed by task id → the task.updated value at nudge time; a new update
	// (bump/done/set) changes `updated` and re-arms. Pruned when tasks vanish.
	const nudgedFor = new Map<string, number>();

	const wakeStaleTasks = () => {
		if (!WAKE_ENABLED || typeof pi.sendUserMessage !== "function") return;
		const tasks = readTasks(); // visible only: nudge what the user can still see stalling
		const alive = new Set<string>();
		for (const t of tasks) {
			const id = t.id ?? "";
			alive.add(id);
			if (!id || isDone(t) || !t.updated) continue;
			const idleS = nowSec() - t.updated;
			if (idleS < WAKE_AFTER_S) continue;
			if (nudgedFor.get(id) === t.updated) continue; // already nudged at this level
			nudgedFor.set(id, t.updated);
			const label = t.label ?? id;
			const counts = (t.total ?? 0) > 0 ? ` ${t.done ?? 0}/${t.total}` : "";
			const note = t.note ? ` · ${t.note}` : "";
			const min = Math.max(1, Math.round(idleS / 60));
			pi.sendUserMessage(
				`⚠️ [task-status] "${label}"${counts}${note} has shown no progress for ${min} min. ` +
					`If it should still be running: check the process (ps aux | grep …) and its logs for the stall cause, then resume reporting with task_progress. ` +
					`If it finished silently or was abandoned: close it out with task_progress {"action":"done"|"remove","id":"${id}"}.`,
				{ deliverAs: "followUp" },
			);
		}
		for (const id of [...nudgedFor.keys()]) {
			if (!alive.has(id)) nudgedFor.delete(id);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		render(ctx);
		timer = setInterval(() => {
			try {
				render(ctx);
				wakeStaleTasks();
			} catch {
				/* ctx invalidated: stay silent */
			}
		}, REFRESH_MS);
	});

	pi.on("session_shutdown", async () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});

	pi.registerCommand("task-status", {
		description: "Show background task progress; 'clear' removes all status files",
		handler: async (args: string, ctx: any) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "clear") {
				let n = 0;
				for (const fp of statusFiles()) {
					try {
						fs.unlinkSync(fp);
						n++;
					} catch {
						/* ignore */
					}
				}
				lastLine = "";
				render(ctx);
				ctx.ui.notify(`Removed ${n} task status file(s)`, "info");
				return;
			}

			const all = readTasks(true);
			if (all.length === 0) {
				ctx.ui.notify(`No task statuses (dir: ${STATUS_DIR})`, "info");
				return;
			}
			const rows = all.map((t) => {
				const stale = isStale(t) ? " [stale]" : "";
				const hid = t.updated && nowSec() - t.updated > HIDE_AFTER_S ? " [hidden]" : "";
				const unit = t.unit ? t.unit : "";
				const note = t.note ? `  ${t.note}` : "";
				return `${isDone(t) ? "✓" : "◆"} ${t.label ?? t.id}  ${t.done}/${t.total}${unit} ${pctOf(t)}%${stale}${hid}${note}`;
			});
			ctx.ui.notify(rows.join("\n"), "info");
			render(ctx);
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
			const prev = readTask(id);
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
					writeStatus(t);
					renderNow();
					text = [
						`✓ Progress chip live in footer: ◆ ${label} ${done}/${total} ${Math.round((done / total) * 100)}%`,
						``,
						`A tool call cannot fire mid-script — wire live updates into the job itself:`,
						`  per completed unit, inside the script, run ONE of:`,
						`    python3 ~/.pi/agent/scripts/task_status.py bump ${id}`,
						`    or write JSON directly (atomic tmp+rename; unix-seconds timestamp):`,
						`      {"id":"${id}","label":"${label}","done":N,"total":${total},"note":"...","updated":$(date +%s)} → ${fp}`,
						`When finished: task_progress {"action":"done","id":"${id}"} (✓ green; auto-hides 30 min after last update; >${STALE_AFTER_S}s idle shows "· stale").`,
						`Watchdog: if this task shows no update for ${Math.round(WAKE_AFTER_S / 60)} min, the extension wakes the agent (queued, never interrupts) to investigate — script-side bumps keep it quiet.`,
					].join("\n");
					break;
				}
				case "bump": {
					let t = prev;
					if (!t) {
						if (params.total && params.total >= 1) t = { id, label: params.label ?? id, done: 0, total: params.total };
						else return toolError(`unknown task "${id}" — call action "set" first (or pass total to create it here)`);
					}
					if (params.total && params.total >= 1) t.total = params.total;
					if (params.label) t.label = params.label;
					if (params.note) t.note = params.note;
					const step = params.n && params.n >= 1 ? params.n : 1;
					t.done = Math.min((t.done ?? 0) + step, t.total ?? (t.done ?? 0) + step);
					t.updated = nowSec();
					writeStatus(t);
					renderNow();
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
					writeStatus(t);
					renderNow();
					text = `✓ ${t.label}: ${t.done}/${t.total} — complete (chip auto-hides after ${Math.round(HIDE_AFTER_S / 60)} min)`;
					break;
				}
				case "remove": {
					try {
						fs.unlinkSync(fp);
					} catch {
						/* already gone: fine */
					}
					renderNow();
					text = `removed status for "${id}"`;
					break;
				}
			}
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});
}
