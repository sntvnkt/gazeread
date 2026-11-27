/* GazeRead – четец с проследяване на погледа */
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const { syllabify, isCyrillic } = window.GazeSyllables;

  // ---------------- профил (в браузъра или в акаунта) ----------------
  const Profile = await window.GazeProfile.init();
  const store = { get: (k, d) => Profile.get(k, d), set: (k, v) => Profile.set(k, v) };
  const Adapt = window.GazeAdapt;

  const SAMPLE = `Дислексията не е болест и няма нищо общо с интелигентността. Тя е различен начин, по който мозъкът обработва буквите и звуците.

Много известни учени, художници и предприемачи имат дислексия. Те често виждат света по необикновен и творчески начин.

Когато четеш, понякога някоя дума изглежда объркана или прекалено дълга. Това е съвсем нормално. GazeRead забелязва, когато погледът ти се задържи, и ти помага: увеличава думата, разделя я на срички и я прочита на глас.

Опитай сега: погледни по-дълго думата „приключенски“ или „забележителност“ и виж какво ще се случи.`;

  // ---------------- елементи ----------------
  const area = $('readingArea');
  const dotEl = $('gazeDot');
  const rulerEl = $('ruler');
  const toastEl = $('toast');

  // ---------------- настройки ----------------
  const settings = Object.assign({
    dwell: 1.5, size: 26, spacing: 2.2, font: '"Lexend", sans-serif', rate: 0.8, voice: '',
    ruler: false, autoSpeak: false, dotOpacity: 45, showVideo: false, mouseMode: false, learnClicks: true, autoDwell: true, article: false, stay: 3, camId: '',
    gazeProvider: 'local',
  }, store.get('settings', {}));
  if (!['local', 'cloud'].includes(settings.gazeProvider)) settings.gazeProvider = 'local';
  const ARTICLE_SCALE = 0.73; // вид „статия“: 26 px → 19 px
  // старата стойност 15% беше прекалено бледа – вдигаме я веднъж
  if (!settings.v || settings.v < 2) { if (settings.dotOpacity < 45) settings.dotOpacity = 45; settings.v = 2; }
  const saveSettings = () => store.set('settings', settings);
  const fmt = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');

  function applySettings() {
    const r = document.documentElement.style;
    r.setProperty('--read-size', settings.size + 'px');
    r.setProperty('--read-line', settings.spacing);
    r.setProperty('--read-font', settings.font);
    $('dwellVal').textContent = fmt(settings.dwell) + ' с';
    $('stayVal').textContent = settings.stay ? fmt(settings.stay) + ' с + според думата' : 'докато натисна Shift';
    area.classList.toggle('article', !!settings.article);
    $('sizeVal').textContent = settings.article ? Math.round(settings.size * ARTICLE_SCALE) + ' px · статия' : settings.size + ' px';
    $('spacingVal').textContent = fmt(settings.spacing);
    $('rateVal').textContent = fmt(settings.rate) + '×';
    rulerEl.classList.toggle('on', settings.ruler && !!lastPoint);
    $('dotVal').textContent = settings.dotOpacity ? settings.dotOpacity + '%' : 'скрита';
    dotEl.style.opacity = settings.dotOpacity / 100;
    dotEl.classList.toggle('on', settings.dotOpacity > 0 && ['camera', 'cloud'].includes(tracking.mode) && !!lastPoint);
    $('camVideo').classList.toggle('show', settings.showVideo && tracking.mode === 'camera');
    $('gazeProvider').value = settings.gazeProvider;
    $('cloudPrivacy').hidden = settings.gazeProvider !== 'cloud';
    $('cloudConsentLabel').hidden = settings.gazeProvider !== 'cloud';
    $('cloudRegistration').hidden = settings.gazeProvider !== 'cloud';
    invalidateRects();
  }

  function bindRange(id, key, parse = parseFloat) {
    const el = $(id); el.value = settings[key];
    el.addEventListener('input', () => { settings[key] = parse(el.value); applySettings(); saveSettings(); });
  }
  function bindCheck(id, key, after) {
    const el = $(id); el.checked = !!settings[key];
    el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); applySettings(); after && after(); });
  }
  bindRange('dwell', 'dwell'); bindRange('stay', 'stay');bindRange('size', 'size', (v) => parseInt(v, 10));
  bindRange('spacing', 'spacing'); bindRange('rate', 'rate');
  $('font').value = settings.font;
  $('font').addEventListener('change', (e) => { settings.font = e.target.value; applySettings(); saveSettings(); });
  bindCheck('ruler', 'ruler'); bindCheck('autoSpeak', 'autoSpeak');
  bindRange('dotOpacity', 'dotOpacity', (v) => parseInt(v, 10)); bindCheck('showVideo', 'showVideo'); bindCheck('learnClicks', 'learnClicks'); bindCheck('autoDwell', 'autoDwell');
  bindCheck('article', 'article');
  bindCheck('mouseMode', 'mouseMode', () => { if (settings.mouseMode) startMouseMode(); else stopTracking(); });
  $('gazeProvider').addEventListener('change', () => {
    settings.gazeProvider = $('gazeProvider').value;
    if (tracking.active) stopTracking(true);
    setStatus('off', 'Изключено');
    saveSettings();
    applySettings();
  });

  // тема
  const savedTheme = store.get('theme', null);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $('themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', document.documentElement.dataset.theme);
  });

  function toast(msg, ms = 3200) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  // ---------------- текст ----------------
  let wordEls = [];
  let sentences = []; // масив от масиви с думи

  const cleanWord = (t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

  // думите от един ред текст → <span class="w">; поддържа **удебелен** и *наклонен* текст
  function appendWords(parent, text) {
    const parts = text.split(/(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/);
    for (const part of parts) {
      if (!part) continue;
      let target = parent, s = part;
      const m = /^(\*\*|__)(.+)\1$/.exec(part) || /^([*_])(.+)\1$/.exec(part);
      if (m) {
        target = document.createElement(m[1].length === 2 ? 'strong' : 'em');
        parent.appendChild(target); s = m[2];
      }
      for (const tok of s.split(/(\s+)/)) {
        if (!tok) continue;
        if (/^\s+$/.test(tok)) { target.appendChild(document.createTextNode(' ')); continue; }
        const clean = cleanWord(tok);
        if (!clean) { target.appendChild(document.createTextNode(tok)); continue; }
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = tok;
        span.dataset.tok = tok;
        span.dataset.word = clean;
        span.dataset.i = wordEls.length;
        span.dataset.s = sentences.length - 1;
        wordEls.push(span);
        sentences[sentences.length - 1].push(span);
        if (/[.!?…]["“”»)]*$/.test(tok)) sentences.push([]);
        target.appendChild(span);
      }
    }
    if (sentences[sentences.length - 1].length) sentences.push([]); // краят на реда/заглавието е край на изречение
  }

  // прост markdown: # заглавия, - списъци, 1. номерирани, > цитат, ![](картинка), всеки ред – абзац
  function parseBlocks(text) {
    const blocks = [];
    for (const raw of text.split('\n')) {
      const t = raw.trim();
      if (!t) continue;
      let m, last = blocks[blocks.length - 1];
      if ((m = /^(#{1,6})\s+(.+)$/.exec(t))) blocks.push({ type: 'h' + Math.min(m[1].length, 3), text: m[2].replace(/\s#+$/, '') });
      else if ((m = /^!\[([^\]]*)\]\((\S+?)\)$/.exec(t))) blocks.push({ type: 'img', alt: m[1], src: m[2] });
      else if ((m = /^[-*+•]\s+(.+)$/.exec(t))) {
        if (last && last.type === 'ul') last.items.push(m[1]); else blocks.push({ type: 'ul', items: [m[1]] });
      } else if ((m = /^(\d+)[.)]\s+(.+)$/.exec(t))) {
        if (last && last.type === 'ol') last.items.push(m[2]); else blocks.push({ type: 'ol', start: +m[1], items: [m[2]] });
      } else if ((m = /^>\s?(.*)$/.exec(t))) {
        if (!m[1].trim()) continue;
        if (last && last.type === 'quote') last.lines.push(m[1]); else blocks.push({ type: 'quote', lines: [m[1]] });
      } else blocks.push({ type: 'p', text: t });
    }
    return blocks;
  }

  const looksLikeArticle = (text) => /^(#{1,6}\s|[-*•]\s|\d+[.)]\s|>\s|!\[)/m.test(text || '');

  function renderText(text) {
    text = (text || '').replace(/\r/g, '').trim();
    area.innerHTML = '';
    wordEls = []; sentences = [[]];
    closeHelp();
    if (!text) { area.innerHTML = '<div class="empty">Няма текст за показване.</div>'; return; }
    for (const b of parseBlocks(text)) {
      if (b.type === 'img') {
        if (!/^https:\/\//i.test(b.src)) continue;
        const fig = document.createElement('figure');
        const img = document.createElement('img');
        img.src = b.src; img.alt = b.alt; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        img.addEventListener('load', invalidateRects);
        img.addEventListener('error', () => { fig.remove(); invalidateRects(); });
        fig.appendChild(img);
        area.appendChild(fig);
      } else if (b.type === 'ul' || b.type === 'ol') {
        const list = document.createElement(b.type);
        if (b.start && b.start !== 1) list.start = b.start;
        for (const it of b.items) { const li = document.createElement('li'); appendWords(li, it); list.appendChild(li); }
        area.appendChild(list);
      } else if (b.type === 'quote') {
        const q = document.createElement('blockquote');
        for (const l of b.lines) { const p = document.createElement('p'); appendWords(p, l); q.appendChild(p); }
        area.appendChild(q);
      } else {
        const el = document.createElement(b.type);
        appendWords(el, b.text);
        area.appendChild(el);
      }
    }
    sentences = sentences.filter((s) => s.length);
    // възстанови отбелязаните трудни думи
    for (const el of wordEls) if (hardWords.has(el.dataset.word.toLowerCase())) el.classList.add('hard');
    invalidateRects();
    store.set('text', text);
  }

  area.addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    if (!w) return;
    // кликът показва къде човекът гледа в момента → дообучаваме модела
    if (tracking.mode === 'camera' && settings.learnClicks && window.GazeEngine) {
      window.GazeEngine.addClick(e.clientX, e.clientY);
      lineState.line = null;
    }
    openHelp(w, 'click');
  });

  // табове
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $('tab-text').hidden = t.dataset.tab !== 'text';
    $('tab-url').hidden = t.dataset.tab !== 'url';
  }));

  $('readBtn').addEventListener('click', () => {
    renderText($('textIn').value);
    if (wordEls.length) area.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('sampleBtn').addEventListener('click', () => { $('textIn').value = SAMPLE; renderText(SAMPLE); });
  $('editBtn').addEventListener('click', () => { $('inputPanel').scrollIntoView({ behavior: 'smooth' }); $('textIn').focus(); });

  // ---------------- текст от сайт ----------------
  const JUNK_IMG = /logo|icon|avatar|sprite|pixel|badge|emoji|\.svg(\?|$)|^data:/i;

  // чисти markdown от r.jina.ai, но запазва заглавия, списъци, цитати и картинки
  function cleanMarkdown(md) {
    const title = (/^Title:\s*(.+)$/m.exec(md) || [])[1];
    const start = md.indexOf('Markdown Content:');
    if (start >= 0) md = md.slice(start + 'Markdown Content:'.length);
    const imgs = [];
    md = md.replace(/\r/g, '')
      .replace(/```[^\n]*\n?/g, '')
      // заглавия от вида „Текст\n=====“
      .replace(/^(.+)\n=+\s*$/gm, '# $1').replace(/^(.+)\n-{3,}\s*$/gm, '## $1')
      // редове, които са само връзки (менюта, навигация)
      .replace(/^\s*(?:[-*+]\s+)?(?:\[[^\]]*\]\([^)]*\)[\s|·•,/-]*)+$/gm, '')
      // картинки → на отделен ред
      .replace(/\[?!\[([^\]]*)\]\(([^)\s]+)[^)]*\)(?:\]\([^)]*\))?/g, (m, alt, src) => {
        if (JUNK_IMG.test(src)) return '';
        imgs.push(`![${alt.replace(/[[\]]/g, '')}](${src})`);
        return `\n\n\u0000${imgs.length - 1}\u0000\n\n`;
      })
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')          // връзки → текст
      .replace(/<[^>]+>/g, '')
      .replace(/`/g, '')
      .replace(/^\s*\|.*\|\s*$/gm, '')                  // таблици
      .replace(/^\s*([-*_]\s*){3,}$/gm, '')             // хоризонтални линии
      .replace(/^[ \t]+(?=[-*+]\s|\d+[.)]\s)/gm, '')     // вложени списъци → обикновени
      .replace(/\u0000(\d+)\u0000/g, (m, i) => imgs[+i])
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (title && !/^#\s/.test(md)) md = '# ' + title.trim() + '\n\n' + md;
    return md;
  }

  // HTML (от сайт или от копиран текст) → прост markdown със запазена структура
  function htmlToMarkdown(root, base) {
    const out = [];
    const SKIP = /^(SCRIPT|STYLE|NAV|HEADER|FOOTER|ASIDE|FORM|NOSCRIPT|BUTTON|SVG|IFRAME|SELECT|TEMPLATE)$/;
    const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,ul,ol,blockquote,pre,figure,figcaption,img,table,div,section,article,dl,dd,dt';
    const txt = (n) => n.textContent.replace(/\s+/g, ' ').trim();
    const abs = (s) => { try { return s ? new URL(s, base).href : ''; } catch (e) { return ''; } };
    const push = (s) => { if (s && s.replace(/[#\-\d.>\s]/g, '').length) out.push(s); };
    const pushImg = (img) => {
      const src = abs(img.getAttribute('src') || img.getAttribute('data-src'));
      if (/^https:/i.test(src) && !JUNK_IMG.test(src) && !(+img.getAttribute('width') > 0 && +img.getAttribute('width') < 60)) out.push(`![${(img.alt || '').replace(/[[\]]/g, '')}](${src})`);
    };
    const walk = (n) => {
      for (const c of n.children) {
        const t = c.tagName;
        if (SKIP.test(t) || c.hidden || c.getAttribute('aria-hidden') === 'true') continue;
        if (t === 'IMG') { pushImg(c); continue; }
        if (t === 'TABLE') continue;
        if (/^H[1-6]$/.test(t)) { push('#'.repeat(Math.min(+t[1], 3)) + ' ' + txt(c)); continue; }
        if (t === 'LI') {
          const ol = c.parentElement && c.parentElement.tagName === 'OL';
          const idx = [...c.parentElement.children].filter((x) => x.tagName === 'LI').indexOf(c) + 1;
          push((ol ? idx + '. ' : '- ') + txt(c)); continue;
        }
        if (t === 'BLOCKQUOTE') { push('> ' + txt(c)); continue; }
        if (/^(P|PRE|FIGCAPTION|DT|DD)$/.test(t) || !c.querySelector(BLOCKS)) {
          c.querySelectorAll && c.querySelectorAll('img').forEach(pushImg);
          const s = txt(c);
          if (s) push(/^(#|[-*+•]\s|\d+[.)]\s|>)/.test(s) ? '​' + s : s);
          continue;
        }
        walk(c);
      }
    };
    walk(root);
    return out.join('\n\n');
  }

  function htmlToText(html, base) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    return htmlToMarkdown(root, base);
  }

  // вид „статия“ – по-малък шрифт и подредба като на нормален сайт
  function setArticle(on, why) {
    if (!!settings.article === on) return;
    settings.article = on; $('article').checked = on;
    applySettings(); saveSettings();
    if (on && why) toast('📰 Показвам текста като статия. Можеш да го изключиш от „Настройки“.', 4500);
  }

  // при поставяне на копиран текст от сайт – запазваме заглавията, списъците и картинките
  $('textIn').addEventListener('paste', (e) => {
    const html = e.clipboardData && e.clipboardData.getData('text/html');
    if (!html) return;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const md = htmlToMarkdown(doc.body, location.href);
    if (!looksLikeArticle(md)) return; // обикновен текст – оставяме нормалното поставяне
    e.preventDefault();
    const ta = e.target;
    ta.setRangeText(md, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    setArticle(true, 'paste');
  });

  $('urlBtn').addEventListener('click', async () => {
    const err = $('urlErr'); err.textContent = '';
    let url = $('urlIn').value.trim();
    if (!url) { err.textContent = 'Въведи адрес на страница.'; return; }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch (e) { err.textContent = 'Адресът не изглежда правилен.'; return; }
    const btn = $('urlBtn'); btn.disabled = true; btn.textContent = '⏳ Зареждам…';
    let text = '';
    try {
      const r = await fetch('https://r.jina.ai/' + url, { headers: { 'X-Return-Format': 'markdown' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = cleanMarkdown(await r.text());
    } catch (e1) {
      try {
        const r = await fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(url));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        text = htmlToText(await r.text(), url);
      } catch (e2) { text = ''; }
    }
    btn.disabled = false; btn.textContent = '⬇️ Вземи текста';
    if (!text || text.length < 20) {
      err.textContent = 'Не успях да взема текста от този сайт. Отвори страницата, копирай текста и го постави в „Постави текст“.';
      return;
    }
    $('textIn').value = text;
    renderText(text);
    if (looksLikeArticle(text)) setArticle(true, 'url'); else toast('Текстът е зареден ✔');
    area.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---------------- трудни думи ----------------
  const hardWords = new Map(Object.entries(store.get('hard', {}))); // дума → брой
  Adapt.load(store.get('adapt', null), hardWords);
  const saveAdapt = () => store.set('adapt', Adapt.export());

  function renderHard() {
    const list = $('hardList');
    list.innerHTML = '';
    $('hardCount').textContent = hardWords.size ? `(${hardWords.size})` : '';
    if (!hardWords.size) { list.innerHTML = '<span class="hint">Тук ще се появят думите, на които си се задържал.</span>'; return; }
    [...hardWords.entries()].sort((a, b) => b[1] - a[1]).forEach(([w, n]) => {
      const c = document.createElement('button');
      c.className = 'chip'; c.textContent = n > 1 ? `${w} ×${n}` : w;
      c.title = syllabify(w).join(' · ');
      c.addEventListener('click', () => {
        const el = wordEls.find((x) => x.dataset.word.toLowerCase() === w);
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => openHelp(el, 'list'), 350); }
        else speak(w);
      });
      list.appendChild(c);
    });
  }
  function markHard(el) {
    const key = el.dataset.word.toLowerCase();
    hardWords.set(key, (hardWords.get(key) || 0) + 1);
    store.set('hard', Object.fromEntries(hardWords));
    wordEls.forEach((x) => { if (x.dataset.word.toLowerCase() === key) x.classList.add('hard'); });
    renderHard();
  }
  $('clearHard').addEventListener('click', () => {
    hardWords.clear(); store.set('hard', {});
    wordEls.forEach((x) => x.classList.remove('hard')); renderHard();
  });
  $('practiceBtn').addEventListener('click', async () => {
    const words = [...hardWords.keys()];
    if (!words.length) { toast('Още няма трудни думи.'); return; }
    stopSpeech();
    const tok = speechToken;
    for (const w of words) {
      if (tok.cancelled) break;
      await speak(w);
      await sleep(900);
    }
  });

  // ---------------- помощ направо в текста ----------------
  // Стъпка 1 (погледът се задържа): думата се увеличава на мястото си – нищо не се закрива.
  //   • Успя да я прочетеш → натисни Shift и тя се връща нормална.
  //   • Не успя → кликни върху нея: разделя се на срички и се чува цялата дума.
  let helpEl = null;
  const hintEl = $('wordHint');

  function showHint(html) { hintEl.innerHTML = html; hintEl.classList.add('show'); }
  function hideHint() { hintEl.classList.remove('show'); }

  function restoreWord(el) {
    el.classList.remove('zoom', 'syl', 'active');
    el.textContent = el.dataset.tok;
  }

  function showSyllables(el) {
    const tok = el.dataset.tok, word = el.dataset.word;
    const at = tok.indexOf(word);
    const pre = tok.slice(0, at), post = tok.slice(at + word.length);
    el.innerHTML = escapeHtml(pre)
      + syllabify(word).map((s) => `<span class="sy">${escapeHtml(s)}</span>`).join('<i class="sep">·</i>')
      + escapeHtml(post);
    el.classList.add('syl');
  }

  // информация за последното увеличаване от погледа – нужна, за да се учим от отговора
  let zoomInfo = null;

  function openHelp(el, reason) {
    if (helpEl && helpEl !== el) restoreWord(helpEl);
    const again = helpEl === el && el.classList.contains('syl');
    if (reason === 'gaze') {
      const r = el.getBoundingClientRect();      // мястото ПРЕДИ увеличаването – там е гледал човекът
      zoomInfo = { el, t: performance.now(), x: r.left + r.width / 2, y: r.top + r.height / 2, scrollY,
        dwellMs: Adapt.dwellFor(el.dataset.word, settings.dwell) * 1000, done: false };
      Adapt.state.zoomed++;
    }
    helpEl = el;
    el.classList.add('zoom', 'active');
    if (reason === 'gaze') {
      showHint('Прочете ли думата? <kbd>Shift</kbd> – да · <b>Кликни думата</b> – раздели я на срички');
      if (settings.autoSpeak) speak(el.dataset.word);
    } else {
      if (!again) { showSyllables(el); markHard(el); if (reason === 'click') learnOutcome(el, true); }
      stopSpeech();
      speak(el.dataset.word);
      showHint('<kbd>Shift</kbd> – готово · <b>Кликни пак</b> – чуй думата отново');
    }
    invalidateRects();
    scheduleAutoClose(el);
  }

  // ---- думата сама се връща в нормален размер след няколко секунди ----
  // време = настройката + повече за дълги думи + повече, ако е на срички;
  // докато човекът още гледа (или е с мишката) върху нея – чака.
  let autoClose = null; // { el, deadline, hardStop }
  function stayMsFor(el) {
    const len = (el.dataset.word || '').length;
    const syl = el.classList.contains('syl') ? syllabify(el.dataset.word).length : 0;
    return settings.stay * 1000 + Math.max(0, len - 4) * 250 + syl * 500;
  }
  function scheduleAutoClose(el) {
    if (!settings.stay) { autoClose = null; return; }
    const ms = stayMsFor(el), now = performance.now();
    autoClose = { el, deadline: now + ms, hardStop: now + ms * 3 };
  }
  function extendAutoClose(el) {
    if (!autoClose || autoClose.el !== el) return;
    autoClose.deadline = Math.min(autoClose.hardStop, Math.max(autoClose.deadline, performance.now() + 1200));
  }
  setInterval(() => {
    if (!autoClose) return;
    if (!helpEl || autoClose.el !== helpEl) { autoClose = null; return; }
    if (synth && synth.speaking) { extendAutoClose(helpEl); return; } // не прекъсваме гласа
    if (performance.now() >= autoClose.deadline) {
      cooldown.set(helpEl, performance.now());
      autoClose = null;
      closeHelp();
    }
  }, 200);
  area.addEventListener('mousemove', (e) => {
    if (helpEl && e.target.closest && e.target.closest('.w') === helpEl) extendAutoClose(helpEl);
  });

  /** Учене от отговора на човека: helped = кликна (трудна), иначе Shift (прочете я). */
  function learnOutcome(el, helped) {
    const z = zoomInfo && zoomInfo.el === el && !zoomInfo.done ? zoomInfo : null;
    if (z) z.done = true;
    Adapt.learn(el.dataset.word, helped);
    if (z && settings.autoDwell) {
      const nd = Adapt.tuneDwell(settings.dwell, helped, performance.now() - z.t);
      if (nd !== settings.dwell) { settings.dwell = nd; $('dwell').value = nd; applySettings(); saveSettings(); }
    }
    // погледът по време на задържането е бил върху думата → безплатна точка за калибриране
    if (z && tracking.mode === 'camera' && window.GazeEngine && Math.abs(scrollY - z.scrollY) < 2) {
      const since = performance.now() - z.t;
      if (window.GazeEngine.addLabel(z.x, z.y, since + 100, since + Math.max(400, z.dwellMs - 150), 1.2)) {
        if (window.GazeEngine.learned % 10 === 0) saveCalibration();
      }
    }
    saveAdapt();
    renderProfile();
  }

  function closeHelp() {
    if (helpEl) restoreWord(helpEl);
    helpEl = null; autoClose = null;
    hideHint();
    invalidateRects();
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input, textarea, select, dialog')) return;
    if ((e.key === 'Shift' || e.key === 'Escape') && helpEl) {
      if (tracking.mode) cooldown.set(helpEl, performance.now());
      if (e.key === 'Shift' && !helpEl.classList.contains('syl')) learnOutcome(helpEl, false);
      closeHelp();
    }
  });
  addEventListener('scroll', () => invalidateRects(), { passive: true });
  addEventListener('resize', () => invalidateRects());

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------- озвучаване ----------------
  const synth = window.speechSynthesis;
  let voices = [];
  let speechToken = { cancelled: false };
  function loadVoices() {
    if (!synth) { $('voiceHint').textContent = 'Този браузър не поддържа озвучаване.'; return; }
    voices = synth.getVoices();
    const sel = $('voice');
    const keep = settings.voice;
    sel.innerHTML = '<option value="">Автоматично</option>';
    voices.filter((v) => /^(bg|en)/i.test(v.lang)).concat(voices.filter((v) => !/^(bg|en)/i.test(v.lang)))
      .forEach((v) => { const o = document.createElement('option'); o.value = v.name; o.textContent = `${v.name} (${v.lang})`; sel.appendChild(o); });
    sel.value = keep;
    const hasBg = voices.some((v) => /^bg/i.test(v.lang));
    $('voiceHint').textContent = voices.length && !hasBg
      ? 'Няма български глас. Отвори сайта в Microsoft Edge или добави български глас в Windows (Настройки → Час и език → Говор).'
      : '';
  }
  if (synth) { loadVoices(); synth.addEventListener?.('voiceschanged', loadVoices); }
  $('voice').addEventListener('change', (e) => { settings.voice = e.target.value; saveSettings(); });

  function pickVoice(text) {
    if (settings.voice) { const v = voices.find((x) => x.name === settings.voice); if (v) return v; }
    const lang = isCyrillic(text) ? 'bg' : 'en';
    const list = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
    return list.find((v) => /natural|online|neural/i.test(v.name)) || list[0] || null;
  }

  function speak(text, { rate = settings.rate, onBoundary } = {}) {
    return new Promise((resolve) => {
      if (!synth) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice(text);
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = isCyrillic(text) ? 'bg-BG' : 'en-US';
      u.rate = rate;
      u.onend = u.onerror = () => resolve();
      if (onBoundary) u.onboundary = onBoundary;
      synth.speak(u);
    });
  }
  function stopSpeech() {
    speechToken.cancelled = true;
    speechToken = { cancelled: false };
    synth && synth.cancel();
    wordEls.forEach((w) => w.classList.remove('speaking'));
  }
  async function readSentences(from, to) {
    stopSpeech();
    const tok = speechToken;
    for (let s = from; s <= to && s < sentences.length; s++) {
      if (tok.cancelled) return;
      const ws = sentences[s];
      let text = '', offsets = [];
      ws.forEach((w) => { offsets.push(text.length); text += w.dataset.tok + ' '; });
      ws[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      let lit = null;
      const light = (el) => { if (lit) lit.classList.remove('speaking'); lit = el; el && el.classList.add('speaking'); };
      light(ws[0]);
      await speak(text, {
        onBoundary: (e) => {
          if (e.name && e.name !== 'word') return;
          let k = 0; while (k + 1 < offsets.length && offsets[k + 1] <= e.charIndex) k++;
          light(ws[k]);
        },
      });
      light(null);
    }
  }
  $('readAllBtn').addEventListener('click', () => { if (sentences.length) readSentences(0, sentences.length - 1); else toast('Първо постави текст.'); });
  $('stopBtn').addEventListener('click', stopSpeech);

  // ---------------- проследяване ----------------
  const tracking = { active: false, mode: null, calibrated: false, distanceChanged: false };
  let lastPoint = null;              // изгладена точка
  let rects = null;                  // кеш с позициите на думите
  const scores = new Map();          // натрупано време на поглед върху всяка дума
  const cooldown = new Map();        // кога последно е показана помощ за думата
  let lastFrame = 0;
  let watchingEl = null;
  let dotPos = null;

  let lines = null;                  // думите, групирани по редове
  const lineState = { line: null, pending: null, pendingT: 0 };
  const drift = { y: 0 };
  function invalidateRects() { rects = null; lines = null; }
  function getRects() {
    if (!rects) {
      rects = wordEls.map((el) => {
        const r = el.getBoundingClientRect();
        return { el, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top, bottom: r.bottom };
      }).filter((r) => r.bottom > -50 && r.top < innerHeight + 50);
    }
    return rects;
  }
  function getLines() {
    if (!lines) {
      lines = [];
      for (const r of getRects()) {
        let ln = lines.find((l) => Math.abs(l.y - r.y) < r.h * 0.5);
        if (!ln) { ln = { y: r.y, words: [] }; lines.push(ln); }
        ln.words.push(r);
      }
      lines.sort((a, b) => a.y - b.y);
      lines.forEach((l, i) => { l.i = i; });
    }
    return lines;
  }

  /**
   * Камерата е по-неточна по вертикала, затова първо „залепваме“ погледа за ред
   * (сменяме реда само ако погледът остане на новия ред известно време),
   * а после избираме най-близката дума в този ред.
   */
  function wordAtCamera(x, y0, dt) {
    const hit = document.elementFromPoint(x, y0);
    if (hit && (hit.closest('.side') || hit.closest('#calib') || hit.closest('.nav') || hit.closest('dialog'))) return null;
    const ls = getLines();
    if (!ls.length) return null;
    const pitch = ls.length > 1 ? (ls[ls.length - 1].y - ls[0].y) / (ls.length - 1) : 60;
    // корекция на „отплаването“: докато четеш, погледът е върху редовете,
    // затова бавно изваждаме средното вертикално отклонение от центъра на реда
    const y = y0 - drift.y;
    const res = wordAtLine(x, y, dt, ls, pitch);
    if (res && lineState.pending === null) {
      const lineY = res.line.y;
      drift.y += ((y0 - lineY) - drift.y) * Math.min(1, dt / 4);
      const lim = pitch * 0.45;
      drift.y = Math.max(-lim, Math.min(lim, drift.y));
    }
    return res ? res.el : null;
  }

  function wordAtLine(x, y, dt, ls, pitch) {
    let near = null, nd = Infinity;
    for (const l of ls) { const d = Math.abs(l.y - y); if (d < nd) { nd = d; near = l; } }
    if (nd > Math.max(pitch * 2.2, 90)) { lineState.pending = null; return null; } // гледа извън текста
    let cur = lineState.line && ls.find((l) => l.words[0].el === lineState.line);
    if (!cur) { cur = near; lineState.line = near.words[0].el; }
    else if (near !== cur) {
      const far = Math.abs(cur.y - y) > pitch * 1.6;
      if (lineState.pending === near) lineState.pendingT += dt; else { lineState.pending = near; lineState.pendingT = dt; }
      if (far || lineState.pendingT > 0.22) { cur = near; lineState.line = near.words[0].el; lineState.pending = null; }
    } else lineState.pending = null;
    let best = null, bd = Infinity;
    for (const r of cur.words) {
      const d = Math.max(0, Math.abs(x - r.x) - r.w / 2);
      if (d < bd) { bd = d; best = r.el; }
    }
    return bd <= 170 ? { el: best, line: cur } : null;
  }

  /** Намира думата най-близо до точката (погледът от камера е неточен). */
  function wordAt(x, y, radius) {
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit.closest('#wordHelp') || hit.closest('.side') || hit.closest('#calib') || hit.closest('.nav') || hit.closest('dialog'))) return null;
    if (hit && hit.classList && hit.classList.contains('w')) return hit;
    let best = null, bestD = Infinity;
    for (const r of getRects()) {
      const dx = Math.max(0, Math.abs(x - r.x) - r.w / 2);
      const dy = Math.max(0, Math.abs(y - r.y) - r.h / 2) * 1.6; // редът е по-важен
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = r.el; }
    }
    return bestD <= radius ? best : null;
  }

  function onGazePoint(x, y, smoothing) {
    if (x == null || y == null || !isFinite(x)) return;
    const now = performance.now();
    if (!lastPoint) lastPoint = { x, y };
    lastPoint.x += (x - lastPoint.x) * smoothing;
    lastPoint.y += (y - lastPoint.y) * smoothing;
    const dt = Math.min(0.2, lastFrame ? (now - lastFrame) / 1000 : 0);
    lastFrame = now;

    if (settings.dotOpacity > 0 && ['camera', 'cloud'].includes(tracking.mode)) {
      dotEl.classList.add('on');
      // „мъртва зона“: малките трептения на погледа не местят точката
      if (!dotPos || Math.hypot(lastPoint.x - dotPos.x, lastPoint.y - dotPos.y) > 35) {
        dotPos = { x: lastPoint.x, y: lastPoint.y };
        dotEl.style.left = dotPos.x + 'px'; dotEl.style.top = dotPos.y + 'px';
      }
    }

    const el = tracking.mode === 'camera'
      ? wordAtCamera(lastPoint.x, lastPoint.y, dt)
      : wordAt(lastPoint.x, lastPoint.y, tracking.mode === 'cloud' ? 100 : 4);

    // линия за четене
    if (settings.ruler && el) {
      const r = el.getBoundingClientRect(), pad = r.height * 0.35;
      rulerEl.style.top = (r.top - pad) + 'px'; rulerEl.style.height = (r.height + pad * 2) + 'px';
      rulerEl.classList.add('on');
    } else if (!settings.ruler) rulerEl.classList.remove('on');

    // натрупване и „изтичане“ на времето – устойчиво на трептене на погледа
    for (const [k, v] of scores) {
      const nv = k === el ? v : v - dt * 1.4;
      if (nv <= 0) scores.delete(k); else scores.set(k, nv);
    }
    // таван, за да не „помни“ стара дума твърде дълго, след като погледът се премести
    if (el) scores.set(el, Math.min(settings.dwell * 1.45, (scores.get(el) || 0) + dt));
    if (el && el === helpEl) extendAutoClose(el); // още я гледа – не я връщаме

    let top = null, topV = 0;
    for (const [k, v] of scores) if (v > topV) { topV = v; top = k; }
    if (watchingEl !== top) { watchingEl && watchingEl.classList.remove('watching'); watchingEl = top; }

    // личният модел решава колко дълго да чака за ТАЗИ дума
    if (top && top !== helpEl && topV >= Adapt.dwellFor(top.dataset.word, settings.dwell)) {
      const last = cooldown.get(top) || 0;
      if (now - last > 5000) {
        cooldown.set(top, now);
        top.classList.remove('watching');
        scores.clear();
        openHelp(top, 'gaze');
      }
    }
  }

  function setStatus(state, text) {
    const s = $('trackStatus');
    s.classList.toggle('on', state === 'on'); s.classList.toggle('busy', state === 'busy');
    $('trackText').textContent = text;
  }

  // --- мишка ---
  function onMouse(e) { onGazePoint(e.clientX, e.clientY, 1); }
  let mouseTimer = null;
  function startMouseMode() {
    stopTracking(true);
    tracking.active = true; tracking.mode = 'mouse';
    addEventListener('mousemove', onMouse);
    // таймер, за да се натрупва време и когато мишката стои неподвижно
    mouseTimer = setInterval(() => { if (lastPoint) onGazePoint(lastPoint.x, lastPoint.y, 1); }, 60);
    setStatus('on', 'Режим с мишка – задръж курсора върху дума');
    $('eyeBtn').textContent = 'Изключи';
    applySettings();
  }

  // --- камера (MediaPipe + собствен модел, виж js/gaze.js) ---
  const video = $('camVideo');
  const calib = $('calib');
  let engineBound = false;
  let gazeCloudScriptPromise = null;
  let cloudHadFace = false;

  function loadGazeCloudApi() {
    if (window.GazeCloudAPI) return Promise.resolve(window.GazeCloudAPI);
    if (gazeCloudScriptPromise) return gazeCloudScriptPromise;
    gazeCloudScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://api.gazerecorder.com/GazeCloudAPI.js';
      script.async = true;
      script.onload = () => {
        if (window.GazeCloudAPI) resolve(window.GazeCloudAPI);
        else {
          gazeCloudScriptPromise = null;
          reject(new Error('GazeCloudAPI did not initialize.'));
        }
      };
      script.onerror = () => {
        gazeCloudScriptPromise = null;
        reject(new Error('Could not load GazeCloudAPI.'));
      };
      document.head.appendChild(script);
    });
    return gazeCloudScriptPromise;
  }

  function bindGazeCloudCallbacks(api) {
    api.UseClickRecalibration = true;
    api.OnCalibrationComplete = () => {
      if (!tracking.active || tracking.mode !== 'cloud') return;
      tracking.cloudCalibrated = true;
      $('accuracyText').textContent = 'Калибрирането е завършено от GazeCloud.';
      setStatus('on', 'GazeCloud следи погледа');
    };
    api.OnResult = (data) => {
      if (!tracking.active || tracking.mode !== 'cloud' || !data) return;
      if (data.state !== 0) {
        if (data.state === -1) {
          cloudHadFace = false;
          if (watchingEl) watchingEl.classList.remove('watching');
          watchingEl = null;
          lastPoint = null;
          lineState.line = null;
          lastFrame = 0;
          scores.clear();
          setStatus('busy', 'GazeCloud не вижда лице');
        } else if (data.state === 1) {
          tracking.cloudCalibrated = false;
          setStatus('busy', 'Калибриране в GazeCloud…');
        }
        return;
      }
      if (!tracking.cloudCalibrated) return;
      if (!cloudHadFace) setStatus('on', 'GazeCloud следи погледа');
      cloudHadFace = true;
      const x = Number(data.docX) - scrollX;
      const y = Number(data.docY) - scrollY;
      if (Number.isFinite(x) && Number.isFinite(y)) onGazePoint(x, y, 0.6);
    };
    api.OnCamDenied = () => {
      if (tracking.mode !== 'cloud') return;
      stopTracking(true);
      setStatus('off', 'Няма разрешение за камерата');
      toast('Разреши достъпа до камерата за GazeRecorder и опитай отново.', 6000);
    };
    api.OnError = (msg) => {
      if (tracking.mode !== 'cloud') return;
      stopTracking(true);
      setStatus('off', 'Грешка в GazeCloud');
      toast('GazeCloud: ' + String(msg || 'възникна грешка'), 6000);
    };
  }

  async function startCloudTracking() {
    if (!window.isSecureContext) { toast('Камерата работи само през https:// или localhost.', 5000); return; }
    if (!$('cloudConsent').checked) {
      toast('Потвърди, че разбираш какви данни използва онлайн режимът.', 5000);
      $('cloudConsent').focus();
      return;
    }
    stopTracking(true);
    setStatus('busy', 'Зареждане на GazeCloud…');
    $('eyeBtn').disabled = true;
    try {
      const api = await loadGazeCloudApi();
      bindGazeCloudCallbacks(api);
      tracking.active = true;
      tracking.mode = 'cloud';
      tracking.cloudCalibrated = false;
      cloudHadFace = true;
      calib.classList.remove('show');
      $('eyeBtn').textContent = 'Изключи';
      $('recalBtn').disabled = false;
      $('testBtn').disabled = true;
      setStatus('busy', 'GazeCloud се свързва и калибрира…');
      applySettings();
      api.StartEyeTracking();
    } catch (e) {
      console.error(e);
      stopTracking(true);
      setStatus('off', 'Неуспешно стартиране на GazeCloud');
      toast('Не успях да стартирам GazeCloud. Провери интернет връзката и дали адресът на сайта е регистриран при GazeRecorder.', 7000);
    } finally {
      $('eyeBtn').disabled = false;
    }
  }

  function waitForEngine() {
    if (window.GazeEngine) return Promise.resolve(window.GazeEngine);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('engine')), 8000);
      addEventListener('gazeengine-ready', () => { clearTimeout(t); resolve(window.GazeEngine); }, { once: true });
    });
  }

  function setCheck(id, state, text) {
    const li = $(id);
    li.className = state;
    if (text) li.lastChild.textContent = ' ' + text;
  }

  function onEngineStatus(st) {
    tracking.distanceChanged = !!st.distanceChanged;
    if (!calib.classList.contains('show') || $('calibMsg').classList.contains('hidden')) return;
    const W = video.videoWidth || 1280;
    setCheck('chkFace', st.face ? 'ok' : 'bad', st.face ? 'Лицето се вижда' : 'Не виждам лице – погледни към камерата');
    if (st.face) {
      const r = st.eyeWidth / W;
      if (st.distanceRatio != null) {
        if (st.distanceChanged) setCheck('chkDist', 'mid', 'Позицията се промени – остани в това разстояние');
        else setCheck('chkDist', 'ok', 'Разстоянието е стабилно');
      } else if (r < 0.007) setCheck('chkDist', 'bad', 'Твърде далеч си – камерата едва вижда очите ти');
      else if (r < 0.012) setCheck('chkDist', 'mid', 'Далеч си – работи, но малко по-неточно (повече светлина помага)');
      else if (r > 0.18) setCheck('chkDist', 'bad', 'Лицето е твърде голямо – отдалечи се малко');
      else setCheck('chkDist', 'ok', 'Разстоянието е приемливо');
    } else setCheck('chkDist', '', 'Разстояние до екрана');
    if (st.brightness != null) {
      if (st.brightness < 12) setCheck('chkLight', 'bad', 'Картината е черна – камерата е закрита или е избрана грешна камера (виж „Камера“ вляво)');
      else if (st.brightness < 55) setCheck('chkLight', 'bad', 'Твърде тъмно – светни лампа пред себе си');
      else if (st.brightness < 85) setCheck('chkLight', 'mid', 'Малко тъмно – повече светлина ще помогне');
      else setCheck('chkLight', 'ok', 'Осветлението е добро');
    }
    $('calibStart').disabled = !st.face; $('quickStart').disabled = !st.face;
    $('camAdvice').textContent = st.face
      ? 'Сложи лицето си в овала и остани на едно стабилно разстояние от камерата. Не е нужно да седиш плътно до екрана.'
      : 'Седни срещу камерата, с лице към светлината.';
  }

  function onEngineGaze(x, y) {
    if (tracking.mode === 'camera' && !tracking.calibrating && !tracking.distanceChanged) onGazePoint(x, y, 0.6);
  }

  // ---- обяснение на проблемите с камерата (с конкретни стъпки) ----
  const isEdge = /Edg\//.test(navigator.userAgent);
  const flagsUrl = (isEdge ? 'edge' : 'chrome') + '://flags/#unsafely-treat-insecure-origin-as-secure';
  function cameraProblem(e) {
    const name = (e && e.name) || (e && e.message) || 'Error';
    const o = location.origin;
    if (e === 'insecure') return ['Браузърът спира камерата на този адрес', `
      <p>Сайтът е отворен на <code>${escapeHtml(o)}</code>. Браузърите пускат камерата само на адрес с <b>https://</b> или на <b>localhost</b>.</p>
      <ol>
        <li><b>Най-лесно:</b> копирай папката GazeRead на този лаптоп, пусни <code>node server.js</code> и отвори <code>http://localhost:8080/reader.html</code>.</li>
        <li><b>Или</b> в адресната лента отвори <code>${flagsUrl}</code>, впиши <code>${escapeHtml(o)}</code>, избери <b>Enabled</b> и рестартирай браузъра.</li>
        <li><b>Или</b> качи сайта на хостинг с https://.</li>
      </ol>`];
    if (e === 'nobrowser') return ['Този браузър няма достъп до камера', '<p>Отвори GazeRead в <b>Google Chrome</b> или <b>Microsoft Edge</b> (последна версия).</p>'];
    if (e && e.stage === 'model') return ['Не успях да заредя проследяването', `
      <p>Камерата работи, но моделът за разпознаване на лице не се зареди. Първия път той се изтегля от интернет.</p>
      <ol>
        <li>Провери дали има интернет.</li>
        <li>Изключи блокера на реклами (AdBlock, uBlock) за този сайт – понякога спира <code>cdn.jsdelivr.net</code> и <code>storage.googleapis.com</code>.</li>
        <li>В училищна или фирмена мрежа тези адреси може да са забранени – опитай през друга мрежа (напр. от телефона).</li>
      </ol>`];
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return ['Няма разрешение за камерата', `
      <ol>
        <li>Кликни иконата <b>🔒 / камера</b> вляво от адреса → <b>Камера → Разреши</b> и презареди страницата.</li>
        <li>В Windows: <b>Настройки → Поверителност и защита → Камера</b> – включи „Достъп до камерата“ и „Разреши на приложенията да имат достъп“ (и за настолни приложения).</li>
        <li>Някои лаптопи имат <b>капаче</b> пред камерата или <b>клавиш</b> за изключването ѝ (иконата с камера на F-клавишите).</li>
      </ol>`];
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return ['Камерата е заета или не може да се включи', `
      <ol>
        <li>Затвори програмите, които може да ползват камерата: <b>Zoom, Teams, Skype, Discord, „Камера“</b>, други раздели с видео.</li>
        <li>Ако лаптопът има няколко камери, избери друга от „Камера“ в лентата вляво.</li>
        <li>Затвори изцяло браузъра и го отвори пак. Ако не помогне – рестартирай компютъра.</li>
      </ol>`];
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return ['Не е намерена камера', `
      <ol>
        <li>Провери дали камерата не е изключена с клавиш или капаче.</li>
        <li>Ако е външна камера – включи я в друг USB порт.</li>
        <li>В Windows отвори приложението <b>„Камера“</b> – ако и там не работи, проблемът е в драйвера.</li>
      </ol>`];
    if (e && e.message === 'engine') return ['Страницата не се зареди докрай', '<p>Презареди страницата (Ctrl+F5) и опитай пак. Провери дали има интернет.</p>'];
    return ['Камерата не тръгна', `
      <ol>
        <li>Презареди страницата и опитай пак.</li>
        <li>Използвай Chrome или Edge и провери дали камерата работи в приложението „Камера“ на Windows.</li>
        <li>Ако проблемът остане, изпрати ми кода по-долу.</li>
      </ol>`];
  }
  function showCameraProblem(e) {
    const [title, body] = cameraProblem(e);
    $('camErrTitle').textContent = '📷 ' + title;
    $('camErrBody').innerHTML = body;
    const code = typeof e === 'string' ? e : `${(e && e.name) || 'Error'}${e && e.stage ? ' [' + e.stage + ']' : ''}: ${(e && e.message) || ''}`;
    $('camErrCode').textContent = 'Код на грешката: ' + code + ' · ' + location.origin;
    const d = $('camErr');
    if (!d.open) d.showModal();
  }
  $('camErrClose').addEventListener('click', () => $('camErr').close());
  $('camErrRetry').addEventListener('click', () => { $('camErr').close(); startCamera(); });
  $('camErrMouse').addEventListener('click', () => { $('camErr').close(); settings.mouseMode = true; $('mouseMode').checked = true; saveSettings(); startMouseMode(); });

  // избор на камера (лаптопите с Windows Hello имат и инфрачервена камера, която дава черна картина)
  async function fillCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let cams = [];
    try { cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch (e) { return; }
    const sel = $('camSelect');
    sel.innerHTML = '<option value="">Автоматично</option>' + cams.map((c, i) =>
      `<option value="${escapeHtml(c.deviceId)}">${escapeHtml(c.label || 'Камера ' + (i + 1))}</option>`).join('');
    sel.value = cams.some((c) => c.deviceId === settings.camId) ? settings.camId : '';
    $('camField').hidden = cams.length < 2;
  }
  $('camSelect').addEventListener('change', (e) => {
    settings.camId = e.target.value; saveSettings();
    if (tracking.mode === 'camera') startCamera();
  });
  fillCameras();

  async function startCamera() {
    if (settings.gazeProvider === 'cloud') return startCloudTracking();
    if (!window.isSecureContext) { showCameraProblem('insecure'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showCameraProblem('nobrowser'); return; }
    stopTracking(true);
    setStatus('busy', 'Стартиране на камерата…');
    $('eyeBtn').disabled = true;
    let engine;
    try {
      engine = await waitForEngine();
      if (!engineBound) { engine.on('status', onEngineStatus); engine.on('gaze', onEngineGaze); engineBound = true; }
      // запазено калибриране от предишни сесии → само бърза проверка вместо пълно калибриране
      if (!engine.model) engine.importData(store.get('calib', null));
      showFaceCheck();
      await engine.start(video, settings.camId || undefined);
      fillCameras(); // след разрешението вече се виждат имената на камерите
      tracking.active = true; tracking.mode = 'camera';
      $('eyeBtn').textContent = 'Изключи';
      $('recalBtn').disabled = false;
      $('testBtn').disabled = !engine.model;
      setStatus(engine.model ? 'on' : 'busy', engine.model ? 'Камерата следи погледа' : 'Нужно е калибриране');
      applySettings();
    } catch (e) {
      console.error(e);
      calib.classList.remove('show');
      if (engine) engine.stop();
      setStatus('off', cameraProblem(e)[0]);
      showCameraProblem(e);
    } finally {
      $('eyeBtn').disabled = false;
    }
  }

  function placeVideo(inCalib) {
    if (inCalib) $('camSlot').appendChild(video);
    else if (video.parentNode !== document.body) document.body.appendChild(video);
    video.play && video.play().catch(() => {});
  }

  function showFaceCheck() {
    calib.classList.add('show');
    $('calibMsg').classList.remove('hidden');
    $('calibResult').classList.add('hidden');
    $('calibDot').className = '';
    $('calibProgress').textContent = '';
    const hasModel = !!(window.GazeEngine && window.GazeEngine.model);
    $('quickStart').hidden = !hasModel;
    $('calibStart').classList.toggle('ghost', hasModel);
    $('quickNote').hidden = !hasModel;
    const face = !!(window.GazeEngine && window.GazeEngine.status.face);
    $('calibStart').disabled = !face; $('quickStart').disabled = !face;
    placeVideo(true);
  }

  /** Запазва калибрирането (и наученото докато четеш) в профила. */
  function saveCalibration() {
    if (!window.GazeEngine || !window.GazeEngine.model) return;
    store.set('calib', window.GazeEngine.exportData());
    renderProfile();
  }

  function closeCalib() {
    tracking.calibrating = false;
    calib.classList.remove('show');
    $('calibDot').className = '';
    placeVideo(false);
    applySettings();
  }

  function stopTracking(silent) {
    const previousMode = tracking.mode;
    tracking.active = false; tracking.mode = null; tracking.calibrating = false;
    if (previousMode === 'camera' && window.GazeEngine) window.GazeEngine.stop();
    if (previousMode === 'cloud' && window.GazeCloudAPI) {
      try { window.GazeCloudAPI.StopEyeTracking(); }
      catch (e) { console.error(e); toast('Не успях да спра GazeCloud коректно.', 5000); }
      window.GazeCloudAPI.OnResult = null;
      window.GazeCloudAPI.OnCalibrationComplete = null;
      window.GazeCloudAPI.OnCamDenied = null;
      window.GazeCloudAPI.OnError = null;
    }
    removeEventListener('mousemove', onMouse);
    clearInterval(mouseTimer);
    tracking.cloudCalibrated = false;
    cloudHadFace = false;
    tracking.distanceChanged = false;
    if (window.GazeEngine) window.GazeEngine.clearDistanceReference();
    calib.classList.remove('show');
    lastPoint = null; dotPos = null; lastFrame = 0; scores.clear(); lineState.line = null;
    if (watchingEl) watchingEl.classList.remove('watching');
    dotEl.classList.remove('on'); rulerEl.classList.remove('on');
    $('recalBtn').disabled = true; $('testBtn').disabled = true;
    $('eyeBtn').textContent = 'Включи проследяване';
    applySettings();
    if (!silent) { setStatus('off', 'Изключено'); $('mouseMode').checked = settings.mouseMode = false; saveSettings(); }
  }

  $('eyeBtn').addEventListener('click', () => {
    if (tracking.active) { stopTracking(); return; }
    if (settings.mouseMode) startMouseMode(); else startCamera();
  });
  $('recalBtn').addEventListener('click', () => {
    if (tracking.mode === 'camera') showFaceCheck();
    else if (tracking.mode === 'cloud' && window.GazeCloudAPI) {
      tracking.cloudCalibrated = false;
      cloudHadFace = true;
      setStatus('busy', 'GazeCloud калибрира отново…');
      try { window.GazeCloudAPI.RestartEyeTracking(); }
      catch (e) { console.error(e); toast('Не успях да стартирам повторно калибриране в GazeCloud.', 6000); }
    }
  });
  $('testBtn').addEventListener('click', () => { if (tracking.mode === 'camera') runSequence(true); });
  $('calibCancel').addEventListener('click', () => { closeCalib(); if (!window.GazeEngine.model) stopTracking(); });
  $('calibStart').addEventListener('click', () => runSequence(false));
  $('quickStart').addEventListener('click', () => runSequence(true));
  $('resOk').addEventListener('click', closeCalib);
  $('resRetry').addEventListener('click', showFaceCheck);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tracking.calibrating) { tracking.cancelCalib = true; } });

  // --- калибриране и тест на точността ---
  const CALIB_POINTS = [
    [50, 50], [8, 8], [50, 8], [92, 8], [92, 50], [92, 92], [50, 92], [8, 92], [8, 50],
    [29, 29], [71, 29], [71, 71], [29, 71],
  ];
  const TEST_POINTS = [[50, 35], [25, 22], [75, 22], [25, 78], [75, 78], [50, 65]];

  async function showDotAt(px, py, cls) {
    const dot = $('calibDot');
    dot.className = 'show ' + (cls || '');
    dot.style.left = px + 'px'; dot.style.top = py + 'px';
    await sleep(650);                 // време очите да стигнат до точката
  }

  async function runSequence(testOnly) {
    const engine = window.GazeEngine;
    tracking.calibrating = true; tracking.cancelCalib = false;
    engine.clearDistanceReference();
    calib.classList.add('show');
    $('calibMsg').classList.add('hidden');
    $('calibResult').classList.add('hidden');
    placeVideo(false);
    closeHelp();
    const dot = $('calibDot');
    const prog = $('calibProgress');
    const W = innerWidth, H = innerHeight;
    await sleep(700);
    engine.setDistanceReference();

    if (!testOnly) {
      engine.clear();
      for (let i = 0; i < CALIB_POINTS.length; i++) {
        if (tracking.cancelCalib) return closeCalib();
        const [px, py] = [CALIB_POINTS[i][0] / 100 * W, CALIB_POINTS[i][1] / 100 * H];
        prog.textContent = `Гледай точката · ${i + 1} от ${CALIB_POINTS.length} · Esc за отказ`;
        let got = 0;
        for (let attempt = 0; attempt < 3 && got < 10; attempt++) {
          await showDotAt(px, py);
          dot.style.setProperty('--collect-ms', '1300ms');
          dot.classList.add('collect');
          const feats = await engine.collect(1300);
          dot.classList.remove('collect');
          got += engine.addPoint(feats, px, py, 'p' + i);
          if (got < 10) prog.textContent = 'Не виждам очите ти добре – погледни точката отново';
        }
      }
      engine.fit(true);
      if (!engine.model) {
        dot.className = '';
        return showResult('Калибрирането не успя', 'Камерата не видя очите ти достатъчно добре. Провери светлината и опитай пак.', false);
      }
    }

    // при бърза проверка старите данни тежат по-малко от новите (главата може да е на друго място)
    if (testOnly) engine.ageSamples(0.7);

    // тест: точки, които моделът не е виждал
    const errs = [];
    for (let i = 0; i < TEST_POINTS.length; i++) {
      if (tracking.cancelCalib) return closeCalib();
      const [px, py] = [TEST_POINTS[i][0] / 100 * W, TEST_POINTS[i][1] / 100 * H];
      prog.textContent = `Проверка на точността · ${i + 1} от ${TEST_POINTS.length}`;
      await showDotAt(px, py, 'test');
      dot.style.setProperty('--collect-ms', '1000ms');
      dot.classList.add('collect');
      const feats = await engine.collect(1000);
      dot.classList.remove('collect');
      const p = engine.predictMany(feats);
      if (p) errs.push({ dx: Math.abs(p[0] - px), dy: Math.abs(p[1] - py) });
      engine.addPoint(feats, px, py, 't' + Date.now() + i);   // тестовите точки също обучават
    }
    engine.fit(true);
    engine.resetFilter();
    dot.className = ''; prog.textContent = '';
    if (!errs.length) return showResult('Не виждам очите ти', 'Провери светлината и опитай пак.', false);

    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    const ex = Math.round(med(errs.map((e) => e.dx))), ey = Math.round(med(errs.map((e) => e.dy)));
    const err = Math.round(Math.hypot(ex, ey));
    const quality = err < 90 ? 'отлична' : err < 150 ? 'добра' : err < 230 ? 'средна' : 'слаба';
    let text = `Средно отклонение: около ${err} px (хоризонтално ${ex}, вертикално ${ey}).`;

    // по-голям шрифт = по-големи цели за погледа
    const pitch = settings.size * settings.spacing;
    const need = Math.min(44, Math.ceil((ey * 1.1) / settings.spacing));
    if (pitch < ey * 1.1 && need > settings.size) {
      settings.size = need; $('size').value = need; saveSettings(); applySettings();
      text += ` Увеличих текста до ${need} px, за да може системата по-лесно да разпознава реда.`;
    }
    if (quality === 'слаба' || quality === 'средна') {
      text += ' Съвети: светлина пред лицето, остани на едно стабилно разстояние и не мърдай главата. Кликай върху думите – всеки клик учи системата.';
      if (testOnly) text += ' Ако е много неточно, натисни „Калибрирай отново“ за пълно калибриране.';
    }
    if (testOnly) {
      // корекция на постоянно отклонение спрямо запазения модел вече е в данните – запазваме
      text = 'Използвах запазеното ти калибриране. ' + text;
    }
    Adapt.addAccuracy(err); saveAdapt();
    saveCalibration();
    $('accuracyText').textContent = `Точност: ${quality} (~${err} px)`;
    $('testBtn').disabled = false;
    setStatus('on', 'Камерата следи погледа');
    showResult(`Точност: ${quality}`, text, true);
  }

  function showResult(title, text, ok) {
    tracking.calibrating = false;
    $('resTitle').textContent = title;
    $('resText').textContent = text;
    $('resOk').hidden = !ok;
    $('calibResult').classList.remove('hidden');
    $('calibMsg').classList.add('hidden');
  }

  addEventListener('beforeunload', () => {
    if (window.GazeEngine && window.GazeEngine.model && window.GazeEngine.learned) saveCalibration();
    if (window.GazeEngine) window.GazeEngine.stop();
  });

  // ---------------- акаунт и профил ----------------
  const accDlg = $('accountDlg');
  let accMode = 'login';
  function renderAccount() {
    $('accountBtn').textContent = Profile.user ? '👤 ' + Profile.user.username : '👤 Вход';
    $('accIn').hidden = !!Profile.user;
    $('accOut').hidden = !Profile.user;
    if (Profile.user) $('accName').textContent = Profile.user.username;
    $('accNoServer').hidden = Profile.serverAvailable;
    $('accForm').hidden = !Profile.serverAvailable;
  }
  function setAccMode(m) {
    accMode = m;
    document.querySelectorAll('[data-acc]').forEach((b) => b.classList.toggle('active', b.dataset.acc === m));
    $('accSubmit').textContent = m === 'login' ? 'Влез' : 'Създай акаунт';
    $('accPass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('accErr').textContent = '';
  }
  document.querySelectorAll('[data-acc]').forEach((b) => b.addEventListener('click', () => setAccMode(b.dataset.acc)));
  $('accountBtn').addEventListener('click', () => { renderAccount(); setAccMode(accMode); accDlg.showModal(); });
  $('accClose').addEventListener('click', () => accDlg.close());
  $('accForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = $('accUser').value.trim(), p = $('accPass').value;
    $('accSubmit').disabled = true; $('accErr').textContent = '';
    try {
      if (accMode === 'login') await Profile.login(u, p); else await Profile.register(u, p);
      location.reload();             // зарежда настройките и калибрирането от акаунта
    } catch (err) { $('accErr').textContent = err.message; }
    finally { $('accSubmit').disabled = false; }
  });
  $('accLogout').addEventListener('click', async () => { await Profile.logout(); location.reload(); });
  $('accDelete').addEventListener('click', async () => {
    if (!confirm('Сигурен ли си? Акаунтът и всичко запазено в него ще бъдат изтрити завинаги.')) return;
    try { await Profile.deleteAccount(); location.reload(); } catch (err) { $('accErr').textContent = err.message; }
  });

  function renderProfile() {
    const c = store.get('calib', null);
    const st = Adapt.state;
    const acc = st.accuracy.length ? st.accuracy[st.accuracy.length - 1].px : null;
    const learned = c ? new Set(c.samples.map((s) => s[4]).filter((g) => /live/.test(g))).size : 0;
    const rows = [];
    rows.push(`<li><b>Калибриране:</b> ${c ? 'запазено (' + new Date(c.saved).toLocaleDateString('bg-BG') + ')' : 'няма запазено'}</li>`);
    if (acc != null) rows.push(`<li><b>Последна точност:</b> ~${acc} px</li>`);
    if (st.accuracy.length > 1) {
      const first = st.accuracy[0].px;
      if (acc < first) rows.push(`<li>Точността се подобри от ~${first} до ~${acc} px 📈</li>`);
    }
    rows.push(`<li><b>Научени точки от четенето:</b> ${learned}</li>`);
    rows.push(`<li><b>Увеличени думи:</b> ${st.zoomed} · прочетени сам/а: ${st.readOk} · с помощ: ${st.helped}</li>`);
    rows.push(`<li><b>Време за задържане:</b> ${fmt(settings.dwell)} с${settings.autoDwell ? ' (нагласява се само)' : ''}</li>`);
    $('profileStats').innerHTML = rows.join('');
    $('profileAi').innerHTML = Adapt.insights().map((t) => `<li>${escapeHtml(t)}</li>`).join('');
    $('profileWho').textContent = Profile.user
      ? `Запазва се в акаунта „${Profile.user.username}“ – работи на всеки компютър.`
      : 'Запазва се само в този браузър. Влез в акаунт, за да го имаш навсякъде.';
  }
  $('forgetCalib').addEventListener('click', () => {
    if (!confirm('Да изтрия ли запазеното калибриране? Следващия път ще трябва пълно калибриране.')) return;
    store.set('calib', null);
    if (window.GazeEngine) window.GazeEngine.clear();
    renderProfile(); toast('Калибрирането е изтрито.');
  });
  $('resetAi').addEventListener('click', () => {
    if (!confirm('Да започне ли личният модел да се учи отначало?')) return;
    Adapt.load(null, hardWords); saveAdapt(); renderProfile(); toast('Личният модел започва отначало.');
  });

  // ---------------- старт ----------------
  applySettings();
  renderHard();
  renderAccount();
  renderProfile();
  if (location.hash === '#account') { setAccMode(accMode); accDlg.showModal(); history.replaceState(null, '', location.pathname); }
  const saved = store.get('text', '');
  $('textIn').value = saved || SAMPLE;
  renderText(saved || SAMPLE);
  if (settings.mouseMode) startMouseMode();
})();
