// ===================== 英语伴学引擎（代码 / 关卡 / 题库 分离） =====================
// 目录结构：
//   index.html        页面骨架（样式）
//   app.js            引擎（本文件：课本选择 / 关卡地图 / 答题 / 判分 / 语音 / 听写，不含任何具体题目）
//   data/books.json   课本清单：添加新课本时在这里登记一行 {"id":"5B","file":"data/5B.json"}
//   data/5A.json      五年级上课时题库（一份课本一个文件）
//                        units 数组每项：{name,title,icon,color,en}
//                        name/title/icon/color=中文名/图标/主题色；en=单元英文标题（可选，有则显示并可🔊朗读）
//
// 添加新课本（如五年级下册）步骤：
//   1. 复制 data/5A.json 为 data/5B.json，修改里面的题目内容（格式完全一样）
//   2. 在 data/books.json 里加一行 {"id":"5B","file":"data/5B.json"}
//   3. 刷新页面即可，本文件不用改

let BOOK = null;      // 当前课本数据 {id,title,subtitle,units,questions}
let books = [];       // 课本清单（books.json）
let bookData = {};    // 各课本完整数据缓存 {id: {...}}

// ===================== 状态管理 =====================
let state = {
  completed: {}, // {1: {stars:3, score:14, total:15}, ...}
  currentUnit: 1,
  currentQ: 0,
  score: 0,
  selected: -1,
  answered: false,
  autoSpeak: true,   // 进入新题时是否自动朗读英文
  lastSpoken: null,  // 已自动朗读过的题目标识，避免重复朗读
  answeredCorrect: false, // 当前题是否答对（听写题结果展示用）
  drawn: []              // 本次闯关从单元题库中随机抽取的题目
};

// ===================== 语音朗读（Web Speech API，浏览器内置，无需联网） =====================
let enVoice = null;
let enVoices = [];   // 全部英文音色池（跟读时按角色分配）
let _voiceTimer = null;

function initVoices() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  if (!vs.length) return; // iOS 首次为空，等 onvoiceschanged 或轮询
  enVoices = vs.filter(v => /^en([-_]|$)/i.test(v.lang));
  // 优先选美音，其次任意英文音色
  enVoice = enVoices.find(v => /^en[-_]US/i.test(v.lang)) || enVoices[0] || null;
}

// iOS 兼容：音色列表异步加载，首次可能为空，轮询直到拿到
function ensureVoices() {
  if (!('speechSynthesis' in window)) return;
  initVoices();
  if (enVoice) return;
  let tries = 0;
  const iv = setInterval(() => {
    initVoices();
    if (enVoice || ++tries > 20) clearInterval(iv);
  }, 200);
}

// 从题目/选项的中英混排文本中提取英文部分（允许数字：9 p.m. / 7:10 a.m. 等由 TTS 读成 nine / seven ten）
function extractEn(text) {
  const m = text.match(/[A-Za-z][A-Za-z0-9\s.,!?'’;:()_-]*/g);
  if (!m) return '';
  return m.map(s => s.replace(/_+/g, ' blank ')   // 连续填空下划线读作一次 "blank"
                     .replace(/[.,!?;:()\s]+$/, '').trim())
          .filter(Boolean).join('. ');
}

function makeUtterance(en, voice, rate) {
  const u = new SpeechSynthesisUtterance(en);
  u.lang = 'en-US';
  if (voice) u.voice = voice;
  else if (enVoice) u.voice = enVoice;
  u.rate = rate || 0.85;  // 稍慢，适合孩子听
  return u;
}

// 朗读一段文本中的英文（传原始文本即可，内部自动提取英文；onend：朗读结束回调；voice/rate：指定音色）
function speakText(raw, onend, voice, rate) {
  const text = raw ? decodeURIComponent(raw) : '';
  if (!('speechSynthesis' in window)) { alert('当前浏览器不支持语音朗读，请使用 Safari 或 Chrome 打开。'); return; }
  const en = extractEn(text);
  if (!en) { if (onend) onend(); return; } // 无英文可读：立即回调，不拖到 4.5 秒兜底
  ensureVoices();
  speechSynthesis.cancel();
  if (!enVoice) { setTimeout(() => speakText(raw, onend, voice, rate), 300); return; } // iOS 音色未就绪，稍后重试
  const u = makeUtterance(en, voice, rate);
  if (onend) { u.onend = onend; u.onerror = onend; }
  speechSynthesis.speak(u);
  startKeepAlive();
}

// 依次朗读多段文本（题目 + 各选项）
function speakSequence(texts) {
  if (!('speechSynthesis' in window)) return;
  const ens = texts.map(extractEn).filter(Boolean);
  if (!ens.length) return;
  ensureVoices();
  speechSynthesis.cancel();
  // iOS 上音色可能还没就绪，等一小会儿再读
  if (!enVoice) { setTimeout(() => speakSequence(texts), 300); return; }
  ens.forEach(en => speechSynthesis.speak(makeUtterance(en)));
  startKeepAlive();
}

// iOS Safari 有个 bug：长朗读约15秒后会自动停止。
// 用一个低频 resume 定时器"续命"，只在有朗读在进行时开启。
function startKeepAlive() {
  stopKeepAlive();
  _voiceTimer = setInterval(() => {
    if ('speechSynthesis' in window && speechSynthesis.speaking) {
      speechSynthesis.pause();
      speechSynthesis.resume();
    }
  }, 8000);
}

function stopKeepAlive() {
  if (_voiceTimer) { clearInterval(_voiceTimer); _voiceTimer = null; }
}

function stopSpeech() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  stopKeepAlive();
}

// 完形填空（题干含 ___）判断
function isCloze(q) {
  return /_{2,}/.test(q.q);
}

// 听写判分归一化：忽略大小写和多余空格
function normalizeWord(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// 答完题后播放"正确答案"的语音：
// 听写=单词本身；完形填空=补全后的整句；单词"中译英"题=正确选项（英文单词）；
// 语音题正确选项是音标（如 /w/）时改读题干中的例词；其余=正确选项（纯中文时回退题干英文）
function speakCorrectAnswer(q, onend) {
  let raw;
  if (q.type === '听写') raw = q.word;
  else if (isCloze(q)) raw = fillCloze(q);
  else {
    const opt = String(q.options[q.answer] || '');
    if (q.type === '单词' && /[A-Za-z]/.test(opt)) raw = opt;                                  // 中译英：读正确的英文词
    else if (q.type === '语音') raw = opt.replace(/[^A-Za-z]/g, '').length >= 2 ? opt : q.q;   // 辨音题读例词，辨词题读正确单词
    else if (/[A-Za-z]/.test(opt)) raw = opt;                                                  // 一般题：读正确选项
    else raw = q.q;                                                                            // 正确选项纯中文：回退读题干英文
  }
  speakText(encodeURIComponent(raw), onend);
}

// 完形填空补全：正确答案按空位依次填入，得到完整句子（供朗读整句）
// 多空题答案以 ';' 或 ',' 分隔各空（如 "Is, drawing"）；分隔数与空位数不符时整体填入第一空兜底
function fillCloze(q) {
  const blanks = (q.q.match(/_{2,}/g) || []).length;
  const ans = String(q.options[q.answer] || '');
  let parts = ans.split(/\s*;\s*/);
  if (parts.length === 1) parts = ans.split(/\s*,\s*/);
  if (blanks > 1 && parts.length === blanks) {
    let i = 0;
    return q.q.replace(/_{2,}/g, () => parts[i++]);
  }
  return q.q.replace(/_{2,}/, ans);
}

// 自动朗读开关
function toggleAutoSpeak() {
  state.autoSpeak = !state.autoSpeak;
  if (!state.autoSpeak) {
    stopSpeech();
  } else {
    // 刚打开开关：立即朗读当前题（完形填空不自动播放；选项不自动朗读，答后只读正确选项）
    const q = state.drawn[state.currentQ];
    state.lastSpoken = state.currentUnit + '-' + state.currentQ;
    if (q.type === '听写') speakText(encodeURIComponent(q.word));
    else if (!isCloze(q)) speakSequence([q.q]);
  }
  renderQuiz();
}

// 给题目和选项上的 🔊 按钮绑定点击事件（stopPropagation：点喇叭不触发选择）
function bindSpeakButtons() {
  document.querySelectorAll('[data-speak]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      speakText(el.getAttribute('data-speak'));
    });
  });
}

