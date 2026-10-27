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
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_DIR = process.env.PI_TASK_STATUS_DIR
	? process.env.PI_TASK_STATUS_DIR.replace(/^~/, os.homedir())
	: path.join(os.homedir(), ".pi", "agent", "status");

const STATUS_KEY = "task-progress";
const MAX_TASKS = Number(process.env.PI_TASK_MAX ?? 3);
const REFRESH_MS = Number(process.env.PI_TASK_REFRESH_MS ?? 5000);
const HIDE_AFTER_S = Number(process.env.PI_TASK_HIDE_MIN ?? 30) * 60;
const STALE_AFTER_S = Number(process.env.PI_TASK_STALE_SEC ?? 180);

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

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastLine = "";

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

	pi.on("session_start", async (_event, ctx) => {
		render(ctx);
		timer = setInterval(() => {
			try {
				render(ctx);
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
}
