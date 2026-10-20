import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocaleService } from '../core/locale.service.ts';
import { SchemaField } from './schema-field.ts';

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

// A command step's config schema, shaped as BMS's palette serves it (inlined, annotated). Its own
// copy: importing another spec file would run that file's tests again.
const FEEL = { type: 'string', 'x-atlas-type': 'feel' };
const MAPPING = { type: 'object', additionalProperties: FEEL };
const COMMAND = {
  type: 'object',
  required: ['action', 'request'],
  properties: {
    action: { type: 'string' },
    request: {
      type: 'object',
      required: ['event'],
      properties: { event: { type: 'string', 'x-choices': 'commands' }, input: MAPPING },
    },
    await: { type: 'object', properties: { correlate: FEEL, output: MAPPING } },
  },
};
const CHOICES = { commands: [{ event: 'transcode.job.create' }] };

/** A parent that holds the value, as the designer does: every emission replaces it. */
@Component({
  imports: [SchemaField],
  template: `<atlas-schema-field
    [schema]="schema"
    [value]="value()"
    [choices]="choices"
    [readOnly]="readOnly()"
    (valueChange)="value.set($event)"
  />`,
})
class Host {
  schema = COMMAND;
  choices = CHOICES;
  readonly value = signal<unknown>({ action: 'transcode', request: { event: '' } });
  readonly readOnly = signal(false);
}

function setup() {
  TestBed.configureTestingModule({ providers: [{ provide: LocaleService, useClass: FakeLocale }] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const type = (el: Element | null, value: string, event = 'input') => {
    const input = el as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event(event));
    fixture.detectChanges();
  };
  return { fixture, root, host: fixture.componentInstance, type };
}

const labelled = (root: HTMLElement, text: string) => {
  const label = [...root.querySelectorAll('label')].find((l) =>
    l.textContent?.trim().startsWith(text),
  );
  return label ? root.querySelector(`#${label.getAttribute('for')}`) : null;
};

describe('SchemaField — a property panel from a config schema', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders every property, nested objects as their own groups, required ones marked', () => {
    const t = setup();
    const names = [...t.root.querySelectorAll('label.name')].map((l) =>
      l.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(names).toEqual(['Action *', 'Event *', 'Correlate']);
    const legends = [...t.root.querySelectorAll('legend')].map((l) =>
      l.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(legends).toEqual(['Request *', 'Input', 'Await', 'Output']);
    expect(labelled(t.root, 'Correlate')?.classList.contains('feel')).toBe(true);
  });

  it('each edit emits the WHOLE new value; a blank optional field is removed', () => {
    const t = setup();
    t.type(labelled(t.root, 'Action'), 'move-online');
    expect(t.host.value()).toEqual({ action: 'move-online', request: { event: '' } });
    t.type(labelled(t.root, 'Correlate'), '= incoming.assetId = vars.assetId');
    expect(t.host.value()).toMatchObject({
      await: { correlate: '= incoming.assetId = vars.assetId' },
    });
    t.type(labelled(t.root, 'Correlate'), '');
    expect(t.host.value()).toEqual({ action: 'move-online', request: { event: '' } });
  });

  it('a closed-list field is a select of the palette’s list', () => {
    const t = setup();
    const select = labelled(t.root, 'Event') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'transcode.job.create']);
    t.type(select, 'transcode.job.create', 'change');
    expect(t.host.value()).toMatchObject({ request: { event: 'transcode.job.create' } });
  });

  it('a data mapping adds, renames and removes rows', () => {
    const t = setup();
    const input = [...t.root.querySelectorAll('fieldset')].find(
      (f) => f.querySelector('legend')?.textContent?.trim() === 'Input',
    )!;
    (input.querySelector('button') as HTMLButtonElement).click();
    t.fixture.detectChanges();
    expect(t.host.value()).toMatchObject({ request: { input: { 'vars.new1': '= ' } } });
    t.type(input.querySelector('input.key'), 'assetId', 'change');
    t.type(input.querySelector('.row input.feel'), '= vars.assetId');
    expect(t.host.value()).toMatchObject({ request: { input: { assetId: '= vars.assetId' } } });
    (input.querySelector('.row button') as HTMLButtonElement).click();
    t.fixture.detectChanges();
    expect(t.host.value()).toEqual({ action: 'transcode', request: { event: '' } });
  });

  it('read-only disables every control', () => {
    const t = setup();
    t.host.readOnly.set(true);
    t.fixture.detectChanges();
    const controls = [...t.root.querySelectorAll('input, select, textarea')] as HTMLInputElement[];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((c) => c.disabled)).toBe(true);
    expect(t.root.querySelector('button')).toBeNull();
  });
});
