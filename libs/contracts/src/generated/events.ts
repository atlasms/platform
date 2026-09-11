// GENERATED FROM docs/architecture/schemas — DO NOT EDIT.
//
// Regenerate with `npm run api:types`. `npm run api:check` fails the build when this file and the
// schemas disagree. The same files are loaded at runtime by @atlas/contracts to VALIDATE a payload;
// this is the compile-time projection of them, not a second opinion.

// --- shared types (common.schema.json#/$defs) ---

/** ULID identifier (used for messageId/correlationId and most entity ids). */
export type Ulid = string;

/** Channel/tenant scope id; present on every row and message. */
export type ChannelId = string;

/** HSM storage tier. */
export const TierValues = ['online', 'near-line', 'offline'] as const;
export type Tier = (typeof TierValues)[number];

/** The kind of generated media version. */
export const RenditionKindValues = [
  'original',
  'proxy',
  'broadcast',
  'thumbnail',
  'vtt-filmstrip',
  'hover-preview',
] as const;
export type RenditionKind = (typeof RenditionKindValues)[number];

export interface Checksum {
  algorithm: string;
  value: string;
}

export interface Rendition {
  kind: RenditionKind;
  /** HSM-resolved logical path. */
  path: string;
  checksum: Checksum;
  sizeBytes?: number;
  durationSec?: number;
}

/** ffprobe-derived technical metadata; additive fields allowed. */
export interface TechnicalMetadata {
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  aspectRatio?: string;
  audioChannels?: number;
  frameRate?: number;
}

export interface Error {
  code: string;
  message: string;
  retryable?: boolean;
}

/** A generic pointer to any Atlas entity, used by cross-cutting events (tasks, notifications, alerts, publishing, audit). */
export interface EntityRef {
  /** The referenced entity's kind. */
  entityType: string;
  /** Id of the referenced entity (usually a ULID; may be an external id for feed items). */
  entityId: string;
}

/** Uniform severity for notifications, tasks and alerts. */
export const SeverityValues = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SeverityValues)[number];

/** Kind of human-in-the-loop task. One definition: BMS declares it in a workflow, emits it in workflow.task.created, and Notifications re-emits it in task.created — three sites had two value sets (workflow.task.created could not express 'generic'). */
export const TaskKindValues = ['approve', 'edit', 'review', 'generic'] as const;
export type TaskKind = (typeof TaskKindValues)[number];

/** Who a task is assigned to, or a message addressed to. */
export const PrincipalKindValues = ['user', 'group'] as const;
export type PrincipalKind = (typeof PrincipalKindValues)[number];

/** IAM account state; a state machine with coded transitions (lockout, invitation). */
export const UserStateValues = ['active', 'disabled', 'locked', 'invited'] as const;
export type UserState = (typeof UserStateValues)[number];

/** Levels a Tier-3 setting can be written at. Resolution is nearest-wins: code default -> deployment -> channel -> category -> user (design §2.5). */
export const SettingScopeValues = ['deployment', 'channel', 'category', 'user'] as const;
export type SettingScope = (typeof SettingScopeValues)[number];

/** Which AI tier ran: online (interactive, bounded latency) or offline (batch). Not the HSM storage Tier. */
export const AiTierValues = ['online', 'offline'] as const;
export type AiTier = (typeof AiTierValues)[number];

/** An enrichment task; each is its own model pipeline in the AI service. */
export const AiTaskValues = [
  'faces',
  'objects',
  'shots',
  'scenes',
  'stt',
  'language-id',
  'keywords',
  'summary',
] as const;
export type AiTask = (typeof AiTaskValues)[number];

/** An outbound publishing connector; each is its own integration. */
export const PublishKindValues = ['epg', 'hbbtv', 'social', 'web'] as const;
export type PublishKind = (typeof PublishKindValues)[number];

// --- one payload per events/<type>.payload.schema.json ---

/** Emitted by AI Enrichment when a job's tasks finish. Results are recorded as derived/suggestions in MAM (FR-AI-3). */
export interface AiEnrichmentCompletedPayload {
  assetId: Ulid;
  jobId?: Ulid;
  tier?: AiTier;
  results: { task: AiTask; output?: unknown; confidence?: number }[];
}

