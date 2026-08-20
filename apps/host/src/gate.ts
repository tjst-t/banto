/**
 * 外に出すときの門。
 *
 * この口は叩けば Claude の枠を使い、fs のツールでファイルを触れる。
 * **認証なしで外に出してはいけない。**
 *
 * 前段（Caddy 等）に認証を置けるならそちらのほうがよい——アプリに秘密を持たせずに済む。
 * ここにあるのは、前段に手が入れられないときのための最小限である。
 *
 * 弱いところを正直に書いておく：
 *  - 合言葉は1つで、失効も差し替えもコマンドを打ち直すしかない
 *  - HTTP で運ぶなら経路上で読める。**信用できる網の中でだけ使う**
 *  - 総当たりへの遅延を入れていない。合言葉を十分長くすることで代えている
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const COOKIE = 'banto_key';

/** 長さが違っても同じ時間で比べる。長さの違いだけで漏れないようにする。 */
function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // 長さが違う時点で不一致だが、比較そのものは走らせて時間を揃える。
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**
 * 通してよいかを判定する。通してよければ true。
 *
 * 合言葉は `?k=` かクッキーで受ける。`?k=` で来たらクッキーに移して URL から消す
 * ——合言葉がアドレス欄や履歴に残り続けるのを避けるため。
 */
export function passes(req: IncomingMessage, res: ServerResponse, secret: string): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const fromQuery = url.searchParams.get('k');

  if (fromQuery !== null && sameSecret(fromQuery, secret)) {
    url.searchParams.delete('k');
    res.writeHead(302, {
      'set-cookie': `${COOKIE}=${encodeURIComponent(secret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      location: `${url.pathname}${url.search}`,
    });
    res.end();
    return false; // 応答は済ませてある。呼び手は続けない。
  }

  const fromCookie = cookieValue(req.headers.cookie, COOKIE);
  if (fromCookie !== undefined && sameSecret(fromCookie, secret)) return true;

  // 断る理由を書く。黙って 404 にしない（教訓13）。
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('合言葉が要ります。 ?k=<合言葉> を付けて開いてください。\n');
  return false;
}
