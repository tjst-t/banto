# 02-item13-parked-elicitation

**捨てる。本実装に流れ込ませない。**

## 問い

`docs/specs/v4-architecture.md` §10 item 13——判断待ちの「後で答える」層。
Step 0 の実測で MRTR も Tasks capability も無いことが分かった上で、
残る道（`onElicitation` コールバック）が実際にどう振る舞うかを確かめる。

1. 既定タイムアウト（60秒）で本当に切れるか
2. `onElicitation` が `null` を返したとき何が起きるか
3. **banto（host）を落として上げ直したあとに答えられるか**——受信箱の本当の要件
4. Tasks 経路が使えるか（Step 0 で「advertise されない」ことは確定済み）

## 偽物を本物に寄せた点

- Module は `createSdkMcpServer`（in-process）ではなく、実 stdio subprocess として
  `Server.elicitInput()` を呼ぶ。in-process だと参照渡しになり JSON-RPC の枠も
  要求側タイムアウトも無く、簡単に「寝かせられた」ことになってしまう（教訓1）
- Module 側のタイムアウトは明示的に短く指定して試した（`run-timeout.mjs` は5秒）
  ——既定60秒をそのまま待つテストは時間の無駄が大きいので省略し、代わりに
  「Module 側が指定した任意の秒数で切れる」ことを確認して既定値の妥当性を推論した
  （型定義で `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` を確認済み・Step 0）

## 結果（合否はサーバ側＝Module のログで見る。クライアント側の静けさは証拠にならない）

| 実験 | 結果 |
|---|---|
| **基本の往復**（`run-accept.mjs`） | `onElicitation` が `accept` を返すと正常に往復する。19ms |
| **(1) タイムアウト**（`run-timeout.mjs`） | Module 側 5秒指定 → 5.003秒後に **`MCP error -32001: Request timed out`** が Module 側の catch に届く（`elicitInput` が reject する） |
| **(2) `null` 返却**（`run-null-return.mjs`） | 型定義の警告どおり **fail-closed**——帯域外応答を送らずに `null` を返すと、何も送られず、Module 側のタイムアウトまで pending のまま（5秒後に同じ `-32001`） |
| **(3) host 再起動をまたげるか**（`run-host-restart.mjs`） | **またげない。** pending 中に `Query.close()` を呼ぶと、Module 側の `elicitInput` は**即座に** `{"action":"cancel"}` で解決された（66ms） |
| **onElicitation 未設定** | 仕様書コメントどおり自動的に **`decline`** で即座に解決される（11ms） |
| **(4) Tasks 経路** | Step 0 で確定済み（`tasks` capability を advertise しない）。実測は省略 |

## 決定的な発見

**(3) が核心。** Elicitation プロトコル自体の継続では「host を落として上げ直した
あとに答える」を実現できない——host（Runner）の接続を閉じた瞬間、pending 中の
elicitation は強制的に `cancel` として解決される。これは §2.4.1 が未決として
残していた「走っている呼び出しの中で完結しない待ちをどう寝かせて再開するか」の
2つの選択肢のうち、**「呼び出し自体を保留する」が実装として成立しないことを示す**
——残るのは「`requestState` を Event Store に持つ」だけ。

## 仕様書のどの行を更新したか

- `docs/specs/v4-architecture.md` §2.4（Elicitation の使い方の決定を書き直す）
- `docs/specs/v4-architecture.md` §2.4.1（判断待ちの型に requestState を持たせる）
- `docs/specs/v4-architecture.md` §10 item 13 を打ち消し

## 破棄

段3（本実装）の頭で `poc/` ごと削除する。
