#!/usr/bin/env node
/**
 * test-wake.mjs — functional tests for wake.ts (/wake-at)
 * Pure time-spec parsing, set/cancel lifecycle, caps, floors,
 * delivery + failure announcement, shutdown discard, zombie guard.
 * Run: node tests/test-wake.mjs
 */
import { spawn } from "node:child_process";

process.env.PI_WAKE_MIN_S = "1"; // fast floor for real-timer tests
process.env.PI_WAKE_MAX = "3"; // low cap for the cap test

const mod = await import("../wake.ts");

const handlers = {};
let registeredCmd;
const sends = [];
const notes = [];
const events = [];

const pi = {
	on: (ev, h) => (handlers[ev] = h),
	registerCommand: (_name, def) => (registeredCmd = def),
	sendUserMessage: (text, opts) => sends.push([text, opts]),
};
mod.default(pi);

const uiCtx = { ui: { notify: (m, k) => notes.push([m, k]) } };
await handlers.session_start({}, uiCtx);

globalThis.__wakeTestHook = (ev, d) => events.push([ev, d]);

const run = (args) => registeredCmd.handler(args, uiCtx);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };
const errNotes = () => notes.filter(([, k]) => k === "error");

console.log("registration");
ok(registeredCmd !== undefined, "command registered");
ok(typeof registeredCmd.handler === "function", "handler is a function");

console.log("pure time-spec parsing (__wakeTestHookParse)");
const parse = globalThis.__wakeTestHookParse;
ok(typeof parse === "function", "parse hook exposed");
const NOW = new Date(2026, 0, 15, 10, 0, 0).getTime();
{
	let p = parse("30m", NOW, 60);
	ok(!("error" in p) && p.atMs === NOW + 1800_000, "30m → +1800s");
	p = parse("90s", NOW, 60);
	ok(!("error" in p) && p.atMs === NOW + 90_000, "90s → +90s");
	p = parse("2h", NOW, 60);
	ok(!("error" in p) && p.atMs === NOW + 7200_000, "2h → +7200s");
	p = parse("14:30", NOW, 60);
	ok(!("error" in p) && new Date(p.atMs).getHours() === 14 && new Date(p.atMs).getMinutes() === 30, "14:30 today (future)");
	p = parse("09:00", NOW, 60); // already past 10:00 → tomorrow
	ok(!("error" in p) && p.atMs > NOW + 20 * 3600_000, "09:00 past → tomorrow");
	p = parse("10:00", NOW, 60); // inside the 60s floor window → tomorrow
	ok(!("error" in p) && p.atMs > NOW, "10:00 now → tomorrow (never immediate)");
	p = parse("10:01", NOW, 60); // exactly at the floor edge → tomorrow
	ok(!("error" in p) && p.atMs > NOW, "10:01 (= floor edge) → tomorrow, no floor bypass");
	p = parse("10:02", NOW, 60); // past the floor → today
	ok(!("error" in p) && p.atMs < NOW + 3600_000, "10:02 (past floor) → today");
	const NIGHT = new Date(2026, 0, 15, 23, 50, 0).getTime();
	p = parse("00:10", NIGHT, 60); // midnight crossing
	ok(!("error" in p) && p.atMs > NIGHT && p.atMs - NIGHT < 24 * 3600_000, "00:10 from 23:50 → tomorrow just after midnight");
	for (const bad of ["30", "1.5h", "25:00", "abc", "0x10m"]) {
		p = parse(bad, NOW, 60);
		ok("error" in p, `"${bad}" rejected`);
	}
	p = parse("30s", NOW, 60);
	ok("error" in p && p.error.includes("floor"), "below-floor delay rejected with reason");
	p = parse("48h", NOW, 60);
	ok("error" in p && p.error.includes("ceiling"), "over-ceiling delay rejected with reason");
	p = parse("5s", NOW, 5);
	ok(!("error" in p), "floor is the caller's argument (env-driven)");
}

console.log("set → fire (one-shot, followUp)");
await run("2s hello world");
ok(notes.some(([m, k]) => k === "info" && m.includes("w1") && m.includes("hello world")), "set confirms id + note");
ok(events.some(([e, d]) => e === "set" && d?.id === "w1"), "hook saw set");
await run("");
ok(notes.some(([m]) => m.includes("w1") && m.includes("in")), "list shows pending w1");
await sleep(3200);
ok(sends.length === 1, `fired exactly once (got ${sends.length})`);
ok(sends[0]?.[1]?.deliverAs === "followUp", "delivered as followUp");
ok(sends[0]?.[0]?.includes("hello world"), "message text carried");
ok(sends[0]?.[0]?.includes("stale"), "stale-queue hint included");
await sleep(1200);
ok(sends.length === 1, "one-shot: never fires again");
await run("list");
ok(notes.some(([m]) => m.includes("no pending")), "list empty after fire");

