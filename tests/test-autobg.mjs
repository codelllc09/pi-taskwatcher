// test-autobg.mjs — autobg module: bash auto-detach + generic stall watch
//
// Real child processes (sleep/echo); no fake timers. Runtime ≈ 3.5 min
// (stall floor 30 s, abort floor 60 s — parallel windows keep it bounded):
//   A 62 s  stall notice + first auto-abort (hung_tool)
//   B 62 s  cap enforcement (hung_tool again) ∥ never-abort whitelist
//   C 41 s  update re-arm ∥ skip list
//   + demote floor 10 s, sync abort, shutdown, zombie guard
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ok as rawOk } from "node:assert/strict";
let passed = 0;
const ok = (...a) => { rawOk(...a); passed++; };

const DIR = `/tmp/autobg-test-${Date.now()}`;
mkdirSync(DIR, { recursive: true });
process.env.PI_TASK_STATUS_DIR = DIR;
process.env.PI_AUTOBG_DIR = `${DIR}/bg`;
process.env.PI_AUTOBG_DEMOTE_MS = "10000";
process.env.PI_AUTOBG_STALL_S = "30";
process.env.PI_AUTOBG_ABORT_S = "60";
process.env.PI_AUTOBG_TICK_MS = "1000";
process.env.PI_AUTOBG_MAX_AUTO_ABORTS = "1"; // cap exercised in one extra window
process.env.PI_AUTOBG_NEVER_ABORT = "never_tool";

const mod = await import("../autobg.ts");
const sent = [];
const notes = [];
let aborts = 0;
let bashTool;
const handlers = {};
const pi = {
	on: (ev, h) => (handlers[ev] = h),
	registerCommand: () => {},
	registerTool: (d) => (bashTool = d),
	sendUserMessage: (text, opts) => sent.push([text, opts]),
};
mod.default(pi);

const uiCtx = {
	ui: { notify: (m, k) => notes.push([m, k]) },
	sessionManager: { getSessionId: () => "sess-ab" },
	abort: () => aborts++,
};
await handlers.session_start({}, uiCtx);
ok(bashTool?.name === "bash", "bash tool registered under its own name");
ok(bashTool.promptGuidelines.some((g) => g.includes("automatically detached")), "detach guideline injected");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args, signal) => bashTool.execute("tc", args, signal, undefined);

// ── 1. short command: synchronous, unchanged ────────────────────────────
{
	const r = await run({ command: "echo hello-sync" });
	ok(r.content[0].text.includes("hello-sync"), "short command output passes through");
	ok(!sent.some(([m]) => m.includes("Background command finished")), "no wake for short commands");
}

// ── 2. long command: demote at 10 s, wake on finish ──────────────────────
{
	const t0 = Date.now();
	const r = await run({ command: "echo pre; sleep 13; echo post" });
	const wall = Date.now() - t0;
	ok(wall < 12000 && wall >= 9500, `demote returned at ~10 s (wall ${wall} ms)`);
	ok(r.content[0].text.includes("[autobg]"), "demote notice in result");
	ok(r.content[0].text.includes("pre"), "pre-detach output retained");
	ok(!r.content[0].text.includes("post"), "post-detach output NOT in result");
	await sleep(4500); // command ends at t=13s; +500ms grace + margin
	const wake = sent.find(([m]) => m.includes("Background command finished"));
	ok(wake, "completion wake sent");
	ok(wake[0].includes("exit 0"), "wake carries exit code");
	ok(wake[0].includes("post"), "wake carries output tail");
	ok(wake[1]?.deliverAs === "followUp", "wake is queued (followUp)");
	const logFiles = execFileSync("ls", [`${DIR}/bg`]).toString().trim().split("\n");
	ok(logFiles.length === 1, "one bg log");
	ok(readFileSync(`${DIR}/bg/${logFiles[0]}`, "utf-8").includes("post"), "post-detach output in log");
	const st = JSON.parse(readFileSync(`${DIR}/${logFiles[0].replace(".log", ".json")}`, "utf-8"));
	ok(st.kind === "bg", "status file stamped kind:bg");
	ok(st.done === 1 && st.note.includes("exit 0"), "status file completed");
}

