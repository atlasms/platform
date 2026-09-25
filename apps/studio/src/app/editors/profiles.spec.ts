// The transcode profile registry in Studio (EP-16.6): the form's model — starting targets MTS
// accepts, a body that says only what the form says, MTS's 422 placed under the field it names —
// the list, which says what resolution will do, and the editor tab: a save is a compare-and-set,
// a platform profile is read-only to a channel administrator and can be redefined for the channel.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Profile, ProfileInput } from '../core/generated/mts.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { ProfilesService, type ProfileScope } from '../core/profiles.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { ProfilesView } from '../panels/admin/profiles-view.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { ProfileEditor } from './profile-editor.ts';
import {
  KINDS,
  draftForKind,
  draftFrom,
  splitProblems,
  toInput,
  type ProfileDraft,
} from './profile.model.ts';

const stored = (input: ProfileInput, over: Partial<Profile> = {}): Profile => ({
  ...input,
  version: 1,
  createdBy: 'admin',
  createdAt: '2026-09-25T10:00:00Z',
  updatedAt: '2026-09-25T10:00:00Z',
  ...over,
});

describe('profile.model', () => {
  it('starts each kind at a target MTS accepts: broadcast is CBR 4:2:2 interlaced MXF, a proxy a quality target', () => {
    expect(toInput('broadcast', draftForKind('broadcast', 'House'))).toEqual({
      id: 'broadcast',
      name: 'House',
      kind: 'broadcast',
      container: 'mxf',
      video: {
        codec: 'mpeg2',
        width: 1920,
        height: 1080,
        fit: 'pad',
        frameRate: '25',
        scan: 'tff',
        chroma: '422',
        gpu: 'none',
        bitrateMbps: 50,
      },
      audio: { codec: 'pcm_s24le', sampleRate: 48000 },
      enabled: true,
    });
    const proxy = toInput('p', draftForKind('proxy', 'P'));
    expect(proxy.video).toEqual({
      codec: 'h264',
      width: 1280,
      height: 720,
      fit: 'pad',
      scan: 'progressive',
      chroma: '420',
      gpu: 'none',
      quality: 23,
    });
    expect(proxy.audio).toEqual({ codec: 'aac', bitrateKbps: 128 });
    // A still: no rate, scan, chroma or GPU — they do not apply to one frame — and no audio.
    const thumb = toInput('t', draftForKind('thumbnail', 'T'));
    expect(thumb).toMatchObject({ container: 'jpg' });
    expect(thumb.video).toEqual({ codec: 'h264', width: 320, height: 180, fit: 'pad' });
    expect(thumb.audio).toBeUndefined();
  });

  it('round-trips: a stored profile, as a form, is the same body again — so opening it is not an edit', () => {
    for (const kind of KINDS) {
      const input = toInput('x', draftForKind(kind, 'X'));
      expect(toInput('x', draftFrom(stored(input)))).toEqual(input);
    }
  });

  it('sends only what the form says: the other rate mode, a switched-off target and "as source" are omitted', () => {
    const d: ProfileDraft = {
      ...draftForKind('proxy', 'P'),
      rateMode: 'bitrate',
      bitrateMbps: 8,
      quality: 23, // kept in the form, not sent
      frameRate: '',
      audioCodec: 'pcm_s16le',
      bitrateKbps: 128, // AAC only — not sent for PCM
      description: '  ',
    };
    const body = toInput('p', d);
    expect(body.video).toMatchObject({ bitrateMbps: 8 });
    expect(body.video).not.toHaveProperty('quality');
    expect(body.video).not.toHaveProperty('frameRate');
    expect(body.audio).toEqual({ codec: 'pcm_s16le' });
    expect(body).not.toHaveProperty('description');
    expect(toInput('p', { ...d, hasVideo: false })).not.toHaveProperty('video');
    // Switching a target off and on gives back what was there.
    expect(toInput('p', { ...d, hasVideo: true }).video).toEqual(body.video);
  });

  it("places MTS's rules: a field's under the field, a combination above the form, text unchanged", () => {
    expect(
      splitProblems(
        'name is required; video.width must be an even whole number from 16 to 7680; mp4 carries h264 video; video: give bitrateMbps or quality, not both; video.gpu applies to h264 only',
      ),
    ).toEqual({
      fields: {
        name: ['name is required'],
        'video.width': ['video.width must be an even whole number from 16 to 7680'],
        'video.gpu': ['video.gpu applies to h264 only'],
      },
      general: ['mp4 carries h264 video', 'video: give bitrateMbps or quality, not both'],
    });
  });
});

