export function clockTime(at: number | null | undefined, never: string): string {
  if (at == null) return never;
  return new Date(at).toLocaleTimeString();
}

export function milliseconds(value: number | null | undefined, strings: { notAvailable: string; milliseconds: (value: number) => string }): string {
  return value == null ? strings.notAvailable : strings.milliseconds(value);
}
