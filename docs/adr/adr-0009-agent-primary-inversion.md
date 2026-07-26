---
id: adr-0009
type: adr
status: proposed
refs: [vision, principles, adr-0002, adr-0003, agent-primary-inversion-note]
branch: explore/agent-primary
---

# ADR-0009: 番頭主体への構造逆転（AI Agent を主、開発システムを従に）

> status: **proposed**（探索ブランチ `explore/agent-primary` の working canon）。記憶システムの詳細設計は [Quirefold](../spec/memory.md)（`spec-memory`＝banto の記憶サブシステム）に統合済み。Substrate の確定は [ADR-0010](./adr-0010-memory-substrate-schema.md)。詳細は [docs/notes/agent-primary-inversion.md](../notes/agent-primary-inversion.md)。

## 文脈

S6cfce9 全体像プロトタイプ（ADR-0002）の検討の終盤、UIパラダイム（コックピット vs チャットファースト）を詰めるうちに、より根本の**構造の逆転**が浮上した。従来は「banto＝開発システムが主、AI Agent はその部品」だったが、PO の意図は「**コンテキストを超えて高精度な記憶を持つ AI Agent（番頭）が主体となり、開発システム全体を統括する。チャットで不便なところを既存UI（アテンションキュー等）で補う**」。将来は開発以外の領域も同じ番頭に取り込みうる＝真の番頭への第一歩としての開発システム。

## 決定

**記憶を持つ AI 番頭（steward）を主体、開発システム（daemon＋UI）を従とする構造を、本探索ブランチの前提とする。**

- 4層：PO（主人）／番頭AI（記憶あり・PO代理・アーキ/方針/大きな判断・差配）／daemon（決定的統治基盤）／職人＝worker（memoryless・実装/調査/行単位レビュー）。
- **二軸で bantoの存在理由を守る**：体験・差配の軸は番頭が主、執行の軸は daemon が主（ゲート・真実＝イベントログ）。番頭でも帳簿はごまかせない（D2/D3 保持）。
- **番頭の決定境界**：利用体験を変え、かつ本物のトレードオフのときだけ PO へ。それ以外は番頭が決定（D1 を高度で置換）。pre-release は壊してよい。
- **番頭は細かい仕事をしない**：調査/実装は職人へ委譲しコンテキストを節約。
- **分身（フチコマ）**：番頭は複数インスタンスに分身し、決定はイベントログへ直列化、学びは共有記憶へ収束。アテンションキュー＝daemon発起の分身の待ち行列。会話スレッド＝生きてる分身。
- **記憶を持つ番頭／memoryless な職人の非対称**を原則とする。

## 帰結

- (+) 「チャット vs コックピット」が解ける：主体は番頭、既存UIは番頭が差し出す走査可能な盤面。
- (+) 記憶システム（ADR-0003）が“機能”から**核**へ昇格。拡張性が構造から出る（番頭核と開発固有の道具を分離）。
- (+) daemon の決定的統治（D2）と worker の memoryless 監査可能性（I1）は保持。substrate（daemon/worker/ADR-0003〜0008/specs）と個別サーフェスは**再利用**（全捨て不要）。
- (−) VISION・操作パラダイム・プロトタイプのシェルは**作り直し**。principles に番頭の判断規則を追加（要 ADR 経由）。
- (−) **本丸＝記憶の同期/マージ設計が未確定**（導出記憶の照合規則、長寿命分身の再同期）。PO の永続記憶システム文書を統合してから確定する。
- 正式化（VISION.json/principles.md/本ADRの accepted 化）は上記統合の後。
