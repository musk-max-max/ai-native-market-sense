/**
 * 时间与 id 端口：领域逻辑不直接读 `Date.now()` / `randomUUID()`，测试才能钉住时间。
 */

import { randomUUID } from 'node:crypto';

import { uuidv7 } from '../domain/approval-ref.js';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** `usr_<uuidv7>`：服务端生成、永不复用（ADR-008 D1）。 */
  userId(): string;
  /** `app_<uuidv7>`：内部注册申请 id。 */
  applicationId(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * 默认 id 生成器：UUIDv7（时间有序，便于审计排序与索引局部性）。
 * 注意 `crypto.randomUUID()` 是 v4，不要用于审批 id（L51 要求 v7 形态 + DB CHECK）。
 */
export const uuidIdGenerator: IdGenerator = {
  userId: () => `usr_${uuidv7()}`,
  applicationId: () => `app_${uuidv7()}`,
};

/** 备用（非确定性场景，例如 E2E 夹具）。 */
export const randomIdGenerator: IdGenerator = {
  userId: () => `usr_${randomUUID()}`,
  applicationId: () => `app_${randomUUID()}`,
};
