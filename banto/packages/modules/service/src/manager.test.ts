import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceManager } from "./manager.js";
import { ServiceError } from "./spec.js";
import { ServiceStore } from "./store.js";
import type { CommandResult, Systemctl } from "./systemd.js";

/** systemd の代わり。起こした・止めた・自動起動の状態だけを覚える */
class FakeSystemctl implements Systemctl {
  calls: string[][] = [];
  active = new Map<string, string>();
  enabled = new Set<string>();
  listening: Set<number> | null = new Set<number>();
  async run(args: string[]): Promise<CommandResult> {
    this.calls.push(args);
    const [cmd, ...rest] = args;
    const unit = rest.find((a) => a.endsWith(".service")) ?? "";
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    switch (cmd) {
      case "show":
        return ok(`ActiveState=${this.active.get(unit) ?? "inactive"}\nSubState=\nNRestarts=0\n`);
      case "is-enabled":
        return this.enabled.has(unit) ? ok("enabled\n") : { code: 1, stdout: "disabled\n", stderr: "" };
      case "enable":
        this.enabled.add(unit);
        return ok();
      case "disable":
        this.enabled.delete(unit);
        if (rest.includes("--now")) this.active.set(unit, "inactive");
        return ok();
      case "start":
      case "restart":
        this.active.set(unit, "active");
        return ok();
      case "stop":
        // 落ちていたもの（failed）は stop しても failed のまま（本物の systemd と同じ）
        if (this.active.get(unit) !== "failed") this.active.set(unit, "inactive");
        return ok();
      case "reset-failed":
        if (this.active.get(unit) === "failed") this.active.set(unit, "inactive");
        return ok();
      default:
        return ok();
    }
  }
  async listeningPorts() {
    return this.listening;
  }
  did(cmd: string, unit: string) {
    return this.calls.some((c) => c[0] === cmd && c.includes(unit));
  }
}

async function setup(
  opts: {
    secrets?: Record<string, string>;
    failAlias?: string;
    moduleName?: string;
    base?: string;
    withdrawPublications?: (name: string) => Promise<{ unpublished: { url: string; port: number }[] }>;
  } = {},
) {
  const base = opts.base ?? (await mkdtemp(join(tmpdir(), "banto-service-")));
  const sc = new FakeSystemctl();
  const resolved: string[] = [];
  const manager = new ServiceManager({
    projectRoot: join(base, "root"),
    store: new ServiceStore(join(base, "data", opts.moduleName ?? "service")),
    ...(opts.moduleName ? { moduleName: opts.moduleName } : {}),
    systemctl: sc,
    paths: { unitDir: join(base, "units"), stateDir: join(base, "state") },
    nodePath: "/usr/local/bin/node",
    wrapperPath: "/banto/log-wrapper.js",
    inheritedEnv: { ANTHROPIC_BASE_URL: "http://10.0.0.1:4737/claude" },
    settleMs: 0,
    ...(opts.withdrawPublications ? { withdrawPublications: opts.withdrawPublications } : {}),
    async resolveSecret(_env, alias) {
      if (alias === opts.failAlias) throw new Error("人が断りました");
      resolved.push(alias);
      return opts.secrets?.[alias] ?? `value-of-${alias}`;
    },
  });
  return { base, sc, manager, resolved, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("初めての名前：登録して、写し（unit・コマンド・0600 の鍵のファイル）を作り、自動起動に入れて起こす", async () => {
  const { base, sc, manager, cleanup } = await setup({ secrets: { openai: "sk-SECRET" } });
  try {
    const s = await manager.start({ name: "web", command: "npm run dev", ports: [3000], envSecrets: { OPENAI_API_KEY: "openai" } });
    assert.equal(s.state, "running");
    assert.equal(s.desired, "running");
    assert.ok(sc.did("enable", "banto-web.service") && sc.did("start", "banto-web.service"));
    const unit = await readFile(join(base, "units/banto-web.service"), "utf8");
    assert.doesNotMatch(unit, /sk-SECRET/, "鍵の値は unit に書かない");
    assert.equal(await readFile(join(base, "state/web/command.sh"), "utf8"), "npm run dev\n");
    const envPath = join(base, "state/web/env");
    assert.match(await readFile(envPath, "utf8"), /OPENAI_API_KEY="sk-SECRET"/);
    assert.match(await readFile(envPath, "utf8"), /ANTHROPIC_BASE_URL=/, "Claude のログインの住所も写す");
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    // **マスターに値を置かない**・返り値にも出さない
    assert.doesNotMatch(await readFile(join(base, "data/service/services.json"), "utf8"), /sk-SECRET/);
    assert.doesNotMatch(JSON.stringify(s), /sk-SECRET/);
  } finally {
    await cleanup();
  }
});

test("同じ名前・同じ中身なら起動するだけ。動いていれば鍵を引き直さない", async () => {
  const { manager, resolved, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x", envSecrets: { K: "k" } });
    await manager.start({ name: "web", command: "x", envSecrets: { K: "k" } });
    assert.deepEqual(resolved, ["k"], "動いているものの2回目は Vault を呼ばない");
  } finally {
    await cleanup();
  }
});

test("同じ名前・違う中身は断る。今の登録を理由に添える", async () => {
  const { manager, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "npm run dev" });
    await assert.rejects(manager.start({ name: "web", command: "npm start" }), (e: Error) => {
      assert.ok(e instanceof ServiceError);
      assert.match(e.message, /npm run dev/);
      assert.match(e.message, /removeService/);
      return true;
    });
  } finally {
    await cleanup();
  }
});

