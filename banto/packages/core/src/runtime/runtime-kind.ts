// **Project の実行場所の種類と、種類で答えが分かれる問い**（2026-10-17、v4-security.md §1「SSH の接続は Project ごとに1本」）。
//
// 前は「別のサーバの Project か」の2択（`isRemoteProject`）を、問いの違う場所（根はこの機械のパスか・この機械のコンテナが
// あるか・眠らせる／閉じるときに Service を止めるか）がそれぞれ使っていた。別のサーバの中のコンテナ（`containers`）を足すと
// 問いごとに答えが分かれる（根は向こう・コンテナはあるが向こう・眠らせるならコンテナを止める）ので、問いごとに関数にし、
// 種類ごとの答えを `switch` で書く。**種類を足したら、ここの `switch` が型で落ちる**——足し忘れた問いが残らない。

import { HOST_CONTAINER_RUNTIME } from "./remote-store.js";

/** 実行場所の種類：この機械のコンテナ／別のサーバ（向こうのユーザーで直に動かす——`machine`） */
export type RuntimeKind = "host-container" | "remote-machine";

/**
 * Project の記録の `runtime` から種類を引く。無ければこの機械のコンテナ。`remote:<名前>` は別のサーバ——ほかの値も前の
 * 2択と同じく別のサーバとして扱う（この機械の根として正規化しない・この機械のコンテナを探さない）
 */
export function runtimeKindOf(runtime: string | undefined): RuntimeKind {
  return runtime === undefined || runtime === HOST_CONTAINER_RUNTIME ? "host-container" : "remote-machine";
}

/** 根がこの機械のパスか（正規化・重なりの確かめをこの機械で行うか。Runner の作業ディレクトリが根か） */
export function rootIsOnThisMachine(runtime: string | undefined): boolean {
  const kind = runtimeKindOf(runtime);
  switch (kind) {
    case "host-container":
      return true;
    case "remote-machine":
      return false;
    default:
      return unreachableKind(kind);
  }
}

/** この機械の Incus のコンテナで動くか（コンテナの状態・上限・中で引くこと・止めること） */
export function usesHostContainer(runtime: string | undefined): boolean {
  const kind = runtimeKindOf(runtime);
  switch (kind) {
    case "host-container":
      return true;
    case "remote-machine":
      return false;
    default:
      return unreachableKind(kind);
  }
}

/**
 * 眠らせるとき、Service の Module が待たれていなければ、**コンテナを止めるかに依らず** Service を止めて自動起動から外すか。
 * 別のサーバ（`machine`）は止める箱が無く、向こうの起こし直しで勝手に起きる。この機械はコンテナごと止めれば中の Service も
 * 止まる（コンテナを残すときだけ止める——呼び元が見る）
 */
export function suspendsServicesToSleep(runtime: string | undefined): boolean {
  const kind = runtimeKindOf(runtime);
  switch (kind) {
    case "host-container":
      return false;
    case "remote-machine":
      return true;
    default:
      return unreachableKind(kind);
  }
}

/**
 * 閉じるとき、Service を止めて自動起動から外してから閉じるか。別のサーバ（`machine`）は閉じたら実行場所が空いて別の Project が
 * 来る——enable のままだと向こうの起こし直しで起きてぶつかる。この機械のコンテナは Project ごとなので空かない
 */
export function suspendsServicesToClose(runtime: string | undefined): boolean {
  const kind = runtimeKindOf(runtime);
  switch (kind) {
    case "host-container":
      return false;
    case "remote-machine":
      return true;
    default:
      return unreachableKind(kind);
  }
}

function unreachableKind(kind: never): never {
  throw new Error(`実行場所の種類 ${String(kind)} の扱いがありません`);
}
