import type { RightsWindow, RightsWindowInput } from '../core/generated/scheduling.types.ts';
import type { EditorStore } from '../workbench/editor.store.ts';

/**
 * A rights window as the form holds it (EP-31) — pure, so the conversions are tested without a
 * component.
 *
 * The two instants are edited as `datetime-local` values: wall-clock in the BROWSER's zone,
 * converted to instants on the way out. A licence is signed in someone's local time, and asking an
 * operator to type UTC is how a window ends an hour early; the form says which zone it means.
 */
export interface RightsDraft {
  subject: 'asset' | 'category';
  /** The asset's id or the category's, per `subject`. */
  subjectId: string;
  /** `YYYY-MM-DDTHH:mm`, local. */
  from: string;
  to: string;
  territory: string;
  notes: string;
}

export const EMPTY_RIGHTS_DRAFT: RightsDraft = {
  subject: 'asset',
  subjectId: '',
  from: '',
  to: '',
  territory: '',
  notes: '',
};

/** An instant as a `datetime-local` value in the browser's zone. */
export function localInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A `datetime-local` value as an instant. One that does not parse is sent AS TYPED, so the
 * service's 422 names the field — the form does not keep a second copy of its rules.
 */
function instant(local: string): string {
  const t = new Date(local).getTime();
  return Number.isNaN(t) ? local : new Date(t).toISOString();
}

export function draftOf(w: RightsWindow): RightsDraft {
  return {
    subject: w.assetId !== undefined ? 'asset' : 'category',
    subjectId: w.assetId ?? w.categoryId ?? '',
    from: localInput(w.validFrom),
    to: localInput(w.validTo),
    territory: w.territory ?? '',
    notes: w.notes ?? '',
  };
}

/** The body the service is sent: the whole window, empty optional fields left out. */
export function inputOf(d: RightsDraft): RightsWindowInput {
  const id = d.subjectId.trim();
  return {
    ...(d.subject === 'asset' ? { assetId: id } : { categoryId: id }),
    validFrom: instant(d.from),
    validTo: instant(d.to),
    ...(d.territory.trim() !== '' ? { territory: d.territory.trim() } : {}),
    ...(d.notes.trim() !== '' ? { notes: d.notes.trim() } : {}),
  };
}

/** Which draft control a field the service names belongs under. */
export const FIELD_CONTROL: Readonly<Record<string, keyof RightsDraft>> = {
  assetId: 'subjectId',
  categoryId: 'subjectId',
  validFrom: 'from',
  validTo: 'to',
  territory: 'territory',
  notes: 'notes',
};

/** `2026-09-12 06:00 → 2026-12-31 23:59`, in the browser's zone — for a list row. */
export function span(w: Pick<RightsWindow, 'validFrom' | 'validTo'>): string {
  return `${localInput(w.validFrom).replace('T', ' ')} → ${localInput(w.validTo).replace('T', ' ')}`;
}

/**
 * Open a window's tab. Here, in the model, not beside the component: the editor area defers each
 * editor kind, and importing the editor module from the list would pull it into the panel's bundle.
 */
export function openRightsWindow(
  editors: EditorStore,
  window: Pick<RightsWindow, 'id' | 'assetId' | 'categoryId'>,
): void {
  editors.open({
    type: 'rights-window',
    resourceId: window.id,
    title: window.assetId ?? window.categoryId ?? window.id,
    icon: '⚖',
  });
}
