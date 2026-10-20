import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocaleService } from '../core/locale.service.ts';
import { FeelInput } from './feel-input.ts';

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

@Component({
  imports: [FeelInput],
  template: `<atlas-feel-input
    [value]="value()"
    [vars]="['assetId', 'verdict']"
    [readOnly]="readOnly()"
    (valueChange)="value.set($event)"
  />`,
})
class Host {
  readonly value = signal('');
  readonly readOnly = signal(false);
}

function setup() {
  TestBed.configureTestingModule({ providers: [{ provide: LocaleService, useClass: FakeLocale }] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const box = root.querySelector('input.feel') as HTMLInputElement;
  const type = (text: string) => {
    box.value = text;
    box.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const state = () => root.querySelector('.feel-input')?.getAttribute('data-state');
  const verdict = () => root.querySelector('.verdict')?.textContent?.replace(/\s+/g, ' ').trim();
  return { fixture, root, host: fixture.componentInstance, box, type, state, verdict };
}

describe('FeelInput — the FEEL editor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('judges the expression as it is typed, with publish’s own words', () => {
    const t = setup();
    expect(t.state()).toBe('empty');
    t.type('= vars.verdict = "approved"');
    expect(t.state()).toBe('ok');
    expect(t.verdict()).toBe('✓ feel.ok');
    t.type('= for x in vars.xs return x');
    expect(t.state()).toBe('error');
    expect(t.verdict()).toContain('outside the workflow expression subset');
    expect(t.box.getAttribute('aria-invalid')).toBe('true');
    t.type('= vars.verdikt = "approved"');
    expect(t.state()).toBe('warning');
    expect(t.verdict()).toBe('feel.undeclared vars.verdikt');
  });

  it('offers the subset’s names and inserts one at the caret', () => {
    const t = setup();
    t.type('= count(');
    (t.root.querySelector('button.toggle') as HTMLButtonElement).click();
    t.fixture.detectChanges();
    const offered = [...t.root.querySelectorAll('.snippets button')].map((b) =>
      b.textContent?.trim(),
    );
    expect(offered).toContain('vars.assetId');
    expect(offered).toContain('lower case()');
    t.box.setSelectionRange(8, 8);
    const asset = [...t.root.querySelectorAll('.snippets button')].find(
      (b) => b.textContent?.trim() === 'vars.assetId',
    ) as HTMLButtonElement;
    asset.click();
    t.fixture.detectChanges();
    expect(t.host.value()).toBe('= count(vars.assetId');
  });

  it('read-only: the expression is judged, nothing can be inserted', () => {
    const t = setup();
    t.host.value.set('= vars.assetId != null');
    t.host.readOnly.set(true);
    t.fixture.detectChanges();
    expect(t.box.disabled).toBe(true);
    expect(t.root.querySelector('button.toggle')).toBeNull();
    expect(t.state()).toBe('ok');
  });
});
