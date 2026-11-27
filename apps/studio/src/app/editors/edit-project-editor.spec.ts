import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetsService } from '../core/assets.service.ts';
import { EditProjectsService, type Timeline } from '../core/edit-projects.service.ts';
import type { Asset, EditProject, FileRef } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { MediaService } from '../core/media.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { By } from '@angular/platform-browser';
import { EditPlayer } from './edit-player.ts';
import { EditProjectEditor } from './edit-project-editor.ts';

const SOURCE = '01K00000000000000000000SRC';
const OUTPUT = '01K00000000000000000000OUT';

const project = (overrides: Partial<EditProject> = {}): EditProject =>
  ({
    id: 'P1',
    sourceAssetId: SOURCE,
    mediaKind: 'video',
    state: 'draft',
    timeline: { clips: [{ renditionRef: 'original', inSec: 1, outSec: 5 }] },
    outputProfile: 'proxy',
    version: 2,
    createdBy: 'u1',
    createdAt: '2026-11-23T09:00:00.000Z',
    updatedAt: '2026-11-23T09:00:00.000Z',
    ...overrides,
  }) as EditProject;

const source = {
  id: SOURCE,
  channelId: 'ch12',
  title: 'Evening bulletin',
  mediaType: 'video',
  state: 'ready',
  createdBy: 'u1',
} as Asset;

class FakeProjects {
  readonly gets: Subject<EditProject>[] = [];
  readonly saves: Array<{
    version: number;
    body: { timeline: Timeline; outputProfile?: string };
    result: Subject<EditProject>;
  }> = [];
  readonly renders: Array<{ body: object; result: Subject<EditProject> }> = [];
  get(_id: string) {
    const s = new Subject<EditProject>();
    this.gets.push(s);
    return s;
  }
  save(_id: string, version: number, body: { timeline: Timeline; outputProfile?: string }) {
    const result = new Subject<EditProject>();
    this.saves.push({ version, body, result });
    return result;
  }
  render(_id: string, body: object) {
    const result = new Subject<EditProject>();
    this.renders.push({ body, result });
    return result;
  }
}

const DEFAULT_FILES = [{ kind: 'original' }, { kind: 'proxy', variant: 'edit' }] as FileRef[];