// 通关线：答对 70% 及以上
function passLine(total) {
  return Math.ceil(total * 0.7);
}

// ===================== 随机抽题 =====================
const DRAW_COUNT = 15;   // 每次闯关从单元题库中随机抽取的题数（题库已覆盖该单元全部知识点）

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 从单元题库中随机抽 DRAW_COUNT 题（题库不足时全取）
function drawQuestions(unitNum) {
  const bank = BOOK.questions[unitNum] || [];
  return shuffle(bank).slice(0, Math.min(DRAW_COUNT, bank.length));
}

// HTML 转义（防止课本数据中的特殊字符破坏页面）
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ===================== 进度存储（按课本分开保存） =====================
function progressKey() {
  return 'english_quiz_progress_' + (BOOK ? BOOK.id : '');
}

// 从localStorage读取进度
function loadProgress() {
  state.completed = {};
  try {
    const saved = localStorage.getItem(progressKey());
    if (saved) {
      const data = JSON.parse(saved);
      if (data.completed) state.completed = data.completed;
    }
  } catch(e) {}
}

// 保存进度
function saveProgress() {
  try {
    localStorage.setItem(progressKey(), JSON.stringify({
      completed: state.completed
    }));
  } catch(e) {}
}

// 读取某课本已保存的进度（不进游戏也能显示用）
function readCompleted(bookId) {
  try {
    const saved = localStorage.getItem('english_quiz_progress_' + bookId);
    if (saved) {
      const data = JSON.parse(saved);
      if (data.completed) return data.completed;
    }
  } catch(e) {}
  return {};
}

// 更新顶部进度条
function updateProgress() {
  if (!BOOK) return;
  const total = BOOK.units.length;
  const done = Object.keys(state.completed).length;
  const pct = Math.round(done / total * 100);
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressText').textContent = `已完成 ${done} / ${total} 关`;
}

// ===================== 数据加载 =====================
function showLoadError() {
  const c = document.getElementById('content');
  c.innerHTML = '<div class="load-error">⚠️ 题库加载失败。<br>请不要直接双击打开本文件——请运行「启动手机伴学.bat」，用手机扫码或电脑访问显示的网址。</div>';
}

async function boot() {
  try {
    const res = await fetch('data/books.json', { cache: 'no-store' });
    books = await res.json();
    for (const b of books) {
      const r = await fetch(b.file, { cache: 'no-store' });
      bookData[b.id] = await r.json();
    }
  } catch (e) {
    showLoadError();
    return;
  }
  if (!books.length) { showLoadError(); return; }
  // 课本清单排序：按年级升序、上册在前（id 形如 "4A"/"4B"/"5A"；解析失败则保持原顺序）
  const rank = id => {
    const m = /^(\d+)([A-Z])$/i.exec(String(id));
    return m ? Number(m[1]) * 10 + (m[2].toUpperCase() === 'A' ? 0 : 1) : Infinity;
  };
  books.sort((a, b) => rank(a.id) - rank(b.id));
  if (books.length === 1) {
    loadBook(books[0]);
  } else {
    renderBookSelect();
  }
}

// 进入某一本课本
function loadBook(entry) {
  BOOK = bookData[entry.id];
  if (!BOOK || !BOOK.units || !BOOK.questions) { showLoadError(); return; }
  stopSpeech();
  // 重置答题状态
  state.currentUnit = 1;
  state.currentQ = 0;
  state.score = 0;
  state.selected = -1;
  state.answered = false;
  state.answeredCorrect = false;
  state.lastSpoken = null;
  loadProgress();

  // 页头 / 标题 / 底部信息随课本变化
  setHeader('quiz');
  renderMap();
  updateProgress();
}

// 设置页头文案：mode = 'quiz'（闯关）| 'dict'（听写）| 'read'（跟读）
function setHeader(mode) {
  if (!BOOK) return;
  const isDict = mode === 'dict';
  const isRead = mode === 'read';
  const label = isDict ? '英语听写' : isRead ? '课文跟读' : '英语伴学';
  const icon = isDict ? '✏️ ' : isRead ? '🗣️ ' : '🎓 ';
  const head = isDict ? '英语听写' : isRead ? '课文跟读' : '英语伴学';
  document.title = BOOK.title + label;
  document.getElementById('headerTitle').textContent = icon + BOOK.title + head;
  document.getElementById('headerSub').textContent = BOOK.subtitle || '';
  document.getElementById('progressWrap').style.display = (isDict || isRead) ? 'none' : '';
  document.getElementById('progressText').style.display = (isDict || isRead) ? 'none' : '';
  if (isDict) {
    document.getElementById('footerText').textContent =
      `${BOOK.title}英语听写 · 单元 1-${BOOK.units.length} · 每词读三遍，纸笔完成`;
  } else if (isRead) {
    document.getElementById('footerText').textContent =
      `${BOOK.title}课文跟读 · 单元 1-${BOOK.units.length} · 播一句跟读一句`;
  } else {
    const need = passLine(DRAW_COUNT);
    document.getElementById('footerText').textContent =
      `${BOOK.title}英语伴学 · 单元 1-${BOOK.units.length} · 每关 ${DRAW_COUNT} 题，答对 ${need} 题通关`;
  }
}

