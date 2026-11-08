export function legacyName(value) {
  var name = value == null ? '' : value;
  return name.substr(0, 4);
}
