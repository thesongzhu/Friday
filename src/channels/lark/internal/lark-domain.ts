/**
 * Lark/Feishu open-platform base domains.
 *
 * Vendor-adapted from `@larksuiteoapi/node-sdk` (MIT, lines 192–278 of `es/index.js`)
 * so Friday can keep the same domain semantics without taking the SDK as a
 * runtime dependency. We only model the two domains Friday's channel uses
 * (Feishu = 中国 open.feishu.cn; Lark = international open.larksuite.com).
 */

export enum LarkDomain {
  Feishu = 0,
  Lark = 1,
}

export function formatLarkDomain(domain: LarkDomain | string): string {
  switch (domain) {
    case LarkDomain.Feishu:
      return "https://open.feishu.cn";
    case LarkDomain.Lark:
      return "https://open.larksuite.com";
    default:
      return typeof domain === "string" ? domain : "https://open.feishu.cn";
  }
}
