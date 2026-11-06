import type { Actor } from '../domain/types';

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/** ISO8601 → `YYYY-MM-DD HH:mm`（本地时区），仅用于展示；接口始终传 ISO。 */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function actorLabel(actor: Actor): string {
  return actor.kind === 'human' ? `人类 · ${actor.id}` : `AI · ${actor.id}`;
}

/** 审计来源的一行文本：谁改的、哪次模型运行。 */
export function actorSourceText(actor: Actor): string {
  if (actor.kind === 'human') return `人类工号 ${actor.id}`;
  const model = actor.modelVersion ? `模型 ${actor.modelVersion}` : '模型版本未知';
  const run = actor.runId ? ` / run ${actor.runId}` : '';
  return `agent ${actor.id}（${model}${run}）`;
}

export function shortId(id: string, length = 8): string {
  return id.length <= length ? id : `${id.slice(0, length)}…`;
}
