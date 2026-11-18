import crypto from 'node:crypto'
import Plugin from '../../components/common/Plugin.js'
import { Cfg } from '#miao'
import { accountCookie, cookiePart, getMysAccounts, getNoteUser } from '../../components/common/MysAuth.js'
import { GAMES, MESSAGES, SEEN_TTL, STOP_CODES, TERMINAL, COMMAND_REG, parseCommand, getAutoCodes, getCodes, getRoles, redeemCode } from './RedeemApi.js'

const SUBS = 'miao:redeem:subs'
const SEEN = 'miao:redeem:seen'
const PREFIX = { gs: '#', sr: '*', zzz: '%' }
const enabled = () => Cfg.get('redeem', true)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const inflight = new Set()
let polling = false

async function unlock (key, value) {
  await redis.eval('if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end', { keys: [key], arguments: [value] })
}

export default class Redeem extends Plugin {
  constructor () {
    super({
      name: '喵喵:兑换码',
      dsc: '原神/星铁/绝区零国服兑换码',
      event: 'message',
      priority: -100,
      rule: [{ reg: COMMAND_REG, fnc: 'handle' }]
    })
    this.task = { name: '喵喵:自动兑换码', cron: '17 */10 * * * *', fnc: () => this.runAll(), log: false }
  }

  subKey (e, game) {
    return JSON.stringify([String(e.self_id || e.bot?.uin || ''), String(e.user_id), game])
  }

  async handle () {
    let e = this.e
    let cmd = parseCommand(e.msg)
    if (!cmd) return false
    let name = GAMES[cmd.game].name
    let reply = msg => e.reply(msg, true)
    let key = this.subKey(e, cmd.game)
    try {
      if (cmd.action === 'off') {
        await redis.hDel(SUBS, key)
        await reply(`已关闭${name}自动兑换码`)
        return true
      }
      if (cmd.action === 'status') {
        let on = !!await redis.hGet(SUBS, key)
        await reply(`${name}自动兑换码：${on ? '已开启' : '未开启'}${enabled() ? '' : '（功能已被管理员关闭）'}`)
        return true
      }
      if (!enabled()) return false
      if (cmd.action === 'usage') {
        let p = PREFIX[cmd.game]
        await reply(`${p}使用兑换码：兑换近期收录的码\n${p}使用兑换码 兑换码：使用指定码，多个用空格分隔，最多20个\n${p}自动兑换码开启 / ${p}自动兑换码关闭 / ${p}自动兑换码状态`)
        return true
      }
      let user = await getNoteUser(e, e.user_id)
      let accounts = getMysAccounts(user, cmd.game)
      if (!accounts.length) {
        await reply(`请先【#扫码登录】绑定${name}账号`)
        return true
      }
      if (cmd.action === 'on') {
        let sub = { qq: String(e.user_id), bot: String(e.self_id || e.bot?.uin || ''), group: e.isGroup ? String(e.group_id) : '', game: cmd.game }
        await redis.hSet(SUBS, key, JSON.stringify(sub))
        await reply(`已开启${name}自动兑换码，仅兑换官方前瞻直播码，每10分钟检查一次，结果发送到${sub.group ? '本群' : '私聊'}`)
        return true
      }
      if (inflight.has(key)) {
        await reply('兑换进行中，请稍后再试')
        return true
      }
      inflight.add(key)
      try {
        let codes = cmd.codes || (await getCodes(cmd.game)).map(x => x.code)
        if (!codes.length) {
          await reply('暂无近期收录的兑换码')
          return true
        }
        await reply(`开始兑换${name}兑换码，请稍候...`)
        let results = await this.exchange({ qq: e.user_id, game: cmd.game, accounts, codes })
        await this.report(reply, cmd.game, results)
      } finally {
        inflight.delete(key)
      }
    } catch (err) {
      logger.error(`[兑换码] 指令处理失败：${err.message}`)
      await reply('兑换码操作失败，请稍后再试')
    }
    return true
  }

  async loadCredentials (qq, game, account) {
    let ck = await accountCookie(qq, account)
    let owner = cookiePart(ck, 'account_id_v2') || cookiePart(ck, 'account_id') || cookiePart(ck, 'ltuid_v2') || cookiePart(ck, 'ltuid')
    if (!/cookie_token(?:_v2)?=/.test(ck) || (owner && owner !== account.ltuid)) return { ck: '', retcode: -1071, roles: [] }
    return { ck, ...await getRoles(game, ck) }
  }

