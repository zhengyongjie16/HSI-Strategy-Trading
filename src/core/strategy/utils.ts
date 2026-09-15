import {
  STRATEGY_ID_PATTERN,
  STRATEGY_WINDOWS_RESERVED_DIRECTORY_NAMES,
} from '../../constants/strategy.js';

/**
 * 将严格 kebab-case 策略 ID 映射为对应的 camelCase 策略目录名。
 * 不会 trim、解码或修复非法输入；非法 ID 直接抛出错误。
 *
 * @param strategyId 原始策略 ID
 * @returns 与策略 ID 一一对应的目录名
 */
export function strategyIdToDirectoryName(strategyId: string): string {
  if (!STRATEGY_ID_PATTERN.test(strategyId)) {
    throw new Error(`[Strategy] 非法策略 ID: ${strategyId}`);
  }

  const [firstSegment, ...remainingSegments] = strategyId.split('-');
  if (firstSegment === undefined) {
    throw new Error(`[Strategy] 策略 ID 缺少首段: ${strategyId}`);
  }

  return [
    firstSegment,
    ...remainingSegments.map((segment) => {
      const [firstCharacter, ...remainingCharacters] = segment;
      if (firstCharacter === undefined) {
        throw new Error(`[Strategy] 策略 ID 存在空段: ${strategyId}`);
      }

      return `${firstCharacter.toUpperCase()}${remainingCharacters.join('')}`;
    }),
  ].join('');
}

/**
 * 将严格 camelCase 策略目录名反向映射为 kebab-case 策略 ID。
 * 映射结果必须能精确往返；非法目录名、保留设备名和大小写不符合项直接抛出错误。
 *
 * @param directoryName 实际策略目录名
 * @returns 与目录名一一对应的策略 ID
 */
export function strategyDirectoryNameToId(directoryName: string): string {
  if (
    directoryName.length === 0 ||
    STRATEGY_WINDOWS_RESERVED_DIRECTORY_NAMES.has(directoryName.toUpperCase())
  ) {
    throw new Error(`[Strategy] 非法策略目录名: ${directoryName}`);
  }

  const strategyId = directoryName.replaceAll(
    /[A-Z]/g,
    (character) => `-${character.toLowerCase()}`,
  );
  if (strategyIdToDirectoryName(strategyId) !== directoryName) {
    throw new Error(`[Strategy] 策略目录名无法精确映射: ${directoryName}`);
  }

  return strategyId;
}
