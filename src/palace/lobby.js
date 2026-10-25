import './entry.js';
import './lobby.css';
import {loadMemories} from './memories.js';
import './generated/figma-lobby-tokens.css';

const key = 'mneme:lobby:favorites:v1';
let memories = [];
let collectionStatus = 'loading';
const validFavorite = id => (Number.isInteger(id) && id >= 1 && id <= 29) || (typeof id === 'string' && id.length > 0 && id.length <= 200);
let favorites = new Set();
let storageAvailable = true;
try {
  const saved = JSON.parse(localStorage.getItem(key) || '[]');
  if (Array.isArray(saved)) favorites = new Set(saved.filter(validFavorite));
} catch { storageAvailable = false; }
const grid = document.querySelector('#memory-grid');
const search = document.querySelector('#search');
const dialog = document.querySelector('#photo-dialog');
let savedOnly = false;
let selected = null;
let opener = null;
let noticeTimer;

function notify(message) {
  const notice = document.querySelector('#notice');
  notice.textContent = message;
  notice.classList.add('visible');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.remove('visible'), 3500);
}
function updateCounts() {
  const count = memories.filter(memory => favorites.has(memory.id)).length;
  document.querySelector('#saved-count').textContent = count;
  document.querySelector('#saved-summary').textContent = count ? `${count} ${count === 1 ? 'favorite' : 'favorites'}, saved here.` : 'Your favorites, saved here.';
  for (const label of document.querySelectorAll('[data-moment-count]')) label.textContent = memories.length;
  document.querySelector('#browse-summary').textContent = collectionStatus === 'ready' ? 'Your memories, a little closer.' : 'Explore the sample collection.';
}
function toggleSave(id) {
  const saving = !favorites.has(id);
  if (saving) favorites.add(id); else favorites.delete(id);
  try { localStorage.setItem(key, JSON.stringify([...favorites])); storageAvailable = true; }
  catch { storageAvailable = false; }
  notify(storageAvailable ? (saving ? 'Saved to your favorites.' : 'Removed from favorites.') : 'Browser storage unavailable. Favorites last for this visit.');
  updateCounts();
  // Preserve keyboard focus by updating existing cards rather than rebuilding the grid.
  for (const button of grid.querySelectorAll('.save-button')) {
    const memory = memories.find(item => String(item.id) === button.dataset.id);
    if (!memory) continue;
    const saved = favorites.has(memory.id);
    button.setAttribute('aria-pressed', String(saved));
    button.setAttribute('aria-label', `${saved ? 'Unsave' : 'Save'} ${memory.title}`);
    button.textContent = saved ? '♥' : '♡';
  }
  if (savedOnly) {
    const focusedId = document.activeElement?.dataset.id;
    render();
    if (focusedId) (grid.querySelector('.save-button') || document.querySelector('#reset-filter')).focus();
  }
  updateDialog();
}
function updateDialog() {
  if (!selected) return;
  const saved = favorites.has(selected.id);
  const button = document.querySelector('#save-photo');
  button.textContent = saved ? '♥ Saved moment' : '♡ Save moment';
  button.setAttribute('aria-pressed', String(saved));
}
function openPhoto(memory, trigger) {
  selected = memory;
  opener = trigger;
  document.querySelector('#original-photo').src = memory.url;
  document.querySelector('#original-photo').alt = `${memory.title}, ${memory.generated ? 'memory preview' : 'sample photograph'}`;
  document.querySelector('#photo-title').textContent = memory.title;
  const enter = document.querySelector('#enter-memory');
  enter.hidden = !memory.generated;
  if (memory.generated) enter.href = `/library/?memory=${encodeURIComponent(memory.id)}&from=lobby`;
  else enter.removeAttribute('href');
  document.querySelector('#photo-caption').textContent = memory.generated ? 'Step inside to create or reopen this memory’s scene.' : 'Figma sample · Add your own moments to step inside them.';
  updateDialog();
  dialog.showModal();
  document.body.style.overflow = 'hidden';
}
function render() {
  const query = search.value.trim().toLowerCase();
  const visible = memories.filter(m => (!savedOnly || favorites.has(m.id)) && (!query || m.title.toLowerCase().includes(query) || String(m.id) === query));
  grid.replaceChildren();
  for (const memory of visible) {
    const card = document.createElement('article');
    card.className = 'memory-card';
    const photo = document.createElement('button');
    photo.className = 'photo-button';
    photo.setAttribute('aria-label', `View ${memory.title}`);
    const img = document.createElement('img');
    img.src = memory.url;
    img.alt = '';
    img.loading = 'lazy';
    img.width = 764;
    img.height = 522;
    photo.append(img);
    photo.addEventListener('click', () => openPhoto(memory, photo));
    const bottom = document.createElement('div');
    bottom.className = 'card-bottom';
    const name = document.createElement('span');
    name.textContent = memory.title;
    const save = document.createElement('button');
    save.className = 'save-button';
    save.dataset.id = memory.id;
    save.setAttribute('aria-label', `${favorites.has(memory.id) ? 'Unsave' : 'Save'} ${memory.title}`);
    save.setAttribute('aria-pressed', String(favorites.has(memory.id)));
    save.textContent = favorites.has(memory.id) ? '♥' : '♡';
    save.addEventListener('click', () => toggleSave(memory.id));
    bottom.append(name, save);
    card.append(photo, bottom);
    grid.append(card);
  }
  document.querySelector('#empty').hidden = visible.length > 0;
  document.querySelector('#empty-title').textContent = query ? 'No moment found.' : 'Keep a moment close.';
  document.querySelector('#empty-copy').textContent = query ? 'Try another name or browse the full collection.' : 'Tap a heart on any photo. Your favorites stay in this browser.';
  document.querySelector('#collection-note').textContent = collectionStatus === 'loading' ? 'Finding your moments…' : `${visible.length} ${savedOnly ? 'saved ' : collectionStatus === 'ready' ? '' : 'sample '}${visible.length === 1 ? 'moment' : 'moments'} · ${savedOnly ? 'Favorites stay in this browser.' : collectionStatus === 'ready' ? 'Select a memory to step inside.' : 'A preview of your future room.'}`;
  document.querySelector('#empty').hidden = visible.length > 0 || collectionStatus === 'loading';
  document.querySelector('#all-filter').setAttribute('aria-pressed', String(!savedOnly));
  document.querySelector('#saved-filter').setAttribute('aria-pressed', String(savedOnly));
}
function route(focus = true) {
  const hash = location.hash.slice(1);
  const target = ['moments', 'saved'].includes(hash) ? 'moments' : hash === 'design' ? 'design' : 'home';
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== target;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === target) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (target === 'moments') { savedOnly = hash === 'saved'; search.value = ''; render(); }
  document.querySelector('#location-label').textContent = { home:'LOBBY / 01', moments:'MOMENTS / 02', design:'DESIGN / 03' }[target];
  document.title = `Memory Palace · ${target === 'home' ? 'Your lobby' : target === 'moments' ? 'Moments' : 'Design in Figma'}`;
  if (dialog.open) dialog.close();
  if (focus) { document.querySelector('#main').focus({preventScroll:true}); window.scrollTo(0, 0); }
}
document.querySelector('#all-filter').addEventListener('click', () => { location.hash = 'moments'; });
document.querySelector('#saved-filter').addEventListener('click', () => { location.hash = 'saved'; });
document.querySelector('#reset-filter').addEventListener('click', () => {
  search.value = '';
  if (savedOnly) location.hash = 'moments'; else render();
  search.focus();
});
search.addEventListener('input', render);
document.querySelector('#close-photo').addEventListener('click', () => dialog.close());
document.querySelector('#save-photo').addEventListener('click', () => toggleSave(selected.id));
dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
dialog.addEventListener('close', () => {
  document.body.style.overflow = '';
  if (opener?.isConnected) opener.focus();
  else if (!document.querySelector('#moments').hidden) document.querySelector('#saved-filter').focus();
});
window.addEventListener('hashchange', () => route());
window.addEventListener('storage', e => {
  if (e.key !== key && e.key !== null) return;
  try { const value = JSON.parse(e.newValue || '[]'); favorites = new Set(Array.isArray(value) ? value.filter(validFavorite) : []); } catch { favorites = new Set(); }
  updateCounts(); if (!document.querySelector('#moments').hidden) render(); updateDialog();
});
updateCounts();
route(false);

loadMemories().then(result => {
  memories = result.memories;
  collectionStatus = result.status;
  updateCounts();
  render();
  document.querySelector('#room-status').textContent = result.status === 'ready' ? `${memories.length} ${memories.length === 1 ? 'moment' : 'moments'} ready` : result.status === 'offline' ? 'Library unavailable · Sample room ready' : '29 sample moments ready';
  if (result.status === 'ready') {
    const photos = document.querySelectorAll('.room-preview img');
    photos.forEach((photo, index) => { photo.src = memories[index % memories.length].url; });
    document.querySelector('.room-preview').setAttribute('aria-label', 'A preview of your sunlit room with floating memories');
  }
});
