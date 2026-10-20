import { fileURLToPath } from 'node:url';

// contracts/src/paths.ts -> ../../../docs/architecture/schemas/
export const schemasDir = fileURLToPath(
  new URL('../../../docs/architecture/schemas/', import.meta.url),
);
/** The designer's palette and the presets (EP-23.1) — read at runtime, so copied into images. */
export const workflowsDir = fileURLToPath(
  new URL('../../../docs/architecture/workflows/', import.meta.url),
);
export const eventsDir = fileURLToPath(
  new URL('../../../docs/architecture/schemas/events/', import.meta.url),
);
