/**
 * 登录态读写与 Bearer 注入（Q5-front 裁定，A6）。
 *
 * 键位契约：
 *  - 主键 `ms_token`：登录页 writeAuthToken 写入的通用登录态（Q5 裁定）；
 *  - 回退 `e2e_token`（可经构建变量 VITE_E2E_AUTH_STORAGE_KEY 改名）：
 *    A12 契约——E2E 在页面加载前用 addInitScript 写入该键，读取端保持回退，
 *    既有测试与 Dockerfile 构建参数（web/h5/Dockerfile:29）不需改动；
 *  - 页面不硬编码 token。
 */
import { navigate } from './router';

const PRIMARY_AUTH_STORAGE_KEY = 'ms_token';

const LEGACY_E2E_STORAGE_KEY: string =
  (import.meta.env.VITE_E2E_AUTH_STORAGE_KEY as string | undefined) ?? 'e2e_token';

/** 读取登录态：ms_token 优先，空/缺时回退 e2e_token；存储不可用视为未登录。 */
export function readAuthToken(): string | null {
  try {
    const primary = window.localStorage.getItem(PRIMARY_AUTH_STORAGE_KEY);
    if (primary && primary.trim().length > 0) return primary;
    const legacy = window.localStorage.getItem(LEGACY_E2E_STORAGE_KEY);
    return legacy && legacy.trim().length > 0 ? legacy : null;
  } catch {
    // 隐私模式 / 存储被禁用时视为未登录，不影响行情展示。
    return null;
  }
}

export function hasAuthToken(): boolean {
  return readAuthToken() !== null;
}

/**
 * 写入登录态（只写主键；不覆盖回退键）。
 * 空 token 忽略；隐私模式写入失败静默——调用方写后用 hasAuthToken() 复核，
 * 失败则停留在登录页报「存储不可用」，避免落进 401 跳转回环。
 */
export function writeAuthToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed.length === 0) return;
  try {
    window.localStorage.setItem(PRIMARY_AUTH_STORAGE_KEY, trimmed);
  } catch {
    // 隐私模式 / 配额满：无态可写，由调用方复核兜底。
  }
}

/** 清除登录态：主键与 E2E 回退键同删，防旧态复活。 */
export function clearAuthToken(): void {
  try {
    window.localStorage.removeItem(PRIMARY_AUTH_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_E2E_STORAGE_KEY);
  } catch {
    // 存储不可用时本就无态可清。
  }
}

/**
 * 带 Bearer 的 fetch：有登录态才注入 Authorization（Q5：cEndMetrics 网关三处裸 fetch 收口）。
 * 无 token 时原样透传，让服务端 401 fail-closed，前端再按域语义处理。
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = readAuthToken();
  if (token === null) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/**
 * 401 统一收口（Q5 分层单点裁定）：仅状态码 401 生效——非 /login 页收到 401 时
 * 同步 pushState 跳 /login?next=<当前路径+query>；navigate 是同步的，pathname 守卫
 * 使并发 401 天然去重、且不会在登录页自跳成环。
 * watchlist 域的 401→anonymous 在 apiGateway 提前分支处理，不会走到这里；
 * 登录页自身的 401（密码错误）由 LoginPage 就地报错，也不调用本函数。
 */
export function handleUnauthorized(status: number | null): void {
  if (status !== 401) return;
  if (typeof window === 'undefined') return;
  const { pathname, search } = window.location;
  if (pathname === '/login' || pathname === '/login/') return;
  navigate(`/login?next=${encodeURIComponent(`${pathname}${search}`)}`);
}
