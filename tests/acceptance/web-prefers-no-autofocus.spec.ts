/**
 * PO報告 2026-08-15: タッチ端末で会話を切り替えると、チャット欄へ自動フォーカスして
 * ソフトウェアキーボードが開く。判定ロジック（packages/banto-web/src/prefersNoAutoFocus.ts）
 * を検証する。実際に focus() を止めているのは Room.tsx 側で、ここは純粋な判定のみを見る
 * （UI 検証は tests/mobile-no-autofocus.spec.ts の playwright 側）。
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prefersNoAutoFocus } from "../../packages/banto-web/src/prefersNoAutoFocus.js";

const originalMatchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;

function stubMatchMedia(matches: (query: string) => boolean): void {
  (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia = (
    query: string
  ) => ({ matches: matches(query) });
}

afterEach(() => {
  (globalThis as { matchMedia?: unknown }).matchMedia = originalMatchMedia;
});

describe("prefersNoAutoFocus: タッチ端末の判定", () => {
  it("(pointer: coarse) が真なら true", () => {
    stubMatchMedia((query) => query === "(pointer: coarse)");
    assert.equal(prefersNoAutoFocus(), true);
  });

  it("(hover: none) が真なら true（pointer: coarse だけでは拾えない端末がある）", () => {
    stubMatchMedia((query) => query === "(hover: none)");
    assert.equal(prefersNoAutoFocus(), true);
  });

  it("どちらも偽なら false（PCはこれまでどおり）", () => {
    stubMatchMedia(() => false);
    assert.equal(prefersNoAutoFocus(), false);
  });

  it("matchMedia が無い環境（SSR・試験環境）では false に倒す", () => {
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
    assert.equal(prefersNoAutoFocus(), false);
  });
});
