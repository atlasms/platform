// THE contract table: (policy, permission, context) -> expected decision.
//
// EP-05.5 requires that the server and the browser reach identical decisions. This table is the
// shared fixture both targets run — it deliberately contains no imports beyond types, so it can
// be loaded by a browser bundle as-is.

import type { EffectivePolicy, ResourceContext, Rule } from '../src/index.ts';

const rule = (r: Partial<Rule> & Pick<Rule, 'id' | 'permissions'>): Rule => ({ ...r });

export const SUBJECT = 'user-42';

export const policy: EffectivePolicy = {
  subjectId: SUBJECT,
  permVersion: 7,
  rules: [
    // Read anything, anywhere.
    rule({ id: 'r-read', permissions: ['asset:read'] }),
    // Write only football, only core+taxonomy fields.
    rule({
      id: 'r-football',
      permissions: ['asset:write'],
      scope: { categoryPaths: ['/sports/football/'] },
      fieldGroups: ['core', 'taxonomy'],
    }),
    // Write rights fields, but only on ready assets in ch12.
    rule({
      id: 'r-rights',
      permissions: ['asset:write'],
      scope: { channelIds: ['ch12'], states: ['ready'] },
      fieldGroups: ['rights'],
    }),
    // Full control of one's own drafts.
    rule({ id: 'r-own', permissions: ['asset:*'], scope: { ownedOnly: true } }),
    // Wildcard resource, single action.
    rule({ id: 'r-any-read', permissions: ['*:read'] }),
  ],
};

export interface Case {
  name: string;
  permission: string;
  ctx?: ResourceContext;
  allowed: boolean;
  /** undefined = all groups; an array = exactly these, sorted. */
  fieldGroups?: string[] | undefined;
}

export const cases: Case[] = [
  // --- permission matching -------------------------------------------------
  { name: 'plain grant', permission: 'asset:read', ctx: { channelId: 'ch99' }, allowed: true },
  {
    name: 'unrelated permission is refused',
    permission: 'schedule:send',
    ctx: { channelId: 'ch12', ownerId: 'other', state: 'draft' },
    allowed: false,
  },
  {
    name: 'resource wildcard grant covers a concrete permission',
    permission: 'schedule:read',
    ctx: { channelId: 'ch99', ownerId: 'other' },
    allowed: true,
  },
  {
    name: 'asking for a wildcard does not match a concrete grant',
    permission: 'asset:*',
    ctx: { channelId: 'ch99', ownerId: 'other' },
    allowed: false,
  },

  // --- category subtree ----------------------------------------------------
  {
    name: 'write inside the granted subtree',
    permission: 'asset:write',
    ctx: { channelId: 'ch99', categoryPath: '/sports/football/highlights/', ownerId: 'other' },
    allowed: true,
    fieldGroups: ['core', 'taxonomy'],
  },
  {
    name: 'write on the subtree root itself',
    permission: 'asset:write',
    ctx: { channelId: 'ch99', categoryPath: '/sports/football/', ownerId: 'other' },
    allowed: true,
    fieldGroups: ['core', 'taxonomy'],
  },
  {
    name: 'write outside the subtree is refused',
    permission: 'asset:write',
    ctx: { channelId: 'ch99', categoryPath: '/news/politics/', ownerId: 'other' },
    allowed: false,
  },
  {
    name: 'SECURITY: a sibling sharing a name prefix is NOT covered',
    permission: 'asset:write',
    // "/sports/football/" must not cover "/sports/footballing-legends/"
    ctx: { channelId: 'ch99', categoryPath: '/sports/footballing-legends/', ownerId: 'other' },
    allowed: false,
  },

  // --- field groups --------------------------------------------------------
  {
    name: 'asking for a granted field group',
    permission: 'asset:write',
    ctx: {
      channelId: 'ch99',
      categoryPath: '/sports/football/',
      fieldGroup: 'core',
      ownerId: 'other',
    },
    allowed: true,
    fieldGroups: ['core', 'taxonomy'],
  },
  {
    name: 'asking for a field group nobody grants here',
    permission: 'asset:write',
    ctx: {
      channelId: 'ch99',
      categoryPath: '/sports/football/',
      fieldGroup: 'rights',
      ownerId: 'other',
    },
    allowed: false,
  },
  {
    name: 'rights are writable on a ready asset in ch12',
    permission: 'asset:write',
    ctx: { channelId: 'ch12', state: 'ready', fieldGroup: 'rights', ownerId: 'other' },
    allowed: true,
    fieldGroups: ['rights'],
  },
  {
    name: 'rights are NOT writable once the asset is approved',
    permission: 'asset:write',
    ctx: { channelId: 'ch12', state: 'approved', fieldGroup: 'rights', ownerId: 'other' },
    allowed: false,
  },
  {
    name: 'field groups from several matching rules are unioned',
    permission: 'asset:write',
    ctx: { channelId: 'ch12', state: 'ready', categoryPath: '/sports/football/', ownerId: 'x' },
    allowed: true,
    fieldGroups: ['core', 'rights', 'taxonomy'],
  },

  // --- ownership -----------------------------------------------------------
  {
    name: 'an unrestricted rule on my own asset grants ALL field groups',
    permission: 'asset:write',
    ctx: {
      channelId: 'ch99',
      ownerId: SUBJECT,
      categoryPath: '/news/politics/',
      fieldGroup: 'rights',
    },
    allowed: true,
    fieldGroups: undefined, // r-own declares no fieldGroups => all
  },
  {
    name: "ownedOnly does not leak to someone else's asset",
    permission: 'asset:delete',
    ctx: { channelId: 'ch99', ownerId: 'other' },
    allowed: false,
  },

  // --- the broad question --------------------------------------------------
  {
    name: 'no context asks "could I write any asset?" — yes, somewhere',
    permission: 'asset:write',
    allowed: true,
    fieldGroups: undefined, // r-own matches broadly and grants all
  },
  {
    name: 'no context still refuses a permission held nowhere',
    permission: 'user:admin',
    allowed: false,
  },
];
