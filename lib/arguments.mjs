import { fail } from './files.mjs';

export function parseArgs(argv, allowed) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    if (!allowed.includes(value) || Object.hasOwn(options, value)) fail('INVALID_INPUT', 'Unknown or repeated option: ' + value);
    if (['--root', '--store', '--kit', '--by', '--offset', '--file', '--addons', '--agent', '--scope', '--project', '--name', '--path', '--alias', '--title', '--concept', '--description'].includes(value)) {
      const operand = argv[++i];
      if (!operand || operand.startsWith('--')) fail('INVALID_INPUT', value + ' requires a value');
      options[value] = operand;
    } else options[value] = true;
  }
  return { options, positional };
}
