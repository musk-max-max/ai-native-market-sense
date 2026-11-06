/**
 * 密码哈希（P0）：`scrypt`（node:crypto 内置，无第三方依赖）。
 *
 * 存储格式：`scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`（参数随哈希入库，未来可平滑升级）。
 * 为什么不是 bcrypt/argon2：node 内置 scrypt 已满足 P0，且 CI/容器无需编译 native 模块；
 * 若要上 argon2id，替换本文件实现即可（密码格式含算法前缀，可共存迁移）。
 *
 * 安全细节：
 *   - `timingSafeEqual` 比较，避免字节级时间侧信道；
 *   - 未知邮箱也要跑一次同参数 scrypt（`DUMMY_PASSWORD_HASH`），防「账号枚举」的时间差
 *     （ADR-008 D2：内部注册/登录对邮箱做等时响应）；
 *   - 存储的 N/r/p 参与校验，篡改成非法参数返回 false，不抛异常。
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { readonly N: number; readonly r: number; readonly p: number },
) => Promise<Buffer>;

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function encode(buffer: Buffer): string {
  return buffer.toString('base64');
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(plain, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return [
    'scrypt',
    String(SCRYPT_PARAMS.N),
    String(SCRYPT_PARAMS.r),
    String(SCRYPT_PARAMS.p),
    encode(salt),
    encode(derived),
  ].join('$');
}

interface ParsedHash {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

const MAX_MEMORY = 128 * 1024 * 1024;

function parseStored(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6) {
    return null;
  }
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (algorithm !== 'scrypt') {
    return null;
  }
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 1 || r <= 0 || p <= 0) {
    return null;
  }
  // 拒绝异常参数：scrypt 的内存开销 ≈ 128*N*r，防止被篡改的 hash 拖垮进程。
  if (128 * N * r > MAX_MEMORY) {
    return null;
  }
  const salt = Buffer.from(saltRaw ?? '', 'base64');
  const hash = Buffer.from(hashRaw ?? '', 'base64');
  if (salt.length === 0 || hash.length === 0) {
    return null;
  }
  return { N, r, p, salt, hash };
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (parsed === null) {
    return false;
  }
  try {
    const derived = await scrypt(plain, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
    });
    return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}

/**
 * 等时响应用假哈希：未知邮箱/密码错误走同一条 scrypt 路径。
 * 内容为全零 salt + 全零 hash，任何明文都不会匹配。
 */
export const DUMMY_PASSWORD_HASH = [
  'scrypt',
  String(SCRYPT_PARAMS.N),
  String(SCRYPT_PARAMS.r),
  String(SCRYPT_PARAMS.p),
  encode(Buffer.alloc(SALT_LENGTH)),
  encode(Buffer.alloc(KEY_LENGTH)),
].join('$');
