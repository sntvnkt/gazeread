/*
 * GazeRead – личен модел, който свиква с четенето на човека
 *
 * 1) Предсказва колко вероятно е дадена дума да е трудна ЗА ТОЗИ човек
 *    (логистична регресия, която се учи онлайн):
 *       • кликнал е думата (имал е нужда от срички/звук)  → трудна  (1)
 *       • натиснал е Shift (успял е да я прочете)          → лесна   (0)
 *    За трудните думи помощта идва по-рано, за лесните – по-късно.
 * 2) Нагласява времето за задържане: ако човек често натиска Shift веднага
 *    (помощта е дошла твърде рано), времето леко се увеличава, и обратно.
 */
(function () {
  const { syllabify, isCyrillic } = window.GazeSyllables;
  const VOWELS = /[аъоуеияюaeiouy]/i;
  const RARE_BG = /[щжъюяьцф]/gi;
  const CONFUSING = /[бдпвqbdp]/gi;   // букви, които често се объркват при дислексия

  const FEATURES = [
    ['bias', 'начално'],
    ['len', 'дълги думи'],
    ['syl', 'много срички'],
    ['clusters', 'струпани съгласни'],
    ['rare', 'редки букви (щ, ж, ъ, ю, я, ц…)'],
    ['confusing', 'букви, които си приличат (б/д/п/в)'],
    ['similar', 'думи, подобни на вече трудни'],
    ['capital', 'имена и думи с главна буква'],
    ['foreign', 'думи на латиница'],
  ];
  const PRIOR = [-1.4, 0.9, 0.6, 0.4, 0.2, 0.15, 1.0, 0.1, 0.3];

  const sigmoid = (z) => 1 / (1 + Math.exp(-z));

  const A = {
    state: null,
    hardWords: null,          // Map, подава се отвън

    load(saved, hardWords) {
      const s = saved && Array.isArray(saved.w) && saved.w.length === PRIOR.length ? saved : null;
      this.state = s || { w: PRIOR.slice(), n: 0, quick: 0, helped: 0, readOk: 0, zoomed: 0, accuracy: [] };
      this.state.accuracy = this.state.accuracy || [];
      this.hardWords = hardWords;
      return this;
    },

    features(word) {
      const w = word.toLowerCase();
      const len = w.length;
      const syl = syllabify(w).length;
      let clusters = 0, run = 0;
      for (const ch of w) { if (/\p{L}/u.test(ch) && !VOWELS.test(ch)) { run++; if (run === 3) clusters++; } else run = 0; }
      const rare = (w.match(RARE_BG) || []).length;
      const conf = (w.match(CONFUSING) || []).length;
      let similar = 0;
      if (this.hardWords && len >= 4) {
        for (const h of this.hardWords.keys()) {
          if (h === w) { similar = 1; break; }
          if (h.length >= 4 && h.slice(0, 4) === w.slice(0, 4)) similar = Math.max(similar, 0.6);
        }
      }
      return [1, Math.min(len, 20) / 10, Math.min(syl, 8) / 4, Math.min(clusters, 3) / 2, Math.min(rare, 4) / 2,
        Math.min(conf, 6) / 3, similar, /^\p{Lu}/u.test(word) ? 1 : 0, isCyrillic(word) ? 0 : 1];
    },

    pHard(word) {
      const f = this.features(word);
      return sigmoid(f.reduce((a, v, i) => a + v * this.state.w[i], 0));
    },

    /** Време за задържане за конкретната дума (секунди). */
    dwellFor(word, base) {
      const p = this.pHard(word);
      return Math.max(0.5, base * (1.3 - 0.7 * p));   // трудна → по-рано, лесна → по-късно
    },

    /** Учене от резултата: helped = true (кликна) / false (Shift). */
    learn(word, helped) {
      const f = this.features(word);
      const p = this.pHard(word);
      const st = this.state;
      const lr = 0.35 / Math.sqrt(1 + st.n / 25);
      const y = helped ? 1 : 0;
      for (let i = 0; i < f.length; i++) st.w[i] += lr * ((y - p) * f[i] - (i ? 0.01 * (st.w[i] - PRIOR[i]) : 0));
      st.n++;
      if (helped) st.helped++; else st.readOk++;
    },

    /**
     * Нагласява основното време за задържане.
     * quickShift: Shift е натиснат < 0,8 s след увеличаването → помощта е дошла твърде рано.
     */
    tuneDwell(base, helped, msSinceZoom) {
      let b = base;
      if (!helped && msSinceZoom < 800) { b *= 1.05; this.state.quick++; }
      else if (helped) b *= 0.985;
      return Math.round(Math.min(3.5, Math.max(0.7, b)) * 10) / 10;
    },

    addAccuracy(px) {
      this.state.accuracy.push({ t: Date.now(), px });
      if (this.state.accuracy.length > 30) this.state.accuracy.shift();
    },

    /** Кратко описание какво е научил моделът – за панела „Моят профил“. */
    insights() {
      const st = this.state;
      if (st.n < 5) return ['Все още се уча – прочети още малко текст, като използваш Shift и клик.'];
      const diffs = FEATURES.map(([k, label], i) => ({ k, label, d: st.w[i] - PRIOR[i], w: st.w[i] })).slice(1);
      const harder = diffs.filter((x) => x.w > 0.5).sort((a, b) => b.w - a.w).slice(0, 3).map((x) => x.label);
      const out = [];
      if (harder.length) out.push('По-трудни за теб са: ' + harder.join(', ') + '.');
      const total = st.helped + st.readOk;
      if (total) out.push(`Успяваш сам/а с ${Math.round(st.readOk / total * 100)}% от думите, на които се спираш.`);
      return out;
    },

    export() { return this.state; },
  };

  window.GazeAdapt = A;
})();
