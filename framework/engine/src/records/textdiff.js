// Minimal single edit turning `oldText` into `newText`: common prefix and
// suffix are kept, the middle is replaced. Concurrent edits at different
// positions then touch different characters and merge.
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

export function textEdit(oldText, newText) {
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  // Do not split a surrogate pair.
  if (prefix > 0 && isHigh(oldText.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) suffix++;
  if (suffix > 0 && isLow(oldText.charCodeAt(oldText.length - suffix))) suffix--;
  return {
    index: prefix,
    deleteCount: oldText.length - prefix - suffix,
    insert: newText.slice(prefix, newText.length - suffix),
  };
}
