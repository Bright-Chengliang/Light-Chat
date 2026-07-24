import { publicError } from './security.mjs';

const MAX_FOLDERS = 30;
const MAX_ROLES_PER_FOLDER = 50;
const MAX_ROLES = 100;
const MAX_NAME_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 240;
// Keep the role definition limit aligned with the maximum model context
// configured by the application. Actual requests still use the selected
// model's token-aware context validation before reaching the upstream API.
const MAX_PROMPT_LENGTH = 16 * 1024 * 1024;

// Keep control characters which can alter how a definition is displayed or
// interpreted out of the store. Prompt line endings are normalised below, so
// CR is intentionally not included in this expression.
const DANGEROUS_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;
const COMPACT_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;
const ID_RE = /^[A-Za-z0-9_-]{3,64}$/u;

const invalidLibrary = (message = '角色库格式无效') =>
  publicError(400, message, 'INVALID_ROLE_LIBRARY');

function fail(message) {
  throw invalidLibrary(message);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normaliseText(value, label, { max, allowEmpty = false, prompt = false } = {}) {
  if (typeof value !== 'string') fail(`${label}格式无效`);
  const normalised = prompt ? value.replace(/\r\n?/gu, '\n') : value.trim();
  if (!allowEmpty && normalised.trim().length === 0) fail(`${label}不能为空`);
  if (normalised.length > max) fail(`${label}过长`);
  if ((prompt ? DANGEROUS_CONTROL_RE : COMPACT_CONTROL_RE).test(normalised)) {
    fail(`${label}包含危险控制字符`);
  }
  return normalised;
}

function normaliseId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    fail(`${label}需为 3–64 位字母、数字、下划线或连字符`);
  }
  return value;
}

function normaliseRole(input) {
  if (!isRecord(input)) fail('角色格式无效');
  return {
    id: normaliseId(input.id, '角色标识'),
    name: normaliseText(input.name, '角色名称', { max: MAX_NAME_LENGTH }),
    description: normaliseText(input.description ?? '', '角色描述', {
      max: MAX_DESCRIPTION_LENGTH,
      allowEmpty: true,
    }),
    systemPrompt: normaliseText(input.systemPrompt, '系统提示词', {
      max: MAX_PROMPT_LENGTH,
      prompt: true,
    }),
  };
}

function normaliseFolder(input, index, ids) {
  if (!isRecord(input)) fail(`第 ${index + 1} 个文件夹格式无效`);
  const folder = {
    id: normaliseId(input.id, '文件夹标识'),
    name: normaliseText(input.name, '文件夹名称', { max: MAX_NAME_LENGTH }),
    roles: [],
  };
  if (ids.has(folder.id)) fail(`标识重复：${folder.id}`);
  ids.add(folder.id);

  if (!Array.isArray(input.roles)) fail(`文件夹“${folder.name}”的角色列表无效`);
  if (input.roles.length > MAX_ROLES_PER_FOLDER) {
    fail(`文件夹“${folder.name}”最多包含 ${MAX_ROLES_PER_FOLDER} 个角色`);
  }
  for (const roleInput of input.roles) {
    const role = normaliseRole(roleInput);
    if (ids.has(role.id)) fail(`标识重复：${role.id}`);
    ids.add(role.id);
    folder.roles.push(role);
  }
  return folder;
}

export const EMPTY_ROLE_LIBRARY = Object.freeze({
  version: 1,
  folders: Object.freeze([]),
});

/**
 * Validate and canonicalise a role library. The returned object never shares
 * mutable arrays or objects with the caller and intentionally drops unknown
 * properties from input records.
 */
export function validateRoleLibrary(input) {
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.folders)) {
    fail('角色库必须包含 version: 1 和 folders 数组');
  }
  if (input.folders.length > MAX_FOLDERS) fail(`最多创建 ${MAX_FOLDERS} 个文件夹`);

  const ids = new Set();
  const folders = [];
  let roleCount = 0;
  for (let index = 0; index < input.folders.length; index += 1) {
    const folder = normaliseFolder(input.folders[index], index, ids);
    roleCount += folder.roles.length;
    if (roleCount > MAX_ROLES) fail(`角色总数不能超过 ${MAX_ROLES} 个`);
    folders.push(folder);
  }
  return { version: 1, folders };
}

/** Return a detached role record, or null when roleId is not present. */
export function findRole(library, roleId) {
  const normalised = validateRoleLibrary(library);
  if (typeof roleId !== 'string') return null;
  for (const folder of normalised.folders) {
    const role = folder.roles.find((candidate) => candidate.id === roleId);
    if (role) return { ...role };
  }
  return null;
}
