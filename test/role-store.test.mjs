import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_ROLE_LIBRARY, findRole, validateRoleLibrary } from '../lib/role-store.mjs';

const role = (id, overrides = {}) => ({
  id,
  name: `Role ${id}`,
  description: 'A useful role',
  systemPrompt: 'Answer clearly.\nUse tabs\twhen useful.',
  ...overrides,
});

const folder = (id, roles = [role(`${id}-r`)], overrides = {}) => ({
  id,
  name: `Folder ${id}`,
  roles,
  ...overrides,
});

test('validates and normalises a library while preserving folder and role order', () => {
  const input = {
    version: 1,
    folders: [
      folder('one', [role('one-r2', { name: '  Second  ', description: '  desc  ' }), role('one-r1')]),
      folder('two', [role('two-r1')]),
    ],
    ignored: 'not persisted',
  };
  const result = validateRoleLibrary(input);
  assert.deepEqual(result.folders.map(({ id }) => id), ['one', 'two']);
  assert.deepEqual(result.folders[0].roles.map(({ id }) => id), ['one-r2', 'one-r1']);
  assert.equal(result.folders[0].roles[0].name, 'Second');
  assert.equal(result.folders[0].roles[0].description, 'desc');
  assert.equal('ignored' in result, false);
  input.folders[0].roles[0].name = 'mutated';
  assert.equal(result.folders[0].roles[0].name, 'Second');
});

test('empty library has the canonical version and no folders', () => {
  assert.deepEqual(validateRoleLibrary(EMPTY_ROLE_LIBRARY), { version: 1, folders: [] });
});

test('rejects duplicate IDs across folders and roles', () => {
  assert.throws(
    () => validateRoleLibrary({ version: 1, folders: [folder('same', [role('same-r')]), folder('same', [])] }),
    (error) => error.code === 'INVALID_ROLE_LIBRARY' && error.status === 400,
  );
  assert.throws(
    () => validateRoleLibrary({ version: 1, folders: [folder('one', [role('same'), role('same')])] }),
    (error) => error.code === 'INVALID_ROLE_LIBRARY',
  );
});

test('rejects NUL and other dangerous control characters but allows prompt newlines and tabs', () => {
  assert.throws(
    () => validateRoleLibrary({ version: 1, folders: [folder('one', [role('one-r', { systemPrompt: 'ok\0bad' })])] }),
    (error) => error.code === 'INVALID_ROLE_LIBRARY',
  );
  assert.throws(
    () => validateRoleLibrary({ version: 1, folders: [folder('one', [role('one-r', { name: 'bad\nname' })])] }),
    (error) => error.code === 'INVALID_ROLE_LIBRARY',
  );
  const result = validateRoleLibrary({ version: 1, folders: [folder('one', [role('one-r', { systemPrompt: 'line 1\r\nline 2\rline 3\t' })])] });
  assert.equal(result.folders[0].roles[0].systemPrompt, 'line 1\nline 2\nline 3\t');
});

test('rejects empty prompts and configured size limits', () => {
  assert.throws(
    () => validateRoleLibrary({ version: 1, folders: [folder('one', [role('one-r', { systemPrompt: ' \n\t ' })])] }),
    (error) => error.code === 'INVALID_ROLE_LIBRARY',
  );
  assert.throws(
    () => validateRoleLibrary({ version: 1, folders: [folder('one', [role('one-r', { name: 'x'.repeat(61) })])] }),
    (error) => error.code === 'INVALID_ROLE_LIBRARY',
  );
  assert.throws(
    () => validateRoleLibrary({ version: 1, folders: [folder('one', Array.from({ length: 51 }, (_, i) => role(`r-${String(i).padStart(2, '0')}`)))] }),
    (error) => error.code === 'INVALID_ROLE_LIBRARY',
  );
  assert.throws(
    () => validateRoleLibrary({ version: 1, folders: Array.from({ length: 31 }, (_, i) => folder(`f-${String(i).padStart(2, '0')}`, [])) }),
    (error) => error.code === 'INVALID_ROLE_LIBRARY',
  );
  const tooManyRoles = Array.from({ length: 101 }, (_, i) => role(`r-${String(i).padStart(3, '0')}`));
  const split = Array.from({ length: 3 }, (_, i) => folder(`f-${i}`, tooManyRoles.slice(i * 40, i * 40 + 40)));
  assert.throws(
    () => validateRoleLibrary({ version: 1, folders: [...split, folder('f-last', [role('r-last')])] }),
    (error) => error.code === 'INVALID_ROLE_LIBRARY',
  );
});

test('allows system prompts beyond the former arbitrary 50,000-character cap', () => {
  const systemPrompt = 'a'.repeat(50_001);
  const result = validateRoleLibrary({ version: 1, folders: [folder('one', [role('one-r', { systemPrompt })])] });
  assert.equal(result.folders[0].roles[0].systemPrompt.length, systemPrompt.length);
});

test('findRole returns a detached role and null for an unknown ID', () => {
  const library = { version: 1, folders: [folder('one', [role('one-r')]) ] };
  const found = findRole(library, 'one-r');
  assert.deepEqual(found, role('one-r'));
  found.name = 'changed';
  assert.equal(library.folders[0].roles[0].name, 'Role one-r');
  assert.equal(findRole(library, 'missing'), null);
  assert.equal(findRole(library, null), null);
});
