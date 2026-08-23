/**
 * Banto Core。
 *
 *  1. Channel / Thread を作る
 *  2. Runner を回して、出てきたイベントをログに積む
 *  3. 判断待ちを1本の列として出す
 *  4. 画面のために口を開ける（`serve`。中身は server.ts）
 *
 * **観測はここに置かない。** 観測を機構の中に置くと、機構が止まったとき
 * 観測も一緒に止まる（ADR-0001 決定8）。観測は @banto/observer に、別プロセスとして居る。
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import path from 'node:path';

import { EventLog, fold, foldApprovals, ledgerOf, pendingQueue, type NewEvent } from '@banto/core';
import {
  Factory,
  environmentPortOver,
  publishPortOver,
  repoPortOver,
  workerImplementerOver,
} from '@banto/factory';
import {
  assertStartable,
  connectInProcess,
  requiredRoot,
  resolve,
  resolveInside,
  type BantoModule,
  type ModuleSource,
  type ToolCaller,
} from '@banto/module-kit';
import { fsModule, manifest as fsManifest } from '@banto/module-fs';
import { envProcessModule } from '@banto/module-env-process';
import { envDockerModule } from '@banto/module-env-docker';
import { envScriptModule } from '@banto/module-env-script';
import { publishNoneModule } from '@banto/module-publish-none';
import { repoModule, manifest as repoManifest } from '@banto/module-repo';
import { workerModule } from '@banto/module-worker';
import { AgentSdkRunner } from '@banto/runner';

import { startServer, type FactoryPool } from './server.js';

interface RunArgs {
  dataDir: string;
  channelName: string;
  threadTitle: string;
  model: string;
  prompt: string;
  maxTurns: number;
  cwd: string;
}

async function runTurn(args: RunArgs): Promise<void> {
  const log = new EventLog(args.dataDir);
  const state = fold(await log.read());

  // Channel は名前で引き当てる。無ければ作る。
  let channelId = [...state.channels.values()].find((c) => c.name === args.channelName)?.id;
  if (channelId === undefined) {
    channelId = randomUUID();
    await log.append({ type: 'channel.created', channelId, channelName: args.channelName });
  }

  const threadId = randomUUID();
  const queryId = randomUUID();
  await log.append({ type: 'thread.created', threadId, channelId, title: args.threadTitle });
  await log.append({ type: 'thread.status', threadId, status: 'working' });

  const runner = new AgentSdkRunner();
  let turns = 0;
  let failed = false;

  try {
    for await (const event of runner.query({
      threadId,
      queryId,
      systemPrompt: 'You are helping measure context growth. Answer briefly.',
      mcpServers: [],
      skills: [],
      model: args.model,
      prompt: args.prompt,
      cwd: args.cwd,
      maxTurns: args.maxTurns,
    })) {
      await log.append(event as NewEvent);
      if (event.type === 'turn.usage') turns += 1;
      if (event.type === 'query.step' && event.status === 'failed') failed = true;
    }
  } catch (cause) {
    // 黙って別の経路へ落ちない（規則2）。状態を記録してから落ちる。
    await log.append({ type: 'thread.status', threadId, status: 'blocked' });
    throw cause;
  }

  await log.append({
    type: 'thread.status',
    threadId,
    status: failed ? 'blocked' : 'done',
  });

  process.stdout.write(`thread=${threadId} turns=${turns}${failed ? ' (failed)' : ''}\n`);
}

async function showQueue(dataDir: string): Promise<void> {
  const state = fold(await new EventLog(dataDir).read());
  const queue = pendingQueue(state);

  process.stdout.write('\n  いま自分を待っているもの\n');
  process.stdout.write(`  ${'─'.repeat(72)}\n`);
  if (queue.length === 0) {
    process.stdout.write('  （なし）\n\n');
    return;
  }

  const now = Date.now();
  for (const decision of queue) {
    const waitedMin = Math.floor((now - Date.parse(decision.since)) / 60_000);
    const where = decision.threadId
      ? (state.threads.get(decision.threadId)?.title ?? decision.threadId)
      : '—';
    process.stdout.write(
      `  [${decision.source.padEnd(8)}] ${decision.question}\n` +
        `             ${where} · ${waitedMin} 分待ち\n`,
    );
  }
  // 5プロジェクト・20会話でも1画面に収まることを、件数で見えるようにする。
  process.stdout.write(
    `  ${'─'.repeat(72)}\n  ${queue.length} 件 / スレッド ${state.threads.size} 本 / プロジェクト ${state.channels.size} 個\n\n`,
  );
}

/**
 * 同じものを1枚の HTML にする。ADR-0001 決定11 の React PWA は Phase 0 では作らない
 * ——完了条件に要るのは「1画面に出る」ことであって、表面の作り込みではない。
 */
