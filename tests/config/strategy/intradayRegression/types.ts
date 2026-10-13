/** 显式对象配置 fixture，保留可注入的非法数值边界。 */
export type ConfigFixture = {
  readonly signals: {
    readonly BUYCALL: string;
    readonly SELLCALL: string;
    readonly BUYPUT: string;
    readonly SELLPUT: string;
  };
  readonly verification: {
    readonly buy: { readonly delaySeconds: number; readonly indicators: ReadonlyArray<string> };
    readonly sell: { readonly delaySeconds: number; readonly indicators: ReadonlyArray<string> };
  };
};
