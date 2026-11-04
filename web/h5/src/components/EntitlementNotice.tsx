/**
 * 受限状态提示（403 / 无价格数字）。
 *
 * 合规（H3）：
 *  - 只陈述「当前版本暂不提供该标的行情数据」，不让用户知道「谁不让」「为什么」；
 *  - 不得写成网络异常/加载失败，也不得写成不存在/已退市（那属于掩盖）；
 *  - 不展示权限分层取值、来源内部 ID 等内部标识；
 *  - 不渲染 quote-price 节点，保证 AC-5「受限矩阵零数值」。
 */
import { copy } from '../lib/copy';
import { TID } from '../lib/testids';

export function EntitlementNotice() {
  return (
    <section
      className="entitlement"
      data-testid={TID.entitlementNotice}
      role="status"
      aria-labelledby="entitlement-heading"
    >
      <h2 id="entitlement-heading" className="entitlement__title">
        {copy.entitlement.title}
      </h2>
      <p className="entitlement__body">{copy.entitlement.body}</p>
      <p className="entitlement__hint">{copy.entitlement.hint}</p>
    </section>
  );
}
