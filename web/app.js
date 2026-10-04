/**
 * 答案之书 · 页面逻辑（vanilla JS，零依赖）
 *
 * 状态很小，集中放在 state 里，所有渲染都从它出发——界面出问题时先看 state 对不对，
 * 不用去 DOM 里反推。
 *
 * 两个刻意的决定：
 *   ① 一次把相关结果全部取回来（最多 60 条），「显示更多」在本地翻页。
 *      换排序方式则重新请求——排序规则只写在后端一份，前端不复刻，免得两边算出不同顺序。
 *   ② 所有外部文本经 esc() 再进 DOM。源文可信不代表这个动作可以省。
 */

'use strict';

const PAGE_SIZE = 12;   // 首屏与每次「显示更多」的条数
const FETCH_LIMIT = 60; // 一次取回的上限，够覆盖绝大多数查询的相关条目数

const $ = (id) => document.getElementById(id);
const els = {
  topbar: $('topbar'),
  form: $('askForm'),
  input: $('q'),
  submit: $('submitBtn'),
  samples: $('samples'),
  safety: $('safety'),
  interp: $('interpretation'),
  toolbar: $('toolbar'),
  countLine: $('countLine'),
  sorts: $('sorts'),
  gradeFilter: $('gradeFilter'),
  expandAll: $('expandAll'),
  loading: $('loading'),
  grid: $('grid'),
  more: $('more'),
  moreBtn: $('moreBtn'),
  empty: $('empty'),
  modal: $('modal'),
  modalPanel: $('modalPanel'),
  modalHead: $('modalHead'),
  modalBody: $('modalBody'),
  theme: $('themeToggle'),
};

/** 页面状态。渲染函数只读它，交互函数只改它 */
const state = {
  question: '',
  sort: 'relevance',
  grade: 'all',
  results: [],       // 后端返回的相关条目（已按 sort 排好）
  visible: PAGE_SIZE,
  meta: null,        // /api/meta 的结果，含标签取值与排序方式
  lastData: null,    // 最近一次接口原始返回，计数行要用里面的候选数
  lastFocus: null,   // 打开弹窗前焦点在哪，关闭后要还回去
};

const SAMPLES = [
  '我是一个45岁女性，需要注意哪些身体健康方面的问题',
  '一个6岁儿童有哪些建议和指南',
  '被公司裁员了能拿多少钱',
  '家里老人总是摔跤怎么办',
  '租房押金不退怎么办',
  '幽门螺杆菌要不要查',
];

const GENDER_TEXT = { female: '女性专属', male: '男性专属', any: '不限性别' };
const RATIO_LEVEL = { 极高: 3, 高: 2, 一般: 1 };

/**
 * HTML 转义。外部文本一律走这里再进 DOM。
 *
 * @param {unknown} v 任意值
 * @returns {string}
 */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 证据等级色点。
 *
 * @param {string} grade A / B / C
 * @returns {string} HTML
 */
function gradeDot(grade) {
  const g = ['A', 'B', 'C'].includes(grade) ? grade : 'C';
  return `<span class="grade grade-${g}" title="证据等级 ${g} 级">${g}</span>`;
}

/**
 * 性价比三段小柱。填满几段就是哪一档，不用读文字。
 *
 * @param {string} ratio 极高 / 高 / 一般
 * @returns {string} HTML
 */
function ratioMeter(ratio) {
  const level = RATIO_LEVEL[ratio] ?? 1;
  return `<span class="ratio" data-level="${level}" title="性价比 ${esc(ratio)}">
    <span class="ratio-bars"><i></i><i></i><i></i></span>
    <span class="ratio-text">${esc(ratio)}</span>
  </span>`;
}

/**
 * 把条目标签摊平成「文字 + 样式类」的列表，按重要程度排序：
 * 年龄段 → 性别 → 领域 → 主题 → 人群。卡片和弹窗都从这里取，保证顺序一致。
 *
 * @param {object} tags 条目标签
 * @returns {{text:string, cls:string}[]}
 */
