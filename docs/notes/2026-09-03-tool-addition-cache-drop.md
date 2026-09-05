# tool追加でキャッシュが落ちる（実測）

**結論は下にまとめる。仕様（`docs/specs/v4-architecture.md`）は変えていない
——現行の実装（Project単位で毎ターンModule集合を丸ごと再解決する形）が、
この問題を実質的に避けられているため。ここには実測結果だけ残す。**

## 何を測ったか

Phase 1完了条件「ツールを足してもキャッシュが落ちない（数値で確認）」の実測。
`runTurn()`を直接2回呼ぶ（`packages/core/src/runner/cache-stability.smoketest.mjs`）：

- turn1：`vault`のみをmcpServersに渡す（新規session）
- turn2：`resumeSessionId`でturn1を継続、`vault`に加えて`shell`・`filesystem`を
  追加（＝ツールが増えた状態）

## 結果

```
turn1 usage: cache_creation_input_tokens=8390, cache_read_input_tokens=15507
turn2 usage: cache_creation_input_tokens=24347, cache_read_input_tokens=0
```

**turn2のcache_read_input_tokensが0——turn1で作ったキャッシュが一切再利用
されず、全部作り直しになっている。**

対照実験として、ツールを増やさずに（vaultのみのまま）2ターン実行すると、
turn2でもcache_read_input_tokensは0にはならない（turn1と近い規模の値を維持）。
——**「resumeそのものが機能していない」ではなく、「tool集合が変わったこと」が
引き金になっている**、と切り分けられた。

## 実際のbantoでどこまで効くか

**現行の`resolveModulesForThread`（cli.ts）は、Threadの各ターンで
「そのProjectに繋がっている全Module」を毎回丸ごと解決する。** Shell・
FileSystemはProjectの最初のターンより前に（`resolveModulesForThread`内で
`await`して）spawnされるため、**同一Thread内でturn 1からturn 2にかけて
tool集合が変わることは、通常の使い方では起きない**——起きるのは「Thread進行中に
新しいModuleがhostに登録された」ような、稀なケースに限られる。

## 対応

**今は仕様も実装も変えない。** 上記の理由で、通常の使い方ではこの問題を
実質踏まない設計に既になっているため。**踏むとしたら**：Project起動後に
新しいModuleを追加で有効化したときで、そのときは**次のターンでキャッシュが
作り直しになる（コストは掛かるが、壊れるわけではない）**——動作としては
許容範囲、というのが現時点の判断。将来、Module追加が頻繁な運用が出てきたら、
「新しいModuleが増えたら新しいThreadを促す」等の緩和策を検討する。
