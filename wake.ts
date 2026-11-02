/**
 * wake.ts — user-scheduled one-shot wake-ups (/wake-at)
 *
 * ─────────────────────────────────────────────────────────────
 * §1 what it is
 *
 *    The taskwatcher family wakes the agent on *conditions* (task
 *    stalled, tool hung, bg command exited). /wake-at adds the one
 *    missing axis: *time*, chosen by the user. One-shot by design —
 *    there is no loop tax, no recurring token cost; a wake fires once
 *    and is gone. The "is this wake worth the tokens?" decision stays
 *    with the person who set it.
 *
 *      /wake-at 30m check the build result
 *      /wake-at 14:00 review the test run        (today, or tomorrow
 *                                                  if already past)
 *      /wake-at            — or — /wake-at list   — pending wakes
 *      /wake-at cancel w1                          — cancel
 *
 *    Delivery is sendUserMessage({deliverAs:"followUp"}): wakes an
 *    idle agent immediately, queues behind a busy run — never
 *    interrupts (same channel as the stale nudge).
 *
 * ─────────────────────────────────────────────────────────────
 * §2 session-scoped, in-memory, deliberately
 *
 *    Timers live in the extension process and die with the session
 *    (session_shutdown clears them and says how many were dropped —
 *    never silently). Nothing is written to disk: a persisted wake
 *    would need to survive restarts and answer "deliver into which
 *    conversation?" — that is cron + a status file's job, not an
 *    in-session alarm clock's.
 *
 * ─────────────────────────────────────────────────────────────
 * §3 hardening (repo invariants)
 *
 *    - env numbers sanitized via envNum(); bad values reported once
 *    - malformed time specs are rejected with usage text — nothing
 *      is guessed ("30" without a unit is an error, not 30 minutes)
 *    - delay floor PI_WAKE_MIN_S (default 60 s) caps accidental spam;
 *      ceiling 24 h matches the session-scoped semantics
 *    - at most PI_WAKE_MAX (default 5) pending wakes per session
 *    - every timer unref()'d — a pending wake can never keep the
 *      process alive (zombie guard)
 *    - delivery failure is announced via ctx.ui.notify, once per wake
 *    - test observation via globalThis.__wakeTestHook / __wakeTestHookParse;
 *      no prod branches for tests
 */

const envIssues: string[] = [];

/** Sanitize a numeric env: non-number / out-of-range → default (issue logged). */
function envNum(name: string, def: number, min: number, max: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return def;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < min || n > max) {
		envIssues.push(`${name}=${raw} (want ${min}..${max}, default ${def})`);
		return def;
	}
	return n;
}

const MAX_WAKES = envNum("PI_WAKE_MAX", 5, 1, 50);
const MIN_DELAY_S = envNum("PI_WAKE_MIN_S", 60, 1, 86_400);
const MAX_DELAY_S = 86_400; // 24 h — session-scoped alarms, not a calendar

interface Wake {
	id: string;
	timer: ReturnType<typeof setTimeout>;
	atMs: number;
	setAtMs: number;
	msg: string;
	failedNotified: boolean;
}

const wakes = new Map<string, Wake>();
let nextSeq = 1;

/**
 * Pure time-spec parser (exported to tests via __wakeTestHookParse).
 * Returns the absolute fire time, or an error string with usage.
 */
function parseWhen(
	spec: string,
	nowMs: number,
	minS: number,
): { atMs: number } | { error: string } {
	const rel = /^(\d+)([smh])$/.exec(spec);
	if (rel) {
		const n = Number(rel[1]);
		const unitS = rel[2] === "s" ? 1 : rel[2] === "m" ? 60 : 3600;
		const delayS = n * unitS;
		if (delayS < minS) return { error: `delay ${spec} is below the ${minS}s floor` };
		if (delayS > MAX_DELAY_S) return { error: `delay ${spec} exceeds the 24h ceiling` };
		return { atMs: nowMs + delayS * 1000 };
	}
	const abs = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(spec);
	if (abs) {
		const d = new Date(nowMs);
		const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(abs[1]), Number(abs[2]));
		// inside the min-delay window ("now" or barely ahead) → tomorrow, so an
		// absolute spec can never sneak past the floor that relative specs obey
		if (at.getTime() <= nowMs + minS * 1000) at.setDate(at.getDate() + 1);
		return { atMs: at.getTime() };
	}
	return {
		error: `cannot parse time "${spec}" — use <n>s|m|h (e.g. 30m) or HH:MM (e.g. 14:00)`,
	};
}

