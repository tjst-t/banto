# 記録：Managed Agents の `self_hosted` を調べた（実験は未実施）

> 2026-08-20。ADR-0001 に書かれていた検証の**下調べ**。
> **実験は実施していない。** ここにあるのは公式文書で確かめた事実だけで、
> 動かして得た結果ではない。
>
> **2026-08-20 追記：Managed Agents は使わないと判断した。** 理由は設計ではなく
> 前提条件で、Claude API の課金が必須だから（ADR-0001「判断した：Managed Agents は
> 使わない」）。**この文書は、API アカウントを持つことになったときに
> そのまま走らせるために残す。**

## 結論から

ADR が前提に置いていた事実のうち **1つは古くなり、1つは正しく、書かれていない
制約が1つ見つかった。** ただし**検証の題そのものには、まだ答えが出ていない。**

## ADR の前提を1つずつ当たった（出所：公式文書、2026-08-20 取得）

| ADR の記述 | いま | 出所 |
|---|---|---|
| self_hosted では **Memory Stores が未対応** | **古い。対応している** | 「Sessions on a self-hosted environment attach memory stores exactly as sessions on cloud environments do」。ただし Claude Platform on AWS 上の self_hosted では不可、かつ `ant` CLI worker では mount されず Python/TS/Go の `EnvironmentWorker` が要る |
| self_hosted では **環境変数資格情報が未対応** | **正しい** | 「Environment variable credentials (`environment_variable`) are not yet supported with self-hosted sandboxes」 |
| （記述なし） | **`file` と `github_repository` の resource は 400 で拒否される** | 「Self-hosted sandboxes support `memory_store` resources only」。session に含めると `resources are not supported with self-hosted environments` で 400 |

### 3つめは banto にとって問題にならない

Anthropic 側はファイルも git リポジトリも mount しない。代わりにファイルの参照
（S3 パスや commit SHA）を session の `metadata` に渡し、**自分の worker で用意する**。

banto の worker は**ローカルの作業ツリーの上で動く**ので、mount してもらう必要が
そもそも無い。git は Repo モジュールが自分で扱う（決定5）。**ADR の
「self_hosted 一択」という判断は、この制約を知ったうえでも変わらない。**

## まだ答えが出ていない、いちばん大事なこと

**self_hosted で、grader は採点対象をどうやって見るのか。**

Outcomes の文書は成果物の受け取りをこう書いている——「The agent writes output files
to `/mnt/session/outputs/` inside the sandbox. Once the session is idle, fetch them
through the Files API scoped to the session」。だがこれは cloud の sandbox の話で、
**self_hosted では sandbox は自分の側にある。** grader は Anthropic 側で別の文脈窓を
持って走る。文書は grader の入力が何かを明示していない。

考えられるのは2つ：

1. **grader はセッションのイベント履歴を読む。** self_hosted でもエージェントループ
   自体は Anthropic の orchestration 層で走り、ツールの**実行だけ**が自分の側に来る。
   つまり tool_result は Anthropic 側に戻っている。だとすれば grader は履歴から採点でき、
   **self_hosted でも Outcomes は成立する**
2. **grader は `/mnt/session/outputs/` のファイルを読む。** だとすれば self_hosted では
   採点対象が Anthropic 側に無く、**Outcomes は成立しない**

**1 だと考える理由はあるが、確かめていない。** 推測で ADR を書き換えない（規則1）。
これは動かせば1回で分かる。

## 実験ができなかった理由

Managed Agents は Claude API の課金対象で、`x-api-key` が要る。この機械には
API 資格情報が無い——`ANTHROPIC_API_KEY` も `ANTHROPIC_AUTH_TOKEN` も未設定、
`ant` CLI も `~/.config/anthropic` のプロファイルも無い。あるのは Claude Code の
サブスク資格情報（`~/.claude/.credentials.json`）だけで、これを課金 API に向けるかは
人が決めること。

## 実験の設計（資格情報が入り次第そのまま走らせる）

題は1点に絞ったまま。**まず上の「grader は何を見るか」を潰す。**

1. `POST /v1/environments` で `config: {"type": "self_hosted"}` を作る
2. Console で環境キーを発行し、`EnvironmentWorker`（TypeScript）で worker を建てる
   ——banto の作業ツリーの上で動かす
3. セッションを作り、`initial_events` に `user.define_outcome` を1つ入れる。
   rubric は**ファイルの中身でしか判定できない形**にする
   （例：「`report.md` に `## 結論` という見出しがあり、その直下に3行以上ある」）
4. `span.outcome_evaluation_end` の `result` と `explanation` を見る
   - 中身に即した指摘が返る → grader は履歴を読んでいる（仮説1）。**Outcomes は使える**
   - 「採点対象が見つからない」等 → 仮説2。**self_hosted では Outcomes は使えない**
5. 使えると分かった場合にだけ、決定10 の受け入れ
   （3依頼同時・落として再起動しても続く）と突き合わせる

**費用の見込み**：Haiku で数ターン ×2〜3 セッション。数十円の規模。

## 先に言っておくべき見立て

仮に Outcomes が動いても、**決定10 の受け入れ全部は置き換わらない。**
決定10 の受け入れは「3依頼を同時に投げて3つとも main に入る。**落として再起動しても続く**」で、
これは**耐久実行と並行**の話である。Outcomes が与えるのは rubric による**品質の門**で、
落ちたところから再開することではない。Deployments は cron であって耐久実行ではない。

ADR の検証の題は「Outcomes が**受け入れ**を置き換えられるか」と書かれており、
受け入れ判定の部分に限れば正しい問いのままである。ただし**決定10 を丸ごと
Managed Agents に置き換えられる、とは読まないこと。**
