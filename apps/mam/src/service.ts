// MAM's domain service (EP-17.1, EP-17.5, EP-17.6).
//
// Every mutation does four things, in this order and in one transaction:
//   1. scope to the caller's channel,
//   2. authorize with canEnforce and the FULL resource context,
//   3. write the record,
//   4. enqueue the event on the outbox — atomically with (3).
//
// Steps 3 and 4 sharing a transaction is the whole reason the outbox exists: the state change and
// the announcement commit together, or neither does.

import { buildEnvelope, subjectFor, ulid, validatePayload, type Envelope } from '@atlas/contracts';
import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import { Conflict, Forbidden, NotFound, ValidationError } from '@atlas/service-kit';
import {
  orphanedFields,
  requiredFieldNames,
  resolveFields,
  validateExtended,
  type FieldDefinition,
  type FieldSchema,
} from './field-schema.ts';
import type { AssetStore, AssetTx, ExtendedValues } from './store.ts';
import { parseTagLabels, sameTags, type Tag } from './tag.ts';
import {
  BASE_MANDATORY_FIELDS,
  presentFieldsOf,
  type Asset,
  type CreateAssetInput,
  type UpdateAssetInput,
} from './asset.ts';
import {
  canTransition,
  eventFor,
  type LifecycleAction,
  type LifecycleContext,
} from './lifecycle.ts';

export interface MamOptions {
  store: AssetStore;
  /** Extra mandatory fields for a category, beyond the platform's base set. */
  mandatoryFieldsFor?: (asset: Asset) => readonly string[];
  /**
   * Terms per controlled vocabulary, for validating `type: 'vocabulary'` fields.
   *
   * The cached snapshot in a deployment (`@atlas/reference`). A vocabulary that is absent makes
   * its fields unwritable rather than unchecked — see `field-schema.ts`.
   */
  vocabularies?: () => ReadonlyMap<string, ReadonlySet<string>>;
  now?: () => Date;
}

/**
 * Extended field names are namespaced in the lifecycle context.
 *
 * An operator is free to define an extended field called `title`, and the core asset already has
 * one. Without a prefix the mandatory-metadata gate would see a single flat `title` and let the
 * core value satisfy a requirement on the extended field — passing a check nobody actually met.
 */
const EXTENDED_PREFIX = 'extended.';

/**
 * The field group a tag write belongs to.
 *
 * The starter roles scope `asset:write` by field group — an Editor gets `core`, `taxonomy`, `cast`
 * and `shotlist`; a Librarian gets `files` and `rights`
 * ([authorization-model.md §9](../../../docs/architecture/authorization-model.md)). Asking without
 * a group means *any* group satisfies the check, so naming it here is a genuine narrowing: a
 * Librarian's file-and-rights grant no longer reaches an asset's keywords.
 */
const TAXONOMY_GROUP = 'taxonomy';

/** Who is asking, and in which tenant. Established by the gateway, never parsed from a JWT here. */
export interface Caller {
  userId: string;
  channelId: string;
  policy: EffectivePolicy;
  correlationId?: string;
}

export class MamService {
  private readonly options: MamOptions;
  private readonly now: () => Date;

