// **どこでも動く UUID（v4）**（2026-10-03、ユーザー報告：携帯から送れなかった）。
//
// `crypto.randomUUID()` は**安全な文脈（HTTPS か localhost）でしか定義されない**——LAN の IP を http で開いた携帯
// などでは「crypto.randomUUID is not a function」で送信ごと落ちていた（古い iOS Safari〈15.4 未満〉にも無い）。
// `crypto.getRandomValues()` は安全でない文脈でも使えるので、無いときはそれで同じ形を作る。
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
