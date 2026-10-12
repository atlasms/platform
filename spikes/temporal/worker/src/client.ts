// Drives the checks from outside: `node src/client.ts probe <image>` | `start` | `signal <id> <verdict>`.
import { Client, Connection } from '@temporalio/client';

const [cmd, a, b] = process.argv.slice(2);
const connection = await Connection.connect({
  address: process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233',
});
const client = new Client({ connection, namespace: 'atlas' });
const taskQueue = process.env['TASK_QUEUE'] ?? 'spike';

if (cmd === 'probe') {
  const result = await client.workflow.execute('probe', {
    taskQueue,
    workflowId: `probe-${a}-${Date.now()}`,
    args: [a],
  });
  console.log(`PROBE OK: ${result}`);
} else if (cmd === 'start') {
  const id = `wait-${Date.now()}`;
  await client.workflow.start('waitForApproval', { taskQueue, workflowId: id, args: ['asset-1'] });
  console.log(id);
} else if (cmd === 'signal') {
  const handle = client.workflow.getHandle(a!);
  await handle.signal('approve', b!);
  console.log(`RESUMED: ${await handle.result()}`);
}
await connection.close();
