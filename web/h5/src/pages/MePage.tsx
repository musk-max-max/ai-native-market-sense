/**
 * 「我的」Tab（/me）：账户 / 权限（entitlement）/ 退订（置顶）/ 免责全文
 * （docs/design/c-end-h5-v2.md §1.1、§4 合规落点清单）。
 *
 * 合规纪律：
 *  - 退订入口固定在本页**顶部区域**，不得藏到三级页面（硬约束 1）；
 *  - 免责声明由服务端版本化下发、不可关闭：本页只展示常驻摘要，不自行编写法律正文，
 *    也不渲染任何「关闭/收起」控件；
 *  - 未接入的通道（账户、退订接口）显式说明「尚未接入」，不给可点击的假按钮、不填占位数值。
 */
import { copy } from '../lib/copy';

export function MePage() {
  return (
    <div className="page me">
      <h1 className="page__title">{copy.me.title}</h1>

      <section className="card me__card" id="unsubscribe" aria-labelledby="me-unsubscribe">
        <h2 className="card__title" id="me-unsubscribe">
          {copy.me.unsubscribeTitle}
        </h2>
        <p className="card__note">{copy.me.unsubscribeNote}</p>
        <p className="card__hint">{copy.me.unsubscribePending}</p>
      </section>

      <section className="card me__card" aria-labelledby="me-account">
        <h2 className="card__title" id="me-account">
          {copy.me.accountTitle}
        </h2>
        <p className="card__note">{copy.me.accountAnonymous}</p>
      </section>

      <section className="card me__card" aria-labelledby="me-entitlement">
        <h2 className="card__title" id="me-entitlement">
          {copy.me.entitlementTitle}
        </h2>
        <p className="card__note">{copy.me.entitlementNote}</p>
      </section>

      <section className="card me__card" aria-labelledby="me-disclaimer">
        <h2 className="card__title" id="me-disclaimer">
          {copy.me.disclaimerTitle}
        </h2>
        <p className="card__note">{copy.app.footerNote}</p>
        <p className="card__hint">{copy.me.disclaimerNote}</p>
      </section>
    </div>
  );
}
