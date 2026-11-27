/*
 * GazeRead – разделяне на срички
 * Правилата са опростени, но покриват повечето думи в българския и английския език.
 */
(function (global) {
  const BG_VOWELS = 'аъоуеияюѝэ';
  const BG_SONORANTS = 'йрлмн';
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
  function cutsBg(w) {
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
