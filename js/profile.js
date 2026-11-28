/*
 * GazeRead – профил на потребителя
 * Без акаунт: всичко се пази в този браузър (localStorage); може да се пренесе на друг компютър с файл.
 * С акаунт (само ако сайтът е пуснат с node server.js): пази се и на сървъра.
 * Като статичен сайт (GitHub Pages, Netlify…) няма /api – тогава акаунтите просто не се показват.
 */
(function () {
  const GUEST_KEY = 'gazeread.profile.guest';
  const userKey = (u) => 'gazeread.profile.user.' + u.toLowerCase();
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* пълно или забранено */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  async function call(method, url, body) {
    const r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(data.error || 'Грешка ' + r.status);
    return data;
  }

  // мигриране от старите отделни ключове
  function legacyGuest() {
    const p = {};
    try {
      for (const k of ['settings', 'hard', 'text']) {
        const v = localStorage.getItem('gazeread.' + k);
        if (v !== null) p[k] = JSON.parse(v);
      }
    } catch (e) {}
    return p;
  }

  const P = {
    user: null,
    data: {},
    serverAvailable: false,
    status: '',                 // текст за състоянието на запазването

    async init() {
      try {
        const me = await call('GET', '/api/me');
        // някои хостинги връщат index.html (код 200) за всеки адрес – истинският сървър винаги дава { user: … }
        if (!me || typeof me !== 'object' || !('user' in me)) throw new Error('no server');
        this.serverAvailable = true;
        if (me.user) {
          this.user = me.user;
          // локалното копие може да е по-ново (ако страницата е затворена преди да се запази на сървъра)
          const local = ls.get(userKey(me.user.username));
          const server = me.profile;
          if (local && (!server || (local.updatedAt || 0) > (server.updatedAt || 0))) { this.data = local; this.save(); }
          else this.data = server || {};
          return this;
        }
      } catch (e) { this.serverAvailable = false; }
      this.data = ls.get(GUEST_KEY) || legacyGuest();
      return this;
    },

    get(k, d) { return this.data[k] === undefined ? d : this.data[k]; },
    set(k, v) { this.data[k] = v; this.data.updatedAt = Date.now(); this.save(); },

    /** Заменя целия профил (зареждане от файл) и го запазва веднага. */
    async replace(data) { this.data = { ...data, updatedAt: Date.now() }; await this.save(true); },

    save(immediate) {
      const key = this.user ? userKey(this.user.username) : GUEST_KEY;
      clearTimeout(this._t);
      const run = async () => {
        ls.set(key, this.data);
        if (!this.user) return;
        try { await call('PUT', '/api/profile', this.data); this.status = 'Запазено'; }
        catch (e) { this.status = 'Не успях да запазя на сървъра: ' + e.message; }
      };
      if (immediate) return run();
      this._t = setTimeout(run, 2500);
    },

    /** При вход/регистрация: ако акаунтът е нов, пренасяме досегашните данни от браузъра. */
    async _afterAuth(res) {
      this.user = res.user;
      const guest = ls.get(GUEST_KEY) || {};
      this.data = res.profile || guest;
      if (!res.profile && Object.keys(guest).length) await this.save(true);
    },
    async login(username, password) { await this._afterAuth(await call('POST', '/api/login', { username, password })); },
    async register(username, password) { await this._afterAuth(await call('POST', '/api/register', { username, password })); },
    async logout() { await this.save(true); await call('POST', '/api/logout'); this.user = null; },
    async deleteAccount() { const u = this.user; await call('DELETE', '/api/account'); if (u) ls.del(userKey(u.username)); this.user = null; },
  };

  window.GazeProfile = P;
  // запазване при затваряне на страницата
  addEventListener('pagehide', () => {
    const key = P.user ? userKey(P.user.username) : GUEST_KEY;
    ls.set(key, P.data);
    if (P.user && navigator.sendBeacon) { /* PUT не става с beacon – данните остават и локално */ }
  });
})();
