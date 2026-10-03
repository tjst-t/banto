// 「ログイン中の端末」に出す、おおよその端末名（User-Agent から）。**見分けの手がかりで、認証には使わない**
// ——User-Agent は送り手がいくらでも書ける。

export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const os =
    /Android/.test(ua) ? (/Pixel [^;)]+/.exec(ua)?.[0] ?? "Android")
    : /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux"
    : undefined;
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : undefined;
  if (os && browser) return `${os} の ${browser}`;
  return os ?? browser ?? "不明な端末";
}
