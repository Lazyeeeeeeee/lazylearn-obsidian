/**
 * 32 位 FNV-1a，十六进制。
 *
 * 用途只有一个：判断「这一段内容还是不是上次同步的那一份」。不是密码学哈希——
 * 要的是同步、稳定、够短（要写进 frontmatter 给人看），不是抗碰撞。
 */

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}