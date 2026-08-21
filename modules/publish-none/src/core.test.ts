import { describe, expect, it } from 'vitest';

import { NonePublishCore } from './core.js';

const core = new NonePublishCore();

describe('NonePublishCore', () => {
  it('host:port を URL にする', () => {
    expect(core.publish('127.0.0.1:4173')).toEqual({
      url: 'http://127.0.0.1:4173',
      reachableFrom: 'banto-host-only',
    });
  });

  // 「公開した」と「届く」は別物。URL だけ返すと、外から開けると誤解される。
  it('届く範囲を値で返す（公開したふりをしない）', () => {
    expect(core.publish('10.0.0.5:8080').reachableFrom).toBe('banto-host-only');
  });

  it('形が違えば止まる。壊れた文字列をそのまま URL にしない（規則2）', () => {
    for (const bad of ['127.0.0.1', 'no-port:', ':8080', 'host:80:80', '']) {
      expect(() => core.publish(bad)).toThrow(/host:port の形ではない/);
    }
  });

  it('port が範囲外なら止まる', () => {
    expect(() => core.publish('127.0.0.1:70000')).toThrow(/範囲外/);
  });

  // Factory は teardown で必ず呼ぶ。実装ごとに呼んでよい／いけないが変わると、
  // Factory が実装を知ることになる。
  it('unpublish は、消すものが無いことを理由として返す', () => {
    expect(core.unpublish('run-1')).toContain('畳むものは無い');
  });
});
