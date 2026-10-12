# Browser の日本語が中国の字形で描かれる（2026-10-12、Backlog #271）

決めたことは `docs/specs/v4-modules.md` §4.1「本体で決めたこと」の「字体」。ここは経緯と測ったこと。

## 起きたこと

稼働中（release 3c261bef）で、日本語のページが中華フォントで描かれるとユーザー報告。この Project のコンテナで
`fc-match "sans-serif:lang=ja"` が WenQuanYi Zen Hei を返していた。Playwright の `install-deps chromium` が入れる
`fonts-wqy-zenhei` の設定（`25-wqy-zenhei.conf`・`64-wqy-zenhei.conf`）が強い。IPA ゴシックも入っているが負ける。
この Project のコンテナは手で直した（`fonts-noto-cjk` と `/etc/fonts/conf.d/60-banto-ja.conf`）。

## 測ったこと（まっさらのコンテナ、banto-base の Ubuntu 24.04）

- `install-deps chromium` の後：`fc-match "sans-serif:lang=ja"` も素の `sans-serif` も WenQuanYi Zen Hei
- `fonts-noto-cjk` を足しただけ：`fc-match` は変わらず WenQuanYi Zen Hei（sans-serif・serif・monospace とも）
- `FONTCONFIG_FILE` に「`/etc/fonts/fonts.conf` を include → 後に規則」の設定を置く：`fc-match` は lang=ja で
  Noto Sans/Serif/Sans Mono CJK JP、zh-cn は SC のまま。**システムの設定より後に置いても、`prepend`＋`strong` なら勝つ**
- lang=ja の規則と総称の alias（JP を好む）だけだと **lang=ko も JP になる**——ko・zh の規則も書く
- **Chrome は `fc-match` と同じには選ばない**。Module の設定なしでも、Noto CJK が入っていれば lang=ja の sans-serif・名前つきの
  字体（Hiragino・Meiryo・Helvetica の後の sans-serif）・lang の無い文字の多くは Noto Sans CJK JP で描いた（CDP の
  `CSS.getPlatformFontsForNode`）。**それでも設定なしでは `monospace`（lang=ja）が WenQuanYi Zen Hei Mono、`system-ui` が
  WenQuanYi Zen Hei**（html の lang が無いときも en のときも）。設定ありでは全部 Noto CJK JP（Mono は Noto Sans Mono CJK JP）
- 入れ直しの通し（まっさらのコンテナで Module の組み立てから、ブラウザ・ライブラリ・字体を Module が入れる）：字体の apt 36 秒・
  Chrome 233 秒・install-deps 59 秒。lang=ja の文字は Noto Sans CJK JP・lang=ko は Noto Sans CJK KR・`notice` は無し

## 選んだ・選ばなかった

- **設定の置き場は `FONTCONFIG_FILE`（Module の置き場）**。`/etc/fonts/conf.d` に置く案は採らなかった：sudo が要り、
  別のサーバ（sudo しない）では置けず、コンテナのほかのプログラムの字体まで変える。Module が起こすブラウザにだけ効けば足りる
- `XDG_CONFIG_HOME` の下（`fontconfig/fonts.conf`）に置く案は採らなかった：ブラウザの設定の置き場（`~/.config` 相当）も一緒に
  動いてしまう。`FONTCONFIG_FILE` は字体だけを変える
- **字体の包みは入れる**（設定だけでは字形が無い）。IPA ゴシックを先に選ぶ案は採らなかった：Sans しか無く、Serif・Mono・
  ほかの CJK の言語を持たない
- **入れられなくても断らない**：字形が違うだけでページは開ける。tmux（Terminal）は無いと動かないので断るが、ここは違う
- **CJK でない locale の総称は JP**：決めないと wqy の中国の字形に落ちる。banto の使い手は日本語で書く
- 試験（`tools.integration.test`）は、この Project のコンテナではシステムに手の設定（`60-banto-ja.conf`）があるので、Module の
  設定が無くても通る。Module の設定が効いていることの見分けは `ja-mono`・`system` の場合で、まっさらのコンテナで設定を外すと
  WenQuanYi になることを上の通しで確かめた（ko は設定なしでも Chrome が KR を選んだ——見分けにはならない）