/** Emitted by AI Enrichment when an enrichment task fails. Off the critical path — consumed by Notifications and Logging; never blocks ingest or approval. */
export interface AiEnrichmentFailedPayload {
  assetId: Ulid;
  task: AiTask;
  error: Error;
  at: string;
}

/** Emitted by AI Enrichment with provisional suggestions for human confirmation (never auto-applied - FR-AI-3). Consumed by MAM, Notifications. */
export interface AiSuggestionRaisedPayload {
  assetId: Ulid;
  /** Which AI tier produced these. */
  tier?: AiTier;
  suggestions: {
    kind: 'person' | 'tag' | 'subject' | 'caption';
    value: string;
    confidence?: number;
  }[];
}

/** Emitted by Logging & Analytics when a monitored threshold or condition trips (DLQ growth, checksum-mismatch rate, restore-ETA breach, storage target down). Consumed by Notifications for delivery. */
export interface AlertRaisedPayload {
  alertId: Ulid;
  /** Service or subsystem that is the subject of the alert. */
  source: string;
  /** Alert rule id/name, e.g. "dlq-depth", "checksum-mismatch", "restore-eta-breach". */
  kind: string;
  severity: Severity;
  subjectRef?: EntityRef;
  message: string;
  /** Optional numeric context. */
  metric?: { name?: string; value?: number; threshold?: number };
  raisedAt: string;
}

/** Emitted by MAM when an asset is approved for air. Consumed by Scheduling, Integration, Logging. */
export interface AssetApprovedPayload {
  assetId: Ulid;
  /** User id who approved (manual verdict). */
  approver: string;
  approvedAt?: string;
  /** When the media becomes unusable and requires re-review. Absent = permanent approval. Defaults from the asset's category (FR-TAX-7), overridable per asset. */
  expiresAt?: string;
  /** Optional id of the workflow review step that produced this verdict (FR-APP-5). */
  reviewPointId?: string;
}

/** Emitted by MAM when an asset record is created (usually from ingest.accepted). */
export interface AssetCreatedPayload {
  assetId: Ulid;
  /** The core fields required for every asset (FR-MAM-1). */
  core: {
    title: string;
    description?: string;
    durationSec?: number;
    fileType: string;
    resolution?: string;
    aspectRatio?: string;
    audioChannels?: number;
  };
}

/** Emitted by MAM when an asset is purged — chiefly a rejected asset whose retention window (retainUntil) has lapsed without replacement (FR-APP-8), or an explicit administrative deletion. Consumed by HSM (remove bytes per policy) and Logging. */
export interface AssetDeletedPayload {
  assetId: Ulid;
  /** Why the asset was purged. */
  reason: 'rejected-retention' | 'manual' | 'policy';
  /** User id for a manual deletion; absent when the scheduler purges automatically. */
  deletedBy?: string;
  deletedAt?: string;
}

/** Emitted by MAM when a previously-approved asset reaches its expiry (expiresAt) and becomes unusable, requiring manual re-review (FR-APP-7). Fired by MAM's internal scheduler, not a user action. Consumed by Scheduling (drop from schedulable set), Notifications, Logging. */
export interface AssetExpiredPayload {
  assetId: Ulid;
  /** The expiresAt that has now been reached. */
  expiredAt: string;
  /** User id whose approval just lapsed. */
  priorApprover?: string;
  /** Whether expiresAt came from a per-asset override or the inherited category default (FR-TAX-7). */
  expirySource?: 'asset' | 'category';
}

/** Emitted by MAM when renditions are attached and mandatory metadata is present. */
export interface AssetReadyPayload {
  assetId: Ulid;
}

/** Emitted by MAM when an asset is rejected in review. Consumed by Notifications, Logging. */
export interface AssetRejectedPayload {
  assetId: Ulid;
  reason: string;
  /** User id who rejected (manual verdict). */
  rejectedBy?: string;
  rejectedAt?: string;
  /** When the rejected media is purged if not replaced first (FR-APP-8). Absent = kept until manual/policy disposition. */
  retainUntil?: string;
  /** Optional id of the workflow review step that produced this verdict (FR-APP-5). */
  reviewPointId?: string;
}

/** Emitted by MAM when a new version supersedes a prior asset (metadata cloned, new id). Consumed by Scheduling, Logging. */
export interface AssetReplacedPayload {
  oldId: Ulid;
  newId: Ulid;
}

