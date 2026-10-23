// One git environment for every git call the kit makes. Git exports repository-location
// variables to the commands its hooks run (GIT_DIR always in a linked worktree, GIT_WORK_TREE
// with --work-tree, GIT_PREFIX, -c settings as GIT_CONFIG_PARAMETERS), and a parent process may
// set them too. Inherited, they would point a command at another repository than the one it
// names. Every call here names its repository itself, so they are dropped. The user's config
// files (GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM and the files they name) stay,
// so credential helpers, insteadOf rewrites and SSH settings keep working.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const GIT_LOCATION = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_PREFIX', 'GIT_TEMPLATE_DIR',
  'GIT_QUARANTINE_PATH', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS']);
// Variables that change what a command means or prints rather than where it runs: pathspec
// magic (GIT_LITERAL_PATHSPECS=1 turns `:/` into a literal path, so a grep over the whole tree
// matches nothing) and tracing (GIT_TRACE, GIT_TRACE_PACKET, GIT_TRACE2*, ... write to stderr or
// a file, so a caller reading stderr sees noise and a trace file collects arguments).
const PATHSPECS = new Set(['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']);
const behaviour = name => PATHSPECS.has(name) || /^GIT_TRACE/.test(name);
// Configuration injected through the environment rather than a file. GIT_CONFIG_COUNT with its
// GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n> is how a user or CI deliberately hands git settings
// (insteadOf rewrites, credential helpers); GIT_CONFIG (one file for git config only) and
// GIT_CONFIG_PARAMETERS (what a parent `git -c` passes on to its hooks) are inherited by accident.
const counted = name => name === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name);
const inherited = name => name === 'GIT_CONFIG' || name === 'GIT_CONFIG_PARAMETERS';

// The environment without repository-location, pathspec, trace or injected configuration
// variables. Git that contacts a remote passes keepConfig, so configuration the user gives as
// GIT_CONFIG_COUNT/KEY/VALUE still applies there; GIT_CONFIG and GIT_CONFIG_PARAMETERS never do.
// Every call still names its own repository, so none of it can choose another.
export function gitEnvironment(env = process.env, { keepConfig = false } = {}) {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !GIT_LOCATION.has(name) && !behaviour(name) && !inherited(name) && (keepConfig || !counted(name))));
}
// Git with nothing from the environment or the user's configuration: no GIT_* at all, no system
// or global config, so no inherited filters, hooks, replacements or alternates, and never a
// prompt. For reading a repository the kit only inspects or a cache it owns, never for contacting
// a remote. extra adds variables the caller sets itself.
export function isolatedGitEnvironment(env = process.env, extra = {}) {
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')));
  return { ...kept, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...extra };
}
// Runs git in directory (given as -C, so the repository is always the one named), or with no
// repository when directory is null (clone, ls-remote of a URL). Resolves with { stdout, stderr }
// and rejects as execFile does. options are execFile's; env defaults to gitEnvironment().
export function git(directory, args, options = {}) {
  return exec('git', directory === null ? args : ['-C', directory, ...args],
    { timeout: 120000, maxBuffer: 1024 * 1024, ...options, env: options.env ?? gitEnvironment() });
}