// ===================== 课本选择界面（多本课本时显示；只有一本时自动进入） =====================
function renderBookSelect() {
  stopSpeech();
  BOOK = null;
  document.title = '英语伴学';
  document.getElementById('headerTitle').textContent = '🎓 英语伴学';
  document.getElementById('headerSub').textContent = '选择要学习的课本';
  document.getElementById('progressWrap').style.display = 'none';
  document.getElementById('progressText').textContent = '';
  document.getElementById('footerText').textContent = '';

  const content = document.getElementById('content');
  let html = '<div class="map-title">📚 选择课本</div><div class="map-sub">点击课本卡片开始学习</div><div class="grid">';
  books.forEach(b => {
    const bd = bookData[b.id] || {};
    const n = (bd.units || []).length;
    const done = Object.keys(readCompleted(b.id)).length;
    html += `
      <div class="card" onclick="loadBookById('${b.id}')">
        <span class="icon">${bd.icon || '📖'}</span>
        <div class="name">${escapeHtml(bd.title || b.id)}</div>
        <div class="status">${n} 个单元 · 已完成 ${done} / ${n} 关</div>
      </div>`;
  });
  html += '</div>';
  content.innerHTML = html;
  setCrumb([{ t: '🏠 选择教材' }]);
}

function loadBookById(id) {
  const entry = books.find(b => b.id === id);
  if (entry) loadBook(entry);
}

// ===================== 主界面：关卡地图 =====================
function renderMap() {
  setHeader('quiz');
  if (dict) { dict.stopped = true; dictToken++; dict = null; } // 回地图即离开听写流程
  stopSpeech();
  const content = document.getElementById('content');
  const units = BOOK.units;
  const need = passLine(DRAW_COUNT);
  const types = [...new Set(Object.values(BOOK.questions).flat().map(q => q.type))];
  let html = '<div class="map-title">🎯 选择关卡开始学习</div>';
  html += `<div class="map-sub">每关 ${DRAW_COUNT} 题：${types.join(' · ')}，答对 ${need} 题通关 · 题库随机抽题，关卡全部开放，可自由挑战</div><div class="grid">`;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const num = i + 1;
    const isCompleted = state.completed[num];

    let cls = 'card';
    let status = '';
    let stars = '';

    if (isCompleted) {
      cls += ' completed';
      const s = isCompleted.stars;
      stars = '<div class="stars">' + '⭐'.repeat(s) + '</div>';
      status = `<div class="status">通过 ✓ ${isCompleted.score}/${isCompleted.total}</div>`;
    } else {
      status = '<div class="status">👉 开始学习</div>';
    }

    html += `
      <div class="${cls}" data-unit="${num}" onclick="openUnit(${num})">
        <span class="icon">${unit.icon}</span>
        <div class="name">${unit.name}<br>${unit.title}</div>
        ${unit.en ? `<div class="unit-en">${unit.en}<span class="speak-btn" data-speak="${encodeURIComponent(unit.en)}" title="朗读单元英文标题">🔊</span></div>` : ''}
        ${stars}${status}
      </div>`;
  }

  html += '</div>';
  html += '<div class="btn-reset-wrap"><button class="btn-reset" onclick="renderDictRecords()">📜 听写记录</button></div>';
  html += '<div class="btn-reset-wrap"><button class="btn-reset" onclick="resetProgress()">🔄 重新开始</button></div>';

  content.innerHTML = html;
  bindSpeakButtons(); // 卡片上的 🔊 按钮（朗读单元英文标题）
  setCrumb([{ t: '🏠 首页', go: 'renderBookSelect()' }, { t: BOOK.title }]);
}

