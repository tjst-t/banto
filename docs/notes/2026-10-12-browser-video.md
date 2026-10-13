# Browser の人の画面を動画で流す（2026-10-12〜13）

仕様は `docs/specs/v4-modules.md` §4.1「動画で流す——H.264 と WebCodecs」。ここは経緯。

- 2026-10-12 ユーザー「結構遅延が多いけど仕組み上しょうがない？ 動画を滑らかに再生できない？」。設計役の見立て（案X：
  Xvfb→GStreamer→H.264→流れの口→WebCodecs／案Y：WebRTC／案Z：今の JPEG を詰める）を Fable のサブエージェント
  （d80bc5ec）に確かめさせた。結論：案X。本質は遅延より帯域（今の JPEG は倍率2で 95〜175 Mbit/s）。H.264 は同じページで
  4〜5 Mbit/s・30fps。穴は4つ（ページの大きさの上書きと取り込み・キーフレームの大きさ・静止中の CPU・TCP で詰まった絵）。
  CDP の base64 は原因ではない（設計役の見立ての誤り）。Chrome の中で取り込んで圧縮する案は倍率2で取り込みが毎秒 13.7 枚で律速。
  借りる先は RustDesk（TCP で H.264、要求時キーフレーム、速さの適応）。
- 同日 ユーザー「案Xで進める。まず段1」。段1 の測定役（サブエージェント 12b865ea）が (a)(b) を測り、(c) の試しのページ
  （tmp-video-probe/server.mjs）を作った。設計役が Service video-probe として起こし Publish した。
- 試しのページを Android で開くと、サーバへ頼むボタンが全部効かなかった。原因は banto の Publish：banto のログインで守った
  公開先の forward_auth の問い合わせに Upgrade・Connection を付けたまま渡し、banto 本体の upgrade の受け口が 404 を返して
  いた（公開したサービスの WebSocket が全部開けなかった）。直して release（d66bf976）。
- 2026-10-12 16:06 ごろ ユーザーが Android 10・Chrome 154 で測った（写し4枚）。数字は仕様の (c)。iPhone・1280×800・
  キーフレームの要求の描き直しは取れていない。
