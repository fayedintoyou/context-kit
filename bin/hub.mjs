#!/usr/bin/env node
import { initWorkspace, selectRoot, KIT_ACTOR } from '../lib/workspace.mjs';
import { installAgents, agentStatus, uninstallAgents, setupWorkspace } from '../lib/install.mjs';
import { execute } from '../lib/operations.mjs';
import { parseArgs } from '../lib/arguments.mjs';
import { fail, errorData } from '../lib/files.mjs';

const help = `Usage: context-kit [--root <directory>] <command>        (context-kit help for topics)
  help [topic]
  init <new-directory> [--kit <npm-spec>] [--addons a,b|none]
  setup <new-directory> [--kit <npm-spec>] [--addons a,b|none] [agents install options]
  agents install [--agent claude,codex] [--scope user|project] [--project <dir>] [--name <server>] [--link] [--force] [--allow-write] [--global-mcp]
  agents status | agents uninstall [--agent claude,codex] [--force]
  list | validate
  context <hub-id> [--inbox]
  browse <hub-id> [directory] [--offset <n>] [--inbox]
  read <hub-id> <concept-id> [--frontmatter] [--inbox]
  search <text> [--inbox]
  skills | addons
  read-skill <hub-id> <reference> [--file <path>]
  capture <hub-id> <title> [--by <actor>]   (UTF-8 body on stdin)
  repos add <hub-id> [<upstream>] [--path <checkout>] [--alias a,b] [--title <t>] [--concept <id>] [--description <d>]
  repos | repos locate <repo> <path> | repos clone <repo> [<path>] | repos scan <directory> | repos sync
  specs stores | specs list | specs read <spec-id> | specs audit | specs garden   [--store <id>]
  specs parties --store <id>
  specs status <change> | specs next <change> | specs slice <change> <slice> | specs reconcile <change>   [--store <id>]
  specs archivable | specs archive --ready | specs archive --rehearse   [--store <id>]
  pr land <number> --sha <tested-sha> [--repo owner/name] [--wait] [--timeout <minutes>] [--method squash/rebase/merge]
      [--skip-review "<reason>"] [--no-checks "<reason>"] [--bootstrap-policy]
Root precedence: --root, CONTEXT_KIT_ROOT, toolkit checkout (read-only).`;
try {
  const { options, positional } = parseArgs(process.argv.slice(2), ['--root', '--inbox', '--store', '--kit', '--by', '--offset', '--frontmatter', '--file', '--addons', '--agent', '--scope', '--project', '--link', '--force', '--allow-write', '--global-mcp', '--name', '--help', '--path', '--alias', '--title', '--concept', '--description', '--ready', '--rehearse',
    '--sha', '--repo', '--wait', '--timeout', '--method', '--skip-review', '--no-checks', '--bootstrap-policy']);
  if (options['--help']) { process.stdout.write(help + '\n'); }
  else {
    const [command, ...args] = positional;
    let result;
    const list = value => value === undefined ? undefined : value === 'none' ? [] : value.split(',').map(item => item.trim()).filter(Boolean);
    const installFlags = ['--agent', '--scope', '--project', '--name', '--link', '--force', '--allow-write', '--global-mcp'];
    const installOptions = () => ({ agents: list(options['--agent']), scope: options['--scope'], project: options['--project'], name: options['--name'],
      link: Boolean(options['--link']), force: Boolean(options['--force']), allowWrite: Boolean(options['--allow-write']), globalMcp: Boolean(options['--global-mcp']) });
    if (!['agents', 'setup'].includes(command) && installFlags.some(flag => options[flag])) fail('INVALID_INPUT', 'Install options apply only to agents and setup');
    if (options['--addons'] && !['init', 'setup'].includes(command)) fail('INVALID_INPUT', '--addons applies only to init and setup');
    if ((command === 'init' || command === 'setup') && args.length === 1) {
      if (options['--root'] || options['--inbox'] || options['--store']) fail('INVALID_INPUT', `${command} takes its destination as an argument`);
      if (command === 'init') result = await initWorkspace(args[0], { kit: options['--kit'], addons: list(options['--addons']) });
      else {
        const installArgs = installFlags.flatMap(flag => options[flag] === undefined ? [] : options[flag] === true ? [flag] : [flag, options[flag]]);
        result = await setupWorkspace(args[0], { kit: options['--kit'], addons: list(options['--addons']), installArgs });
      }
    } else if (command === 'agents') {
      const root = (await selectRoot(options['--root'] || process.env.CONTEXT_KIT_ROOT)).root;
      if (args[0] === 'install' && args.length === 1) result = await installAgents(root, installOptions());
      else if (args[0] === 'status' && args.length === 1) result = await agentStatus(root);
      else if (args[0] === 'uninstall' && args.length === 1) result = await uninstallAgents(root, installOptions());
      else fail('INVALID_INPUT', help);
    } else {
      if (options['--kit']) fail('INVALID_INPUT', '--kit applies only to init');
      if (options['--by'] && command !== 'capture' && !(command === 'repos' && args[0] === 'add')) fail('INVALID_INPUT', '--by applies only to capture and repos add');
      if (options['--offset'] !== undefined && command !== 'browse') fail('INVALID_INPUT', '--offset applies only to browse');
      if (options['--frontmatter'] && command !== 'read') fail('INVALID_INPUT', '--frontmatter applies only to read');
      if ((options['--ready'] || options['--rehearse']) && !(command === 'specs' && args[0] === 'archive')) fail('INVALID_INPUT', '--ready and --rehearse apply only to specs archive');
      if (options['--ready'] && options['--rehearse']) fail('INVALID_INPUT', 'Pass --ready or --rehearse to specs archive, not both');
      if (options['--file'] && command !== 'read-skill') fail('INVALID_INPUT', '--file applies only to read-skill');
      const landFlags = ['--sha', '--repo', '--wait', '--timeout', '--method', '--skip-review', '--no-checks', '--bootstrap-policy'];
      if (landFlags.some(flag => options[flag] !== undefined) && !(command === 'pr' && args[0] === 'land')) fail('INVALID_INPUT', `${landFlags.join(', ')} apply only to pr land`);
      const selection = { ...await selectRoot(options['--root'] || process.env.CONTEXT_KIT_ROOT), source: 'cli', actor: options['--by'] || KIT_ACTOR, allowWrite: true };
      const count = { help: [0, 1], addons: [0], skills: [0], list: [0], validate: [0], context: [1], browse: [1, 2], read: [2], search: [1], 'read-skill': [2], capture: [2] };
      if (options['--inbox'] && !['context', 'search', 'browse', 'read'].includes(command)) fail('INVALID_INPUT', '--inbox applies only to context, search, browse and read');
      const storeCommands = ['list', 'read', 'audit', 'garden', 'parties', 'status', 'next', 'slice', 'reconcile', 'archivable', 'archive'];
      if (options['--store'] && (command !== 'specs' || !storeCommands.includes(args[0]))) fail('INVALID_INPUT', `--store applies only to specs ${storeCommands.join('/')}`);
      const store = options['--store'] ? { store: options['--store'] } : {};
      const addFlags = ['--path', '--alias', '--title', '--concept', '--description'];
      if (addFlags.some(flag => options[flag]) && !(command === 'repos' && args[0] === 'add')) fail('INVALID_INPUT', `${addFlags.join(', ')} apply only to repos add`);
      if (command === 'repos') {
        if (args[0] === 'add' && [2, 3].includes(args.length)) {
          const fields = { id: args[1], ...(args[2] ? { upstream: args[2] } : {}), aliases: list(options['--alias']) ?? [],
            ...Object.fromEntries(['title', 'concept', 'description'].filter(key => options[`--${key}`]).map(key => [key, options[`--${key}`]])) };
          result = options['--path'] ? await execute(selection, 'add_repo_checkout', { ...fields, path: options['--path'] }) : await execute(selection, 'add_repo', fields);
        } else if (args.length === 0) result = await execute(selection, 'list_repos');
        else if (args[0] === 'locate' && args.length === 3) result = await execute(selection, 'locate_repo', { repository: args[1], path: args[2] });
        else if (args[0] === 'clone' && [2, 3].includes(args.length)) result = await execute(selection, 'clone_repo', { repository: args[1], ...(args[2] ? { path: args[2] } : {}) });
        else if (args[0] === 'sync' && args.length === 1) result = await execute(selection, 'sync_repos');
        else if (args[0] === 'scan' && args.length === 2) result = await execute(selection, 'scan_repos', { directory: args[1] });
        else fail('INVALID_INPUT', help);
      } else if (command === 'specs') {
        if (args[0] === 'stores' && args.length === 1) result = await execute(selection, 'list_spec_stores');
        else if (args[0] === 'list' && args.length === 1) result = await execute(selection, 'list_specs', store);
        else if (args[0] === 'parties' && args.length === 1) result = await execute(selection, 'list_parties', store);
        else if (args[0] === 'garden' && args.length === 1) result = await execute(selection, 'garden_specs', store);
        else if (args[0] === 'audit' && args.length === 1) result = await execute(selection, 'audit_specs', store);
        else if (args[0] === 'read' && args.length === 2) result = await execute(selection, 'read_spec', { id: args[1], ...store });
        else if (args[0] === 'status' && args.length === 2) result = await execute(selection, 'change_status', { change: args[1], ...store });
        else if (args[0] === 'next' && args.length === 2) result = await execute(selection, 'next_slices', { change: args[1], ...store });
        else if (args[0] === 'slice' && args.length === 3) result = await execute(selection, 'read_slice', { change: args[1], slice: args[2], ...store });
        else if (args[0] === 'archivable' && args.length === 1) result = await execute(selection, 'archivable_changes', store);
        else if (args[0] === 'archive' && args.length === 1) {
          if (!options['--ready'] && !options['--rehearse']) fail('INVALID_INPUT', 'specs archive archives only ready changes; pass --ready (or --rehearse to only check)');
          result = await execute(selection, options['--rehearse'] ? 'archive_rehearse' : 'archive_ready', store);
        }
        else if (args[0] === 'reconcile' && args.length === 2) result = await execute(selection, 'reconcile_change', { change: args[1], ...store });
        else fail('INVALID_INPUT', help);
      } else if (command === 'pr') {
        if (!(args[0] === 'land' && args.length === 2 && /^[1-9][0-9]*$/.test(args[1]))) fail('INVALID_INPUT', help);
        if (!options['--sha']) fail('INVALID_INPUT', 'pr land needs --sha <the tested head SHA>');
        const timeout = options['--timeout'] === undefined ? undefined : Number(options['--timeout']);
        if (timeout !== undefined && !options['--wait']) fail('INVALID_INPUT', '--timeout applies only with --wait');
        result = await execute(selection, 'land_pull_request', { number: Number(args[1]), sha: options['--sha'], wait: Boolean(options['--wait']),
          bootstrapPolicy: Boolean(options['--bootstrap-policy']),
          ...Object.fromEntries([['repo', '--repo'], ['method', '--method'], ['skipReview', '--skip-review'], ['noChecks', '--no-checks']]
            .filter(([, flag]) => options[flag] !== undefined).map(([key, flag]) => [key, options[flag]])),
          ...(timeout === undefined ? {} : { timeout }) });
      } else {
        if (!Object.hasOwn(count, command) || !count[command].includes(args.length)) fail('INVALID_INPUT', help);
        const includeInbox = Boolean(options['--inbox']);
        if (command === 'list') result = await execute(selection, 'list_hubs');
        if (command === 'validate') result = await execute(selection, 'validate_hubs');
        if (command === 'context') result = await execute(selection, 'get_context', { id: args[0], includeInbox });
        if (command === 'browse') {
          const offset = options['--offset'] === undefined ? 0 : Number(options['--offset']);
          result = await execute(selection, 'browse_hub', { id: args[0], path: args[1] ?? '', offset, includeInbox });
        }
        if (command === 'read') result = await execute(selection, 'read_concept', { id: args[0], concept: args[1], frontmatter: Boolean(options['--frontmatter']), includeInbox });
        if (command === 'search') result = await execute(selection, 'search_context', { query: args[0], includeInbox });
        if (command === 'help') result = await execute(selection, 'help', args[0] === undefined ? {} : { topic: args[0] });
        if (command === 'addons') result = await execute(selection, 'list_addons');
        if (command === 'skills') result = await execute(selection, 'list_skills');
        if (command === 'read-skill') result = await execute(selection, 'read_skill', { id: args[0], reference: args[1], ...(options['--file'] ? { file: options['--file'] } : {}) });
        if (command === 'capture') {
          if (process.stdin.isTTY) fail('INVALID_INPUT', 'Pipe a UTF-8 note body into capture');
          const chunks = []; let bytes = 0;
          for await (const chunk of process.stdin) {
            bytes += chunk.length;
            if (bytes > 65536) fail('TOO_LARGE', 'Capture body exceeds 64 KiB');
            chunks.push(chunk);
          }
          let body;
          try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
          catch { fail('INVALID_UTF8', 'Capture body must be UTF-8'); }
          result = await execute(selection, 'capture_note', { id: args[0], title: args[1], body });
        }
      }
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.valid === false || ['structurally_invalid', 'no_canonical_specs'].includes(result.status)) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: errorData(error) }) + '\n');
  process.exitCode = 1;
}
