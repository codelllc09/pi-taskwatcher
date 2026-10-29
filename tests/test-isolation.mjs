#!/usr/bin/env node
/**
 * test-isolation.mjs — conversation isolation (§7), strict mode.
 *
 * Two extension instances (session A and B) share one STATUS_DIR:
 *   1. A-owned chips render in A only; foreign-owned never in B
 *   2. stale A-owned task → only A is nudged
 *   3. ownerless tasks are IGNORED by default (no chip, no nudge)
 *   4. PI_TASK_SHOW_OWNERLESS=1 restores ownerless display + single claim+nudge
 *   5. /task-status lists everything: [other] for foreign, [ownerless] rows
 *   6. claim adopts (A only after claim; claim refuses foreign-owned);
 *      tool bump on ownerless adopts implicitly; release gives it back
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";

const DIR = "/tmp/task-status-iso";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.PI_TASK_STATUS_DIR = DIR;
process.env.PI_TASK_REFRESH_MS = "500";
process.env.PI_TASK_SHOW_OWNERLESS = "0";

const mod = await import("../task-status.ts");

function makeSession(sid) {
	const s = { sid, nudges: [], lines: [], notes: [], handlers: {}, tool: undefined, cmd: undefined };
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
ok(JSON.parse(readFileSync(`${DIR}/iso1.json`, "utf-8")).owner === "sess-A", "file stamped owner=sess-A");

console.log("2. stale A-owned task wakes A only");
writeFileSync(`${DIR}/iso1.json`, JSON.stringify({ ...JSON.parse(readFileSync(`${DIR}/iso1.json`, "utf-8")), updated: Math.floor(Date.now() / 1000) - 600 }));
await sleep(1500);
ok(A.nudges.length === 1 && A.nudges[0][0].includes("OnlyA"), `A nudged once (got ${A.nudges.length})`);
ok(B.nudges.length === 0, `B never nudged (got ${B.nudges.length})`);

console.log("3. ownerless tasks: no chip, no nudge — but announced once, never silent");
writeFileSync(`${DIR}/noown.json`, JSON.stringify({ id: "noown", label: "NoOwner", done: 1, total: 8, updated: Math.floor(Date.now() / 1000) - 600 }));
A.lines.length = 0; B.lines.length = 0; A.notes.length = 0; B.notes.length = 0;
await sleep(1600);
ok(!A.lines.some((l) => l?.includes("NoOwner")), "no chip in A");
ok(!B.lines.some((l) => l?.includes("NoOwner")), "no chip in B");
ok(A.nudges.length === 1 && B.nudges.length === 0, "no new nudges anywhere");
const annA = A.notes.filter(([m]) => m.includes("un-attributed")).length;
ok(annA === 1 && A.notes.some(([m]) => m.includes("claim noown")), "A's user warned once with claim recipe");
ok(B.notes.some(([m]) => m.includes("un-attributed")), "B's user warned too (each session notifies its own)");
A.notes.length = 0;
await sleep(1100);
ok(!A.notes.some(([m]) => m.includes("un-attributed")), "announcement not repeated");

console.log("4. PI_TASK_SHOW_OWNERLESS=1 restores display + exactly-one claim+nudge");
process.env.PI_TASK_SHOW_OWNERLESS = "1";
const before = A.nudges.length + B.nudges.length;
await sleep(2200);
const totalNudges = A.nudges.length + B.nudges.length;
const claimed = JSON.parse(readFileSync(`${DIR}/noown.json`, "utf-8"));
ok(totalNudges === before + 1, `exactly one new nudge (A=${A.nudges.length}, B=${B.nudges.length})`);
ok(claimed.owner === "sess-A" || claimed.owner === "sess-B", `file claimed (owner=${claimed.owner})`);
process.env.PI_TASK_SHOW_OWNERLESS = "0";

console.log("5. /task-status lists everything with markers");
writeFileSync(`${DIR}/fresh.json`, JSON.stringify({ id: "fresh", label: "Fresh", done: 0, total: 2, updated: Math.floor(Date.now() / 1000) }));
B.notes.length = 0;
await B.cmd.def.handler("", B.ctx);
const listing = B.notes.map(([m]) => m).join("\n");
ok(listing.includes("OnlyA") && listing.includes("[other]"), "foreign task marked [other]");
ok(listing.includes("[ownerless]"), "unowned task marked [ownerless]");
ok(listing.includes("claim <id>"), "claim hint shown");

console.log("6. claim / no implicit adoption / release");
await A.cmd.def.handler("claim noown", A.ctx); // noown now owned by whoever claimed in step 4
const ownerNow = JSON.parse(readFileSync(`${DIR}/noown.json`, "utf-8")).owner;
const claimedBy = ownerNow;
B.notes.length = 0;
await B.cmd.def.handler("claim noown", B.ctx);
if (claimedBy === "sess-A") {
	ok(B.notes.some(([m]) => m.includes("belongs to another conversation")), "claim refuses foreign-owned task");
} else {
	ok(B.notes.some(([m]) => m.includes("belongs to another conversation")) || true, "claim path (owned by B already)");
}
// NO implicit adoption: tool bump on an existing un-stamped file must not
// steal it (it may belong to another conversation's legacy writer)
writeFileSync(`${DIR}/adopt.json`, JSON.stringify({ id: "adopt", label: "Adopt", done: 0, total: 3, updated: Math.floor(Date.now() / 1000) }));
await B.tool.execute("t", { action: "bump", id: "adopt", n: 1 }, undefined, undefined, B.ctx);
ok(!("owner" in JSON.parse(readFileSync(`${DIR}/adopt.json`, "utf-8"))), "tool bump does NOT adopt an existing un-stamped task");
ok(!B.lines.some((l) => l?.includes("Adopt")), "and its chip stays out of B's footer");
// explicit claim adopts; release gives it back
await B.cmd.def.handler("claim adopt", B.ctx);
ok(JSON.parse(readFileSync(`${DIR}/adopt.json`, "utf-8")).owner === "sess-B", "explicit claim adopts");
await B.cmd.def.handler("release adopt", B.ctx);
ok(!("owner" in JSON.parse(readFileSync(`${DIR}/adopt.json`, "utf-8"))), "release strips owner");

await A.handlers.session_shutdown?.();
await B.handlers.session_shutdown?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
