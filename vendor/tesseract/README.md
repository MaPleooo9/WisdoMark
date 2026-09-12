# vendor/tesseract · 离线中文 OCR 引擎

这里是 [tesseract.js](https://github.com/naptha/tesseract.js) 的浏览器构建产物，**原样拷贝**进来，
不在运行时联网下载 —— 本项目的承诺是「全本地，零云端」，不能为了识别图里的文字去连 CDN。

## 文件来源

| 文件 | 出处 | 说明 |
|---|---|---|
| `tesseract.esm.min.js` | `tesseract.js@7.0.0/dist/` | 主入口（ES module，侧栏 `import` 它） |
| `worker.min.js` | `tesseract.js@7.0.0/dist/` | 识别跑在独立 worker 里，不占侧栏主线程 |
| `core/tesseract-core-simd-lstm.wasm.js` | `tesseract.js-core@7.0.0/` | WASM 核心，**已内嵌 wasm（SINGLE_FILE）**，不需要另外的 `.wasm` 文件 |
| `lang/chi_sim.traineddata.gz` | [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) | 简体中文语言包（fast 版，1.7 MB） |

许可：tesseract.js 与 tesseract.js-core 为 **Apache-2.0**，`tessdata_fast` 语言包为 **Apache-2.0**。

## 三个必须照抄的配置（少一个就跑不起来）

```js
Tesseract.createWorker('chi_sim', 1, {
  workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
  workerBlobURL: false,                                                    // ← 关键
  corePath: chrome.runtime.getURL('vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js'),
  langPath: chrome.runtime.getURL('vendor/tesseract/lang')
});
```

| 配置 | 不这么写会怎样 |
|---|---|
| `workerBlobURL: false` | tesseract.js 默认用 `new Worker(URL.createObjectURL(blob))` 起 worker，MV3 的 `script-src 'self'` **不允许 blob: worker**，直接报 `Failed to execute 'importScripts'`，且错误信息指向 workerPath，极易误判成文件路径写错（实测踩过） |
| `corePath` 指向具体 `.js` 文件 | 指向目录时 worker 会按自身能力拼 `relaxedsimd-lstm` / `simd-lstm` 等四个候选名，只放一个文件必然 404 |
| `manifest.json` 加 `'wasm-unsafe-eval'` | MV3 默认 CSP 禁止 `WebAssembly.compile`，worker 一起就挂 |

## 为什么不放 `.wasm` 文件

`tesseract-core-*-lstm.wasm.js` 是 emscripten 的 SINGLE_FILE 构建 —— wasm 以 base64 内嵌在 JS 里
（3.9 MB ≈ 2.86 MB × 1.37 正是这个比例）。实测把配套的 `.wasm` 删掉后识别结果完全不变。
留着它只是多 2.9 MB。