  constructor(options: MamOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  // --- reads -----------------------------------------------------------------

  /**
   * Fetch one asset.
   *
   * A cross-tenant id is reported as NOT FOUND, not FORBIDDEN. "You may not see this" confirms the
   * asset exists, which is itself a leak across a tenant boundary.
   */
  async get(caller: Caller, id: string): Promise<Asset> {
    const asset = await this.options.store.get(id);
    if (!asset || asset.channelId !== caller.channelId) throw new NotFound(`no asset ${id}`);
    this.authorize(caller, 'asset:read', asset);
    return asset;
  }

  async list(caller: Caller): Promise<Asset[]> {
    this.authorize(caller, 'asset:read');
    return this.options.store.listByChannel(caller.channelId);
  }

  // --- writes ----------------------------------------------------------------

  async create(caller: Caller, input: CreateAssetInput): Promise<Asset> {
    // No resource yet, so the check asks the broad question — but still inside the caller's
    // channel, which is the part that must never be omitted.
    this.authorize(caller, 'asset:write');

    if (!input.title?.trim()) throw new ValidationError('title is required');
    if (!input.mediaType?.trim()) throw new ValidationError('mediaType is required');
    if (!input.fileType?.trim()) throw new ValidationError('fileType is required');

    const at = this.now().toISOString();
    const asset: Asset = {
      id: ulid(),
      channelId: caller.channelId,
      title: input.title,
      mediaType: input.mediaType,
      fileType: input.fileType,
      state: 'created',
      version: 1,
      hasRenditions: false,
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
      ...defined({
        description: input.description,
        categoryId: input.categoryId,
        structureId: input.structureId,
        episodeNo: input.episodeNo,
        durationSec: input.durationSec,
        allowedBroadcastCount: input.allowedBroadcastCount,
        expiresAt: input.expiresAt,
      }),
    };

    await this.commit(caller, asset, 'asset.created', {
      assetId: asset.id,
      core: {
        title: asset.title,
        fileType: asset.fileType,
        ...defined({ description: asset.description, durationSec: asset.durationSec }),
      },
    });

    return asset;
  }

  async update(caller: Caller, id: string, patch: UpdateAssetInput): Promise<Asset> {
    const existing = await this.get(caller, id);
    this.authorize(caller, 'asset:write', existing);

    // ALLOWLIST, not the caller's object. `UpdateAssetInput` omits `state`, but a type is erased
    // at runtime and this patch arrives as JSON — spreading it would let `{"state":"approved"}`
    // route straight around review. Same for id, channelId, version and the audit fields.
    const safe = pickUpdatable(patch);

    const changedFields = (Object.keys(safe) as (keyof UpdateAssetInput)[]).filter(
      (key) => safe[key] !== undefined && safe[key] !== existing[key],
    );
    // No-op PATCHes are common from UIs that submit whole forms. Emitting `asset.updated` with an
    // empty changedFields would both violate the contract (minItems: 1) and wake every consumer
    // for nothing.
    if (changedFields.length === 0) return existing;

    const updated: Asset = {
      ...existing,
      ...defined(safe),
      version: existing.version + 1,
      updatedAt: this.now().toISOString(),
    };

    await this.commit(caller, updated, 'asset.updated', {
      assetId: updated.id,
      changedFields,
      source: 'user',
    });

    return updated;
  }

  /**
   * Move an asset through its lifecycle.
   *
   * The single entry point for state change — `update()` cannot touch `state`, so review cannot be
   * routed around by a metadata PATCH.
   */
  async transition(
    caller: Caller,
    id: string,
    action: LifecycleAction,
    options: { expiresAt?: string; retainUntil?: string; reason?: string } = {},
  ): Promise<Asset> {
    const existing = await this.get(caller, id);

    // Approving is its own permission: someone who may edit metadata is not thereby entitled to
    // sign an asset off for air.
    const permission =
      action === 'approve' || action === 'reject' ? 'asset:approve' : 'asset:write';
    this.authorize(caller, permission, existing);

    // The contract makes `reason` required on asset.rejected, and it is right to. A rejection with
    // no stated cause leaves whoever has to fix the asset with nothing to act on — and it would be
    // caught by schema validation anyway, but as an opaque 500 instead of a clear 422.
    if (action === 'reject' && !options.reason?.trim()) {
      throw new ValidationError('a rejection must state a reason');
    }

    const context = await this.contextFor(existing);
    const result = canTransition(context, action);
    if (!result.allowed) {
      throw new Conflict(result.reason ?? `cannot ${action} this asset`);
    }

    const updated: Asset = {
      ...existing,
      state: result.next ?? existing.state,
      version: existing.version + 1,
      updatedAt: this.now().toISOString(),
      ...defined({ expiresAt: options.expiresAt, retainUntil: options.retainUntil }),
    };

    const eventType = eventFor(action);
    if (eventType === undefined) {
      // An internal step with no contract event still commits, just without announcing itself.
      await this.options.store.transaction(async (tx) => tx.put(updated));
      return updated;
    }

    await this.commit(
      caller,
      updated,
      eventType,
      this.payloadFor(caller, eventType, updated, options),
    );
    return updated;
  }

  /** Attach renditions — normally driven by `transcode.completed` from MTS. */
  async attachRenditions(caller: Caller, id: string): Promise<Asset> {
    const existing = await this.get(caller, id);
    this.authorize(caller, 'asset:write', existing);
    const updated: Asset = {
      ...existing,
      hasRenditions: true,
      updatedAt: this.now().toISOString(),
    };
    await this.options.store.transaction(async (tx) => tx.put(updated));
    return updated;
  }

  // --- extensible metadata (EP-17.2) -----------------------------------------

  /**
   * The extensible document, the fields that govern it, and anything orphaned.
   *
   * All three together because none is useful alone: values without their definitions cannot be
   * rendered or labelled, and definitions without values cannot be filled in.
   */
  async extended(
    caller: Caller,
    id: string,
  ): Promise<{
    values: ExtendedValues;
    fields: FieldDefinition[];
    orphaned: string[];
  }> {
    const asset = await this.get(caller, id);
    const [values, fields] = await Promise.all([
      this.options.store.extended(id),
      this.fieldsFor(asset),
    ]);
    const stored = values ?? {};
    return { values: stored, fields, orphaned: orphanedFields(fields, stored) };
  }

  /**
   * Patch the extensible document.
   *
   * A MERGE, not a replacement: a form that submits one section must not erase the others. An
   * explicit `null` clears a field, which is the only way to express removal in a merge — omitting
   * it means "leave alone".
   */
  async updateExtended(
    caller: Caller,
    id: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<ExtendedValues> {
    const asset = await this.get(caller, id);
    this.authorize(caller, 'asset:write', asset);

    const fields = await this.fieldsFor(asset);
    const errors = validateExtended(fields, patch, {
      ...defined({ vocabularies: this.options.vocabularies?.() }),
    });
    if (errors.length > 0) {
      throw new ValidationError(errors.map((e) => `${e.field}: ${e.message}`).join('; '));
    }

    const current = (await this.options.store.extended(id)) ?? {};
    const merged: ExtendedValues = { ...current };
    for (const [name, value] of Object.entries(patch)) {
      if (value === null) delete merged[name];
      else merged[name] = value;
    }

    // Same transaction as the version bump: the document and the record it belongs to move
    // together, so a reader can never see a version that does not match the metadata.
    const updated: Asset = {
      ...asset,
      version: asset.version + 1,
      updatedAt: this.now().toISOString(),
    };
    const changedFields = Object.keys(patch).map((name) => `${EXTENDED_PREFIX}${name}`);
    if (changedFields.length === 0) return current;

    await this.commitWith(
      caller,
      updated,
      'asset.updated',
      { assetId: updated.id, changedFields, source: 'user' },
      async (tx) => tx.putExtended(id, asset.channelId, merged),
    );

    return merged;
  }

  /** Define or replace a FieldSchema. Operator-managed configuration, not asset data. */
  async putSchema(caller: Caller, schema: FieldSchema): Promise<FieldSchema> {
    // `taxonomy:admin`, not `asset:write`: editing a schema changes what every asset in its scope
    // must carry, which is a governance action rather than an editorial one.
    this.authorize(caller, 'taxonomy:admin');
    if (schema.channelId !== caller.channelId) {
      throw new Forbidden('a schema cannot be written into another channel');
    }
    await this.options.store.transaction(async (tx) => tx.putSchema(schema));
    return schema;
  }

  async schemas(caller: Caller): Promise<FieldSchema[]> {
    this.authorize(caller, 'asset:read');
    return this.options.store.schemas(caller.channelId);
  }

  // --- free-form tags (EP-17.3) ----------------------------------------------

  /** The tags on one asset. Scoped and authorized by {@link get}. */
  async tags(caller: Caller, id: string): Promise<Tag[]> {
    const asset = await this.get(caller, id);
    return this.options.store.tagsOf(asset.id);
  }

  /**
   * Every tag in the caller's channel — the cloud, and what an autocomplete offers.
   *
   * `taxonomy:read`, not the `taxonomy:admin` the service catalogue lists against `GET /tags`. That
   * table describes the *management* surface; gating the read behind admin would make tag
   * autocomplete an administrator-only feature, which defeats free-form tagging for every editor
   * the feature exists for. Administering the vocabulary — renaming, merging, deleting — is still
   * `taxonomy:admin` and still unbuilt.
   */
  async listTags(caller: Caller): Promise<Tag[]> {
    this.authorize(caller, 'taxonomy:read');
    return this.options.store.listTags(caller.channelId);
  }

  /**
   * Replace an asset's tags.
   *
   * Whole-set: a tag input hands back the final list, and there is no partial form of "these are
   * the keywords". Labels the channel has not seen are minted on the spot — that is what makes a
   * tag free-form — and each minting is announced as `taxonomy.updated` so Search and Studio learn
   * about a new term without polling for one.
   */
  async setTags(caller: Caller, id: string, labels: readonly unknown[]): Promise<Tag[]> {
    const asset = await this.get(caller, id);
    this.authorize(caller, 'asset:write', asset, TAXONOMY_GROUP);

    const parsed = parseTagLabels(labels);
    if (parsed.errors.length > 0) throw new ValidationError(parsed.errors.join('; '));

    const current = await this.options.store.tagsOf(id);
    // Re-submitting the same set — which a form that PUTs on every keystroke does constantly — must
    // not bump the version or wake every consumer. Compared on the normalized form, so `FOOTBALL`
    // over an existing `football` is correctly nothing.
    if (sameTags(current, parsed.labels)) return current;

    // Candidate ids are minted HERE rather than in the adapter, so ULID generation stays a domain
    // concern and both stores behave identically. A candidate is used only if its label is new;
    // that is also how a newly minted tag is recognised below, without a second query.
    const candidates = parsed.labels.map((l) => ({ id: ulid(), ...l }));
    const fresh = new Set(candidates.map((c) => c.id));

    const updated: Asset = {
      ...asset,
      version: asset.version + 1,
      updatedAt: this.now().toISOString(),
    };

    let resolved: Tag[] = [];
    await this.commitWith(
      caller,
      updated,
      'asset.updated',
      // `['tags']`, not a field-level list of what was added and removed. The contract's
      // `changedFields` names FIELDS, and the delta belongs in the audit event EP-19.2 defines.
      { assetId: updated.id, changedFields: ['tags'], source: 'user' },
      async (tx) => {
        resolved = await tx.setTags(id, asset.channelId, candidates);
        for (const tag of resolved) {
          if (!fresh.has(tag.id)) continue; // reused an existing tag — nothing new to announce
          await tx.enqueue(
            this.eventRecord(caller, asset.channelId, 'taxonomy.updated', {
              kind: 'tag',
              action: 'created',
              id: tag.id,
              label: tag.label,
            }),
          );
        }
      },
    );

    return resolved;
  }

  /** The resolved field definitions for one asset. */
  private async fieldsFor(asset: Asset): Promise<FieldDefinition[]> {
    const schemas = await this.options.store.schemas(asset.channelId);
    return resolveFields(schemas, {
      channelId: asset.channelId,
      mediaType: asset.mediaType,
      ...defined({ categoryPath: asset.categoryId }),
    });
  }

  /**
   * The lifecycle's view of an asset, including the category's mandatory fields AND any extended
   * fields an operator marked required.
   *
   * This is where FR-MAM-2 meets FR-MAM-5: making a field required has to actually stop an asset
   * advancing, or "required" is a label on a form.
   */
  async contextFor(asset: Asset): Promise<LifecycleContext> {
    const extra = this.options.mandatoryFieldsFor?.(asset) ?? [];
    const [fields, values] = await Promise.all([
      this.fieldsFor(asset),
      this.options.store.extended(asset.id),
    ]);

    const requiredExtended = requiredFieldNames(fields).map((n) => `${EXTENDED_PREFIX}${n}`);
    const presentExtended = Object.entries(values ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([name]) => `${EXTENDED_PREFIX}${name}`);

    return {
      state: asset.state,
      hasRenditions: asset.hasRenditions,
      mandatoryFields: [...new Set([...BASE_MANDATORY_FIELDS, ...extra, ...requiredExtended])],
      presentFields: [...presentFieldsOf(asset), ...presentExtended],
      ...defined({ expiresAt: asset.expiresAt, retainUntil: asset.retainUntil }),
    };
  }

  // --- internals -------------------------------------------------------------

  /**
   * STRICT authorization with the full resource context.
   *
   * Lenient `can()` would treat a predicate it cannot evaluate as satisfied, so an incomplete
   * context would yield a WIDER grant (authorization-model.md §5.1). Studio uses lenient to decide
   * what to show; a service enforcing must not.
   *
   * `fieldGroup` follows the same rule in the other direction: **omitting it widens the check**,
   * because a rule that declares field groups matches anyway when none was asked for. So it is
   * passed wherever the write belongs to a known group. Core and file writes do not name theirs
   * yet, so field-group scoping is only partly enforced — a gap, not a decision.
   */
  private authorize(caller: Caller, permission: string, asset?: Asset, fieldGroup?: string): void {
    const decision = canEnforce(caller.policy, permission, {
      channelId: caller.channelId,
      ...defined({ categoryPath: asset?.categoryId, ownerId: asset?.createdBy, fieldGroup }),
    });
    if (!decision.allowed) throw new Forbidden(decision.reason ?? `missing ${permission}`);
  }

  /** Write the record and its event in ONE transaction. */
  private async commit(
    caller: Caller,
    asset: Asset,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return this.commitWith(caller, asset, eventType, payload);
  }

  /**
   * The same unit of work, with an extra write joining it.
   *
   * `also` runs on the SAME tx handle, which is the whole point — a caller that reached for the
   * store instead would land in a different transaction and lose the atomicity silently.
   */
  private async commitWith(
    caller: Caller,
    asset: Asset,
    eventType: string,
    payload: Record<string, unknown>,
    also?: (tx: AssetTx) => Promise<void>,
  ): Promise<void> {
    const record = this.eventRecord(caller, asset.channelId, eventType, payload);

    // Nothing is read back inside this block on purpose. On sqlite an uncommitted write is visible
    // to the same connection; on Postgres it is not visible outside the transaction's own client —
    // so a read here would work in tests and return stale data in production.
    await this.options.store.transaction(async (tx) => {
      await tx.put(asset);
      await also?.(tx);
      await tx.enqueue(record);
    });
  }

  /**
   * Validate a payload and wrap it in an addressed envelope, ready for the outbox.
   *
   * Validated before it is stored, not on the way out: an invalid payload in the outbox is a poison
   * message that fails every drain forever, and the transaction that could have rejected it has
   * long since committed.
   *
   * Separate from {@link commitWith} because one unit of work can carry more than one event — a tag
   * write announces the asset change AND every vocabulary term it minted, and all of them have to
   * commit with the rows they describe.
   */
  private eventRecord(
    caller: Caller,
    channelId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): { id: string; message: { id: string; subject: string; body: Envelope } } {
    const check = validatePayload(eventType, payload);
    if (!check.valid) {
      throw new ValidationError(
        `${eventType} payload does not match its schema: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    }

    const envelope: Envelope = buildEnvelope({
      type: eventType,
      channelId,
      payload,
      actor: { kind: 'user', id: caller.userId },
      ...defined({ correlationId: caller.correlationId }),
    });

    return {
      id: envelope.messageId,
      message: {
        id: envelope.messageId,
        subject: subjectFor(channelId, eventType),
        body: envelope,
      },
    };
  }

  /**
   * Build the event payload for a lifecycle transition.
   *
   * Each of these contracts requires more than the asset id — an approval names its approver, a
   * rejection states its reason, an expiry records when. That is deliberate on the contract's
   * part: these are the events a compliance record is reconstructed from, and "asset 42 was
   * rejected" with no author and no cause is not a record of anything.
   */
  private payloadFor(
    caller: Caller,
    eventType: string,
    asset: Asset,
    options: { reason?: string; retainUntil?: string },
  ): Record<string, unknown> {
    const at = asset.updatedAt;
    switch (eventType) {
      case 'asset.approved':
        return {
          assetId: asset.id,
          approver: caller.userId,
          approvedAt: at,
          ...defined({ expiresAt: asset.expiresAt }),
        };
      case 'asset.rejected':
        return {
          assetId: asset.id,
          reason: options.reason,
          rejectedBy: caller.userId,
          rejectedAt: at,
          ...defined({ retainUntil: asset.retainUntil }),
        };
      case 'asset.expired':
        // `expirySource` records where `expiresAt` came from — a per-asset override or an
        // inherited category default (FR-TAX-7). Always 'asset' today: category-inherited expiry
        // arrives with the taxonomy work, and claiming 'category' before then would be a lie in
        // the audit record.
        return { assetId: asset.id, expiredAt: at, expirySource: 'asset' };
      default:
        return { assetId: asset.id };
    }
  }
}

/**
 * The only fields a metadata update may touch.
 *
 * Deliberately an explicit list rather than a denylist: a denylist has to be updated every time a
 * field is added to `Asset`, and the failure mode of forgetting is that the new field becomes
 * writable by anyone with `asset:write` — including, one day, another field that matters as much
 * as `state`.
 */
const UPDATABLE_FIELDS = [
  'title',
  'description',
  'categoryId',
  'structureId',
  'episodeNo',
  'durationSec',
  'allowedBroadcastCount',
  'expiresAt',
] as const satisfies readonly (keyof UpdateAssetInput)[];

function pickUpdatable(patch: UpdateAssetInput): UpdateAssetInput {
  const out: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (patch[field] !== undefined) out[field] = patch[field];
  }
  return out as UpdateAssetInput;
}

/**
 * Drop undefined entries.
 *
 * `exactOptionalPropertyTypes` is on, so `{ a: undefined }` is not the same as `{}` — and on the
 * wire an explicit null is noise every consumer has to handle.
 */
function defined<T extends Record<string, unknown>>(
  source: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  // The return type strips `undefined` from the VALUES, not just the keys. `Partial<T>` would
  // leave `string | undefined`, which under exactOptionalPropertyTypes is not assignable to an
  // optional `string` — the very distinction this helper exists to preserve.
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
