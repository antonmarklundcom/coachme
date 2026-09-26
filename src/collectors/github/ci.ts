export type CI = 'green' | 'red' | 'pending' | 'none' | 'unknown';
export function ciState(rollup?: { state?: string | null } | null, error = false): CI {
  if (error) return 'unknown';
  if (!rollup) return 'none';
  switch (rollup.state) {
    case 'SUCCESS': return 'green';
    case 'FAILURE': case 'ERROR': return 'red';
    case 'PENDING': case 'EXPECTED': return 'pending';
    default: return 'unknown';
  }
}
