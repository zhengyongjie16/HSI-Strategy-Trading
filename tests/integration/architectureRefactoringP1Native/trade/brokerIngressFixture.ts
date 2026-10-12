/** 高层自然 Actor 组装：依赖 core/application 与 infra producer 的中性 ports，SDK DTO 不越界。 */
import { createBrokerIngressFixture as createSdkFixture } from '../../../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { orderEconomics } from '../../../../src/domain/order/orderEconomics.js';
import { createOrderRecorder } from '../../../../src/core/orderRecorder/index.js';
import type { OrderRecorderFactoryDeps } from '../../../../src/core/orderRecorder/types.js';
import type {
  OrderRecorder,
  RawOrderFromAPI,
  RateLimiter,
} from '../../../../src/types/services.js';
import { createOrderMonitor } from '../../../../src/core/trader/orderMonitor/index.js';
import { createOrderOps } from '../../../../src/core/trader/orderMonitor/orderOps.js';
import { createRouteProcessor } from '../../../../src/core/trader/orderMonitor/routeProcessor.js';
import { createOrderStatusQuery } from '../../../../src/core/trader/orderMonitor/orderStatusQuery.js';
import type { AccountServiceDeps } from '../../../../src/types/accountReadPorts.js';
import { createAccountService } from '../../../../src/application/accountQuery/index.js';
import { createOrderExecutor } from '../../../../src/core/trader/orderExecutor/index.js';
import type {
  TraderDeps,
  OrderCacheManagerDeps,
  OrderExecutorDeps,
  OrderExecutor,
  OrderMonitor,
  OrderMonitorDeps,
} from '../../../../src/core/trader/types.js';
import type { OrderPushPort } from '../../../../src/types/orderPushPorts.js';
import { createTrader } from '../../../../src/core/trader/index.js';
import { createOrderCacheManager } from '../../../../src/core/trader/orderCacheManager.js';
import { createOrderAPIManager } from '../../../../src/core/orderRecorder/orderApiManager.js';
import type {
  OrderOps,
  OrderOpsDeps,
  OrderStatusQueryDeps,
  RouteProcessor,
  RouteProcessorDeps,
} from '../../../../src/core/trader/orderMonitor/types.js';

/** 使用同一离线 broker 的中性能力装配原生产 Actor，不向业务消费者发布 DTO/context。 */
export async function createBrokerIngressFixture(
  input: Parameters<typeof createSdkFixture>[0],
): Promise<
  Awaited<ReturnType<typeof createSdkFixture>> &
    Readonly<{
      createCacheManager: (
        deps: Omit<OrderCacheManagerDeps, 'ctx'>,
      ) => ReturnType<typeof createOrderCacheManager>;
      createApiManager: (
        deps: Readonly<{ rateLimiter: Pick<RateLimiter, 'throttle'> }>,
      ) => ReturnType<typeof createOrderAPIManager>;
      createTrader: (deps: Omit<TraderDeps, 'brokerAccess'>) => ReturnType<typeof createTrader>;
      createAccountService: (
        deps: Omit<AccountServiceDeps, 'accountReadPort'>,
      ) => ReturnType<typeof createAccountService>;
      createStateQuery: (
        deps: Omit<OrderStatusQueryDeps, 'orderDetailReadPort' | 'executionLedgerPort'>,
      ) => ReturnType<typeof createOrderStatusQuery>;
      createExecutor: (
        deps: Omit<OrderExecutorDeps, 'tradeMutationPort' | 'readSellPositions'>,
      ) => OrderExecutor;
      createPushPort: () => OrderPushPort;
      createQueryOrdersReader: (orderId?: string) => () => Promise<ReadonlyArray<RawOrderFromAPI>>;
      createRecorder: (
        deps: Omit<OrderRecorderFactoryDeps, 'orderSnapshotReadPort'> &
          Readonly<{ rateLimiter: Pick<RateLimiter, 'throttle'> }>,
      ) => OrderRecorder;
      createMonitor: (
        deps: Omit<
          OrderMonitorDeps,
          'orderDetailReadPort' | 'executionLedgerPort' | 'tradeMutationPort' | 'orderPushPort'
        >,
      ) => OrderMonitor;
      createOperations: (
        deps: Omit<OrderOpsDeps, 'tradeMutationPort' | 'orderStatusQuery'> &
          Pick<OrderStatusQueryDeps, 'getExecutionTimeEvidence'>,
      ) => OrderOps;
      createRoute: (deps: Omit<RouteProcessorDeps, 'tradeMutationPort'>) => RouteProcessor;
    }>
> {
  const facts = await createSdkFixture(input, orderEconomics);
  const { ports } = facts;
  return {
    ...facts,
    createCacheManager: (deps) =>
      createOrderCacheManager({ ...deps, ctx: ports.createPendingOrdersReader() }),
    createApiManager: (deps) =>
      createOrderAPIManager({
        orderSnapshotReadPort: ports.createOrderSnapshotReadPort({
          ...deps,
          executionLedgerPort: facts.executionLedgerPort,
        }),
      }),
    createTrader: (deps) => createTrader({ ...deps, brokerAccess: facts.brokerAccess }),
    createAccountService: (deps) =>
      createAccountService({ ...deps, accountReadPort: ports.createAccountReadPort() }),
    createStateQuery: (deps) =>
      createOrderStatusQuery({
        ...deps,
        orderDetailReadPort: ports.createOrderDetailReadPort(),
        executionLedgerPort: facts.executionLedgerPort,
      }),
    createExecutor: (deps) =>
      createOrderExecutor({
        ...deps,
        tradeMutationPort: ports.createTradeMutationPort(),
        readSellPositions: ports.createSellPositionReader(),
      }),
    createPushPort: ports.createOrderPushPort,
    createQueryOrdersReader: (orderId = facts.queryObservation.orderId) => {
      const detailReader = ports.createOrderDetailReadPort();
      return async () => {
        const detail = await detailReader.read(orderId);
        // 保留已返回事实的预检阶段；坏 DTO 不触发后继 ledger。
        const inspected = detail.decode([]);
        const executions = await facts.executionLedgerPort.todayExecutions({
          orderId: inspected.orderId,
        });
        return [detail.decode(executions)];
      };
    },
    createRecorder: (deps) =>
      createOrderRecorder({
        getExecutionTimeEvidence: deps.getExecutionTimeEvidence,
        settlementRefreshNeedRecorder: deps.settlementRefreshNeedRecorder,
        orderSnapshotReadPort: ports.createOrderSnapshotReadPort({
          rateLimiter: deps.rateLimiter,
          executionLedgerPort: facts.executionLedgerPort,
        }),
      }),
    createMonitor: (deps) =>
      createOrderMonitor({
        ...deps,
        orderDetailReadPort: ports.createOrderDetailReadPort(),
        executionLedgerPort: facts.executionLedgerPort,
        orderPushPort: ports.createOrderPushPort(),
        tradeMutationPort: ports.createTradeMutationPort(),
      }),
    createOperations: (deps) =>
      createOrderOps({
        ...deps,
        tradeMutationPort: ports.createTradeMutationPort(),
        orderStatusQuery: createOrderStatusQuery({
          orderDetailReadPort: ports.createOrderDetailReadPort(),
          executionLedgerPort: facts.executionLedgerPort,
          rateLimiter: deps.rateLimiter,
          getExecutionTimeEvidence: deps.getExecutionTimeEvidence,
        }),
      }),
    createRoute: (deps) =>
      createRouteProcessor({ ...deps, tradeMutationPort: ports.createTradeMutationPort() }),
  };
}
