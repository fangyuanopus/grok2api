// ==UserScript==
// @name         Grok -> Grok2API (Vercel Auto Sync)
// @namespace    https://tampermonkey.net/
// @version      2.0.0
// @description  从 grok.com 自动同步 sso/cf_clearance 到 Grok2API（直连 API，不依赖粘贴）
// @match        https://grok.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_cookie
// @grant        GM_xmlhttpRequest
// @connect      grok2api-su.vercel.app
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ====== 你只需要改这三项 ======
  const TARGET_BASE = 'https://grok2api-su.vercel.app';
  const ADMIN_APP_KEY = 'grok2api';
  const TARGET_POOL = 'ssoBasic'; // 可改为 ssoSuper
  // 可选：固定代理（例如 'http://127.0.0.1:7890'），留空表示不改代理
  const FIXED_PROXY = '';
  // ============================

  function now() {
    return new Date().toLocaleTimeString();
  }

  function log(...args) {
    console.log('[Grok2API Sync]', ...args);
  }

  function toBearer(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    return /^Bearer\s+/i.test(s) ? s : `Bearer ${s}`;
  }

  function b64UrlDecodeJson(part) {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const text = atob(b64);
    return JSON.parse(text);
  }

  function validateJwt(jwt) {
    const token = String(jwt || '').trim().replace(/\s+/g, '');
    if (!token) return { ok: false, reason: 'empty' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'segment_count' };
    if (token.length < 80) return { ok: false, reason: 'too_short' };
    if (!parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) {
      return { ok: false, reason: 'bad_charset' };
    }
    try {
      const payload = b64UrlDecodeJson(parts[1]);
      const hasBasicClaim = payload && typeof payload === 'object'
        && (
          typeof payload.exp === 'number'
          || typeof payload.iat === 'number'
          || typeof payload.sub === 'string'
          || typeof payload.sid === 'string'
          || typeof payload.session_id === 'string'
        );
      if (!hasBasicClaim) return { ok: false, reason: 'missing_claims' };
      return { ok: true, token, payload };
    } catch (e) {
      return { ok: false, reason: 'decode_failed' };
    }
  }

  function pickLatestCookie(cookies, name) {
    const list = (cookies || []).filter(c => c && c.name === name);
    list.sort((a, b) => {
      const ta = Number(a.expirationDate || a.lastAccessed || a.creationTime || 0);
      const tb = Number(b.expirationDate || b.lastAccessed || b.creationTime || 0);
      return tb - ta;
    });
    return list[0] || null;
  }

  function listCookies(domain) {
    return new Promise((resolve, reject) => {
      GM_cookie.list({ domain }, (cookies, err) => {
        if (err) reject(err);
        else resolve(cookies || []);
      });
    });
  }

  function collectJwtFromStorage() {
    const jwtRe = /[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g;
    const candidates = [];
    for (const st of [localStorage, sessionStorage]) {
      for (let i = 0; i < st.length; i++) {
        const key = st.key(i);
        const val = st.getItem(key) || '';
        const m = val.match(jwtRe);
        if (!m) continue;
        m.forEach(x => candidates.push(x));
      }
    }
    for (const c of candidates) {
      const v = validateJwt(c);
      if (v.ok) return v.token;
    }
    return '';
  }

  function gmRequest({ method, url, headers, data, timeout = 30000 }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: headers || {},
        data,
        timeout,
        onload: (res) => resolve(res),
        onerror: (err) => reject(err),
        ontimeout: () => reject(new Error(`timeout: ${method} ${url}`))
      });
    });
  }

  async function requestJson(method, path, { headers = {}, body = null } = {}) {
    const url = `${TARGET_BASE}${path}`;
    const finalHeaders = { ...headers };
    let data = null;
    if (body !== null && body !== undefined) {
      finalHeaders['Content-Type'] = 'application/json';
      data = JSON.stringify(body);
    }
    const res = await gmRequest({ method, url, headers: finalHeaders, data });
    let json = null;
    try {
      json = res.responseText ? JSON.parse(res.responseText) : null;
    } catch (_) {}
    return {
      status: Number(res.status || 0),
      ok: Number(res.status || 0) >= 200 && Number(res.status || 0) < 300,
      json,
      text: String(res.responseText || '')
    };
  }

  async function collectSsoAndCf() {
    let cookies = [];
    try {
      cookies = await listCookies('grok.com');
      if (!cookies.length) {
        cookies = await listCookies('.grok.com');
      }
    } catch (e) {
      log('GM_cookie.list error:', e);
    }

    const ssoCookie = pickLatestCookie(cookies, 'sso');
    const cfCookie = pickLatestCookie(cookies, 'cf_clearance');
    const ssoRaw = String(ssoCookie && ssoCookie.value ? ssoCookie.value : '').trim().replace(/\s+/g, '');
    const cfRaw = String(cfCookie && cfCookie.value ? cfCookie.value : '').trim();

    const ssoCheck = validateJwt(ssoRaw);
    if (ssoCheck.ok) {
      return { sso: ssoCheck.token, cf: cfRaw, source: 'cookie:sso' };
    }

    const fromStorage = collectJwtFromStorage();
    const storageCheck = validateJwt(fromStorage);
    if (storageCheck.ok) {
      return { sso: storageCheck.token, cf: cfRaw, source: 'storage:jwt' };
    }

    throw new Error('未找到有效 JWT（cookie 的 sso 不可读，且 storage 中也没有）');
  }

  function buildTokenObject(token) {
    return {
      token,
      status: 'active',
      quota: TARGET_POOL === 'ssoSuper' ? 140 : 80,
      note: '',
      tags: [],
      use_count: 0,
      fail_count: 0
    };
  }

  async function syncToServer() {
    log(`${now()} 开始同步`);

    const { sso, cf, source } = await collectSsoAndCf();
    const ssoShort = `${sso.slice(0, 18)}...${sso.slice(-10)}`;
    log(`token 来源: ${source}, 长度: ${sso.length}`);
    log(`token 预览: ${ssoShort}`);
    log(`cf_clearance 长度: ${cf ? cf.length : 0}`);

    // 1) 登录后台（app_key）
    const login = await requestJson('POST', '/api/v1/admin/login', {
      headers: { Authorization: toBearer(ADMIN_APP_KEY) }
    });
    if (!login.ok) {
      throw new Error(`login_${login.status}: ${login.text || 'empty response'}`);
    }

    // login 成功但 api_key 可能为空（表示后续接口不做 api_key 校验）
    const returnedApiKey = String((login.json && login.json.api_key) || '').trim();
    const authHeaders = returnedApiKey ? { Authorization: toBearer(returnedApiKey) } : {};
    log(`login_200, api_key=${returnedApiKey ? '已返回' : '空(接口可能未启用 api_key 校验)'}`);

    // 2) 读当前 token 列表
    const listRes = await requestJson('GET', '/api/v1/admin/tokens', { headers: authHeaders });
    if (!listRes.ok || !listRes.json || typeof listRes.json !== 'object') {
      throw new Error(`tokens_get_${listRes.status}: ${listRes.text || 'bad response'}`);
    }

    const tokenMap = listRes.json;
    const pools = Object.keys(tokenMap);
    let exists = false;
    for (const p of pools) {
      const arr = Array.isArray(tokenMap[p]) ? tokenMap[p] : [];
      for (const it of arr) {
        const v = typeof it === 'string' ? it : (it && it.token);
        if (String(v || '').trim() === sso) {
          exists = true;
          break;
        }
      }
      if (exists) break;
    }

    if (!Array.isArray(tokenMap[TARGET_POOL])) tokenMap[TARGET_POOL] = [];
    if (!exists) {
      tokenMap[TARGET_POOL].push(buildTokenObject(sso));
      const saveRes = await requestJson('POST', '/api/v1/admin/tokens', {
        headers: authHeaders,
        body: tokenMap
      });
      if (!saveRes.ok) {
        throw new Error(`tokens_post_${saveRes.status}: ${saveRes.text || 'save failed'}`);
      }
      log('token 已写入');
    } else {
      log('token 已存在，跳过写入');
    }

    // 3) 可选更新 cf_clearance / proxy
    const cfgPayload = {};
    if (cf) {
      cfgPayload.grok = { ...(cfgPayload.grok || {}), cf_clearance: cf };
      cfgPayload.security = { ...(cfgPayload.security || {}), cf_clearance: cf };
    }
    if (FIXED_PROXY) {
      cfgPayload.grok = { ...(cfgPayload.grok || {}), base_proxy_url: FIXED_PROXY, asset_proxy_url: FIXED_PROXY };
      cfgPayload.network = { ...(cfgPayload.network || {}), base_proxy_url: FIXED_PROXY, asset_proxy_url: FIXED_PROXY };
    }

    if (Object.keys(cfgPayload).length > 0) {
      const cfgRes = await requestJson('POST', '/api/v1/admin/config', {
        headers: authHeaders,
        body: cfgPayload
      });
      if (!cfgRes.ok) {
        log(`config_${cfgRes.status}: ${cfgRes.text || 'failed'}`);
      } else {
        log('config 已更新');
      }
    }

    // 4) 刷新刚同步的 token
    const refresh = await requestJson('POST', '/api/v1/admin/tokens/refresh', {
      headers: authHeaders,
      body: { token: sso }
    });
    if (!refresh.ok) {
      throw new Error(`refresh_${refresh.status}: ${refresh.text || 'failed'}`);
    }

    const refreshOk = !!(refresh.json && refresh.json.results && refresh.json.results[sso]);
    const tip = refreshOk
      ? '同步完成：refresh=true'
      : '同步完成：refresh=false（常见是上游 403 风控/账号状态问题，不是脚本语法问题）';

    alert(
      [
        tip,
        `目标: ${TARGET_BASE}`,
        `token来源: ${source}`,
        `sso长度: ${sso.length}`,
        `cf长度: ${cf ? cf.length : 0}`,
        `refresh HTTP: ${refresh.status}`
      ].join('\n')
    );

    log('refresh response:', refresh.json || refresh.text);
  }

  async function run() {
    try {
      await syncToServer();
    } catch (e) {
      console.error('[Grok2API Sync] error:', e);
      alert(`脚本异常: ${String(e && e.message ? e.message : e)}`);
    }
  }

  GM_registerMenuCommand('同步到 Grok2API (Vercel)', run);
})();
