// **Project の実行場所の種類と、種類で答えが分かれる問い**（2026-10-17、v4-security.md §1「SSH の接続は Project ごとに1本」）。
//
// 前は「別のサーバの Project か」の2択（`isRemoteProject`）を、問いの違う場所（根はこの機械のパスか・この機械のコンテナが
// あるか・眠らせる／閉じるときに Service を止めるか）がそれぞれ使っていた。別のサーバの中のコンテナ（`containers`）を足すと
// 問いごとに答えが分かれる（根は向こう・コンテナはあるが向こう・眠らせるならコンテナを止める）ので、問いごとに関数にし、
// 種類ごとの答えを `switch` で書く。**種類を足したら、ここの `switch` が型で落ちる**——足し忘れた問いが残らない。
//
// 別のサーバの動かし方（`machine`／`containers`）は Project の記録には無く、実行場所の登録が持つ。答えが動かし方で分かれる問い
// （眠らせる・閉じるとき Service を止めるか）は、登録を引く口（`RemoteModeOf`）を受ける。根の場所とこの機械のコンテナかは、
// どちらの動かし方でも答えが同じなので記録だけで答える（Project の記録の層は登録を知らない）。

import { HOST_CONTAINER_RUNTIME, type RemoteRuntimeMode } from "./remote-store.js";

/**
 * 実行場所の種類：この機械のコンテナ／別のサーバ（向こうのユーザーで直に動かす——`machine`）／別のサーバの中の Project ごとの
 * コンテナ（`containers`）
 */
export type RuntimeKind = "host-container" | "remote-machine" | "remote-containers";

/** 別のサーバの名前から、登録の動かし方を引く（登録が無ければ undefined） */
export type RemoteModeOf = (runtimeName: string) => RemoteRuntimeMode | undefined;

const REMOTE_PREFIX = "remote:";

/**
 * Project の記録の `runtime` から種類を引く。無ければこの機械のコンテナ。`remote:<名前>` は別のサーバで、登録が `containers`
 * なら `remote-containers`。ほかの値・登録の無い名前は前の2択と同じく `machine` として扱う（この機械の根として正規化しない・
 * この機械のコンテナを探さない）
 */
export function runtimeKindOf(runtime: string | undefined, modeOf: RemoteModeOf): RuntimeKind {
  if (runtime === undefined || runtime === HOST_CONTAINER_RUNTIME) return "host-container";
  const name = runtime.startsWith(REMOTE_PREFIX) ? runtime.slice(REMOTE_PREFIX.length) : undefined;
  return name !== undefined && modeOf(name) === "containers" ? "remote-containers" : "remote-machine";
}

/** 動かし方を問わない問い用（根の場所・この機械のコンテナか）——どちらの動かし方でも答えが同じなので `machine` で引く */
const anyRemote: RemoteModeOf = () => undefined;

/** 根がこの機械のパスか（正規化・重なりの確かめをこの機械で行うか。Runner の作業ディレクトリが根か） */
export function rootIsOnThisMachine(runtime: string | undefined): boolean {
  const kind = runtimeKindOf(runtime, anyRemote);
  switch (kind) {
    case "host-container":
      return true;
    case "remote-machine":
    case "remote-containers":
      return false;
    default:
      return unreachableKind(kind);
  }
}

/** この機械の Incus のコンテナで動くか（コンテナの状態・上限・中で引くこと・止めること） */
export function usesHostContainer(runtime: string | undefined): boolean {
  const kind = runtimeKindOf(runtime, anyRemote);
  switch (kind) {
    case "host-container":
      return true;
    case "remote-machine":
    case "remote-containers":
      return false;
    default:
      return unreachableKind(kind);
  }
}

/**
 * 眠らせるとき、Service の Module が待たれていなければ、**コンテナを止めるかに依らず** Service を止めて自動起動から外すか。
 * 別のサーバ（`machine`）は止める箱が無く、向こうの起こし直しで勝手に起きる。この機械と別のサーバのコンテナ（`containers`）は
 * コンテナごと止めれば中の Service も止まる（コンテナを残すときだけ止める——呼び元が見る）
 */
export function suspendsServicesToSleep(runtime: string | undefined, modeOf: RemoteModeOf): boolean {
  const kind = runtimeKindOf(runtime, modeOf);
  switch (kind) {
    case "host-container":
    case "remote-containers":
      return false;
    case "remote-machine":
      return true;
    default:
      return unreachableKind(kind);
  }
}

/**
 * 閉じるとき、Service を止めて自動起動から外してから閉じるか。別のサーバ（`machine`）は閉じたら実行場所が空いて別の Project が
 * 来る——enable のままだと向こうの起こし直しで起きてぶつかる。この機械と別のサーバのコンテナ（`containers`）は Project ごと
 * なので空かない（閉じるとコンテナを止める）
 */
export function suspendsServicesToClose(runtime: string | undefined, modeOf: RemoteModeOf): boolean {
  const kind = runtimeKindOf(runtime, modeOf);
  switch (kind) {
    case "host-container":
    case "remote-containers":
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
