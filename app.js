/* app.js — 化学三语词汇库 前端逻辑
 * 依赖: data.js (window.CHEM_VOCAB 预设词汇)
 * 持久化: localStorage 存设置；用户新增词 + 笔记经 GitHub API 写回仓库 user-data.json
 */
(function () {
  'use strict';

  // ---------- 常量 ----------
  var SETTINGS_KEY = 'chem_settings';           // 仓库配置 + PAT（仅本机）
  var USERDATA_KEY = 'chem_userdata_cache';     // 用户数据的本地缓存（离线可读）
  var PRESET = (window.CHEM_VOCAB || []);        // 预设词汇（来自 data.js）

  // 内存中的用户数据；结构: { vocab: [], notes: [], stars: [], overrides: {} }
  // stars     —— 被收藏词条的 id；
  // overrides—— 对「预设词条（含 118 化学元素）」的字段覆盖，键为 'ov:' + 词条 key。
  //              预设词库本身只读（data.js 由生成器产出），编辑内容单独存这里，
  //              避免把上千条预设词整体搬进用户数据文件。
  var userData = { vocab: [], notes: [], stars: [], overrides: {} };

  // 编辑态：
  //   editingVocabId 为 null            -> 新增模式
  //   以 'ov:' 开头                     -> 修改预设词条（写入 userData.overrides）
  //   为 'u…' 等用户词条 id             -> 修改用户词条（写入 userData.vocab）
  var editingVocabId = null;
  var editingNoteId = null;

  // 当前表单会话中「待提交的图片」（data URL 数组）
  var pendingVImages = [];   // 自助新增 / 编辑词汇
  var pendingNImages = [];   // 学习笔记
  var MAX_IMAGES = 8;        // 单条目最多图片数
  var MAX_IMG_BYTES = 500 * 1024;   // 单图压缩目标上限（GitHub API 单文件内容 1MB）

  // 切换页签（编辑时用于跳转回表单）
  function showTab(tab) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === tab);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) {
      p.classList.toggle('active', p.id === tab);
    });
  }

  // ---------- DOM 速取 ----------
  function $(id) { return document.getElementById(id); }

  // 转义 HTML，防止用户内容注入（XSS）
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 设置按钮的「可见文案」。
  // 关键：<button> 的显示文字来自子元素文本，赋值 .value 只在表单提交时传递值，
  // 界面上完全不变（<input type=submit> 才是 value 即文案）。因此必须写 textContent，
  // 否则会出现「提示语让你点保存修改，按钮上却还写着保存到仓库」的问题。
  function setBtnLabel(el, txt) {
    if (!el) return;
    el.textContent = txt;
    el.value = txt;              // 同时同步表单提交值，保持语义一致
  }

  // UTF-8 字符串 -> Base64（GitHub API 要求 base64 内容）
  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  // 发音图标（内联 SVG，避免 emoji；学术简洁风）
  var SPEAKER_SVG = '<svg class="spk" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path d="M3 6h2.5L8 3v10L5.5 10H3z" fill="currentColor"/>' +
    '<path d="M10 5.2a3.2 3.2 0 0 1 0 5.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '</svg>';

  // ---------- 发音（Web Speech API） ----------
  // 纯前端、零成本、零后端；预设词与用户新增词通用（二者均含 en 字段）。
  // 支持英式(en-GB)/美式(en-US)，移动端(iOS Safari)同样可用。
  var synth = window.speechSynthesis || null;
  var voicesLoaded = [];

  function refreshVoices() {
    if (!synth) return;
    var vs = synth.getVoices();
    if (vs && vs.length) voicesLoaded = vs;
  }
  // iOS / 部分 Chrome：语音列表异步加载，加载完成后回调刷新
  if (synth && 'onvoiceschanged' in synth) {
    synth.onvoiceschanged = refreshVoices;
  }
  // iOS 首次 getVoices() 常返回空，需在用户手势内首次取一次（点击发音即触发）
  function ensureVoices() {
    if (!synth) return;
    if (!voicesLoaded.length) refreshVoices();
  }
  // 按 lang 选取最匹配语音：精确 -> 同语种前缀(en-)兜底
  function pickVoice(lang) {
    if (!voicesLoaded.length) refreshVoices();
    if (!voicesLoaded.length) return null;
    var exact = voicesLoaded.filter(function (v) { return v.lang === lang; });
    if (exact.length) return exact[0];
    var base = lang.split('-')[0];
    var near = voicesLoaded.filter(function (v) { return v.lang && v.lang.split('-')[0] === base; });
    return near.length ? near[0] : null;
  }
  // 朗读单词；word 来自卡片的 en 字段
  function speak(word, lang) {
    if (!synth || !word) return;        // 浏览器不支持或单词为空则静默
    ensureVoices();
    // 不调用 cancel()：iOS Safari 在 cancel 后紧接 speak 可能吞掉首次发音；
    // 快速连点仅会顺序朗读，属可接受行为。
    var u = new SpeechSynthesisUtterance(word);
    u.lang = lang;
    var v = pickVoice(lang);
    if (v) u.voice = v;                // 无对应语音时仅靠 lang 让系统自选（可能回退）
    synth.speak(u);
  }

  // ---------- 设置 ----------
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
  function applySettingsToForm() {
    var s = loadSettings();
    $('s_owner').value = s.owner || '';
    $('s_repo').value = s.repo || '';
    $('s_branch').value = s.branch || 'main';
    $('s_path').value = s.path || 'user-data.json';
    $('s_pat').value = s.pat || '';
  }

  // ---------- GitHub 读写 ----------
  // 读取用户数据：优先 raw（无需令牌，公开仓库）；失败且配有 PAT 时回退 API
  function fetchUserData() {
    var s = loadSettings();
    if (!s.owner || !s.repo) return Promise.resolve(null);
    var rawUrl = 'https://raw.githubusercontent.com/' + s.owner + '/' + s.repo + '/' +
      (s.branch || 'main') + '/' + (s.path || 'user-data.json');
    // fetch 可能抛同步异常（环境不支持 / 网络中断），统一兜底，避免阻断页面初始化
    var p;
    try {
      p = fetch(rawUrl);
    } catch (e) {
      p = Promise.reject(e);
    }
    return p
      .then(function (r) {
        if (!r.ok) {
          if (r.status === 404) return null;             // 文件不存在，视为空
          if (s.pat) return apiGet(s);                    // 私有库/受限，用令牌
          throw new Error('读取失败 HTTP ' + r.status);
        }
        return r.json();
      })
      .catch(function () { return s.pat ? apiGet(s) : null; });
  }

  // 经 API（带令牌）读取，返回 { sha, data }
  function apiGet(s) {
    var url = 'https://api.github.com/repos/' + s.owner + '/' + s.repo +
      '/contents/' + encodeURIComponent(s.path || 'user-data.json') + '?ref=' + encodeURIComponent(s.branch || 'main');
    return fetch(url, { headers: { 'Authorization': 'Bearer ' + s.pat, 'Accept': 'application/vnd.github+json' } })
      .then(function (r) {
        if (r.status === 404) return { sha: null, data: null };
        if (!r.ok) throw new Error('API 读取失败 HTTP ' + r.status);
        return r.json().then(function (j) {
          // 严格按 UTF-8 字节流解码：先把 base64 还原为字节，再整体解码。
          // 注意不能用 decodeURIComponent(escape(atob(...)))——那会把多字节序列
          // 逐个还原成错误码位的单个字符（中文/韩文会乱码），仅英文可用。
          var bin = atob(j.content.replace(/\s/g, ''));
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
          var txt = (typeof TextDecoder !== 'undefined')
            ? new TextDecoder('utf-8').decode(bytes)
            : decodeURIComponent(escape(bytes));   // 旧环境兜底
          return { sha: j.sha, data: JSON.parse(txt) };
        });
      });
  }

  // 写回仓库：先取 sha（存在则更新，否则新建），再 PUT
  function commitUserData(message) {
    var s = loadSettings();
    if (!s.owner || !s.repo || !s.pat) {
      return Promise.reject(new Error('请先在“设置”中填写 owner / repo / PAT'));
    }
    var raw = JSON.stringify(userData, null, 2);
    // GitHub 内容 API 单文件上限 1MB（base64 后约为原始字符的 1.33 倍），提前拦截
    if (raw.length > 620 * 1024) {
      return Promise.reject(new Error(
        '数据体积 ' + Math.round(raw.length / 1024) + 'KB，超出仓库写入上限；请精简配图数量或改用更小尺寸的截图。'));
    }
    var content = utf8ToBase64(raw);
    var path = s.path || 'user-data.json';
    var url = 'https://api.github.com/repos/' + s.owner + '/' + s.repo +
      '/contents/' + encodeURIComponent(path);
    // 第一步：获取当前 sha
    var p1;
    try {
      p1 = fetch(url + '?ref=' + encodeURIComponent(s.branch || 'main'), {
        headers: { 'Authorization': 'Bearer ' + s.pat, 'Accept': 'application/vnd.github+json' }
      });
    } catch (e) { p1 = Promise.reject(e); }
    return p1.then(function (r) {
      var sha = null;
      if (r.ok) return r.json().then(function (j) { return j.sha; });
      if (r.status !== 404) throw new Error('获取 sha 失败 HTTP ' + r.status);
      return null; // 404 => 新建
    }).then(function (sha) {
      // 第二步：PUT 写入
      var body = { message: message || 'update chem lexicon data', content: content, branch: s.branch || 'main' };
      if (sha) body.sha = sha;
      return fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + s.pat, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error((e && e.message) || ('写入失败 HTTP ' + r.status)); });
      return r.json();
    });
  }

  // ---------- 词汇库渲染 ----------
  var DOMAIN_ORDER = ['合成', '光刻胶', '封装', '聚合', '量产扩大', '化学元素'];

  // 预设词条的覆盖键：'ov:' + key（key 由 generate_data.js 产出，全库唯一）
  function ovKey(v, i) {
    return 'ov:' + (v.key || ('p' + i));
  }

  // 韩语两项是否都已填写（决定 conf 标记）
  function koDone(v) {
    return !!(v.koRom && v.koRom !== '需验证' && v.koMean && v.koMean !== '需验证');
  }

  function getAllVocab() {
    var overrides = userData.overrides || {};
    // 预设 + 用户；用户词条带 source/可删标记
    // 预置词无 id 时按数组下标补稳定 id（p0/p1…），用于星标标记
    var preset = PRESET.map(function (v, i) {
      var o = Object.assign({}, v, { id: v.id || ('p' + i), source: 'preset' });
      var k = ovKey(v, i);
      var ov = overrides[k];
      o._ovKey = k;   // 所有预设词条都带覆盖键（编辑时据此写入 overrides）
      if (ov) {
        // 覆盖合并：只取用户实际填写过的字段（空串表示未填，回落到预设原值）
        ['koRom', 'koMean', 'note', 'level', 'domain'].forEach(function (f) {
          if (typeof ov[f] === 'string' && ov[f] !== '') o[f] = ov[f];
        });
        if (Array.isArray(ov.images)) o.images = ov.images.slice();
        o._ovDone = true;
      }
      o.conf = koDone(o) ? 'verified' : 'needs-check';
      return o;
    });
    var user = userData.vocab.map(function (v) {
      var o = Object.assign({}, v, { source: 'user' });
      o._ovKey = '';
      o.conf = koDone(o) ? 'verified' : 'needs-check';
      return o;
    });
    return preset.concat(user);
  }

  // 按渲染后的 id 取词条（用于回填编辑表单）
  function findRendered(id) {
    var m = null;
    getAllVocab().forEach(function (v) { if (!m && String(v.id) === String(id)) m = v; });
    return m;
  }

  // 是否已收藏
  function isStarred(id) {
    return userData.stars.indexOf(id) !== -1;
  }

  // 切换收藏状态（GitHub star 式：点一下收藏，再点取消），并写回仓库同步
  function toggleStar(id) {
    if (!id) return;
    var i = userData.stars.indexOf(id);
    if (i === -1) userData.stars.push(id);
    else userData.stars.splice(i, 1);
    persistAndRender('toggle star ' + id, null, function () { renderVocab(); renderStars(); });
  }

  function renderVocab() {
    var q = $('search').value.trim().toLowerCase();
    var fd = $('filterDomain').value;
    var fl = $('filterLevel').value;
    var list = getAllVocab().filter(function (v) {
      if (fd && v.domain !== fd) return false;
      // 层级筛选：“自助新增”按来源(用户添加)过滤，其余按 level 字段过滤
      if (fl) {
        if (fl === '__user__') { if (v.source !== 'user') return false; }
        else if (v.level !== fl) return false;
      }
      if (q) {
        var hay = (v.zh + ' ' + v.en + ' ' + v.koRom + ' ' + v.koMean + ' ' + (v.note || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    var container = $('vocabList');
    container.innerHTML = '';
    $('vocabCount').textContent = '共 ' + list.length + ' 条';

    if (!list.length) {
      container.innerHTML = '<p class="hint">无匹配词条。</p>';
      return;
    }

    // 按方向分组
    DOMAIN_ORDER.forEach(function (dom) {
      var group = list.filter(function (v) { return v.domain === dom; });
      if (!group.length) return;
      var title = document.createElement('div');
      title.className = 'vocab-group-title';
      title.textContent = domLabel(dom) + '（' + group.length + '）';
      container.appendChild(title);
      group.forEach(function (v) { container.appendChild(cardEl(v)); });
    });
    // 其他未知方向
    var others = list.filter(function (v) { return DOMAIN_ORDER.indexOf(v.domain) === -1; });
    if (others.length) {
      var t2 = document.createElement('div');
      t2.className = 'vocab-group-title';
      t2.textContent = '其他（' + others.length + '）';
      container.appendChild(t2);
      others.forEach(function (v) { container.appendChild(cardEl(v)); });
    }
  }

  function domLabel(d) {
    return { '合成': '化学合成', '光刻胶': '光刻胶', '封装': '封装', '聚合': '聚合', '量产扩大': '量产扩大', '化学元素': '化学元素', '其他': '其他' }[d] || d;
  }

  // 渲染“星标词汇”标签页：实时汇总所有已收藏词条
  function renderStars() {
    var container = $('starsList');
    if (!container) return;
    var starred = getAllVocab().filter(function (v) { return isStarred(v.id); });
    container.innerHTML = '';
    $('starsCount').textContent = '共 ' + starred.length + ' 条';
    if (!starred.length) {
      container.innerHTML = '<p class="hint">暂无星标词汇。在“词汇库”点击卡片右下角的 ☆ 即可收藏，便于重点学习。</p>';
      return;
    }
    starred.forEach(function (v) { container.appendChild(cardEl(v)); });
  }

  function cardEl(v) {
    var el = document.createElement('div');
    var starred = isStarred(v.id);
    el.className = 'card' + (starred ? ' starred' : '') + (v._ovDone ? ' edited' : '');
    var ko = (v.koRom && v.koRom !== '需验证') || (v.koMean && v.koMean !== '需验证')
      ? '<div class="ko"><span class="koRom">' + esc(v.koRom) + '</span> / <span class="koMean">' + esc(v.koMean) + '</span></div>'
      : '<div class="ko"><span class="koMean">韩语：需验证（点“编辑”可补填）</span></div>';
    var tags =
      '<span class="tag domain">' + esc(domLabel(v.domain)) + '</span>' +
      '<span class="tag">' + esc(v.level) + '</span>' +
      (v.conf === 'needs-check' ? '<span class="tag warn">需验证</span>' : '') +
      (v._ovDone ? '<span class="tag edited-tag">已编辑</span>' : '') +
      (v.source === 'user' ? '<span class="tag user">我添加</span>' : '');
    var del = v.source === 'user'
      ? '<button class="del-btn" data-id="' + esc(v.id) + '">删除</button>' : '';
    // 全部词条（预设 / 化学元素 / 用户新增）均可编辑：预设类走 overrides 覆盖模式
    var edt = '<button class="edit-btn" data-id="' + esc(v.id) + '" data-key="' + esc(v._ovKey || '') + '">编辑</button>';
    // 卡片配图：用户新增词、已被覆盖编辑的词、化学元素可移除配图
    var canDropImg = v.source === 'user' || !!v._ovKey;
    var imgs = (Array.isArray(v.images) && v.images.length)
      ? '<div class="card-imgs">' + v.images.map(function (src, idx) {
          return '<span class="thumb"><img src="' + src + '" alt="配图" />' +
            (canDropImg
              ? '<button type="button" class="img-del" data-kind="vocab" data-idx="' + idx +
                '" data-id="' + esc(v.id) + '" data-key="' + esc(v._ovKey || '') + '" title="移除该图">×</button>'
              : '') +
            '</span>';
        }).join('') + '</div>'
      : '';
    // 星标按钮：右下角，★=已收藏 / ☆=未收藏
    var star = '<button class="star-btn' + (starred ? ' on' : '') + '" data-id="' + esc(v.id) +
      '" title="收藏 / 取消收藏">' + (starred ? '★' : '☆') + '</button>';
    el.innerHTML =
      '<div class="head"><span class="zh">' + esc(v.zh) + '</span>' +
      '<span class="en">' + esc(v.en) + '</span>' +
      '<span class="speak-btns">' +
        '<button class="speak-btn" type="button" data-word="' + esc(v.en) + '" data-lang="en-GB" title="英式发音 (UK)" aria-label="英式发音">' + SPEAKER_SVG + 'UK</button>' +
        '<button class="speak-btn" type="button" data-word="' + esc(v.en) + '" data-lang="en-US" title="美式发音 (US)" aria-label="美式发音">' + SPEAKER_SVG + 'US</button>' +
      '</span></div>' +
      ko +
      '<div class="note">' + esc(v.note) + '</div>' +
      imgs +
      '<div class="meta">' + tags + edt + del + star + '</div>';
    return el;
  }

  // 事件委托：发音 / 星标 / 编辑 / 删除 / 移除配图（词汇库与星标两个列表共用）
  function onVocabClick(e) {
    // 0) 发音（英式/美式）—— 任何卡片（预设或用户新增）都可点
    var speakBtn = e.target.closest('.speak-btn');
    if (speakBtn) {
      speak(speakBtn.getAttribute('data-word'), speakBtn.getAttribute('data-lang'));
      return;
    }
    // 0.5) 移除卡片上的某张配图
    var imgDel = e.target.closest('.img-del');
    if (imgDel && imgDel.getAttribute('data-kind') === 'vocab') {
      removeVocabImage(imgDel.getAttribute('data-key'), imgDel.getAttribute('data-id'), parseInt(imgDel.getAttribute('data-idx'), 10));
      return;
    }
    // 1) 星标切换（任何卡片都可点）
    var starBtn = e.target.closest('.star-btn');
    if (starBtn) { toggleStar(starBtn.getAttribute('data-id')); return; }
    // 2) 编辑（全部词条：预设/元素走 overrides，用户词条走 userData.vocab）
    var editBtn = e.target.closest('.edit-btn');
    if (editBtn) {
      var id = editBtn.getAttribute('data-id');
      var entry = findRendered(id);
      if (!entry) return;
      var isPreset = !!editBtn.getAttribute('data-key');
      // 回填表单
      $('a_zh').value = entry.zh || '';
      $('a_en').value = entry.en || '';
      $('a_koRom').value = (entry.koRom && entry.koRom !== '需验证') ? entry.koRom : '';
      $('a_koMean').value = (entry.koMean && entry.koMean !== '需验证') ? entry.koMean : '';
      $('a_domain').value = entry.domain || '合成';
      $('a_level').value = entry.level || '核心';
      $('a_note').value = entry.note || '';
      // 预设词条：中文/英文为库内既有内容，锁定以免覆盖键与展示不一致
      $('a_zh').readOnly = isPreset;
      $('a_en').readOnly = isPreset;
      // 锁定字段同时去掉必填校验：预设词的中文/英文本来就已有值，
      // 若保留 required，部分浏览器会在提交时弹出“请填写此字段”并静默阻止保存。
      $('a_zh').required = !isPreset;
      $('a_en').required = !isPreset;
      editingVocabId = isPreset ? editBtn.getAttribute('data-key') : entry.id;
      setBtnLabel($('addSubmit'), '保存修改');
      $('addSubmit').classList.add('editing');   // 高亮，避免与「新增」态混淆
      $('addCancel').style.display = '';
      $('addModeHint').style.display = '';
      $('addModeHint').textContent = isPreset
        ? '正在修改预设词条（中文 / 英文已锁定，可补填或修正韩语、解析、方向、层级与配图）。'
        : '正在修改词条，改完点“保存修改”。';
      pendingVImages = Array.isArray(entry.images) ? entry.images.slice() : [];
      drawVImages();
      showTab('add');
      setStatus('addStatus', '正在修改词条，改完点“保存修改”。', '');
      return;
    }
    // 3) 删除（仅用户词条）
    var delBtn = e.target.closest('.del-btn');
    if (!delBtn) return;
    var did = delBtn.getAttribute('data-id');
    if (!confirm('确认删除该词条？')) return;
    userData.vocab = userData.vocab.filter(function (x) { return String(x.id) !== String(did); });
    persistAndRender('删除词条', 'vocabList');
  }

  // 移除某词条上的一张图（支持覆盖模式与用户词条两种存储）
  function removeVocabImage(ovKeyStr, id, idx) {
    if (idx < 0) return;
    if (typeof ovKeyStr === 'string' && ovKeyStr) {
      var ov = userData.overrides[ovKeyStr];
      if (ov && Array.isArray(ov.images)) {
        ov.images.splice(idx, 1);
        if (!ov.images.length) delete ov.images;
        ov.updatedAt = new Date().toISOString();
      }
    } else {
      var rec = userData.vocab.filter(function (x) { return String(x.id) === String(id); })[0];
      if (rec && Array.isArray(rec.images)) {
        rec.images.splice(idx, 1);
        rec.updatedAt = new Date().toISOString();
      }
    }
    persistAndRender('移除配图', null, function () { renderVocab(); renderStars(); });
  }
  $('vocabList').addEventListener('click', onVocabClick);
  $('starsList').addEventListener('click', onVocabClick);

  // 重置新增表单到“新增模式”
  function resetAddForm() {
    $('addForm').reset();
    $('a_level').value = '核心';
    editingVocabId = null;
    setBtnLabel($('addSubmit'), '保存到仓库');
    $('addSubmit').classList.remove('editing');
    $('addCancel').style.display = 'none';
    $('a_zh').readOnly = false;
    $('a_en').readOnly = false;
    $('a_zh').required = true;
    $('a_en').required = true;
    $('addModeHint').style.display = 'none';
    $('addModeHint').textContent = '';
    pendingVImages = [];
    drawVImages();
  }

  // ================= 图片上传（本地选择 + 剪贴板粘贴） =================
  // 图片以 data URL（base64）随 user-data.json 一起写入仓库，因此必须压缩：
  //   · 单图目标 <= 500KB（GitHub API 单文件内容上限 1MB）
  //   · 单条目最多 8 张
  // 若超出配额，仅跳过 localStorage 缓存，不阻断保存。

  // data URL 近似字节数（base64 每 4 字符 ≈ 3 字节）
  function approxBytes(dataUrl) { return Math.round(dataUrl.length * 0.75); }

  // 图片压缩：等比缩到最长边 1280，JPEG 质量自适应下降
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('不是图片文件')); return; }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('图片解析失败')); };
        img.onload = function () {
          var maxSide = 1280;
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (w > maxSide || h > maxSide) {
            var r = Math.min(maxSide / w, maxSide / h);
            w = Math.round(w * r); h = Math.round(h * r);
          }
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          var ctx = cv.getContext('2d');
          // JPEG 无透明通道：先铺白底，避免截图透明区变黑
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          var q = 0.75, url = cv.toDataURL('image/jpeg', q);
          var guard = 0;
          while (approxBytes(url) > MAX_IMG_BYTES && q > 0.35 && guard++ < 6) {
            q -= 0.12; url = cv.toDataURL('image/jpeg', q);
          }
          resolve(url);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // 把若干文件追加进当前待提交图片队列
  function addPendingImages(files, kind) {
    var list = kind === 'note' ? pendingNImages : pendingVImages;
    var pending = Array.prototype.slice.call(files || []);
    if (!pending.length) return Promise.resolve(0);
    if (list.length >= MAX_IMAGES) {
      setStatus(kind === 'note' ? 'noteStatus' : 'addStatus',
        '最多 ' + MAX_IMAGES + ' 张，请先移除一些再添加。', 'err');
      return Promise.resolve(0);
    }
    var added = 0;
    return Promise.all(pending.map(function (f) {
      return compressImage(f).then(function (url) {
        if (list.length >= MAX_IMAGES) return;
        // 同一张图重复粘贴去重
        if (list.indexOf(url) !== -1) return;
        list.push(url);
        added++;
      }).catch(function (err) {
        setStatus(kind === 'note' ? 'noteStatus' : 'addStatus', '图片添加失败：' + err.message, 'err');
      });
    })).then(function () {
      if (kind === 'note') drawNImages(); else drawVImages();
      var kb = Math.round(list.reduce(function (s, u) { return s + approxBytes(u); }, 0) / 1024);
      setStatus(kind === 'note' ? 'noteStatus' : 'addStatus',
        '已添加 ' + list.length + ' 张配图（约 ' + kb + ' KB）。保存后会写入仓库。', 'ok');
      return added;
    });
  }

  // 预览：词汇表单
  function drawVImages() {
    var box = $('a_imgs');
    if (!box) return;
    box.innerHTML = '';
    pendingVImages.forEach(function (src, idx) {
      var t = document.createElement('span');
      t.className = 'thumb';
      t.innerHTML = '<img src="' + src + '" alt="待保存配图" />' +
        '<button type="button" class="img-del" data-kind="v" data-idx="' + idx + '" title="移除">×</button>';
      box.appendChild(t);
    });
  }
  // 预览：笔记表单
  function drawNImages() {
    var box = $('n_imgs');
    if (!box) return;
    box.innerHTML = '';
    pendingNImages.forEach(function (src, idx) {
      var t = document.createElement('span');
      t.className = 'thumb';
      t.innerHTML = '<img src="' + src + '" alt="待保存配图" />' +
        '<button type="button" class="img-del" data-kind="n" data-idx="' + idx + '" title="移除">×</button>';
      box.appendChild(t);
    });
  }

  // 当前处于哪个录入面板（决定粘贴的图片归属）
  function currentImageKind() {
    var addActive = $('add').classList.contains('active');
    var notesActive = $('notes').classList.contains('active');
    if (addActive) return 'vocab';
    if (notesActive) return 'note';
    return null;
  }

  // 表单内预览区的删除按钮（事件委托）
  $('a_imgs').addEventListener('click', function (e) {
    var b = e.target.closest('.img-del');
    if (!b) return;
    pendingVImages.splice(parseInt(b.getAttribute('data-idx'), 10), 1);
    drawVImages();
  });
  $('n_imgs').addEventListener('click', function (e) {
    var b = e.target.closest('.img-del');
    if (!b) return;
    pendingNImages.splice(parseInt(b.getAttribute('data-idx'), 10), 1);
    drawNImages();
  });

  // 本地文件选择
  $('a_pick').addEventListener('click', function () { $('a_file').click(); });
  $('n_pick').addEventListener('click', function () { $('n_file').click(); });
  $('a_file').addEventListener('change', function (e) {
    addPendingImages(e.target.files, 'vocab');
    e.target.value = '';   // 允许重复选择同一文件
  });
  $('n_file').addEventListener('change', function (e) {
    addPendingImages(e.target.files, 'note');
    e.target.value = '';
  });

  // 剪贴板粘贴：截图直接在页面按 Ctrl/Cmd+V 即上传
  // 仅在「自助新增 / 学习笔记」面板生效；焦点在输入框内时不拦截（避免打断文字粘贴）
  document.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items || !items.length) return;
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    var kind = currentImageKind();
    if (!kind) return;
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return;
    e.preventDefault();
    addPendingImages(files, kind);
    // 切到对应面板，让用户看到刚粘贴的图
    showTab(kind === 'note' ? 'notes' : 'add');
  });

  // ---------- 新增 / 修改词汇 ----------
  $('addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var zh = $('a_zh').value.trim();
    var en = $('a_en').value.trim();
    var koRom = $('a_koRom').value.trim();
    var koMean = $('a_koMean').value.trim();
    var note = $('a_note').value.trim();
    if (!zh || !en || !note) { setStatus('addStatus', '请填写中文/英文/解析', 'err'); return; }

    if (editingVocabId) {
      if (String(editingVocabId).indexOf('ov:') === 0) {
        // —— 修改预设词条（含 118 化学元素）：写入 overrides，不动 data.js ——
        var k = editingVocabId;
        var ov = userData.overrides[k] || (userData.overrides[k] = {});
        // 空值字段存为空串，读取时回落到预设原值（例：韩语未填仍显示“需验证”）
        ov.koRom = koRom || '';
        ov.koMean = koMean || '';
        ov.note = note || '';
        ov.domain = $('a_domain').value;
        ov.level = $('a_level').value;
        ov.images = pendingVImages.slice();
        ov.updatedAt = new Date().toISOString();
        persistAndRender('修改预设词条: ' + zh, 'addStatus', resetAddForm);
        return;
      }
      // —— 修改用户词条：按 id 原地替换 ——
      var hit = false;
      userData.vocab = userData.vocab.map(function (x) {
        if (String(x.id) !== String(editingVocabId)) return x;
        hit = true;
        return Object.assign({}, x, {
          zh: zh, en: en,
          koRom: koRom || '需验证', koMean: koMean || '需验证',
          domain: $('a_domain').value, level: $('a_level').value, note: note,
          images: pendingVImages.slice(),
          conf: (koRom && koMean) ? 'verified' : 'needs-check',
          updatedAt: new Date().toISOString()
        });
      });
      if (!hit) { setStatus('addStatus', '未找到原词条，已转为新增', 'err'); return; }
      persistAndRender('修改词条: ' + zh, 'addStatus', resetAddForm);
    } else {
      // 新增模式
      var entry = {
        id: 'u' + Date.now(),
        zh: zh, en: en,
        koRom: koRom || '需验证', koMean: koMean || '需验证',
        domain: $('a_domain').value, level: $('a_level').value, note: note,
        conf: (koRom && koMean) ? 'verified' : 'needs-check',
        images: pendingVImages.slice(),
        addedAt: new Date().toISOString()
      };
      userData.vocab.push(entry);
      persistAndRender('新增词条: ' + entry.zh, 'addStatus', resetAddForm);
    }
  });

  // 取消修改：回到新增模式
  $('addCancel').addEventListener('click', function () {
    resetAddForm();
    setStatus('addStatus', '', '');
  });

  // ---------- 学习笔记 ----------
  function renderNotes() {
    var q = $('noteSearch').value.trim().toLowerCase();
    var list = userData.notes.filter(function (n) {
      if (!q) return true;
      var hay = (n.title + ' ' + n.body + ' ' + (n.cat || '') + ' ' + (n.tags || '')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    var box = $('noteList');
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<p class="hint">暂无笔记。</p>'; return; }
    list.slice().reverse().forEach(function (n) {
      var el = document.createElement('div');
      el.className = 'note-item';
      el.innerHTML =
        '<div><span class="nt">' + esc(n.title) + '</span>' +
        (n.cat ? '<span class="nc">' + esc(n.cat) + '</span>' : '') + '</div>' +
        '<div class="nb">' + esc(n.body) + '</div>' +
        (n.tags ? '<div class="tags"># ' + esc(n.tags) + '</div>' : '') +
        (Array.isArray(n.images) && n.images.length
          ? '<div class="note-imgs">' + n.images.map(function (src, idx) {
              return '<span class="thumb"><img src="' + src + '" alt="笔记配图" />' +
                '<button type="button" class="img-del" data-nid="' + esc(n.id) + '" data-idx="' + idx + '" title="移除该图">×</button></span>';
            }).join('') + '</div>'
          : '') +
        '<div class="nd">' + esc(n.addedAt || '') + (n.updatedAt ? ' · 已修改 ' + esc(n.updatedAt) : '') + '</div>' +
        '<div class="note-actions">' +
        '<button class="edit-note" data-id="' + esc(n.id) + '">编辑</button>' +
        '<button class="del-note" data-id="' + esc(n.id) + '">删除</button>' +
        '</div>';
      box.appendChild(el);
    });
  }

  // 事件委托：编辑 / 删除笔记
  $('noteList').addEventListener('click', function (e) {
    var editBtn = e.target.closest('.edit-note');
    if (editBtn) {
      var id = editBtn.getAttribute('data-id');
      var note = userData.notes.filter(function (x) { return String(x.id) === String(id); })[0];
      if (!note) return;
      $('n_title').value = note.title || '';
      $('n_cat').value = note.cat || '';
      $('n_body').value = note.body || '';
      $('n_tags').value = note.tags || '';
      editingNoteId = note.id;
      // 回填已有配图到待提交队列（保存后一并写回）
      pendingNImages = Array.isArray(note.images) ? note.images.slice() : [];
      drawNImages();
      setBtnLabel($('noteSubmit'), '保存修改');
      $('noteSubmit').classList.add('editing');
      $('noteCancel').style.display = '';
      showTab('notes');
      setStatus('noteStatus', '正在修改笔记，改完点“保存修改”。', '');
      return;
    }
    // 移除笔记配图
    var imgDel = e.target.closest('.note-imgs .img-del');
    if (imgDel) {
      var nid = imgDel.getAttribute('data-nid');
      var rec = userData.notes.filter(function (x) { return String(x.id) === String(nid); })[0];
      if (rec && Array.isArray(rec.images)) {
        rec.images.splice(parseInt(imgDel.getAttribute('data-idx'), 10), 1);
        rec.updatedAt = new Date().toISOString();
        persistAndRender('移除笔记配图', 'noteList', function () { renderNotes(); });
      }
      return;
    }
    var delBtn = e.target.closest('.del-note');
    if (!delBtn) return;
    var did = delBtn.getAttribute('data-id');
    if (!confirm('确认删除该笔记？')) return;
    userData.notes = userData.notes.filter(function (x) { return String(x.id) !== String(did); });
    persistAndRender('删除笔记', 'noteList');
  });

  // 重置笔记表单到“新增模式”
  function resetNoteForm() {
    $('noteForm').reset();
    editingNoteId = null;
    setBtnLabel($('noteSubmit'), '保存笔记');
    $('noteSubmit').classList.remove('editing');
    $('noteCancel').style.display = 'none';
    pendingNImages = [];
    drawNImages();
  }

  // 取消笔记修改
  $('noteCancel').addEventListener('click', function () {
    resetNoteForm();
    setStatus('noteStatus', '', '');
  });

  $('noteForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var title = $('n_title').value.trim();
    var body = $('n_body').value.trim();
    var cat = $('n_cat').value.trim();
    var tags = $('n_tags').value.trim();
    if (!title || !body) { setStatus('noteStatus', '请填写标题与正文', 'err'); return; }

    if (editingNoteId) {
      var hit = false;
      userData.notes = userData.notes.map(function (x) {
        if (String(x.id) !== String(editingNoteId)) return x;
        hit = true;
        return Object.assign({}, x, {
          title: title, cat: cat, body: body, tags: tags,
          images: pendingNImages.slice(),
          updatedAt: new Date().toISOString()
        });
      });
      if (!hit) { setStatus('noteStatus', '未找到原笔记，已转为新增', 'err'); return; }
      persistAndRender('修改笔记: ' + title, 'noteStatus', resetNoteForm);
    } else {
      var note = {
        id: 'n' + Date.now(),
        title: title, cat: cat, body: body, tags: tags,
        images: pendingNImages.slice(),
        addedAt: new Date().toISOString()
      };
      userData.notes.push(note);
      persistAndRender('新增笔记: ' + note.title, 'noteStatus', resetNoteForm);
    }
  });

  $('noteSearch').addEventListener('input', renderNotes);

  // ---------- 通用：提交 + 渲染 + 状态 ----------
  // 写本地缓存：图片以 base64 存储，可能撑爆 localStorage 5MB 配额；
  // 超出时仅跳过缓存，不阻断写库，避免整个保存动作失败。
  function saveCache() {
    try {
      localStorage.setItem(USERDATA_KEY, JSON.stringify(userData));
      return true;
    } catch (e) {
      return false;   // QuotaExceededError：本次不缓存，内容已在仓库中
    }
  }

  function persistAndRender(message, statusId, after) {
    commitUserData(message)
      .then(function () {
        var cached = saveCache();
        setStatus(statusId, cached ? '已保存到仓库 ✓' : '已保存到仓库 ✓（图片过多，本机缓存未留存）', 'ok');
        renderVocab(); renderNotes(); renderStars();
        if (after) after();
      })
      .catch(function (err) {
        // 写库失败时仍保留本地缓存，避免丢失
        saveCache();
        setStatus(statusId, '保存失败：' + err.message + '（已存本地）', 'err');
        renderVocab(); renderNotes(); renderStars();
      });
  }

  function setStatus(id, msg, kind) {
    var el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ---------- 设置面板 ----------
  $('settingsForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var s = {
      owner: $('s_owner').value.trim(),
      repo: $('s_repo').value.trim(),
      branch: $('s_branch').value.trim() || 'main',
      path: $('s_path').value.trim() || 'user-data.json',
      pat: $('s_pat').value.trim()
    };
    saveSettings(s);
    setStatus('settingsStatus', '设置已保存到本机 ✓', 'ok');
  });

  // 测试读取：验证仓库/路径/PAT 是否可用
  $('testSync').addEventListener('click', function () {
    setStatus('settingsStatus', '正在读取…', '');
    fetchUserData().then(function (data) {
      if (data == null) {
        setStatus('settingsStatus', '读取为空（文件可能尚未创建，新增后即生成）', 'ok');
        $('syncInfo').textContent = '仓库可访问，当前无用户数据。';
      } else {
        userData.vocab = data.vocab || [];
        userData.notes = data.notes || [];
        userData.overrides = data.overrides || {};
        saveCache();
        renderVocab(); renderNotes();
        setStatus('settingsStatus', '读取成功 ✓', 'ok');
        $('syncInfo').textContent = '已从仓库载入：词汇 ' + userData.vocab.length + ' 条，笔记 ' + userData.notes.length + ' 条。';
      }
    }).catch(function (err) {
      setStatus('settingsStatus', '读取失败：' + err.message, 'err');
    });
  });

  // ---------- Tab 切换 ----------
  $('tabs').addEventListener('click', function (e) {
    var btn = e.target.closest('.tab');
    if (!btn) return;
    showTab(btn.getAttribute('data-tab'));
  });

  // 搜索/筛选实时刷新
  $('search').addEventListener('input', renderVocab);
  $('filterDomain').addEventListener('change', renderVocab);
  $('filterLevel').addEventListener('change', renderVocab);

  // ---------- 初始化 ----------
  function init() {
    applySettingsToForm();
    // 先用本机缓存（离线也能看到上次同步的收藏/词汇/笔记），保证离线可用
    try {
      var cached = JSON.parse(localStorage.getItem(USERDATA_KEY));
      if (cached) {
        userData.vocab = cached.vocab || [];
        userData.notes = cached.notes || [];
        userData.stars = cached.stars || [];
        userData.overrides = cached.overrides || {};
      }
    } catch (e) { /* 缓存损坏则忽略 */ }
    renderVocab();
    renderNotes();
    renderStars();
    // 再尝试从仓库拉取用户数据（在线时以仓库为准，覆盖缓存）
    var s = loadSettings();
    if (s.owner && s.repo) {
      fetchUserData().then(function (data) {
        if (data) {
          userData.vocab = data.vocab || [];
          userData.notes = data.notes || [];
          userData.stars = data.stars || [];
          userData.overrides = data.overrides || {};
          saveCache();
        }
        renderVocab(); renderNotes(); renderStars();
      }).catch(function () { /* 离线/未配置：仅用预设与本机缓存 */ });
    }
  }

  init();
})();
