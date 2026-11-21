export function clockTime(at: number | null | undefined): string {
  if (at == null) return "never";
  return new Date(at).toLocaleTimeString();
}

export function milliseconds(value: number | null | undefined): string {
  return value == null ? "n/a" : `${Math.round(value)} ms`;
}
