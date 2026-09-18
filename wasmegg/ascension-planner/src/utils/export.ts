/**
 * Utility to trigger a file download in the browser.
 */
export function downloadFile(filename: string, content: string, contentType: string) {
  downloadParts(filename, [content], contentType);
}

/**
 * The same download, from a file supplied in pieces.
 *
 * FOR ANYTHING THAT MIGHT BE LARGE. `new Blob([wholeFile])` needs the whole file as one JS string
 * first, and building that string is itself a full extra copy on top of whatever produced it --
 * three copies of a multi-hundred-megabyte chain table alive at once is what was killing the tab
 * on a big Insane export. An iterable lets the producer yield a chunk at a time and lets each one
 * be collected as soon as the Blob has taken it; the Blob holds the bytes once, and the browser is
 * free to back that with disk rather than the JS heap.
 *
 * The parts are accumulated into an array rather than folded into a growing Blob, which would copy
 * everything seen so far on every chunk and turn a linear job quadratic.
 */
export function downloadParts(filename: string, parts: Iterable<BlobPart>, contentType: string) {
  const blob = new Blob([...parts], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoked on the next turn rather than in this one. The browser reads the blob out of the URL
  // after the synthetic click returns, so revoking immediately is a race against that read -- one
  // this codebase has always run and evidently usually won, since the same-tick revoke shipped for
  // a long time. Deferring costs nothing and removes the race; it is a precaution, not a fix for
  // anything measured here.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
