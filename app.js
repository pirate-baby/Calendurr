const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HUES = [30, 75, 120, 165, 210, 255, 300, 345];
const STORAGE_KEY = 'planner-browser-state-v1';

const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const sundayOf = date => { const result = new Date(date); result.setHours(0, 0, 0, 0); result.setDate(result.getDate() - result.getDay()); return result; };
const parseDate = value => { const [year, month, day] = value.split('-').map(Number); return new Date(year, month - 1, day); };
const color = (hue, lightness = .7, chroma = .13) => `oklch(${lightness} ${chroma} ${hue})`;

let saved = null;
try {
  saved = JSON.parse(window.localStorage?.getItem(STORAGE_KEY) || 'null');
} catch {
  saved = null;
}
const state = {
  startDate: sundayOf(new Date()), weeks: 6, notes: {}, highlights: [], painted: {}, emojis: {}, active: null,
  draftHue: HUES[0], ...(saved || {})
};
state.startDate = new Date(state.startDate);
let dragStart = null;
let dragEnd = null;
let dragging = false;
let dragPointerId = null;

function persist() {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ ...state, startDate: state.startDate.toISOString() }));
  } catch {
    // The planner remains usable when browser storage is blocked.
  }
  document.querySelector('#save-status').textContent = 'Saved in this browser';
}
function changeStart(days) { state.startDate.setDate(state.startDate.getDate() + days); render(); persist(); }
function setWeeks(weeks) { state.weeks = Math.max(2, Math.min(16, weeks)); render(); persist(); }
function cellKey(index) { const date = new Date(state.startDate); date.setDate(date.getDate() + index); return dateKey(date); }
function getHighlight(id) { return state.highlights.find(item => item.id === id); }

function renderControls() {
  document.querySelector('#start-date').value = dateKey(state.startDate);
  document.querySelector('#weeks-label').textContent = `${state.weeks} weeks`;
  document.querySelector('#presets').innerHTML = [4, 6, 8, 12].map(weeks => `<button class="preset ${state.weeks === weeks ? 'active' : ''}" data-weeks="${weeks}">${weeks === 8 ? '8w (2mo)' : `${weeks}w`}</button>`).join('');
  document.querySelector('#presets').querySelectorAll('button').forEach(button => button.onclick = () => setWeeks(Number(button.dataset.weeks)));
  document.querySelector('#swatches').innerHTML = HUES.map(hue => `<button type="button" class="swatch ${state.draftHue === hue ? 'selected' : ''}" style="background:${color(hue)}" aria-label="Select color" data-hue="${hue}"></button>`).join('');
  document.querySelectorAll('.swatch').forEach(button => button.onclick = () => { state.draftHue = Number(button.dataset.hue); renderControls(); });
  const list = document.querySelector('#highlight-list');
  list.innerHTML = state.highlights.map(item => `<span class="highlight-item"><button class="pill-button ${state.active === item.id ? 'active' : ''}" style="--dot:${color(item.hue, .62)};--soft:${color(item.hue, .93, .045)}" data-tool="${item.id}"><span>${item.emoji}</span><span class="dot"></span>${escapeHtml(item.title)}</button><button class="remove-button" title="Remove ${escapeHtml(item.title)}" data-remove="${item.id}">×</button></span>`).join('');
  list.querySelectorAll('[data-tool]').forEach(button => button.onclick = () => { state.active = state.active === button.dataset.tool ? null : button.dataset.tool; renderControls(); });
  list.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => { const id = button.dataset.remove; state.highlights = state.highlights.filter(item => item.id !== id); Object.keys(state.painted).forEach(key => { if (state.painted[key] === id) delete state.painted[key]; }); if (state.active === id) state.active = null; render(); persist(); });
  const eraser = document.querySelector('#eraser'); eraser.classList.toggle('active', state.active === 'eraser'); eraser.onclick = () => { state.active = state.active === 'eraser' ? null : 'eraser'; renderControls(); };
}

