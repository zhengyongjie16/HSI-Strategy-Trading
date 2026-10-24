/** 执行命令纯规则：动作显示、合法中性订单类型、跨日与 protective 识别；不执行订单或日志 IO。 */
import { SIGNAL_ACTION_DESCRIPTIONS } from '../../constants/common.js';
import type { OrderTypeConfig, Signal } from '../../types/signal.js';
import { getHKDateKey } from '../../utils/time/index.js';

/**
 * 获取信号动作的中文描述。
 * 默认行为：从常量表 SIGNAL_ACTION_DESCRIPTIONS 取对应项；键全覆盖时无未匹配回退。
 *
 * @param signalAction 信号动作（BUYCALL/SELLCALL/BUYPUT/SELLPUT）
 * @returns 对应动作描述文本
 */
export function getActionDescription(signalAction: Signal['action']): string {
  return SIGNAL_ACTION_DESCRIPTIONS[signalAction];
}

/**
 * 验证并保留配置中的中性订单类型；SDK 转换只由 native adapter 执行。
 *
 * @param typeConfig 订单类型配置
 * @returns 已验证中性订单类型
 */
export function getOrderTypeFromConfig(typeConfig: OrderTypeConfig): OrderTypeConfig {
  switch (typeConfig) {
    case 'LO': {
      return 'LO';
    }

    case 'ELO': {
      return 'ELO';
    }

    case 'MO': {
      return 'MO';
    }

    default: {
      throw new Error(`[OrderExecutor] 未知订单类型配置: ${String(typeConfig)}`);
    }
  }
}

/**
 * 判断信号是否为跨日或无效触发时间的过期信号。
 * 默认行为：triggerTime 非法时判定为过期。
 *
 * @param signal 交易信号
 * @param now 当前时间
 * @returns true 表示过期，应跳过执行
 */
export function isStaleCrossDaySignal(signal: Signal, now: Date): boolean {
  if (!(signal.triggerTime instanceof Date) || Number.isNaN(signal.triggerTime.getTime())) {
    return true;
  }

  return getHKDateKey(signal.triggerTime) !== getHKDateKey(now);
}

/**
 * 判断信号是否为保护性清仓信号。
 *
 * @param signal 交易信号
 * @returns true 表示保护性清仓信号
 */
export function isLiquidationSignal(signal: Signal): boolean {
  return signal.isProtectiveLiquidation === true;
}
