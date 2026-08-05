import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service.ts';

@Component({
  selector: 'atlas-signin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <form class="signin" (ngSubmit)="submit()">
      <h1>Sign in to Atlas</h1>

      <label for="username">Username</label>
      <input
        id="username"
        name="username"
        autocomplete="username"
        [(ngModel)]="username"
        [disabled]="auth.busy()"
        required
      />

      <label for="password">Password</label>
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
        {{ auth.busy() ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>
  `,
  styles: `
    .signin {
      display: grid;
      gap: 0.5rem;
      max-width: 22rem;
      margin: 4rem auto;
    }
    .error {
      color: var(--color-danger, #b3261e);
    }
    button {
      margin-top: 0.5rem;
    }
  `,
})
export class SignIn {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected username = '';
  protected password = '';
  protected readonly error = signal('');

  protected async submit(): Promise<void> {
    this.error.set('');
    try {
      await this.auth.signIn(this.username, this.password);
      await this.router.navigateByUrl('/');
    } catch {
      // ONE message for every failure, matching what IAM returns. Distinguishing "no such user"
      // from "wrong password" here would rebuild the account-enumeration oracle the server
      // deliberately refuses to be.
      this.error.set('Invalid username or password.');
    }
  }
}
