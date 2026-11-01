// test-stuck-enolog.mjs — stuck watch must survive a missing log (ENOENT → size 0)
// A bg task whose log creation failed is exactly the one that needs watching;
// before the fix, every stat() throw silently killed the watch for that task.
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import { ok } from "node:assert/strict";

const DIR = `/tmp/autobg-enolog-${Date.now()}`;
mkdirSync(`${DIR}/bg`, { recursive: true });
process.env.PI_TASK_STATUS_DIR = DIR;
process.env.PI_AUTOBG_DIR = `${DIR}/bg`;
process.env.PI_AUTOBG_DEMOTE_MS = "10000";
process.env.PI_AUTOBG_BG_STUCK_S = "60";
process.env.PI_AUTOBG_TOUCH_S = "10";
process.env.PI_AUTOBG_TICK_MS = "1000";

const mod = await import("../autobg.ts");
const sent = [];
let bashTool;
const pi = {
	on: () => {},
	registerCommand: () => {},
	registerTool: (d) => (bashTool = d),
	sendUserMessage: (t) => sent.push(t),
};
mod.default(pi);
const uiCtx = { ui: { notify: () => {} }, sessionManager: { getSessionId: () => "enolog" }, abort: () => {} };

const r = await bashTool.execute("t", { command: "sleep 90" }, undefined, undefined);
ok(r.content[0].text.includes("[autobg]"), "demoted at 10 s");

// simulate log-creation failure: the file vanishes → every stat() is ENOENT
const log = `${DIR}/bg/${readdirSync(`${DIR}/bg`)[0]}`;
rmSync(log);

await new Promise((res) => setTimeout(res, 95_000));  // 60s threshold + 10s ticks: leave real headroom
const stuck = sent.find((m) => m.includes("no log output for"));
ok(stuck, "stuck watch fires despite a missing log");
ok(stuck.includes("sleep 90"), "wake carries the command");

const pid = Number(r.content[0].text.match(/pid (\d+)/)?.[1]);
try {
	if (pid) process.kill(-pid, "SIGKILL");
} catch {
	/* already gone */
}
console.log("2 passed, 0 failed");
rmSync(DIR, { recursive: true, force: true });
process.exit(0);
