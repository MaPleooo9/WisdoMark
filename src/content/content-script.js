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
      const text = collectText(pickRoot());

      return {
        ok: true,
        url: location.href,
        title: document.title || '',
        text,
        charCount: text.length
      };
    }
  };
}