test("他のサービスと重なるポートは断る", async () => {
  const { manager, cleanup } = await setup();
  try {
    await manager.start({ name: "a", command: "x", ports: [3000] });
    await assert.rejects(manager.start({ name: "b", command: "y", ports: [3000, 3001] }), /3000.*"a"/);
  } finally {
    await cleanup();
  }
});

test("初めての登録で鍵が引けなかったら、登録も写しも残さない", async () => {
  const { base, manager, cleanup } = await setup({ failAlias: "bad" });
  try {
    await assert.rejects(manager.start({ name: "web", command: "x", envSecrets: { K: "bad" } }), /断りました/);
    assert.deepEqual(await manager.list(), []);
    await assert.rejects(stat(join(base, "units/banto-web.service")));
    await assert.rejects(stat(join(base, "state/web")));
  } finally {
    await cleanup();
  }
});

test("止める：desired を stopped にし、自動起動から外して止める。登録は残る", async () => {
  const { sc, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x" });
    const s = await manager.stop("web");
    assert.equal(s.state, "stopped");
    assert.ok(!sc.enabled.has("banto-web.service"));
    assert.equal((await manager.list()).length, 1);
  } finally {
    await cleanup();
  }
});

test("起こし直し：鍵を Vault から引き直す（鍵を替えたとき）", async () => {
  const { manager, resolved, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x", envSecrets: { K: "k" } });
    await manager.restart("web");
    assert.deepEqual(resolved, ["k", "k"]);
  } finally {
    await cleanup();
  }
});

test("消す：止めて、unit と置き場（鍵のファイル・ログ）と登録を消す", async () => {
  const { base, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x", envSecrets: { K: "k" } });
    await manager.remove("web");
    await assert.rejects(stat(join(base, "units/banto-web.service")));
    await assert.rejects(stat(join(base, "state/web")));
    assert.deepEqual(await manager.list(), []);
    await assert.rejects(manager.stop("web"), /登録されていません/);
  } finally {
    await cleanup();
  }
});

// **公開中のサービスを消したら、その公開もやめる**（2026-09-28、ユーザー決定の案A）。やめられなければ登録は消さない
// ——消したのに公開が残ると、同じ名前で別の中身を登録し直したとき、人の承認なしに同じ URL の中身が替わる
test("消す：先に公開をやめてもらい、やめた URL を返す。やめられなければ登録も unit も残して理由を返す", async () => {
  const asked: string[] = [];
  let refuse = true;
  const { base, sc, manager, cleanup } = await setup({
    withdrawPublications: async (name) => {
      asked.push(name);
      if (refuse) throw new Error("publish-caddy：Caddy に繋がりません");
      return { unpublished: [{ url: "https://web-1a2b3c4d.banto.example.net", port: 3000 }] };
    },
  });
  try {
    await manager.start({ name: "web", command: "x", ports: [3000] });
    await assert.rejects(manager.remove("web"), (e: Error) => e instanceof ServiceError && /公開をやめられなかったので、登録は消していません：publish-caddy：Caddy に繋がりません/.test(e.message));
    assert.deepEqual((await manager.list()).map((s) => s.name), ["web"], "公開をやめられないのに登録を消した");
    assert.ok(!sc.did("disable", "banto-web.service"), "公開をやめられないのに止めた");
    await stat(join(base, "units/banto-web.service"));

    refuse = false;
    const out = await manager.remove("web");
    assert.deepEqual(out, { name: "web", removed: true, unpublished: [{ url: "https://web-1a2b3c4d.banto.example.net", port: 3000 }] });
    assert.deepEqual(asked, ["web", "web"]);
    assert.deepEqual(await manager.list(), []);
    // 止めるだけでは知らせない（公開は残し、not-listening と出る）
    await manager.start({ name: "api", command: "x" });
    await manager.stop("api");
    assert.deepEqual(asked, ["web", "web"]);
  } finally {
    await cleanup();
  }
});

