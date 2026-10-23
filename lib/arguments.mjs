import { fail } from './files.mjs';

// `repeatable` options may appear more than once and are collected into arrays.
export function parseArgs(argv, allowed, repeatable = []) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    if (!allowed.includes(value) || (Object.hasOwn(options, value) && !repeatable.includes(value))) fail('INVALID_INPUT', 'Unknown or repeated option: ' + value);
    if (['--root', '--store', '--kit', '--by', '--offset', '--file', '--addons', '--agent', '--scope', '--project', '--name', '--path', '--ref', '--to', '--alias', '--title', '--concept', '--description', '--http', '--host', '--public-host', '--allow-origin', '--max-sessions', '--session-idle', '--machine-name',
      '--sha', '--repo', '--timeout', '--method', '--skip-review', '--no-checks', '--depth', '--scan', '--clone', '--source', '--format', '--hub', '--at', '--role', '--budget'].includes(value)) {
      const operand = argv[++i];
      if (!operand || operand.startsWith('--')) fail('INVALID_INPUT', value + ' requires a value');
      if (repeatable.includes(value)) (options[value] ??= []).push(operand);
      else options[value] = operand;
    } else options[value] = true;
  }
  return { options, positional };
}
