/**
 * Provider 抽象 + FakeProvider（INF-02）。
 *
 * 规则：AI 服务只依赖此接口；真实 vendor 适配器在 INF-03 接入，且不得把
 * 供应商/模型名写入对外契约或响应（ADR-007 D2/D4）。CI 只允许 FakeProvider。
 */

export interface AiCompletionRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly maxOutputTokens?: number;
}

export interface AiCompletionUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface AiCompletionResult {
  readonly text: string;
  readonly modelFamily: string;
  readonly usage?: AiCompletionUsage;
}

export interface AiStreamChunk {
  readonly delta: string;
  readonly done?: boolean;
}

export interface AiProvider {
  /** 内部标识，仅用于日志/health；不得写进对外响应。 */
  readonly name: string;
  /** 模型族标识，写入 ai.model_family；不得是供应商名。 */
  readonly modelFamily: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
  stream(request: AiCompletionRequest): AsyncIterable<AiStreamChunk>;
}

/** 确定性 FakeProvider：无网络、无密钥，CI/本地默认实现。 */
export class FakeProvider implements AiProvider {
  public readonly name = 'fake';
  public readonly modelFamily = 'fake-v1';

  public async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const prefix = request.system === undefined ? '' : `${request.system}: `;
    return {
      text: `[fake] ${prefix}${request.prompt}`,
      modelFamily: this.modelFamily,
      usage: {
        inputTokens: request.prompt.length,
        outputTokens: request.prompt.length,
      },
    };
  }

  public async *stream(request: AiCompletionRequest): AsyncIterable<AiStreamChunk> {
    const result = await this.complete(request);
    yield { delta: result.text };
    yield { delta: '', done: true };
  }
}

export function createFakeProvider(): AiProvider {
  return new FakeProvider();
}
