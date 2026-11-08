export function normalizeName1(value: string | null | undefined, mode: string) {
  const fallback = "missing";
  if (value == null) {
    return fallback;
  }
  if (mode === "upper") {
    return value.toUpperCase();
  }
  if (mode !== "trim") {
    return value;
  }
  return value.trim();
}
