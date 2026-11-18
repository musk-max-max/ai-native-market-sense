/**
 * PG 实现：P1a 主题视图（M1a，A3 2026-11-18）。
 *
 * 边界（与 PgCEndMetricsRepo 同约定）：
 *  - 只 SELECT serving.v_cend_theme_*，禁直接 SELECT DWD 表；
 *  - 数字以字符串透传（pg 默认 numeric → string），行序由 ORDER BY 保证；
 *  - 查询失败 fail-closed：错误原样上抛，由外壳转 5xx（不吞错、不以空数组冒充成功）。
 */

import type { Pool, PoolClient } from 'pg';

import type { CEndThemeRepo, ThemeFinHealthRow } from '../ports/c-end-theme-repo.js';

export class PgCEndThemeRepo implements CEndThemeRepo {
  constructor(private readonly pool: Pool | PoolClient) {}

  async getFinHealth(instrumentId: string): Promise<readonly ThemeFinHealthRow[]> {
    const { rows } = await this.pool.query<ThemeFinHealthRow>(
      'SELECT * FROM serving.v_cend_theme_fin_health WHERE instrument_id = $1 ORDER BY as_of DESC, period DESC',
      [instrumentId],
    );
    return rows;
  }
}
