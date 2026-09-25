import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./run-command.js";

function unusedRelayClient() {
  return {
    lookupAlias: async (_t: string, name: string) => ({ implementation: "vault", name, group: "instance" }),
    resolveAlias: async () => {
      throw new Error("relay should not be called for this test");
    },
    startSshAgent: async () => {
      throw new Error("relay should not be called for this test");
    },
    close: async () => undefined,
  } as unknown as import("./host-relay-client.js").HostRelayClient;
}

test("runs a command and captures stdout/stderr/exitCode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const result = await runCommand(
      { command: "echo hello && echo world 1>&2 && exit 3" },
      { projectRoot: dir, relayClient: unusedRelayClient() },
    );
    assert.equal(result.stdout.trim(), "hello");
    assert.equal(result.stderr.trim(), "world");
    assert.equal(result.exitCode, 3);
    assert.equal(result.timedOut, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runs relative to the project root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    await writeFile(join(dir, "marker.txt"), "here");
    const result = await runCommand(
      { command: "cat marker.txt" },
      { projectRoot: dir, relayClient: unusedRelayClient() },
    );
    assert.equal(result.stdout.trim(), "here");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("times out long-running commands and reports timedOut", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const result = await runCommand(
      { command: "sleep 5", timeout: 0.5 },
      { projectRoot: dir, relayClient: unusedRelayClient() },
    );
    assert.equal(result.timedOut, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secretFiles are written before exec and always deleted after, even on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const relayClient = {
      lookupAlias: async (_t: string, name: string) => ({ implementation: "vault", name, group: "instance" }),
      resolveAlias: async () => "TOP-SECRET-VALUE",
      startSshAgent: async () => ({ socketPath: "/tmp/unused.sock" }),
      close: async () => undefined,
    } as unknown as import("./host-relay-client.js").HostRelayClient;

    const result = await runCommand(
      { command: "cat .npmrc; exit 1", secretFiles: { ".npmrc": "npm-registry-token" } },
      { projectRoot: dir, relayClient },
    );
    assert.equal(result.stdout.trim(), "TOP-SECRET-VALUE");
    assert.equal(result.exitCode, 1);
    assert.equal(existsSync(join(dir, ".npmrc")), false, "secretFile was not cleaned up after failure");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 中継トークンは「どのModuleからの呼び出しか」の識別そのもの。AIの書いた
// コマンドに継承されると、AIがShellの身元でresolveAliasを呼べてしまう
// （決定・2026-09-10、docs/specs/v4-security.md「中継が縛らないもの」）。
test("no BANTO_* variable is visible to the child process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  const before = { ...process.env };
  process.env.BANTO_HOST_MCP_TOKEN = "RELAY-TOKEN-MUST-NOT-LEAK";
  process.env.BANTO_HOST_MCP_URL = "http://127.0.0.1:1/relay";
  process.env.BANTO_PROJECT_ROOT = dir;
  process.env.BANTO_MODULE_DATA_DIR = dir;
  try {
    const result = await runCommand(
      { command: "env | grep '^BANTO_'; echo exit=$?" },
      { projectRoot: dir, relayClient: unusedRelayClient() },
    );
    assert.equal(result.stdout.trim(), "exit=1", `BANTO_* leaked to the child: ${result.stdout}`);
    assert.ok(!result.stdout.includes("RELAY-TOKEN-MUST-NOT-LEAK"));

    // 親（Moduleプロセス）自身のenvは壊さない——hostから受け取った値で
    // 中継クライアントが動いているため。
    assert.equal(process.env.BANTO_HOST_MCP_TOKEN, "RELAY-TOKEN-MUST-NOT-LEAK");
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in before)) delete process.env[name];
    }
    Object.assign(process.env, before);
    await rm(dir, { recursive: true, force: true });
  }
});

