# 待つ形の runCommand のあとに残ったプロセス（Backlog #527）

2026-10-23。別の Project（learning-type2-electrician）からの報告：待つ形の runCommand で `(setsid npx wrangler dev … &)` を
十数回流し、片づけの `pkill -f` が自分のシェルに当たって先に落ち、wrangler/workerd が 7 組・約 3.5GB 残った。Service の
一覧・listCommands・人のターミナルのどこにも出ず、Project を眠らせても残った。

## 原因

1. **待つ形は起こした `sh` の終わりしか見ていなかった**。コマンドは仕事の組（`banto-shell-<乱数>.scope`）に入れて起こして
   いたが、組の名前を使っていなかった。`(… &)` の中身は組（cgroup）を継いだまま生き続ける——setsid は cgroup を抜けない。
2. **眠らせてもコンテナが止まらない筋**：`HostContainerRuntime.release(placeId, { stop: true })` は、この host の走行で
   `ensureContainer` を通ったことの記録（メモリの `ready`）が無ければ黙って返っていた。host を起こし直すとコンテナは動いた
   まま記録だけ消えるので、そのあと眠らせても止まらない。今回の報告がこの筋だったかは確かめていない（host の起こし直しと
   眠らせた時刻の前後が要る）が、静かに空振りする筋はこれしか無かったので直した。

## 決めたこと（仕様は v4-modules.md §2.3「待つ形のあとに残ったプロセス」・v4-architecture.md スリープの節）

- sh が終わったら組に残りが居るかを見る。普通に終わったなら**引き取って** `listCommands` に `leftover: true` で出し、
  `cancelCommand` で組ごと止められるようにする。時間切れ・取り消しなら組ごと止める。
- `release` は記録が無くても Project から決まる名前で止める（`stopProjectContainer` と同じ。無い・止まっているなら何もしない）。

## 却下した案

- **普通に終わったときも自動で止める**：いちばん確実だが、開発サーバをわざと後ろに回して次のコマンドで叩く使い方を
  黙って壊す。見えて止められれば足りる（完了条件も「見える化され、cancelCommand かスリープで片づく」）。
- **`&`・setsid・nohup をコマンドの文字から見つけて警告**：書き方は無数にあり（スクリプトの中・`disown`・`daemonize`）、
  文字を見ても当たり外れがある。組を見れば書き方によらず分かる。
- **`systemctl --user stop <scope>` で止める**：scope の止める猶予は既定 90 秒で、cancelCommand が長く返らない。自分で
  SIGTERM → 10 秒待つ → SIGKILL（`systemctl --user kill`）にした。

## 残したこと

- 人の画面（サイドバーの印・一覧）には出していない。待たない形の印は札（あとで届ける）とカードから出ている仕組みで、
  札を持たない残りには乗らない。画面に出すなら型が要る（モックで先に見る）。
- 似た根の Backlog #294（サブエージェントの scope が残る）は別件として触っていない。
