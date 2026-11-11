import { useEffect, useState } from 'react';
import { copy } from '../lib/copy';
import { readRole, setRole, isStaff } from '../lib/staff';

/**
 * 顶部角色指示条（L172 C 端双角色 scaffolding）。
 *
 * - guest（普通用户）：显示"普通用户视图 · 合规展示"提示 + 切换入口；
 * - staff（内部员工）：显示"内部员工视图 · 全量数据 · AI 拉满"高对比提示 + 切回入口。
 *
 * 注意：这只是 UI 标识层；真正的数据范围/AI 能力仍由后端 entitlement + H3 制度签发控制。
 * 切换只影响当前浏览器（localStorage），不是跨设备登录态。
 */
export function StaffBanner() {
  const [role, setRoleState] = useState<'guest' | 'staff'>('guest');

  useEffect(() => {
    setRoleState(readRole());
  }, []);

  const onToggle = () => {
    const next = isStaff() ? 'guest' : 'staff';
    setRole(next);
    setRoleState(next);
    // 切换后刷新以让所有读取 role 的组件重新初始化
    window.location.reload();
  };

  if (role === 'staff') {
    return (
      <div className="staff-banner staff-banner--staff" data-testid="staff-banner" role="status">
        <span className="staff-banner__text">{copy.staff.banner}</span>
        <button type="button" className="staff-banner__switch" onClick={onToggle} data-testid="staff-switch">
          {copy.staff.switchToGuest}
        </button>
      </div>
    );
  }

  return (
    <div className="staff-banner staff-banner--guest" data-testid="guest-banner" role="status">
      <span className="staff-banner__text">{copy.staff.bannerGuest}</span>
      <button type="button" className="staff-banner__switch" onClick={onToggle} data-testid="guest-switch">
        {copy.staff.switchToStaff}
      </button>
    </div>
  );
}
