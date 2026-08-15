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
  /**
   * **この道具を呼んだ会話**（PO裁定 2026-08-15）。
   *
   * 「これから再起動します」は知らせではなく、**番頭が自分で叩いた道具の続き**である。
   * だから幹に固定するのも（枝から再起動したときに幹が鳴る）、用件の枝を立てるのも
   * （呼んだ本人が続きを読めず、その枝は直後にプロセスが落ちて宙に浮く）間違いで、
   * 呼んだ会話へそのまま返すのが筋——幹から呼べば幹、枝から呼べばその枝。
   *
   * 取れないときだけ、宛先の無い知らせと同じ扱いに落ちる（I2: 幹へ固定しない）。
   */
  threadId?: string;
  /** 全クライアントへ「これから再起動する」と知らせる。 */
  notify(text: string, target: { threadId?: string }): Promise<void>;
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
       *
       * **この知らせは会話の記録に残らない**（imp-0061 で実測。thread-105 が 14:52:21 に
       * 撃った再起動でも、`これから再起動します` の行は記録にも取次にも無い）。猶予が
       * 短いからではなく、**構造的にそうなる**:
       *
       * `notify` → `deliverToThread` はスレッドごとの列（`thread.notices`）へ `.then` を
       * 継ぎ足す形で、記録の行はその継ぎ足しの中で書かれる。この道具を呼んでいるターン
       * 自体がその列の1件なので、**いま走っているターンが終わるまで記録の行は書けない**
       * ——猶予（graceMs）を伸ばしても、終わるまで待つことになり、終われば今度は
       * 「再起動の直前に新しいターンを1本回す」になる。どちらも要らない。
       *
       * **触らない**。呼んだ会話には道具の戻り値（`再起動します。…`）が同じ内容で記録
       * されており、番頭にも画面にも同じことが出ている。この `notify` が効くのは
       * **呼んだ会話以外を見ているクライアント**だけで、それは全クライアントへ配る別の口
       * で解くべき話——この直し（回収の入口を塞ぐ）の範囲を超える（P1）。
       */
      void deps
        .notify(
          "これから再起動します。会話は保存済みで、再起動後に続きから話せます。",
          // 呼んだ会話へ返す（上の `threadId` の注記）。取れなければ宛先なしのまま
          deps.threadId !== undefined ? { threadId: deps.threadId } : {}
        )
        .catch((err: unknown) => {
          console.error(`[banto] 再起動の知らせを配れませんでした: ${String(err)}`);
        });
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
