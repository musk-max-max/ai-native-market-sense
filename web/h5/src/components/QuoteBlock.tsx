/**
 * 行情区块。
 *
 * 数据口径约束：
 *  - 价格/涨跌幅原样来自 API quote（不做前端计算、不做单位换算）；
 *  - as_of 原样展示 source.as_of 的 ISO 字符串（AC-2 要求与 API 严格相等），
 *    时区说明放在 testid 节点之外，避免污染断言文本；
 *  - staleness_ms > 15min 才渲染延时标记；未超阈值时节点不存在（P0-04 双向断言）；
 *  - 缺失值用「—」，绝不用 0 冒充；
 *  - 文案来自 lib/copy.ts，来源标识经 SOURCE_LABELS 受控映射（data-source 保留原始枚举值）。
 */
import type { QuoteInfo, SourceInfo } from '../data/model';
import { copy, MISSING, sourceLabel } from '../lib/copy';
import {
  adjustmentLabel,
  formatChangePct,
  formatPrice,
  formatSignedAmount,
  formatStaleness,
  isStale,
  priceTone,
} from '../lib/format';
import { TID } from '../lib/testids';

interface QuoteBlockProps {
  quote: QuoteInfo;
  source: SourceInfo;
}

export function QuoteBlock({ quote, source }: QuoteBlockProps) {
  const stale = isStale(source.stalenessMs);
  const tone = priceTone(quote.changePct);

  return (
    <section className="quote" data-testid={TID.quoteBlock} aria-labelledby="quote-heading">
      <h2 id="quote-heading" className="sr-only">
        {copy.quote.ariaTitle}
      </h2>

      <div className="quote__main">
        <p className="quote__caption">
          {copy.quote.caption}
          <span aria-hidden="true">{copy.units.separator}</span>
          {copy.quote.captionSuffix}
        </p>
        <p className="quote__line">
          <span className={`quote__price quote__price--${tone}`} data-testid={TID.quotePrice}>
            {formatPrice(quote.lastPrice)}
          </span>
          <span className="quote__delta">
            <span className={`quote__change quote__change--${tone}`} data-testid={TID.quoteChange}>
              {formatChangePct(quote.changePct)}
            </span>
            <span className="quote__amount">
              {quote.change === null ? MISSING : `${formatSignedAmount(quote.change)} `}
              {copy.units.yuan}
            </span>
          </span>
        </p>
        {quote.suspended && <p className="quote__flag">{copy.quote.suspended}</p>}
      </div>

      <dl className="quote__meta">
        <div className="quote__meta-item quote__meta-item--wide">
          <dt>{copy.quote.asOfLabel}</dt>
          <dd>
            <time dateTime={source.asOf} data-testid={TID.quoteAsOf}>
              {source.asOf}
            </time>
          </dd>
        </div>
        <div className="quote__meta-item">
          <dt>{copy.quote.sourceLabel}</dt>
          <dd data-testid={TID.quoteSource} data-source={source.source}>
            {sourceLabel(source.source)}
          </dd>
        </div>
        <div className="quote__meta-item">
          <dt>{copy.quote.adjustmentLabel}</dt>
          <dd data-testid={TID.quoteAdjustment}>
            {adjustmentLabel(source.adjustment ?? undefined)}
          </dd>
        </div>
        <div className="quote__meta-item">
          <dt>{copy.quote.tradeDateLabel}</dt>
          <dd>{quote.tradeDate}</dd>
        </div>
      </dl>

      {stale && (
        <p className="quote__stale" data-testid={TID.quoteStaleBadge} role="status">
          {copy.quote.stalePrefix}
          {formatStaleness(source.stalenessMs)}
          {copy.quote.staleSuffix}
        </p>
      )}
    </section>
  );
}