/** Emitted by MAM when asset metadata changes. Consumed by WebSocket, Search, Logging. */
export interface AssetUpdatedPayload {
  assetId: Ulid;
  /** Names of the fields that changed. */
  changedFields: string[];
  /** Provenance of the change (FR-MAM-8). */
  source?: 'user' | 'ai' | 'technical';
}

/** Emitted by HSM when an integrity check fails. Raises an alert (Notifications, Logging). */
export interface ChecksumMismatchPayload {
  assetId: Ulid;
  rendition: RenditionKind;
  expected?: Checksum;
  actual?: Checksum;
}

/** Emitted by HSM when an integrity check passes (ingest or sweep). */
export interface ChecksumVerifiedPayload {
  assetId: Ulid;
  rendition: RenditionKind;
  checksum?: Checksum;
  verifiedAt?: string;
}

/** Emitted by any service that owns admin-editable reference data (registries, vocabularies, settings) after a write. Consumers invalidate their cached reference snapshot and revalidate with If-None-Match. Design: docs/architecture/configuration-and-reference-data.md §5. */
export interface ConfigChangedPayload {
  /** Owning service/module, optionally dotted to the affected collection. */
  area: string;
  /** Which tier changed (Tier 1 / 2 / 3). Tier 0 enums never emit this — they change by release. */
  tier: 'registry' | 'vocabulary' | 'setting';
  /** Setting keys or entry ids affected. Omitted for a bulk change; consumers then refetch the whole area. */
  keys?: string[];
  /** Level the value was written at, for settings. */
  scopeLevel?: SettingScope;
  /** Id of the scope instance (channelId, categoryId, userId) when scopeLevel is not `deployment`. */
  scopeId?: string;
  /** Monotonic version of the emitting area's snapshot after the change. */
  configVersion: number;
  /** True when at least one changed descriptor declares `restart: true`; the owning service reports the change as pending. */
  restartRequired?: boolean;
  actorId?: Ulid;
}

/** Command issued by the Studio-hosted media editor (via the BFF) to flatten an edit timeline into a new rendition. Consumed by MTS, which renders it and emits transcode.completed. Design: docs/architecture/services/media-editor.md. */
export interface EditorRenderRequestedPayload {
  editProjectId: Ulid;
  /** Asset whose renditions the timeline references. */
  sourceAssetId: Ulid;
  /** Existing asset to add the rendered result to as a new version; absent = create a new asset. */
  targetAssetId?: Ulid;
  /** The editor operates on video, audio, or image (basic-NLE, D3). */
  mediaKind: 'video' | 'audio' | 'photo';
  /** The edit decision list: an ordered set of clips (source in/out → timeline position) plus optional transitions and filters. Interpreted by the render worker; the authoritative shape is the EditProject timeline (media-editor.md §3). */
  timeline: { clips: { renditionRef: string; inSec: number; outSec: number }[] };
  /** MTS profile id (Tier-1 registry) to encode the flattened result with. */
  outputProfile: string;
  /** User id who triggered the render. */
  requestedBy?: string;
}

/** Emitted by Integration/Feeds when an inbound feed yields an item mapped to Atlas data. Consumed by Newsroom (wires), MAM (asset/metadata creation) and Logging. */
export interface FeedItemReceivedPayload {
  feedId: Ulid;
  /** The source system's item id (external), used for dedupe. */
  itemId: string;
  /** What the mapping produces, e.g. "wire", "asset", "metadata". */
  targetType: string;
  /** Set when the item was mapped onto an asset. */
  mappedAssetId?: Ulid;
  receivedAt: string;
}

/** Emitted by HSM when a rendition moves between tiers. Consumed by MAM, Logging. */
export interface FileMovedPayload {
  assetId: Ulid;
  renditionKind?: RenditionKind;
  fromTier: Tier;
  toTier: Tier;
  path?: string;
}

/** Emitted by HSM when a rendition's bytes are placed on a tier. Consumed by MAM, Logging. */
export interface FilePlacedPayload {
  assetId: Ulid;
  renditionKind?: RenditionKind;
  tier: Tier;
  path: string;
  checksum?: Checksum;
}

