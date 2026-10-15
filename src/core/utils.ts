/**
 * 检查值是否已定义（不是 null 或 undefined）。默认行为：无。
 *
 * @param value 待检查的值
 * @returns 值非 null 且非 undefined 时返回 true，否则返回 false
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
