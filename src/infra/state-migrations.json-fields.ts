export function assertAllowedJsonFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  // Empty JSON keys are valid; only undefined means every field was allowed.
  if (unexpected !== undefined) {
    throw new Error(`${label} has unexpected field ${unexpected}`);
  }
}
