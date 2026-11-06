import character from './character.js'
import profile from './profile.js'
import stat from './stat.js'
import wiki from './wiki.js'
import poke from './poke.js'
import help from './help.js'
import admin from './admin.js'
import gacha from './gacha.js'
import alias from './alias.js'
import fetter from './fetter.js'

let apps = { character, poke, profile, stat, wiki, gacha, admin, help, alias }
let rules = {} // v3
for (let key in apps) {
  rules[`${key}`] = apps[key].v3App()
}
// 好感度（fork 新增，单独一行登记，减少和上游冲突）
rules.fetter = fetter.v3App()

export { rules as apps }