// ===================== 单元模式选择（闯关 / 听写 / 跟读） =====================
function openUnit(unitNum) {
  stopSpeech();
  if (dict) { dict.stopped = true; dictToken++; dict = null; } // 退出听写流程，终止后台播放
  if (rd) { rd = null; }                                        // 退出跟读流程
  setHeader('quiz');
  const unit = BOOK.units[unitNum - 1];
  const vocabCount = (unit.vocab || []).length;
  const readCount = (unit.read || []).length;
  const recCount = readDictRecords().filter(r => r.unit === unitNum).length;
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="quiz-header">
      <div class="quiz-title">${unit.icon} ${unit.name} · ${unit.title}</div>
      <div class="quiz-count"><button class="auto-toggle" onclick="renderMap()">← 返回</button></div>
    </div>
    <div class="mode-grid mode-grid-3">
      <div class="mode-card ${readCount ? '' : 'disabled'}" onclick="${readCount ? `startRead(${unitNum})` : ''}">
        <span class="mode-icon">🗣️</span>
        <div class="mode-name">课文跟读</div>
        <div class="mode-desc">${readCount ? `本单元课文 ${readCount} 句<br>播一句跟读一句<br>支持自动模式` : '本单元暂无课文'}</div>
      </div>
      <div class="mode-card" onclick="startQuiz(${unitNum})">
        <span class="mode-icon">🎯</span>
        <div class="mode-name">闯关练习</div>
        <div class="mode-desc">随机 ${DRAW_COUNT} 题<br>单词 · 句型 · 听写<br>语音 · 交际</div>
      </div>
      <div class="mode-card ${vocabCount ? '' : 'disabled'}" onclick="${vocabCount ? `startDictation(${unitNum})` : ''}">
        <span class="mode-icon">✏️</span>
        <div class="mode-name">单词听写</div>
        <div class="mode-desc">${vocabCount ? `全单元 ${vocabCount} 个词汇<br>纸笔听写<br>每词读三遍` : '本单元暂无词汇表'}</div>
      </div>
    </div>
    ${recCount ? `<div class="mode-foot">本单元已有 ${recCount} 次听写记录 · <a href="javascript:void(0)" onclick="renderDictRecords()">查看记录</a></div>` : ''}
  `;
  setCrumb([
    { t: '🏠 首页', go: 'renderBookSelect()' },
    { t: BOOK.title, go: 'renderMap()' },
    { t: unit.name }
  ]);
}

// ===================== 课文跟读模式（播一句 → 跟读 → 下一句；支持自动播放） =====================
let rd = null;    // 当前跟读会话 {unitNum, list, idx, auto, interval, timer}
let rdToken = 0;  // 跟读会话令牌：递增即作废当前自动链（防跳句后旧定时器抢跑）

// 解析 "Mum: Hello!" 式对话行 → {speaker, text}；无说话人时 speaker=null
function parseSpeaker(en) {
  const m = /^\s*([A-Za-z][A-Za-z .''-]{0,24}?)\s*[:：]\s*(.+)$/.exec(en);
  if (m && /[A-Za-z]/.test(m[2])) return { speaker: m[1].trim(), text: m[2].trim() };
  return { speaker: null, text: en };
}

// —— 说话人性别识别：称呼/头衔/教材人名 → 'm' | 'f' | null ——
const GENDER_NAMES = {
  // 家庭称谓与头衔
  dad: 'm', father: 'm', grandpa: 'm', grandad: 'm', uncle: 'm', brother: 'm', boy: 'm', sir: 'm',
  mum: 'f', mom: 'f', mother: 'f', grandma: 'f', aunt: 'f', sister: 'f', girl: 'f', madam: 'f',
  // 两册教材常见人名
  'li sha': 'f', 'luo jie': 'm', 'fang xiao': 'm', 'zhang qi': 'm', 'zhu li': 'f',
  tingting: 'f', xiaowen: 'f', 'li na': 'f', katie: 'f', jim: 'm', matt: 'm',
  alice: 'f', joe: 'm', david: 'm', susan: 'f', kate: 'f', max: 'm', ella: 'f',
  lisa: 'f', eric: 'm', 'li ming': 'm', 'li liang': 'm', jiajia: 'f', peter: 'm',
  youyou: 'm', huihui: 'm', xiaorong: 'f', xiaoyuan: 'f', 'wu wei': 'm',
  shasha: 'm', jinjin: 'm', libo: 'm', 'li bo': 'm', 'wu yan': 'f', amy: 'f',
  kitty: 'f', sam: 'm', ann: 'f', bill: 'm', ben: 'm', bobby: 'm',
  may: 'f', mary: 'f', helen: 'f', nancy: 'f', simon: 'm', cindy: 'f', millie: 'f'
};
function guessGender(sp) {
  if (!sp) return null;
  const s = String(sp).toLowerCase().replace(/[.·’']/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(mr|mister)\b/.test(s)) return 'm';
  if (/^(mrs|miss|ms|madam|lady)\b/.test(s)) return 'f';
  if (GENDER_NAMES[s]) return GENDER_NAMES[s];
  if (/\b(dad|father|grandpa|uncle|brother)\b/.test(s)) return 'm'; // "Pingping's dad"
  if (/\b(mum|mom|mother|grandma|aunt|sister)\b/.test(s)) return 'f';
  return null;
}

// 英文音色按名称猜性别（Microsoft/Google 音色名可辨识）
const FEMALE_VOICE_RE = /(aria|jenny|sonia|clara|samantha|karen|moira|tessa|veena|zira|susan|linda|catherine|hazel|naomi|colette|denise|eloise|female|woman|girl)/i;
const MALE_VOICE_RE = /(christopher|guy|davis|mark|eric|daniel|alex|fred|oliver|orville|george|paul|ivan|liam|male|man|boy)/i;

// 从音色池为角色分配不同播音员：旁白用默认美音；能辨性别的角色配男/女声，其余轮流
function buildVoicePool() {
  const pool = enVoices.length ? enVoices : (enVoice ? [enVoice] : []);
  rd.voiceMap = {};
  rd._alt = 0;
  rd._pool = pool;
  rd._female = pool.filter(v => FEMALE_VOICE_RE.test(v.name));
  rd._male = pool.filter(v => MALE_VOICE_RE.test(v.name));
  rd._fIdx = 0;
  rd._mIdx = 0;
}

function voiceForSpeaker(sp) {
  if (!rd._pool || !rd._pool.length) return null;
  if (!sp) return enVoice; // 旁白/叙述：默认美音
  if (rd.voiceMap[sp]) return rd.voiceMap[sp];
  const g = guessGender(sp);
  let v = null;
  if (g === 'f' && rd._female.length) v = rd._female[rd._fIdx++ % rd._female.length];
  else if (g === 'm' && rd._male.length) v = rd._male[rd._mIdx++ % rd._male.length];
  if (!v) {
    // 性别未知或该性别无音色：在默认音色之外轮流分配，保证角色间声音不同
    const others = rd._pool.filter(x => x !== enVoice);
    const list = others.length ? others : rd._pool;
    v = list[rd._alt++ % list.length];
  }
  rd.voiceMap[sp] = v;
  return v;
}

function startRead(unitNum) {
  const unit = BOOK.units[unitNum - 1];
  const list = unit.read || [];
  if (!list.length) return;
  stopSpeech();
  setHeader('read');
  rd = { unitNum, list, idx: 0, auto: false, interval: 10000, timer: null };
  rdToken++;
  ensureVoices();
  buildVoicePool();
  renderRead();
  speakReadCurrent(); // 进入第一句自动播放
}

function speakReadCurrent() {
  if (!rd) return;
  if (!rd._pool) buildVoicePool(); // iOS 音色晚就绪时懒初始化
  const { speaker, text } = parseSpeaker(rd.list[rd.idx].en);
  // 人名只用于分配音色，不朗读；对话语速略快更像说话，旁白稍慢清晰
  // 自动模式：本句朗读结束 + 设定间隔 → 自动下一句（token 防跳句后旧定时器抢跑）
  const token = rdToken;
  const onend = rd.auto ? () => {
    if (!rd || !rd.auto || token !== rdToken) return;
    rd.timer = setTimeout(() => {
      if (!rd || !rd.auto || token !== rdToken) return;
      if (rd.idx < rd.list.length - 1) { rd.idx++; renderRead(); speakReadCurrent(); }
      else { setAuto(false); } // 末句读完：自动模式关闭，停在完成按钮
    }, rd.interval);
  } : null;
  speakText(encodeURIComponent(text), onend, voiceForSpeaker(speaker), speaker ? 0.92 : 0.85);
}

function setAuto(on) {
  if (!rd) return;
  rd.auto = on;
  if (on) {
    renderRead();
    speakReadCurrent(); // 立即开始当前句的"朗读→间隔→下一句"链
  } else {
    rdToken++;            // 作废在途定时器链
    clearTimeout(rd.timer);
    stopSpeech();
    renderRead();
  }
}

function pickAutoInterval(btn) {
  if (!rd) return;
  document.querySelectorAll('.auto-seg [data-ms]').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  rd.interval = Number(btn.getAttribute('data-ms'));
}

// 面包屑：固定顶部导航（首页=选教材 → 教材=关卡地图 → 单元=模式选择 → 类别=当前模式）
// trail: [{t:'🏠 首页', go:'renderBookSelect'}, {t:'四年级下册', go:'renderMap'}, {t:'Unit 1', go:"openUnit(1)"}, {t:'🗣️ 跟读', go:null}]
function setCrumb(trail) {
  const el = document.getElementById('crumb');
  if (!el) return;
  if (!trail || !trail.length) { el.className = 'crumb-wrap'; el.innerHTML = ''; return; }
  el.className = 'crumb-wrap show';
  el.innerHTML = trail.map((c, i) => {
    const last = i === trail.length - 1;
    const sep = i > 0 ? '<span class="crumb-sep">›</span>' : '';
    return last
      ? `${sep}<span class="crumb-item cur">${c.t}</span>`
      : `${sep}<span class="crumb-item" onclick="${c.go || 'renderMap()'}">${c.t}</span>`;
  }).join('');
}

// 跳到第 i 句并朗读（手动跳句作废自动链旧定时器，随后按当前自动状态续链）
function gotoRead(i) {
  if (!rd || i < 0 || i >= rd.list.length) return;
  rd.idx = i;
  rdToken++;
  clearTimeout(rd.timer);
  renderRead();
  speakReadCurrent();
}

function renderRead() {
  // 骨架只构建一次；换句仅做增量更新，避免整列表重建导致的闪动
  if (!rd._built) buildReadShell();
  updateReadUI();
}

function buildReadShell() {
  const unit = BOOK.units[rd.unitNum - 1];
  const n = rd.list.length;

  // 整篇字幕：按句渲染，小节（课文/拓展）变化时插入标题+页码行
  let subs = '';
  let lastSt = null;
  rd.list.forEach((s, i) => {
    if (s.st && s.st !== lastSt) {
      lastSt = s.st;
      subs += `<div class="sub-head">${s.st}${s.sp ? ` <span class="sub-page">📖 ${s.sp}</span>` : ''}</div>`;
    }
    const { speaker, text } = parseSpeaker(s.en);
    subs += `
      <div class="sub-row" id="subRow${i}" onclick="gotoRead(${i})">
        <div class="sub-line">${speaker ? `<span class="sub-speaker">${speaker}:</span>` : ''}<span class="sub-en">${text}</span></div>
        <div class="sub-cn">${s.cn}</div>
      </div>`;
  });

  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="quiz-header">
      <div class="quiz-title">🗣️ ${unit.name} · 课文跟读</div>
      <div class="quiz-count">第 <b id="readCur">1</b> / ${n} 句</div>
    </div>
    <div class="read-progress-bar"><div class="read-progress-fill" id="readFill" style="width:${Math.round(1 / n * 100)}%"></div></div>
    <div class="read-subs" id="readSubs">${subs}</div>
    <div class="read-tip" id="readTip">点击任意句子可跳读 · 听一句，大声跟读一句 🗣️</div>
    <div class="read-ctrl-row">
      <button class="btn btn-next read-ctrl" id="readPrevBtn" onclick="gotoRead(Math.max(rd.idx - 1, 0))">⬅ 上一句</button>
      <button class="btn btn-next read-ctrl" onclick="replayRead()">🔊 重听</button>
      <button class="btn btn-primary read-ctrl" id="readNextBtn" onclick="nextRead()">下一句 ➡</button>
    </div>
    <div class="read-auto-row">
      <button class="btn btn-primary read-auto-btn" id="readAutoBtn" onclick="setAuto(!rd.auto)">▶️ 自动模式</button>
      <div class="auto-seg">
        <button data-ms="5000" onclick="pickAutoInterval(this)">5秒</button>
        <button data-ms="10000" class="on" onclick="pickAutoInterval(this)">10秒</button>
        <button data-ms="15000" onclick="pickAutoInterval(this)">15秒</button>
      </div>
    </div>
  `;
  rd._built = true;
  rd._prevRow = null;
  setCrumb([
    { t: '🏠 首页', go: 'renderBookSelect()' },
    { t: BOOK.title, go: 'renderMap()' },
    { t: unit.name, go: `openUnit(${rd.unitNum})` },
    { t: '🗣️ 跟读' }
  ]);
}

