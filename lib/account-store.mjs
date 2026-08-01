import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  assertPassword,
  assertUsername,
  constantTimeTextEqual,
  hashPassword,
  publicError,
  verifyPassword,
} from './security.mjs';

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await copyFile(path, `${path}.bak`).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await rename(temp, path);
}

export class AccountStore {
  constructor(path) {
    this.path = path;
    this.data = null;
    this.dummyPassword = null;
    this.writeQueue = Promise.resolve();
    this.reservedCredits = new Map();
  }

  async initialize(bootstrapUsername, bootstrapPassword) {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      if ([1, 2].includes(parsed?.version)) {
        if (typeof parsed.username !== 'string' || !parsed.passwordHash) throw new Error('invalid account record');
        assertUsername(parsed.username);
        this.data = {
          version: 3,
          revision: 1,
          nextUserSequence: 0,
          users: [{
            uid: '00000', username: parsed.username, passwordHash: parsed.passwordHash, role: 'admin', disabled: false,
            credits: null, usagePoints: 0, chatCalls: 0, imageCalls: 0, modelGroupId: null, extraModels: [],
            createdAt: parsed.updatedAt || new Date().toISOString(), updatedAt: parsed.updatedAt || new Date().toISOString(),
          }],
          modelGroups: [],
        };
        await this.persist();
      } else {
        this.data = this.validateData(parsed);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error('账户数据无法读取或格式无效，服务拒绝启动');
      }
      assertUsername(bootstrapUsername);
      assertPassword(bootstrapPassword);
      const now = new Date().toISOString();
      this.data = {
        version: 3, revision: 1, nextUserSequence: 0, modelGroups: [],
        users: [{
          uid: '00000', username: bootstrapUsername, passwordHash: await hashPassword(bootstrapPassword), role: 'admin', disabled: false,
          credits: null, usagePoints: 0, chatCalls: 0, imageCalls: 0, modelGroupId: null, extraModels: [], createdAt: now, updatedAt: now,
        }],
      };
      await this.persist();
    }
    this.dummyPassword = await hashPassword('not-the-user-password');
  }

  validateData(parsed) {
    if (parsed?.version !== 3 || !Array.isArray(parsed.users) || !Array.isArray(parsed.modelGroups)) throw new Error('invalid account record');
    const userIds = new Set(); const usernames = new Set();
    const users = parsed.users.map((user) => {
      if (!user || typeof user.uid !== 'string' || (user.uid !== '00000' && !/^\d{7}$/.test(user.uid)) || userIds.has(user.uid)) throw new Error('invalid account uid');
      assertUsername(user.username);
      const normalizedUsername = user.username.toLocaleLowerCase('en-US');
      if (usernames.has(normalizedUsername) || !user.passwordHash || !['admin', 'user'].includes(user.role)) throw new Error('invalid account record');
      if ((user.uid === '00000') !== (user.role === 'admin')) throw new Error('invalid administrator record');
      const credits = user.role === 'admin' ? null : user.credits;
      if (credits !== null && (!Number.isSafeInteger(credits) || credits < 0 || credits > 1_000_000_000_000)) throw new Error('invalid credits');
      const counters = ['usagePoints', 'chatCalls', 'imageCalls'];
      for (const key of counters) if (!Number.isSafeInteger(user[key] ?? 0) || (user[key] ?? 0) < 0) throw new Error('invalid usage');
      const extraModels = this.validateModelIds(user.extraModels || []);
      userIds.add(user.uid); usernames.add(normalizedUsername);
      return {
        uid: user.uid, username: user.username, passwordHash: user.passwordHash, role: user.role, disabled: user.role === 'admin' ? false : user.disabled === true,
        credits, usagePoints: user.usagePoints || 0, chatCalls: user.chatCalls || 0, imageCalls: user.imageCalls || 0,
        modelGroupId: typeof user.modelGroupId === 'string' ? user.modelGroupId : null, extraModels,
        createdAt: typeof user.createdAt === 'string' ? user.createdAt : new Date().toISOString(), updatedAt: typeof user.updatedAt === 'string' ? user.updatedAt : new Date().toISOString(),
      };
    });
    if (!users.some((user) => user.uid === '00000' && user.role === 'admin')) throw new Error('administrator missing');
    const groupIds = new Set();
    const modelGroups = parsed.modelGroups.map((group) => {
      const id = typeof group?.id === 'string' ? group.id : '';
      const name = typeof group?.name === 'string' ? group.name.trim() : '';
      if (!/^[A-Za-z0-9_-]{3,48}$/.test(id) || groupIds.has(id) || !name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('invalid model group');
      groupIds.add(id); return { id, name, modelIds: this.validateModelIds(group.modelIds || []) };
    });
    for (const user of users) if (user.modelGroupId && !groupIds.has(user.modelGroupId)) user.modelGroupId = null;
    const nextUserSequence = Number.isInteger(parsed.nextUserSequence) && parsed.nextUserSequence >= 0 ? parsed.nextUserSequence : 0;
    return { version: 3, revision: Number.isSafeInteger(parsed.revision) ? parsed.revision : 1, nextUserSequence, users, modelGroups };
  }

  validateModelIds(value) {
    if (!Array.isArray(value) || value.length > 2000) throw publicError(400, '模型权限列表无效', 'INVALID_MODEL_ACCESS');
    const seen = new Set();
    return value.map((id) => {
      if (typeof id !== 'string' || !id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) throw publicError(400, '模型权限列表无效', 'INVALID_MODEL_ACCESS');
      seen.add(id); return id;
    });
  }

  async persist() {
    this.writeQueue = this.writeQueue.then(() => atomicWriteJson(this.path, this.data));
    await this.writeQueue;
  }

  bumpRevision() { this.data.revision = (this.data.revision || 0) + 1; }

  findUser(uid) { return this.data.users.find((user) => user.uid === uid) || null; }

  publicUser(user) {
    const group = user.modelGroupId ? this.data.modelGroups.find((item) => item.id === user.modelGroupId) : null;
    return {
      uid: user.uid, username: user.username, role: user.role, disabled: user.disabled, credits: user.credits,
      usagePoints: user.usagePoints, chatCalls: user.chatCalls, imageCalls: user.imageCalls,
      modelGroupId: user.modelGroupId, modelGroupName: group?.name || null, extraModels: [...user.extraModels],
      createdAt: user.createdAt, updatedAt: user.updatedAt,
    };
  }

  get username() {
    return this.findUser('00000').username;
  }

  get uid() {
    return '00000';
  }

  async authenticateAccount(username, password) {
    const candidate = typeof password === 'string' && password.length <= 256 ? password : '';
    let matched = null;
    if (typeof username === 'string') {
      for (const user of this.data.users) if (constantTimeTextEqual(username, user.username)) matched = user;
    }
    const passwordMatches = await verifyPassword(
      candidate,
      matched ? matched.passwordHash : this.dummyPassword,
    );
    return matched && passwordMatches && !matched.disabled ? this.publicUser(matched) : null;
  }

  async authenticate(username, password) { return Boolean(await this.authenticateAccount(username, password)); }

  isActive(uid) { const user = this.findUser(uid); return Boolean(user && !user.disabled); }
  isAdmin(uid) { return this.findUser(uid)?.role === 'admin'; }
  getPublicUser(uid) { const user = this.findUser(uid); return user ? this.publicUser(user) : null; }
  listUsers() { return this.data.users.map((user) => this.publicUser(user)); }
  listModelGroups() { return this.data.modelGroups.map((group) => ({ id: group.id, name: group.name, modelIds: [...group.modelIds] })); }

  allowedModelIds(uid) {
    const user = this.findUser(uid);
    if (!user) return new Set();
    if (user.role === 'admin') return null;
    const group = user.modelGroupId ? this.data.modelGroups.find((item) => item.id === user.modelGroupId) : null;
    return new Set([...(group?.modelIds || []), ...user.extraModels]);
  }

  canUseModel(uid, modelId) { const allowed = this.allowedModelIds(uid); return allowed === null || allowed.has(modelId); }

  async changeCredentials({ uid = '00000', username, currentPassword, newUsername, newPassword }) {
    const account = this.findUser(uid);
    if (!account) throw publicError(401, '登录已失效', 'AUTH_REQUIRED');
    assertPassword(currentPassword, { current: true });
    const authenticated = await this.authenticateAccount(username, currentPassword);
    if (!authenticated || authenticated.uid !== uid) {
      throw publicError(401, '用户名或原密码不正确', 'CURRENT_CREDENTIALS_INVALID');
    }

    const nextUsername = newUsername === undefined || newUsername === ''
      ? account.username
      : assertUsername(newUsername);
    const nextPasswordHash = newPassword === undefined || newPassword === ''
      ? account.passwordHash
      : await hashPassword(assertPassword(newPassword));

    if (nextUsername !== account.username && this.data.users.some((user) => user.uid !== uid && user.username.toLocaleLowerCase('en-US') === nextUsername.toLocaleLowerCase('en-US'))) {
      throw publicError(409, '用户名已存在', 'USERNAME_EXISTS');
    }
    if (nextUsername === account.username && nextPasswordHash === account.passwordHash) {
      throw publicError(400, '请填写新的用户名或密码', 'NO_ACCOUNT_CHANGE');
    }
    account.username = nextUsername; account.passwordHash = nextPasswordHash; account.updatedAt = new Date().toISOString(); this.bumpRevision(); await this.persist();
    return this.publicUser(account);
  }

  async createUser({ username, password, credits = 0, modelGroupId = null, extraModels = [] }) {
    const normalizedUsername = assertUsername(username);
    const normalizedPassword = assertPassword(password);
    if (this.data.users.some((user) => user.username.toLocaleLowerCase('en-US') === normalizedUsername.toLocaleLowerCase('en-US'))) throw publicError(409, '用户名已存在', 'USERNAME_EXISTS');
    if (!Number.isSafeInteger(credits) || credits < 0 || credits > 1_000_000_000_000) throw publicError(400, '初始积分无效', 'INVALID_CREDITS');
    if (modelGroupId !== null && !this.data.modelGroups.some((group) => group.id === modelGroupId)) throw publicError(400, '模型权限组不存在', 'MODEL_GROUP_NOT_FOUND');
    let sequence = this.data.nextUserSequence;
    let uid;
    do { uid = sequentialUserUid(sequence); sequence += 1; } while (this.findUser(uid));
    if (sequence > 10_000_000) throw publicError(503, '用户编号已耗尽', 'UID_EXHAUSTED');
    const now = new Date().toISOString();
    const user = { uid, username: normalizedUsername, passwordHash: await hashPassword(normalizedPassword), role: 'user', disabled: false, credits, usagePoints: 0, chatCalls: 0, imageCalls: 0, modelGroupId, extraModels: this.validateModelIds(extraModels), createdAt: now, updatedAt: now };
    this.data.nextUserSequence = sequence; this.data.users.push(user); this.bumpRevision(); await this.persist(); return this.publicUser(user);
  }

  requireOrdinaryUser(uid) {
    const user = this.findUser(uid);
    if (!user) throw publicError(404, '用户不存在', 'USER_NOT_FOUND');
    if (user.role === 'admin' || user.uid === '00000') throw publicError(403, '管理员账号不允许执行此操作', 'ADMIN_PROTECTED');
    return user;
  }

  async setUserDisabled(uid, disabled) {
    const user = this.requireOrdinaryUser(uid); user.disabled = disabled === true; user.updatedAt = new Date().toISOString(); this.bumpRevision(); await this.persist(); return this.publicUser(user);
  }

  async deleteUser(uid) {
    this.requireOrdinaryUser(uid); this.data.users = this.data.users.filter((user) => user.uid !== uid); this.reservedCredits.delete(uid); this.bumpRevision(); await this.persist();
  }

  async rechargeUser(uid, points) {
    const user = this.requireOrdinaryUser(uid);
    if (!Number.isSafeInteger(points) || points < 1 || points > 1_000_000_000) throw publicError(400, '充值积分需为 1–1000000000 的整数', 'INVALID_CREDITS');
    if (user.credits + points > 1_000_000_000_000) throw publicError(400, '用户积分超过上限', 'INVALID_CREDITS');
    user.credits += points; user.updatedAt = new Date().toISOString(); this.bumpRevision(); await this.persist(); return this.publicUser(user);
  }

  async saveModelGroups(groups, allowedModels) {
    if (!Array.isArray(groups) || groups.length > 100) throw publicError(400, '模型权限组格式无效', 'INVALID_MODEL_GROUPS');
    const allowed = new Set(allowedModels); const ids = new Set();
    const normalized = groups.map((group) => {
      const id = typeof group?.id === 'string' ? group.id : '';
      const name = typeof group?.name === 'string' ? group.name.trim() : '';
      if (!/^[A-Za-z0-9_-]{3,48}$/.test(id) || ids.has(id) || !name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) throw publicError(400, '模型权限组格式无效', 'INVALID_MODEL_GROUPS');
      const modelIds = this.validateModelIds(group.modelIds || []);
      if (modelIds.some((modelId) => !allowed.has(modelId))) throw publicError(400, '模型权限组包含未知模型', 'MODEL_NOT_ALLOWED');
      ids.add(id); return { id, name, modelIds };
    });
    this.data.modelGroups = normalized;
    for (const user of this.data.users) if (user.modelGroupId && !ids.has(user.modelGroupId)) user.modelGroupId = null;
    this.bumpRevision(); await this.persist(); return this.listModelGroups();
  }

  async setUserModelAccess(uid, { modelGroupId = null, extraModels = [] }, allowedModels) {
    const user = this.requireOrdinaryUser(uid); const allowed = new Set(allowedModels);
    if (modelGroupId !== null && !this.data.modelGroups.some((group) => group.id === modelGroupId)) throw publicError(400, '模型权限组不存在', 'MODEL_GROUP_NOT_FOUND');
    const normalizedExtraModels = this.validateModelIds(extraModels);
    if (normalizedExtraModels.some((modelId) => !allowed.has(modelId))) throw publicError(400, '用户权限包含未知模型', 'MODEL_NOT_ALLOWED');
    user.modelGroupId = modelGroupId; user.extraModels = normalizedExtraModels; user.updatedAt = new Date().toISOString(); this.bumpRevision(); await this.persist(); return this.publicUser(user);
  }

  reserveQuota(uid, mode, requestedCost = undefined) {
    const user = this.findUser(uid);
    if (!user || user.disabled) throw publicError(401, '登录已失效', 'AUTH_REQUIRED');
    const defaultCost = mode === 'image' ? 5 : 1;
    const cost = requestedCost === undefined ? defaultCost : Number(requestedCost);
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > 1_000_000) throw new Error('invalid quota cost');
    const reserved = this.reservedCredits.get(uid) || 0;
    if (user.role !== 'admin' && user.credits - reserved < cost) throw publicError(402, `积分不足，本次${mode === 'image' ? '生图' : '对话'}需要 ${cost} 积分`, 'INSUFFICIENT_CREDITS');
    if (user.role !== 'admin') this.reservedCredits.set(uid, reserved + cost);
    let settled = false;
    const release = () => {
      if (user.role === 'admin') return;
      const next = Math.max(0, (this.reservedCredits.get(uid) || cost) - cost);
      if (next) this.reservedCredits.set(uid, next); else this.reservedCredits.delete(uid);
    };
    return {
      cost,
      commit: async () => {
        if (settled) return; settled = true; release();
        if (user.role !== 'admin') user.credits -= cost;
        user.usagePoints += cost; if (mode === 'image') user.imageCalls += 1; else user.chatCalls += 1;
        user.updatedAt = new Date().toISOString(); this.bumpRevision(); await this.persist();
      },
      rollback: () => { if (settled) return; settled = true; release(); },
    };
  }
}

export function sequentialUserUid(sequence) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 9_999_999) throw new RangeError('普通用户 UID 序号必须在 0–9999999 之间');
  return String(sequence).padStart(7, '0');
}

export class JsonStore {
  constructor(path, fallback) {
    this.path = path;
    this.value = fallback;
    this.fallback = fallback;
  }

  async load() {
    try {
      this.value = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.value = structuredClone(this.fallback);
      await this.save(this.value);
    }
    return this.value;
  }

  async save(value) {
    await atomicWriteJson(this.path, value);
    this.value = value;
    return value;
  }
}
