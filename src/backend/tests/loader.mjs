/*
=============================================================================
MODULE: backend/tests/loader.mjs
PURPOSE: Offline test harness. Registers ESM loader hooks that mock every
"wix-*" module and map "backend/<name>" specifiers to src/backend/<name>.js,
so the real backend code can be imported and exercised with `node --test`
without a Wix Velo runtime and without node_modules.
SCOPE: tests only. Never imported by production code. G10 ASCII strict.
=============================================================================
*/

import { pathToFileURL } from 'node:url';
import { fileURLToPath, pathToFileURL as p2u } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/backend/tests -> src/backend
export const BACKEND_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Mock registry (mutable so tests can seed data / inspect calls)
// ---------------------------------------------------------------------------

export const wixDataMock = {
  _store: new Map(),          // collectionName -> array of items
  _calls: [],                 // audit trail of operations
  _seed(collection, items) {
    // JSON round-trip would serialize Date instances to ISO strings and
    // break date comparisons in queries (.lt/_createdDate). Revive ISO
    // strings back into Date objects so seeded rows match live Velo types.
    const revived = JSON.parse(JSON.stringify(items), (key, value) => {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? value : d;
      }
      return value;
    });
    this._store.set(collection, revived);
  },
  _reset() {
    this._store.clear();
    this._calls.length = 0;
  },
  query(collection) {
    const rows = () => this._store.get(collection) || [];
    const state = { filters: [], limitN: 30 };
    const cmpValue = (v) => (v instanceof Date ? v.getTime() : v);
    // Real Velo semantics: filter methods (eq/in/lt...) return the same
    // WixDataQuery, so .eq(...).limit(1).count() chains legally. The mock
    // mirrors that by returning `q` from every builder method.
    const q = {};
    q.eq = (field, value) => { state.filters.push([field, value]); return q; };
    q.in = (field, values) => { state.filters.push([field, values]); return q; };
    q.ne = (field, value) => { state.filters.push(['!=', field, value]); return q; };
    q.lt = (field, value) => { state.filters.push(['<', field, value]); return q; };
    q.gt = (field, value) => { state.filters.push(['>', field, value]); return q; };
    q.le = (field, value) => { state.filters.push(['<=', field, value]); return q; };
    q.ge = (field, value) => { state.filters.push(['>=', field, value]); return q; };
    q.between = (field, low, high) => { state.filters.push(['range', field, low, high]); return q; };
    q.contains = (field, value) => { state.filters.push(['has', field, value]); return q; };
    q.hasSome = (field, values) => { state.filters.push(['some', field, values]); return q; };
    q.ascending = () => q;
    q.descending = () => q;
    q.limit = (n) => { state.limitN = n; return q; };
    const applyFilters = () => {
      let items = rows().slice();
      for (const f of state.filters) {
        if (f[0] === '!=') { items = items.filter((it) => it[f[1]] !== f[2]); }
        else if (f[0] === '<') { items = items.filter((it) => cmpValue(it[f[1]]) < cmpValue(f[2])); }
        else if (f[0] === '>') { items = items.filter((it) => cmpValue(it[f[1]]) > cmpValue(f[2])); }
        else if (f[0] === '<=') { items = items.filter((it) => cmpValue(it[f[1]]) <= cmpValue(f[2])); }
        else if (f[0] === '>=') { items = items.filter((it) => cmpValue(it[f[1]]) >= cmpValue(f[2])); }
        else if (f[0] === 'range') { items = items.filter((it) => cmpValue(it[f[1]]) >= cmpValue(f[2]) && cmpValue(it[f[1]]) <= cmpValue(f[3])); }
        else if (f[0] === 'has') { items = items.filter((it) => Array.isArray(it[f[1]]) && it[f[1]].includes(f[2])); }
        else if (f[0] === 'some') { items = items.filter((it) => Array.isArray(it[f[1]]) && it[f[1]].some((v) => f[2].includes(v))); }
        else if (Array.isArray(f[1])) { items = items.filter((it) => f[1].includes(it[f[0]])); }
        else { items = items.filter((it) => it[f[0]] === f[1]); }
      }
      return items;
    };
    q.count = async () => {
      this._calls.push({ op: 'query', collection });
      return applyFilters().length;
    };
    q.find = async () => {
      this._calls.push({ op: 'query', collection });
      const items = applyFilters().slice(0, state.limitN);
      return { items, total: items.length };
    };
    return q;
  },
  get: async (collection, id) => {
    wixDataMock._calls.push({ op: 'get', collection });
    const rows = wixDataMock._store.get(collection) || [];
    return rows.find((r) => r._id === id) || null;
  },
  queryReferencedItems: async (collection, itemId, field) => {
    wixDataMock._calls.push({ op: 'queryReferencedItems', collection });
    const source = (wixDataMock._store.get(collection) || []).find((row) => row._id === itemId);
    const ids = Array.isArray(source?.[field]) ? source[field] : [];
    return { items: ids.map((value) => typeof value === 'object' ? value : { _id: value }) };
  },
  insert: async (collection, item) => {
    wixDataMock._calls.push({ op: 'insert', collection });
    const rows = wixDataMock._store.get(collection) || [];
    const saved = { _id: 'mock_' + (rows.length + 1), ...item };
    rows.push(saved);
    wixDataMock._store.set(collection, rows);
    return saved;
  },
  update: async (collection, item) => {
    wixDataMock._calls.push({ op: 'update', collection });
    const rows = wixDataMock._store.get(collection) || [];
    const idx = rows.findIndex((r) => r._id === item._id);
    if (idx >= 0) rows[idx] = item; else rows.push(item);
    return item;
  },
  remove: async (collection, item) => {
    wixDataMock._calls.push({ op: 'remove', collection });
    // Real Velo semantics: remove() deletes the row (accepts _id or object).
    // Purge crons (cleanAuditLogs et al.) assert against store state after
    // running, so the mock must actually mutate it.
    const id = (item && typeof item === 'object') ? item._id : item;
    const rows = wixDataMock._store.get(collection) || [];
    wixDataMock._store.set(collection, rows.filter((r) => r._id !== id));
    return item;
  },
};

