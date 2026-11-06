/*
* 原神角色好感度：当前等级、升到下一级和升满 10 级还差多少经验
*
* 米游社接口和 Enka 都只给好感等级（1~10），游戏里也只显示等级和一根没有数字的进度条，
* 所以本级已经攒了多少经验拿不到：不带进度时给出范围，玩家报了进度条的百分比时给出估算值。
* */
import lodash from 'lodash'
import { Common } from '#miao'
import { MysApi, Player, Character } from '#miao.models'

// 好感每级升级所需经验，下标为当前等级：1 级升 2 级 1000 …… 9 级升 10 级 5650，共 29100
// 来源：米游社《角色好感度增长指南 1到10级所需经验表》（清酒无隐IKUN）
export const FETTER_EXP = [0, 1000, 1550, 2050, 2600, 3175, 3750, 4350, 4975, 5650]
export const MAX_FETTER = 10
export const TOTAL_EXP = lodash.sum(FETTER_EXP)

// 每天大约能拿到的好感经验：每日委托约 320 + 体力 180（1 体力 1 经验），不算尘歌壶和突发事件；
// 委托和体力的经验给队伍里的每个角色
export const DAILY_EXP = 500

// 旅行者、奇偶没有好感度
const NO_FETTER = ['空', '荧', '旅行者', '奇偶·男性', '奇偶·女性']
const hasFetter = ds => ds && !NO_FETTER.includes(ds.name) && !Character.get(ds.id)?.isTraveler

const days = exp => Math.ceil(exp / DAILY_EXP)
const num = n => Number(n).toLocaleString('en-US')

/**
 * 按等级计算还差多少经验
 * @param {number} level 好感等级
 * @param {number} [pct] 本级进度条的百分比（0~100），不知道时不填
 * @returns {{level, max, next, rest, toNext, toMax, minToMax, maxToMax}}
 *   next: 这一级升级共需多少经验；rest: 后面几级加起来；
 *   有进度时 toNext / toMax 为估算值，没有进度时 minToMax ~ maxToMax 为范围
 */
export function fetterInfo (level, pct) {
  level = Math.min(Math.max(Math.floor(Number(level) || 0), 0), MAX_FETTER)
  if (level >= MAX_FETTER) return { level, max: true, next: 0, rest: 0, toNext: 0, toMax: 0, minToMax: 0, maxToMax: 0 }
  // 0 级（没有数据）按 1 级算
  const lv = Math.max(level, 1)
  const next = FETTER_EXP[lv]
  const rest = lodash.sum(FETTER_EXP.slice(lv + 1))
  // 本级进度条快满时，这一级至少还差 1
  const ret = { level, max: false, next, rest, minToMax: rest + 1, maxToMax: rest + next }
  if (pct !== undefined && pct !== null && pct !== '' && !isNaN(pct)) {
    const p = Math.min(Math.max(Number(pct), 0), 100)
    ret.pct = p
    ret.toNext = Math.max(Math.round(next * (100 - p) / 100), 0)
    ret.toMax = ret.toNext + rest
  }
  return ret
}

/** 取角色数据（与 #角色列表 相同），只留有好感度的角色 */
async function getAvatars (e) {
  e.isSr = false
  e.game = 'gs'
  const mys = await MysApi.init(e)
  if (!mys || !mys.uid) return false
  const player = Player.create(e, 'gs')
  const avatars = await player.refreshAndGetAvatarData({
    index: 2,
    detail: 1,
    talent: 0,
    retType: 'array',
    sort: true
  })
  return { uid: mys.uid, player, avatars: (avatars || []).filter(hasFetter) }
}

