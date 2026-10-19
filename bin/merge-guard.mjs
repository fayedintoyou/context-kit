#!/usr/bin/env node
// A Claude Code PreToolUse hook on Bash: denies a command that would merge a pull request
// directly (`gh pr merge`, or a `gh api` PUT to a pull request's merge endpoint) and points to
// `context-kit pr land`. It is a tripwire for agents acting in good faith, not a shell: it
// follows a bounded token and segment contract, and `sh -c` or `eval` strings, aliases,
// scripts and other clients such as curl are out of its reach. It fails open.
const MAX_COMMAND = 256 * 1024;
const MAX_DEPTH = 32;
export const DENY_REASON = 'Raw pull request merges are blocked by the Context Kit merge tripwire. ' +
  'Land it with: context-kit pr land <number> --sha <tested head SHA>. It checks the repository\'s expected checks ' +
  'and, for substantial work, the review record, then merges pinned to that SHA.';

// Segments split at ; && || | & newlines and parentheses, and the inside of $(…) and
// backticks becomes segments of its own. Words honour single and double quotes and
// backslash escapes.
export function segmentsOf(command) {
  const segments = [];
  let i = 0;
  function scan(stop, depth) {
    if (depth > MAX_DEPTH) throw new Error('nesting too deep');
    let words = [];
    let word = null;
    const endWord = () => { if (word !== null) words.push(word); word = null; };
    const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
    // A substitution's commands are segments of their own; its output joins the word as a placeholder.
    const substitute = close => { scan(close, depth + 1); word = (word ?? '') + '\u0000'; };
    while (i < command.length) {
      const char = command[i];
      if (stop && char === stop) { i++; endSegment(); return; }
      if (char === '\\') { if (command[i + 1] === '\n') { i += 2; continue; } word = (word ?? '') + (command[i + 1] ?? ''); i += 2; continue; }
      if (char === "'") {
        const end = command.indexOf("'", i + 1);
        word = (word ?? '') + command.slice(i + 1, end < 0 ? command.length : end);
        i = end < 0 ? command.length : end + 1;
        continue;
      }
      if (char === '"') {
        i++;
        word = word ?? '';
        while (i < command.length && command[i] !== '"') {
          if (command[i] === '\\' && '"\\$`\n'.includes(command[i + 1] ?? '')) { if (command[i + 1] !== '\n') word += command[i + 1]; i += 2; continue; }
          if (command[i] === '$' && command[i + 1] === '(') { i += 2; substitute(')'); continue; }
          if (command[i] === '`') { i++; substitute('`'); continue; }
          word += command[i++];
        }
        i++;
        continue;
      }
      if (char === '$' && command[i + 1] === '(') { i += 2; substitute(')'); continue; }
      if (char === '`') { i++; substitute('`'); continue; }
      if (char === '#' && word === null) { while (i < command.length && command[i] !== '\n') i++; continue; }
      if (';&|\n()'.includes(char)) { endSegment(); i++; continue; }
      if (/\s/.test(char)) { endWord(); i++; continue; }
      word = (word ?? '') + char;
      i++;
    }
    endSegment();
  }
  scan(null, 0);
  return segments;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['env', 'command', 'time']);
const MERGE_ENDPOINT = /^\/?repos\/[^/\s]+\/[^/\s]+\/pulls\/[^/\s]+\/merge\/?(?:\?.*)?$/;
// gh flags that take a value, so the value is not read as a subcommand.
const VALUED = new Set(['-R', '--repo', '-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field', '--input',
  '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);

export function isRawMerge(words) {
  let rest = [...words];
  for (;;) {
    if (rest.length && ASSIGNMENT.test(rest[0])) { rest.shift(); continue; }
    if (rest.length && WRAPPERS.has(rest[0])) { rest.shift(); while (rest.length && rest[0].startsWith('-')) rest.shift(); continue; }
    break;
  }
  const [program, ...args] = rest;
  if (!program || !(program === 'gh' || program.endsWith('/gh'))) return false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) { if (VALUED.has(args[i])) i++; continue; }
    positional.push(args[i]);
  }
  if (positional[0] === 'pr' && positional[1] === 'merge') return true;
  if (positional[0] !== 'api') return false;
  if (!positional.slice(1).some(word => MERGE_ENDPOINT.test(word))) return false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    const method = word === '-X' || word === '--method' ? args[i + 1]
      : word.startsWith('--method=') ? word.slice('--method='.length)
      : /^-X./.test(word) ? word.slice(2) : null;
    if (method && method.toUpperCase() === 'PUT') return true;
  }
  return false;
}

export function decide(payload) {
  if (payload?.tool_name !== 'Bash' || typeof payload.tool_input?.command !== 'string') return null;
  const command = payload.tool_input.command;
  if (command.length > MAX_COMMAND) return null;
  return segmentsOf(command).some(isRawMerge)
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON } }
    : null;
}

if (process.argv[1]?.endsWith('merge-guard.mjs')) {
  const chunks = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
    const decision = decide(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (decision) process.stdout.write(JSON.stringify(decision) + '\n');
  } catch (error) {
    process.stderr.write(`context-kit merge-guard: could not read the hook payload, allowing (${error.message})\n`);
  }
  process.exitCode = 0;
}
