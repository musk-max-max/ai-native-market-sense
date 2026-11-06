/**
 * 「AI」Tab（/ai）：AI 解读聚合入口的**骨架页**。
 *
 * 合规纪律（红线④ / ADR-007 D3）：
 *  - 模型生成的每条内容都必须带 `AiGeneratedBadge`（标识 + 免责由服务端 P7 注入）；
 *  - 拿不到标识/免责时不得渲染模型文本，只能走「待接入」占位与数据缺口卡；
 *  - 本页当前没有聚合接口，因此只展示缺口卡与占位说明，不伪造 AI 文案、不摆样例解读。
 */
import { copy } from '../lib/copy';
import { DataGapCard } from '../components/DataGapCard';

export function AiHomePage() {
  return (
    <div className="page ai-home">
      <h1 className="page__title">{copy.aiHome.title}</h1>
      <p className="page__lede">{copy.aiHome.lede}</p>

      <DataGapCard
        gapKey="ai-aggregate"
        title={copy.aiHome.aggregateTitle}
        reason="not_integrated"
      />

      <section className="card" aria-label={copy.ai.sectionTitle}>
        <h2 className="card__title">{copy.ai.sectionTitle}</h2>
        <p className="card__note" role="note">
          {copy.aiHome.aggregateEmpty}
        </p>
        <p className="card__hint">{copy.ai.notGeneratedNote}</p>
      </section>
    </div>
  );
}
