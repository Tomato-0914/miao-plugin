/*
* 原神角色好感度
* 独立的一个模块，只在 apps/index.js 里登记，不改上游已有的功能文件，同步上游时不容易冲突
* */
import Fetter from './fetter/Fetter.js'
import { App } from '#miao'

let app = App.init({
  id: 'fetter',
  name: '好感度'
})

app.reg({
  fetterList: {
    // 带“统计 / 列表 / 汇总 / 进度”，或带“原神 / 喵喵”前缀，避开其他插件的 #好感度（机器人好感度之类）
    rule: /^#(原神|喵喵)?(我的)?(角色)?好感度?(统计|列表|汇总|进度)$|^#(原神|喵喵)(角色)?好感度?$/,
    fn: Fetter.list,
    desc: '【#角色】 #好感统计'
  },
  fetterSingle: {
    // #胡桃好感、#胡桃好感度 60%：名字不是原神角色时不处理，交给其他插件
    rule: /^#(原神)?.{1,12}?的?好感度?\s*(\d{1,3}(\.\d+)?\s*[%％]?)?$/,
    fn: Fetter.single,
    desc: '【#角色】 #胡桃好感 #胡桃好感60%'
  }
})

export default app