function flattenTags(tags) {
  return [
    ...(tags.ages ?? []).map((a) => ({ text: a, cls: 'tag-age' })),
    ...(tags.gender && tags.gender !== 'any' ? [{ text: GENDER_TEXT[tags.gender], cls: 'tag-gender' }] : []),
    ...(tags.domains ?? []).map((d) => ({ text: d, cls: 'tag-domain' })),
    ...(tags.topics ?? []).map((t) => ({ text: t, cls: '' })),
    ...(tags.audiences ?? []).map((a) => ({ text: a, cls: '' })),
  ];
}

/**
 * 卡片上的标签：最多显示 4 个，多出来的折成「+N」。
 *
 * @param {object} tags 条目标签
 * @returns {string} HTML
 */
function tagChips(tags) {
  const all = flattenTags(tags);
  const shown = all.slice(0, 4);
  const rest = all.length - shown.length;

  return (
    shown.map((t) => `<span class="tag ${t.cls}">${esc(t.text)}</span>`).join('') +
    (rest > 0 ? `<span class="tag tag-more">+${rest}</span>` : '')
  );
}

/**
 * 弹窗里的标签：全部列出，不做截断——进了弹窗就是想看全的。
 *
 * @param {object} tags 条目标签
 * @returns {string} HTML
 */
function allTagChips(tags) {
  return flattenTags(tags)
    .map((t) => `<span class="tag ${t.cls}">${esc(t.text)}</span>`)
    .join('');
}

/**
 * 画一张结果卡片。
 *
 * 交互设计：整张卡可点（点击开弹窗），但键盘用户靠的是 tabindex + Enter/Space，
 * 所以用 role="button" 而不是在卡片里塞一个按钮——那样会出现「卡片可点、按钮也可点」
 * 两个重复的入口。
 *
 * @param {object} item 单条结果
 * @param {number} index 序号，用于错开入场动画
 * @returns {HTMLElement}
 */
function buildCard(item, index) {
  const el = document.createElement('article');
  el.className = 'card';
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.dataset.id = item.id;
  el.style.setProperty('--d', `${Math.min(index * 45, 400)}ms`);
  el.setAttribute('aria-label', `${item.ref} ${item.title}，查看详情`);

  el.innerHTML = `
    <div class="card-head">
      ${gradeDot(item.grade)}
      <span class="card-ref">${esc(item.ref)}</span>
      ${ratioMeter(item.ratio)}
    </div>
    <h3 class="card-title">${esc(item.title)}</h3>
    ${item.plain ? `<p class="card-plain">${esc(item.plain)}</p>` : ''}
    <div class="card-tags">${tagChips(item.tags ?? {})}</div>
    <div class="card-foot">
      <span class="card-caliber">口径 ${esc(item.cost?.caliber ?? '—')}</span>
      <span class="card-open">详情 →</span>
    </div>
  `;

  el.addEventListener('click', () => openModal(item));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openModal(item);
    }
  });

  return el;
}

/**
 * 按当前筛选与分页状态渲染结果区。
 */
function renderResults() {
  const filtered =
    state.grade === 'all' ? state.results : state.results.filter((r) => r.grade === state.grade);

  const shown = filtered.slice(0, state.visible);
  els.grid.replaceChildren(...shown.map(buildCard));

  // 空态
  if (!filtered.length) {
    els.empty.innerHTML = `
      <div class="empty">
        <span class="empty-mark">?</span>
        <strong>没有对得上的条目</strong>
        换个说法试试，把身份、年龄、具体处境说清楚一点，命中会更准。
      </div>`;
  } else {
    els.empty.innerHTML = '';
  }

  // 「显示更多」按钮
  const left = filtered.length - shown.length;
  if (left > 0) {
    els.more.hidden = false;
    els.moreBtn.textContent = `显示更多（还有 ${left} 条）`;
  } else {
    els.more.hidden = true;
  }

  // 「展开全部」在没有可展开内容时收起来
  els.expandAll.hidden = left <= 0;
}