function setup(canWrite = true, files: FileRef[] = DEFAULT_FILES) {
  const signed: string[] = [];
  const projects = new FakeProjects();
  const events = new Subject<{ subject: string; payload: unknown }>();
  const subscribed: string[] = [];
  const dirty: boolean[] = [];
  const opened: string[] = [];
  TestBed.configureTestingModule({
    providers: [
      { provide: EditProjectsService, useValue: projects },
      {
        provide: AssetsService,
        useValue: {
          get: () => of(source),
          files: () => of(files),
        },
      },
      {
        provide: MediaService,
        useValue: {
          url: (_a: string, kind: string, variant?: string) => {
            signed.push(variant ? `${kind}/${variant}` : kind);
            return of({ url: `/media/v1/${kind}?sig=x`, expiresAt: '2099-01-01T00:00:00Z' });
          },
          text: () => of('WEBVTT\n'),
        },
      },
      { provide: PermissionService, useValue: { can: () => canWrite } },
      { provide: SessionStore, useValue: { channelId: signal('ch12') } },
      {
        provide: WebSocketService,
        useValue: {
          events$: events,
          state: signal('connected'),
          subscribe: (p: string) => {
            subscribed.push(p);
            return Promise.resolve({ ok: true });
          },
        },
      },
      {
        provide: EditorStore,
        useValue: {
          setDirty: (_t: string, d: boolean) => dirty.push(d),
          open: (d: { resourceId: string }) => opened.push(d.resourceId),
        },
      },
      { provide: LocaleService, useValue: { t: (k: string) => k, locale: () => 'en' } },
    ],
  });
  const fixture = TestBed.createComponent(EditProjectEditor);
  fixture.componentRef.setInput('projectId', 'P1');
  fixture.componentRef.setInput('tabId', 'edit-project:P1');
  fixture.componentRef.setInput('pollMs', 1_000);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const answer = (p: EditProject) => {
    projects.gets.at(-1)!.next(p);
    fixture.detectChanges();
  };
  const inputs = () => [...root.querySelectorAll('input.tc')] as HTMLInputElement[];
  const type = (el: HTMLInputElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const button = (selector: string) => root.querySelector(selector) as HTMLButtonElement;
  const click = (selector: string) => {
    button(selector).click();
    fixture.detectChanges();
  };
  return {
    signed,
    projects,
    events,
    subscribed,
    dirty,
    opened,
    fixture,
    root,
    answer,
    inputs,
    type,
    button,
    click,
  };
}

describe('EditProjectEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.useRealTimers());

  it('shows the timeline as clips with timecodes, from the source’s files', () => {
    const t = setup();
    t.answer(project());
    expect(t.inputs().map((i) => i.value)).toEqual(['00:00:01.000', '00:00:05.000']);
    const options = [...t.root.querySelectorAll('tbody td:nth-child(2) select option')].map(
      (o) => o.textContent,
    );
    expect(options.map((o) => o?.trim())).toEqual(['original', 'proxy/edit']);
    expect(t.root.textContent).toContain('Evening bulletin');
    expect(t.subscribed).toEqual(['live.ch12.transcode.progress']);
  });

  it('trims, adds and reorders clips, then saves them compare-and-set on the version read', () => {
    const t = setup();
    t.answer(project());
    expect(t.button('button.save').disabled).toBe(true);
    t.type(t.inputs()[1]!, '00:00:04.500');
    expect(t.dirty.at(-1)).toBe(true);
    expect(t.button('button.render').disabled).toBe(true); // save first
    t.click('button.add');
    t.type(t.inputs()[3]!, '00:00:09');
    t.click('tbody tr:nth-child(2) button.up');
    t.click('button.save');
    expect(t.projects.saves[0]!.version).toBe(2);
    expect(t.projects.saves[0]!.body).toEqual({
      timeline: {
        clips: [
          { renditionRef: 'original', inSec: 4.5, outSec: 9 },
          { renditionRef: 'original', inSec: 1, outSec: 4.5 },
        ],
      },
      outputProfile: 'proxy',
    });
    t.projects.saves[0]!.result.next(project({ version: 3 }));
    t.fixture.detectChanges();
    expect(t.dirty.at(-1)).toBe(false);
  });

  it('refuses a bad timecode in the form, before MAM is asked; places MAM’s 422 under its clip', () => {
    const t = setup();
    t.answer(project());
    t.type(t.inputs()[0]!, 'soon');
    t.click('button.save');
    expect(t.projects.saves).toHaveLength(0);
    expect(t.root.querySelector('.field-error')?.textContent).toContain('editProject.badTimecode');

    t.type(t.inputs()[0]!, '00:00:02');
    t.click('button.save');
    t.projects.saves[0]!.result.error(
      new HttpErrorResponse({
        status: 422,
        error: {
          message: 'the edit project has 1 problem',
          details: { problems: [{ path: 'timeline/clips/0/outSec', message: 'too long' }] },
        },
      }),
    );
    t.fixture.detectChanges();
    expect(t.root.textContent).toContain('too long');
  });

  it('a 409 is a reload offered, never a retry', () => {
    const t = setup();
    t.answer(project());
    t.type(t.inputs()[1]!, '00:00:03');
    t.click('button.save');
    t.projects.saves[0]!.result.error(new HttpErrorResponse({ status: 409, error: {} }));
    t.fixture.detectChanges();
    expect(t.root.textContent).toContain('editProject.conflict');
    expect(t.projects.saves).toHaveLength(1);
  });

  it('renders as the source’s next version, follows live progress, and opens the rendered asset', () => {
    vi.useFakeTimers();
    const t = setup();
    t.answer(project());
    t.click('button.render');
    expect(t.projects.renders[0]!.body).toEqual({ outputProfile: 'proxy', targetAssetId: SOURCE });
    t.projects.renders[0]!.result.next(
      project({ state: 'rendering', version: 3, outputAssetId: OUTPUT, targetAssetId: SOURCE }),
    );
    t.fixture.detectChanges();
    expect(t.root.querySelector('progress')).not.toBeNull();

    const frame = (assetId: string, percent: number) => {
      t.events.next({
        subject: 'live.ch12.transcode.progress',
        payload: { payload: { jobId: 'J', assetId, percent } },
      });
      t.fixture.detectChanges();
    };
    frame('01K00000000000000000000XYZ', 90); // another asset's: ignored
    frame(OUTPUT, 40);
    frame(OUTPUT, 20); // late, out of order: never backwards
    expect((t.root.querySelector('progress') as HTMLProgressElement).value).toBe(40);

    // The poll finds it rendered.
    vi.advanceTimersByTime(1_000);
    t.answer(project({ state: 'rendered', version: 4, outputAssetId: OUTPUT, renderJobId: 'J' }));
    expect(t.root.querySelector('progress')).toBeNull();
    t.click('.done button.link');
    expect(t.opened).toEqual([OUTPUT]);
  });

  it('shows why a render failed', () => {
    const t = setup();
    t.answer(
      project({
        state: 'failed',
        failure: { code: 'COMMAND_REFUSED', message: 'output profile thumbnail makes a thumbnail' },
      }),
    );
    expect(t.root.querySelector('[role=alert]')?.textContent).toContain('makes a thumbnail');
  });

  it('offers no edit to a caller without core write — the form is read only', () => {
    const t = setup(false);
    t.answer(project());
    expect(t.root.querySelector('button.save')).toBeNull();
    expect((t.root.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
  });

  it('EP-26.5: a transition in, its overlap and a filter, chosen per clip and saved with the timeline', () => {
    const t = setup();
    t.answer(
      project({
        timeline: {
          clips: [
            { renditionRef: 'original', inSec: 1, outSec: 5 },
            { renditionRef: 'original', inSec: 8, outSec: 12 },
          ],
        },
      }),
    );
    const transitions = () =>
      [...t.root.querySelectorAll('td.transition select')] as HTMLSelectElement[];
    expect(transitions()[0]!.disabled).toBe(true); // nothing before the first clip
    const pick = transitions()[1]!;
    pick.value = 'fade-black';
    pick.dispatchEvent(new Event('change'));
    t.fixture.detectChanges();
    t.type(t.root.querySelector('input.secs') as HTMLInputElement, '0.75');
    const grayscale = [
      ...t.root.querySelectorAll('td.filters input[type=checkbox]'),
    ][0] as HTMLInputElement;
    grayscale.click();
    t.fixture.detectChanges();
    t.click('button.save');
    expect(t.projects.saves[0]!.body.timeline.clips).toEqual([
      { renditionRef: 'original', inSec: 1, outSec: 5, filters: ['grayscale'] },
      {
        renditionRef: 'original',
        inSec: 8,
        outSec: 12,
        transitionIn: 'fade-black',
        transitionSec: 0.75,
      },
    ]);
  });

  it('EP-26.4: a video project plays its editing proxy; marks land in the selected clip, and selecting a clip seeks to its in', () => {
    const online = { tier: 'online', status: 'available' };
    const t = setup(true, [
      { kind: 'original', storage: { path: '/o', ...online } },
      { kind: 'proxy', variant: 'edit', frameRate: 25, storage: { path: '/e', ...online } },
    ] as FileRef[]);
    t.answer(
      project({
        timeline: {
          clips: [
            { renditionRef: 'original', inSec: 1, outSec: 5 },
            { renditionRef: 'original', inSec: 8, outSec: 12 },
          ],
        },
      }),
    );
    expect(t.signed).toEqual(['proxy/edit']);
    const player = t.fixture.debugElement.query(By.directive(EditPlayer));
    expect(player).not.toBeNull();
    const video = t.root.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/media/v1/proxy?sig=x');

    // The first clip is selected to begin with; a mark writes its in, as a timecode.
    expect(t.root.querySelector('tbody tr')!.getAttribute('aria-selected')).toBe('true');
    (player.componentInstance as EditPlayer).mark.emit({ which: 'in', sec: 1.04 });
    t.fixture.detectChanges();
    expect(t.inputs()[0]!.value).toBe('00:00:01.040');
    expect(t.dirty.at(-1)).toBe(true);

    // Selecting the second puts the playhead on its in (the middle of frame 200), and marks go there.
    t.click('tbody tr:nth-child(2) button.select');
    expect(video.currentTime).toBeCloseTo(8.02, 6);
    (player.componentInstance as EditPlayer).mark.emit({ which: 'out', sec: 11.52 });
    t.fixture.detectChanges();
    expect(t.inputs().map((i) => i.value)).toEqual([
      '00:00:01.040',
      '00:00:05.000',
      '00:00:08.000',
      '00:00:11.520',
    ]);
    // Reordering carries the selection with the clip.
    t.click('tbody tr:nth-child(2) button.up');
    expect(t.root.querySelector('tbody tr')!.getAttribute('aria-selected')).toBe('true');
  });

  it('EP-26.4: no player for an audio project, and none offers marks to a reader', () => {
    const audio = setup();
    audio.answer(project({ mediaKind: 'audio' }));
    expect(audio.root.querySelector('atlas-edit-player')).toBeNull();
    TestBed.resetTestingModule();
    const online = { tier: 'online', status: 'available' };
    const reader = setup(false, [
      { kind: 'proxy', variant: 'edit', frameRate: 25, storage: { path: '/e', ...online } },
    ] as FileRef[]);
    reader.answer(project());
    expect(reader.root.querySelector('video')).not.toBeNull();
    expect(reader.root.querySelector('button.mark-in')).toBeNull();
  });
});