export const mocks = {
  wixData: wixDataMock,
  logger: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    _calls: [],
  },
};

const GENERIC_STUB_SOURCE = `
const fnProxy = new Proxy(function () {}, {
  get: (t, p) => {
    if (p === 'then') return undefined;
    return fnProxy;
  },
  apply: () => fnProxy,
});
export const webMethod = (...args) => {
  // Real Velo semantics: webMethod(perm..., handler) returns the handler
  // (optionally wrapped). Tests call the exported handlers directly, so the
  // last function argument must be returned as-is.
  const fns = args.filter((a) => typeof a === 'function');
  return fns.length ? fns[fns.length - 1] : (handlerFn) => handlerFn;
};
export const Permissions = { Admin: 'ADMIN', SiteMember: 'MEMBER', Public: 'PUBLIC', Anyone: 'ANYONE' };
export const currentMember = fnProxy;
export const locations = fnProxy;
export const bookingsBackend = fnProxy;
export const paymentsBackend = fnProxy;
export const transactions = fnProxy;
export const media = fnProxy;
export const crypto = fnProxy;
export const members = { getCurrentMember: async () => null };
export const secrets = { getSecretValue: async () => "mock-secret" };
// Named SDK exports imported by backend code (offline stubs):
export const availabilityTimeSlots = fnProxy;
export const bookings = fnProxy;
export const checkout = fnProxy;
export const orders = fnProxy;
export const elevate = fnProxy;
export const createClient = () => fnProxy;
export const getSecret = async () => "mock-secret";
export function _namedExportFallback(name) { return fnProxy; }
const handler = { get: (t, p) => {
  if (p === 'then') return undefined;
  if (p === 'webMethod') return webMethod;
  if (p === 'Permissions') return Permissions;
  if (p === 'default') return fnProxy;
  if (!(p in t)) { t[p] = fnProxy; }
  return t[p];
} };
const mod = new Proxy({ default: fnProxy }, handler);
export default mod.default;
`;

const WIX_DATA_SOURCE = `
import { wixDataMock } from ${JSON.stringify(p2u(path.join(BACKEND_DIR, 'tests/loader.mjs')).href.replace(/\\/g, '/'))};
export const items = wixDataMock;
export default wixDataMock;
`;

// ---------------------------------------------------------------------------
// resolve/load hooks (used when run WITH --experimental-loader)
// ---------------------------------------------------------------------------

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('wix-') || specifier.startsWith('@wix/')) {
    // Offline harness: every Wix SDK package resolves to the generic stub.
    // wix-data keeps its dedicated in-memory mock below.
    return { url: 'mock:' + specifier, shortCircuit: true };
  }
  if (specifier.startsWith('backend/') || specifier.startsWith('public/')) {
    const rel = specifier.includes('/') ? specifier.slice(specifier.indexOf('/') + 1) : specifier;
    const rootDir = specifier.startsWith('public/') ? path.join(BACKEND_DIR, '..', 'public') : BACKEND_DIR;
    const abs = path.join(rootDir, rel.endsWith('.js') ? rel : rel + '.js');
    if (!fs.existsSync(abs)) {
      throw new Error('loader.mjs: cannot resolve Velo alias specifier ' + specifier + ' -> ' + abs);
    }
    return { url: pathToFileURL(abs).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('mock:wix-data') || url === 'mock:@wix/data') {
    return { format: 'module', source: WIX_DATA_SOURCE, shortCircuit: true };
  }
  if (url.startsWith('mock:')) {
    return { format: 'module', source: GENERIC_STUB_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
