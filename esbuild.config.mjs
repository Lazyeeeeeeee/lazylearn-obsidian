import esbuild from "esbuild";

const banner = `/*
LazyLearn Obsidian plugin.
main.js 是 esbuild 的产物，别看它、也别手改：改 src/ 然后 npm run build。
*/`;

// Obsidian 运行时已经把这两个模块放在全局，打进包里会和宿主的两份实现打架。
const external = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
];

const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  outfile: "main.js",
  banner: { js: banner },
  sourcemap: watch ? "inline" : false,
  treeShaking: true,
  minify: !watch,
  logLevel: "info",
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
});

if (watch) {
  await context.watch();
  console.log("esbuild 正在监听 src/，改完自动重打包到 main.js");
} else {
  await context.rebuild();
  await context.dispose();
}
