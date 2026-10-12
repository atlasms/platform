// Check 2: the workflow code is bundled when the IMAGE is built. The worker then loads this file
// (`workflowBundle: { codePath }`) and webpack never runs in the container.
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode } from '@temporalio/worker';

const started = Date.now();
const { code } = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL('./src/workflows.ts', import.meta.url)),
});
await mkdir('dist', { recursive: true });
await writeFile('dist/workflow-bundle.js', code);
console.log(`bundled ${code.length} bytes in ${Date.now() - started} ms`);
