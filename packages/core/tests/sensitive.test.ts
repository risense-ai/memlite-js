import { describe, expect, it } from 'vitest'
import { scan } from '../src/sensitive'

describe('clean_text_passes', () => {
  it('正常交易研判与点位不误伤', () => {
    expect(scan('金秤回测：趋势回踩 H1 做多，止损 4155，单笔风险 1%')).toEqual([])
    expect(scan('2026-10-06 研判结论：均值回归做多，点位 4183.50')).toEqual([])
  })
})

describe('password_hits', () => {
  it('赋值式口令命中，占位符不命中', () => {
    expect(scan('db_password=secret123')).toContain('明文口令')
    expect(scan('密码：hunter2ok')).toContain('明文口令')
    expect(scan('password=none')).not.toContain('明文口令')
  })
})

describe('id_card_hits', () => {
  it('18 位身份证命中（含 X 尾），17 位纯数字不误判', () => {
    expect(scan('身份证号 11010519491231002X')).toContain('身份证号')
    expect(scan('11010519491231002X')).toContain('身份证号')
    expect(scan('20261006123456789')).not.toContain('身份证号')
  })
})

describe('colloquial_password_hits', () => {
  it('口语式口令命中，疑问句不命中', () => {
    expect(scan('我的密码是hunter2secret')).toContain('明文口令')
    expect(scan('admin 的口令是 x9y8z7w6')).toContain('明文口令')
    expect(scan('他问我密码是什么，我没说')).not.toContain('明文口令')
  })
})

describe('phone_hits_with_boundaries', () => {
  it('11 位手机号命中，长数字中段不命中', () => {
    expect(scan('联系我 13812345678 谢谢')).toContain('手机号')
    expect(scan('订单 20261006138123456789012 长数字')).not.toContain('手机号')
  })
})

describe('bank_card_luhn', () => {
  it('Luhn 通过的卡号命中，位数不够不命中', () => {
    expect(scan('卡号 4111111111111111')).toContain('银行卡号') // Visa 测试号
    expect(scan('编号 411111111111111')).not.toContain('银行卡号') // 15 位不够
  })
})

describe('token_prefixes', () => {
  it('sk-/ghp_/PEM 命中，ask- 普通词不误伤', () => {
    expect(scan('api key: sk-abcdefghijklmnop123456')).toContain('API密钥(sk-)')
    expect(scan('ask-你好世界')).not.toContain('API密钥(sk-)')
    expect(scan('ghp_1234567890abcdef1234567890abcdef12')).toContain('GitHub token')
    expect(scan('-----BEGIN RSA PRIVATE KEY-----\nMIIEpA')).toContain('PEM私钥')
  })
})

describe('jwt_hits', () => {
  it('三段 JWT 命中，eyJ 普通词不命中', () => {
    expect(scan('token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc')).toContain('JWT')
    expect(scan('eyJ是一个普通词')).not.toContain('JWT')
  })
})
