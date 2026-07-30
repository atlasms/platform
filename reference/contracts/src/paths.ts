import { fileURLToPath } from 'node:url';

// contracts/src/paths.ts -> ../../../docs/architecture/schemas/
export const schemasDir = fileURLToPath(new URL('../../../docs/architecture/schemas/', import.meta.url));
export const eventsDir = fileURLToPath(new URL('../../../docs/architecture/schemas/events/', import.meta.url));
