// Help topics are the references of the core context-kit skill, so the CLI, the MCP
// tool and the installed skill all read the same text.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KIT_ROOT } from './hubs.mjs';
import { fail } from './files.mjs';

const directory = join(KIT_ROOT, 'skills', 'context-kit', 'references');

export async function help(topic) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.md')).map(name => name.slice(0, -3)).sort();
  if (topic === undefined) {
    const topics = [];
    for (const name of names) {
      const text = await readFile(join(directory, `${name}.md`), 'utf8');
      const summary = text.split('\n\n').slice(1).find(block => !block.startsWith('#') && !block.startsWith('|') && !block.startsWith('```'));
      topics.push({ topic: name, title: text.match(/^# (.+)$/m)?.[1] ?? name, summary: summary?.replace(/\s+/g, ' ').trim() ?? '' });
    }
    return { topics, next: 'Read one with help <topic>' };
  }
  if (!names.includes(topic)) fail('UNKNOWN_TOPIC', `No help topic: ${topic} (topics: ${names.join(', ')})`);
  return { topic, content: await readFile(join(directory, `${topic}.md`), 'utf8') };
}
