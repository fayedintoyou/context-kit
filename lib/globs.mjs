// Path globs over '/'-separated relative paths: `**/` matches zero or more directories, a bare
// `**` anything, `*` and `?` stay within one segment, and every other character is literal.
// Shared by landing's routine exemption and repository context packs. (lib/specs/progress.mjs
// keeps its own, looser matcher: its `**` and trailing `/` are part of how slices.yaml paths behave.)
export function globExpression(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      // [^]: any character, newlines included (`.` would stop at one, letting a name escape `**`).
      if (glob[i + 2] === '/') { source += '(?:[^]*/)?'; i += 2; } else { source += '[^]*'; i += 1; }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // u: `?` and `*` count code points, so `?` matches one emoji or astral letter, not half of one.
  return new RegExp(`^${source}$`, 'u');
}
export const matchesAny = (patterns, path) => (patterns ?? []).some(pattern => globExpression(pattern).test(path));

// Why a declared glob is refused, or null: globs are relative to the checkout, '/'-separated,
// with only `*`, `**` and `?` as wildcards, and no empty, `.` or `..` segment, leading `/` or backslash.
export function globProblem(glob) {
  if (glob.startsWith('/')) return 'it is absolute; globs are relative to the checkout';
  if (/[\\]/.test(glob)) return 'it holds a backslash; use /';
  if (/[\u0000-\u001f\u007f]/.test(glob)) return 'it holds a control character';
  if (/[[\]{}]/.test(glob) || /\*{3,}/.test(glob)) return 'only *, ** and ? are wildcards';
  if (glob.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return 'it has an empty, . or .. segment';
  return null;
}
