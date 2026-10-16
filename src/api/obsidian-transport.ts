import { requestUrl } from "obsidian";

import type { HttpRequest, HttpResponse, HttpTransport } from "./transport.ts";

/**
 * 唯一的真实传输实现。`requestUrl` 走 Obsidian 主进程，没有 CORS 限制——
 * 但代价是**它不提供流式读取**：助教 SSE 不能架在这上面（见实施方案里后置项）。
 */
export const obsidianTransport: HttpTransport = {
  async send(request: HttpRequest): Promise<HttpResponse> {
    // throw: false：4xx/5xx 要自己看状态码分诊，别让 requestUrl 抛成一个没有状态码的错。
    const response = await requestUrl({
      url: request.url,
      method: request.method,
      headers: request.headers,
      ...(request.body === null ? {} : { body: request.body }),
      throw: false,
    });
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      headers[key.toLowerCase()] = value;
    }
    return { status: response.status, text: response.text, bytes: response.arrayBuffer, headers };
  },
};
