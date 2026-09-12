// WisdoMark · 内容脚本（运行时按需注入）
//
// 触发方式：由 service worker 通过 chrome.scripting.executeScript({ files }) 注入。
// 注入权限来自 manifest 的 host_permissions（*://*/*）—— 不用 activeTab：
// 它是「一次性 + 仅当前标签页」的授权，侧栏常驻 UI 反复调用会失败，
// 且覆盖不到「收藏夹里的链接」这类非当前页目标。
//
// 职责边界：只读 DOM，不发任何网络请求，不修改页面。
// 抓取的正文通过返回值交回 service worker，后续才会送给本地 Ollama。

// 幂等：重复点击「抓取正文」会重复注入同一个文件，避免重复定义
if (!window.__wisdomark) {
  // 噪声标签：这些子树整体丢弃，不参与正文拼接
  const NOISE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS', 'FORM',
    'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'BUTTON', 'SELECT', 'TEXTAREA',
    'DIALOG', 'TEMPLATE'
  ]);

  // 块级标签：在文本流里补换行，避免整页文字粘成一段
  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET', 'FIGCAPTION',
    'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'LI', 'MAIN', 'OL',
    'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL'
  ]);

  // 正文容器候选：按语义化程度从高到低找，找不到就退回 body
  const ROOT_SELECTORS = [
    'article', 'main', '[role="main"]',
    '#article-content', '.article-content', '.post-content',
    '.entry-content', '.markdown-body', '.rich_media_content'
  ];

  // ---------------------------------------------------------------------------
  // 正文图片（给 OCR 用）
  //
  // 图文帖（B 站 opus、小红书笔记、公众号长图）的干货全在图里，文字只有开场白。
  // 只靠文字抓取，模型看到的就是「大家好，今天我要讲七个阶段」这种没有信息量的空壳。
  // 这里把正文区的大图挑出来，交给侧栏做离线 OCR。
  //
  // 只挑不认：这里不做任何图像处理，也不发请求，图片 URL 直接交回 service worker。
  // ---------------------------------------------------------------------------

  const MIN_IMG_EDGE = 200; // 短边小于它的多半是头像 / 图标 / 分割线
  // 上限 30 是安全阀，防止有人贴几百张图的页面。
  // 原先是 8，实测那篇 B 站动态有 16 张正文图，只认前 8 张直接丢掉后半篇 ——
  // 第 9～16 张全是正文（每张 400~540 字，合计 3714 字），摘要因此只讲到 Stage 2。
  // 16 张全程只要 13 秒且侧栏有进度，等得起；同张数下「漏内容」的代价远大于「多等几秒」。
  const MAX_IMAGES = 30;
  // URL 或 class/id 里出现这些词，基本可以判定是站点的装饰性图片
  const DECORATIVE = /(logo|avatar|icon|banner|sprite|qrcode|emoji|face)/i;
  const NOISE_ANCESTORS = 'header, nav, aside, footer';

  // 取图片的真实地址。懒加载的图 src 可能是占位符，所以还要翻 data-* 和 srcset。
  function imageUrl(img) {
    const candidates = [
      img.currentSrc,
      img.src,
      img.getAttribute('data-src'),
      img.getAttribute('data-original'),
      img.getAttribute('data-lazy-src'),
      img.getAttribute('data-echo')
    ];

    for (const value of candidates) {
      if (value && !/^data:/i.test(value)) return new URL(value, location.href).href;
    }

    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    const first = srcset?.split(',')[0]?.trim().split(/\s+/)[0];
    if (first && !/^data:/i.test(first)) return new URL(first, location.href).href;

    return '';
  }

  function isDecorative(img, url) {
    if (!url || DECORATIVE.test(url)) return true;
    if (img.closest(NOISE_ANCESTORS)) return true;

    // 往上三层看 class / id：用 getAttribute 而不是 className —— SVG 元素的
    // className 是对象不是字符串，直接拼接会得到 [object SVGAnimatedString]
    let node = img;
    for (let depth = 0; depth < 3 && node; depth += 1) {
      const marker = `${node.getAttribute?.('class') || ''} ${node.getAttribute?.('id') || ''}`;
      if (DECORATIVE.test(marker)) return true;
      node = node.parentElement;
    }

    return false;
  }

  function collectImages(root) {
    const out = [];
    const seen = new Set();

    for (const img of root.querySelectorAll('img')) {
      // 懒加载的图没渲染时 naturalWidth 是 0，但外层通常用 CSS 占好了位置，
      // 所以优先信 getBoundingClientRect
      const rect = img.getBoundingClientRect();
      const width = Math.round(rect.width) || img.naturalWidth || 0;
      const height = Math.round(rect.height) || img.naturalHeight || 0;

      if (width < MIN_IMG_EDGE || height < MIN_IMG_EDGE) continue;
      // 又宽又扁的是横幅，不是正文图（正文长图的比例不会超过 1:5）
      if (width / height > 5) continue;

      const url = imageUrl(img);
      if (isDecorative(img, url) || seen.has(url)) continue;

      seen.add(url);
      out.push({ url, width, height, alt: (img.alt || '').slice(0, 80) });
    }

    return out;
  }

  // 用 TreeWalker 收集文本节点。
  // 不用 cloneNode + innerText：节点脱离文档后 innerText 会退化成 textContent，
  // 换行信息全部丢失，拼出来的正文是一整团。
  function collectText(root) {
    const parts = [];

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // FILTER_REJECT = 连同整棵子树一起跳过
            if (NOISE_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
            if (BLOCK_TAGS.has(node.tagName)) parts.push('\n');
            return NodeFilter.FILTER_SKIP;
          }

          return node.nodeValue && node.nodeValue.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      }
    );

    while (walker.nextNode()) {
      parts.push(walker.currentNode.nodeValue);
    }

    return parts
      .join('')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 挑一个最像正文的容器：语义化容器里文本最长的那个，够长就直接用
  function pickRoot() {
    const MIN_ROOT_LEN = 500;
    let best = null;

    for (const selector of ROOT_SELECTORS) {
      for (const el of document.querySelectorAll(selector)) {
        const len = (el.textContent || '').length;
        if (!best || len > best.len) best = { el, len };
      }
      // 已经找到像样的语义容器，不用继续往更弱的候选上找
      if (best && best.len >= MIN_ROOT_LEN) break;
    }

    return best && best.len >= MIN_ROOT_LEN ? best.el : document.body;
  }

  window.__wisdomark = {
    extract() {
      const root = pickRoot();
      const text = collectText(root);

      // 只把前 MAX_IMAGES 张交出去（一张约 1.5 秒，不封顶会让人等到怀疑卡死），
      // 但真正的总数要一起报上去 —— 摘要漏掉后半篇时，用户得知道是这里截的。
      const all = collectImages(root);

      return {
        ok: true,
        url: location.href,
        title: document.title || '',
        text,
        charCount: text.length,
        images: all.slice(0, MAX_IMAGES),
        imageTotal: all.length
      };
    }
  };
}
