// MAM's Tier-3 settings (EP-33.2): declared here, beside the code that reads them; only the value
// is stored (configuration-and-reference-data.md §2.4). Adding a knob is one entry below — the
// view, the validation, the audit and the generated admin UI (EP-33.3) all follow from it.

import { defineSettings } from '@atlas/reference';
import { SettingsAdmin } from '@atlas/settings';

export const mamSettings = defineSettings('mam', {
  /**
   * FR-APP-8: how long rejected media is kept before it may be purged. A rejection that does not
   * state its own `retainUntil` gets `rejectedAt + this`. No default — decided 2026-11-27: unset
   * keeps rejected media until someone says otherwise, which is what every install did before
   * this setting existed, so an upgrade makes nothing purge-eligible. The purge is EP-24.6.
   */
  'review.rejectedRetention': {
    type: 'duration',
    scope: 'channel',
    group: 'review',
    label: 'Keep rejected media for',
    description:
      'How long rejected media is kept before it may be purged (ISO-8601, e.g. P30D). Unset keeps it until it is replaced or purged by hand. A rejection can still give its own date.',
  },
});

export const mamSettingsAdmin = new SettingsAdmin(mamSettings, { service: 'mam' });
