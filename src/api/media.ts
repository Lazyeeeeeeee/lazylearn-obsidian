/**
 * 题干里的媒体引用。
 *
 * 两个方向：把服务端下发的 `/api/media/...` 认出来（只有同源相对路径才认），
 * 以及把文本里的引用换成归档后的本地相对路径。
 */

export interface MediaRef {
  /** 服务端下发的地址，例如 `/api/media/seed/abc.png`。 */
  url: string;
  /** 去掉 `/api/media/` 前缀的对象键，例如 `seed/abc.png`。 */
  objectKey: string;
}

const MEDIA_PREFIX = "/api/media/";

/** URL → 对象键。不是站内媒体地址就返回 null（跨域资源一律不取）。 */
export function mediaRefOf(url: string): MediaRef | null {
  if (!url.startsWith(MEDIA_PREFIX)) return null;
  const objectKey = url.slice(MEDIA_PREFIX.length);
  if (objectKey === "" || objectKey.includes("..")) return null;
  return { url, objectKey };
}

/** 对象键 → 归档后的文件名：只要末段，前面的目录（seed/、chat/<uid>/）不进 vault。 */
export function assetFileName(objectKey: string): string {
  const tail = objectKey.split("/").filter((part) => part !== "").pop() ?? "asset";
  const safe = tail.replace(/[\\:*?"<>|]/g, "_");
  return safe === "" ? "asset" : safe;
}

/**
 * 把文本里的服务端媒体地址换成归档后的本地路径（相对于笔记所在目录）。
 * 只换字节完全相同的地址，不做正则猜测。
 */
export function rewriteMediaRefs(text: string, mapping: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [url, local] of mapping) {
    out = out.split(url).join(local);
  }
  return out;
}

/** 文本里出现的所有站内媒体地址（去重，保持出现顺序）。 */
export function mediaRefsIn(...texts: readonly (string | null | undefined)[]): MediaRef[] {
  const found = new Map<string, MediaRef>();
  for (const text of texts) {
    if (text === null || text === undefined) continue;
    for (const raw of text.match(/\/api\/media\/[^\s)"'>\]]+/g) ?? []) {
      const ref = mediaRefOf(raw);
      if (ref !== null && !found.has(ref.url)) found.set(ref.url, ref);
    }
  }
  return [...found.values()];
}