/** The API Gateway's access record: one per request at the edge, so every request appears exactly once. High-volume, so it ships via the log pipeline (structured log line -> Loki), NOT the broadcast bus, and is defined here so the audit sink and the gateway agree on one shape - the gateway's tests validate a real record against this schema. Inner-service access lines (#245) are a different, per-hop record and are not this event. Consumed by Logging & Analytics. */
export interface GatewayAccessLoggedPayload {
  requestId: Ulid;
  method: string;
  /** What the client asked for, verbatim. The edge is the one place the raw path is worth keeping. */
  path: string;
  /** The matched routing-table prefix, when the request matched one - bounded, so it aggregates. Absent on an unroutable request. */
  route?: string;
  status: number;
  /** Authenticated subject, when present. */
  userId?: string;
  ip?: string;
  latencyMs?: number;
  /** W3C trace id, when the request was traced. What links this line to its trace. */
  traceId?: string;
  at: string;
}

/** Emitted by IAM when a user is added to or removed from a group. Because effective permissions are the union of user and group rules, this bumps the user's permVersion and is consumed by the gateway/cache and the WebSocket service; also by Logging. */
export interface GroupMembershipChangedPayload {
  userId: Ulid;
  groupId: Ulid;
  action: 'added' | 'removed';
  /** The user's new permission version after this change. */
  permVersion?: number;
  by?: string;
  at: string;
}

/** Emitted by RIM when media passes acceptance; the fan-out that triggers MAM/MTS/AI. */
export interface IngestAcceptedPayload {
  assetId: Ulid;
  source?: string;
  /** HSM-placed original path. */
  path?: string;
  checksum: Checksum;
  technicalMetadata?: TechnicalMetadata;
}

/** Emitted by RIM when new incoming content is detected, before acceptance. */
export interface IngestDetectedPayload {
  /** Source id that detected the content. */
  source: string;
  sourceKind?: 'upload' | 'ftp' | 'watch' | 'recorder';
  /** Received/staging path. */
  path: string;
  sizeBytes?: number;
}

/** Emitted by RIM when incoming media fails an acceptance rule. */
export interface IngestRejectedPayload {
  ingestJobId?: Ulid;
  source?: string;
  /** Human-readable rejection reason. */
  reason: string;
  /** The acceptance rule that failed. */
  ruleId?: string;
  /** True if held for review rather than discarded. */
  quarantined?: boolean;
}

/** Emitted by Notifications & Messaging when a user sends a direct or group chat message. Consumed by the WebSocket service (live delivery) and Logging. */
export interface MessageSentPayload {
  /** The chat message id (distinct from the envelope messageId). */
  id: Ulid;
  /** Sender user id. */
  from: string;
  /** Recipients — users and/or groups. */
  to: { kind: PrincipalKind; id: string }[];
  /** Conversation thread, when part of one. */
  threadId?: Ulid;
  body: string;
  sentAt: string;
}

/** Emitted by Notifications & Messaging when a system notification is raised for a user (job done, approval needed, mention, alert). Consumed by the WebSocket service for live delivery. The `type` is a Tier-1 notification-type registry key (see configuration-and-reference-data.md §2.2). */
export interface NotificationRaisedPayload {
  id: Ulid;
  /** Recipient user id. */
  userId: string;
  /** Notification-type registry key, e.g. "asset.approval-needed", "transcode.failed". */
  type: string;
  subjectRef?: EntityRef;
  severity: Severity;
  title?: string;
  body?: string;
  createdAt: string;
}

/** Emitted by IAM when a user's effective permissions change; bumps permVersion so gateway/WebSocket re-check (FR-IAM-8). */
export interface PermissionsChangedPayload {
  userId: Ulid;
  permVersion: number;
}

/** Emitted by MAM when a person is added to the register (name, role, optional image only - FR-PPL-2). */
export interface PersonCreatedPayload {
  personId: Ulid;
  name: string;
  /** e.g. presenter, guest. */
  roleInMedia?: string;
  hasImage?: boolean;
}

/** Emitted by MAM when a person is associated with an asset in a role. */
export interface PersonLinkedPayload {
  personId: Ulid;
  assetId: Ulid;
  /** Role of this person for this asset. */
  roleForAsset?: string;
  /** User id, when a link originated from an AI suggestion. */
  confirmedBy?: string;
}

/** Emitted by HSM when hi-res files + playlist are delivered to the control-room destination. Consumed by Scheduling, Logging. */
export interface PlayoutExportCompletedPayload {
  scheduleId: Ulid;
  /** Control-room network destination. */
  destination: string;
  /** Serialized playlist format. */
  format?: string;
  fileCount?: number;
}

