---
id: task-0047
type: task
kind: feature
title: 設定画面（モジュールは設定項目の宣言を出す。決定41）
status: done
parent: epic-0007
refs: [adr-0010]
scope:
  paths: ["packages/banto-core/src/module-settings.ts", "packages/banto-environment-pool/src/settings.ts", "packages/banto-host/src/core-settings.ts", "packages/banto-host/src/settings-module.ts", "packages/banto-host/src/settings-store.ts", "packages/banto-web/src/views/SettingsPanel.tsx", "tests/acceptance/settings.spec.ts"]
acceptance:
  - { id: a1, text: "モジュールが設定項目の宣言（区画＝title・fields・read/write）を渡し、settings.describe が中核の区画（llm/places/network）とモジュールの宣言した区画を並べる。由来（origin・表示名）といまの値も一緒に来る。宣言の無いモジュールは空の区画を持たない" }
  - { id: a2, text: "画面で変えた値がモジュールの write へ届き、その場の挙動が変わり、保存されて次の起動でも同じ値になる（値の持ち主はモジュール）。例: environment-pool の adhocDrivers を none にすると env provision が断られ、保存値にも none が残る" }
  - { id: a3, text: "受け付けられない値・知らない区画への変更・壊れた設定ファイルは、黙って丸めたり既定に落ちたりせず断る（I2）。ポートは範囲を確かめ、場所の行・Caddy の対も保存時に検証する" }
  - { id: a4, text: "効いたかどうかを正直に返す。その場で効く設定（場所・検証環境の上限）は applied: true、次の起動から効く設定（LLM）は applied: false で返し、効いていないのに効いたと言わない（I2）。restartRequired の項目は画面がその旨を出す" }
  - { id: a5, text: "設定の口（settings.describe / settings.update）は internalTools にあり番頭の Tool 一覧に出ない。保存先はホストのデータ置き場（settings.json）で file.write の砦が守る（決定38b の自己昇格を塞ぐ）" }
  - { id: a6, text: "tests/acceptance/settings.spec.ts が通り、npm run build・npm run typecheck・npm run typecheck:web が通る" }
---

## 背景

ADR-0010 決定41・モジュールフレームワーク（epic-0007）の一環として設定画面を実装した。コミット c9d0a5b（2026-08-01）で実装済み。同コミットのメッセージが「task-0047」に言及しているのに `work/tasks/` にファイルが無かったため、今回起票漏れを補填した（status は実装済みのため done）。

**モジュールは GUI ではなく項目の宣言を渡す**（決定41・PO要望）。設定は「名前と型と今の値」でほぼ尽きるため、見た目まで各モジュールが持つと1つの画面の中で書式がばらばらになる。宣言だけ受け取って描くのは設定画面にすれば、モジュールが増えても設定画面のコードは変わらない。値の持ち主はモジュールで、read/write はモジュールが実装する（決定27）。保存先を持ちたくないモジュールには、ホストが自分の設定ファイルの一区画を SettingsSection として貸す。

## スコープ外

- モジュール各々の設定項目の中身（Kobo 等、将来モジュールが自分で宣言するもの。本タスクは機構と中核の区画・検証環境の区画まで）
- 設定項目の型の追加（SettingFieldType を増やすときは設定画面の描画も合わせて足す）
- モジュールが GUI コンポーネントを持ち込む形への変更（決定41 の宣言ベースを変えない）
- モジュール HTTP 面の認証（決定27b の未決事項・別課題）