test("写しが消されたら作り直し、desired が running なら起こす（コンテナが起き直した場合）", async () => {
  const { base, sc, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x" });
    sc.active.set("banto-web.service", "inactive");
    sc.calls = [];
    await unlink(join(base, "units/banto-web.service"));
    await manager.list();
    assert.ok(await stat(join(base, "units/banto-web.service")));
    assert.ok(sc.calls.some((c) => c[0] === "daemon-reload"));
    assert.ok(sc.did("start", "banto-web.service"), "作り直したものは起こす");
  } finally {
    await cleanup();
  }
});

test("写しが書き換えられたら登録に合わせて戻す。人が中で止めたもの（unit はある）は起こさない", async () => {
  const { base, sc, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x" });
    const path = join(base, "units/banto-web.service");
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replace("Restart=on-failure", "Restart=no"));
    sc.active.set("banto-web.service", "inactive"); // 人が systemctl --user stop した
    sc.calls = [];
    await manager.list();
    assert.equal(await readFile(path, "utf8"), original);
    assert.ok(!sc.did("start", "banto-web.service"), "人が止めたものは止めたまま受け入れる");
  } finally {
    await cleanup();
  }
});

test("写しが消されたが鍵が要るものは、鍵のファイルが無ければ起こさずに理由を出す", async () => {
  const { base, sc, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x", envSecrets: { K: "k" } });
    await rm(join(base, "state/web"), { recursive: true });
    await unlink(join(base, "units/banto-web.service"));
    sc.active.set("banto-web.service", "inactive");
    sc.calls = [];
    const [s] = await manager.list();
    assert.ok(!sc.did("start", "banto-web.service"));
    assert.match(s!.note ?? "", /鍵のファイルが無い/);
  } finally {
    await cleanup();
  }
});

test("登録に無い banto の写しは片付ける（この Module が作った印のあるものだけ）", async () => {
  const { base, sc, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x" });
    const orphan = (await readFile(join(base, "units/banto-web.service"), "utf8")).replace(/web/g, "gone");
    await writeFile(join(base, "units/banto-gone.service"), orphan);
    await writeFile(join(base, "units/banto-mine.service"), "[Unit]\nDescription=人が作ったもの\n");
    await manager.list();
    await assert.rejects(stat(join(base, "units/banto-gone.service")));
    assert.ok(await stat(join(base, "units/banto-mine.service")), "印の無いものは触らない");
    assert.ok(sc.did("disable", "banto-gone.service"));
  } finally {
    await cleanup();
  }
});

test("一覧：登録したポートのうち待ち受けているものを分けて返す", async () => {
  const { sc, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x", ports: [3000, 3001] });
    sc.listening = new Set([3000]);
    const [s] = await manager.list();
    assert.deepEqual(s!.listening, [3000]);
    assert.deepEqual(s!.notListening, [3001]);
  } finally {
    await cleanup();
  }
});

test("ログ：末尾の行を返し、足りなければ回したもの（log.1）からも拾う", async () => {
  const { base, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x" });
    await writeFile(join(base, "state/web/log.1"), "a\nb\n");
    await writeFile(join(base, "state/web/log"), "c\nd\n");
    assert.deepEqual((await manager.logs("web", 3)).lines, ["b", "c", "d"]);
    assert.deepEqual((await manager.logs("web")).lines, ["a", "b", "c", "d"]);
  } finally {
    await cleanup();
  }
});

