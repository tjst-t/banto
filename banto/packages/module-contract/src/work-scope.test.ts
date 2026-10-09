import { test } from "node:test";
import assert from "node:assert/strict";
import { inWorkScope } from "./work-scope.js";

test("仕事の組に入れられないときは、そのまま起こす", () => {
  const r = inWorkScope("/bin/sh", ["-c", "echo hi"], { kind: "shell", available: () => false, env: { A: "1" } });
  assert.deepEqual(r, { command: "/bin/sh", args: ["-c", "echo hi"], env: { A: "1" }, scoped: false });
});

test("入れられるときは systemd-run --user --scope で banto-work-jobs.slice に入れ、oom_score_adj と oom.group を書いてから exec する", () => {
  const r = inWorkScope("/bin/sh", ["-c", "echo hi"], { kind: "shell", available: () => true, uid: 1000, env: { A: "1" } });
  assert.equal(r.scoped, true);
  assert.equal(r.command, "systemd-run");
  assert.match(r.unit!, /^banto-shell-[0-9a-f]{8}\.scope$/);
  assert.deepEqual(r.args.slice(0, 6), ["--user", "--scope", "--quiet", "--collect", `--unit=${r.unit!.replace(/\.scope$/, "")}`, "--slice=banto-work-jobs.slice"]);
  assert.deepEqual(r.args.slice(-4), ["banto-work", "/bin/sh", "-c", "echo hi"]);
  assert.match(r.args[r.args.indexOf("-c") + 1]!, /echo 500 > \/proc\/self\/oom_score_adj.*memory\.oom\.group.*exec "\$@"/);
  assert.equal(r.env.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(r.env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  assert.equal(r.env.A, "1");
});
