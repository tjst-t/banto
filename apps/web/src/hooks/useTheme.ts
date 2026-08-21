import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'banto.theme';

/**
 * 明暗（要件 E7）。**真実は `<html data-theme>` の1属性**で、ここはその読み書き口。
 *
 * 状態を React の側に持って属性へ写すのではなく、**属性を見て、属性を書く**
 * ——写しを持つと、`index.html` の先頭で付けた値と食い違う（規則3）。
 * あの先頭の1行が要るのは、描く前に決めないと明るい画面が一瞬出るためである。
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light'),
  );

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // 保存できない窓（プライベート等）でも切り替えは効く。
        // **できないのは「次に開いたとき覚えていること」だけ**なので、ここでは止めない。
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