/**
 * 渲染计数行：把「候选多少、相关多少、正在看多少」讲清楚。
 *
 * @param {object} data 接口返回
 * @param {number} filteredCount 经过等级筛选后的条数
 */
function renderCount(data, filteredCount) {
  const parts = [`从 <b>${data.totalCandidates}</b> 条候选里挑出 <b>${data.totalRelevant}</b> 条相关`];
  if (state.grade !== 'all') parts.push(`其中 ${state.grade} 级 <b>${filteredCount}</b> 条`);
  els.countLine.innerHTML = parts.join(' · ');
}

/**
 * 渲染「系统怎么理解你的问题」。
 *
 * @param {object} query 结构化查询
 */
function renderInterpretation(query) {
  const fields = [
    ['年龄', query.ages?.bands ?? []],
    ['性别', query.gender && query.gender !== 'any' ? [GENDER_TEXT[query.gender]] : []],
    ['领域', query.domains ?? []],
    ['主题', query.topics ?? []],
    ['人群', query.audiences ?? []],
  ].filter(([, v]) => v.length);

  if (!fields.length) {
    els.interp.hidden = true;
    return;
  }

  els.interp.innerHTML =
    `<span class="interp-title">理解为</span>` +
    fields
      .map(
        ([k, v]) =>
          `<span class="interp-field"><dt>${esc(k)}</dt>` +
          v.map((x) => `<dd class="interp-chip">${esc(x)}</dd>`).join('') +
          `</span>`
      )
      .join('');
  els.interp.hidden = false;
}

/** 渲染排序按钮组，取值来自后端 /api/meta，避免两边各写一份 */
function renderSorts() {
  const modes = state.meta?.sortModes ?? [{ key: 'relevance', label: '相关性', hint: '' }];
  els.sorts.replaceChildren(
    ...modes.map((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sort-btn';
      b.textContent = m.label;
      b.title = m.hint ?? '';
      b.setAttribute('aria-pressed', String(m.key === state.sort));
      b.addEventListener('click', () => {
        if (state.sort === m.key) return;
        state.sort = m.key;
        renderSorts();
        if (state.question) ask(state.question, { keepScroll: true });
      });
      return b;
    })
  );
}

