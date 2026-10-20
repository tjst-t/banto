import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import type { ProjectStart } from "../project-thread/types.js";
import {
  credentialHelperScript,
  ProjectStarter,
  ProjectStartError,
  type ProjectShell,
  type ProjectStartDeps,
  type ShellRun,
} from "./project-start.js";

const GH = { web: "https://github.com", ssh: "github.com" };
const OK: ShellRun = { exitCode: 0, stdout: "", stderr: "" };

type Call = { command: string; envSecrets?: Record<string, string> };

async function withStarter(
  fn: (ctx: {
    store: ProjectThreadStore;
    starter: ProjectStarter;
    calls: string[];
    commands: Call[];
    changes: ProjectStart["status"][];
  }) => Promise<void>,
  opts: {
    mode?: "machine" | "containers";
    shell?: (call: Call, signal: AbortSignal, progress: (n: number) => void) => Promise<ShellRun>;
    createProject?: () => Promise<never>;
    over?: Partial<ProjectStartDeps>;
    store?: (store: ProjectThreadStore) => Promise<void>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "banto-start-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    await opts.store?.(store);
    const calls: string[] = [];
    const commands: Call[] = [];
    const changes: ProjectStart["status"][] = [];
    const shell: ProjectShell = {
      run: async (args, o) => {
        const call = { command: args.command, ...(args.envSecrets ? { envSecrets: args.envSecrets } : {}) };
        commands.push(call);
        calls.push("shell");
        return opts.shell ? opts.shell(call, o.signal, o.onProgress) : OK;
      },
    };
    const deps: ProjectStartDeps = {
      projectThread: store,
      remote: {
        modeOf: (name) => (name === "vm" ? (opts.mode ?? "machine") : undefined),
        createDirectory: async (name, parent, folder) => {
          calls.push(`mkdir:${name}:${parent}:${folder}`);
          return `/home/r/${folder}`;
        },
        removeEmptyDirectory: async (name, path) => {
          calls.push(`rmdir:${name}:${path}`);
        },
        createProject: async (name, projectName, root) => {
          calls.push(`project:${name}:${root}`);
          if (opts.createProject) return opts.createProject();
          return store.createProject(projectName, root, { runtime: `remote:${name}` });
        },
      },
      github: GH,
      wakeShell: async (projectId) => {
        calls.push(`wake:${store.getProject(projectId)?.start?.status}`);
        return shell;
      },
      onChange: (_id, start) => changes.push(start.status),
      ...opts.over,
    };
    await fn({ store, starter: new ProjectStarter(deps), calls, commands, changes });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function settled(store: ProjectThreadStore, id: string): Promise<ProjectStart> {
  for (let i = 0; i < 200; i++) {
    const s = store.getProject(id)?.start;
    if (s && s.status !== "waking" && s.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("始め方の仕事が終わりませんでした");
}

test("作る順番：フォルダ → Project → 仕事（waking→running→done）。新しいリポジトリは既定のブランチ名を読んでから別に init する", async () => {
  await withStarter(
    async ({ store, starter, calls, commands, changes }) => {
      const project = await starter.create({ runtime: "vm", parent: "~/src", folder: "app", name: "App", start: { kind: "init" } });
      assert.equal(project.root, "/home/r/app");
      assert.equal(project.start?.kind, "init");
      const start = await settled(store, project.id);
      assert.equal(start.status, "done", start.error);
      assert.deepEqual(calls, ["mkdir:vm:~/src:app", "project:vm:/home/r/app", "wake:waking", "shell", "shell"]);
      assert.deepEqual(changes, ["waking", "running", "done"]);
      // 名前を読むコマンドには GIT_CONFIG_GLOBAL を付けない（Shell のホームの設定を読む）
      assert.equal(commands[0]!.command, "git config --global --get init.defaultBranch || true");
      assert.equal(commands[1]!.command, "cd -- '/home/r/app' && GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null git init -b 'trunk'");
    },
    { shell: async (call) => (call.command.includes("init.defaultBranch") ? { ...OK, stdout: "trunk\n" } : OK) },
  );
});

test("作るときに一緒に書く設定（onCreated）は、Project を作った直後・仕事を始める前に呼ぶ。断ったら仕事を始めない", async () => {
  await withStarter(async ({ store, starter, calls }) => {
    const project = await starter.create({
      runtime: "vm",
      parent: "~",
      folder: "s",
      name: "S",
      start: { kind: "init" },
      onCreated: async (p) => {
        calls.push(`settings:${p.root}:${store.getProject(p.id)?.start === undefined}`);
      },
    });
    await settled(store, project.id);
    assert.deepEqual(calls.slice(0, 4), ["mkdir:vm:~:s", "project:vm:/home/r/s", "settings:/home/r/s:true", "wake:waking"]);
  });
  await withStarter(async ({ store, starter, calls }) => {
    await assert.rejects(
      starter.create({
        runtime: "vm",
        parent: "~",
        folder: "t",
        name: "T",
        start: { kind: "init" },
        onCreated: async () => {
          throw new Error("書けません");
        },
      }),
      /書けません/,
    );
    assert.ok(!calls.some((c) => c.startsWith("wake:")));
    assert.equal(store.listProjects()[0]?.start, undefined);
  });
});

test("既定のブランチ名が無ければ main", async () => {
  await withStarter(async ({ store, starter, commands }) => {
    const project = await starter.create({ runtime: "vm", parent: undefined, folder: "a", name: "A", start: { kind: "init" } });
    await settled(store, project.id);
    assert.match(commands[1]!.command, /git init -b 'main'$/);
  });
});

test("Project を作れなかったら、作った空のフォルダを消して理由をそのまま返す。仕事は始めない", async () => {
  await withStarter(
    async ({ store, starter, calls }) => {
      await assert.rejects(
        starter.create({ runtime: "vm", parent: "~", folder: "x", name: "X", start: { kind: "init" } }),
        /重なっています/,
      );
      assert.deepEqual(calls, ["mkdir:vm:~:x", "project:vm:/home/r/x", "rmdir:vm:/home/r/x"]);
      assert.equal(store.listProjects().length, 0);
    },
    {
      createProject: async () => {
        throw new ProjectStartError(409, "ほかの Project の根と重なっています");
      },
    },
  );
});

test("フォルダを作れなければ Project も作らない（同じ名前は断る）", async () => {
  await withStarter(
    async ({ store, starter, calls }) => {
      await assert.rejects(starter.create({ runtime: "vm", parent: "~", folder: "x", name: "X", start: { kind: "init" } }), /同じ名前/);
      assert.deepEqual(calls, []);
      assert.equal(store.listProjects().length, 0);
    },
    {
      over: {
        remote: {
          modeOf: () => "machine",
          createDirectory: async () => {
            throw new Error("同じ名前のものがもうあります：x");
          },
          removeEmptyDirectory: async () => assert.fail("消すものは無い"),
          createProject: async () => assert.fail("Project は作らない"),
        },
      },
    },
  );
});

test("URL の断り：file・ext・資格情報入り・- で始まるものは、何も作る前に 400 で断る", async () => {
  await withStarter(async ({ starter, calls }) => {
    for (const url of ["file:///srv/x.git", "ext::sh", "https://u:t@github.com/a/b", "--upload-pack=x", "https://example.org/a/b.git\n-x"]) {
      await assert.rejects(
        starter.create({ runtime: "vm", parent: "~", folder: "x", name: "X", start: { kind: "clone", url } }),
        (err: unknown) => err instanceof ProjectStartError && err.status === 400,
        url,
      );
    }
    assert.deepEqual(calls, []);
  });
});

test("containers（#369 まで）は ssh の URL とアカウントを断る。https の公開の clone は通す", async () => {
  await withStarter(
    async ({ store, starter }) => {
      const create = (url: string, account?: string) =>
        starter.create({ runtime: "vm", parent: "~", folder: `f${Math.random()}`, name: "X", start: { kind: "clone", url, ...(account ? { account } : {}) } });
      await assert.rejects(create("git@github.com:a/b.git"), /https の URL だけ/);
      await assert.rejects(create("ssh://git@example.org/a/b.git"), /https の URL だけ/);
      await assert.rejects(create("https://github.com/a/b.git", "octo"), /アカウントを使えません/);
      const p = await create("a/b");
      assert.equal((await settled(store, p.id)).status, "done");
    },
    { mode: "containers" },
  );
});

test("clone：作業フォルダを片づけて根が空かを見る → 作業フォルダへ clone → 中身を根へ。アカウントは GitHub の https のときだけ envSecrets と credential.helper で渡す", async () => {
  await withStarter(async ({ store, starter, commands }) => {
    const p = await starter.create({
      runtime: "vm",
      parent: "~",
      folder: "b",
      name: "B",
      start: { kind: "clone", url: "https://github.com/a/b.git", account: "Octo" },
    });
    assert.equal((await settled(store, p.id)).status, "done");
    const work = `.banto-clone-${p.id}`;
    assert.equal(commands.length, 3);
    assert.match(commands[0]!.command, new RegExp(`^cd -- '/home/r/b' && rm -rf -- '${work}' && if \\[ -n "\\$\\(ls -A\\)" \\]`));
    const clone = commands[1]!;
    assert.ok(
      clone.command.startsWith(
        "cd -- '/home/r/b' && GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null git -c credential.helper= -c 'credential.helper=!f() {",
      ),
      clone.command,
    );
    assert.ok(clone.command.endsWith(` clone --progress -- 'https://github.com/a/b.git' '${work}'`), clone.command);
    // トークンは環境変数の名前で参照する（コマンドに値を埋めない）。alias は小文字の login
    assert.deepEqual(clone.envSecrets, { GIT_HTTP_TOKEN: "repositories-github-octo" });
    assert.match(clone.command, /"\$GIT_HTTP_TOKEN"/);
    assert.equal(commands[2]!.command, `cd -- '/home/r/b' && find '${work}' -mindepth 1 -maxdepth 1 -exec mv -t . -- {} + && rmdir -- '${work}'`);
    assert.equal(store.getProject(p.id)?.start?.account, "Octo");

    // アカウント無し（公開のもの）は credential.helper を空にするだけ。owner/repo は GitHub の https にする
    commands.length = 0;
    const q = await starter.create({ runtime: "vm", parent: "~", folder: "c", name: "C", start: { kind: "clone", url: "a/c" } });
    await settled(store, q.id);
    assert.ok(commands[1]!.command.includes(" git -c credential.helper= clone --progress -- 'https://github.com/a/c.git' "), commands[1]!.command);
    assert.equal(commands[1]!.envSecrets, undefined);

    // GitHub の外・ssh の URL にアカウントは付けられない
    await assert.rejects(
      starter.create({ runtime: "vm", parent: "~", folder: "d", name: "D", start: { kind: "clone", url: "https://gitlab.com/a/d.git", account: "octo" } }),
      /GitHub の https の URL でだけ/,
    );
    await assert.rejects(
      starter.create({ runtime: "vm", parent: "~", folder: "d", name: "D", start: { kind: "clone", url: "git@github.com:a/d.git", account: "octo" } }),
      /GitHub の https の URL でだけ/,
    );
  });
});

test("clone の失敗：作業フォルダだけを消し、理由（git の出力の末尾）を記録する。もう一度で同じ中身を流し直せる", async () => {
  let fail = true;
  await withStarter(
    async ({ store, starter, commands }) => {
      const p = await starter.create({ runtime: "vm", parent: "~", folder: "b", name: "B", start: { kind: "clone", url: "https://example.org/a/b.git" } });
      const failed = await settled(store, p.id);
      assert.equal(failed.status, "failed");
      assert.match(failed.error!, /^git clone が失敗しました：.*fatal: repository 'https:\/\/example.org\/a\/b.git\/' not found$/);
      assert.equal(commands.length, 3);
      assert.equal(commands[2]!.command, `cd -- '/home/r/b' && rm -rf -- '.banto-clone-${p.id}'`);

      fail = false;
      commands.length = 0;
      await starter.retry(p.id);
      const done = await settled(store, p.id);
      assert.equal(done.status, "done");
      assert.equal(done.error, undefined);
      assert.equal(done.url, "https://example.org/a/b.git");
      assert.match(commands[0]!.command, /rm -rf --/);
      await assert.rejects(starter.retry(p.id), /もう終わっています/);
    },
    {
      shell: async (call) =>
        fail && call.command.includes(" clone --progress ")
          ? { exitCode: 128, stdout: "", stderr: "Cloning into '.banto-clone-x'...\nfatal: repository 'https://example.org/a/b.git/' not found\n" }
          : OK,
    },
  );
});

test("1つの Project に始め方の仕事は同時に1本（走っている間のもう一度は断る）", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await withStarter(
    async ({ store, starter }) => {
      const p = await starter.create({ runtime: "vm", parent: "~", folder: "b", name: "B", start: { kind: "init" } });
      assert.equal(starter.isRunning(p.id), true);
      await assert.rejects(starter.retry(p.id), /いま走っています/);
      release();
      await settled(store, p.id);
      assert.equal(starter.isRunning(p.id), false);
    },
    { shell: async () => (await gate, OK) },
  );
});

test("git が決めた時間のあいだ何も出力しなければ取り消す（出力が増えている間は待つ）", async () => {
  let aborted = 0;
  await withStarter(
    async ({ store, starter, commands }) => {
      const p = await starter.create({ runtime: "vm", parent: "~", folder: "b", name: "B", start: { kind: "clone", url: "https://example.org/a/b.git" } });
      const s = await settled(store, p.id);
      assert.equal(s.status, "failed");
      assert.match(s.error!, /git clone が失敗しました：git が 0 秒のあいだ何も出力しなかったので取り消しました/);
      assert.equal(aborted, 1);
      // 取り消したあとも作業フォルダを片づける
      assert.match(commands.at(-1)!.command, /rm -rf -- '\.banto-clone-/);
    },
    {
      over: { stallMs: 120 },
      shell: (call, signal, progress) => {
        if (!call.command.includes(" clone --progress ")) return Promise.resolve(OK);
        return new Promise<ShellRun>((resolve, reject) => {
          // 最初の 300ms は出力が増え続ける（取り消さない）。そのあと止まる
          let chars = 0;
          const grow = setInterval(() => progress((chars += 10)), 40);
          setTimeout(() => clearInterval(grow), 300);
          const same = setInterval(() => progress(chars), 30);
          signal.addEventListener("abort", () => {
            aborted++;
            clearInterval(grow);
            clearInterval(same);
            reject(new Error("AbortError"));
          });
          setTimeout(() => {
            clearInterval(same);
            resolve(OK);
          }, 3_000);
        });
      },
    },
  );
});

test("起こし直したら、走っていた仕事を interrupted にする（流し直さない）。interrupted からもう一度できる", async () => {
  let id = "";
  await withStarter(
    async ({ store, starter, calls, changes }) => {
      await starter.recoverInterrupted();
      const s = store.getProject(id)!.start!;
      assert.equal(s.status, "interrupted");
      assert.match(s.error!, /起こし直した/);
      assert.equal(s.url, "https://example.org/a/b.git");
      assert.deepEqual(changes, ["interrupted"]);
      assert.deepEqual(calls, []);
      assert.deepEqual(starter.pending().map((x) => x.start.status), ["interrupted"]);
      await starter.retry(id);
      assert.equal((await settled(store, id)).status, "done");
      assert.deepEqual(starter.pending(), []);
    },
    {
      store: async (store) => {
        const p = await store.createProject("B", "/home/r/b", { runtime: "remote:vm" });
        id = p.id;
        await store.setProjectStart(p.id, { kind: "clone", url: "https://example.org/a/b.git", startedAt: "2026-10-20T00:00:00.000Z", status: "running" });
      },
    },
  );
});

test("Shell が断ったら（Vault が承認を求める等）その理由で failed にする", async () => {
  await withStarter(
    async ({ store, starter }) => {
      const p = await starter.create({ runtime: "vm", parent: "~", folder: "b", name: "B", start: { kind: "init" } });
      const s = await settled(store, p.id);
      assert.equal(s.status, "failed");
      assert.equal(s.error, "この Project に Shell の Module がありません");
    },
    {
      over: {
        wakeShell: async () => {
          throw new Error("この Project に Shell の Module がありません");
        },
      },
    },
  );
});

/** 本物の git に credential.helper を渡して、答えるかを見る */
function credentialFill(helper: string, input: string): { status: number | null; stdout: string } {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", `credential.helper=!${helper}`, "credential", "fill"], {
    input,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_HTTP_TOKEN: "tok-123", GIT_ASKPASS: "", SSH_ASKPASS: "" },
  });
  return { status: r.status, stdout: r.stdout };
}

test("credential.helper は GitHub の https（github.com）にだけ答え、ほかの host・http には何も答えない", () => {
  const helper = credentialHelperScript(GH);
  assert.doesNotMatch(helper, /tok-123/);
  const ok = credentialFill(helper, "protocol=https\nhost=github.com\npath=a/b.git\n\n");
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^username=x-access-token$/m);
  assert.match(ok.stdout, /^password=tok-123$/m);
  for (const input of ["protocol=https\nhost=evil.example\n\n", "protocol=http\nhost=github.com\n\n", "protocol=https\nhost=github.com.evil.example\n\n"]) {
    const r = credentialFill(helper, input);
    assert.notEqual(r.status, 0, input);
    assert.doesNotMatch(r.stdout, /tok-123/, input);
  }
  // 行き先を替えた GitHub（試験の偽物）なら、その protocol と host（port つき）にだけ答える
  const fake = credentialHelperScript({ web: "http://127.0.0.1:4555" });
  assert.match(credentialFill(fake, "protocol=http\nhost=127.0.0.1:4555\n\n").stdout, /^password=tok-123$/m);
  assert.notEqual(credentialFill(fake, "protocol=https\nhost=github.com\n\n").status, 0);
});