/** Emitted by Integration/Feeds when an outbound publish/connector delivery succeeds (EPG, HbbTV, social, web). Consumed by Logging. */
export interface PublishCompletedPayload {
  connectorId: Ulid;
  kind: PublishKind;
  subjectRef: EntityRef;
  destination: string;
  /** Provider-returned delivery receipt/id, when available. */
  receipt?: string;
  publishedAt: string;
}

/** Emitted by Integration/Feeds when an outbound publish/connector delivery fails. Consumed by Notifications (alert) and Logging. */
export interface PublishFailedPayload {
  connectorId: Ulid;
  kind: PublishKind;
  subjectRef: EntityRef;
  destination: string;
  error: Error;
  at: string;
}

/** Emitted by RIM when a recorder finalizes a segment file. */
export interface RecordingSegmentCompletedPayload {
  recorderId: Ulid;
  /** Sequential segment index. */
  index: number;
  path: string;
  /** Start timecode HH:MM:SS:FF. */
  tcIn?: string;
  /** End timecode HH:MM:SS:FF. */
  tcOut?: string;
  checksum?: Checksum;
}

/** Emitted by HSM when a near-line/offline asset is back online. Consumed by Scheduling, Notifications. */
export interface RestoreCompletedPayload {
  assetId: Ulid;
  renditionKind?: RenditionKind;
  restoreRequestId?: Ulid;
}

/** Emitted by Newsroom when a rundown is marked ready for air. Consumed by Scheduling (bulletin hand-off), Notifications and Logging. */
export interface RundownReadyPayload {
  rundownId: Ulid;
  date?: string;
  readyAt: string;
  by?: string;
}

/** Emitted by Newsroom when a rundown changes (story order, timing, state). Consumed by the WebSocket service and Logging. */
export interface RundownUpdatedPayload {
  rundownId: Ulid;
  /** The rundown's broadcast date/slot. */
  date?: string;
  /** Rundown state, e.g. draft/ready/onair/done. */
  state?: string;
  changed?: string[];
  by?: string;
  at: string;
}

/** Emitted by Scheduling to trigger HSM delivery of hi-res files + playlist. Consumed by HSM, Logging. */
export interface ScheduleSentToAirPayload {
  scheduleId: Ulid;
  /** Control-room network destination. */
  destination?: string;
  format?: string;
  /** Rule ensuring src_path resolves on the playout host (FR-SCH-5a). */
  pathRewriteRuleId?: string;
}

/** Emitted by Scheduling when a program table changes. Consumed by Integration (EPG), WebSocket. */
export interface ScheduleUpdatedPayload {
  scheduleId: Ulid;
  state?: 'draft' | 'validated' | 'sending' | 'sent' | 'failed';
  itemCount?: number;
}

/** Emitted by Scheduling after an on-demand validation run (editor request or send-to-air pre-flight; FR-SCH-2). Consumed by the WebSocket service (surface results in the editor) and Logging. Validation is advisory and never a per-write gate. */
export interface ScheduleValidatedPayload {
  scheduleId: Ulid;
  valid: boolean;
  issues?: {
    kind: 'gap' | 'overlap' | 'rights' | 'availability' | 'expiry' | 'anchor';
    itemId?: Ulid;
    severity?: Severity;
    message?: string;
  }[];
  validatedAt: string;
}

/** Emitted by Newsroom when a story changes (status, assignment, script/media). Consumed by the WebSocket service (collaborative editing) and Logging. */
export interface StoryUpdatedPayload {
  storyId: Ulid;
  /** The rundown this story belongs to, if any. */
  rundownId?: Ulid;
  status: 'assigned' | 'writing' | 'review' | 'ready' | 'onair';
  /** Names of changed fields. */
  changed?: string[];
  by?: string;
  at: string;
}

/** Emitted by Notifications & Messaging when a task is created (assigned to a user or group). Consumed by the WebSocket service and Logging. A workflow human-task (workflow.task.created from BMS) is materialized as one of these. */
export interface TaskCreatedPayload {
  id: Ulid;
  /** User id or group id. */
  assignee: string;
  assigneeKind: PrincipalKind;
  kind: TaskKind;
  /** What the task is about (asset, workflow instance, story...). */
  subjectRef?: EntityRef;
  dueAt?: string;
  createdBy?: string;
  /** Set when the task originates from a BMS human step. */
  workflowInstanceId?: Ulid;
  createdAt: string;
}

