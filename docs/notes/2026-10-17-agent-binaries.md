# エージェントの本体を取ってくる——実装で決めたこと（2026-10-17）

仕様：`docs/specs/v4-architecture.md` §4.1「エージェントの本体を取ってくる」、`v4-security.md` §1「向こうに置くもの」。
実装は core の `agent-binaries/`（目録・取ってくる・tar を読む・進み具合）、中継の口 `relayEnsureAgentBinary`／
`relayAgentBinaryStatus`、`runtime/remote-ssh.ts` の送り込み、Subagent Module の `agents.ts`・`server.ts`。

## 実装のときに決めたこと

- **向こうの置き場は banto ごとの置き場の下**（`<置き場の根>/<データの置き場のハッシュ 12 字>/agent-binaries/`）。仕様は
  `<置き場の根>/agent-binaries/` と書いていたが、v4-security.md §1「向こうに置くもの」は「置き場の根の下に、banto ごとに」の
  一覧なので、そちらに揃えた。根の直下にすると、同じ根を使う別の banto が「いまの目録に無い版を消す」で互いの版を消しうる。
  仕様の文も直した
- **「余計なファイル」の読み方**：本物の npm の tarball は `package/package.json` と `package/bin/opencode` の2件（fileCount 2）。
  ほかの通常のファイルを断ると本物が通らないので、**読み飛ばす（取り出さない）**。断るのは symlink・hardlink・装置・`..`／`/` で
  始まる名前・**同じパスの2件目**・上限超え。仕様の文も直した
- **版のフォルダの 0555 は rename のあと**：書けないフォルダは親を跨いで rename できない（`..` を書き換える）。単体テストで踏んだ
- **AVX2 の覚え方**：前提の一覧の1項目 `cpu-avx2`（いつも ok）にし、値を `RuntimeCheck.value`（画面には出さない）に置いた。
  別の型を足すより、既に記録・表示される一覧に載せるほうが写しを増やさない。画面の前提の一覧に1行増える
  （`remote-runtime-registry` の期待値に足した）
- **進み具合は待っている呼び元みんなへ**：single-flight（`modules/single-flight.ts`）は結果だけを分けるので、あとから来た呼び元は
  進み具合を受けられず、中継の上限（60秒）で切られる。`SharedProgressTasks` で最後の文をすぐ渡し、以後も流す
- **別のサーバへ送る間の「進まなければやめる」は送る ssh 側**（既存の `TRANSFER_STALL_MS`＝120秒）。知らせるのは
  `watchProgress`（やめる役は持たせない）
- **偽のエージェントの本体**は「受けた引数をそのまま exec する sh」。`command` は口の返り値、`args` で node と
  `testing/fake-agent.js` を渡す。中から見える node のパスは Module 自身の `process.execPath`（コンテナ・別のサーバで違う）なので、
  tarball の中に node のパスを書けない
- **`listSubagents` の説明の「約185MB」**は `agents.ts` の `fetchedBinary.approxSize` に書いた（目録の `approxBytes` の写し）。
  tool の一覧は起動時に組むので、そのために host へ問い合わせる口は作らなかった。目録の版を上げて大きさが大きく変わったら一緒に直す
- **`check:agents`** は core の組み立て済み（`core/dist/agent-binaries/*`）を相対パスで直に読む——開発用の確かめで、Module の
  コードは core を import しない

## 確かめられなかったこと

- `check:agents`（opencode）の本来の形（opencode-go の鍵で `opencode-go/qwen3.6-plus`）は、この機械に鍵
  （`~/.local/share/opencode/auth.json`）が無く流していない。代わりに、目録から取ってきた本物の OpenCode 1.18.32 を
  Module の口から起こし、`listSubagents`（候補が返る）と、鍵の要らない `opencode/big-pickle` での `runSubagent`
  （Project の根に hello.txt を書いて「できた」）が通ることを確かめた
- `banto/probes/b-acp.mjs`（PoC の置き場）は `opencode-ai` を require するので、もう動かない。スコープ外として触っていない
