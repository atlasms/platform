// The Admin panel's Settings view (EP-33.3): generated from each owner's descriptors — what a
// setting resolves to and from where, an editor per writable level validated by the owner's own
// rules, a compare-and-set save and a reset to inherited.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  SettingLevel,
  SettingView,
  SettingsView as View,
  SettingWriteInput,
} from '../../core/generated/mam.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { SettingsService } from '../../core/settings.service.ts';
import { SettingsView } from './settings-view.ts';

class FakeSettings {
  readonly lists: Subject<View>[] = [];
  readonly puts: Array<{
    key: string;
    input: SettingWriteInput;
    version?: number;
    result: Subject<SettingView>;
  }> = [];
  readonly resets: Array<{
    key: string;
    level: SettingLevel;
    version?: number;
    result: Subject<SettingView>;
  }> = [];
  list() {
    const s = new Subject<View>();
    this.lists.push(s);
    return s;
  }
  put(_area: string, key: string, input: SettingWriteInput, version?: number) {
    const result = new Subject<SettingView>();
    this.puts.push({ key, input, ...(version !== undefined ? { version } : {}), result });
    return result;
  }
  reset(_area: string, key: string, level: SettingLevel, version?: number) {
    const result = new Subject<SettingView>();
    this.resets.push({ key, level, ...(version !== undefined ? { version } : {}), result });
    return result;
  }
}

class FakeLocale {
  locale = () => 'en';
  loading = () => false;
  t(key: string): string {
    return key;
  }
  setLocale(_locale: 'en' | 'ar'): Promise<void> {
    return Promise.resolve();
  }
}

const AT = '2026-11-27T10:00:00.000Z';

const retention = (over: Partial<SettingView> = {}): SettingView => ({
  key: 'review.rejectedRetention',
  descriptor: {
    key: 'review.rejectedRetention',
    area: 'mam',
    type: 'duration',
    scope: 'channel',
    label: 'Keep rejected media for',
    description: 'How long rejected media is kept.',
  },
  resolved: { value: null, origin: 'default', overridable: true },
  levels: {},
  writable: ['channel'],
  ...over,
});

const batch = (): SettingView => ({
  key: 'sweep.batch',
  descriptor: {
    key: 'sweep.batch',
    area: 'mam',
    type: 'int',
    scope: 'deployment',
    min: 1,
    max: 1000,
    default: 100,
    restart: true,
  },
  resolved: { value: 100, origin: 'default', overridable: true },
  levels: {},
  writable: [],
});

const token = (): SettingView => ({
  key: 'export.token',
  descriptor: {
    key: 'export.token',
    area: 'mam',
    type: 'string',
    scope: 'channel',
    sensitive: true,
  },
  resolved: { origin: 'channel', overridable: false, redacted: true },
  levels: { channel: { set: true, version: 2, updatedBy: 'u', updatedAt: AT, redacted: true } },
  writable: ['channel'],
});