/** 渲染等级筛选按钮。这是纯前端筛选——它不改变「哪些条目相关」，只改变看哪些 */
function renderGradeFilter() {
  const grades = [
    ['all', '全部'],
    ['A', 'A 级'],
    ['B', 'B 级'],
    ['C', 'C 级'],
  ];
  els.gradeFilter.replaceChildren(
    ...grades.map(([key, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-btn';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(state.grade === key));
      b.addEventListener('click', () => {
        state.grade = key;
        state.visible = PAGE_SIZE;
        renderGradeFilter();
        renderResults();
        renderCount(state.lastData, currentFilteredCount());
      });
      return b;
    })
  );
}

/** 当前等级筛选后的条数 */
function currentFilteredCount() {
  return state.grade === 'all'
    ? state.results.length
    : state.results.filter((r) => r.grade === state.grade).length;
}

/**
 * 提问并渲染。
 *
 * @param {string} question 用户问题
 * @param {object} [options] { keepScroll: 换排序时不要跳回顶部 }
 */
async function ask(question, options = {}) {
  const q = question.trim();
  if (!q) return;

  state.question = q;
  setLoading(true);

  const url = new URL(location.href);
  url.searchParams.set('q', q);
  url.searchParams.set('sort', state.sort);
  history.replaceState(null, '', url);

  try {
    const res = await fetch(
      `/api/ask?q=${encodeURIComponent(q)}&limit=${FETCH_LIMIT}&sort=${encodeURIComponent(state.sort)}`
    );
    if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
    const data = await res.json();

    state.results = data.results ?? [];
    state.lastData = data;
    state.visible = PAGE_SIZE;

    // 安全提示压在最前面，不能被结果淹没
    if (data.safety) {
      els.safety.innerHTML = `<div class="safety"><span class="safety-icon">!</span><div>${esc(data.safety)}</div></div>`;
    } else {
      els.safety.innerHTML = '';
    }

    renderInterpretation(data.query);
    els.toolbar.hidden = false;
    renderSorts();
    renderGradeFilter();
    renderCount(data, currentFilteredCount());
    renderResults();

    if (!options.keepScroll) {
      // 滚到「理解为」那一条刚好落在吸附顶栏下面。
      // 不能拿工具栏当锚点——工具栏是吸附元素，内容滚过它时会被盖住，
      // 锚在它上面会让「理解为」正好卡在顶栏和工具栏中间露出半截。
      const anchor = els.interp.hidden ? els.toolbar : els.interp;
      const y = anchor.getBoundingClientRect().top + window.scrollY - 100;
      window.scrollTo({ top: Math.max(y, 0), behavior: 'smooth' });
    }
  } catch (err) {
    els.toolbar.hidden = true;
    els.grid.replaceChildren();
    els.more.hidden = true;
    els.empty.innerHTML = `
      <div class="empty">
        <span class="empty-mark">!</span>
        <strong>出错了</strong>
        ${esc(err.message)}<br>确认本地服务还在跑（npm run serve）。
      </div>`;
  } finally {
    setLoading(false);
  }
}

/**
 * 开关加载骨架。
 *
 * @param {boolean} on 是否加载中
 */
function setLoading(on) {
  els.loading.hidden = !on;
  els.submit.disabled = on;
  els.submit.textContent = on ? '查找中' : '查一查';
}

// ============ 详情弹窗 ============

/**
 * 打开某条条目的详情弹窗。
 *
 * 弹窗内容全部来自本地数据，没有任何请求——点开是瞬时的。
 *
 * @param {object} item 结果条目
 */
function openModal(item) {
  const tags = item.tags ?? {};

  const stat = (label, value) =>
    value ? `<div class="m-stat"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>` : '';

  const sources = (item.sources ?? [])
    .map((s) => {
      const text = esc(s.text) || '原始出处';
      return s.url
        ? `<li>${text} <a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.url)}</a></li>`
        : `<li>${text}</li>`;
    })
    .join('');

  // 头部单独渲染：它固定在弹窗顶部，不随正文滚动
  els.modalHead.innerHTML = `
    <div class="m-head">
      ${gradeDot(item.grade)}
      <span class="m-ref">${esc(item.ref)}</span>
      <span class="m-section">${esc(item.sectionTitle)}</span>
      ${ratioMeter(item.ratio)}
    </div>
    <h2 class="m-title" id="modalTitle">${esc(item.title)}</h2>
  `;

  els.modalBody.innerHTML = `
    ${item.plain ? `<div class="m-plain"><span class="m-plain-label">说人话</span>${esc(item.plain)}</div>` : ''}

    <div class="m-stats">
      ${stat('口径', item.cost?.caliber)}
      ${stat('收益量级', item.cost?.gain)}
      ${stat('花钱', item.cost?.money === '0' ? '不花钱' : item.cost?.money)}
      ${stat('时间', item.cost?.time)}
      ${stat('毅力', item.cost?.will === '否' ? '不需要' : item.cost?.will)}
    </div>

    <div class="m-tags">${allTagChips(tags)}</div>

    ${item.costText ? `<div class="m-block"><h3>成本</h3><p>${esc(item.costText)}</p></div>` : ''}
    ${item.gain ? `<div class="m-block"><h3>收益</h3><p>${esc(item.gain)}</p></div>` : ''}
    ${item.note ? `<div class="m-block"><h3>备注</h3><p>${esc(item.note)}</p></div>` : ''}
    ${sources ? `<div class="m-block"><h3>来源</h3><ul class="m-sources">${sources}</ul></div>` : ''}

    <div class="m-why">为什么排在这里：${esc((item.reasons ?? []).join(' · ') || '关键词与标签的常规匹配')}</div>
  `;

  state.lastFocus = document.activeElement;
  els.modal.hidden = false;
  lockScroll(true);
  // 滚动发生在正文容器上，不是面板本身；每次打开都要回到顶部
  els.modalBody.scrollTop = 0;
  els.modalPanel.classList.remove('is-scrolled');
  els.modalPanel.focus();
}

/** 关闭弹窗并把焦点还给打开它的那张卡 */
function closeModal() {
  if (els.modal.hidden) return;
  els.modal.hidden = true;
  lockScroll(false);
  if (state.lastFocus instanceof HTMLElement) state.lastFocus.focus();
}

/**
 * 锁滚动。
 * 直接 overflow:hidden 会让页面因滚动条消失而横向抖动，所以补一段等宽的内边距。
 *
 * @param {boolean} on 是否锁定
 */
function lockScroll(on) {
  if (on) {
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.paddingRight = gap > 0 ? `${gap}px` : '';
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }
}

// ============ 顶栏吸附 ============

/** 滚动到一定距离后把顶栏收成紧凑形态；用 rAF 节流，避免每帧都改 class */
function initStickyBar() {
  let ticking = false;
  const update = () => {
    els.topbar.classList.toggle('is-stuck', window.scrollY > 16);
    ticking = false;
  };
  window.addEventListener(
    'scroll',
    () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    },
    { passive: true }
  );
  update();
}

