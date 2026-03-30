/**
 * 信号处理模块
 *
 * 功能：
 * - 对生成的信号进行过滤和风险检查
 * - 计算卖出信号的数量和清仓策略
 * - 实施交易频率限制
 *
 * 买入检查顺序：
 * 1. 风险检查冷却（同标的同买卖方向短时间内不重复进入风险管道）
 * 2. 交易频率限制（同方向买入时间间隔）
 * 3. 清仓冷却（同监控标的任一方向触发冷却则双方向拒买）
 * 4. 买入价格限制（防止追高）
 * 5. 末日保护程序（收盘前 15 分钟拒绝买入）
 * 6. 牛熊证风险检查
 * 7. 实时账户/持仓拉取
 * 8. 基础风险检查（浮亏和持仓限制）
 *
 * 卖出策略：
 * - 趋势退出与结构失效统一使用全平语义
 * - 末日保护继续独立生成无条件清仓信号
 */
import { createRiskCheckPipeline } from './riskCheckPipeline.js';
import { processSellSignals } from './sellQuantityCalculator.js';
import type { SignalProcessor, SignalProcessorDeps } from './types.js';

/**
 * 创建信号处理器（工厂函数）
 * @param globalConfig - 全局交易配置，包含末日保护等系统级风控参数
 * @param liquidationCooldownTracker - 清仓冷却追踪器，用于判断是否在冷却期内
 * @returns SignalProcessor 实例
 */
export const createSignalProcessor = ({
  globalConfig,
  liquidationCooldownTracker,
}: SignalProcessorDeps): SignalProcessor => {
  /** 冷却时间记录：Map<symbol_direction, timestamp>，防止重复信号频繁触发风险检查 */
  const lastRiskCheckTime = new Map<string, number>();
  const applyRiskChecks = createRiskCheckPipeline({
    globalConfig,
    liquidationCooldownTracker,
    lastRiskCheckTime,
  });

  /**
   * 清空风险检查冷却时间记录
   * 跨日或重置场景下调用，确保新的一天不受前一天冷却状态影响
   */
  const resetRiskCheckCooldown = (): void => {
    lastRiskCheckTime.clear();
  };

  return {
    processSellSignals,
    applyRiskChecks,
    resetRiskCheckCooldown,
  };
};
