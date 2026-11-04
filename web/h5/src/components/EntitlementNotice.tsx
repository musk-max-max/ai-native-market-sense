/**
 * 受限状态提示（403 / 无价格数字）。
 *
 * 合规（H4 #5 + H3）：
 *  - 403 的展示文案**原样**取自 API Problem 的 title/detail（服务端 copy.ts 是唯一真源），
 *    前端不改写、不拼接、不追加 hint；去掉这两段后本块不得剩任何解释性文案；
 *  - 前端不再维护「受限文案表」；无 Problem body 的结构异常由页面按整页错误处理；
 *  - 不得写成网络异常/加载失败，也不得写成不存在/已退市（那属于掩盖）；
 *  - 不展示权限分层取值、来源内部 ID 等内部标识；
 *  - 不渲染 quote-price 节点，保证 AC-5「受限矩阵零数值」。
 */
import { problemNoticeLines } from '../lib/problem';
import { TID } from '../lib/testids';
import type { ProblemNotice } from '../data/model';

export function EntitlementNotice({ problem }: { problem: ProblemNotice }) {
  const [title, ...details] = problemNoticeLines(problem);

  return (
    <section
      className="entitlement"
      data-testid={TID.entitlementNotice}
      role="status"
      aria-labelledby="entitlement-heading"
    >
      <h2 id="entitlement-heading" className="entitlement__title">
        {title}
      </h2>
      {details.map((line, index) => (
        <p key={index} className="entitlement__body">
          {line}
        </p>
      ))}
    </section>
  );
}
