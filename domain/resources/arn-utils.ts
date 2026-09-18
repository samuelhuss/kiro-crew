/** Shared ARN parsing helpers for resources that never went through a collector. */

/** Best-effort resourceId extraction: the last meaningful ARN path segment. */
export function deriveResourceIdFromArn(arn: string): string | null {
  const parts = arn.split(':');
  const tail = parts[parts.length - 1];
  if (!tail) return null;
  const afterSlash = tail.includes('/') ? tail.slice(tail.lastIndexOf('/') + 1) : tail;
  return afterSlash || null;
}
