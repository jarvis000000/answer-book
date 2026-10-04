/**
 * 检索质量评测集。
 *
 * 用法：npm run eval  （或 node test/eval.mjs）
 *
 * 每个用例写「问什么」和「哪几条是对的」。判定方式是看 right 里的标题片段
 * 有没有出现在前 N 条结果里，所以片段要能在真实条目标题里找到。
 *
 * 指标：
 *   hit@1  第一条就是对的
 *   hit@3  前三条里有对的（这是实际使用最在意的口径——用户通常只看前三条）
 *   hit@5  前五条里有对的
 *   MRR    第一条正确结果排名的倒数的平均，越接近 1 越好
 *
 * 调整权重、词表、阈值之后跑一遍，数字掉了就回退，别凭手感改。
 */

import { loadLocalEngine } from '../src/node/load-local.mjs';

/** 评测用例：q 是问题，right 是正确答案的标题片段（命中任意一个即算对） */
const CASES = [
  // —— 主人给的两个样例 ——
  { q: '我是一个45岁女性，我需要注意哪些身体健康方面的问题', right: ['乳腺癌筛查', '宫颈癌筛查'] },
  { q: '一个6岁儿童有哪些建议和指南', right: ['窝沟封闭', '儿童近水', '恒磨牙'] },

  // —— 按年龄段问 ——
  { q: '家里老人总是摔跤怎么办', right: ['练平衡', '跌倒'] },
  { q: '新生儿黄疸什么时候要去医院', right: ['黄疸'] },
  { q: '65岁以上要不要查骨密度', right: ['骨密度'] },
  { q: '孩子上小学了要注意什么', right: ['户外待够', '学生体检', '校园欺凌', '欺凌'] },

  // —— 健康与急救 ——
  { q: '幽门螺杆菌要不要查', right: ['幽门螺杆菌'] },
  { q: '体检报告说血压高，我要做什么', right: ['量血压'] },
  { q: '我想戒烟有什么办法', right: ['戒烟'] },
  { q: '被狗咬了要不要打疫苗', right: ['狂犬', '破伤风', '咬伤'] },
  { q: '有人倒地没呼吸了怎么办', right: ['心肺复苏', '心脏骤停', '120'] },
  { q: '喝多了酒第二天能不能开车', right: ['酒', '开车'] },

  // —— 钱与法律 ——
  { q: '被公司裁员了我能拿多少钱', right: ['被裁先算清', '辞退你没提前'] },
  { q: '加班费怎么算', right: ['加班费'] },
  { q: '租房押金不退怎么办', right: ['押金'] },
  { q: '网上被骗了钱怎么追回来', right: ['止付', '被骗'] },
  { q: '公司不给签劳动合同怎么办', right: ['劳动合同', '二倍'] },
  { q: '交通事故对方全责怎么赔', right: ['交通事故', '责任认定'] },
  { q: '彩礼能不能要回来', right: ['彩礼'] },

  // —— 生活与安全 ——
  { q: '电动车能不能推进楼道充电', right: ['不推进楼道'] },
  { q: '骑摩托车要不要戴头盔', right: ['头盔'] },
  { q: '家里要不要装烟雾报警器', right: ['烟雾报警器'] },
  { q: '野生蘑菇能不能采', right: ['野生蘑菇'] },
  { q: '厨房炒菜要不要开抽油烟机', right: ['抽油烟机'] },

  // —— 育儿与家庭 ——
  { q: '孩子被同学欺负了怎么办', right: ['欺凌'] },
  { q: '怀孕了要补什么', right: ['叶酸'] },
  { q: '刚出生的宝宝怎么睡才安全', right: ['仰着睡', '安全睡眠'] },
  { q: '孩子发烧能吃阿司匹林吗', right: ['阿司匹林'] },
  { q: '孩子近视了怎么办', right: ['户外待够', '近视'] },

  // —— 工作与技能 ——
  { q: '工伤怎么认定', right: ['工伤'] },
  { q: '被裁了能不能领失业金', right: ['失业保险'] },
  { q: '怎么查职业资格证是不是山寨的', right: ['职业资格', '山寨证书', '目录'] },
];

/**
 * 跑一遍评测。
 *
 * @param {object} [options] { topN, verbose }
 * @returns {{hit1:number, hit3:number, hit5:number, mrr:number, details:object[]}}
 */
export function runEval(options = {}) {
  const topN = options.topN ?? 10;
  const book = loadLocalEngine();
  const details = [];

  let hit1 = 0;
  let hit3 = 0;
  let hit5 = 0;
  let rrSum = 0;

  for (const c of CASES) {
    const r = book.ask(c.q, { limit: topN });
    const titles = r.results.map((x) => x.entry.title);

    let rank = -1;
    for (let i = 0; i < titles.length; i++) {
      if (c.right.some((frag) => titles[i].includes(frag))) {
        rank = i + 1;
        break;
      }
    }

    if (rank === 1) hit1++;
    if (rank > 0 && rank <= 3) hit3++;
    if (rank > 0 && rank <= 5) hit5++;
    if (rank > 0) rrSum += 1 / rank;

    details.push({ q: c.q, rank, expected: c.right, top3: titles.slice(0, 3) });
  }

  const n = CASES.length;
  return { hit1: hit1 / n, hit3: hit3 / n, hit5: hit5 / n, mrr: rrSum / n, total: n, details };
}

// 直接运行时打印报告
if (import.meta.filename === process.argv[1]) {
  const res = runEval();
  const pct = (x) => `${(x * 100).toFixed(1)}%`;

  console.log(`评测集：${res.total} 条用例`);
  console.log(`hit@1 ${pct(res.hit1)}   hit@3 ${pct(res.hit3)}   hit@5 ${pct(res.hit5)}   MRR ${res.mrr.toFixed(3)}`);

  const missed = res.details.filter((d) => d.rank === 0 || d.rank > 3);
  if (missed.length) {
    console.log('\n排在前三之外的用例：');
    for (const d of missed) {
      console.log(`  [${d.rank === 0 ? '未命中' : '第 ' + d.rank + ' 条'}] ${d.q}`);
      console.log(`        期望含：${d.expected.join(' / ')}`);
      console.log(`        实际前三：${d.top3.map((t) => t.slice(0, 22)).join(' | ')}`);
    }
  }

  // 评测不达标时给出非零退出码，方便将来挂进 CI
  if (res.hit3 < 0.75) process.exitCode = 1;
}
