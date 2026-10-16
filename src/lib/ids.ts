/**
 * 标识生成。Obsidian 桌面端的渲染进程有 webcrypto，但别赌它一定在：
 * 没有就退回时间戳 + 随机串（这些 id 只用来去重，不需要保密性）。
 */

export function newUuid(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}