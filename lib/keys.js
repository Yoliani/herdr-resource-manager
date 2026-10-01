/**
 * Split a raw stdin chunk into individual key tokens. Escape sequences
 * (CSI like "\x1b[A" and SS3 like "\x1bOA") stay whole; every other
 * character is its own token, so coalesced reads like "gjjj" dispatch as
 * four keypresses.
 *
 * Returns { tokens, pending }: pending is the raw tail of an INCOMPLETE
 * escape sequence (e.g. the chunk ended mid-CSI with "\x1b["). The caller
 * must hold it and prepend it to the next chunk — dispatching it would
 * misread a split arrow key as Escape.
 */
export function tokenize(chunk) {
  const tokens = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i];
    if (ch === "\x1b") {
      const rest = chunk.slice(i);
      const csi = rest.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
      if (csi) {
        tokens.push(csi[0]);
        i += csi[0].length;
        continue;
      }
      const ss3 = rest.match(/^\x1bO[A-Za-z~]/);
      if (ss3) {
        tokens.push(ss3[0]);
        i += ss3[0].length;
        continue;
      }
      // Incomplete: lone ESC, ESC + "[", or ESC [ params without a final byte.
      if (/^\x1b(\[|$)/.test(rest) || /^\x1b\[[0-9;]*$/.test(rest)) {
        return { tokens, pending: rest };
      }
      if (/^\x1bO$/.test(rest)) {
        return { tokens, pending: rest };
      }
      tokens.push("\x1b");
      i += 1;
      continue;
    }
    tokens.push(ch);
    i += 1;
  }
  return { tokens, pending: null };
}
