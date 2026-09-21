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

  // 内存中的用户数据；结构: { vocab: [], notes: [] }
  var userData = { vocab: [], notes: [] };

  // 编辑态：非空表示正在修改已有条目（否则为新增模式）
  var editingVocabId = null;
  var editingNoteId = null;

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

  // UTF-8 字符串 -> Base64（GitHub API 要求 base64 内容）
  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
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
    return fetch(rawUrl)
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
          var txt = decodeURIComponent(escape(atob(j.content.replace(/\s/g, ''))));
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
    var content = utf8ToBase64(JSON.stringify(userData, null, 2));
    var path = s.path || 'user-data.json';
    var url = 'https://api.github.com/repos/' + s.owner + '/' + s.repo +
      '/contents/' + encodeURIComponent(path);
    // 第一步：获取当前 sha
    return fetch(url + '?ref=' + encodeURIComponent(s.branch || 'main'), {
      headers: { 'Authorization': 'Bearer ' + s.pat, 'Accept': 'application/vnd.github+json' }
    }).then(function (r) {
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
  var DOMAIN_ORDER = ['合成', '光刻胶', '封装', '聚合', '量产扩大'];

  function getAllVocab() {
    // 预设 + 用户；用户词条带 source/可删标记
    var preset = PRESET.map(function (v) {
      return Object.assign({}, v, { source: 'preset' });
    });
    var user = userData.vocab.map(function (v) {
      return Object.assign({}, v, { source: 'user' });
    });
    return preset.concat(user);
  }

  function renderVocab() {
    var q = $('search').value.trim().toLowerCase();
    var fd = $('filterDomain').value;
    var fl = $('filterLevel').value;
    var list = getAllVocab().filter(function (v) {
      if (fd && v.domain !== fd) return false;
      if (fl && v.level !== fl) return false;
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
    return { '合成': '化学合成', '光刻胶': '光刻胶', '封装': '封装', '聚合': '聚合', '量产扩大': '量产扩大' }[d] || d;
  }

  function cardEl(v) {
    var el = document.createElement('div');
    el.className = 'card';
    var ko = (v.koRom && v.koRom !== '需验证') || (v.koMean && v.koMean !== '需验证')
      ? '<div class="ko"><span class="koRom">' + esc(v.koRom) + '</span> / <span class="koMean">' + esc(v.koMean) + '</span></div>'
      : '<div class="ko"><span class="koMean">韩语：需验证</span></div>';
    var tags =
      '<span class="tag domain">' + esc(domLabel(v.domain)) + '</span>' +
      '<span class="tag">' + esc(v.level) + '</span>' +
      (v.conf === 'needs-check' ? '<span class="tag warn">需验证</span>' : '') +
      (v.source === 'user' ? '<span class="tag user">我添加</span>' : '');
    var del = v.source === 'user'
      ? '<button class="del-btn" data-id="' + esc(v.id) + '">删除</button>' : '';
    var edt = v.source === 'user'
      ? '<button class="edit-btn" data-id="' + esc(v.id) + '">编辑</button>' : '';
    el.innerHTML =
      '<div class="head"><span class="zh">' + esc(v.zh) + '</span>' +
      '<span class="en">' + esc(v.en) + '</span></div>' +
      ko +
      '<div class="note">' + esc(v.note) + '</div>' +
      '<div class="meta">' + tags + edt + del + '</div>';
    return el;
  }

  // 事件委托：编辑 / 删除用户词条
  $('vocabList').addEventListener('click', function (e) {
    var editBtn = e.target.closest('.edit-btn');
    if (editBtn) {
      var id = editBtn.getAttribute('data-id');
      var entry = userData.vocab.filter(function (x) { return String(x.id) === String(id); })[0];
      if (!entry) return;
      // 把现有条目回填到新增表单，并切换为“修改模式”
      $('a_zh').value = entry.zh || '';
      $('a_en').value = entry.en || '';
      $('a_koRom').value = (entry.koRom && entry.koRom !== '需验证') ? entry.koRom : '';
      $('a_koMean').value = (entry.koMean && entry.koMean !== '需验证') ? entry.koMean : '';
      $('a_domain').value = entry.domain || '合成';
      $('a_level').value = entry.level || '核心';
      $('a_note').value = entry.note || '';
      editingVocabId = entry.id;
      $('addSubmit').value = '保存修改';
      $('addCancel').style.display = '';
      showTab('add');
      setStatus('addStatus', '正在修改词条，改完点“保存修改”。', '');
      return;
    }
    var delBtn = e.target.closest('.del-btn');
    if (!delBtn) return;
    var did = delBtn.getAttribute('data-id');
    if (!confirm('确认删除该词条？')) return;
    userData.vocab = userData.vocab.filter(function (x) { return String(x.id) !== String(did); });
    persistAndRender('删除词条', 'vocabList');
  });

  // 重置新增表单到“新增模式”
  function resetAddForm() {
    $('addForm').reset();
    $('a_level').value = '核心';
    editingVocabId = null;
    $('addSubmit').value = '保存到仓库';
    $('addCancel').style.display = 'none';
  }

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
      // 修改模式：按 id 替换原词条（不新增）
      var hit = false;
      userData.vocab = userData.vocab.map(function (x) {
        if (String(x.id) !== String(editingVocabId)) return x;
        hit = true;
        return Object.assign({}, x, {
          zh: zh, en: en,
          koRom: koRom || '需验证', koMean: koMean || '需验证',
          domain: $('a_domain').value, level: $('a_level').value, note: note,
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
      $('noteSubmit').value = '保存修改';
      $('noteCancel').style.display = '';
      showTab('notes');
      setStatus('noteStatus', '正在修改笔记，改完点“保存修改”。', '');
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
    $('noteSubmit').value = '保存笔记';
    $('noteCancel').style.display = 'none';
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
          updatedAt: new Date().toISOString()
        });
      });
      if (!hit) { setStatus('noteStatus', '未找到原笔记，已转为新增', 'err'); return; }
      persistAndRender('修改笔记: ' + title, 'noteStatus', resetNoteForm);
    } else {
      var note = {
        id: 'n' + Date.now(),
        title: title, cat: cat, body: body, tags: tags,
        addedAt: new Date().toISOString()
      };
      userData.notes.push(note);
      persistAndRender('新增笔记: ' + note.title, 'noteStatus', resetNoteForm);
    }
  });

  $('noteSearch').addEventListener('input', renderNotes);

  // ---------- 通用：提交 + 渲染 + 状态 ----------
  function persistAndRender(message, statusId, after) {
    commitUserData(message)
      .then(function () {
        localStorage.setItem(USERDATA_KEY, JSON.stringify(userData));
        setStatus(statusId, '已保存到仓库 ✓', 'ok');
        renderVocab(); renderNotes();
        if (after) after();
      })
      .catch(function (err) {
        // 写库失败时仍保留本地缓存，避免丢失
        localStorage.setItem(USERDATA_KEY, JSON.stringify(userData));
        setStatus(statusId, '保存失败：' + err.message + '（已存本地）', 'err');
        renderVocab(); renderNotes();
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
        localStorage.setItem(USERDATA_KEY, JSON.stringify(userData));
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
    // 先显示预设，保证离线可用
    renderVocab();
    renderNotes();
    // 再尝试从仓库拉取用户数据
    var s = loadSettings();
    if (s.owner && s.repo) {
      fetchUserData().then(function (data) {
        if (data) {
          userData.vocab = data.vocab || [];
          userData.notes = data.notes || [];
          localStorage.setItem(USERDATA_KEY, JSON.stringify(userData));
        }
        renderVocab(); renderNotes();
      }).catch(function () { /* 离线/未配置：仅用预设与本机缓存 */ });
    }
  }

  init();
})();
