export function Panel({ name }: { name: string }) {
  const label = name;
  console.warn(label);
  return <section>{label}</section>;
}
