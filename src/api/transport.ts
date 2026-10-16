/**
 * HTTP 传输层的窄接口。放在这里（而不是直接用 `requestUrl`）是为了让 client.ts
 * 保持纯净：smoke 脚本用夹具跑它，不必在 Node 里假装一个 Obsidian。
 */

export type HttpMethod = "GET" | "POST" | "PUT";

export interface HttpRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body: string | null;
}

export interface HttpResponse {
  status: number;
  text: string;
  /** 原始字节。媒体（题干图）走它——`text` 那条路上二进制会被解码坏掉。 */
  bytes: ArrayBuffer;
  /** 响应头名一律小写，免得调用点各自猜大小写。 */
  headers: Record<string, string>;
}

export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>;
}
