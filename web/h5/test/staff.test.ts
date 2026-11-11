/**
 * staff.ts unit tests (L172 dual-role scaffolding).
 *
 * Covers readRole priority (URL > localStorage > default guest),
 * setRole persistence semantics (guest clears storage), and isStaff.
 * Storage + URL are faked through a minimal window/globalThis shim so the
 * tests run under plain `node --test` (no jsdom dependency).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRole, setRole, isStaff } from '../src/lib/staff.ts';

type FakeStorage = {
  store: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function installFakeWindow(): FakeStorage {
  const store = new Map<string, string>();
  const storage: FakeStorage = {
    store,
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
  const fakeWindow = {
    location: { href: 'http://localhost:18000/' },
    localStorage: storage,
  };
  (globalThis as { window?: unknown }).window = fakeWindow;
  return storage;
}

function setUrlRole(role: string | null): void {
  const href = role === null ? 'http://localhost:18000/' : `http://localhost:18000/?role=${role}`;
  (globalThis as { window: { location: { href: string } } }).window.location.href = href;
}

test('readRole defaults to guest when no URL param and empty storage', () => {
  const storage = installFakeWindow();
  setUrlRole(null);
  assert.equal(storage.store.size, 0);
  assert.equal(readRole(), 'guest');
  assert.equal(isStaff(), false);
});

test('readRole prefers URL role=staff over stored guest', () => {
  const storage = installFakeWindow();
  storage.setItem('ms_role', 'guest');
  setUrlRole('staff');
  assert.equal(readRole(), 'staff');
  assert.equal(isStaff(), true);
});

test('readRole ignores unknown URL role and falls back to storage', () => {
  const storage = installFakeWindow();
  storage.setItem('ms_role', 'staff');
  setUrlRole('admin');
  assert.equal(readRole(), 'staff');
});

test('readRole ignores unknown stored value and defaults to guest', () => {
  const storage = installFakeWindow();
  storage.setItem('ms_role', 'root');
  setUrlRole(null);
  assert.equal(readRole(), 'guest');
});

test('setRole persists staff and clears storage for guest', () => {
  const storage = installFakeWindow();
  setUrlRole(null);
  setRole('staff');
  assert.equal(storage.getItem('ms_role'), 'staff');
  assert.equal(readRole(), 'staff');

  setRole('guest');
  assert.equal(storage.store.has('ms_role'), false);
  assert.equal(readRole(), 'guest');
});

test('readRole degrades to guest when window is unavailable', () => {
  delete (globalThis as { window?: unknown }).window;
  assert.equal(readRole(), 'guest');
  assert.equal(isStaff(), false);
  // setRole must not throw without window either.
  setRole('staff');
});
