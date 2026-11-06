import type { Actor } from '../domain/types';
import { actorSourceText } from '../lib/format';
import { TESTIDS } from '../lib/testids';

/**
 * 来源徽标：agent 与人类操作必须可区分（谁改的、哪次模型运行）。
 * 数据来源约定为 identity.AuditSink 的 actor{kind,id,modelVersion,runId}。
 */
export function ActorBadge({ actor }: { actor: Actor }) {
  const isAgent = actor.kind === 'agent';
  return (
    <span
      className={`c-actor ${isAgent ? 'is-agent' : 'is-human'}`}
      data-testid={TESTIDS.actorBadge}
      title={actorSourceText(actor)}
    >
      <span>{isAgent ? 'AI' : '人类'}</span>
      <span>{actor.id}</span>
      {isAgent && actor.modelVersion ? (
        <span className="c-actor-model">
          {actor.modelVersion}
          {actor.runId ? ` / ${actor.runId}` : ''}
        </span>
      ) : null}
    </span>
  );
}
