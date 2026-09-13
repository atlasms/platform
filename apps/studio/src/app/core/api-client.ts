import { HttpClient, type HttpContext, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { API_BASE_URL } from './api.ts';

/**
 * One request, described by its OPERATION rather than by a hand-typed URL (EP-02.4).
 *
 * The `generated/*.operations.ts` tables are projected from `docs/architecture/openapi/*.yaml`:
 * method, the path as the gateway serves it, and the names of its path parameters. A service
 * names the operation and supplies the values; this builds the request. So a service cannot spell
 * a path differently from the contract, cannot use the wrong verb, and cannot forget a path
 * parameter — `{ id }` is REQUIRED by the type when the path has `{id}` in it, and refused when it
 * does not. `npm run api:check` fails the build when a table and its contract disagree, which
 * closes the loop: rename a path in the contract and every caller stops compiling.
 *
 * The response type is the caller's, asserted with `.as<T>()`. Not generated: the stubs declare
 * responses unevenly (many are `description` only), so a generated return type would be `unknown`
 * half the time — and the caller already asserts the shape where it flushes the fake in its test.
 * (One call cannot take both `<T>` and the inferred operation: TypeScript infers all type
 * arguments or none, so the two are split.)
 */
export interface Operation {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** As served by the gateway: `/api/v1/assets/{id}`, `/auth/login`. */
  readonly path: string;
  /** The `{name}` segments of `path`, in order. */
  readonly params: readonly string[];
}

/** Query values. `undefined` means "not sent", so callers pass their options straight through. */
export type Query = Record<string, string | number | boolean | undefined>;

interface BaseOptions {
  query?: Query;
  body?: unknown;
  context?: HttpContext;
}

/** `{ id: string }` for `/assets/{id}`; nothing extra for a path without parameters. */
type ParamsOf<O extends Operation> = O['params'] extends readonly []
  ? { params?: undefined }
  : { params: { readonly [K in O['params'][number]]: string } };

export type CallOptions<O extends Operation> = BaseOptions & ParamsOf<O>;

/** Options are mandatory exactly when the path has parameters to fill. */
export type CallArgs<O extends Operation> = O['params'] extends readonly []
  ? [options?: CallOptions<O>]
  : [options: CallOptions<O>];

/**
 * The URL for an operation: the base, then the path with every `{param}` replaced by its
 * percent-encoded value. Pure, so a URL is checkable without an HTTP layer.
 *
 * Encoding is not optional: an id is a ULID today, but a vocabulary name or a search term is user
 * text, and `/`, `?` or `#` in a substituted segment would silently truncate or reroute the path.
 */
export function urlOf<O extends Operation>(base: string, op: O, ...args: CallArgs<O>): string {
  const values: Record<string, string | undefined> = args[0]?.params ?? {};
  const path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`${op.method} ${op.path}: missing path param ${name}`);
    return encodeURIComponent(value);
  });
  return `${base}${path}`;
}

/** A described request, waiting for the caller to say what comes back. */
export interface Call {
  as<T>(): Observable<T>;
}

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** `api.call(MamOperations.getAsset, { params: { id } }).as<Asset>()`. */
  call<O extends Operation>(op: O, ...args: CallArgs<O>): Call {
    const options = args[0];
    const url = urlOf(this.base, op, ...args);
    let params = new HttpParams();
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      if (value !== undefined) params = params.set(key, value);
    }
    return {
      as: <T>() =>
        this.http.request<T>(op.method, url, {
          params,
          ...(options?.body !== undefined ? { body: options.body } : {}),
          ...(options?.context !== undefined ? { context: options.context } : {}),
        }),
    };
  }
}
