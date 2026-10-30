#!/usr/bin/env node
/**
 * test-hardening.cjs — anti-freeze & no-silent-failure tests.
 * Each case spawns a child process (env is read at module load), drives the
 * extension through a mock, and asserts on observable behavior.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };
const DIR = "/tmp/task-status-hard";

function scratch() {
	rmSync(DIR, { recursive: true, force: true });
	mkdirSync(DIR, { recursive: true });
}

/** Run a child script with env; collect stdout JSON the script prints. */
function runChild(body, env = {}, timeoutMs = 15000) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", body], {
			env: { ...process.env, PI_TASK_STATUS_DIR: DIR, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "", err = "", t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("close", (code, signal) => { clearTimeout(t); resolve({ code, signal, out, err }); });
	});
}

const HARNESS = `
const mod = await import("file://MODULE_PATH");
const pi = {
  on: (ev, h) => (globalThis.h ??= {})[ev] = h,
  registerCommand: () => {},
  registerTool: () => {},
  sendUserMessage: (t, o) => console.log("NUDGE\\n" + t),
};
const notes = [];
globalThis.__taskStatusTestHook = (e) => console.log("HOOK:" + e);
mod.default(pi);
await globalThis.h.session_start({}, {
  ui: { notify: (m, k) => console.log("NOTE:" + k + ":" + m), setStatus: () => {}, theme: { fg: (_s, x) => x } },
});
`.replace("MODULE_PATH", new URL("../taskwatcher.ts", import.meta.url).pathname);

console.log("env sanitization: garbage values fall back, get reported, cannot spin");
for (const badVal of ["", "abc", "0", "-5"]) {
	scratch();
	const { out } = await runChild(HARNESS + `
await new Promise(r => setTimeout(r, 1300));
process.exit(0);
`, { PI_TASK_REFRESH_MS: badVal });
	const hookCount = (out.match(/HOOK:refresh/g) || []).length;
	const reported = out.includes("PI_TASK_REFRESH_MS");
	ok(reported, `PI_TASK_REFRESH_MS=${JSON.stringify(badVal)} is reported to the user`);
	ok(hookCount >= 1 && hookCount <= 4, `cadence bounded (refresh ×${hookCount} in 1.3s, floor 500ms — no spin)`);
}

console.log("zombie-proof: pending timer never keeps the process alive");
scratch();
{
	const t0 = Date.now();
	const { code, signal } = await runChild(HARNESS, {}, 5000);
	const exited = code !== null && signal !== "SIGKILL";
	ok(exited && Date.now() - t0 < 4500, `child exited on its own in ${Date.now() - t0}ms (unref works)`);
}

console.log("oversized files: flagged after persistent ticks, not silently skipped");
scratch();
{
	writeFileSync(`${DIR}/huge.json`, JSON.stringify({ id: "huge", done: 1, total: 2, updated: 1, pad: "x".repeat(100 * 1024) }));
	const { out } = await runChild(HARNESS + `
await new Promise(r => setTimeout(r, 3200));
process.exit(0);
`, { PI_TASK_REFRESH_MS: "500" });
	ok(out.includes("ignoring huge.json"), "oversized file announced after persistent ticks");
	ok(out.includes("oversized"), "announcement carries the reason");
}

console.log("corrupt JSON: transient tolerated, persistent surfaced");
scratch();
{
	writeFileSync(`${DIR}/broken.json`, "{ not json !!!");
	const { out } = await runChild(HARNESS + `
await new Promise(r => setTimeout(r, 3200));
process.exit(0);
`, { PI_TASK_REFRESH_MS: "500" });
	ok(out.includes("ignoring broken.json"), "persistently corrupt file announced");
	ok(out.includes("invalid JSON") || out.includes("unreadable"), "reason stated");
}

console.log("file-count cap: truncation is announced, not silent");
scratch();
{
	for (let i = 0; i < 203; i++) writeFileSync(`${DIR}/t${i}.json`, JSON.stringify({ id: `t${i}`, done: 1, total: 2, updated: Math.floor(Date.now() / 1000) }));
	const { out } = await runChild(HARNESS + `
await new Promise(r => setTimeout(r, 800));
process.exit(0);
`);
	ok(out.includes("beyond PI_TASK_MAX_FILES"), "truncation announced");
}

console.log("event loop never blocks under load (async I/O)");
scratch();
{
	for (let i = 0; i < 150; i++) writeFileSync(`${DIR}/load${i}.json`, JSON.stringify({ id: `load${i}`, label: "L" + i, done: i, total: 150, updated: Math.floor(Date.now() / 1000), pad: "y".repeat(48 * 1024) }));
	const { out } = await runChild(HARNESS + `
let maxGap = 0, last = Date.now();
const iv = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 2);
await new Promise(r => setTimeout(r, 2000));
clearInterval(iv);
console.log("MAXGAP:" + maxGap);
process.exit(0);
`, { PI_TASK_REFRESH_MS: "500" });
	const gap = parseInt((out.match(/MAXGAP:(\d+)/) || [0, 999])[1], 10);
	ok(gap < 100, `main-thread max block ${gap}ms < 100ms with 150×48KB files`);
}

console.log("python CLI: failures exit non-zero with a message");
{
	const r1 = spawnSync("python3", [new URL("../scripts/task_status.py", import.meta.url).pathname, "set", "--id", "cli1", "--total", "5", "--label", "CLI"], { env: { ...process.env, PI_TASK_STATUS_DIR: DIR }, encoding: "utf-8" });
	ok(r1.status === 0, "set ok");
	const r2 = spawnSync("python3", [new URL("../scripts/task_status.py", import.meta.url).pathname, "bump", "--id", "ghost"], { env: { ...process.env, PI_TASK_STATUS_DIR: DIR }, encoding: "utf-8" });
	ok(r2.status !== 0 && (r2.stderr || r2.stdout).length > 0, "bump of unknown id fails loudly");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