const fmtClock = (ms: number): string => {
	const d = new Date(ms);
	const p = (x: number) => String(x).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fmtIn = (atMs: number): string => {
	const s = Math.max(0, Math.round((atMs - Date.now()) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	return `${(s / 3600).toFixed(1)}h`;
};

export default function (pi: any) {
	let uiCtx: any;

	const notify = (ctx: any, msg: string, kind: "info" | "warning" | "error" = "info") => {
		try {
			ctx?.ui?.notify?.(msg, kind);
		} catch {
			/* notify itself must never throw into the caller */
		}
	};

	const hook = (event: string, detail?: unknown) => {
		const h = (globalThis as any).__wakeTestHook;
		if (typeof h === "function") {
			try {
				h(event, detail);
			} catch {
				/* test hook failures are not prod failures */
			}
		}
	};

	const fire = (w: Wake) => {
		wakes.delete(w.id); // one-shot: fires once, gone — loops must be re-armed by the user
		const elapsedS = Math.max(1, Math.round((Date.now() - w.setAtMs) / 1000));
		const elapsed = elapsedS < 60 ? `${elapsedS}s` : `${Math.round(elapsedS / 60)}m`;
		try {
			pi.sendUserMessage(
				`⏰ [wake-at] ${w.msg} — scheduled ${fmtClock(w.atMs)}, fired after ${elapsed}. ` +
					`If the agent was busy this was queued and may be stale — re-check the current state before acting.`,
				{ deliverAs: "followUp" },
			);
			hook("fire", { id: w.id, msg: w.msg });
		} catch (e) {
			// no silent catch: announce once per wake
			if (!w.failedNotified) {
				w.failedNotified = true;
				notify(uiCtx, `[wake-at] delivering "${w.id}" failed: ${String(e).slice(0, 120)}`, "error");
				hook("fire-failed", { id: w.id });
			}
		}
	};

	const listText = (): string => {
		if (wakes.size === 0) return "no pending wake-ups";
		return [...wakes.values()]
			.sort((a, b) => a.atMs - b.atMs)
			.map((w) => `${w.id}  at ${fmtClock(w.atMs)} (in ${fmtIn(w.atMs)})  ${w.msg}`)
			.join("\n");
	};

	pi.on("session_start", async (_event: any, ctx: any) => {
		uiCtx = ctx;
		// pre-flight: a wake that cannot be delivered is useless — say so up front,
		// not when the first one fires (fire()'s catch remains the last resort)
		if (typeof pi.sendUserMessage !== "function") {
			notify(ctx, "[wake-at] sendUserMessage unavailable in this harness — wake-ups cannot be delivered", "warning");
		}
		if (envIssues.length > 0) {
			notify(ctx, `[wake-at] ignored invalid env: ${envIssues.join("; ")}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		const n = wakes.size;
		for (const w of wakes.values()) clearTimeout(w.timer);
		wakes.clear();
		if (n > 0) {
			notify(uiCtx, `[wake-at] session ended — discarded ${n} pending wake-up(s); /wake-at is session-scoped`, "warning");
			hook("discard", n);
		}
	});

	pi.registerCommand("wake-at", {
		description: "Schedule a one-shot wake-up: /wake-at 30m <note> | HH:MM <note> | list | cancel <id>",
		handler: async (args: string, ctx: any) => {
			if (!uiCtx) uiCtx = ctx; // command may run before session_start in harnesses
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);

			if (parts.length === 0 || parts[0] === "list") {
				notify(ctx, listText(), "info");
				return;
			}
			if (parts[0] === "cancel") {
				const id = parts[1] ?? "";
				const w = wakes.get(id);
				if (!w) {
					notify(ctx, `[wake-at] no such wake "${id || "?"}" — try /wake-at list`, "error");
					hook("reject", `cancel:${id || "?"}`);
					return;
				}
				clearTimeout(w.timer);
				wakes.delete(id);
				hook("cancel", id);
				notify(ctx, `[wake-at] cancelled "${id}" (${w.msg})`, "info");
				return;
			}

			const spec = parts[0];
			const msg = parts.slice(1).join(" ") || "scheduled wake-up";
			const parsed = parseWhen(spec, Date.now(), MIN_DELAY_S);
			if ("error" in parsed) {
				notify(ctx, `[wake-at] ${parsed.error}\nusage: /wake-at <n>s|m|h <note> · /wake-at HH:MM <note> · /wake-at list · /wake-at cancel <id>`, "error");
				hook("reject", spec);
				return;
			}
			if (wakes.size >= MAX_WAKES) {
				notify(ctx, `[wake-at] ${wakes.size} pending wake-up(s) already at the PI_WAKE_MAX=${MAX_WAKES} cap — cancel one first (/wake-at list)`, "error");
				hook("reject", "cap");
				return;
			}
			const id = `w${nextSeq++}`;
			const atMs = parsed.atMs;
			const w: Wake = {
				id,
				timer: setTimeout(() => fire(w), Math.max(0, atMs - Date.now())),
				atMs,
				setAtMs: Date.now(),
				msg,
				failedNotified: false,
			};
			w.timer.unref?.(); // a pending wake must never keep the process alive
			wakes.set(id, w);
			hook("set", { id, atMs });
			notify(ctx, `[wake-at] ${id} will fire at ${fmtClock(atMs)} (in ${fmtIn(atMs)}): ${msg}`, "info");
		},
	});

	// §3: test observation only — pure functions / events, no prod branches
	const g = globalThis as any;
	if (!g.__wakeTestHookParse) g.__wakeTestHookParse = parseWhen;
}