class FakeProfiles {
  readonly lists: Subject<Profile[]>[] = [];
  readonly gets: { id: string; scope: ProfileScope; result: Subject<Profile> }[] = [];
  readonly creates: { body: ProfileInput; result: Subject<Profile> }[] = [];
  readonly replaces: {
    id: string;
    body: ProfileInput & { version: number };
    scope: ProfileScope;
    result: Subject<Profile>;
  }[] = [];
  list() {
    const s = new Subject<Profile[]>();
    this.lists.push(s);
    return s;
  }
  get(id: string, scope: ProfileScope) {
    const result = new Subject<Profile>();
    this.gets.push({ id, scope, result });
    return result;
  }
  create(body: ProfileInput) {
    const result = new Subject<Profile>();
    this.creates.push({ body, result });
    return result;
  }
  replace(id: string, body: ProfileInput & { version: number }, scope: ProfileScope) {
    const result = new Subject<Profile>();
    this.replaces.push({ id, body, scope, result });
    return result;
  }
}

/** A channel administrator (config:admin in ch12), or with `platform`, an unscoped one. */
function configure(permissions: string[] = ['config:admin'], platform = false) {
  localStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: ProfilesService, useValue: new FakeProfiles() },
      { provide: LocaleService, useValue: { t: (k: string) => k } },
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: 'admin',
    channelId: 'ch12',
    policy: {
      subjectId: 'admin',
      permVersion: 1,
      rules: [{ id: 'r', permissions, ...(platform ? {} : { scope: { channelIds: ['ch12'] } }) }],
    },
  });
  return {
    api: TestBed.inject(ProfilesService) as unknown as FakeProfiles,
    editors: TestBed.inject(EditorStore),
  };
}

const houseBroadcast = (channelId?: string, over: Partial<Profile> = {}) =>
  stored(
    {
      ...toInput('broadcast', draftForKind('broadcast', channelId ? 'House' : 'Platform')),
      ...(channelId ? { channelId } : {}),
    },
    over,
  );

