import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import YAML from 'yaml'
import md5 from 'md5'
import fetch from 'node-fetch'

const STOKEN_DIRS = [
  'data/Login-Plugin',
  'plugins/xiaoyao-cvs-plugin/data/yaml',
  'data/Mihoyo-Login',
  'plugins/Mihoyo-Login-Plugin/data/yaml',
  'plugins/xhh/data/Stoken',
  'plugins/xhh-TL/data/Stoken'
]
const EXCHANGE_URL = 'https://passport-api.mihoyo.com/account/ma-cn-session/app/exchange'
const EXCHANGE_SALT = 'JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS'
const EXCHANGE_APP_VERSION = '2.106.2'
const EXCHANGE_SDK_VERSION = '2.44.0'
const EXCHANGE_DEVICE_ID = crypto.randomUUID().replace(/-/g, '').toUpperCase()
const APP_UA = 'Mozilla/5.0 (Linux; Android 13; Mi 10 Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/74.0.3729.186 Mobile Safari/537.36 miHoYoBBS/2.71.1'

export function cookiePart (ck = '', key) {
  let m = String(ck).match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`))
  return m ? m[1] : ''
}

export function loadStokenYaml (qq) {
  let ret = {}
  for (let dir of STOKEN_DIRS) {
    let file = path.join(process.cwd(), dir, `${qq}.yaml`)
    if (!fs.existsSync(file)) continue
    let data
    try {
      data = YAML.parse(fs.readFileSync(file, 'utf8')) || {}
    } catch (err) {
      continue
    }
    for (let [uid, entry] of Object.entries(data)) {
      if (entry && (entry.stoken || entry.ck_stoken) && !ret[uid]) ret[uid] = entry
    }
  }
  return ret
}

function parseEntry (entry = {}) {
  let raw = entry.ck_stoken || ''
  return {
    stuid: String(entry.stuid || cookiePart(raw, 'stuid') || cookiePart(raw, 'ltuid') || ''),
    stoken: entry.stoken || cookiePart(raw, 'stoken'),
    mid: entry.mid || cookiePart(raw, 'mid')
  }
}

function appDs (query = '') {
  let t = Math.floor(Date.now() / 1000)
  let r = Math.random().toString(36).slice(2, 8)
  return `${t},${r},${md5(`salt=rtvTthKxEyreVXQCnhluFgLXPOFKPHlA&t=${t}&r=${r}&b=&q=${query}`)}`
}

async function getJson (url, headers) {
  let ctrl = new AbortController()
  let timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    let res = await fetch(url, { headers, signal: ctrl.signal })
    return await res.json().catch(() => null)
  } catch (err) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function exchangeCookieToken ({ stuid, stoken, mid }) {
  let body = JSON.stringify({ dst_token_type: 4, src_token: { token: stoken, token_type: 1 }, mid })
  let t = Math.floor(Date.now() / 1000)
  let r = Math.random().toString(36).slice(2, 8)
  let ctrl = new AbortController()
  let timer = setTimeout(() => ctrl.abort(), 15000)
  let json
  try {
    let res = await fetch(EXCHANGE_URL, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        DS: `${t},${r},${md5(`salt=${EXCHANGE_SALT}&t=${t}&r=${r}&b=${body}&q=`)}`,
        'User-Agent': `Mozilla/5.0 (Linux; Android 12; Unspecified Device) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/103.0.5060.129 Mobile Safari/537.36 miHoYoBBS/${EXCHANGE_APP_VERSION}`,
        'x-rpc-app_version': EXCHANGE_APP_VERSION,
        'x-rpc-client_type': '2',
        'x-rpc-app_id': 'bll8iq97cem8',
        'x-rpc-device_id': EXCHANGE_DEVICE_ID,
        'x-rpc-device_name': 'Mihoyo Capture',
        'x-rpc-device_model': 'Mi 14',
        'x-rpc-game_biz': 'bbs_cn',
        'x-rpc-sdk_version': EXCHANGE_SDK_VERSION,
        'x-rpc-account_version': EXCHANGE_SDK_VERSION
      },
      signal: ctrl.signal
    })
    json = await res.json().catch(() => null)
  } catch (err) {
    logger.warn(`[米游社凭证] stoken 换票请求异常：${err.name}`)
    return ''
  } finally {
    clearTimeout(timer)
  }
  let token = json?.data?.token
  let owner = String(json?.data?.user_info?.aid || '')
  if (json?.retcode !== 0 || token?.token_type !== 4 || !/^v2_/.test(token?.token || '')) {
    logger.warn(`[米游社凭证] stoken 换票失败：${json?.message || '无响应'}（${json?.retcode}）`)
    return ''
  }
  if (owner && owner !== String(stuid)) {
    logger.warn(`[米游社凭证] stoken 换票结果与通行证 ${stuid} 不符`)
    return ''
  }
  return token.token
}

async function cookieTokenBySToken ({ stuid, stoken, mid }) {
  let ck = `stuid=${stuid};stoken=${stoken}${mid ? `;mid=${mid}` : ''}`
  let json = await getJson('https://passport-api.mihoyo.com/account/auth/api/getCookieAccountInfoBySToken', {
    'x-rpc-app_id': 'bll8iq97cem8',
    'User-Agent': 'okhttp/4.9.3',
    Cookie: ck
  })
  if (json?.data?.cookie_token) return json.data.cookie_token
  let query = `stoken=${encodeURIComponent(stoken)}&uid=${encodeURIComponent(stuid)}${mid ? `&mid=${encodeURIComponent(mid)}` : ''}`
  json = await getJson(`https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken?${query}`, {
    Cookie: ck,
    'User-Agent': APP_UA,
    'x-rpc-app_version': '2.71.1',
    'x-rpc-client_type': '2',
    'x-rpc-sys_version': '13',
    'x-rpc-channel': 'miyousheluodi',
    'x-rpc-device_id': crypto.randomUUID(),
    DS: appDs(query)
  })
  return json?.data?.cookie_token || ''
}

export async function stokenToCookie (entry) {
  if (!entry) return ''
  for (let key of ['ck', 'cookie']) {
    if (/cookie_token=/.test(entry[key] || '')) return entry[key]
  }
  let cred = parseEntry(entry)
  if (!cred.stuid || !cred.stoken) return ''
  if (/^v2_/.test(cred.stoken) && cred.mid) {
    let token = await exchangeCookieToken(cred)
    return token ? `account_id_v2=${cred.stuid};account_mid_v2=${cred.mid};cookie_token_v2=${token}` : ''
  }
  let token = await cookieTokenBySToken(cred)
  return token ? `account_id=${cred.stuid};ltuid=${cred.stuid};cookie_token=${token}` : ''
}

export function stokenEntries (qq) {
  let ret = []
  for (let [uid, entry] of Object.entries(loadStokenYaml(qq))) {
    let cred = parseEntry(entry)
    if (!cred.stuid || !cred.stoken) continue
    ret.push({ uid: String(uid), ...cred, entry })
  }
  return ret
}

export async function getNoteUser (e, qq = e?.user_id) {
  let NoteUser = e?.runtime?.NoteUser
  if (!NoteUser) {
    try {
      let { default: Runtime } = await import('../../../../lib/plugins/runtime.js')
      NoteUser = new Runtime(e || {}).NoteUser
    } catch (err) {
      NoteUser = null
    }
  }
  if (NoteUser?.create) {
    try {
      let user = await NoteUser.create(qq)
      if (user) return user
    } catch (err) {}
  }
  if (e?.user?.getUidList && String(e.user.qq || e.user_id) === String(qq)) return e.user
  return null
}

export function getMysAccounts (user, game) {
  let mysUsers = user?.mysUsers || {}
  let accounts = new Map()
  let add = (uid, ltuid) => {
    if (!uid || !ltuid) return
    uid = String(uid)
    ltuid = String(ltuid)
    let mys = mysUsers[ltuid]
    if (!/^\d+$/.test(uid) || !mys) return
    let owned = (mys.uids?.[game] || []).map(String)
    if (owned.length && !owned.includes(uid)) return
    if (accounts.has(uid) && accounts.get(uid).ltuid !== ltuid) return
    accounts.set(uid, { uid, ltuid, ck: mys.ck || '' })
  }
  for (let item of [...(user?.getCkUidList?.(game) || []), ...(user?.getUidList?.(game) || [])]) {
    if (item && typeof item === 'object') add(item.uid, item.ltuid || item.stuid)
  }
  for (let [ltuid, mys] of Object.entries(mysUsers)) {
    for (let uid of mys?.uids?.[game] || []) add(uid, ltuid)
  }
  return [...accounts.values()]
}

export async function accountCookie (qq, account) {
  let ck = account.ck || ''
  let owner = cookiePart(ck, 'account_id_v2') || cookiePart(ck, 'account_id') || cookiePart(ck, 'ltuid_v2') || cookiePart(ck, 'ltuid')
  if (/cookie_token(?:_v2)?=/.test(ck) && (!owner || owner === account.ltuid)) return ck
  let entry = stokenEntries(qq).find(s => s.stuid === account.ltuid)
  return entry ? await stokenToCookie(entry.entry) : ''
}

export default { cookiePart, loadStokenYaml, stokenEntries, stokenToCookie, getNoteUser, getMysAccounts, accountCookie }
