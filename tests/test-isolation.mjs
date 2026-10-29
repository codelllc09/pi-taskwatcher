#!/usr/bin/env node
/**
 * test-isolation.mjs — conversation isolation (§7).
 *
 * Two extension instances (session A and B) share one STATUS_DIR, mimicking
 * two concurrent Pi conversations on one machine:
 *   1. A-owned chips render in A only
 *   2. stale A-owned task → only A is nudged
 *   3. ownerless stale task → exactly ONE nudge across both sessions (claim)
 *   4. /task-status in B lists A's task marked [other] (transparency)
 *   5. ownerless tasks stay visible to everyone (backward compat)
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";

const DIR = "/tmp/task-status-iso";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.PI_TASK_STATUS_DIR = DIR;
process.env.PI_TASK_REFRESH_MS = "500";

const mod = await import("../task-status.ts");

function makeSession(sid) {
	const s = {
		sid,
		nudges: [],
		lines: [],
		notes: [],
		handlers: {},
		tool: undefined,
		cmd: undefined,
	};
	const pi = {
		on: (ev, h) => (s.handlers[ev] = h),
		registerCommand: (name, def) => (s.cmd = { name, def }),
		registerTool: (d) => (s.tool = d),
		sendUserMessage: (text, opts) => s.nudges.push([text, opts]),
	};
	mod.default(pi);
	s.ctx = {
		ui: {
			notify: (m, k) => s.notes.push([m, k]),
			setStatus: (_k, v) => s.lines.push(v),
			theme: { fg: (_s, x) => x },
		},
		sessionManager: { getSessionId: () => sid },
	};
	return s;
}

const A = makeSession("sess-A");
const B = makeSession("sess-B");
await A.handlers.session_start({}, A.ctx);
await B.handlers.session_start({}, B.ctx);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };

console.log("1. A-owned chips render in A only");
await A.tool.execute("t", { action: "set", id: "iso1", label: "OnlyA", total: 4 }, undefined, undefined, A.ctx);
ok(A.lines.some((l) => l?.includes("OnlyA")), "A's footer shows it");
await sleep(1300);
ok(!B.lines.some((l) => l?.includes("OnlyA")), "B's footer does not");
const stored = JSON.parse(readFileSync(`${DIR}/iso1.json`, "utf-8"));
ok(stored.owner === "sess-A", `file stamped owner=sess-A (got ${stored.owner})`);

console.log("2. stale A-owned task wakes A only");
writeFileSync(`${DIR}/iso1.json`, JSON.stringify({ ...stored, updated: Math.floor(Date.now() / 1000) - 600 }));
await sleep(1500);
ok(A.nudges.length === 1 && A.nudges[0][0].includes("OnlyA"), `A nudged once (got ${A.nudges.length})`);
ok(B.nudges.length === 0, `B never nudged (got ${B.nudges.length})`);

console.log("3. ownerless stale task: exactly one session claims + nudges");
writeFileSync(`${DIR}/noown.json`, JSON.stringify({ id: "noown", label: "NoOwner", done: 1, total: 8, updated: Math.floor(Date.now() / 1000) - 600 }));
const before = A.nudges.length + B.nudges.length;
await sleep(2500);
const totalNudges = A.nudges.length + B.nudges.length;
const claimed = JSON.parse(readFileSync(`${DIR}/noown.json`, "utf-8"));
ok(totalNudges === before + 1, `exactly one new nudge across sessions (A=${A.nudges.length}, B=${B.nudges.length})`);
ok(claimed.owner === "sess-A" || claimed.owner === "sess-B", `file claimed (owner=${claimed.owner})`);

console.log("4. /task-status in B lists A's task as [other]");
B.notes.length = 0;
await B.cmd.def.handler("", B.ctx);
const listing = B.notes.map(([m]) => m).join("\n");
ok(listing.includes("OnlyA") && listing.includes("[other]"), "foreign task listed with [other] marker");

console.log("5. ownerless tasks stay visible to everyone (backward compat)");
writeFileSync(`${DIR}/legacy.json`, JSON.stringify({ id: "legacy", label: "Legacy", done: 1, total: 2, updated: Math.floor(Date.now() / 1000) }));
await sleep(1300);
ok(A.lines.some((l) => l?.includes("Legacy")), "A sees ownerless task");
ok(B.lines.some((l) => l?.includes("Legacy")), "B sees ownerless task");

await A.handlers.session_shutdown?.();
await B.handlers.session_shutdown?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