test("BANTO_* が envSecrets で復活させられない（黙って無視せず止める）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const relayClient = {
      lookupAlias: async (_t: string, name: string) => ({ implementation: "vault", name, group: "instance" }),
      resolveAlias: async () => "whatever",
      startSshAgent: async () => ({ socketPath: "/tmp/unused.sock" }),
      close: async () => undefined,
    } as unknown as import("./host-relay-client.js").HostRelayClient;

    await assert.rejects(
      runCommand(
        { command: "true", envSecrets: { BANTO_HOST_MCP_TOKEN: "some-alias" } },
        { projectRoot: dir, relayClient },
      ),
      /BANTO_/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PATH などの通常の環境変数は子に届く", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const result = await runCommand(
      { command: 'echo "path=${PATH:+set}"' },
      { projectRoot: dir, relayClient: unusedRelayClient() },
    );
    assert.equal(result.stdout.trim(), "path=set");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// **MCP の呼び出しは既定60秒で切れる**（既知の罠）。`npm install` のような
// 長いコマンドを通すため、実行中は進捗を送り続けて呼び出し元のタイムアウトを
// 更新させる（docs/specs/v4-modules.md §2.3）。
test("長いコマンドの実行中は、進捗を送り続ける（呼び出し元のタイムアウトを更新させる）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  const notes: string[] = [];
  try {
    const result = await runCommand(
      { command: "sleep 0.4" },
      {
        projectRoot: dir,
        relayClient: unusedRelayClient(),
        onProgress: (note) => notes.push(note),
        progressIntervalMs: 50,
      },
    );
    assert.equal(result.exitCode, 0);
    const heartbeats = notes.filter((n) => n.startsWith("実行中"));
    assert.ok(heartbeats.length >= 3, `進捗が足りない: ${JSON.stringify(notes)}`);
    assert.match(heartbeats[0]!, /秒経過/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("コマンドが終わったら進捗も止まる（タイマーを残さない）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  const notes: string[] = [];
  try {
    await runCommand(
      { command: "true" },
      {
        projectRoot: dir,
        relayClient: unusedRelayClient(),
        onProgress: (note) => notes.push(note),
        progressIntervalMs: 20,
      },
    );
    const afterExit = notes.length;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(notes.length, afterExit, "終わった後も進捗が送られている");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("envSecrets values reach the child process env, never the command string", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const relayClient = {
      lookupAlias: async (_t: string, name: string) => ({ implementation: "vault", name, group: "instance" }),
      resolveAlias: async (place: { name: string }) => `resolved-${place.name}`,
      startSshAgent: async () => ({ socketPath: "/tmp/unused.sock" }),
      close: async () => undefined,
    } as unknown as import("./host-relay-client.js").HostRelayClient;

    const result = await runCommand(
      { command: 'echo "token=$NPM_TOKEN"', envSecrets: { NPM_TOKEN: "npm-registry-token" } },
      { projectRoot: dir, relayClient },
    );
    assert.equal(result.stdout.trim(), "token=resolved-npm-registry-token");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// **引数の説明は、AI がこの Module を使えるかどうかそのもの**
// （追加・2026-09-12、ユーザー指摘「AI が Vault の使い方を分かっていない」）。
// 以前は `envSecrets: { type: "object" }` としか書いておらず、
// 「何を鍵にして何を値にするのか」も「値を書いてはいけない」ことも伝わらなかった。
test("runCommand の説明が、秘密の渡し方を AI に伝えている", async () => {
  const { createShellServer } = await import("./server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  // 中継は使わない試験（tool の説明だけを見る）——繋がる先は要らない
  const relayClient = {
    lookupAlias: async (_t: string, name: string) => ({ implementation: "vault", name, group: "instance" }),
    resolveAlias: async () => "",
    startSshAgent: async () => ({ socketPath: "" }),
  };
  const server = createShellServer({
    projectRoot: process.cwd(),
    relayClient: relayClient as never,
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const { tools } = await client.listTools();
    const run = tools.find((t) => t.name === "runCommand")!;
    assert.match(run.description ?? "", /alias/, "秘密を alias 名で渡すことが書かれていない");
    assert.match(run.description ?? "", /vault:\/\/aliases/, "一覧の在りかが書かれていない");

    const props = (run.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    assert.match(props.envSecrets?.description ?? "", /alias 名/, "envSecrets の説明が無い");
    assert.match(props.secretFiles?.description ?? "", /alias 名/, "secretFiles の説明が無い");
    assert.match(props.sshIdentity?.description ?? "", /ssh-identity/, "sshIdentity の説明が無い");
    assert.match(props.timeout?.description ?? "", /120/, "既定のタイムアウトが書かれていない");
  } finally {
    await client.close();
  }
});

// **決め打ちをやめた**（追加・2026-09-12）。以前は `"vault"` を直に呼んでいたので、
// 2本目の backend に預けた秘密には構造的に届かなかった。ここで見るのは2つ：
//   1. **在りかを窓口に聞いてから**、その金庫を呼ぶ（`vault` 以外にも届く）
//   2. **値は窓口を通らない**——窓口に渡すのは名前だけ
test("秘密の在りかは窓口に聞く——決め打ちした金庫を呼ばない", async () => {
  const calls: Array<[string, string]> = [];
  const relayClient = {
    lookupAlias: async (target: string, name: string) => {
      calls.push([`lookup:${target}`, name]);
      // **修飾名で頼まれても、backend での本当の名前と置き場を返す**
      return { implementation: "vault-infisical", name: "npm-token", group: "team" };
    },
    resolveAlias: async (place: { implementation: string; name: string; group?: string }) => {
      calls.push([`resolve:${place.implementation}`, place.name + "@" + place.group]);
      return "VALUE-FROM-SECOND-VAULT";
    },
    startSshAgent: async () => ({ socketPath: "/tmp/unused.sock" }),
  } as unknown as import("./host-relay-client.js").HostRelayClient;

  const dir = await mkdtemp(join(tmpdir(), "shell-lookup-"));
  const result = await runCommand(
    { command: "printf %s \"$TOKEN\"", envSecrets: { TOKEN: "vault-infisical:npm-token" } },
    { projectRoot: dir, relayClient },
  );

  assert.equal(result.stdout, "VALUE-FROM-SECOND-VAULT");
  assert.deepEqual(calls, [
    ["lookup:vault-directory", "vault-infisical:npm-token"],
    // **窓口ではなく、引いた金庫を直接**。しかも**窓口が返した名前と置き場**で
    // ——AI が書いた修飾名をそのまま渡すと、backend にその名前は無い
    ["resolve:vault-infisical", "npm-token@team"],
  ]);
});

test("在りかが分からない alias は、既定の金庫へ落とさず止まる", async () => {
  const relayClient = {
    lookupAlias: async () => {
      throw new Error('alias "unknown" はどの Vault にもありません');
    },
    resolveAlias: async () => assert.fail("在りかが分からないのに金庫を呼んだ"),
    startSshAgent: async () => ({ socketPath: "" }),
  } as unknown as import("./host-relay-client.js").HostRelayClient;

  const dir = await mkdtemp(join(tmpdir(), "shell-lookup-miss-"));
  await assert.rejects(
    () => runCommand({ command: "true", envSecrets: { TOKEN: "unknown" } }, { projectRoot: dir, relayClient }),
    /どの Vault にもありません/,
  );
});

test("同じ alias を2箇所で使っても、在りかは1度しか引かない", async () => {
  let lookups = 0;
  const relayClient = {
    lookupAlias: async () => {
      lookups += 1;
      return { implementation: "vault", name: "same", group: "instance" };
    },
    resolveAlias: async () => "same",
    startSshAgent: async () => ({ socketPath: "" }),
  } as unknown as import("./host-relay-client.js").HostRelayClient;

  const dir = await mkdtemp(join(tmpdir(), "shell-lookup-once-"));
  await runCommand(
    { command: "true", envSecrets: { A: "dup" }, secretFiles: { "f.txt": "dup" } },
    { projectRoot: dir, relayClient },
  );
  assert.equal(lookups, 1);
});

// **Shell 専用のホーム**（決定・2026-09-23、ユーザー）。人のホームは閉じ込めで読めない
// ——継いだままだと git も npm も落ちるので、host が用意したホームを渡す。
test("Shell のホームを渡すと、HOME と XDG の置き場がその中を指す", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const home = join(dir, ".shell-home");
    const result = await runCommand(
      { command: 'echo "$HOME|$XDG_CONFIG_HOME|$XDG_CACHE_HOME" && touch "$HOME/written"' },
      { projectRoot: dir, homeDir: home, relayClient: unusedRelayClient() },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${home}|${home}/.config|${home}/.cache`);
    // npm が起動元として足した、人のホームを指す設定は落ちる（HOME を替えても npm がそちらを見るため）
    const prev = { cache: process.env.npm_config_cache, registry: process.env.npm_config_registry };
    process.env.npm_config_cache = `${process.env.HOME}/.npm`;
    process.env.npm_config_registry = "https://registry.example";
    try {
      const npm = await runCommand(
        { command: 'echo "cache=${npm_config_cache:-none}|registry=${npm_config_registry:-none}"' },
        { projectRoot: dir, homeDir: home, relayClient: unusedRelayClient() },
      );
      assert.equal(npm.stdout.trim(), "cache=none|registry=https://registry.example");
    } finally {
      if (prev.cache === undefined) delete process.env.npm_config_cache;
      else process.env.npm_config_cache = prev.cache;
      if (prev.registry === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = prev.registry;
    }
    assert.ok(existsSync(join(home, "written")), "ホームに書けない（用意されていない）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// **閉じ込めで弾かれたら、そう言う**（追加・2026-09-23）。「自分の端末では動くのに」の理由を
// 人にも AI にも見せる——Project とホームの中の失敗は閉じ込めのせいではないので言わない
test("閉じ込めの外のパスで Permission denied になったら、理由を添える", async () => {
  const { confinementNoteFor } = await import("./run-command.js");
  const note = confinementNoteFor(
    [
      "warning: unable to access '/home/u/.gitconfig': Permission denied",
      "cat: /proj/secret: Permission denied",
      "cat: /home/shell/x: Permission denied",
      "fatal: cannot exec 'remote-https': Permission denied",
    ].join("\n"),
    { projectRoot: "/proj", homeDir: "/home/shell" },
  );
  assert.match(note ?? "", /閉じ込めの外にあるため触れませんでした：\/home\/u\/\.gitconfig。/);
  assert.match(note ?? "", /「Shell のホーム」/);
  assert.equal(confinementNoteFor("ls: /nope: No such file or directory", { projectRoot: "/proj" }), undefined);
});

// **コンテナの中では、ホストのものは「無い」**（追加・2026-09-25）。人のホームを指して無かったら、そう言う
test("コンテナの中で、人のホームを指して No such file になったら、コンテナの中に無いと添える", async () => {
  const { confinementNoteFor } = await import("./run-command.js");
  const allowed = { projectRoot: "/home/u/proj", homeDir: "/home/u/.local/share/banto/modules/shell-p/home", inContainer: true };
  const note = confinementNoteFor(
    [
      "cat: /home/u/.gitconfig: No such file or directory",
      "cat: /home/u/proj/missing.txt: No such file or directory",
      "sh: 1: /usr/bin/nosuch: not found",
      "ls: cannot access '/opt/tool': No such file or directory",
    ].join("\n"),
    allowed,
  );
  assert.match(note ?? "", /Project のコンテナの中にありません：\/home\/u\/\.gitconfig。/);
  assert.match(note ?? "", /人のホーム（ホスト）のものは見えません/);
  // Project の中の打ち間違い・コンテナの中の道具には添えない
  assert.doesNotMatch(note ?? "", /missing\.txt|\/opt\/tool/);
  // コンテナでは Permission denied は閉じ込めのせいではない（中のファイルの権限）
  assert.equal(confinementNoteFor("cat: /home/u/x: Permission denied", allowed), undefined);
});
