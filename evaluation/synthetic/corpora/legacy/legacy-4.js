export function legacy4(input) {
  var working = input;
  var result = 0;
  if (working == 0) result = 1;
  if (working != 1) result += 2;
  return String(result).substr(0, 3);
}
