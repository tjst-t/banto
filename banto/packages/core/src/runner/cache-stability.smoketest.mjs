// 実際にAnthropic APIを叩く手動確認スクリプト（自動テストには含めない——課金される）。
// Phase 1完了条件「ツールを足してもキャッシュが落ちない（数値で確認）」の実測。
//
// 同じsessionを2ターン走らせる。1ターン目はvaultだけ、2ターン目（resume）で
// shell・filesystemを足す——「途中でtoolが増える」実際のシナリオを再現し、
// 2ターン目のcache_read_input_tokensが1ターン目のプレフィックスを再利用できて
// いる（0近くまで落ちていない）ことを見る。
//
// 前提：banto hostが起動していて、指定projectIdでshell/filesystemが
// spawn済みであること（先に1回ダミーのターンを実行しておく）。
import { runTurn } from "../../dist/runner/adapter.js";

const port = process.env.BANTO_PORT ?? "4913";
const authToken = process.env.BANTO_TOKEN;
const projectId = process.argv[2];
if (!projectId || !authToken) {
  console.error("usage: BANTO_TOKEN=<token> node cache-stability.smoketest.mjs <projectId>");
  process.exit(1);
}

const headers = { authorization: `Bearer ${authToken}` };
const vaultUrl = `http://127.0.0.1:${port}/agent-relay/vault`;
const shellUrl = `http://127.0.0.1:${port}/agent-relay/shell-${projectId}`;
const fsUrl = `http://127.0.0.1:${port}/agent-relay/filesystem-${projectId}`;

function usageOf(messages) {
  const result = messages.find((m) => m.type === "result");
  return result?.usage;
}

console.log("[turn1] vault only, fresh session");
const turn1 = await runTurn({
  prompt: "Reply with exactly: turn1-done",
  mcpServers: { vault: { type: "http", url: vaultUrl, headers } },
  permissionMode: "bypassPermissions",
});
const usage1 = usageOf(turn1.messages);
console.log("[turn1] usage:", JSON.stringify(usage1));

console.log("[turn2] vault + shell + filesystem (tool added), resume turn1 session");
const turn2 = await runTurn({
  resumeSessionId: turn1.sessionId,
  prompt: "Reply with exactly: turn2-done",
  mcpServers: {
    vault: { type: "http", url: vaultUrl, headers },
    shell: { type: "http", url: shellUrl, headers },
    filesystem: { type: "http", url: fsUrl, headers },
  },
  permissionMode: "bypassPermissions",
});
const usage2 = usageOf(turn2.messages);
console.log("[turn2] usage:", JSON.stringify(usage2));

const cacheRead2 = usage2?.cache_read_input_tokens ?? 0;
const cacheCreation1 = (usage1?.cache_creation_input_tokens ?? 0) + (usage1?.cache_read_input_tokens ?? 0);

console.log(`\nturn1 total cached prefix (creation+read): ${cacheCreation1}`);
console.log(`turn2 cache_read_input_tokens: ${cacheRead2}`);

// ツールを足しても、turn1で作ったキャッシュのうち相当量がturn2でも
// cache_read（再利用）として計上されていれば「落ちていない」と判定する。
// 全部作り直し（cache_readがほぼ0でcache_creationだけ大きい）なら壊れている。
const ratio = cacheCreation1 > 0 ? cacheRead2 / cacheCreation1 : 0;
console.log(`ratio (turn2 cache_read / turn1 cached prefix): ${ratio.toFixed(3)}`);

if (ratio < 0.5) {
  console.error("RESULT: FAIL — tool追加でキャッシュの大半が作り直しになっている");
  process.exit(1);
}
console.log("RESULT: OK — tool追加後もturn1のキャッシュの大半が再利用されている");
