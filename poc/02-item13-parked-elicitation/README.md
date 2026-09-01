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
5. **（2026-08-31 追加）`onElicitation` の `options.signal` は、Module 側の
   タイムアウトで abort されるか**——受信箱の3状態を設計する過程で「クライアント側は
   検知不能」という当初の結論が検証不足だったと判明したため、正式に確認し直す
6. **（同）タイムアウト前に resolve すれば、元の tool 呼び出しを直接解決できるか**
   ——受信箱の「生きている」状態の核心
7. **（同）タイムアウト後に resolve しても意味が無いことの確認**——「次のターンへの
   新規入力として渡す」に頼らざるを得ない理由の裏付け

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
| **(5) signal の abort**（`run-signal-abort.mjs`） | **発火する**（当初「検知不能」と書いたのは検証不足による誤り——規則1）。Module 側タイムアウト5秒に対し、`onElicitation` 受信 at 6.2〜6.4秒、会話のターン終了（`result` イベント）at 17.3〜18.5秒、signal の abort at 17.8〜19.0秒——**abort は会話のターン終了より毎回遅れて届いた**（n=2） |
| **(6) タイムアウト前に resolve**（`run-late-answer-live.mjs`） | **合格。** Module 側タイムアウト8秒、受信2秒後に resolve → tool 呼び出しが正常に解決し、渡した回答（`poc太郎（受信箱からの遅延回答）`）がそのまま tool 結果に載った |
| **(7) タイムアウト後に resolve**（`run-late-answer-after-timeout.mjs`） | **想定通り無効。** Module 側タイムアウト3秒、受信6秒後（タイムアウト後）に resolve → tool 結果は `-32001: Request timed out` のまま。渡した回答は反映されない |

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
- **（2026-08-31）** §2.4.1「タイムアウトは banto の制御外」の節を、実験(5)(6)(7)を
  根拠に訂正——「検知不能」を撤回し、判断待ちを**3状態**（生きている／解決済み／
  タイムアウト済み）で出し分ける決定に書き直した。§2.4 に「判定の軸を一般化した」
  節（判断待ち/レビュー待ち × Thread自身/Module管理下、の2軸モデル）を追加

## 破棄

段3（本実装）の頭で `poc/` ごと削除する。