describe('ProfilesView', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists in resolution order and says what each row means; a channel admin creates in the channel only', () => {
    const { api, editors } = configure();
    const fixture = TestBed.createComponent(ProfilesView);
    fixture.detectChanges();
    api.lists[0]?.next([
      houseBroadcast(undefined),
      stored(
        { ...toInput('fast-proxy', draftForKind('proxy', 'Fast')), enabled: false },
        {
          channelId: 'ch12',
        },
      ),
      houseBroadcast('ch12'),
    ]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const rows = Array.from(root.querySelectorAll('.items button')).map((b) =>
      Array.from(b.querySelectorAll('span'))
        .map((s) => s.textContent?.trim())
        .join(' '),
    );
    expect(rows).toEqual([
      // The channel's first: it is what the channel resolves to.
      'House broadcast admin.scopeChannel admin.profileBuiltIn',
      'Platform broadcast admin.platformWide admin.profileOverridden',
      'Fast fast-proxy admin.scopeChannel admin.profileDisabled',
    ]);
    // A channel administrator is not offered the platform scope — MTS would refuse it.
    expect(root.querySelector('select[name=scope]')).toBeNull();

    const view = fixture.componentInstance as unknown as {
      id: string;
      name: string;
      kind: ProfileInput['kind'];
      create(): void;
    };
    view.id = 'Bad Id';
    view.name = 'Bad';
    view.create();
    expect(api.creates).toHaveLength(0);

    view.id = 'house-proxy';
    view.name = 'House proxy';
    view.kind = 'proxy';
    view.create();
    expect(api.creates[0]?.body).toEqual(
      toInput('house-proxy', draftForKind('proxy', 'House proxy')),
    );
    expect(api.creates[0]?.body).not.toHaveProperty('channelId');
    api.creates[0]?.result.next(stored(api.creates[0].body, { channelId: 'ch12' }));
    fixture.detectChanges();
    expect(editors.activeTab()?.type).toBe('profile');
    expect(editors.activeTab()?.resourceId).toBe('channel/house-proxy');

    view.id = 'broadcast';
    view.name = 'Again';
    view.create();
    api.creates[1]?.result.error({ status: 409, error: { message: 'exists' } });
    fixture.detectChanges();
    expect(root.textContent).toContain('admin.profileIdTaken');
  });

  it('offers the platform scope to an unscoped administrator, and a platform create says so in the body', () => {
    const { api, editors } = configure(['config:admin'], true);
    const fixture = TestBed.createComponent(ProfilesView);
    fixture.detectChanges();
    api.lists[0]?.next([]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('summary') as HTMLElement).click();
    fixture.detectChanges();
    expect(root.querySelector('select[name=scope]')).not.toBeNull();
    const view = fixture.componentInstance as unknown as {
      id: string;
      name: string;
      scope: ProfileScope;
      create(): void;
    };
    view.id = 'broadcast';
    view.name = 'Platform';
    view.scope = 'platform';
    view.create();
    expect(api.creates[0]?.body.channelId).toBeNull();
    api.creates[0]?.result.next(stored(api.creates[0].body));
    expect(editors.activeTab()?.resourceId).toBe('platform/broadcast');
  });

  it('shows a reader the registry with no create form', () => {
    const { api } = configure(['config:read']);
    const fixture = TestBed.createComponent(ProfilesView);
    fixture.detectChanges();
    api.lists[0]?.next([houseBroadcast('ch12')]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('details.new')).toBeNull();
    expect(root.querySelectorAll('.items button')).toHaveLength(1);
  });
});

