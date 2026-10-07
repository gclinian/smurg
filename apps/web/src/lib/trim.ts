// Cutting a run of characters off the end of a text that came from someone else (a person's message, agent text, a
// file's contents). Written as a loop on purpose: `text.replace(/[.]+$/, '')` is tried again from every character of a
// long run that is NOT at the end ("a" + 16,000 dots + "b"), which costs the square of the run's length and held the
// page for seconds per message (review R4-03). Use this wherever the text is not the reader's own typing.

/** `text` without the characters of `chars` that stand at its end. Linear in the length of the text. */
export function trimEndOf(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1] as string)) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}
