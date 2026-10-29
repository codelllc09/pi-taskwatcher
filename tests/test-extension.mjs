#!/usr/bin/env node
/**
 * test-extension.cjs — functional tests for task-status.ts
 * Tool roundtrip, error paths, watchdog lifecycle.
 * Run: node tests/test-extension.cjs   (expects PI_TASK_STATUS_DIR to a scratch dir)
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";

const DIR = process.env.PI_TASK_STATUS_DIR ?? "/tmp/task-status-func";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.PI_TASK_STATUS_DIR = DIR;
process.env.PI_TASK_REFRESH_MS = "500";

const mod = await import("../task-status.ts");
const toolCalls = { sendUserMessage: [] };
let registeredTool;
const handlers = {};
const notes = [];
const statusSets = [];

const pi = {
	on: (ev, h) => (handlers[ev] = h),
	registerCommand: () => {},
	registerTool: (d) => (registeredTool = d),
	sendUserMessage: (text, opts) => toolCalls.sendUserMessage.push([text, opts]),
};
mod.default(pi);

const uiCtx = {
	ui: {
		notify: (m, k) => notes.push([m, k]),
		setStatus: (_k, v) => statusSets.push(v),
		theme: { fg: (_s, x) => x },
	},
};
await handlers.session_start({}, uiCtx);

const t = registeredTool;
const call = (args) => t.execute("id1", args, undefined, undefined, uiCtx);
const readJson = (id) => JSON.parse(readFileSync(`${DIR}/${id}.json`, "utf-8"));
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };

console.log("tool registration");
ok(t && t.name === "task_progress", "registers as task_progress");
ok(t.promptGuidelines?.length > 0, "has promptGuidelines");
ok(t.promptSnippet?.includes("footer"), "has promptSnippet");

console.log("set / bump / done / remove roundtrip");
let r = await call({ action: "set", id: "a1", label: "Alpha", total: 8, note: "rt 0.5" });
ok(r.content[0].text.includes("◆ Alpha 0/8"), "set confirms chip");
ok(r.content[0].text.includes("bump a1"), "set embeds wiring recipe");
ok(readJson("a1").total === 8 && readJson("a1").done === 0, "set writes file");
r = await call({ action: "bump", id: "a1", n: 3 });
ok(r.content[0].text.includes("3/8"), "bump 3 → 3/8");
r = await call({ action: "bump", id: "a1" });
ok(r.content[0].text.includes("4/8"), "bump default n=1 → 4/8");
ok(readJson("a1").updated <= Math.floor(Date.now() / 1000), "bump stamps updated");
r = await call({ action: "done", id: "a1" });
ok(r.content[0].text.includes("8/8"), "done completes");
ok(readJson("a1").done === 8, "done written");
r = await call({ action: "remove", id: "a1" });
ok(r.content[0].text.includes("removed"), "remove works");
let gone = false;
try { readFileSync(`${DIR}/a1.json`); } catch { gone = true; }
ok(gone, "remove deleted file");

console.log("error paths are loud (isError)");
r = await call({ action: "set", id: "../evil" });
ok(r.isError && r.content[0].text.includes("invalid id"), "path traversal rejected");
r = await call({ action: "set", id: "x" });
ok(r.isError && r.content[0].text.includes("total"), "set without total rejected");
r = await call({ action: "bump", id: "ghost" });
ok(r.isError && r.content[0].text.includes('"set" first'), "bump unknown rejected with hint");

console.log("schema-invalid existing file is not rewritten as garbage");
writeFileSync(`${DIR}/junk.json`, JSON.stringify({ id: "junk", label: "Junk", foo: 1 })); // lacks done/total
r = await call({ action: "bump", id: "junk" });
ok(r.isError, "bump on schema-invalid file errors instead of fabricating");
const junkAfter = JSON.parse(readFileSync(`${DIR}/junk.json`, "utf-8"));
ok(junkAfter.foo === 1 && junkAfter.done === undefined, "junk file left untouched");
r = await call({ action: "bump", id: "junk", total: 5 });
ok(!r.isError && r.content[0].text.includes("1/5"), "bump with total rebuilds it cleanly");
r = await call({ action: "remove", id: "junk" });
ok(!r.isError, "cleanup junk");

console.log("watchdog lifecycle");
const now = Math.floor(Date.now() / 1000);
// 10 min stale: past WAKE_AFTER_S (5 min) but inside HIDE_AFTER_S (30 min) — the nudge window
writeFileSync(`${DIR}/stuck.json`, JSON.stringify({ id: "stuck", label: "Stuck", done: 2, total: 10, updated: now - 600 }));
await new Promise((r2) => setTimeout(r2, 1300));
ok(toolCalls.sendUserMessage.length === 1, `stale task nudged exactly once (got ${toolCalls.sendUserMessage.length})`);
ok(toolCalls.sendUserMessage[0]?.[0]?.includes('"Stuck" 2/10'), "nudge carries facts");
ok(toolCalls.sendUserMessage[0]?.[1]?.deliverAs === "followUp", "nudge queued as followUp");
await new Promise((r2) => setTimeout(r2, 1300));
ok(toolCalls.sendUserMessage.length === 1, "dedupe holds across ticks");
writeFileSync(`${DIR}/stuck.json`, JSON.stringify({ id: "stuck", label: "Stuck", done: 5, total: 10, updated: Math.floor(Date.now() / 1000) - 601 }));
await new Promise((r2) => setTimeout(r2, 1300));
ok(toolCalls.sendUserMessage.length === 2, "re-armed after real progress stalled again");
writeFileSync(`${DIR}/fin.json`, JSON.stringify({ id: "fin", label: "Fin", done: 7, total: 7, updated: now - 600 }));
await new Promise((r2) => setTimeout(r2, 1300));
ok(!toolCalls.sendUserMessage.some(([m]) => m.includes('"Fin"')), "done tasks never nudged");

console.log("shutdown is final: ticks stop, no zombie re-arm");
await handlers.session_shutdown?.();
const hookAfter = (globalThis.__taskStatusTestHookCalls ??= []);
let afterCount = 0;
globalThis.__taskStatusTestHook = (e) => { if (e === "refresh") afterCount++; };
writeFileSync(`${DIR}/zombie.json`, JSON.stringify({ id: "zombie", label: "Z", done: 1, total: 9, updated: Math.floor(Date.now() / 1000) - 600 }));
await new Promise((r2) => setTimeout(r2, 1400));
ok(afterCount === 0, `no refresh after shutdown (got ${afterCount})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
