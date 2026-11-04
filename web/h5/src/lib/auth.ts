/**
 * E2E 登录态读取。
 *
 * A12 契约：E2E 在页面加载前通过 addInitScript 写入 localStorage["e2e_token"]，
 * 页面请求层读取该 token 并注入 Authorization: Bearer。页面不硬编码 token。
 * 若测试侧通过 E2E_AUTH_STORAGE_KEY 改名，可用构建变量 VITE_E2E_AUTH_STORAGE_KEY 对齐。
 */
const DEFAULT_AUTH_STORAGE_KEY = 'e2e_token';

const AUTH_STORAGE_KEY: string =
  (import.meta.env.VITE_E2E_AUTH_STORAGE_KEY as string | undefined) ?? DEFAULT_AUTH_STORAGE_KEY;

export function readAuthToken(): string | null {
  try {
    const token = window.localStorage.getItem(AUTH_STORAGE_KEY);
    return token && token.trim().length > 0 ? token : null;
  } catch {
    // 隐私模式 / 存储被禁用时视为未登录，不影响行情展示。
    return null;
  }
}

export function hasAuthToken(): boolean {
  return readAuthToken() !== null;
}
