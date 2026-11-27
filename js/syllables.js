/*
 * GazeRead – разделяне на срички
 *
 * Български: всяка сричка има точно една гласна (о·ко, я·бъл·ка). Когато между две гласни има
 * две или повече съгласни, границата се избира по официалните правила за пренасяне на ИБЕ
 * (шаблоните hyph-bg в js/vendor): поне една съгласна остава отляво и поне една отдясно
 * (сес·тра, не се·стра; кос·ка, из·вест·ни, раз·де·ля). Ако шаблоните позволяват няколко места,
 * избираме това, при което следващата сричка започва с естествена за българския група съгласни.
 * Ако шаблоните не са заредени, се използват по-простите правила по-долу.
 *
 * Английски: опростени правила.
 */
(function (global) {
  const BG_VOWELS = 'аъоуеияюѝэ';
  const BG_SONORANTS = 'йрлмн';

  // ---------- официални шаблони за пренасяне (ако са заредени) ----------
  let hyphenateBg = null;
  try {
    if (global.createHyphenator && global.hyphenationPatternsBg) {
      hyphenateBg = global.createHyphenator(global.hyphenationPatternsBg, { hyphenChar: '­', minWordLength: 2 });
    }
  } catch (e) { hyphenateBg = null; }

  /** Позициите в думата, на които правописът позволява пренасяне. */
  function allowedBreaks(w) {
    const set = new Set();
    if (!hyphenateBg) return set;
    let parts;
    try { parts = hyphenateBg(w).split('­'); } catch (e) { return set; }
    let p = 0;
    for (let i = 0; i < parts.length - 1; i++) { p += parts[i].length; set.add(p); }
    return set;
  }

  // групи от две съгласни, с които започват български думи (бл, гр, ст, зд, вк…)
  const BG_ONSETS = new Set(('бл бр вг вд вж вз вк вл вм вн вп вр вс вт вх вц вч вш вщ гл гн гр дв дл дн др дж жд жл жн жр ' +
    'зб зв зг зд зл зм зн зр кв кл кн кр кс кт мл мн мр пл пн пр пс пт пч пш св сг ск сл см сн сп ср ст сф сх сц сч ' +
    'тв тк тл тм тр фл фр хв хл хм хр цв цр чв чл чр шв шк шл шм шп шт шр щр').split(' '));
  /** Дали групата съгласни звучи естествено в началото на сричка. */
  function naturalOnset(c) {
    if (c.endsWith('ь')) c = c.slice(0, -1);
    if (c.length <= 1) return true;
    if (c.length > 3) return false;
    for (let i = 0; i + 1 < c.length; i++) if (!BG_ONSETS.has(c.slice(i, i + 2))) return false;
    return true;
  }
  const EN_VOWELS = 'aeiouy';
  const EN_DIGRAPHS = ['ch', 'sh', 'th', 'ph', 'wh', 'gh', 'ck', 'qu'];

  const isCyrillic = (s) => /[Ѐ-ӿ]/.test(s);

  /** Връща масив от срички, като пази оригиналния регистър. */
  function syllabify(word) {
    if (!word) return [];
    // думи с тире – всяка част отделно
    if (word.includes('-')) {
      return word.split('-').flatMap((p, i, arr) => {
        const s = syllabify(p);
        if (i < arr.length - 1 && s.length) s[s.length - 1] += '-';
        return s;
      });
    }
    const cuts = isCyrillic(word) ? cutsBg(word.toLowerCase()) : cutsEn(word.toLowerCase());
    const out = [];
    let prev = 0;
    for (const c of cuts) { out.push(word.slice(prev, c)); prev = c; }
    out.push(word.slice(prev));
    return out.filter(Boolean);
  }

  // ---------- български ----------
  // дали две съгласни звучат естествено в началото на сричка (кл, тр, ст, зд…)
  const goodOnset = (c) => c.length < 2 || 'рлвй'.includes(c[1]) || 'сзшж'.includes(c[0]);

  /** Срички по официалните правила (нужни са шаблоните hyph-bg). */
  function cutsBgOfficial(w) {
    const vowels = [];
    for (let i = 0; i < w.length; i++) if (BG_VOWELS.includes(w[i])) vowels.push(i);
    if (vowels.length < 2) return [];
    const ok = allowedBreaks(w);
    const cuts = [];
    for (let k = 0; k < vowels.length - 1; k++) {
      const a = vowels[k], b = vowels[k + 1];
      const n = b - a - 1;                        // съгласни между двете гласни
      if (n === 0) { cuts.push(b); continue; }    // по·е·зи·я
      if (n === 1) { cuts.push(a + 1); continue; } // ви·со·чи·на
      // 2+ съгласни: поне една отляво и поне една отдясно; „ь“ не се отделя от съгласната пред него
      const cands = [];
      for (let c = a + 2; c <= b - 1; c++) if (w[c] !== 'ь') cands.push(c);
      if (!cands.length) { cuts.push(a + 1); continue; } // шо·фьор, ка·мьон
      // предимство: място, позволено от правописа; после – естествено начало на следващата сричка;
      // при равенство – по-лявото (сес·тра пред сест·ра)
      let best = cands[0], bestScore = -1;
      for (const c of cands) {
        const s = (ok.has(c) ? 2 : 0) + (naturalOnset(w.slice(c, b)) ? 1 : 0);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      cuts.push(best);
    }
    return cuts;
  }

  function cutsBg(w) {
    if (hyphenateBg) return cutsBgOfficial(w);
    const vowels = [];
    for (let i = 0; i < w.length; i++) if (BG_VOWELS.includes(w[i])) vowels.push(i);
    if (vowels.length < 2) return [];
    const cuts = [];
    for (let k = 0; k < vowels.length - 1; k++) {
      const a = vowels[k], b = vowels[k + 1];
      const n = b - a - 1;               // съгласни между двете гласни
      let cut;
      if (n === 0) cut = b;               // ге-ро-и
      else if (n === 1) cut = a + 1;      // кни-га
      else {
        const cluster = w.slice(a + 1, b);
        if (cluster.endsWith('ь')) {      // шо-фьор, ка-мьон
          cut = b - 2;
          if (cut <= a) cut = a + 1;
        } else if (/(.)\1/.test(cluster)) {
          cut = a + 1 + cluster.search(/(.)\1/) + 1; // Ан-на, ност-та
        } else if (n === 2) {
          // при-клю, ко-ска, но от-го, лек-си, мом-че, кар-та
          cut = !BG_SONORANTS.includes(cluster[0]) && goodOnset(cluster) ? a + 1 : a + 2;
        } else if (BG_SONORANTS.includes(cluster[0])) {
          cut = goodOnset(cluster.slice(1)) ? a + 2 : a + 3; // кон-трол, гент-ност
        } else if (!'сзшж'.includes(cluster[0]) && goodOnset(cluster.slice(1, 3))) {
          cut = a + 2;                    // пред-при, худ-жни…
        } else {
          cut = a + 1;                    // се-стра
        }
      }
      cuts.push(cut);
    }
    return cuts;
  }

  // ---------- английски ----------
  function cutsEn(w) {
    // групи гласни като ядра на срички
    const isV = (i) => {
      const ch = w[i];
      if (ch === 'y') return i > 0 && !EN_VOWELS.includes(w[i - 1]); // y в началото е съгласна
      if (ch === 'u' && i > 0 && w[i - 1] === 'q') return false;      // qu
      return EN_VOWELS.includes(ch);
    };
    const groups = [];
    for (let i = 0; i < w.length; i++) {
      if (isV(i)) {
        const start = i;
        while (i + 1 < w.length && isV(i + 1)) i++;
        groups.push([start, i]);
      }
    }
    // нямо „e“ в края: make, hope (но не table, the)
    if (groups.length > 1) {
      const last = groups[groups.length - 1];
      const L = w.length;
      if (last[0] === L - 1 && w[L - 1] === 'e' && !(w[L - 2] === 'l' && !isV(L - 3))) groups.pop();
      else if (last[0] === L - 2 && w.endsWith('ed') && !/[td]ed$/.test(w)) groups.pop();
    }
    if (groups.length < 2) return [];
    const cuts = [];
    for (let k = 0; k < groups.length - 1; k++) {
      const a = groups[k][1], b = groups[k + 1][0];
      const n = b - a - 1;
      const cluster = w.slice(a + 1, b);
      let cut;
      if (n === 0) cut = b;
      else if (k === groups.length - 2 && /[^aeiouy]le$/.test(w) && b === w.length - 1) cut = b - 2; // ta-ble
      else if (n === 1) cut = a + 1;                                      // ti-ger
      else if (n === 2 && EN_DIGRAPHS.includes(cluster)) cut = cluster === 'ck' ? b : a + 1; // ma-chine, pick-et
      else if (EN_DIGRAPHS.includes(cluster.slice(-2)) && cluster.slice(-2) !== 'ck') cut = b - 2; // pan-ther
      else if (EN_DIGRAPHS.includes(cluster.slice(0, 2))) cut = a + 3;   // back-ground
      else cut = a + 2;                                                   // win-dow, mon-ster
      cuts.push(cut);
    }
    return cuts;
  }

  global.GazeSyllables = { syllabify, isCyrillic };
})(window);
