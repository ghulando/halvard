// Helpers for reading transcript lines, which every tool writes as JSON objects.

export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function texts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => {
    const text = object(block).text;
    return typeof text === 'string' ? [text] : [];
  });
}
