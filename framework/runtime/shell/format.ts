export function clockTime(at: number | null | undefined, never: string): string {
  if (at == null) return never;
  return new Date(at).toLocaleTimeString();
}

/** A moment that may be days ago: its date and time. */
export function clockAndDate(at: number): string {
  return new Date(at).toLocaleString();
}

export function milliseconds(value: number | null | undefined, strings: { notAvailable: string; milliseconds: (value: number) => string }): string {
  return value == null ? strings.notAvailable : strings.milliseconds(value);
}