async function writeQueueHtml(dataDir: string, out: string): Promise<void> {
  const state = fold(await new EventLog(dataDir).read());
  const queue = pendingQueue(state);
  const now = Date.now();

  const rows = queue
    .map((d) => {
      const waited = Math.floor((now - Date.parse(d.since)) / 60_000);
      const where = d.threadId
        ? (state.threads.get(d.threadId)?.title ?? d.threadId)
        : '—';
      return `<tr><td class="src">${escapeHtml(d.source)}</td><td>${escapeHtml(d.question)}</td><td class="dim">${escapeHtml(where)}</td><td class="dim">${waited} 分</td></tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<meta charset="utf-8"><title>いま自分を待っているもの</title>
<style>
 body{font:15px/1.6 system-ui,sans-serif;margin:2rem auto;max-width:56rem;color:#222}
 h1{font-size:1.1rem;font-weight:600}
 table{border-collapse:collapse;width:100%}
 td{padding:.5rem .6rem;border-bottom:1px solid #eee;vertical-align:top}
 .src{font:12px ui-monospace,monospace;color:#666;white-space:nowrap}
 .dim{color:#888;white-space:nowrap}
 .none{color:#888}
 footer{margin-top:1rem;color:#888;font-size:13px}
 @media(max-width:640px){.dim{display:none}}
</style>
<h1>いま自分を待っているもの</h1>
${queue.length === 0 ? '<p class="none">（なし）</p>' : `<table>${rows}</table>`}
<footer>${queue.length} 件 / スレッド ${state.threads.size} 本 / プロジェクト ${state.channels.size} 個</footer>
`;
  await writeFile(out, html, 'utf8');
  process.stdout.write(`${out}\n`);
}

/**
 * Factory を1つ組み立てる（要件 B1・C13・決定17）。
 *
 * **役割の割り当てをここで書く。** repo も environment も worker も、
 * **他のモジュールと同じ口**を通って呼ばれる——中核とモジュールの違いは、
 * 口ではなく出荷元だけ（要件 C13）。**docker に替えても変わるのは
 * 下の `bindings` の1行だけ**で、Factory 側は1文字も変わらない
 * （それを実物で確かめたのが `packages/factory` の受け入れ試験）。
 *
 * **起動時に台帳で確かめる。** 名乗るだけでは足りないので、`resolve` が
 * 本物の `tools/list` と突き合わせる（要件 C11）。合わなければ**起動しない**。
 */
async function buildFactory(
  dataDir: string,
  repoRoot: string,
  model: string,
  /**
   * どの環境実装を使うか（仕様 §6：**運用者が決める**、リポジトリではない）。
   *
   * **既定は隔離する `env-docker`。** Factory は人が見ていない状態で自律的に
   * コマンドを実行する（決定29の2軸モデル：監督なし×構造で縛る）。`env-process` は
   * ホストと同じ権限で任意コマンドを実行する無隔離の実装なので、既定にしない
   * ——使うなら運用者が明示的に選ぶ（`--env env-process`）。
   *
   * `env-script` は**リポジトリが自前の環境を宣言できる**実装（`.banto/repo.json`）。
   * これも監督なし×banto外に影響しうる操作なので、2つの門を維持する
   * ——①ここで明示的に選んだ`repoRoot`だけが対象になる（リポジトリの中身だけでは
   * 有効化されない）、②スクリプトの中身は承認台帳を通るまで実行されない
   * （`ScriptEnvironmentCore`・`UnapprovedScriptError`）。
   */
  environmentId: 'env-process' | 'env-docker' | 'env-script' = 'env-docker',
  /**
   * 公開手段（仕様 §3）。**渡さなければ公開の枝に入らない**——
   * どこまで届く URL を生やすかは、運用者が1行書いて決めること。
   */
  publishId: 'publish-none' | undefined = undefined,
): Promise<Factory> {
  const log = new EventLog(dataDir);

  const worker = workerModule({
    log,
    model,
    mcpServers: [],
    toolsByModule: new Map(),
    // **何を許したかを1行で残す**（要件 D4）。既定では1つも通らない。
    extraAllowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  });

  /**
   * モジュールの作業範囲は直接渡す（決定29）。**環境変数のグローバル書き込みはしない**
   * ——`buildFactory` は複数リポジトリぶん並行で呼ばれうる（`factoryPool`）。
   * 1つのプロセス内で `process.env` を書き換える方式だと、後から呼んだ
   * `buildFactory` の `repoRoot` が先に呼んだものを上書きしてしまう。
   */
  const environment =
    environmentId === 'env-docker'
      ? envDockerModule(repoRoot)
      : environmentId === 'env-script'
        ? // **許可されるのはこの `repoRoot` だけ**（門①）。承認台帳は畳んで作る——
          // 保存された「承認済み一覧」を持たない（規則3・approval.ts）。
          envScriptModule({ allowedRepos: [repoRoot], ledger: ledgerOf(foldApprovals(await log.read())) })
        : envProcessModule(repoRoot);

  const servers = new Map([
    ['repo', repoModule(repoRoot).createServer()],
    [environmentId, environment.createServer()],
    ['worker', worker.createServer()],
    ...(publishId === undefined
      ? []
      : ([[publishId, publishNoneModule.createServer()]] as [string, ReturnType<typeof publishNoneModule.createServer>][])),
  ]);
  const callers = new Map<string, ToolCaller>();
  for (const [id, server] of servers) callers.set(id, await connectInProcess(server));

  const sources: ModuleSource[] = [
    { manifest: repoManifest, listTools: () => listToolsVia(callers, 'repo') },
    { manifest: environment.manifest, listTools: () => listToolsVia(callers, environmentId) },
    { manifest: worker.manifest, listTools: () => listToolsVia(callers, 'worker') },
    ...(publishId === undefined
      ? []
      : [
          {
            manifest: publishNoneModule.manifest,
            listTools: () => listToolsVia(callers, publishId),
          },
        ]),
    {
      // **Factory は実装の名前を1つも持たない。** 役割で頼むだけ（決定16）。
      manifest: {
        id: 'factory',
        description: '依頼を耐久ワークフローとして進める',
        isolation: 'in-process',
        mcp: { kind: 'in-process' },
        requires: [
          {
            capability: 'repo',
            tools: ['add_worktree', 'has_worktree', 'remove_worktree', 'head_of', 'is_ahead', 'merge', 'rebase_onto'],
          },
          { capability: 'environment', tools: ['create', 'status', 'exec', 'address', 'destroy'] },
          { capability: 'worker', tools: ['work'] },
          // **公開は任意。** 紐づけたときだけ役割として要求する（仕様 §5.2）。
          ...(publishId === undefined
            ? []
            : [{ capability: 'publish', tools: ['publish', 'unpublish'] }]),
        ],
      },
      listTools: async () => ['request', 'advance'],
    },
  ];

  // **候補が1つでも自動で選ばない**（要件 C8c と同じ理由）。ここが「その1行」。
  const bindings = new Map([
    ['repo', 'repo'],
    ['environment', environmentId],
    ['worker', 'worker'],
    ...(publishId === undefined ? [] : [['publish', publishId] as [string, string]]),
  ]);

  // 合わなければ起動しない。**何が足りないかを全部言ってから**止まる（要件 C11）。
  assertStartable(await resolve(sources, bindings));

  const need = (id: string): ToolCaller => {
    const caller = callers.get(id);
    if (!caller) throw new Error(`繋がっていないモジュール: ${id}`);
    return caller;
  };

  return new Factory({
    log,
    repo: repoPortOver(need('repo')),
    environment: environmentPortOver(need(environmentId)),
    implementer: workerImplementerOver(need('worker'), (workdir) =>
      path.resolve(repoRoot, workdir),
    ),
    ...(publishId === undefined ? {} : { publish: publishPortOver(need(publishId)) }),
    // **テストの走らせ方は渡さない。** リポジトリが `.banto/repo.json` で
    // 宣言する（仕様 §6）。ここに既定を置くと、宣言していないリポジトリで
    // 「0件が通った」になる。
  });
}

/**
 * 複数のリポジトリを1つの banto で扱うための組み立て（決定29）。
 *
 * `reposRoot` は広い親（例: `$HOME/projects`）。`repo`（相対パス）ごとに
 * `buildFactory` を1回だけ呼び、以後は使い回す——**作り直さない**のは
 * `RepoCore.addWorktree` と同じ考え（要件 B5）。`repo` を省くと `'.'`
 * ——`reposRoot` 自体が1つのリポジトリである、今までどおりの単一リポジトリ運用。
 *
 * `resolveInside` で境界を確かめる。**広い root の外を指しても広がらない**
 * ——fs の書き込み境界（決定29）と同じ道具を使う。
 */
export function buildFactoryPool(
  dataDir: string,
  reposRoot: string,
  model: string,
  environmentId: 'env-process' | 'env-docker' | 'env-script',
  publishId: 'publish-none' | undefined,
): FactoryPool {
  const built = new Map<string, Promise<Factory>>();
  const factoryFor = (repo: string): Promise<Factory> => {
    const absolute = resolveInside(reposRoot, repo);
    let promise = built.get(absolute);
    if (promise === undefined) {
      promise = buildFactory(dataDir, absolute, model, environmentId, publishId);
      built.set(absolute, promise);
    }
    return promise;
  };
  return { factoryFor, allBuilt: () => Promise.all(built.values()) };
}

/** 台帳の突き合わせも、**繋いだ口から**聞く（自己申告を自己申告で確かめない・規則1）。 */
/**
 * `hello-py` の台帳を読む（要件 C6）。**JSON をそのまま読む**——
 * TypeScript でないモジュールの台帳は、TypeScript の外に在る。
 */
function helloPyManifest(): BantoModule {
  const file = path.resolve('modules/hello-py/manifest.json');
  // 握りつぶさない（規則2）。読めないなら、そう言って止まる。
  return JSON.parse(readFileSync(file, 'utf8')) as BantoModule;
}

async function listToolsVia(callers: Map<string, ToolCaller>, id: string): Promise<string[]> {
  const caller = callers.get(id);
  if (!caller) throw new Error(`繋がっていないモジュール: ${id}`);
  return caller.listTools();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function flag(argv: string[], name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return argv[i + 1] ?? fallback;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const dataDir = flag(argv, 'data', process.env['BANTO_DATA_DIR'] ?? './.banto-data');

  switch (command) {
    case 'run':
      await runTurn({
        dataDir,
        channelName: flag(argv, 'channel', 'banto-v3'),
        threadTitle: flag(argv, 'title', '計測'),
        // 既定を Haiku にしてある。Phase 0 で要るのは usage の数値であって
        // 賢さではない。計測のために枠を使い切らない。
        model: flag(argv, 'model', 'claude-haiku-4-5'),
        prompt: flag(argv, 'prompt', 'Say OK.'),
        maxTurns: Number(flag(argv, 'max-turns', '1')),
        cwd: flag(argv, 'cwd', process.cwd()),
      });
      break;

    case 'serve': {
      const port = Number(flag(argv, 'port', '4300'));
      const repoRoot = flag(argv, 'repo', '');
      const model = flag(argv, 'model', 'claude-haiku-4-5');

      /**
       * Factory は **`--repo` を渡したときだけ**紐づく（要件 B1）。
       * 渡さなければ `/api/runs` は 501 を返す——「在るが何もしない口」を作らない。
       *
       * **既定で紐づけない理由**：Factory はサブエージェントを起動して
       * ファイルを書き換え、git を動かす。どのリポジトリに対してそれを許すかは、
       * 運用者が1行書いて決めることであって、既定で決まっていてよいことではない。
       */
      /**
       * 環境の実装（仕様 §6：**運用者が決める**）。**知らない名前は断る**
       * ——黙って既定へ落ちると、隔離したつもりでしていないことになる（規則2）。
       *
       * **既定は `env-docker`**（決定29）。`env-process` は明示的な選択でのみ使う。
       */
      const environmentId = flag(argv, 'env', 'env-docker');
      if (environmentId !== 'env-process' && environmentId !== 'env-docker' && environmentId !== 'env-script') {
        throw new Error(`知らない環境: ${environmentId}（env-process か env-docker か env-script）`);
      }

      /** 公開手段（仕様 §3）。**知らない名前は断る**——黙って既定へ落ちない。 */
      const publishFlag = flag(argv, 'publish', '');
      if (publishFlag !== '' && publishFlag !== 'publish-none') {
        throw new Error(`知らない公開手段: ${publishFlag}（いまは publish-none だけ）`);
      }
      const publishId = publishFlag === '' ? undefined : 'publish-none';

      /**
       * `--repo` は**広い親**（複数リポジトリの根）にもなれる（決定29）。
       * `/api/runs` が `repo`（相対パス、省くと `'.'`）を指定すると、
       * そのリポジトリ向けの Factory を**要求されて初めて**組み立てる
       * ——先回りして全部には繋がない。単一リポジトリ運用（`repo` を指定しない）は
       * 今までどおり、`reposRoot` 自体が唯一のリポジトリとして動く。
       */
      const factory =
        repoRoot === ''
          ? undefined
          : buildFactoryPool(dataDir, repoRoot, model, environmentId, publishId);
      const fsRoot = requiredRoot('BANTO_FS_ROOT');
      // Phase 1.5 では fs だけを繋ぐ。shell / repo は subprocess なので、
      // 台帳から解決する経路を通してから足す（要件 C11）。
      startServer({
        dataDir,
        port,
        // **インスタンスではなく、作る関数を渡す**（`server.ts` の `ModuleFactory` 参照）。
        // 使い回すと2回目の問い合わせで `fs` の道具が消える（実測 2026-08-22）。
        //
        // `writeRoot` は `server.ts` がスレッドごとに解いて渡す（決定29：読み取りは
        // 広く、書き込みは狭く）。ここでは受け取って `fsModule` に流すだけ——
        // 境界の判定そのものは `FileSystemCore` に1つだけある（規則3）。
        modules: [
          {
            name: fsManifest.id,
            kind: 'in-process',
            createServer: (writeRoot) => fsModule(fsRoot, writeRoot ?? null).createServer(),
          },
        ],
        toolsByModule: new Map([['fs', ['read', 'write', 'list']]]),
        /**
         * 画面の割り当ては台帳から導く（決定20）。別表を持たない（規則3）。
         *
         * **hello-py も載せる。** ツールは繋いでいないが、
         * **subprocess で TypeScript でもないモジュールが `sandboxed` な面を
         * 持ち込めること**が要件 C6 の中身なので、面だけは配る。
         */
        manifests: [fsManifest, helloPyManifest()],
        model,
        host: flag(argv, 'host', '127.0.0.1'),
        ...(factory === undefined ? {} : { factory }),
        ...(flag(argv, 'secret', '') === '' ? {} : { secret: flag(argv, 'secret', '') }),
        ...(flag(argv, 'web', '') === '' ? {} : { webRoot: flag(argv, 'web', '') }),
      });
      process.stdout.write(`http://${flag(argv, 'host', '127.0.0.1')}:${port}\n`);
      if (factory === undefined) {
        process.stdout.write('Factory は紐づいていない（--repo <path> で紐づく）\n');
      }
      break;
    }

    case 'queue': {
      const out = flag(argv, 'html', '');
      if (out === '') await showQueue(dataDir);
      else await writeQueueHtml(dataDir, out);
      break;
    }

    default:
      process.stderr.write(
        'usage:\n' +
          '  host run   --data <dir> [--model m] [--prompt p] [--max-turns n] [--title t]\n' +
          '  host serve  --data <dir> [--port n] [--model m]\n' +
          '  host queue --data <dir> [--html <file>]\n',
      );
      process.exitCode = 2;
  }
}

main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
});
