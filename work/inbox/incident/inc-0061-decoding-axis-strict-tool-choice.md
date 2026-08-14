---
id: inc-0061
type: incident
kind: bug
origin: claude
class: llm-provider
status: open
refs: [adr-0019, inc-0056]
---

## 内容

**道具の数とは無関係に、復号の段で道具呼び出しが潰れている疑いがある**（ADR-0019 診断②）。

- pi は vLLM へ**全ツールに `strict: false`** を送り、`tool_choice` は設定していない
- vLLM 公式: `For tool_choice="auto", setting strict: true on at least one tool opts in to
  structural-tag constraints; without it, the model generates freely and tool calls are
  extracted from raw text.`
- 「では strict を付ければよい」は罠。arXiv:2606.25605 が **Tool Suppression**（オープンウェイトで
  JSON Schema 制約と tool calling を同時に有効にすると道具を呼ばなくなる。文法トークンマスクが
  tool-call トークンを到達不能にする）を機序つきで報告。緩和は**2パス分離**
- inc-0056 の実測（`strict: true` で 1/12 → 3/12 と改善しなかった）とも符合

## なぜ起票するか

ADR-0019 の未決③が「本 ADR では決めない。incident として起票し、実測で切り分ける」と
明記していたが、起票されていなかった。**道具を減らしても直らない軸**なので、
ADR-0019 決定82〜85 の効果測定とは別に切り分ける必要がある。

## 確かめること

`strict` の有無 × `tool_choice` の指定 × 2パス分離、の組み合わせで道具呼び出し率を測る。
題材は実ログから機械的に抽出（自分で選ばない）。n は十分に取る。
