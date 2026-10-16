# 用事で起きた Project を眠りに戻す——実装で決めた細部（Backlog #358）

仕様はアーキ仕様 §2.2「眠りに戻す」（決定・2026-10-16、4dbddb9b）。ここは実装で決めた細部と、仕様と食い違うところ。

## 食い違い（人に上げる——規則8）

- **このブランチ（factory/project-sleep-return）の `docs/specs/v4-architecture.md` には §2.2「Project のグループとスリープ」が無い。**
  origin/main（4dbddb9b・20bf0ec2 ほか）にはある。スリープのコード（7e20a423）は入っているのに仕様の節が無いので、載せ直しの
  ときに仕様のコミットが落ちたと見られる。実装は origin/main の §2.2 を正として読んだ。仕様書はこのブランチでは直していない
- **仕様は「起きた理由と、起きてから人の操作があったかは `project.woke` の cause と `project-activity.json` の `lastHumanAt` から引く」。**
  `project-activity.json`（`lastHumanAt`）はまだ無い（Backlog `project-idle-sleep`）。そこで今は**メモリに覚える**：
  `ProjectSleep.wake` が `delivery`／`automation` で起こしたら Project と起こした時刻を覚え、人の操作（`noteHuman`）・眠った・閉じたで忘れる。
  **banto を起こし直すと忘れ、起きたままになる**（眠らせ損ねる側に倒す——人が見ているかもしれない Project を勝手に眠らせない）。
  `project-idle-sleep` で `lastHumanAt` が入ったら、そちらから引く形に寄せる

## 決めた細部

- **人の操作**：人のセッション（Cookie）からの、`GET`／`HEAD` 以外の要求で、道が `/api/projects/:id/…`・`/api/threads/:id/…`・
  `/api/inbox/:id/…` のもの（Thread は持ち主の Project、受信箱の項目は Thread の Project かお知らせの Project）。仕様の列挙
  （開いた＝prepare・送った・答えた・返信した・Fork を閉じた・名前や設定を変えた）はどれもこの形。**読むだけの要求は数えない**——
  画面は出来事のたびに一覧や会話を取り直すので、`GET` を数えると、開いていない Project まで数えてしまうおそれがある
- **用が済んでいない**（`errandLeftoversOf`）：`hostActivity` に加えて、その Project のどれかの Thread に
  (a) まだ渡していない届いたもの（留めたものを含む）、(b) 生きている判断待ち、(c) **起きてから始めたターン**の結末が人を待つ
  （受信箱の `reviewAttentionOf` と同じ見方——失敗・止めた・判断待ち・決めることがある）。(c) を起きてからのターンに限るのは、
  何週間も前に失敗したまま置いてある会話で、ずっと眠りに戻れなくなるのを避けるため
- **きっかけ**：`threadTurns.onChange` の `ended` と、裏の仕事の札が閉じたとき（`publishBackground`——札を閉じたあとに必ず通る）。
  どちらも同じ刻みのほかの聞き手（受信箱・届いたものの続き）を先に走らせるため `setImmediate` で見る。眠らせるのは
  `ProjectSleep.sleep(id, "auto")` そのもの——断られたら（409：その間に何か始まった等）候補のまま次のきっかけを待つ
- 判断役（`banto.turn-decisions`）がいる Project：元の会話のターンは「決めることがある」で起きたまま。判断役が答えて元の会話が
  進み、決めることの無いターンで終われば戻る。判断役が人に任せたら、決めることが残るので起きたまま
