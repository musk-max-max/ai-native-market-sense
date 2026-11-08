/**
 * /dev/ai-card — AI 卡视觉采证 fixture 路由（A6，m00346）。
 *
 * 用途：为 A7 的 AI-2/AI-3 computed-style 采证（390×844 浅/深）提供
 * 天然渲染的完整 AI 卡结构：ai-generated / ai-badge / ai-disclaimer /
 * ai-context / 页面级与块内 ai-as-of，全部走生产组件与生产 CSS 类。
 *
 * 标注（红线）：本页数据为本地静态 fixture，**不是任何 API 的响应**，
 * 不发起任何 /v1 请求；仅用于视觉采证，不进入产品导航、不可从
 * TabBar 到达。生产接线（/v1/ai 客户端）就绪后由调用方注入 aiContent，
 * 本页保留作回归采证入口。
 *
 * 文案纪律：可见字符串一律 ASCII（compliance.test.ts 扫描 src 中文字面量，
 * 仅 lib/copy.ts / data/mockGateway.ts 豁免）；组件内中文来自 copy.ts。
 */
import { AiInterpretation, type AiSegmentKey } from '../components/AiInterpretation';
import type { AiGeneratedContent } from '../components/AiTextSlot';
import { DisclaimerNotice } from '../components/DisclaimerNotice';
import { QuoteBlock } from '../components/QuoteBlock';
import type { DisclaimerInfo, QuoteInfo, SourceInfo } from '../data/model';

/** 与 E2E AI_AS_OF 同值，便于采证脚本逐字比对（tests/e2e/lib/ai-mock.js）。 */
const FIXTURE_AS_OF = '2026-11-06T15:00:00+08:00';

const FIXTURE_SOURCE: SourceInfo = {
  source: 'platform_snapshot',
  asOf: FIXTURE_AS_OF,
  stalenessMs: 60_000,
  adjustment: null,
};

const STALE_SOURCE: SourceInfo = {
  source: 'platform_snapshot',
  asOf: FIXTURE_AS_OF,
  stalenessMs: 1_800_000, // 30min > 15min threshold -> renders .quote__stale
  adjustment: null,
};

const FIXTURE_QUOTE: QuoteInfo = {
  tradeDate: '2026-11-06',
  lastPrice: 1680,
  prevClose: 1667.7,
  change: 12.3,
  changePct: 0.74,
  suspended: false,
  limitStatus: null,
};

const FIXTURE_DISCLAIMER: DisclaimerInfo = {
  text:
    'Fixture disclaimer for visual evidence collection. This sample is not an API response and not investment advice.',
  version: 'fixture-1',
  closable: false,
};

const FIXTURE_LABEL = 'AI generated (fixture)';
const FIXTURE_TEXT =
  'Fixture paragraph rendered through the production AiTextSlot path for computed-style evidence.';

/** 五段共用同一 fixture 文本三件套（label + disclaimer + asOf），AiTextSlot fail-closed 仍生效。 */
const FIXTURE_AI_CONTENT: Readonly<Partial<Record<AiSegmentKey, AiGeneratedContent>>> = {
  valuation: {
    text: FIXTURE_TEXT,
    label: FIXTURE_LABEL,
    disclaimer: FIXTURE_DISCLAIMER.text,
    asOf: FIXTURE_AS_OF,
  },
  growth: {
    text: FIXTURE_TEXT,
    label: FIXTURE_LABEL,
    disclaimer: FIXTURE_DISCLAIMER.text,
    asOf: FIXTURE_AS_OF,
  },
  'earnings-quality': {
    text: FIXTURE_TEXT,
    label: FIXTURE_LABEL,
    disclaimer: FIXTURE_DISCLAIMER.text,
    asOf: FIXTURE_AS_OF,
  },
  'capital-flow': {
    text: FIXTURE_TEXT,
    label: FIXTURE_LABEL,
    disclaimer: FIXTURE_DISCLAIMER.text,
    asOf: FIXTURE_AS_OF,
  },
  risk: {
    text: FIXTURE_TEXT,
    label: FIXTURE_LABEL,
    disclaimer: FIXTURE_DISCLAIMER.text,
    asOf: FIXTURE_AS_OF,
  },
};

export function AiCardFixturePage() {
  return (
    <div className="page ai-card-fixture" data-fixture="ai-card-visual-evidence">
      <h1 className="page__title">AI card visual fixture</h1>
      <p className="page__lede">
        Static fixture for computed-style evidence collection. Not an API response. Not
        investment advice.
      </p>

      <QuoteBlock quote={FIXTURE_QUOTE} source={FIXTURE_SOURCE} />

      <AiInterpretation
        quote={FIXTURE_QUOTE}
        source={FIXTURE_SOURCE}
        fundamental={null}
        fundamentalState="missing"
        aiContent={FIXTURE_AI_CONTENT}
      />

      <h2 className="page__section-title">Absent-state demos</h2>
      <p className="page__lede">
        Below blocks trigger conditional classes that the main fixture does not render.
      </p>

      {/* .quote__stale: stalenessMs above threshold */}
      <QuoteBlock quote={FIXTURE_QUOTE} source={STALE_SOURCE} />

      {/* .ai-slot--pending: no aiContent injected -> AiTextSlot null placeholder */}
      <AiInterpretation
        quote={FIXTURE_QUOTE}
        source={FIXTURE_SOURCE}
        fundamental={null}
        fundamentalState="missing"
        aiContent={{}}
      />

      <DisclaimerNotice disclaimer={FIXTURE_DISCLAIMER} />
    </div>
  );
}
