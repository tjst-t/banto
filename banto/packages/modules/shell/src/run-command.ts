// docs/specs/v4-modules.md §2.3 Shell の実装。alias方式（アーキ仕様§2.5）——
// 値はcommand文字列にもargvにも書かず、子プロセスのenvテーブルに直接注入する。

import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AliasPlace, HostRelayClient } from "./host-relay-client.js";

export interface RunCommandInput {
  command: string;
  cwd?: string;
  timeout?: number;
  envSecrets?: Record<string, string>;
  secretFiles?: Record<string, string>;
  sshIdentity?: string;
  signal?: AbortSignal;
}

export interface RunCommandDeps {
  projectRoot: string;
  /**
   * **コマンドに渡すホーム**（決定・2026-09-23、ユーザー）。host が Project ごとに用意し、
   * 人が選んだ設定（既定は git の設定）だけを写してある。人のホームは閉じ込めで読めない
   * ——継いだままだと git も npm も致命的に落ちる（`packages/core/src/modules/shell-home.ts`）。
   * 渡されなければ、親の HOME のまま。
   */
  homeDir?: string;
  /**
   * **Project のコンテナの中で動いているか**（決定・2026-09-25、`docs/specs/v4-security.md` §1。host が
   * `BANTO_IN_CONTAINER=1` で知らせる）。コンテナではホストのものは弾かれるのではなく**そもそも無い**ので、
   * 閉じ込めの説明の拾い方と言い方が変わる
   */
  inContainer?: boolean;
  relayClient: HostRelayClient;
  /** 名前から在りかを引く窓口（既定 `vault-directory`）。**試験で差し替えるための穴**。 */
  directoryModuleName?: string;
  onProgress?(note: string): void;
  /** 進捗を送る間隔（既定 10 秒）。**試験で短くするための穴**——本番では既定のまま。 */
  progressIntervalMs?: number;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /**
   * **閉じ込めで弾かれたらしいときの説明**（追加・2026-09-23）。人も AI も、
   * 「自分の端末では動くのに」の理由がこれで分かる。弾かれた気配が無ければ持たない。
   */
  confinementNote?: string;
}

/**
 * `Permission denied` などの行から、閉じ込めの外を指すパスを拾う。
 *
 * **コンテナの中では**（`inContainer`）、ホストのものは弾かれるのではなく**そもそも無い**——`No such file or
 * directory` の行から、`/home/` の下で Project とホームの外を指すパスを拾う（人のホームのものを指したらしいとき）。
 * コンテナの中の道具の打ち間違い（`/usr/...` 等）には添えない
 */
