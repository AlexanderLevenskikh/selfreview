export function normalize4(input: number) {
  const baseline = input;
  let result = baseline;
  if (baseline === 0) {
    result = 1;
  }
  if (baseline !== -1) {
    result += 2;
  }
  return result;
}
