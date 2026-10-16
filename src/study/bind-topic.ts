/**
 * 绑定落到笔记上的那一层：读 metadataCache，写走 `processFrontMatter`。
 * 形状与校验在 binding.ts，这里只管 Obsidian 的文件交互。
 */

import type { App, TFile } from "obsidian";

import { readBinding, removeBindingFrom, writeBindingInto } from "./binding.ts";
import type { TopicBinding } from "./binding.ts";

export function activeMarkdownFile(app: App): TFile | null {
  const file = app.workspace.getActiveFile();
  if (file === null || file.extension !== "md") return null;
  return file;
}

export function readNoteBinding(app: App, file: TFile): TopicBinding | null {
  return readBinding(app.metadataCache.getFileCache(file)?.frontmatter);
}

/**
 * 写绑定。返回写进去的那一份：`processFrontMatter` 落盘后 metadataCache 是异步刷新的，
 * 写完立刻回读会读到旧值，调用方拿返回值更新自己的状态。
 */
export async function writeNoteBinding(app: App, file: TFile, binding: TopicBinding): Promise<TopicBinding> {
  await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    writeBindingInto(frontmatter, binding);
  });
  return binding;
}

export async function clearNoteBinding(app: App, file: TFile): Promise<void> {
  await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    removeBindingFrom(frontmatter);
  });
}