  async exchange ({ qq, game, accounts, codes, subscription = null }) {
    let results = []
    let roleCache = new Map()
    let subChanged = async () => subscription && await redis.hGet(SUBS, subscription.key) !== subscription.raw
    for (let account of accounts) {
      let { uid, ltuid } = account
      let lockKey = `${SEEN}:lock:${game}:${uid}`
      let token = crypto.randomBytes(16).toString('hex')
      if (!await redis.set(lockKey, token, { NX: true, EX: 900 })) {
        if (!subscription) results.push(`${uid}：兑换进行中，请稍后再试`)
        continue
      }
      try {
        let pending = []
        for (let code of codes) {
          let stateKey = `${SEEN}:${game}:${uid}:${code}`
          let raw = await redis.get(stateKey)
          let state = raw ? JSON.parse(raw) : {}
          if (!subscription || (!state.done && (state.attempts || 0) < 3)) pending.push({ code, stateKey, state })
        }
        if (!pending.length) continue
        if (!roleCache.has(ltuid)) roleCache.set(ltuid, await this.loadCredentials(qq, game, account))
        let credentials = roleCache.get(ltuid)
        let role = credentials.roles.find(r => String(r.game_uid) === uid)
        if (credentials.retcode !== 0 || !role) {
          results.push(`${uid}：${MESSAGES[credentials.retcode] || '请【#扫码登录】重新绑定账号'}`)
          for (let p of pending) await redis.set(p.stateKey, JSON.stringify({ attempts: (p.state.attempts || 0) + 1 }), { EX: SEEN_TTL })
          continue
        }
        for (let { code, stateKey, state } of pending) {
          if (!enabled() || await subChanged()) break
          let nextKey = `${SEEN}:next:${game}:${uid}`
          let wait = Math.min(6500, Math.max(0, Number(await redis.get(nextKey) || 0) - Date.now()))
          if (wait) await sleep(wait)
          if (await redis.get(lockKey) !== token || !enabled() || await subChanged()) break
          let result
          try {
            result = await redeemCode(game, role, credentials.ck, code)
          } catch (err) {
            logger.warn(`[兑换码] ${game}/${uid}/${code} 请求失败：${err.message}`)
            result = { retcode: null, msg: '兑换失败，请稍后再试' }
          }
          await redis.set(nextKey, String(Date.now() + 6500), { EX: 30 })
          await redis.set(stateKey, JSON.stringify({ done: TERMINAL.has(result.retcode), attempts: (state.attempts || 0) + 1, retcode: result.retcode }), { EX: SEEN_TTL })
          results.push(`${uid} · ${code}：${result.msg}`)
          if (STOP_CODES.includes(result.retcode)) break
        }
      } catch (err) {
        logger.error(`[兑换码] ${game}/${uid} 处理失败：${err.message}`)
        results.push(`${uid}：兑换失败，请稍后再试`)
      } finally {
        await unlock(lockKey, token)
      }
    }
    return results
  }

  async report (send, game, lines) {
    for (let i = 0; i < lines.length; i += 12) {
      await send(`${GAMES[game].name}兑换结果：\n${lines.slice(i, i + 12).join('\n')}`)
    }
  }

  async runAll () {
    if (polling || !enabled()) return
    polling = true
    try {
      let subs = await redis.hGetAll(SUBS)
      for (let [key, raw] of Object.entries(subs)) {
        if (!enabled()) break
        if (inflight.has(key)) continue
        inflight.add(key)
        try {
          let sub = JSON.parse(raw)
          if (!GAMES[sub.game] || !sub.qq) continue
          let codes = (await getAutoCodes(sub.game)).map(x => x.code)
          if (!codes.length) continue
          let bot = Bot?.[sub.bot] || (String(Bot?.uin || '') === sub.bot ? Bot : null)
          let target = sub.group ? bot?.pickGroup?.(sub.group) : bot?.pickFriend?.(sub.qq)
          if (!target?.sendMsg) continue
          let user = await getNoteUser({ user_id: sub.qq, self_id: sub.bot, bot }, sub.qq)
          let accounts = getMysAccounts(user, sub.game)
          if (!accounts.length) continue
          let results = await this.exchange({ qq: sub.qq, game: sub.game, accounts, codes, subscription: { key, raw } })
          if (results.length && await redis.hGet(SUBS, key) === raw) {
            await this.report(msg => target.sendMsg(`自动兑换码 · ${sub.qq}\n${msg}`), sub.game, results)
          }
        } catch (err) {
          logger.error(`[兑换码] 自动兑换失败：${err.message}`)
        } finally {
          inflight.delete(key)
        }
      }
    } catch (err) {
      logger.error(`[兑换码] 读取订阅失败：${err.message}`)
    } finally {
      polling = false
    }
  }
}
