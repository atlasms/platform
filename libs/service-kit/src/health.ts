// Liveness (is the process up) vs readiness (are dependencies OK). Non-critical checks can fail
// without flipping readiness — matching the "critical path is sacred" degradation model.
export type Check = () => Promise<boolean> | boolean;
interface Registered {
  name: string;
  check: Check;
  critical: boolean;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: { name: string; ok: boolean; critical: boolean }[];
}

export class HealthRegistry {
  private checks: Registered[] = [];
  register(name: string, check: Check, opts: { critical?: boolean } = {}): this {
    this.checks.push({ name, check, critical: opts.critical ?? true });
    return this;
  }
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }
  async readiness(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.checks.map(async (c) => {
        let ok = false;
        try {
          ok = await c.check();
        } catch {
          ok = false;
        }
        return { name: c.name, ok, critical: c.critical };
      }),
    );
    const status = results.every((r) => r.ok || !r.critical) ? 'ready' : 'not_ready';
    return { status, checks: results };
  }
}
