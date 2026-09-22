import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDeclarationFromRegistry, RegistryInstallError } from "./to-declaration.js";
import type { RegistryServer } from "./server-json.js";

const NEVER_INSTALL = async () => {
  throw new Error("取得してはいけない場面で取得しようとした");
};

function remoteServer(headers?: unknown): RegistryServer {
  return {
    name: "com.example/thing",
    description: "",
    version: "1.0.0",
    remotes: [{ type: "streamable-http", url: "https://mcp.example.com/v1", headers: headers as never }],
  };
}

function npmServer(env?: unknown): RegistryServer {
  return {
    name: "io.github.someone/thing",
    description: "",
    version: "1.0.0",
    packages: [
      {
        registryType: "npm",
        identifier: "thing-mcp",
        version: "2.0.0",
        transport: { type: "stdio" },
        environmentVariables: env as never,
      },
    ],
  };
}

const installed = async () => ({ relativeScript: "node_modules/thing-mcp/dist/server.js", version: "2.0.0" });

test("URL に繋ぐものは、プロセスを立てずにそのまま繋ぐ", async () => {
  const built = await buildDeclarationFromRegistry({
    server: remoteServer(),
    name: "thing",
    answers: [],
    packageDir: "/tmp/x",
    installNpm: NEVER_INSTALL as never,
  });
  assert.deepEqual(built.launch, { type: "http", url: "https://mcp.example.com/v1" });
  // **閉じ込めは書かない**——相手のサーバで動いているので掛からない。
  // 掛からないものを付けたふりをしない
  assert.equal((built.meta as { confinement?: unknown }).confinement, undefined);
});

test("秘密は名前だけが宣言に残る——値は起動の直前に Vault から引く", async () => {
  const built = await buildDeclarationFromRegistry({
    server: remoteServer([{ name: "Authorization", isRequired: true, isSecret: true }]),
    name: "thing",
    answers: [{ name: "Authorization", source: "vault", value: "example-token" }],
    packageDir: "/tmp/x",
    installNpm: NEVER_INSTALL as never,
  });
  const launch = built.launch as { headers: Record<string, string> };
  assert.equal(launch.headers.Authorization, "${secret:example-token}");
  // 値そのものが宣言に入っていないこと（記録に残ってしまうので）
  assert.ok(!JSON.stringify(built.launch).includes("sk-"));
});

test("直接入力を選べば、その値がそのまま入る（残ると画面が言っている）", async () => {
  const built = await buildDeclarationFromRegistry({
    server: remoteServer([{ name: "Authorization", isSecret: true }]),
    name: "thing",
    answers: [{ name: "Authorization", source: "plain", value: "Bearer abc" }],
    packageDir: "/tmp/x",
    installNpm: NEVER_INSTALL as never,
  });
  assert.equal((built.launch as { headers: Record<string, string> }).headers.Authorization, "Bearer abc");
});

test("聞かれていない欄は差せない——画面から任意のヘッダを足す道を作らない", async () => {
  const built = await buildDeclarationFromRegistry({
    server: remoteServer([{ name: "Authorization" }]),
    name: "thing",
    answers: [{ name: "X-Sneaky", source: "plain", value: "1" }],
    packageDir: "/tmp/x",
    installNpm: NEVER_INSTALL as never,
  });
  assert.equal((built.launch as { headers?: Record<string, string> }).headers, undefined);
});

test("必須が空なら、取得もせずに断る（空のまま起動しない）", async () => {
  await assert.rejects(
    () =>
      buildDeclarationFromRegistry({
        server: npmServer([{ name: "API_KEY", isRequired: true }]),
        name: "thing",
        answers: [],
        packageDir: "/tmp/x",
        // **取得より先に断る**——差し替えが呼ばれたら落ちる
        installNpm: NEVER_INSTALL as never,
      }),
    (err: Error) => err instanceof RegistryInstallError && /API_KEY/.test(err.message),
  );
});

test("npm のものは、取ってきた先を指して起動する——閉じ込めは必ず付く", async () => {
  const built = await buildDeclarationFromRegistry({
    server: npmServer(),
    name: "thing",
    answers: [],
    packageDir: "/tmp/x",
    installNpm: installed as never,
  });
  assert.deepEqual(built.launch, {
    command: "${nodeExec}",
    args: ["${modulePackageDir}/node_modules/thing-mcp/dist/server.js"],
  });
  // **外から繋ぐコードは必ず閉じ込める**（`cli.ts` がこれを要求する）
  assert.deepEqual((built.meta as { confinement: unknown }).confinement, {
    kind: "landlock",
    root: "none",
  });
  // **役割は名乗らせない**——`server.json` に banto の役割は無いし、
  // 有っても自己申告は信じない（金庫の窓口を名乗る経路を作らない）
  assert.deepEqual((built.meta as { satisfies: string[] }).satisfies, []);
});

test("対応していない配布形式は、理由ごと断る（黙って落とさない）", async () => {
  const server: RegistryServer = {
    name: "io.github.someone/thing",
    description: "",
    version: "1.0.0",
    packages: [{ registryType: "pypi", identifier: "thing", transport: { type: "stdio" } }],
  };
  await assert.rejects(
    () =>
      buildDeclarationFromRegistry({
        server,
        name: "thing",
        answers: [],
        packageDir: "/tmp/x",
        installNpm: NEVER_INSTALL as never,
      }),
    (err: Error) => err instanceof RegistryInstallError && /uvx/.test(err.message),
  );
});

test("繋ぎ方が1つも書かれていないものは断る", async () => {
  await assert.rejects(
    () =>
      buildDeclarationFromRegistry({
        server: { name: "io.github.a/b", description: "", version: "1.0.0" },
        name: "thing",
        answers: [],
        packageDir: "/tmp/x",
        installNpm: NEVER_INSTALL as never,
      }),
    (err: Error) => err instanceof RegistryInstallError,
  );
});

test("人に尋ねる形の起動引数には、まだ対応していないと言う", async () => {
  const server: RegistryServer = {
    name: "io.github.someone/thing",
    description: "",
    version: "1.0.0",
    packages: [
      {
        registryType: "npm",
        identifier: "thing-mcp",
        version: "2.0.0",
        transport: { type: "stdio" },
        // 値も既定も無い＝人に聞く形
        packageArguments: [{ type: "positional", isRequired: true, description: "対象のフォルダ" }],
      },
    ],
  };
  await assert.rejects(
    () =>
      buildDeclarationFromRegistry({
        server,
        name: "thing",
        answers: [],
        packageDir: "/tmp/x",
        installNpm: installed as never,
      }),
    (err: Error) => err instanceof RegistryInstallError && /引数/.test(err.message),
  );
});
