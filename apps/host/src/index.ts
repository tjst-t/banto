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
import { writeFile } from 'node:fs/promises';

import path from 'node:path';

import { EventLog, fold, pendingQueue, type NewEvent } from '@banto/core';
import { AgentImplementer, Factory } from '@banto/factory';
import { fsModule } from '@banto/module-fs';
import { ProcessEnvironmentCore } from '@banto/module-env-process';
import { RepoCore } from '@banto/module-repo';
import { AgentSdkRunner } from '@banto/runner';

import { startServer } from './server.js';

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
 * Factory を1つ組み立てる（要件 B1）。
 *
 * **役割の割り当てをここで書く**（決定16）。いまは `environment` に
 * `env-process` を、実装者にサブエージェントを結ぶ。docker に替えるときに
 * 変わるのはこの数行だけで、Factory 側は1文字も変わらない。
 */
function buildFactory(dataDir: string, repoRoot: string, model: string): Factory {
  const log = new EventLog(dataDir);
  const repo = new RepoCore(repoRoot);
  // 環境の根はリポジトリの根。作業ツリーはその内側にできる。
  const env = new ProcessEnvironmentCore(repoRoot);

  return new Factory({
    log,
    repo,
    environment: {
      create: (workdir) => env.create(workdir),
      status: (handle) => env.status(handle),
      exec: (handle, command, args) => env.exec(handle, command, args),
      destroy: (handle) => env.destroy(handle),
    },
    implementer: new AgentImplementer({
      log,
      modules: [],
      toolsByModule: new Map(),
      model,
      absoluteWorkdir: (workdir) => path.resolve(repoRoot, workdir),
      // **何を許したかを1行で残す**（要件 D4）。既定では1つも通らない。
      extraAllowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    }),
    // テストの走らせ方はリポジトリが決める（仕様 §6）。いまは1つ固定で、
    // リポジトリ側の宣言から読むのは docker provider と同じ回で入れる。
    test: { command: 'sh', args: ['-c', 'npm test --silent'] },
  });
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
      const factory = repoRoot === '' ? undefined : buildFactory(dataDir, repoRoot, model);
      // Phase 1.5 では fs だけを繋ぐ。shell / repo は subprocess なので、
      // 台帳から解決する経路を通してから足す（要件 C11）。
      startServer({
        dataDir,
        port,
        modules: [{ name: fsModule.manifest.id, kind: 'in-process', server: fsModule.createServer() }],
        toolsByModule: new Map([['fs', ['read', 'write', 'list']]]),
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
