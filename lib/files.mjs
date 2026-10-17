import { open, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export const MAX_FILE = 128 * 1024;
export const MAX_OUTPUT = 128 * 1024;
export function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}
export function errorData(error) {
  return { code: error.code || 'INVALID_INPUT', message: error.message };
}
export async function inside(root, path) {
  const base = await realpath(root);
  const target = await realpath(path);
  const offset = relative(base, target);
  if (offset === '..' || offset.startsWith('../') || isAbsolute(offset)) {
    fail('PATH_ESCAPE', `Path escapes its root: ${path}`);
  }
  return target;
}
export async function localFile(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path)) {
    fail('INVALID_PATH', `Expected a relative file path: ${path}`);
  }
  let file;
  try { file = await inside(root, resolve(root, path)); }
  catch (error) { if (error.code === 'ENOENT') fail('NOT_FOUND', `Missing file: ${path}`); throw error; }
  if (!(await stat(file)).isFile()) fail('INVALID_PATH', `Not a file: ${path}`);
  return file;
}
export async function readText(file, limit = MAX_FILE) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > limit) fail('TOO_LARGE', `File exceeds ${limit} bytes: ${file}`);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)); }
    catch { fail('INVALID_UTF8', `File is not UTF-8: ${file}`); }
  } finally { await handle.close(); }
}