function updateReadUI() {
  const n = rd.list.length;
  const pct = Math.round((rd.idx + 1) / n * 100);
  const cur = document.getElementById('readCur');
  const fill = document.getElementById('readFill');
  if (cur) cur.textContent = rd.idx + 1;
  if (fill) fill.style.width = pct + '%';

  // 高亮迁移：只动两行，不重建列表
  if (rd._prevRow) rd._prevRow.classList.remove('cur');
  const row = document.getElementById('subRow' + rd.idx);
  if (row) {
    row.classList.add('cur');
    rd._prevRow = row;
    // 容器内平滑居中（不触发整页滚动）
    const subs = document.getElementById('readSubs');
    if (subs) {
      subs.scrollTo({
        top: row.offsetTop - subs.clientHeight / 2 + row.offsetHeight / 2,
        behavior: 'smooth'
      });
    }
  }

  // 控制按钮状态
  const prevBtn = document.getElementById('readPrevBtn');
  const nextBtn = document.getElementById('readNextBtn');
  const tip = document.getElementById('readTip');
  const autoBtn = document.getElementById('readAutoBtn');
  if (prevBtn) prevBtn.disabled = rd.idx === 0;
  if (nextBtn) nextBtn.textContent = rd.idx === n - 1 ? '✅ 完成' : '下一句 ➡';
  if (tip) tip.textContent = rd.auto ? '⏳ 自动模式：读完本句后休息，进入下一句…' : '点击任意句子可跳读 · 听一句，大声跟读一句 🗣️';
  if (autoBtn) {
    autoBtn.textContent = rd.auto ? '⏸ 暂停自动' : '▶️ 自动模式';
    autoBtn.className = 'btn read-auto-btn ' + (rd.auto ? 'btn-next' : 'btn-primary');
  }
}

function replayRead() {
  if (!rd) return;
  rdToken++;              // 打断在途自动链，重听后重新起链
  clearTimeout(rd.timer);
  speakReadCurrent();
}

function nextRead() {
  if (!rd) return;
  if (rd.idx < rd.list.length - 1) {
    rd.idx++;
    rdToken++;            // 作废旧自动链，按当前自动状态重新起链
    clearTimeout(rd.timer);
    renderRead();
    speakReadCurrent(); // 下一句自动播放
  } else {
    const n = rd.list.length;
    rd = null;
    rdToken++;
    stopSpeech();
    const content = document.getElementById('content');
    content.innerHTML = `
      <div class="result-box">
        <div class="result-icon">🌟</div>
        <div class="result-title">跟读完成！</div>
        <div class="result-score">${n} 句</div>
        <div class="result-msg">课文全部跟读完毕，坚持每天读一遍，语感越来越好！</div>
        <button class="btn btn-primary" onclick="renderMap()">返回关卡地图</button>
      </div>`;
    setHeader('quiz');
    setCrumb([
      { t: '🏠 首页', go: 'renderBookSelect()' },
      { t: BOOK.title, go: 'renderMap()' }
    ]);
  }
}

// ===================== 听写模式（纸笔听写 + 自检勾选 + 记录） =====================
let dict = null;      // 当前听写会话 {unitNum, order, idx, interval, played, stopped, startedAt}
let dictToken = 0;    // 播放序列令牌：递增即打断当前循环（重听/结束用）

function dictRecordsKey() {
  return 'english_quiz_dict_records_' + (BOOK ? BOOK.id : '');
}

