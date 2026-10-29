// Shared UI helpers for app.html and spotlight.html.
export const $ = (s) => document.querySelector(s);

export const el = (tag, { dataset, ...props } = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  Object.assign(e.dataset, dataset);
  e.append(...kids);
  return e;
};

export const icon = (id) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.innerHTML = `<use href="icons.svg#i-${id}"/>`;
  return s;
};

export async function call(msg) {
  const res = await window.vf.call(msg);
  if (res?.error) throw new Error(res.error);
  return res;
}

// Site icon from Vaultwarden's icon service, coloured initial as fallback.
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
export function avatar(item, server) {
  const h = hue(item.name || '?');
  const box = el('span', { className: 'av', textContent: (item.name.trim()[0] || '?').toUpperCase() });
  box.style.background = `linear-gradient(135deg, hsl(${h} 70% 58%), hsl(${(h + 40) % 360} 65% 48%))`;
  if (item.host && server) {
    const img = el('img', { alt: '', src: `${server}/icons/${encodeURIComponent(item.host)}/icon.png` });
    img.onload = () => { box.textContent = ''; box.style.background = ''; box.classList.add('img'); box.append(img); };
  }
  return box;
}

export function generatePassword(len = 20) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*+-=?@_';
  // rejection sampling keeps the distribution uniform
  const out = [];
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < 256 - (256 % chars.length) && out.length < len) out.push(chars[b % chars.length]);
    }
  }
  return out.join('');
}
