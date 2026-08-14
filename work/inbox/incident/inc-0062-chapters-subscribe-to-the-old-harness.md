---
id: inc-0062
type: incident
kind: bug
origin: claude
class: banto-host
status: open
refs: [adr-0020, task-0104]
---

## 内容

**バックエンドを会話の途中で替えると、自動の章立てが働かなくなる**（2026-08-13・静的に確定）。

`ChapterKeeper.start()` は、そのとき動いていたハーネスに購読を1回張るだけ:

```ts
start(): void {
  this.unsubscribe = this.harness.subscribe((event) => { ... });  // ← ここで固定される
}
```

`Thread.replaceHarness` が張り直すのは**サーバの配信の購読だけ**なので、
章の見張りは**古いハーネス**に残る。`run_end` は新しいほうから出るので、
閾値を超えても誰も畳まない＝文脈が伸び続ける。

**`closeChapter`（PO が手で区切る口）は効く。** `harness` の getter が毎回引き直す形に
なっているため——「差し替えに追随する」という注記があるのに、**追随しているのは半分だけ**
だった（P3：注記と実態の食い違い）。

task-0104 で `dispose()` を入れたので、pi へ戻したときは古い Claude ハーネスの購読が
**まとめて消える**。つまり `pi → Claude → pi` を往復した会話では、自動の章立ては
黙って止まったままになる。

## なぜ起票するか

task-0104（復元と後始末）のスコープ外。直すには「ハーネスが替わったことを
`ChapterKeeper` へ伝える経路」が要り、いま `replaceHarness` を呼ぶのは `server.ts`
（章立てを知らない層・D5）なので、通す先を決める設計判断が要る。

## 決めること

`Thread` に「差し替えられた」を知らせる口を持たせて `bin.ts` が `chapters` を張り直すか、
`ChapterKeeper` 側が毎ターン購読先を確かめる形にするか。
