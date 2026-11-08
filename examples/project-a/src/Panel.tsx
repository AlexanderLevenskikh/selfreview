export function Panel({ name }: { name: string }) {
  var label = name;
  console.log(label);
  return <section>{label}</section>;
}