// ── 3. abort during synchronous phase kills (built-in semantics) ────────
{
	const ac = new AbortController();
	const p = run({ command: "sleep 30" }, ac.signal);
	setTimeout(() => ac.abort(), 400);
	let err;
	await p.catch((e) => (err = e));
	ok(err?.message.includes("abort"), "sync abort rejects with aborted");
	ok(aborts === 0, "extension never calls ctx.abort for sync abort");
}

// ── window A: stall notice at 30 s → auto-abort at 60 s ─────────────────
sent.length = 0;
notes.length = 0;
await handlers.tool_execution_start({ toolCallId: "w1", toolName: "hung_tool", args: {} }, uiCtx);
await sleep(31500);
ok(notes.some(([m, k]) => k === "warning" && m.includes("hung_tool") && m.includes("no progress")), "A: stall notice to user at 30 s");
ok(sent.some(([m]) => m.includes("hung_tool") && m.includes("went silent")), "A: stall notice queued for the model");
await sleep(31000);
ok(aborts === 1, "A: auto-abort fired at 60 s silence");
ok(sent.some(([m]) => m.includes("judged hung") && m.includes("auto-aborted")), "A: abort explanation queued for the model");
await handlers.tool_execution_end({ toolCallId: "w1" }, uiCtx);

// ── window B: cap reached (2nd hang, MAX=1 → notify only) ∥ never-abort ──
sent.length = 0;
notes.length = 0;
const abortsBeforeB = aborts;
await handlers.tool_execution_start({ toolCallId: "w2", toolName: "hung_tool", args: {} }, uiCtx);
await handlers.tool_execution_start({ toolCallId: "w4", toolName: "never_tool", args: {} }, uiCtx);
await sleep(62000);
ok(aborts === abortsBeforeB, "B: capped tool is not aborted again");
ok(sent.join("\n").includes("no further auto-aborts") || notes.join("\n").includes("no further auto-aborts"), "B: cap explanation present");
ok(aborts === abortsBeforeB, "B: never-abort tool untouched (same window)");
ok(notes.some(([m]) => m.includes("never_tool")), "B: never-abort tool still gets informational notice");
await handlers.tool_execution_end({ toolCallId: "w2" }, uiCtx);
await handlers.tool_execution_end({ toolCallId: "w4" }, uiCtx);

// ── window C: update re-arm ∥ skip list (fast tick) ─────────────────────
sent.length = 0;
notes.length = 0;
await handlers.tool_execution_start({ toolCallId: "w5", toolName: "alive_tool", args: {} }, uiCtx);
await handlers.tool_execution_start({ toolCallId: "r1", toolName: "read", args: {} }, uiCtx);
await sleep(20000); // < 30 s stall floor
await handlers.tool_execution_update({ toolCallId: "w5", toolName: "alive_tool", partialResult: {} }, uiCtx);
await sleep(20000); // 40 s total, but re-armed at 20 s → still quiet
ok(!notes.some(([m]) => m.includes("alive_tool")), "C: updates keep the stall clock quiet");
ok(!notes.some(([m]) => m.includes("read")), "C: builtin read is on the skip list");
await handlers.tool_execution_end({ toolCallId: "w5" }, uiCtx);
await handlers.tool_execution_end({ toolCallId: "r1" }, uiCtx);

// ── session shutdown: no more wakes ─────────────────────────────────────
{
	sent.length = 0;
	await handlers.session_shutdown?.();
	const r = await run({ command: `sleep 12; echo late` });
	ok(r.content[0].text.includes("[autobg]"), "demote still works after shutdown flag");
	await sleep(2500);
	ok(!sent.some(([m]) => m.includes("Background command finished")), "no wake after session shutdown");
}

// ── zombie guard: detached children and unref()ed timers never pin loop ─
const p = run({ command: "sleep 11" }); // demotes; child outlives the test
await sleep(12000);
ok(existsSync(`${DIR}/bg`), "bg log dir exists");
void p;

console.log(`${passed} passed, 0 failed`);
rmSync(DIR, { recursive: true, force: true });
// If the process exits after this print, the zombie guard holds.
