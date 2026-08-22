import { inject, Injectable, signal, computed, effect } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

type Locale = 'en' | 'ar';
type Direction = 'ltr' | 'rtl';

interface Translations {
  [key: string]: string | Translations;
}

/**
 * Locale + RTL service (EP-11.6).
 *
 * - Loads translation JSON from `/locales/<locale>.json` at runtime.
 * - Persists the chosen locale to localStorage so it survives reloads.
 * - Applies `dir="rtl"` + `lang` on `<html>` when Arabic (or any RTL locale) is active.
 * - Provides a flat `t(key)` function for templates: `t('mediaPanel.search')`.
 *
 * The JSON files are flat-ish (nested objects allowed); `t()` walks the dot path.
 */
@Injectable({ providedIn: 'root' })
export class LocaleService {
  private readonly http = inject(HttpClient);
  private readonly doc = inject(DOCUMENT);

  private readonly _locale = signal<Locale>('en');
  private readonly _translations = signal<Translations>({});
  private readonly _loading = signal(false);

  readonly locale = this._locale.asReadonly();
  readonly direction = computed<Direction>(() =>
    this._locale() === 'ar' ? 'rtl' : 'ltr',
  );
  readonly loading = this._loading.asReadonly();

  constructor() {
    // Restore from localStorage on bootstrap
    const saved = this.doc.defaultView?.localStorage?.getItem('atlas.locale') as Locale | null;
    if (saved && (saved === 'en' || saved === 'ar')) {
      this._locale.set(saved);
    }
    // Apply direction whenever locale changes
    effect(() => {
      const dir = this.direction();
      const lang = this._locale();
      const html = this.doc.documentElement;
      html.dir = dir;
      html.lang = lang;
    });
    // Load initial translations
    this.load(this._locale());
  }

  /** Switch locale and load its translations. */
  async setLocale(locale: Locale): Promise<void> {
    if (locale === this._locale()) return;
    this._locale.set(locale);
    this.doc.defaultView?.localStorage?.setItem('atlas.locale', locale);
    await this.load(locale);
  }

  /** Translate a dot-notation key, e.g. `t('mediaPanel.search')`. */
  t(key: string): string {
    const parts = key.split('.');
    let current: unknown = this._translations();
    for (const part of parts) {
      if (typeof current === 'object' && current !== null && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return key; // fallback to key itself
      }
    }
    return typeof current === 'string' ? current : key;
  }

  /** Load translation JSON for a locale. */
  private async load(locale: Locale): Promise<void> {
    this._loading.set(true);
    try {
      const json = await firstValueFrom(this.http.get<Translations>(`/locales/${locale}.json`));
      this._translations.set(json);
    } catch {
      // Fallback to empty — templates will show keys instead of translations
      this._translations.set({});
    } finally {
      this._loading.set(false);
    }
  }
}