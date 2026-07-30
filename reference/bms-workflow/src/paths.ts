import { fileURLToPath } from 'node:url';

// Anchor to the docs tree so the reference impl uses the SINGLE-SOURCE schema + fixtures.
// src/paths.ts -> ../../../docs/architecture/
const ARCH = new URL('../../../docs/architecture/', import.meta.url);

export const schemasDir = fileURLToPath(new URL('schemas/', ARCH));
export const workflowsDir = fileURLToPath(new URL('workflows/', ARCH));
export const p = (base: string, rel: string) => fileURLToPath(new URL(rel, new URL(base)));
