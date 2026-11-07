/**
 * 中英混合分词：ASCII 整词小写；CJK 段取单字 + bigram。
 * 与 Rust memlite search.rs tokenize 逐字对齐。
 */

/** CJK 词界仅 U+4E00–U+9FFF（历史口径，勿扩全 CJK）：
 * 全角标点（，。 U+3000/FF00 段）是分隔符不是词——当词切会改变文档长度，
 * BM25 分数随之漂移（对拍发现过 0.7% 差）。 */
export function isCjk(c: string): boolean {
  const code = c.codePointAt(0) ?? 0
  return code >= 0x4e00 && code <= 0x9fff
}

export function tokenize(text: string): string[] {
  const out: string[] = []
  let ascii = ''
  let cjk = ''
  const flushAscii = () => {
    if (ascii !== '') {
      out.push(ascii.toLowerCase())
      ascii = ''
    }
  }
  const flushCjk = () => {
    const chars = [...cjk]
    for (const ch of chars) out.push(ch)
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1])
    cjk = ''
  }
  for (const ch of text) {
    const isAlnum = /[a-zA-Z0-9_]/.test(ch)
    if (isAlnum) {
      flushCjk()
      ascii += ch
    } else if (isCjk(ch)) {
      flushAscii()
      cjk += ch
    } else {
      flushAscii()
      flushCjk()
    }
  }
  flushAscii()
  flushCjk()
  return out
}
