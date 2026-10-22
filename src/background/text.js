// WisdoMark · 正文形态判断（纯函数，不依赖 chrome API）
//
// 只做一件事：判断一段正文像不像「完整文章」，而不是「图文帖的开场白」。
//
// 为什么需要它：OCR 一张都没认出时，不能无条件判「没抓到正文」——
// 小黑盒那篇《吃烫的就流鼻涕》正文 924 字、排版完整，只是 5 张配图里没有可用文字，
// 整篇就被判死了。但反过来也不能无条件放行：1118 字的口语开场白
// （「大家好，今天我要讲七个阶段」）也会产出空洞摘要。
//
// 只看长度不够，所以叠三个机械特征：
//   - 够长（≥600 字）
//   - 分段够多（≥4 段；正文通常一行一段）
//   - 句末标点够多（≥3 个）
//
// 实测依据（2026-10-22）：小黑盒那篇 924 字 / 12 段 / 句末标点密集 → true；
// 口语开场白通常一段到底、句子少 → false。

export function looksLikeCompleteArticle(text) {
  const s = String(text || '');
  if (s.length < 600) return false;

  const paragraphs = s.split(/\n+/).filter((p) => p.trim().length >= 20).length;
  const sentences = (s.match(/[。！？!?]/g) || []).length;

  return paragraphs >= 4 && sentences >= 3;
}