console.log("cancel prevents fire");
await run("3s later");
await run("cancel w2");
ok(notes.some(([m, k]) => k === "info" && m.includes("cancelled")), "cancel confirms");
await sleep(4200);
ok(!sends.some(([m]) => m.includes("later")), "cancelled wake never fired");
ok(errNotes().length === 0, "no errors so far");

console.log("bad input is loud, nothing fabricated");
notes.length = 0;
await run("banana");
ok(errNotes().some(([m]) => m.includes("cannot parse") && m.includes("usage")), "bad spec → error + usage");
await run("cancel w99");
ok(errNotes().some(([m]) => m.includes("no such wake")), "cancel unknown → error");
ok(events.filter(([e]) => e === "reject").length === 2, "rejects hooked");

console.log("cap: PI_WAKE_MAX=3");
await run("10m a"); await run("10m b"); await run("10m c");
notes.length = 0;
await run("10m d");
ok(errNotes().some(([m]) => m.includes("PI_WAKE_MAX")), "4th wake rejected with cap message");
await run("cancel w3"); await run("cancel w4"); await run("cancel w5");

console.log("delivery failure is announced (no silent catch)");
{
	const goodSend = pi.sendUserMessage;
	pi.sendUserMessage = () => { throw new Error("boom"); };
	await run("2s failing delivery");
	await sleep(3200);
	ok(errNotes().some(([m]) => m.includes("failed") && m.includes("boom")), "fire failure announced");
	ok(events.some(([e]) => e === "fire-failed"), "fire-failed hooked");
	pi.sendUserMessage = goodSend;
}

console.log("shutdown discards pending, loudly");
await run("60m survive?");
notes.length = 0;
events.length = 0;
await handlers.session_shutdown();
ok(notes.some(([m, k]) => k === "warning" && m.includes("discarded 1")), "shutdown announces discarded count");
ok(events.some(([e, d]) => e === "discard" && d === 1), "discard hooked");
await sleep(1000);
ok(!sends.some(([m]) => m.includes("survive?")), "discarded wake never fires after shutdown");

console.log("zombie guard: pending wake does not keep the process alive");
const childCode = await new Promise((resolve) => {
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		process.env.PI_WAKE_MIN_S = "1";
		const mod = await import(${JSON.stringify(new URL("../wake.ts", import.meta.url).href)});
		const handlers = {};
		let cmd;
		mod.default({
			on: (ev, h) => (handlers[ev] = h),
			registerCommand: (_n, d) => (cmd = d),
			sendUserMessage: () => {},
		});
		await handlers.session_start({}, { ui: { notify: () => {} } });
		await cmd.handler("3600s pending forever", { ui: { notify: () => {} } });
	`], { stdio: ["ignore", "ignore", "inherit"] });
	const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
	child.on("close", (code, signal) => { clearTimeout(killer); resolve(signal === "SIGKILL" ? "HUNG" : code); });
});
ok(childCode === 0, childCode === "HUNG" ? "child HUNG with pending wake (unref broken!)" : "child exits cleanly with a pending 1h wake");

console.log("harness pre-flight: undeliverable wakes are flagged at session start");
{
	const notes2 = [];
	const handlers2 = {};
	mod.default({ // no sendUserMessage at all
		on: (ev, h) => (handlers2[ev] = h),
		registerCommand: () => {},
	});
	await handlers2.session_start({}, { ui: { notify: (m, k) => notes2.push([m, k]) } });
	ok(notes2.some(([m, k]) => k === "warning" && m.includes("sendUserMessage unavailable")), "missing sendUserMessage → warned up front");
}

console.log("invalid env is reported at session start (subprocess, env read at load)");
{
	const out = await new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", `
			process.env.PI_WAKE_MAX = "banana";
			process.env.PI_WAKE_MIN_S = "-5";
			const mod = await import(${JSON.stringify(new URL("../wake.ts", import.meta.url).href)});
			const notes = [];
			const handlers = {};
			mod.default({ on: (ev, h) => (handlers[ev] = h), registerCommand: () => {}, sendUserMessage: () => {} });
			await handlers.session_start({}, { ui: { notify: (m, k) => notes.push([m, k]) } });
			console.log(JSON.stringify(notes));
		`], { stdio: ["ignore", "pipe", "inherit"] });
		let buf = "";
		child.stdout.on("data", (d) => (buf += d));
		const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
		child.on("close", () => { clearTimeout(killer); resolve(buf); });
	});
	ok(out.includes("ignored invalid env"), "garbage env values reported");
	ok(out.includes("PI_WAKE_MAX=banana") && out.includes("PI_WAKE_MIN_S=-5"), "both bad values named");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
