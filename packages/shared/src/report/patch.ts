import type { PatchOperation } from '../schemas/ai.ts';

/** RFC 6902 subset (replace / add / remove) with RFC 6901 pointers. Never mutates the input. */

export class PatchError extends Error {
  constructor(
    message: string,
    public readonly op: PatchOperation,
  ) {
    super(message);
    this.name = 'PatchError';
  }
}

export function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new Error(`Invalid JSON pointer: ${path}`);
  return path
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function getAtPointer(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const token of parsePointer(path)) {
    if (Array.isArray(cur)) {
      const idx = Number(token);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (isObject(cur)) {
      cur = cur[token];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function applyPatch<T>(doc: T, ops: PatchOperation[]): T {
  let out: unknown = clone(doc);
  for (const op of ops) out = applyOne(out, op);
  return out as T;
}

function applyOne(doc: unknown, op: PatchOperation): unknown {
  const tokens = parsePointer(op.path);
  if (tokens.length === 0) {
    if (op.op === 'remove') throw new PatchError('Cannot remove the document root', op);
    return clone(op.value);
  }
  const parentTokens = tokens.slice(0, -1);
  const last = tokens[tokens.length - 1]!;
  const parent = getAtPointer(doc, pointerFrom(parentTokens));
  if (parent === undefined) throw new PatchError(`Path does not exist: ${op.path}`, op);
  if (Array.isArray(parent)) {
    if (last === '-') {
      if (op.op !== 'add') throw new PatchError(`"-" is only valid for add: ${op.path}`, op);
      parent.push(clone(op.value));
      return doc;
    }
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0)
      throw new PatchError(`Bad array index in ${op.path}`, op);
    switch (op.op) {
      case 'add':
        if (idx > parent.length) throw new PatchError(`Index out of range: ${op.path}`, op);
        parent.splice(idx, 0, clone(op.value));
        break;
      case 'replace':
        if (idx >= parent.length) throw new PatchError(`Path does not exist: ${op.path}`, op);
        parent[idx] = clone(op.value);
        break;
      case 'remove':
        if (idx >= parent.length) throw new PatchError(`Path does not exist: ${op.path}`, op);
        parent.splice(idx, 1);
        break;
    }
    return doc;
  }
  if (isObject(parent)) {
    switch (op.op) {
      case 'add':
        parent[last] = clone(op.value);
        break;
      case 'replace':
        if (!(last in parent)) throw new PatchError(`Path does not exist: ${op.path}`, op);
        parent[last] = clone(op.value);
        break;
      case 'remove':
        if (!(last in parent)) throw new PatchError(`Path does not exist: ${op.path}`, op);
        delete parent[last];
        break;
    }
    return doc;
  }
  throw new PatchError(`Parent is not a container: ${op.path}`, op);
}

function pointerFrom(tokens: string[]): string {
  if (tokens.length === 0) return '';
  return '/' + tokens.map((t) => t.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}
