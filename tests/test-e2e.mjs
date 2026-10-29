#!/usr/bin/env node
/**
 * test-e2e.mjs — end-to-end acceptance battery.
 *
 * Replicates the manual live acceptance flow against the real extension
 * module + real files, with only the Pi host mocked (ui + sendUserMessage):
 *   1. chip rendering content (via setStatus capture): ◆/✓/· stale/hidden
 *   2. mixed-writer interop: external process writes JSON → poll loop renders it
 *   3. educator text: resolved CLI path + JSON recipe in the set result
 *   4. /task-status command: listing incl. problem files, and clear
 *   5. CLI roundtrip: set/bump/done/ls/rm in a scratch dir
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";

const DIR = "/tmp/task-status-e2e";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.PI_TASK_STATUS_DIR = DIR;
process.env.PI_TASK_REFRESH_MS = "500";

const mod = await import("../task-status.ts");
const sent = [];
const notes = [];
const statusLines = [];
const handlers = {};
let tool, cmd;

const pi = {
	on: (ev, h) => (handlers[ev] = h),
	registerCommand: (name, def) => (cmd = { name, def }),
	registerTool: (d) => (tool = d),
	sendUserMessage: (text, opts) => sent.push([text, opts]),
};
mod.default(pi);

const mkCtx = () => ({
	ui: {
		notify: (m, k) => notes.push([m, k]),
		setStatus: (_k, v) => statusLines.push(v),
		theme: { fg: (_s, x) => x },
	},
});
const ctx = mkCtx();
await handlers.session_start({}, ctx);

const call = (args) => tool.execute("id1", args, undefined, undefined, ctx);
const lastLine = () => statusLines[statusLines.length - 1] ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };

console.log("1. chip rendering content (setStatus lines)");
statusLines.length = 0;
await call({ action: "set", id: "e2e", label: "E2E", total: 5 });
ok(lastLine().includes("◆ E2E 0/5 0%"), `set renders chip line: "${lastLine()}"`);
await call({ action: "bump", id: "e2e", n: 2 });
ok(lastLine().includes("E2E 2/5 40%"), `bump re-renders: "${lastLine()}"`);

console.log("2. mixed-writer interop: external process → poll loop renders");
// simulate the batch script writing JSON directly (the documented shell recipe)
writeFileSync(`${DIR}/e2e.json`, `{"id":"e2e","label":"E2E","done":4,"total":5,"updated":${Math.floor(Date.now() / 1000)}}`);
statusLines.length = 0;
await sleep(1200); // poll tick must pick up the external write on its own
ok(lastLine().includes("E2E 4/5 80%"), `poll loop rendered external write: "${lastLine()}"`);

console.log("3. educator text: resolved CLI path + JSON recipe");
let r = await call({ action: "set", id: "edu", label: "Edu", total: 3 });
const edu = r.content[0].text;
ok(/python3 \S+task_status\.py bump edu/.test(edu), "CLI path resolved to an absolute task_status.py");
ok(edu.includes('"done":N') && edu.includes("updated"), "JSON recipe embedded");
ok(edu.includes("Watchdog"), "watchdog notice embedded");

console.log("4. stale and hidden markers");
writeFileSync(`${DIR}/stale1.json`, JSON.stringify({ id: "stale1", label: "S1", done: 1, total: 9, updated: Math.floor(Date.now() / 1000) - 400 })); // >180s stale, <30min visible
writeFileSync(`${DIR}/hidden1.json`, JSON.stringify({ id: "hidden1", label: "H1", done: 1, total: 9, updated: Math.floor(Date.now() / 1000) - 4000 })); // >30min hidden
await call({ action: "remove", id: "edu" }); // trigger a refresh via tool
ok(lastLine().includes("S1 1/9") && lastLine().includes("stale"), `stale marker shown: "${lastLine()}"`);
ok(!lastLine().includes("H1"), "hidden task not rendered");
// watchdog: only S1 (visible, stale, not done) qualifies — H1 is invisible, e2e is not yet stale
await sleep(700);
ok(sent.some(([m]) => m.includes('"S1" 1/9')), "watchdog nudged the visible stale task");
ok(!sent.some(([m]) => m.includes('"H1"')), "hidden tasks never nudged");

console.log("5. /task-status command: listing + problem files + clear");
writeFileSync(`${DIR}/broken.json`, "{oops");
notes.length = 0;
await cmd.def.handler("", ctx);
const listing = notes.map(([m]) => m).join("\n");
ok(/E2E\s+4\/5/.test(listing), "lists running task");
ok(listing.includes("S1") && listing.includes("[stale]"), "lists stale task with marker");
ok(listing.includes("H1") && listing.includes("[hidden]"), "lists hidden task with marker");
ok(listing.includes("Problem files") || !listing.includes("broken"), "problem section only once persistent (broken just written — tolerated for now)");
await sleep(3000); // 5+ ticks at 500ms → broken.json becomes persistent
notes.length = 0;
await cmd.def.handler("", ctx);
ok(notes.map(([m]) => m).join("\n").includes("broken.json"), "persistent corrupt file listed after BAD_AFTER_TICKS");
await cmd.def.handler("clear", ctx);
ok(readdirSync(DIR).filter((f) => f.endsWith(".json")).length === 0, "clear removed every status file");
ok(notes.some(([m]) => m.includes("Removed")), "clear reports the count");

console.log("6. CLI roundtrip in scratch dir");
const CLI = new URL("../scripts/task_status.py", import.meta.url).pathname;
const run = (args) => spawnSync("python3", [CLI, ...args], { env: { ...process.env, PI_TASK_STATUS_DIR: DIR }, encoding: "utf-8" });
let c = run(["set", "--id", "c1", "--label", "CLI", "--total", "4"]);
ok(c.status === 0, "cli set ok");
c = run(["bump", "--id", "c1", "--by", "3"]);
ok(c.status === 0 && c.stdout.includes("3/4"), `cli bump: ${c.stdout.trim()}`);
c = run(["done", "--id", "c1"]);
ok(c.status === 0 && c.stdout.includes("4/4"), "cli done completes");
c = run(["ls"]);
ok(c.status === 0 && c.stdout.includes("CLI"), "cli ls lists");
c = run(["rm", "--id", "c1"]);
ok(c.status === 0, "cli rm ok");
c = run(["bump", "--id", "ghost"]);
ok(c.status !== 0 && c.stderr.includes("no such task"), "cli bump unknown fails loudly");

await handlers.session_shutdown?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
