/* shared dashboard helpers */

export async function api(path, opts = {}) {
  const body = opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body;
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers,
    body,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `http ${res.status}`);
    err.status = res.status;
    err.data   = data;
    throw err;
  }
  return data;
}

export async function whoami() {
  try { return await api('/api/auth/me'); }
  catch { return null; }
}

export async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); }
  finally { location.href = '/login.html'; }
}

export function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class')   e.className = v;
    else if (k === 'html')  e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v != null)  e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

export async function renderHeader(active) {
  const me = await whoami();
  if (!me) { location.href = '/login.html'; return null; }

  const nav = el('nav', {}, [
    el('a', { href: '/index.html',  class: active === 'home'  ? 'active' : '' }, 'servers'),
    me.is_super ? el('a', { href: '/users.html',    class: active === 'users'    ? 'active' : '' }, 'users') : null,
    me.is_super ? el('a', { href: '/audit.html',    class: active === 'audit'    ? 'active' : '' }, 'audit') : null,
    me.is_super ? el('a', { href: '/terminal.html', class: active === 'terminal' ? 'active' : '' }, 'terminal') : null,
    el('a', { href: '/account.html', class: active === 'account' ? 'active' : '' }, 'account'),
    el('a', { href: '#', onclick: (e) => { e.preventDefault(); logout(); } }, 'log out'),
  ]);

  const header = el('header', {}, [
    el('span', { class: 'logo' }, 'minecraft dashboard'),
    nav,
    el('span', { class: 'who' }, [
      me.username,
      me.is_super ? ' · super' : '',
    ]),
  ]);

  document.body.prepend(header);
  return me;
}

export function renderFooter() {
  document.body.appendChild(
    el('footer', {}, 'minecraft dashboard - made by brotlaius')
  );
}

export function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}
