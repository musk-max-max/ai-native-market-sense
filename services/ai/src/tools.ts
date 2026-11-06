/**
 * Tool registry 接口（INF-02）。
 *
 * 这里只定义注册表与工具元数据；具体工具（market/watchlist/研究数据）在后续批次接入。
 * 数据授权不在本服务判定：tool 的 requiredTier 仅用于声明数据需求，最终由 market gate
 * 在数据侧判定（ADR-007 D4 / Lead L126）。
 */

export type ToolTier =
  | 'internal_eval'
  | 'research_only'
  | 'c_end_display'
  | 'platform_user_data';

export type Audience = 'c_end' | 'internal';

export interface ToolContext {
  readonly userId: string;
  readonly audience: Audience;
  readonly asOf?: string;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly description: string;
  /** 数据侧最小档位声明；不是授权凭据。 */
  readonly requiredTier: ToolTier;
  execute(context: ToolContext, input: Input): Promise<Output>;
}

export interface ToolRegistry {
  register<Input, Output>(tool: ToolDefinition<Input, Output>): void;
  get(name: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
}

export class DuplicateToolError extends Error {
  public constructor(name: string) {
    super(`tool 已注册：${name}`);
    this.name = 'DuplicateToolError';
  }
}

export class InMemoryToolRegistry implements ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  public register<Input, Output>(tool: ToolDefinition<Input, Output>): void {
    if (this.#tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name);
    }
    this.#tools.set(tool.name, tool as ToolDefinition);
  }

  public get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  public list(): readonly ToolDefinition[] {
    return [...this.#tools.values()];
  }
}

export function createToolRegistry(): ToolRegistry {
  return new InMemoryToolRegistry();
}