describe('ProfileEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function open(ref: string, t: ReturnType<typeof configure>) {
    t.editors.open({ type: 'profile', resourceId: ref, title: ref });
    const tabId = t.editors.activeTab()!.id;
    const fixture = TestBed.createComponent(ProfileEditor);
    fixture.componentRef.setInput('profileRef', ref);
    fixture.componentRef.setInput('tabId', tabId);
    fixture.detectChanges();
    const editor = fixture.componentInstance as unknown as {
      set<K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]): void;
      save(): void;
      reload(): void;
      redefine(): void;
    };
    return { fixture, editor, tabId, root: fixture.nativeElement as HTMLElement };
  }

  it("saves the whole profile with the version it read; MTS's 422 lands under the field; a 409 offers a reload, never a retry", () => {
    const t = configure();
    const { fixture, editor, tabId, root } = open('channel/broadcast', t);
    expect(t.api.gets[0]).toMatchObject({ id: 'broadcast', scope: 'channel' });
    t.api.gets[0]?.result.next(houseBroadcast('ch12', { version: 3 }));
    fixture.detectChanges();
    const save = () => root.querySelector('button[type=submit]') as HTMLButtonElement;
    expect(save().disabled).toBe(true); // nothing changed yet

    editor.set('width', 1280);
    editor.set('height', 720);
    fixture.detectChanges();
    expect(save().disabled).toBe(false);
    expect(t.editors.activeTab()?.id).toBe(tabId);
    expect(t.editors.activeTab()?.dirty).toBe(true);

    editor.save();
    const sent = t.api.replaces[0]!;
    expect(sent.id).toBe('broadcast');
    expect(sent.scope).toBe('channel');
    expect(sent.body.version).toBe(3);
    expect(sent.body.video).toMatchObject({ width: 1280, height: 720, bitrateMbps: 50 });

    sent.result.error({
      status: 422,
      error: {
        message: 'video.width must be an even whole number from 16 to 7680; mxf audio is 48 kHz',
      },
    });
    fixture.detectChanges();
    const widthLabel = root.querySelector('input[name=width]')!.closest('label')!;
    expect(widthLabel.textContent).toContain('video.width must be an even whole number');
    expect(root.querySelector('.problems')?.textContent).toContain('mxf audio is 48 kHz');

    // Someone else saved meanwhile: said so, and the way on is a reload — not a quiet retry.
    editor.save();
    t.api.replaces[1]?.result.error({ status: 409, error: { message: 'version' } });
    fixture.detectChanges();
    expect(root.textContent).toContain('admin.profileConflict');
    expect(t.api.replaces).toHaveLength(2);
    editor.reload();
    t.api.gets[1]?.result.next(houseBroadcast('ch12', { version: 4, name: 'Theirs' }));
    fixture.detectChanges();
    expect(root.textContent).not.toContain('admin.profileConflict');
    expect(root.querySelector('h2')?.textContent).toBe('Theirs');
    expect(t.editors.activeTab()?.dirty).toBe(false);

    // A successful save adopts what MTS stored — its version is the next save's.
    editor.set('enabled', false);
    editor.save();
    t.api.replaces[2]?.result.next(houseBroadcast('ch12', { version: 5, enabled: false }));
    fixture.detectChanges();
    expect(root.textContent).toContain('v5');
    expect(t.editors.activeTab()?.dirty).toBe(false);
  });

  it('shows a platform profile read-only to a channel administrator, and redefines it for the channel', () => {
    const t = configure();
    const { fixture, editor, root } = open('platform/broadcast', t);
    expect(t.api.gets[0]?.scope).toBe('platform');
    t.api.gets[0]?.result.next(houseBroadcast(undefined));
    fixture.detectChanges();
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
    expect(root.querySelector('button[type=submit]')).toBeNull();
    expect(root.textContent).toContain('admin.profileRedefine');

    editor.redefine();
    const body = t.api.creates[0]!.body;
    expect(body).not.toHaveProperty('channelId'); // the caller's channel
    expect(body).toEqual(toInput('broadcast', draftFrom(houseBroadcast(undefined))));
    t.api.creates[0]?.result.next(stored(body, { channelId: 'ch12' }));
    expect(t.editors.activeTab()?.resourceId).toBe('channel/broadcast');

    // Already redefined: that is the one to open.
    t.editors.open({ type: 'profile', resourceId: 'platform/broadcast', title: 'x' });
    editor.redefine();
    t.api.creates[1]?.result.error({ status: 409, error: { message: 'exists' } });
    expect(t.editors.activeTab()?.resourceId).toBe('channel/broadcast');
  });

  it('lets an unscoped administrator edit a platform profile, and a reader edit nothing', () => {
    const admin = configure(['config:admin'], true);
    const a = open('platform/broadcast', admin);
    admin.api.gets[0]?.result.next(houseBroadcast(undefined));
    a.fixture.detectChanges();
    expect(a.root.querySelector('fieldset')?.disabled).toBe(false);
    expect(a.root.textContent).not.toContain('admin.profileRedefine');

    TestBed.resetTestingModule();
    const reader = configure(['config:read']);
    const r = open('channel/broadcast', reader);
    reader.api.gets[0]?.result.next(houseBroadcast('ch12'));
    r.fixture.detectChanges();
    expect(r.root.querySelector('fieldset')?.disabled).toBe(true);
    expect(r.root.textContent).not.toContain('admin.profileRedefine');
  });
});