function setup(settings: SettingView[] = [retention()]) {
  const fake = new FakeSettings();
  TestBed.configureTestingModule({
    providers: [
      { provide: SettingsService, useValue: fake },
      { provide: LocaleService, useClass: FakeLocale },
    ],
  });
  const fixture = TestBed.createComponent(SettingsView);
  fixture.detectChanges();
  fake.lists[0]?.next({ area: 'mam', configVersion: 3, settings });
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const item = (key: string) => root.querySelector(`[data-key="mam.${key}"]`) as HTMLElement;
  const type = async (key: string, level: string, text: string) => {
    const input = item(key).querySelector(
      `form[data-level="${level}"] input, form[data-level="${level}"] select, form[data-level="${level}"] textarea`,
    ) as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(
      new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const submit = (key: string, level: string) => {
    (
      item(key).querySelector(
        `form[data-level="${level}"] button[type="submit"]`,
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
  };
  return { fixture, root, fake, item, type, submit };
}

describe('SettingsView', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders each setting from its descriptor: what is in effect, where from, an editor per writable level', () => {
    const t = setup([retention(), batch()]);
    const r = t.item('review.rejectedRetention');
    expect(r.querySelector('.title')?.textContent?.trim()).toBe('Keep rejected media for');
    expect(r.querySelector('.resolved .value')?.textContent?.trim()).toBe('settings.unset');
    expect(r.querySelector('.resolved .origin')?.textContent?.trim()).toBe(
      'settings.origin.default',
    );
    expect([...r.querySelectorAll('form.level')].map((f) => f.getAttribute('data-level'))).toEqual([
      'channel',
    ]);
    // A duration is free text with its form shown; nothing set at this level, so no reset.
    expect((r.querySelector('form input') as HTMLInputElement).placeholder).toBe('P30D');
    expect(r.querySelector('form .link')).toBeNull();

    // Nothing writable for this caller: shown, not editable; a restart-only knob says so.
    const b = t.item('sweep.batch');
    expect(b.querySelector('.resolved .value')?.textContent?.trim()).toBe('100');
    expect(b.querySelectorAll('form.level').length).toBe(0);
    expect(b.querySelector('.state')?.textContent?.trim()).toBe('settings.restart');
  });

  it("validates in the browser with the owner's rules — a bad duration cannot be saved", async () => {
    const t = setup();
    const r = () => t.item('review.rejectedRetention');
    const save = () => r().querySelector('form button[type="submit"]') as HTMLButtonElement;
    // Empty: nothing to save (that is what reset is for).
    expect(save().disabled).toBe(true);
    await t.type('review.rejectedRetention', 'channel', 'thirty days');
    expect(save().disabled).toBe(true);
    expect(r().querySelector('p.error.field')?.textContent).toContain('ISO-8601');
    await t.type('review.rejectedRetention', 'channel', 'P30D');
    expect(save().disabled).toBe(false);
    expect(r().querySelector('p.error.field')).toBeNull();
  });

  it('saves over the level’s version and shows the owner’s answer', async () => {
    const t = setup([
      retention({
        resolved: { value: 'P30D', origin: 'channel', scopeId: 'ch12', overridable: false },
        levels: {
          channel: { value: 'P30D', set: true, version: 4, updatedBy: 'u', updatedAt: AT },
        },
      }),
    ]);
    // The editor starts at the stored value.
    expect(
      (t.item('review.rejectedRetention').querySelector('form input') as HTMLInputElement).value,
    ).toBe('P30D');
    await t.type('review.rejectedRetention', 'channel', 'P7D');
    t.submit('review.rejectedRetention', 'channel');
    expect(t.fake.puts).toHaveLength(1);
    expect(t.fake.puts[0]).toMatchObject({
      key: 'review.rejectedRetention',
      input: { level: 'channel', value: 'P7D' },
      version: 4,
    });
    t.fake.puts[0]!.result.next(
      retention({
        resolved: { value: 'P7D', origin: 'channel', scopeId: 'ch12', overridable: false },
        levels: { channel: { value: 'P7D', set: true, version: 5, updatedBy: 'u', updatedAt: AT } },
      }),
    );
    t.fixture.detectChanges();
    const r = t.item('review.rejectedRetention');
    expect(r.querySelector('.resolved .value')?.textContent?.trim()).toBe('P7D');
    expect(r.querySelector('.resolved .origin')?.textContent?.trim()).toBe(
      'settings.origin.channel',
    );
  });

  it('a first value sends no version; reset to inherited is offered only where a value is set', async () => {
    const t = setup();
    await t.type('review.rejectedRetention', 'channel', 'P90D');
    t.submit('review.rejectedRetention', 'channel');
    expect(t.fake.puts[0]?.version).toBeUndefined();
    t.fake.puts[0]!.result.next(
      retention({
        resolved: { value: 'P90D', origin: 'channel', overridable: false },
        levels: {
          channel: { value: 'P90D', set: true, version: 1, updatedBy: 'u', updatedAt: AT },
        },
      }),
    );
    t.fixture.detectChanges();
    const reset = t
      .item('review.rejectedRetention')
      .querySelector('form .link') as HTMLButtonElement;
    expect(reset.textContent?.trim()).toBe('settings.reset');
    reset.click();
    expect(t.fake.resets[0]).toMatchObject({
      key: 'review.rejectedRetention',
      level: 'channel',
      version: 1,
    });
    t.fake.resets[0]!.result.next(
      retention({ levels: { channel: { set: false, version: 2, updatedBy: 'u', updatedAt: AT } } }),
    );
    t.fixture.detectChanges();
    const r = t.item('review.rejectedRetention');
    expect(r.querySelector('.resolved .origin')?.textContent?.trim()).toBe(
      'settings.origin.default',
    );
    expect(r.querySelector('form .link')).toBeNull();
    expect((r.querySelector('form input') as HTMLInputElement).value).toBe('');
  });

  it("a 409 says someone else changed it and reloads; a 422 puts the owner's reason under the level", async () => {
    const t = setup();
    await t.type('review.rejectedRetention', 'channel', 'P1D');
    t.submit('review.rejectedRetention', 'channel');
    t.fake.puts[0]!.result.error({
      status: 422,
      error: {
        message: 'mam.review.rejectedRetention is not valid',
        details: { problems: [{ message: 'too short for policy' }] },
      },
    });
    t.fixture.detectChanges();
    expect(
      t.item('review.rejectedRetention').querySelector('p.error.field')?.textContent?.trim(),
    ).toBe('too short for policy');
    // Changing the draft clears the owner's refusal.
    await t.type('review.rejectedRetention', 'channel', 'P2D');
    expect(t.item('review.rejectedRetention').querySelector('p.error.field')).toBeNull();

    t.submit('review.rejectedRetention', 'channel');
    t.fake.puts[1]!.result.error({ status: 409, error: { message: 'at version 2' } });
    t.fixture.detectChanges();
    expect(t.root.querySelector('p.error[role="alert"]')?.textContent).toContain(
      'settings.conflict',
    );
    expect(t.fake.lists).toHaveLength(2); // reloaded
  });

  it('a sensitive value is never shown — masked in effect, an empty password editor', () => {
    const t = setup([token()]);
    const r = t.item('export.token');
    expect(r.querySelector('.resolved .value')?.textContent?.trim()).toBe('••••');
    const input = r.querySelector('form input') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
  });

  it('a number is sent as a number, a choice as its option’s own value', async () => {
    const t = setup([
      { ...batch(), writable: ['deployment'] },
      {
        key: 'ui.density',
        descriptor: {
          key: 'ui.density',
          area: 'mam',
          type: 'oneOf',
          scope: 'user',
          options: [{ value: 'comfortable' }, { value: 'compact', label: 'Compact' }],
        },
        resolved: { value: 'comfortable', origin: 'default', overridable: true },
        levels: {},
        writable: ['user'],
      },
    ]);
    await t.type('sweep.batch', 'deployment', '0');
    expect(
      (t.item('sweep.batch').querySelector('form button[type="submit"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await t.type('sweep.batch', 'deployment', '250');
    t.submit('sweep.batch', 'deployment');
    expect(t.fake.puts[0]?.input).toEqual({ level: 'deployment', value: 250 });
    t.fake.puts[0]!.result.next({ ...batch(), writable: ['deployment'] });
    t.fixture.detectChanges();

    await t.type('ui.density', 'user', 'compact');
    t.submit('ui.density', 'user');
    expect(t.fake.puts[1]?.input).toEqual({ level: 'user', value: 'compact' });
  });
});
