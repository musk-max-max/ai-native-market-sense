/** 把后端/适配层错误转成可展示文案（不吞掉具体原因）。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '未知错误';
}