/** Emitted by Notifications & Messaging when a task changes state (completed, forwarded/reassigned, cancelled). Consumed by the WebSocket service, BMS (to advance a waiting human step), and Logging. */
export interface TaskUpdatedPayload {
  id: Ulid;
  state: 'open' | 'forwarded' | 'done' | 'cancelled';
  /** User id who effected the change. */
  by?: string;
  /** New assignee when state is forwarded. */
  forwardedTo?: string;
  /** For a completed decision task: the verdict, e.g. "approved"/"rejected". */
  outcome?: string;
  at: string;
}

/** Emitted by MAM when an operator-managed vocabulary entry changes. Consumed by Search, WebSocket. The `kind` enum is Tier 0 (the SET of vocabularies is code-known); the terms themselves are data — see docs/architecture/configuration-and-reference-data.md. */
export interface TaxonomyUpdatedPayload {
  kind: 'tag' | 'category' | 'subject' | 'classification' | 'structure';
  action: 'created' | 'updated' | 'deleted' | 'moved' | 'deprecated' | 'merged';
  id: string;
  label?: string;
  /** For hierarchical categories. */
  parentId?: string;
  /** For action `merged`: the surviving term old references redirect to. */
  replacedById?: string;
  /** Snapshot version after this change; consumers may revalidate their cached reference snapshot. */
  configVersion?: number;
}

/** Emitted by MTS when all renditions for a job are produced and checksummed. Consumed by MAM and HSM. */
export interface TranscodeCompletedPayload {
  assetId: Ulid;
  jobId?: Ulid;
  renditions: Rendition[];
}

/** Emitted by MTS after a job exhausts retries. Consumed by Notifications and BMS. */
export interface TranscodeFailedPayload {
  assetId: Ulid;
  jobId?: Ulid;
  attempts?: number;
  error: Error;
}

/** Command issued by BMS/RIM to MTS to enqueue a transcode job. */
export interface TranscodeJobCreatePayload {
  assetId: Ulid;
  /** Transcode profile ids to produce. */
  presetIds: string[];
  /** HSM-resolved input path. */
  inputPath?: string;
  /** Optional preset-id -> desired output path. */
  outputPaths?: Record<string, string>;
  /** Higher runs sooner. */
  priority?: number;
}

/** Best-effort progress from MTS; drives progress bars, not state. May be dropped under load. */
export interface TranscodeProgressPayload {
  jobId: Ulid;
  assetId?: Ulid;
  percent: number;
  /** Realtime factor, e.g. 2.0 = 2x realtime. */
  speed?: number;
}

/** Emitted by MTS when a worker begins a job. */
export interface TranscodeStartedPayload {
  jobId: Ulid;
  assetId: Ulid;
  workerId?: string;
}

/** Emitted by IAM when a user account is created. Consumed by Notifications (welcome/onboarding) and Logging. Carries no credentials or sensitive PII. */
export interface UserCreatedPayload {
  userId: Ulid;
  username: string;
  /** Display name. */
  name?: string;
  state: UserState;
  createdBy?: string;
  createdAt: string;
}

/** Emitted by IAM when a user account changes (profile, state, role/rule assignment). Consumed by the WebSocket service and Logging. Carries only the names of changed fields — actual before/after values ride the audit delta (Logging §6.4), keeping PII off the broadcast bus. */
export interface UserUpdatedPayload {
  userId: Ulid;
  /** Field names that changed, e.g. ["state", "assignments"]. */
  changed: string[];
  /** New state, when state changed. */
  state?: UserState;
  at: string;
}

/** Emitted by BMS when a workflow instance reaches a terminal state. Consumed by Notifications and Logging. */
export interface WorkflowCompletedPayload {
  instanceId: Ulid;
  definitionId: Ulid;
  /** The asset the flow was about, when asset-scoped. */
  assetId?: Ulid;
  outcome: 'completed' | 'failed' | 'cancelled' | 'compensated';
  startedAt?: string;
  completedAt?: string;
  /** Present when outcome is failed. */
  error?: Error;
}