function renderCalendar() {
  const calendar = document.querySelector('#calendar');
  let html = WEEKDAYS.map(day => `<div class="weekday">${day}</div>`).join('');
  const today = dateKey(new Date());
  for (let index = 0; index < state.weeks * 7; index++) {
    const date = new Date(state.startDate); date.setDate(date.getDate() + index);
    const key = dateKey(date); const item = getHighlight(state.painted[key]);
    const previousDate = new Date(date); previousDate.setDate(previousDate.getDate() - 1);
    const isHighlightStart = Boolean(item && state.painted[dateKey(previousDate)] !== item.id);
    const isSelected = dragStart !== null && index >= Math.min(dragStart, dragEnd) && index <= Math.max(dragStart, dragEnd);
    const label = (date.getDate() === 1 || index === 0) ? MONTHS[date.getMonth()] : '';
    const marker = isHighlightStart ? `<span class="highlight-band" style="--band-color:${color(item.hue, .62)}"><span>${escapeHtml(item.title)}</span></span><span class="highlight-emoji">${item.emoji}</span>` : '';
    html += `<div class="day ${item ? 'highlighted' : ''} ${isSelected ? 'selected' : ''}" data-index="${index}" style="--day-color:${item ? color(item.hue, .93, .045) : '#fff'}">${marker}<div class="day-top"><span class="month-label">${label}</span><span class="day-number ${key === today ? 'today' : ''}">${date.getDate()}</span></div><div class="day-note" contenteditable="true" data-note="${key}">${escapeHtml(state.notes[key] || '')}</div></div>`;
  }
  calendar.innerHTML = html;
  const startPaint = (event, pointerId) => {
    const day = event.target.closest('.day');
    if (!day || !state.active) return;
    event.preventDefault();
    dragStart = Number(day.dataset.index);
    dragEnd = dragStart;
    dragging = true;
    dragPointerId = pointerId;
    if (state.active === 'eraser') eraseCell(dragStart);
    updateSelectionPreview();
  };
  calendar.onmousedown = event => {
    if (event.button !== 0) return;
    startPaint(event, 'mouse');
  };
  calendar.onmouseover = event => {
    if (!dragging || dragPointerId !== 'mouse') return;
    const day = event.target.closest('.day');
    if (day) movePaintTo(Number(day.dataset.index));
  };
  calendar.onpointerdown = event => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    startPaint(event, event.pointerId);
    calendar.setPointerCapture?.(event.pointerId);
  };
  calendar.querySelectorAll('.day-note').forEach(note => note.addEventListener('blur', () => { state.notes[note.dataset.note] = note.innerText; persist(); }));
}
function updateSelectionPreview() {
  document.querySelectorAll('.day').forEach(day => {
    const index = Number(day.dataset.index);
    const selected = dragging && dragStart !== null && index >= Math.min(dragStart, dragEnd) && index <= Math.max(dragStart, dragEnd);
    day.classList.toggle('selected', selected);
  });
}
function eraseCell(index) {
  const key = cellKey(index);
  delete state.painted[key];
  delete state.emojis[key];
  const day = document.querySelector(`.day[data-index="${index}"]`);
  if (day) {
    day.classList.remove('highlighted');
    day.style.setProperty('--day-color', '#fff');
    day.querySelector('.highlight-band')?.remove();
    day.querySelector('.highlight-emoji')?.remove();
  }
}
function movePaint(event) {
  if (!dragging || event.pointerId !== dragPointerId) return;
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const day = element?.closest('.day');
  if (!day || !document.querySelector('#calendar').contains(day)) return;
  movePaintTo(Number(day.dataset.index));
}
function movePaintTo(index) {
  if (index === dragEnd) return;
  dragEnd = index;
  if (state.active === 'eraser') eraseCell(index);
  updateSelectionPreview();
}
function commitPaint(event) {
  if (event && event.pointerId !== dragPointerId) return;
  if (!dragging || dragStart === null || !state.active) { dragging = false; dragStart = dragEnd = dragPointerId = null; renderCalendar(); return; }
  const highlight = getHighlight(state.active);
  for (let index = Math.min(dragStart, dragEnd); index <= Math.max(dragStart, dragEnd); index++) { const key = cellKey(index); if (state.active === 'eraser') eraseCell(index); else state.painted[key] = state.active; }
  const firstKey = cellKey(Math.min(dragStart, dragEnd));
  for (let index = Math.min(dragStart, dragEnd); index <= Math.max(dragStart, dragEnd); index++) delete state.emojis[cellKey(index)];
  if (highlight) state.emojis[firstKey] = highlight.emoji;
  dragging = false; dragStart = dragEnd = dragPointerId = null; render(); persist();
}
function cancelPaint(event) {
  if (event.pointerId !== dragPointerId) return;
  dragging = false;
  dragStart = dragEnd = dragPointerId = null;
  renderCalendar();
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function render() { renderControls(); renderCalendar(); }

document.querySelector('#previous-week').onclick = () => changeStart(-7);
document.querySelector('#next-week').onclick = () => changeStart(7);
document.querySelector('#decrease-weeks').onclick = () => setWeeks(state.weeks - 1);
document.querySelector('#increase-weeks').onclick = () => setWeeks(state.weeks + 1);
document.querySelector('#start-date').onchange = event => { if (event.target.value) { state.startDate = sundayOf(parseDate(event.target.value)); render(); persist(); } };
document.querySelector('#new-highlight').onsubmit = event => { event.preventDefault(); const title = document.querySelector('#title-input').value.trim(); if (!title) return; const id = `highlight-${Date.now()}`; state.highlights.push({ id, title, emoji: document.querySelector('#emoji-input').value.trim() || '📌', hue: state.draftHue }); state.active = id; document.querySelector('#title-input').value = ''; state.draftHue = HUES[(HUES.indexOf(state.draftHue) + 1) % HUES.length]; render(); persist(); };
const emojiTrigger = document.querySelector('#emoji-trigger');
const emojiPicker = document.querySelector('#emoji-picker');
emojiTrigger.onclick = () => emojiPicker.classList.toggle('open');
emojiPicker.addEventListener('emoji-click', event => { document.querySelector('#emoji-input').value = event.detail.unicode; emojiTrigger.textContent = event.detail.unicode; emojiPicker.classList.remove('open'); });
document.addEventListener('click', event => { if (!event.target.closest('.emoji-picker-wrap')) emojiPicker.classList.remove('open'); });
document.addEventListener('pointermove', movePaint);
document.addEventListener('pointerup', commitPaint);
document.addEventListener('pointercancel', cancelPaint);
document.addEventListener('mouseup', () => { if (dragPointerId === 'mouse') commitPaint(); });
render();
