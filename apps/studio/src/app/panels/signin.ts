import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../core/auth.service.ts';
import { LocaleService } from '../core/locale.service.ts';

/**
 * The sign-in screen: the whole viewport, no workbench around it. It is a top-level route, not a
 * panel — the frame does not exist before there is a session (app.routes.ts) — so it carries the
 * one control a signed-out person still needs, the language.
 */
@Component({
  selector: 'atlas-signin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <form class="signin" (ngSubmit)="submit()">
      <h1>{{ locale.t('app.title') }}</h1>

      <label for="username">{{ locale.t('auth.username') }}</label>
      <!-- A full-screen page whose only purpose is this form: focusing its first field is what the
           user came for, and nothing precedes it that focus would skip. -->
      <!-- eslint-disable @angular-eslint/template/no-autofocus -->
      <input
        id="username"
        name="username"
        autocomplete="username"
        autofocus
        [(ngModel)]="username"
        [disabled]="auth.busy()"
        required
      />
      <!-- eslint-enable @angular-eslint/template/no-autofocus -->

      <label for="password">{{ locale.t('auth.password') }}</label>
      <input
        id="password"
        name="password"
        type="password"
        autocomplete="current-password"
        [(ngModel)]="password"
        [disabled]="auth.busy()"
        required
      />

      @if (error()) {
        <!-- role="alert" so a screen reader announces it: a failure the user cannot perceive is a
             form that silently does nothing. -->
        <p class="error" role="alert">{{ error() }}</p>
      }

      <button type="submit" [disabled]="auth.busy()">
        {{ auth.busy() ? locale.t('auth.signingIn') : locale.t('auth.signIn') }}
      </button>

      <select
        class="language"
        [value]="locale.locale()"
        (change)="onLocaleChange($event)"
        [disabled]="locale.loading()"
        aria-label="Language"
      >
        <option value="en">English</option>
        <option value="ar">العربية</option>
      </select>
    </form>
  `,
  styles: `
    :host {
      display: grid;
      place-items: center;
      min-block-size: 100dvh;
      color: var(--color-fg);
      background: var(--color-bg);
    }
    .signin {
      display: grid;
      gap: 0.5rem;
      inline-size: min(22rem, calc(100vw - 2rem));
      padding: 2rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-bg-raised);
    }
    h1 {
      margin: 0 0 0.5rem;
      font-size: 1.25rem;
    }
    .error {
      margin: 0;
      color: var(--color-danger);
    }
    button {
      margin-top: 0.5rem;
    }
    .language {
      margin-top: 1rem;
      justify-self: end;
    }
  `,
})
export class SignIn {
  protected readonly auth = inject(AuthService);
  protected readonly locale = inject(LocaleService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected username = '';
  protected password = '';
  protected readonly error = signal('');

  protected async submit(): Promise<void> {
    this.error.set('');
    try {
      await this.auth.signIn(this.username, this.password);
      await this.router.navigateByUrl(this.returnUrl());
    } catch {
      // ONE message for every failure, matching what IAM returns. Distinguishing "no such user"
      // from "wrong password" here would rebuild the account-enumeration oracle the server
      // deliberately refuses to be.
      this.error.set('Invalid username or password.');
    }
  }

  /**
   * Where the guard sent us from, so a deep link survives the sign-in. Only a path within this
   * app: `//host` would be a redirect to somewhere else, and the query string is caller input.
   */
  private returnUrl(): string {
    const wanted = this.route.snapshot.queryParamMap.get('returnUrl') ?? '/';
    return wanted.startsWith('/') && !wanted.startsWith('//') ? wanted : '/';
  }

  protected onLocaleChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    if (select.value === 'en' || select.value === 'ar') void this.locale.setLocale(select.value);
  }
}
