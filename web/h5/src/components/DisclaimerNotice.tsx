/**
 * 免责声明展示。
 *
 * 合规硬约束（A7 system_prompt + contracts/shared DisclaimerMeta）：
 *  - 文案与版本必须原样来自 API meta.disclaimer，不由前端改写（组帧文案来自 lib/copy.ts）；
 *  - 不得折叠、不得低对比、不得渲染任何关闭/隐藏入口（契约 closable 恒为 false）；
 *  - 任何降价展示（包括受限、延时）都不允许把这个区块砍掉。
 */
import type { DisclaimerInfo } from '../data/model';
import { copy } from '../lib/copy';
import { TID } from '../lib/testids';

export function DisclaimerNotice({ disclaimer }: { disclaimer: DisclaimerInfo }) {
  return (
    <section
      className="disclaimer"
      data-testid={TID.disclaimer}
      role="note"
      aria-labelledby="disclaimer-heading"
    >
      <h2 id="disclaimer-heading" className="disclaimer__heading">
        {copy.disclaimer.title}
      </h2>
      <p className="disclaimer__text" data-testid={TID.disclaimerText}>
        {disclaimer.text}
      </p>
      <p className="disclaimer__meta">
        {copy.disclaimer.versionLabel}{' '}
        <span data-testid={TID.disclaimerVersion}>{disclaimer.version}</span>
        <span aria-hidden="true">{copy.units.separator}</span>
        {copy.disclaimer.notClosable}
      </p>
    </section>
  );
}

/** 仅在受限响应未携带免责元数据时出现：明确说明缺失，不伪造合规文案。 */
export function DisclaimerUnavailable() {
  return (
    <section
      className="disclaimer disclaimer--unavailable"
      data-testid={TID.disclaimer}
      role="note"
      aria-labelledby="disclaimer-unavailable-heading"
    >
      <h2 id="disclaimer-unavailable-heading" className="disclaimer__heading">
        {copy.disclaimer.title}
      </h2>
      <p className="disclaimer__text" data-testid={TID.disclaimerText}>
        {copy.disclaimer.unavailable}
      </p>
    </section>
  );
}