test("同時に頼まれても1本ずつ通す（同じ名前の登録が二重にならない）", async () => {
  const { manager, resolved, cleanup } = await setup();
  try {
    const results = await Promise.allSettled([
      manager.start({ name: "web", command: "x", envSecrets: { K: "k" } }),
      manager.start({ name: "web", command: "y" }),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal((await manager.list()).length, 1);
    assert.deepEqual(resolved, ["k"]);
  } finally {
    await cleanup();
  }
});

test("落ちたものを止めたら「止めた」と見せる（systemd に落ちた印を残さない）", async () => {
  const { sc, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x" });
    sc.active.set("banto-web.service", "failed");
    assert.equal((await manager.list())[0]!.state, "crashed");
    const s = await manager.stop("web");
    assert.equal(s.state, "stopped");
    assert.ok(sc.did("reset-failed", "banto-web.service"));
  } finally {
    await cleanup();
  }
});

test("登録済みの名前は name だけで起こせる。止めていたものは desired を戻し、鍵を引き直して起こす", async () => {
  const { sc, manager, resolved, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x", ports: [3000], envSecrets: { K: "k" } });
    await manager.stop("web");
    sc.calls = [];
    const s = await manager.start({ name: "web" });
    assert.equal(s.desired, "running");
    assert.equal(s.state, "running");
    assert.deepEqual(resolved, ["k", "k"]);
    assert.ok(sc.did("reset-failed", "banto-web.service") && sc.did("start", "banto-web.service"));
    // 書いた項目は登録と一致しないと断る
    await manager.stop("web");
    await assert.rejects(manager.start({ name: "web", ports: [4000] }), /別の中身/);
    // 初めての名前は command が要る
    await assert.rejects(manager.start({ name: "new" }), /command/);
  } finally {
    await cleanup();
  }
});

test("鍵が要るものの unit は、鍵のファイルが無ければ起動しない形（EnvironmentFile に - を付けない）", async () => {
  const { base, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "a", command: "x", envSecrets: { K: "k" } });
    await manager.start({ name: "b", command: "y" });
    assert.match(await readFile(join(base, "units/banto-a.service"), "utf8"), /^EnvironmentFile=\//m);
    assert.match(await readFile(join(base, "units/banto-b.service"), "utf8"), /^EnvironmentFile=-\//m);
  } finally {
    await cleanup();
  }
});

test("置き場だけ消えた（unit は残る）：鍵が要るものは理由を出し、要らないものは鍵のファイルを作り直す", async () => {
  const { base, sc, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "a", command: "x", envSecrets: { K: "k" } });
    await manager.start({ name: "b", command: "y" });
    await rm(join(base, "state"), { recursive: true });
    sc.calls = [];
    const list = await manager.list();
    assert.match(list.find((s) => s.name === "a")!.note ?? "", /鍵のファイルが無い/);
    assert.ok(await stat(join(base, "state/b/env")), "鍵の要らないものは作り直す");
    assert.ok(!sc.did("start", "banto-a.service"));
  } finally {
    await cleanup();
  }
});

test("同じ Project に2本つけても、互いの写しを片付けない（印に Module の名前を入れる）", async () => {
  const first = await setup({ moduleName: "service" });
  try {
    await first.manager.start({ name: "web", command: "x" });
    const second = await setup({ moduleName: "service-2", base: first.base });
    await second.manager.list();
    assert.ok(await stat(join(first.base, "units/banto-web.service")), "別の1本の写しは消さない");
  } finally {
    await first.cleanup();
  }
});

test("待ち受けを調べられなければ、空と言わずに理由を出す", async () => {
  const { sc, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x", ports: [3000] });
    sc.listening = null;
    const [s] = await manager.list();
    assert.deepEqual(s!.notListening, []);
    assert.match(s!.note ?? "", /待ち受けを調べられませんでした/);
  } finally {
    await cleanup();
  }
});

test("消すとき、systemd の中の落ちた印も消す（not-found/failed の残骸を残さない）", async () => {
  const { sc, manager, cleanup } = await setup();
  try {
    await manager.start({ name: "web", command: "x" });
    sc.calls = []; // 起動のときの reset-failed と取り違えない
    await manager.remove("web");
    assert.ok(sc.did("reset-failed", "banto-web.service"));
  } finally {
    await cleanup();
  }
});
