# main の E2E が7つ落ちていた件（2026-10-03）

「backlog開発」の Fork が見つけた7つ（Backlog の前の f3ff3746 でも同じく落ちる）を、1つずつ再現して見分けた。

## 回し方の誤り（まずここ）

頼みの中の回し方は `sg incus -c "npx playwright test …"` だった。**`sg` は主グループを incus に変えるので、
E2E が作るフォルダのグループが incus になる**。入れ子のコンテナの `raw.idmap` は gid 1000 しか対応させないので、
中の root はそのフォルダ（0700）を辿れず、その下へのマウントが `forkmount … exit status 1` で落ちる。
`e2e/config.ts` の注記どおり **`sudo -n -E -u ubuntu env PATH="$PATH" npx playwright test …`** で回す
（主グループはそのまま、incus も持てる。`docs/notes/2026-09-25-dev-environment.md` にも同じ罠）。

## 7つの見分け

| spec | 分類 | 何だったか | 直したもの |
|---|---|---|---|
| frontend-interaction:52 | 試験の待ち方 | Command Palette は閉じても消える動き（100ms）の間は画面に残り、入力欄が焦点を持ったまま。その間に押した Escape はパレット側が受け取り（defaultPrevented）、背面の Fork に届かない。人が2回目を押すのは消えたあと | 試験：中身が消えるのを待ってから押す |
| sidebar-reorder-rename:160 | 試験の待ち方 | 並びの保存（PUT /api/projects/order）は記録への fsync を待ってから返る。直前に作った Project のコンテナ起動でディスクが混み 2.9 秒かかり、その間にリロードして頼みが打ち切られていた（core は止まっていない：同じ間の healthz は 19ms） | 試験：保存の返事を待ってからリロード |
| composer-image-paste:162 | 仕様の変更に試験が追いついていない | 「Fork の画面では、分ける前の親の会話は最後の1件だけ出す」（99101d9c、2026-09-30）ので、画像の付いた人の発言は Fork の面に出ない | 試験：引き継ぎは host が Fork に写した記録で確かめる（画像の id が親と同じ・中身が取れる） |
| ai-start-forks:109 | 試験の誤り | 携帯の幅では受信箱のボタンは Base の面のヘッダにしか無い。試験は Fork の面に居るまま探して 60 秒待った（2026-10-02 に足した確かめ） | 試験：≡（ナビ）から受信箱を開く |
| instance-modules:200 | **本物の不具合**（画面） | 設定画面の Module の一覧は「同時に欲しがったら1本を分け合う」作りで、Module を足す前に出た取得に足した後の頼みが相乗りし、足した Module の無い一覧で止まっていた。host の一覧が遅いとき（下の Infisical に繋がらない vault-infisical の起動待ちで 12 秒）に表に出た | 画面：最後の増減より前に出た取得なら、終わったあとにもう1回取る（`module-settings-panel.tsx`） |
| module-settings-canvas:258 | この機械では構造的に通らない | 開発用の Infisical は host の 127.0.0.1:8088（docker）で、Project のコンテナからは届かない（ゲートウェイ・LAN の IP でも繋がらない、確認済み）。vault-infisical の listGroupBindings が `fetch failed` になり、Vault の置き場の選択肢に出ない | なし（host で回せば通るはずだが、この Fork では確かめていない） |
| wide-root:38 | 回し方の誤り | 上の `sg incus` のせい。`sudo -u ubuntu` で回すと通る | なし |

## 残り

- vault-infisical は接続先に届かないと、繋がるまで 16 秒かかる（「申告と可視性の確認」15.7 秒）。その間 banto 全体の
  Module の一覧（/api/ui-settings）が待たされる。本番で Infisical Cloud が遅いときも同じことが起きうる——直すかは未決
