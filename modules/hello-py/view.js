/**
 * hello-py が持ち込む画面（要件 C1・C14、決定20）。
 *
 * **iframe の中で走る**（`sandboxed`）。このモジュールは subprocess で、
 * しかも TypeScript ですらないので、`in-page` は名乗れない
 * ——第三者モジュールとまったく同じ立場である。
 *
 * ## ここから見えないもの
 *
 * iframe は `sandbox="allow-scripts"` で、`allow-same-origin` を**渡していない**。
 * だからこのコードは：
 *
 * - banto の cookie（合言葉）を読めない
 * - banto の DOM に触れない
 * - banto のオリジンへ fetch できない（生成元が不透明なので）
 *
 * **中身は親から postMessage で渡される。** 取りに行く手段が無いので、
 * 「渡されたものだけを描く」以外のことができない——それが狙いである。
 */
(function () {
  var root = document.getElementById('root');

  /** 親からの1通だけを受ける。**送り主を確かめる**——誰でも投げられるので。 */
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (data === null || typeof data !== 'object' || data.type !== 'banto:resource') return;

    render(data);
    // 高さを返す。**親は中身を知らない**ので、こちらから言うしかない。
    window.parent.postMessage(
      { type: 'banto:height', px: document.documentElement.scrollHeight },
      '*',
    );
  });

  function render(resource) {
    root.textContent = '';

    var head = document.createElement('p');
    head.className = 'head';
    head.textContent = 'hello-py の面（sandboxed）・' + (resource.mimeType || '形は分からない');
    root.appendChild(head);

    // **整形しない。** 渡されたものをそのまま出す（当てずっぽうで整形しない）。
    var body = document.createElement('pre');
    body.textContent = resource.text;
    root.appendChild(body);

    var proof = document.createElement('p');
    proof.className = 'proof';
    // **閉じ込められていることを、画面で見せる。** 触れないことが安全の中身なので。
    proof.textContent = 'この面から banto の cookie は ' + cookieVisibility();
    root.appendChild(proof);
  }

  function cookieVisibility() {
    try {
      // 不透明な生成元では、そもそも document.cookie が投げる（か、常に空になる）。
      return document.cookie === '' ? '見えない（空）' : '見える(!)';
    } catch (error) {
      return '見えない（触ると ' + error.name + '）';
    }
  }

  // 準備ができたと伝える。**親はこれを待ってから中身を送る**（取りこぼさないため）。
  window.parent.postMessage({ type: 'banto:ready' }, '*');
})();