function readDictRecords() {
  try {
    const saved = localStorage.getItem(dictRecordsKey());
    const arr = saved ? JSON.parse(saved) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function saveDictRecord(rec) {
  try {
    const arr = readDictRecords();
    arr.unshift(rec);
    if (arr.length > 200) arr.length = 200; // 只留最近200次
    localStorage.setItem(dictRecordsKey(), JSON.stringify(arr));
  } catch (e) {}
}

function startDictation(unitNum) {
  const unit = BOOK.units[unitNum - 1];
  const vocab = unit.vocab || [];
  if (!vocab.length) return;
  stopSpeech();
  setHeader('dict');
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="quiz-header">
      <div class="quiz-title">✏️ ${unit.name} · 单词听写</div>
      <div class="quiz-count"><button class="auto-toggle" onclick="renderMap()">← 退出</button></div>
    </div>
    <div class="question-box">
      <div class="question-text">准备好纸和笔 📝<br>共 ${vocab.length} 个单词/短语，顺序随机，每个播放三遍；全部放完后按播放顺序对照自检。</div>
    </div>
    <div class="dict-setup-label">每遍之间 / 换词前的间隔：</div>
    <div class="interval-row">
      <button class="interval-btn" data-sec="5" onclick="pickInterval(this)">5 秒</button>
      <button class="interval-btn selected" data-sec="10" onclick="pickInterval(this)">10 秒</button>
      <button class="interval-btn" data-sec="15" onclick="pickInterval(this)">15 秒</button>
    </div>
    <button class="btn btn-primary" onclick="beginDictation(${unitNum})">▶️ 开始听写</button>
  `;
  setCrumb([
    { t: '🏠 首页', go: 'renderBookSelect()' },
    { t: BOOK.title, go: 'renderMap()' },
    { t: BOOK.units[unitNum - 1].name, go: `openUnit(${unitNum})` },
    { t: '✏️ 听写' }
  ]);
}

function pickInterval(btn) {
  document.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function beginDictation(unitNum) {
  const unit = BOOK.units[unitNum - 1];
  const secBtn = document.querySelector('.interval-btn.selected');
  const interval = (secBtn ? Number(secBtn.getAttribute('data-sec')) : 10) * 1000;
  dict = {
    unitNum,
    order: shuffle(unit.vocab),
    idx: 0,
    interval,
    played: null,
    stopped: false,
    startedAt: Date.now()
  };
  renderDictStage();
  dictRunWord();
}

function renderDictStage() {
  const unit = BOOK.units[dict.unitNum - 1];
  const content = document.getElementById('content');
  const n = dict.order.length;
  const cur = Math.min(dict.idx + 1, n);
  content.innerHTML = `
    <div class="quiz-header">
      <div class="quiz-title">✏️ ${unit.name} · 听写中</div>
      <div class="quiz-count"><button class="auto-toggle" onclick="stopDictation()">⏹ 结束播放</button></div>
    </div>
    <div class="question-box dict-stage">
      <div class="dict-progress">第 <b id="dictCur">${cur}</b> / ${n} 词</div>
      <div class="dict-tip">仔细听，写纸上 🔉<br><span id="dictRep" class="dict-rep">第 1 遍…</span></div>
      <button class="btn btn-next" id="dictReplayBtn" onclick="replayDictWord()">🔊 重听这个词</button>
      <div class="dict-nav-row">
        <button class="btn btn-next dict-nav" onclick="dictPrevWord()">⬅ 上一个</button>
        <button class="btn btn-next dict-nav" onclick="dictNextWord()">下一个 ➡</button>
      </div>
    </div>
    <div class="dict-note">播放中不显示单词内容；可随时点"结束播放"提前进入自检。</div>
  `;
  setCrumb([
    { t: '🏠 首页', go: 'renderBookSelect()' },
    { t: BOOK.title, go: 'renderMap()' },
    { t: unit.name, go: `openUnit(${dict.unitNum})` },
    { t: '✏️ 听写' }
  ]);
}

// 播放当前词三遍（每遍之间与换词前都是同一间隔）；token 失效即静默退出
function dictRunWord(token) {
  token = token === undefined ? dictToken : token;
  if (!dict || dict.stopped || token !== dictToken) return;
  if (dict.idx >= dict.order.length) { showDictChecklist(false); return; }
  const word = dict.order[dict.idx];
  let rep = 0;
  const step = () => {
    if (!dict || dict.stopped || token !== dictToken) return;
    rep++;
    const repEl = document.getElementById('dictRep');
    if (repEl) repEl.textContent = `第 ${rep} 遍…`;
    const curEl = document.getElementById('dictCur');
    if (curEl) curEl.textContent = String(dict.idx + 1);
    speakText(encodeURIComponent(word.en));
    if (rep < 3) setTimeout(step, dict.interval);
    else setTimeout(() => {                    // 第三遍后的间隔 → 下一词
      if (!dict || dict.stopped || token !== dictToken) return;
      dict.idx++;
      dictRunWord(token);
    }, dict.interval);
  };
  step();
}

function replayDictWord() {
  if (!dict || dict.stopped) return;
  dictToken++;              // 打断当前序列
  const word = dict.order[Math.min(dict.idx, dict.order.length - 1)];
  speakText(encodeURIComponent(word.en)); // 立即重放当前词
  setTimeout(() => dictRunWord(dictToken), dict.interval); // 间隔后从当前词继续三遍流程
}

// 上一个 / 下一个：跳到目标词并重新走"三遍+间隔"流程
function dictJump(delta) {
  if (!dict || dict.stopped) return;
  const target = Math.min(Math.max(dict.idx + delta, 0), dict.order.length - 1);
  if (target === dict.idx && delta > 0) { showDictChecklist(false); return; } // 末词再点"下一个"=提前结束播放
  dict.idx = target;
  dictToken++;
  stopSpeech();
  dictRunWord(dictToken);
}

function dictPrevWord() { dictJump(-1); }
function dictNextWord() { dictJump(1); }

function stopDictation() {
  if (!dict) { renderMap(); return; }
  dict.stopped = true;
  dictToken++;
  stopSpeech();
  // 只把已播放过的词纳入自检清单
  dict.played = dict.order.slice(0, Math.max(dict.idx, 1));
  showDictChecklist(true);
}

function showDictChecklist(partial) {
  stopSpeech();
  dictToken++; // 打断播放序列
  const list = dict.played || dict.order;
  const unit = BOOK.units[dict.unitNum - 1];
  const content = document.getElementById('content');
  let html = `
    <div class="quiz-header">
      <div class="quiz-title">📋 ${unit.name} · 对照自检</div>
      <div class="quiz-count">${partial ? `已播 ${list.length}/${dict.order.length} 词` : `共 ${list.length} 词`}</div>
    </div>
    <div class="question-box">
      <div class="question-text">按刚才的播放顺序核对纸上的听写：写对并勾选 ✅，最后点"完成听写"。</div>
    </div>
    <div class="check-list">`;
  list.forEach((v, i) => {
    html += `
      <div class="check-row">
        <span class="check-no">${i + 1}</span>
        <span class="check-en">${v.en}</span>
        <span class="check-cn">${v.cn}</span>
        <input type="checkbox" class="check-box" data-i="${i}">
      </div>`;
  });
  html += `</div>
    <button class="btn btn-primary" onclick="finishDictation()">✅ 完成听写（${list.length} 词）</button>
    <button class="btn btn-next" onclick="cancelDictation()" style="margin-top:10px">放弃本次听写</button>`;
  content.innerHTML = html;
  setCrumb([
    { t: '🏠 首页', go: 'renderBookSelect()' },
    { t: BOOK.title, go: 'renderMap()' },
    { t: unit.name, go: `openUnit(${dict.unitNum})` },
    { t: '✏️ 听写·自检' }
  ]);
  window.scrollTo(0, 0);
}

function cancelDictation() {
  dict = null;
  renderMap();
}

function finishDictation() {
  const list = dict.played || dict.order;
  const boxes = document.querySelectorAll('.check-box');
  const items = list.map((v, i) => ({
    en: v.en,
    cn: v.cn,
    ok: boxes[i] ? !!boxes[i].checked : false
  }));
  const passed = items.filter(x => x.ok).length;
  const rec = {
    time: new Date().toISOString(),
    unit: dict.unitNum,
    interval: dict.interval / 1000,
    total: items.length,
    passed,
    score: items.length ? Math.round(passed / items.length * 100) : 0,
    items // 逐词掌握数据：后续"按掌握程度调整听写策略"用
  };
  saveDictRecord(rec);
  dict = null;
  const unit = BOOK.units[rec.unit - 1];
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="result-box">
      <div class="result-icon">${rec.score >= 90 ? '🏆' : rec.score >= 70 ? '🎉' : '💪'}</div>
      <div class="result-title">听写完成！</div>
      <div class="result-score">${rec.passed} / ${rec.total}（${rec.score} 分）</div>
      <div class="result-msg">${unit.name} · 间隔 ${rec.interval} 秒 · ${rec.score >= 90 ? '掌握得非常好！' : rec.score >= 70 ? '不错的成绩，错词再练一练！' : '把没勾出的词多听几遍，明天再战！'}</div>
      <button class="btn btn-primary" onclick="renderDictRecords()">📜 查看听写记录</button>
      <button class="btn btn-next" onclick="openUnit(${rec.unit})" style="margin-top:10px">再来一次</button>
    </div>`;
  setCrumb([
    { t: '🏠 首页', go: 'renderBookSelect()' },
    { t: BOOK.title, go: 'renderMap()' },
    { t: unit.name, go: `openUnit(${rec.unit})` },
    { t: '✏️ 听写·成绩' }
  ]);
}

// ===================== 听写记录页 =====================
function renderDictRecords() {
  stopSpeech();
  setHeader('dict');
  const content = document.getElementById('content');
  const recs = readDictRecords();
  let html = `
    <div class="quiz-header">
      <div class="quiz-title">📜 听写记录（${BOOK.title}）</div>
      <div class="quiz-count"><button class="auto-toggle" onclick="renderMap()">← 返回</button></div>
    </div>`;
  if (!recs.length) {
    html += '<div class="question-box"><div class="question-text">还没有听写记录。进入单元 → 单词听写，完成一次即可在此查看历史成绩。</div></div>';
  } else {
    // 汇总：按单元统计
    const byUnit = {};
    recs.forEach(r => {
      byUnit[r.unit] = byUnit[r.unit] || { n: 0, sum: 0, last: r };
      byUnit[r.unit].n++;
      byUnit[r.unit].sum += r.score;
    });
    html += '<div class="rec-summary">';
    Object.keys(byUnit).sort((a, b) => a - b).forEach(u => {
      const s = byUnit[u];
      const unit = BOOK.units[u - 1] || {};
      html += `<div class="rec-unit">${unit.icon || '📖'} ${unit.name}：${s.n} 次 · 平均 ${Math.round(s.sum / s.n)} 分 · 最近 ${s.last.score} 分</div>`;
    });
    html += '</div>';
    html += '<div class="rec-list">';
    recs.slice(0, 50).forEach(r => {
      const unit = BOOK.units[r.unit - 1] || {};
      const d = new Date(r.time);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      html += `<div class="rec-row"><span class="rec-date">${ds}</span><span class="rec-unit-name">${unit.name || ''}</span><span class="rec-score">${r.passed}/${r.total} · ${r.score}分</span><span class="rec-int">间隔${r.interval}s</span></div>`;
    });
    html += '</div>';
    html += '<div class="btn-reset-wrap"><button class="btn-reset" onclick="clearDictRecords()">🗑 清空听写记录</button></div>';
  }
  content.innerHTML = html;
  setCrumb([
    { t: '🏠 首页', go: 'renderBookSelect()' },
    { t: BOOK.title, go: 'renderMap()' },
    { t: '📜 听写记录' }
  ]);
}

function clearDictRecords() {
  if (confirm('确定清空本课本的所有听写记录吗？')) {
    try { localStorage.removeItem(dictRecordsKey()); } catch (e) {}
    renderDictRecords();
  }
}

// ===================== 答题界面 =====================
function startQuiz(unitNum) {
  state.currentUnit = unitNum;
  state.currentQ = 0;
  state.score = 0;
  state.selected = -1;
  state.answered = false;
  state.answeredCorrect = false;
  state.lastSpoken = null;
  state.drawn = drawQuestions(unitNum);  // 每次闯关从大题库随机抽 15 题
  stopSpeech();

  renderQuiz();
}

function renderQuiz() {
  const content = document.getElementById('content');
  const unit = BOOK.units[state.currentUnit - 1];
  const qs = state.drawn;
  const q = qs[state.currentQ];
  const isDict = q.type === '听写';

  // 按钮可用条件：选择题需已选答案且未提交；听写题只要未提交就能点（点时会校验输入）
  const btnDisabled = isDict
    ? (state.answered ? 'disabled' : '')
    : ((state.selected === -1 || state.answered) ? 'disabled' : '');
  const btnText = isDict && !state.answered ? '✏️ 检查答案'
    : (state.currentQ === qs.length - 1 ? '提交答案' : '下一题');

  // 🔊 题目朗读按钮：听写题=听/再听单词；完形填空（含___）不出按钮（避免提前播放）；其余题干含英文时显示
  const qSpeak = isDict
    ? `<span class="speak-btn" data-speak="${encodeURIComponent(q.word)}" title="再听一次">🔊</span>`
    : (!isCloze(q) && /[A-Za-z]/.test(q.q)
      ? `<span class="speak-btn" data-speak="${encodeURIComponent(q.q)}" title="朗读英文">🔊</span>` : '');

  const typeColor = { '单词':'#4caf50', '听写':'#ff9800', '句型':'#4facfe', '课文':'#9c27b0', '语音':'#e91e63', '交际':'#00bcd4', '拓展':'#795548' };

  // 听写题：输入框（答后显示结果）；选择题：选项列表（选项上不再有朗读按钮）
  const body = isDict ? `
    <div class="dict-hint">💡 中文意思：${q.cn}</div>
    ${state.answered
      ? `<div class="dict-result ${state.answeredCorrect ? 'ok' : 'no'}">${state.answeredCorrect ? '✓ 拼写正确！' : '✗ 正确写法：' + q.word + '（' + q.cn + '）'}</div>`
      : `<input class="dict-input" id="dictationInput" type="text" placeholder="拼写听到的英文单词" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">`}
  ` : `
    <div class="options">
      ${q.options.map((opt, i) => `
        <div class="option ${state.selected === i ? 'selected' : ''} ${state.answered && i === q.answer ? 'correct' : ''} ${state.answered && state.selected === i && i !== q.answer ? 'wrong' : ''}"
             onclick="selectOption(${i})">${String.fromCharCode(65 + i)}. ${opt}</div>
      `).join('')}
    </div>`;

  const html = `
    <div class="quiz-header">
      <div class="quiz-title">${unit.icon} ${unit.name} · ${unit.title}${unit.en ? `<div class="quiz-unit-en">${unit.en}</div>` : ''}</div>
      <div class="quiz-count">${state.currentQ + 1} / ${qs.length} · 得分 ${state.score}<button class="auto-toggle ${state.autoSpeak ? 'on' : ''}" onclick="toggleAutoSpeak()">${state.autoSpeak ? '🔊 自动朗读' : '🔇 朗读关'}</button></div>
    </div>
    <div class="question-box">
      <span class="question-type" style="background:${typeColor[q.type] || '#4facfe'}">${q.type}</span>
      <div class="question-text">${q.q}${qSpeak}</div>
    </div>
    ${body}
    <button class="btn btn-next" onclick="nextQuestion()" ${btnDisabled}>${btnText}</button>
  `;

  content.innerHTML = html;
  bindSpeakButtons();
  setCrumb([
    { t: '🏠 首页', go: 'renderBookSelect()' },
    { t: BOOK.title, go: 'renderMap()' },
    { t: unit.name, go: `openUnit(${state.currentUnit})` },
    { t: '🎯 闯关' }
  ]);

  // 听写题：聚焦输入框，回车直接检查
  const inp = document.getElementById('dictationInput');
  if (inp) {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') nextQuestion(); });
    inp.focus();
  }

  // 自动朗读：进入新题时只朗读题干英文（选项不自动播放——英文选项全读一遍既啰嗦又等于广播答案；
  // 提交答案后由 speakCorrectAnswer 只朗读正确选项）
  const key = state.currentUnit + '-' + state.currentQ;
  if (state.autoSpeak && state.lastSpoken !== key) {
    state.lastSpoken = key;
    setTimeout(() => {
      if (q.type === '听写') speakText(encodeURIComponent(q.word));
      else if (!isCloze(q)) speakSequence([q.q]);
    }, 200);
  }
}

function selectOption(index) {
  if (state.answered) return;
  state.selected = index;
  renderQuiz();
}

function nextQuestion() {
  if (state.answered) return;

  const q = state.drawn[state.currentQ];
  let isCorrect;

  if (q.type === '听写') {
    const input = document.getElementById('dictationInput');
    const val = input ? input.value : '';
    if (!val.trim()) { alert('请先仔细听一听，再拼写单词'); return; }
    state.selected = val;
    isCorrect = normalizeWord(val) === normalizeWord(q.word);
  } else {
    if (state.selected === -1) return;
    isCorrect = state.selected === q.answer;
  }

  if (isCorrect) {
    state.score++;
    showFeedback(true);
  } else {
    showFeedback(false);
  }

  state.answered = true;
  state.answeredCorrect = isCorrect;

  // 重新渲染以显示正确答案
  renderQuiz();

  // 选择答案提示对错后，播放正确答案的语音
  // （听写=单词；单词题=题干英文；完形填空=补全整句；其余=正确选项）
  let advanced = false;
  const advance = () => {
    if (advanced) return;
    advanced = true;
    const qs = state.drawn;
    if (state.currentQ < qs.length - 1) {
      state.currentQ++;
      state.selected = -1;
      state.answered = false;
      state.answeredCorrect = false;
      renderQuiz();
    } else {
      showResult();
    }
  };
  setTimeout(() => speakCorrectAnswer(q, advance), 350);
  setTimeout(advance, 4500); // 兜底：无语音环境或朗读异常时也能进入下一题
}

// 反馈动画
function showFeedback(isCorrect) {
  const fb = document.getElementById('feedback');
  fb.textContent = isCorrect ? '✓' : '✗';
  fb.className = 'feedback show ' + (isCorrect ? 'correct' : 'wrong');
  setTimeout(() => { fb.className = 'feedback'; }, 800);
}

// ===================== 结果界面 =====================
function showResult() {
  stopSpeech();
  const content = document.getElementById('content');
  const total = state.drawn.length;
  const score = state.score;
  const unitNum = state.currentUnit;
  const unit = BOOK.units[unitNum - 1];
  const need = passLine(total);
  const passed = score >= need;

  let icon, title, msg;

  if (passed) {
    const stars = (score === total || score >= Math.ceil(total * 0.9)) ? 3
                : (score >= Math.ceil(total * 0.8)) ? 2 : 1;
    state.completed[unitNum] = { stars, score, total };
    saveProgress();

    icon = '🎉';
    title = '闯关成功！';
    msg = score === total
      ? `太棒了！满分通过${unit.name}！你是英语小达人！🌟`
      : `恭喜通过${unit.name}！答对 ${score} / ${total} 题，继续加油！`;
  } else {
    icon = '💪';
    title = '再接再厉！';
    msg = `答对 ${score} / ${total} 题，答对 ${need} 题才能通过。复习单词和句型，再来一次吧！`;
  }

  const html = `
    <div class="result-box">
      <div class="result-icon">${icon}</div>
      <div class="result-title">${title}</div>
      <div class="result-score">${score} / ${total}</div>
      <div class="result-msg">${msg}</div>
      ${passed && unitNum < BOOK.units.length ? `<button class="btn btn-primary" onclick="startQuiz(${unitNum + 1})">下一关：${BOOK.units[unitNum].icon} ${BOOK.units[unitNum].name}</button>` : ''}
      <button class="btn btn-next" onclick="backToMap()" style="margin-top:10px">返回关卡地图</button>
      ${!passed ? `<button class="btn btn-next" onclick="startQuiz(${unitNum})" style="margin-top:10px">🔄 再试一次</button>` : ''}
    </div>
  `;

  content.innerHTML = html;
  updateProgress();
  setCrumb([
    { t: '🏠 首页', go: 'renderBookSelect()' },
    { t: BOOK.title, go: 'renderMap()' },
    { t: unit.name, go: `openUnit(${unitNum})` },
    { t: '🎯 闯关·成绩' }
  ]);
}

// 返回地图
function backToMap() {
  stopSpeech();
  renderMap();
  updateProgress();
}

// 重置进度
function resetProgress() {
  if (confirm('确定要清除本课本所有闯关进度吗？')) {
    state.completed = {};
    saveProgress();
    renderMap();
    updateProgress();
  }
}

// ===================== 初始化 =====================
initVoices();
if ('speechSynthesis' in window) {
  // 音色列表异步加载，变化时重新取一次
  speechSynthesis.onvoiceschanged = initVoices;
}
boot();
