/**
 * 写前敏感扫描：密码/身份证/手机号/银行卡/token/私钥，默认拒绝入库。
 * 命中即拒（不是脱敏改写）——提示用户改存位置指针（如「密码在 ~/.env」）。
 * 想强制入库暂不提供口子：这是嵌入式明文库，宁严勿松。
 * 规则与 Rust memlite sensitive.rs 对齐（compat.md §七）。
 */

/** 扫描文本，返回命中种类（空表 = 干净） */
export function scan(text: string): string[] {
  const hits: string[] = []
  const t = text

  // PEM 私钥块
  if (t.includes('-----BEGIN') && (t.includes('PRIVATE KEY') || t.includes('RSA PRIVATE'))) {
    hits.push('PEM私钥')
  }
  // JWT（eyJ 开头的三段 base64url）
  if (findJwt(t)) hits.push('JWT')
  // 常见 token 前缀
  const prefixes: Array<[string, string]> = [
    ['sk-', 'API密钥(sk-)'],
    ['ghp_', 'GitHub token'],
    ['gho_', 'GitHub token'],
    ['github_pat_', 'GitHub PAT'],
    ['AKIA', 'AWS密钥'],
    ['xox', 'Slack token'],
  ]
  for (const [pat, name] of prefixes) {
    if (t.includes(pat)) {
      // sk- 后须跟足够长的字母数字，防误伤普通词
      if (pat === 'sk-') {
        const p = t.indexOf('sk-')
        if (p >= 0) {
          const tail = t.slice(p + 3)
          const m = /^[A-Za-z0-9]+/.exec(tail)
          if (m && m[0].length >= 16) hits.push(name)
        }
      } else {
        hits.push(name)
      }
    }
  }
  // key=value / password: xxx 赋值式口令（明文口令）
  if (hasPlaintextPassword(t)) hits.push('明文口令')
  // 身份证 18 位（末位可 X）
  if (findCnId(t)) hits.push('身份证号')
  // 银行卡 16-19 位连续数字（Luhn 校验，防误伤长订单号）
  if (findBankCard(t)) hits.push('银行卡号')
  // CN 手机号 1[3-9]xxxxxxxxx（11 位，带边界）
  if (findCnPhone(t)) hits.push('手机号')
  return [...new Set(hits)]
}

const B64 = /[A-Za-z0-9_-]/

function findJwt(t: string): boolean {
  // eyJ 开头，后接 ≥10 个 base64url 字符，再 '.' 再非空 base64url 段（≥5）
  let i = 0
  while (i + 10 < t.length) {
    if (t.startsWith('eyJ', i)) {
      let j = i + 3
      while (j < t.length && B64.test(t[j])) j++
      const seg1 = j - (i + 3)
      if (seg1 >= 10 && t[j] === '.') {
        let k = j + 1
        while (k < t.length && B64.test(t[k])) k++
        if (k - (j + 1) >= 5) return true
      }
    }
    i++
  }
  return false
}

function hasPlaintextPassword(t: string): boolean {
  // 形如 password=xxx / passwd: xxx / 密码：xxx / 密码是xxx（赋值右侧非空、非纯占位符）
  const lower = t.replace(/[A-Z]/g, (c) => c.toLowerCase())
  const keys = [
    'password=',
    'password：',
    'password:',
    'password is ',
    'passwd=',
    'passwd:',
    'pwd=',
    'pwd:',
    '密码=',
    '密码：',
    '密码:',
    '密码是',
    '密碼是',
    '口令=',
    '口令：',
    '口令:',
    '口令是',
  ]
  for (const key of keys) {
    const asciiKey = /^[ -~]/.test(key)
    const hay = asciiKey ? lower : t
    const p = hay.indexOf(key)
    if (p < 0) continue
    let val = hay.slice(p + key.length).replace(/^\s+/, '')
    val = val.replace(/^["']+/, '')
    const m = /^[^\s"';)]+/.exec(val)
    const word = m ? m[0] : ''
    // 排除占位符、疑问词与显然非密码的
    const placeholder = ['none', 'null', 'true', 'false', '<password>', '${password}', '***', 'xxx']
    const interrogative = ['什么', '啥', '多少', '几位', '忘了', '不告诉你', '不知道', '没设', '没有']
    if (
      Buffer.byteLength(word, 'utf8') >= 4 &&
      !placeholder.includes(word) &&
      !interrogative.some((w) => word.startsWith(w))
    ) {
      return true
    }
  }
  return false
}

/** 简化 Luhn */
function luhnOk(num: string): boolean {
  const digits = [...num].filter((c) => /[0-9]/.test(c)).map(Number)
  if (digits.length < 16) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = digits[digits.length - 1 - i]
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/** 抽 [min,max] 位连续纯数字段（整段超长时按窗滑取） */
function digitRuns(t: string, min: number, max: number): string[] {
  const out: string[] = []
  for (const m of t.matchAll(/\d+/g)) {
    const run = m[0]
    if (run.length >= min) {
      if (run.length > max) {
        for (let s = 0; s + max <= run.length; s++) out.push(run.slice(s, s + max))
      } else {
        out.push(run)
      }
    }
  }
  return out
}

function findBankCard(t: string): string | undefined {
  // 抽连续数字段（≥16），Luhn 通过才认
  for (const seg of digitRuns(t, 16, 19)) {
    if (luhnOk(seg)) return seg
  }
  return undefined
}

/** 18 位身份证：17 数字 + 末位数字或 X；年份段 1900..=2100 弱校验 */
function findCnId(t: string): string | undefined {
  for (const seg of digitRuns(t, 17, 18)) {
    if (seg.length === 17) continue // 还要跟一个 X/x 才完整
    if (seg.length === 18) {
      const year = Number(seg.slice(6, 10))
      if (year >= 1900 && year <= 2100) return seg
    }
  }
  // 17 位数字紧跟 X
  for (const m of t.matchAll(/(?<!\d)(\d{17})[Xx]/g)) {
    const seg = m[1]
    const year = Number(seg.slice(6, 10))
    if (year >= 1900 && year <= 2100) return seg + 'X'
  }
  return undefined
}

/** 11 位手机号：1[3-9]xxxxxxxxx，前后无其他数字（防长数字中段误中） */
function findCnPhone(t: string): string | undefined {
  const m = /(?<!\d)1[3-9]\d{9}(?!\d)/.exec(t)
  return m ? m[0] : undefined
}
