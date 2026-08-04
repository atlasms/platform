import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { IfCanDirective } from './if-can.directive.ts';
import { SessionStore } from './session.store.ts';

@Component({
  selector: 'atlas-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IfCanDirective],
  template: `
    <button id="write" *atlasIfCan="'asset:write'">Write</button>
    <button id="delete" *atlasIfCan="'asset:delete'; strict: true; resource: ctx">Delete</button>
    <span id="approve" *atlasIfCan="'asset:approve'; else denied">Approve</span>
    <ng-template #denied><span id="denied">No approval</span></ng-template>
  `,
})
class Host {
  protected readonly ctx = { categoryPath: '/news/' };
}

describe('*atlasIfCan', () => {
  let session: SessionStore;

  beforeEach(() => {
    TestBed.resetTestingModule();
    session = TestBed.inject(SessionStore);
  });

  const render = (): HTMLElement => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  const signIn = (permissions: string[], scope?: unknown): void =>
    session.signIn({
      userId: 'u1',
      channelId: 'ch12',
      policy: {
        subjectId: 'u1',
        permVersion: 1,
        rules: [{ id: 'r', permissions, ...(scope ? { scope } : {}) }] as never,
      },
    });

  it('renders nothing without a session', () => {
    const el = render();
    expect(el.querySelector('#write')).toBeNull();
    expect(el.querySelector('#approve')).toBeNull();
  });

  it('shows a control the user holds and hides one they do not', () => {
    signIn(['asset:write'], { channelIds: ['ch12'] });
    const el = render();
    expect(el.querySelector('#write')).not.toBeNull();
    expect(el.querySelector('#delete')).toBeNull();
  });

  it('renders the else-template when refused', () => {
    signIn(['asset:write'], { channelIds: ['ch12'] });
    const el = render();
    expect(el.querySelector('#approve')).toBeNull();
    expect(el.querySelector('#denied')).not.toBeNull();
  });

  it('strict mode hides a destructive control when the context does not satisfy the scope', () => {
    // The grant covers /sports/ only; the host's context is /news/. Lenient evaluation would show
    // the button — strict is why it stays hidden.
    signIn(['asset:delete'], { channelIds: ['ch12'], categoryPaths: ['/sports/'] });
    const el = render();
    expect(el.querySelector('#delete')).toBeNull();
  });

  it('strict mode shows it when the context does satisfy the scope', () => {
    signIn(['asset:delete'], { channelIds: ['ch12'], categoryPaths: ['/news/'] });
    const el = render();
    expect(el.querySelector('#delete')).not.toBeNull();
  });

  it('SECURITY: a revoked permission removes the control without a reload', () => {
    // Matches the server's `permissions.changed` behaviour: access ends when it ends, not at the
    // next login.
    signIn(['asset:write'], { channelIds: ['ch12'] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#write')).not.toBeNull();

    signIn([], { channelIds: ['ch12'] });
    fixture.detectChanges();
    expect(el.querySelector('#write')).toBeNull();
  });
});