// ============ 初始化 ============

/** 示例问题按钮 */
function initSamples() {
  for (const s of SAMPLES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sample';
    b.textContent = s;
    b.addEventListener('click', () => {
      els.input.value = s;
      ask(s);
    });
    els.samples.appendChild(b);
  }
}

/** 主题切换：记住选择，首次进来跟随系统的深浅色偏好 */
function initTheme() {
  const saved = localStorage.getItem('answer-book-theme');
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const apply = (theme) => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('answer-book-theme', theme);
  };
  apply(saved ?? (prefersDark ? 'night' : 'day'));
  els.theme.addEventListener('click', () => {
    apply(document.documentElement.dataset.theme === 'night' ? 'day' : 'night');
  });
}

async function init() {
  initTheme();
  initSamples();
  initStickyBar();

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    ask(els.input.value);
  });

  els.moreBtn.addEventListener('click', () => {
    state.visible += PAGE_SIZE;
    renderResults();
  });

  els.expandAll.addEventListener('click', () => {
    state.visible = Number.MAX_SAFE_INTEGER;
    renderResults();
  });

  // 弹窗：点遮罩或关闭按钮关闭
  els.modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal();
  });

  // 正文滚起来之后给固定头部加一道投影，提示「下面还有内容」
  els.modalBody.addEventListener(
    'scroll',
    () => {
      els.modalPanel.classList.toggle('is-scrolled', els.modalBody.scrollTop > 4);
    },
    { passive: true }
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // 先取元信息（排序方式、标签取值），再决定是否直接出结果
  try {
    state.meta = await (await fetch('/api/meta')).json();
    renderSorts();
  } catch {
    /* 元信息拿不到不影响检索，排序按钮会退化成只有「相关性」 */
  }

  // 地址栏带 q 就直接出结果（刷新、分享都能复现同一次查询）
  const params = new URL(location.href).searchParams;
  const q = params.get('q');
  const sort = params.get('sort');
  if (sort && (state.meta?.sortModes ?? []).some((m) => m.key === sort)) state.sort = sort;

  if (q) {
    els.input.value = q;
    await ask(q);
  } else {
    els.input.focus();
  }
}

init();