export function confinementNoteFor(
  stderr: string,
  allowed: { projectRoot: string; homeDir?: string; inContainer?: boolean },
): string | undefined {
  const blocked = new Set<string>();
  const failure = allowed.inContainer ? /No such file or directory|ENOENT/ : /Permission denied|EACCES|Operation not permitted/;
  for (const line of stderr.split("\n")) {
    if (!failure.test(line)) continue;
    for (const m of line.matchAll(/(\/[^\s'"`:,)]+)/g)) {
      const path = m[1]!;
      const within = (root?: string) => root !== undefined && (path === root || path.startsWith(`${root}/`));
      if (within(allowed.projectRoot) || within(allowed.homeDir) || path.startsWith("/dev/")) continue;
      if (allowed.inContainer && !path.startsWith("/home/")) continue;
      blocked.add(path);
    }
  }
  if (blocked.size === 0) return undefined;
  const paths = [...blocked].slice(0, 5).join("、");
  const how =
    "人のホームの設定を使いたいときは、人が 設定 →「Shell のホーム」で写すものに足せます。" +
    "資格情報は写さず、Vault から渡します（envSecrets・sshIdentity）。";
  return allowed.inContainer
    ? `Project のコンテナの中にありません：${paths}。banto の Shell は Project ごとのコンテナの中で動きます。` +
        "見えるのはこの Project のフォルダ・Shell 専用のホーム・コンテナに入れた道具だけで、人のホーム（ホスト）のものは見えません。" +
        how
    : `閉じ込めの外にあるため触れませんでした：${paths}。banto の Shell が触れるのは、この Project のフォルダと Shell 専用のホームの中だけです。` +
        how;
}

const DEFAULT_TIMEOUT_SEC = 120;

/**
 * 実行中に進捗を送る間隔（docs/specs/v4-modules.md §2.3）。
 *
 * **MCP の呼び出しは既定60秒で切れる**（呼び出し元が待つ側の上限）。`npm install`
 * のように60秒を超えるコマンドは普通にあるので、実行中に `notifications/progress`
 * を定期送出して、呼び出し元のタイムアウトを更新させる——**新しい機構ではなく、
 * MCP が既に持つ仕組みの使い先**（規則12）。10秒は「60秒より十分短く、
 * 通知が煩くならない」ところ。
 */
const PROGRESS_INTERVAL_MS = 10_000;

// hostがModuleに渡す変数の接頭辞。BANTO_HOST_MCP_TOKENは「どのModuleからの
// 呼び出しか」の識別そのものなので（アーキ仕様§2.5「プロセスごとに発行」＝
// プロセスが身元）、AIの書いたコマンドを走らせる子プロセスはこの身元ではない
// ——渡さない（決定・2026-09-10、docs/specs/v4-security.md「中継が縛らないもの」）。
const HOST_ENV_PREFIX = "BANTO_";

/** 親（Moduleプロセス）のenvから、hostが渡した`BANTO_*`を落とした写しを作る。 */
export function buildChildEnv(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (name.startsWith(HOST_ENV_PREFIX)) continue;
    child[name] = value;
  }
  return child;
}

export async function runCommand(input: RunCommandInput, deps: RunCommandDeps): Promise<RunCommandResult> {
  const directoryModule = deps.directoryModuleName ?? "vault-directory";
  const env = buildChildEnv();
  if (deps.homeDir) {
    // XDG の置き場も同じホームの中へ——親が明示していると、そちら（人のホーム）が勝つ
    await mkdir(deps.homeDir, { recursive: true });
    env.HOME = deps.homeDir;
    env.XDG_CONFIG_HOME = `${deps.homeDir}/.config`;
    env.XDG_CACHE_HOME = `${deps.homeDir}/.cache`;
    env.XDG_DATA_HOME = `${deps.homeDir}/.local/share`;
    env.XDG_STATE_HOME = `${deps.homeDir}/.local/state`;
    // **npm が起動元として足した設定も、人のホームを指したまま残る**（実測・2026-09-23）。
    // host が `npm`/`npx` の下から起こされると `npm_config_cache=~/.npm`・
    // `npm_config_userconfig=~/.npmrc` を継ぎ、HOME を替えても npm はそちらを見る
    // ——閉じ込めの中では読めない。人のホームを指すものだけ落とす
    const parentHome = process.env.HOME;
    if (parentHome) {
      for (const name of Object.keys(env)) {
        if (/^npm_config_/i.test(name) && env[name]?.startsWith(`${parentHome}/`)) delete env[name];
      }
    }
  }

  // **どの Vault にあるかは、名前から引く**（改訂・2026-09-12）。以前は
  // `"vault"` を決め打ちしていたので、2本目の backend（`vault-infisical`）に
  // 預けた秘密には**構造的に届かなかった**。窓口に聞いてから、その backend を
  // 直接呼ぶ——**値は窓口を通らない**（アーキ仕様 §2.5）。
  //
  // 1回の runCommand の中では同じ名前を2度引かない（`envSecrets` と
  // `secretFiles` に同じ alias が出ることがある）。**跨いでは持たない**
  // ——別のホストが預け先を変えたとき、古い在りかを見せることになる（規則3）。
  //
  // **引くのは「在りか」＝(Vault, グループ, 名前) の三つ組**（訂正・2026-09-15）。
  // 以前は実装名だけを覚えて、`resolveAlias` には AI が書いた文字列を渡していた
  // ——**修飾名（`vault-infisical:npm-token`）では backend にその名前が無い**ので、
  // 一覧に出た名前をそのまま書いても使えなかった
  const whereCache = new Map<string, Promise<AliasPlace>>();
  const vaultOf = (alias: string, note: (n: string) => string): Promise<AliasPlace> => {
    let found = whereCache.get(alias);
    if (!found) {
      found = deps.relayClient.lookupAlias(directoryModule, alias, (n) => deps.onProgress?.(note(n)));
      whereCache.set(alias, found);
    }
    return found;
  };
  const writtenSecretFiles: string[] = [];

  // 落とした名前をenvSecretsで復活させられては同じこと。黙って無視すると
  // 「指定したのに入っていない」が見えない失敗になるので、ここで止める（規則2）。
  for (const envName of Object.keys(input.envSecrets ?? {})) {
    if (envName.startsWith(HOST_ENV_PREFIX)) {
      throw new Error(`envSecretsに${HOST_ENV_PREFIX}で始まる名前は使えません: ${envName}`);
    }
  }

  try {
    for (const [envName, alias] of Object.entries(input.envSecrets ?? {})) {
      // 中継の初回は host が人に承認を聞く——待っている間の合図をそのまま
      // 上（AI のターン）へ流し、外側の tool 呼び出しが先に切れないようにする
      const place = await vaultOf(alias, (n) => `envSecrets: ${envName}——${n}`);
      env[envName] = await deps.relayClient.resolveAlias(place, (note) =>
        deps.onProgress?.(`envSecrets: ${envName}——${note}`),
      );
      deps.onProgress?.(`envSecrets: ${envName} を解決しました`);
    }

    if (input.sshIdentity) {
      const place = await vaultOf(input.sshIdentity, (n) => `sshIdentity——${n}`);
      const { socketPath } = await deps.relayClient.startSshAgent(place, (note) =>
        deps.onProgress?.(`sshIdentity——${note}`),
      );
      env.SSH_AUTH_SOCK = socketPath;
      deps.onProgress?.(`sshIdentity: ${input.sshIdentity} をssh-agentに読み込みました`);
    }

    for (const [relPath, alias] of Object.entries(input.secretFiles ?? {})) {
      const place = await vaultOf(alias, (n) => `secretFiles: ${relPath}——${n}`);
      const value = await deps.relayClient.resolveAlias(place, (note) =>
        deps.onProgress?.(`secretFiles: ${relPath}——${note}`),
      );
      const absPath = resolve(deps.projectRoot, relPath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, value, { mode: 0o600 });
      writtenSecretFiles.push(absPath);
      deps.onProgress?.(`secretFiles: ${relPath} を書き出しました`);
    }

    const cwd = input.cwd ? resolve(deps.projectRoot, input.cwd) : deps.projectRoot;
    const timeoutMs = (input.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000;

    return await new Promise<RunCommandResult>((resolvePromise, reject) => {
      const child = spawn("/bin/sh", ["-c", input.command], {
        cwd,
        env,
        timeout: timeoutMs,
        killSignal: "SIGTERM",
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      // 走っている間、呼び出し元のタイムアウトを更新し続ける（上記）。
      // 経過と出力量も一緒に伝える——人が見たときに「止まっている」と
      // 「時間が掛かっている」を区別できる
      const startedAt = Date.now();
      const heartbeat = setInterval(() => {
        const sec = Math.round((Date.now() - startedAt) / 1000);
        deps.onProgress?.(`実行中（${sec}秒経過、出力 ${stdout.length + stderr.length} 文字）`);
      }, deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
      // このタイマーだけで Node を生かし続けない
      heartbeat.unref();

      const onAbort = () => {
        child.kill("SIGTERM");
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });

      const settle = (fn: () => void) => {
        clearInterval(heartbeat);
        input.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      child.on("error", (err) => {
        settle(() => reject(err));
      });
      child.on("exit", (code, signal) => {
        if (signal === "SIGTERM" && code === null) timedOut = true;
        const confinementNote =
          code === 0
            ? undefined
            : confinementNoteFor(stderr, { projectRoot: deps.projectRoot, homeDir: deps.homeDir, inContainer: deps.inContainer });
        settle(() =>
          resolvePromise({ stdout, stderr, exitCode: code, timedOut, ...(confinementNote ? { confinementNote } : {}) }),
        );
      });
    });
  } finally {
    // 中断・タイムアウト・正常終了いずれでも、secretFilesは必ず削除する
    // （規則2、決定・2026-09-02「既知の限界として受け入れる」節のTODO対応の一部）。
    for (const path of writtenSecretFiles) {
      await unlink(path).catch(() => undefined);
    }
  }
}
