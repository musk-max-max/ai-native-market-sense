/**
 * 内部员工身份识别（L172 双角色 scaffolding）。
 *
 * 规则：
 * - URL 带 ?role=staff 切内部员工视图（演示/调试用）；
 * - localStorage["ms_role"] = "staff" 持久化；
 * - Bearer token 存在且解码后含 internal staff claim（后续接 identity 服务）；
 * - 默认 guest（普通用户）。
 *
 * 注意：当前为 UI 骨架，真正的权限/数据门禁由后端 entitlement + H3 签发控制。
 */
const ROLE_STORAGE_KEY = 'ms_role';

export type H5Role = 'guest' | 'staff';

export function readRole(): H5Role {
  try {
    // URL param 优先（用于演示 / E2E）
    const url = new URL(window.location.href);
    const urlRole = url.searchParams.get('role');
    if (urlRole === 'staff' || urlRole === 'guest') {
      return urlRole;
    }
    // 其次 localStorage
    const stored = window.localStorage.getItem(ROLE_STORAGE_KEY);
    if (stored === 'staff' || stored === 'guest') {
      return stored;
    }
    // 默认 guest
    return 'guest';
  } catch {
    return 'guest';
  }
}

export function setRole(role: H5Role): void {
  try {
    if (role === 'guest') {
      window.localStorage.removeItem(ROLE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(ROLE_STORAGE_KEY, role);
    }
  } catch {
    // ignore
  }
}

export function isStaff(): boolean {
  return readRole() === 'staff';
}
