/**
 * レベル1（PO裁定）: banto ホスト自身の再起動。
 *
 * bin.ts の中に直接書いていたものをここへ出した（imp-0037）。`bin.ts` は CLI の入口で、
 * 読み込むだけで `main()` が走るため**試験から呼べない**——「結果を返してから落ちる」は
 * 機械で確かめられなければ守れないので、依存を引数で受け取る形にして切り出す。
 */

import { Type } from "typebox";
import { defineNamespacedTool } from "@banto/core";

export interface RestartToolDeps {
  /** 全クライアントへ「これから再起動する」と知らせる。 */
  notify(text: string): Promise<void>;
  /** WS/HTTP と全スレッドの後始末。 */
  close(): Promise<void>;
  /** プロセスを終える。systemd（Restart=always）が起動し直す。 */
  exit(code: number): void;
  /** 返事が履歴へ落ちるまでの猶予。 */
  graceMs?: number;
}

export function createRestartTool(deps: RestartToolDeps) {
  const graceMs = deps.graceMs ?? 1000;
  return defineNamespacedTool({
    name: "system.restart",
    label: "System: Restart",
    description:
      "banto ホスト自身を再起動する。全クライアントに通知してから graceful に終了し、" +
      "systemd（Restart=always）が起動し直す。会話は保存済みで、再起動後に続きから話せる。" +
      "稼働中の職人は中断されるが、記録は残り worker.wake で再開できる。" +
      "検証環境は cgroup の巻き添えで落ちるので、事前に env.list で確認すること",
    parameters: Type.Object({}),
    async execute() {
      /**
       * **知らせは配るが、ターンの完走は待たない**（imp-0037 原因1）。
       *
       * ここで `await` すると、この道具を呼んでいる当のターンへ知らせを差し込んだ
       * 往復が終わるまで戻らない——その間にプロセスが死ぬので `tool_end` が書けない。
       * I2: 配れなかったことは握りつぶさずログへ残す。
       */
      void deps.notify("これから再起動します。会話は保存済みで、再起動後に続きから話せます。").catch(
        (err: unknown) => {
          console.error(`[banto] 再起動の知らせを配れませんでした: ${String(err)}`);
        }
      );
      /**
       * **落ちるのはターンの外**（imp-0037 原因1の本体）。
       *
       * 以前は `execute()` の中で `close()` → `process.exit(0)` まで済ませていたので、
       * この道具の `tool_end` が履歴へ書かれる前にプロセスが消えていた。結果、会話には
       * `state:"running"` の `system.restart` が永久に残り、再起動後の番頭は
       * 「結果の返ってこない道具」を抱えたまま黙り続けていた。
       *
       * `unref()` を付けるのは、**この待ちがプロセスを生かす理由にならない**ようにするため
       * ——他に何も残っていないなら、猶予を待たずに終わってよい。
       */
      const timer = setTimeout(() => {
        void (async () => {
          try {
            await deps.close();
          } catch (err) {
            // I2: 閉じられなかったことを黙って exit(0) に混ぜない
            console.error(`[banto] 再起動の後始末で転びました: ${String(err)}`);
          }
          deps.exit(0);
        })();
      }, graceMs);
      timer.unref?.();
      return {
        content: [
          {
            type: "text" as const,
            text: "再起動します。会話は保存済みで、再起動後に続きから話せます。",
          },
        ],
      };
    },
  });
}
