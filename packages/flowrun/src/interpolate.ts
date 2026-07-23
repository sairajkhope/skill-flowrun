export function interpolate(
  template: string,
  params: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in params)) {
      throw new Error(`Missing param for placeholder {{${key}}}`);
    }
    return params[key];
  });
}

export function collectPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
    out.add(m[1]);
  }
  return [...out];
}
