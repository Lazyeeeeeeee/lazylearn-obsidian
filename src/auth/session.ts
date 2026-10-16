/**
 * 会话 token 的存取。密码只用于换 token，不落盘；token 进 Obsidian 的 SecretStorage
 * （`app.secretStorage`，since 1.11.4 —— manifest 的 minAppVersion 就是钉这个）。
 *
 * 这里只依赖一个两方法的窄接口：smoke 用一个 Map 就能跑，不必假装整个 Obsidian。
 */

export interface SecretStore {
  get(id: string): string | null;
  set(id: string, value: string): void;
}

import { fnv1a } from "../lib/hash.ts";

/**
 * SecretStorage 的 id 只收「小写字母数字 + 短横线」。带上服务地址的哈希：
 * 换服务器就是另一条会话，不会拿 A 站的 token 去请求 B 站。
 */
export function sessionSecretId(baseUrl: string): string {
  return `lazylearn-session-${fnv1a(baseUrl)}`;
}

export function readToken(store: SecretStore, baseUrl: string): string | null {
  if (baseUrl === "") return null;
  const token = store.get(sessionSecretId(baseUrl));
  return token === null || token === "" ? null : token;
}

export function saveToken(store: SecretStore, baseUrl: string, token: string): void {
  if (baseUrl === "") return;
  store.set(sessionSecretId(baseUrl), token);
}

/** SecretStorage 目前没有删除 API（只有 set/get/list），所以用空串表示已登出。 */
export function clearToken(store: SecretStore, baseUrl: string): void {
  if (baseUrl === "") return;
  store.set(sessionSecretId(baseUrl), "");
}
