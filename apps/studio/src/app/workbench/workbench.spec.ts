// EP-11.6 — the workbench under RTL.
//
// EP-11.6 set `dir="rtl"` on <html> and stopped there. The workbench is a CSS grid, and grid tracks
// run along the INLINE axis, so `dir="rtl"` moves the activity bar and side bar to the right of the
// screen and the divider's "grow" direction with them. The drag arithmetic and the arrow keys kept
// measuring in physical pixels, so in Arabic the side bar shrank when you dragged it open.
//
// It also renders the panel names, and those were the one part of the shell EP-11.6 never
// translated: the activity bar printed a hard-coded English `title` while `workbench.panels.*`
// sat unused in both locale files.

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../core/auth.service.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { PANELS } from './panels.ts';
import { Workbench } from './workbench.ts';

/** Translations exist for every key, so an untranslated string in the output is visible as English. */
class FakeLocale {
  readonly dir = signal<'ltr' | 'rtl'>('ltr');
  locale = () => (this.dir() === 'rtl' ? 'ar' : 'en');
  direction = () => this.dir();
  loading = () => false;
  t(key: string): string {
    const ar: Record<string, string> = {
      'workbench.panels.media': 'الوسائط',
      'workbench.panels.schedule': 'الجدولة',
      'workbench.panels.notBuilt': 'لم يُبنَ بعد',
    };
    return this.dir() === 'rtl' ? (ar[key] ?? key) : key;
  }
  setLocale() {
    return Promise.resolve();
  }
}

class FakeAuth {
  token = () => 'test-token';
  signOut() {
    return Promise.resolve();
  }
}

interface InternalWorkbench {
  sideBarWidth: () => number;
  minWidth: number;
  maxWidth: number;
  onResizeKey(event: KeyboardEvent): void;
  startResize(event: PointerEvent): void;
  panelTitle(panel: (typeof PANELS)[number]): string;
}

function setup() {
  const locale = new FakeLocale();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: LocaleService, useValue: locale },
      { provide: AuthService, useValue: new FakeAuth() },
    ],
  });
  // Left signed OUT on purpose: an authenticated session opens the dashboard tab and connects the
  // websocket, neither of which this file is about.
  TestBed.inject(SessionStore).signOut();
  const fixture = TestBed.createComponent(Workbench);
  return { fixture, component: fixture.componentInstance as unknown as InternalWorkbench, locale };
}

/** The divider element, with the pointer-capture jsdom does not implement stubbed out. */
function divider(fixture: ReturnType<typeof setup>['fixture']): HTMLElement {
  const el = fixture.nativeElement.querySelector('.resizer') as HTMLElement;
  el.setPointerCapture = () => undefined;
  return el;
}

/**
 * Start a drag by dispatching on the divider itself rather than calling `startResize` with a
 * hand-made event: `Event.target` is read-only, and the handler reads it to attach the move
 * listeners. Going through the real template binding is also what the user does.
 */
const dragFrom = (el: HTMLElement, clientX: number): void => {
  el.dispatchEvent(new MouseEvent('pointerdown', { clientX, cancelable: true }));
};

const moveTo = (el: HTMLElement, clientX: number): void => {
  el.dispatchEvent(new MouseEvent('pointermove', { clientX }));
};

describe('Workbench', () => {
  beforeEach(() => TestBed.resetTestingModule());

  describe('the side-bar divider', () => {
    it('LTR: dragging right widens the side bar', () => {
      const { fixture, component } = setup();
      fixture.detectChanges();
      const el = divider(fixture);
      const start = component.sideBarWidth();

      dragFrom(el, 300);
      moveTo(el, 360);
      expect(component.sideBarWidth()).toBe(start + 60);
    });

    it('RTL: dragging LEFT widens the side bar, because the side bar is on the right', () => {
      const { fixture, component, locale } = setup();
      locale.dir.set('rtl');
      fixture.detectChanges();
      const el = divider(fixture);
      const start = component.sideBarWidth();

      dragFrom(el, 300);
      moveTo(el, 240);
      expect(component.sideBarWidth()).toBe(start + 60);

      // ...and dragging right closes it, rather than widening it off the screen.
      moveTo(el, 360);
      expect(component.sideBarWidth()).toBe(start - 60);
    });

    it('the arrow keys follow the same inline axis the drag does', () => {
      const { fixture, component, locale } = setup();
      fixture.detectChanges();
      const start = component.sideBarWidth();

      component.onResizeKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      expect(component.sideBarWidth()).toBe(start + 10);

      locale.dir.set('rtl');
      component.onResizeKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      expect(component.sideBarWidth()).toBe(start); // back where it started
    });

    it('Shift is the coarse step, and the width stays inside its bounds', () => {
      const { fixture, component } = setup();
      fixture.detectChanges();

      component.onResizeKey(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true }));
      expect(component.sideBarWidth()).toBe(290); // 240 + the coarse 50, not the fine 10

      for (let i = 0; i < 20; i++) {
        component.onResizeKey(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true }));
      }
      expect(component.sideBarWidth()).toBe(component.minWidth);
    });

    it('a key that is not an arrow is left to the browser', () => {
      const { fixture, component } = setup();
      fixture.detectChanges();
      const start = component.sideBarWidth();

      const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
      component.onResizeKey(event);
      expect(component.sideBarWidth()).toBe(start);
      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe('panel names', () => {
    it('are translated, not hard-coded English', () => {
      const { fixture, component, locale } = setup();
      locale.dir.set('rtl');
      fixture.detectChanges();

      const media = PANELS.find((p) => p.id === 'media')!;
      expect(media.titleKey).toBe('workbench.panels.media');
      expect(component.panelTitle(media)).toBe('الوسائط');
    });

    it('an unbuilt panel says so in the reader’s language too', () => {
      const { fixture, component, locale } = setup();
      locale.dir.set('rtl');
      fixture.detectChanges();

      const schedule = PANELS.find((p) => p.id === 'schedule')!;
      expect(schedule.available).toBe(false);
      expect(component.panelTitle(schedule)).toBe('الجدولة — لم يُبنَ بعد');
    });

    it('every panel names a key both locale files actually carry', async () => {
      // The keys used to cover six of eleven panels, so five would have rendered their raw key.
      const [en, ar] = await Promise.all([
        import('../../locales/en.json').then((m) => m.default as unknown),
        import('../../locales/ar.json').then((m) => m.default as unknown),
      ]);
      const read = (src: unknown, key: string): unknown =>
        key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], src);

      for (const panel of PANELS) {
        expect(read(en, panel.titleKey), `en: ${panel.titleKey}`).toBeTypeOf('string');
        expect(read(ar, panel.titleKey), `ar: ${panel.titleKey}`).toBeTypeOf('string');
      }
      expect(read(en, 'workbench.panels.notBuilt')).toBeTypeOf('string');
      expect(read(ar, 'workbench.panels.notBuilt')).toBeTypeOf('string');
    });
  });
});