/** Emitted by BMS when a workflow instance reaches a step that another service must perform. Consumed by the target service and Logging. Concrete command steps are realized by issuing the target service's own command (e.g. a transcode step issues transcode.job.create); this event is the observable record that BMS requested the step. */
export interface WorkflowStepRequestedPayload {
  instanceId: Ulid;
  /** The published workflow definition this instance runs. */
  definitionId: Ulid;
  /** Node id within the workflow definition (NCName). */
  stepId: string;
  /** Matches the workflow-definition node kind driving this step. */
  stepKind: 'command' | 'human-task' | 'wait-event' | 'timer' | 'sub-flow';
  /** The service expected to act (e.g. "mts", "hsm"). Absent for internal steps. */
  target?: string;
  /** The asset in flow, when the step is asset-scoped. */
  assetId?: Ulid;
  /** Step-specific parameters; the target validates them against its own command contract. */
  params?: Record<string, never>;
}

/** Emitted by BMS when a human-in-the-loop task is created. Consumed by Notifications. */
export interface WorkflowTaskCreatedPayload {
  taskId: Ulid;
  workflowInstanceId?: Ulid;
  /** User or group id. */
  assignee: string;
  assetId?: Ulid;
  kind?: TaskKind;
  dueAt?: string;
}

/** Event type -> payload. `EventPayloads['asset.created']` is the payload of that event. */
export interface EventPayloads {
  'ai.enrichment.completed': AiEnrichmentCompletedPayload;
  'ai.enrichment.failed': AiEnrichmentFailedPayload;
  'ai.suggestion.raised': AiSuggestionRaisedPayload;
  'alert.raised': AlertRaisedPayload;
  'asset.approved': AssetApprovedPayload;
  'asset.created': AssetCreatedPayload;
  'asset.deleted': AssetDeletedPayload;
  'asset.expired': AssetExpiredPayload;
  'asset.ready': AssetReadyPayload;
  'asset.rejected': AssetRejectedPayload;
  'asset.replaced': AssetReplacedPayload;
  'asset.updated': AssetUpdatedPayload;
  'checksum.mismatch': ChecksumMismatchPayload;
  'checksum.verified': ChecksumVerifiedPayload;
  'config.changed': ConfigChangedPayload;
  'editor.render.requested': EditorRenderRequestedPayload;
  'feed.item.received': FeedItemReceivedPayload;
  'file.moved': FileMovedPayload;
  'file.placed': FilePlacedPayload;
  'gateway.access.logged': GatewayAccessLoggedPayload;
  'group.membership.changed': GroupMembershipChangedPayload;
  'ingest.accepted': IngestAcceptedPayload;
  'ingest.detected': IngestDetectedPayload;
  'ingest.rejected': IngestRejectedPayload;
  'message.sent': MessageSentPayload;
  'notification.raised': NotificationRaisedPayload;
  'permissions.changed': PermissionsChangedPayload;
  'person.created': PersonCreatedPayload;
  'person.linked': PersonLinkedPayload;
  'playout.export.completed': PlayoutExportCompletedPayload;
  'publish.completed': PublishCompletedPayload;
  'publish.failed': PublishFailedPayload;
  'recording.segment.completed': RecordingSegmentCompletedPayload;
  'restore.completed': RestoreCompletedPayload;
  'rundown.ready': RundownReadyPayload;
  'rundown.updated': RundownUpdatedPayload;
  'schedule.sent-to-air': ScheduleSentToAirPayload;
  'schedule.updated': ScheduleUpdatedPayload;
  'schedule.validated': ScheduleValidatedPayload;
  'story.updated': StoryUpdatedPayload;
  'task.created': TaskCreatedPayload;
  'task.updated': TaskUpdatedPayload;
  'taxonomy.updated': TaxonomyUpdatedPayload;
  'transcode.completed': TranscodeCompletedPayload;
  'transcode.failed': TranscodeFailedPayload;
  'transcode.job.create': TranscodeJobCreatePayload;
  'transcode.progress': TranscodeProgressPayload;
  'transcode.started': TranscodeStartedPayload;
  'user.created': UserCreatedPayload;
  'user.updated': UserUpdatedPayload;
  'workflow.completed': WorkflowCompletedPayload;
  'workflow.step.requested': WorkflowStepRequestedPayload;
  'workflow.task.created': WorkflowTaskCreatedPayload;
}

export type EventType = keyof EventPayloads;