const Fetter = {
  /** #好感统计：全部角色 */
  async list (e) {
    const ret = await getAvatars(e)
    if (!ret) return false
    const { uid, player, avatars } = ret
    if (!avatars.length) {
      e._isReplyed || e.reply(`查询失败，暂未获得#${uid}角色数据，请绑定CK或 #更新面板`)
      return true
    }

    const maxed = []
    let list = []
    for (const ds of avatars) {
      const info = fetterInfo(ds.fetter)
      const item = {
        ...lodash.pick(ds, ['id', 'name', 'abbr', 'star', 'face', 'elem', 'level', 'cons']),
        fetter: info.level,
        ...info,
        minDays: days(info.minToMax),
        maxDays: days(info.maxToMax),
        // 已经攒到的经验（按本级刚升上来算）：满级进度条用
        donePct: Math.round((TOTAL_EXP - info.maxToMax) / TOTAL_EXP * 100)
      }
      if (info.max) maxed.push(item)
      else list.push(item)
    }
    // 离满级近的排前面；同等级按星级、等级
    list = lodash.orderBy(list, ['fetter', 'star', 'level'], ['desc', 'desc', 'desc'])

    const faceChar = Character.get(player.face) || Character.get(avatars[0]?.id)
    const imgs = faceChar?.imgs || {}
    const face = {
      banner: imgs.banner,
      face: imgs.face,
      qFace: imgs.qFace,
      name: player.name || `#${uid}`,
      level: player.level
    }
    const summary = {
      total: avatars.length,
      maxed: maxed.length,
      left: list.length,
      minExp: num(lodash.sumBy(list, 'minToMax')),
      maxExp: num(lodash.sumBy(list, 'maxToMax'))
    }
    return await Common.render('character/fetter-list', {
      save_id: uid,
      uid,
      face,
      summary,
      list: list.map(i => ({ ...i, next: num(i.next), minToMax: num(i.minToMax), maxToMax: num(i.maxToMax) })),
      maxed,
      fetterExp: FETTER_EXP.slice(1).map((exp, idx) => ({ from: idx + 1, exp: num(exp) })),
      totalExp: num(TOTAL_EXP),
      dailyExp: DAILY_EXP,
      updateTime: player.getUpdateTime(),
      isSelfCookie: e.isSelfCookie
    }, { e, scale: 1.4 })
  },

  /** #胡桃好感 / #胡桃好感 60%：单个角色 */
  async single (e) {
    const m = /^#(?:原神)?(.+?)的?好感度?\s*(?:(\d{1,3}(?:\.\d+)?)\s*[%％]?)?$/.exec(String(e.original_msg || e.msg || '').trim())
    if (!m) return false
    const char = Character.get(m[1].trim())
    if (!char || !char.isGs) return false
    if (char.isTraveler || NO_FETTER.includes(char.name)) {
      e.reply(`${char.name}没有好感度`)
      return true
    }
    const ret = await getAvatars(e)
    if (!ret) return false
    const ds = ret.avatars.find(a => Number(a.id) === Number(char.id))
    if (!ds) {
      e.reply(`UID ${ret.uid} 里没有找到${char.name}：还没有这个角色，或者数据没更新（绑定CK，或把角色放进展柜后 #更新面板）`)
      return true
    }
    const pct = m[2]
    const info = fetterInfo(ds.fetter, pct)
    if (info.max) {
      e.reply(`${char.name} 好感已满 ${MAX_FETTER} 级`)
      return true
    }
    const lv = Math.max(info.level, 1)
    const lines = []
    if (info.pct !== undefined) {
      lines.push(`${char.name} 好感 ${info.level} 级（进度条约 ${info.pct}%）`)
      lines.push(`升到 ${lv + 1} 级：这一级共 ${num(info.next)} 经验，还差约 ${num(info.toNext)}`)
      if (lv + 1 < MAX_FETTER) lines.push(`升满 ${MAX_FETTER} 级：还差约 ${num(info.toMax)}，约 ${days(info.toMax)} 天`)
      else lines.push(`约 ${days(info.toNext)} 天升满`)
    } else {
      lines.push(`${char.name} 好感 ${info.level} 级`)
      lines.push(`升到 ${lv + 1} 级：这一级共需 ${num(info.next)} 经验（本级进度拿不到，还差 1~${num(info.next)}）`)
      lines.push(`升满 ${MAX_FETTER} 级：还差约 ${num(info.minToMax)}~${num(info.maxToMax)}，约 ${days(info.minToMax)}~${days(info.maxToMax)} 天`)
      lines.push(`看一眼游戏里的进度条，发送 #${char.abbr || char.name}好感 60% 可以算得更准`)
    }
    lines.push(`（天数按每天委托 + 体力约 ${DAILY_EXP} 经验估算，角色要在队伍里；放尘歌壶、做突发事件、联机会更快）`)
    e.reply(lines.join('\n'))
    return true
  }
}

export default Fetter
