/**
 * 指标展示项。
 * 类型用途：定义监控日志输出顺序中的单个展示元素，仅包含价格与涨跌幅。
 * 数据来源：由 indicatorProfile.displayPlan 编译生成。
 * 使用范围：marketMonitor 与展示层测试。
 */
export type DisplayIndicatorItem = 'price' | 'changePercent';

/**
 * 指标展示计划最小契约。
 * 类型用途：只表达展示层真正需要的 displayPlan，避免把完整画像当成运行时依赖边界。
 * 数据来源：StrategyRuntime 装配阶段生成或测试替身构造。
 * 使用范围：marketMonitor、展示层测试与轻量运行时快照。
 */
export type IndicatorDisplayProfile = {
  readonly displayPlan: ReadonlyArray<DisplayIndicatorItem>;
};
