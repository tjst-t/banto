// (3) banto（host）を落として上げ直したあとに答えられるか——受信箱の本当の要件。
// Runner プロセス（この node プロセス自体、内部で CLI subprocess を spawn している）を
// SIGKILL で強制終了し、Module 側の elicitInput 呼び出しがどうなるかを見る。
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');
writeFileSync(path.join(here, 'module.observed.log'), '');

const q = query({
  prompt: 'poc-elicit-module の ask_name tool を1回呼んで、結果をそのまま報告して。',
  options: {
    maxTurns: 3,
    settingSources: [],
    allowedTools: ['mcp__poc__ask_name'],
    // Module 側にはタイムアウトを指定しない = 既定60秒。永久 pending の onElicitation を渡す。
    mcpServers: { poc: { type: 'stdio', command: 'node', args: [modulePath] } },
    onElicitation: async () => {
      console.log('[sdk] onElicitation 受信。応答しない（人が答える前に host を落とす、を模す）');
      return new Promise(() => {});
    },
  },
});

// elicitInput:start がログに出るまで待つ（Module 側がリクエストを受理した瞬間）
async function waitForStart() {
  const { readFileSync, existsSync } = await import('node:fs');
  const logPath = path.join(here, 'module.observed.log');
  for (let i = 0; i < 100; i++) {
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, 'utf8');
      if (content.includes('elicitInput:start')) return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// query() を裏で回しつつ、start を待つ
const iterPromise = (async () => {
  try {
    for await (const _m of q) { /* 何もしない。for-await を回すことで内部処理を進める */ }
  } catch (err) {
    console.log('[sdk] iteration 側で例外:', err?.message);
  }
})();

const started = await waitForStart();
console.log('elicitInput:start を観測:', started);

// ここで「host（Runner）を落とす」ことを模す。query() の返すオブジェクトは
// AsyncGenerator ＋ Query インタフェースの両方を持つ。`kill` は SpawnedProcess の
// メンバーで Query には無い（sdk.d.ts で確認しなおした）——Query 側にあるのは close()。
console.log('typeof q.close:', typeof q.close);
if (typeof q.close === 'function') {
  console.log('[sdk] q.close() を呼ぶ');
  q.close();
}

await new Promise((r) => setTimeout(r, 2000));
console.log('--- module.observed.log（host 側 kill 後）---');
const { readFileSync } = await import('node:fs');
console.log(readFileSync(path.join(here, 'module.observed.log'), 'utf8'));

process.exit(0);
