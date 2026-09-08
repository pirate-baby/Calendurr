const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HUES = [30, 75, 120, 165, 210, 255, 300, 345];
const STORAGE_KEY = 'planner-browser-state-v1';

const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const sundayOf = date => { const result = new Date(date); result.setHours(0, 0, 0, 0); result.setDate(result.getDate() - result.getDay()); return result; };
const parseDate = value => { const [year, month, day] = value.split('-').map(Number); return new Date(year, month - 1, day); };
const color = (hue, lightness = .7, chroma = .13) => `oklch(${lightness} ${chroma} ${hue})`;
const projectHue = project => {
  if (!project) return 0;
  return [...project].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 360, 0);
};

let saved = null;
try {
  saved = JSON.parse(window.localStorage?.getItem(STORAGE_KEY) || 'null');
} catch {
  saved = null;
}
const state = {
  startDate: sundayOf(new Date()), weeks: 6, contexts: [], painted: {}, emojis: {}, active: null,
  draftHue: HUES[0], tasks: [], selectedDate: null, selectedTaskId: null, mode: 'task', ...(saved || {})
};
state.startDate = new Date(state.startDate);
delete state.notes;
if (!Array.isArray(saved?.contexts)) state.contexts = Array.isArray(state.highlights) ? state.highlights : [];
delete state.highlights;
state.weather = { zip: '', highs: {}, lows: {}, rain: {}, temperatureMode: 'high', location: '', status: '', ...(state.weather || {}) };
state.weather.highs ||= {};
state.weather.lows ||= {};
state.weather.rain ||= {};
if (!['high', 'low'].includes(state.weather.temperatureMode)) state.weather.temperatureMode = 'high';
if (state.mode === 'highlight') state.mode = 'context';
if (!['task', 'context'].includes(state.mode)) state.mode = 'task';
state.tasks = Array.isArray(state.tasks) ? state.tasks.filter(task => task && task.id && task.title && task.date).map(task => ({
  id: String(task.id), title: String(task.title), description: String(task.description || ''), date: String(task.date),
  labels: Array.isArray(task.labels) ? task.labels.map(String) : [], project: String(task.project || ''), priorityOrder: Number(task.priorityOrder) || 0,
  status: String(task.status || 'todo')
})) : [];
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
}
function changeStart(days) { state.startDate.setDate(state.startDate.getDate() + days); render(); persist(); }
function setWeeks(weeks) { state.weeks = Math.max(2, Math.min(16, weeks)); render(); persist(); }
function cellKey(index) { const date = new Date(state.startDate); date.setDate(date.getDate() + index); return dateKey(date); }
function getContext(id) { return state.contexts.find(item => item.id === id); }
function tasksForDate(date) { return state.tasks.filter(task => task.date === date).sort((a, b) => a.priorityOrder - b.priorityOrder || a.title.localeCompare(b.title)); }
function taskColor(task) { return task.project ? color(projectHue(task.project), .62, .13) : '#938b84'; }
function taskIdLabel(task) { return escapeHtml(task.id.length > 5 ? task.id.slice(-5) : task.id); }
function contextLabel(title) {
  if (title.length <= 14) return escapeHtml(title);
  const middle = Math.ceil(title.length / 2);
  const wordBreak = title.lastIndexOf(' ', middle);
  const splitAt = wordBreak > 0 ? wordBreak : middle;
  return `${escapeHtml(title.slice(0, splitAt))}<br>${escapeHtml(title.slice(splitAt).trim())}`;
}
function temperatureColor(temperature) { const ratio = Math.max(0, Math.min(1, (temperature + 10) / 120)); return color(225 - ratio * 220, .67, .15); }

function renderWeather() {
  const weather = state.weather;
  document.querySelector('#weather-zip').value = weather.zip;
  document.querySelector('#weather-status').textContent = weather.status || 'Enter a US ZIP code to color days by forecast high.';
  document.querySelectorAll('[data-temperature-mode]').forEach(button => button.classList.toggle('active', button.dataset.temperatureMode === weather.temperatureMode));
  const marks = [0, 32, 50, 70, 90, 110];
  document.querySelector('#temperature-scale').innerHTML = `<div class="temperature-gradient"></div>${marks.map(temperature => `<span class="temperature-mark" style="left:${((temperature + 10) / 120) * 100}%">${temperature}°</span>`).join('')}`;
}

async function loadWeather(zip) {
  const normalizedZip = zip.trim();
  if (!/^\d{5}$/.test(normalizedZip)) {
    state.weather.status = 'Enter a five-digit US ZIP code.';
    renderWeather();
    return;
  }
  state.weather = { ...state.weather, zip: normalizedZip, highs: {}, lows: {}, rain: {}, location: '', status: 'Loading NOAA forecast...' };
  renderWeather();
  persist();
  try {
    const locationResponse = await fetch(`https://api.zippopotam.us/us/${normalizedZip}`);
    if (!locationResponse.ok) throw new Error('ZIP code not found');
    const location = await locationResponse.json();
    const place = location.places?.[0];
    if (!place) throw new Error('ZIP code not found');
    const pointResponse = await fetch(`https://api.weather.gov/points/${place.latitude},${place.longitude}`, { headers: { Accept: 'application/geo+json' } });
    if (!pointResponse.ok) throw new Error('NOAA forecast unavailable');
    const point = await pointResponse.json();
    const forecastResponse = await fetch(point.properties.forecast, { headers: { Accept: 'application/geo+json' } });
    if (!forecastResponse.ok) throw new Error('NOAA forecast unavailable');
    const forecast = await forecastResponse.json();
    const highs = {};
    const lows = {};
    const rain = {};
    forecast.properties.periods.forEach(period => {
      if (typeof period.temperature !== 'number') return;
      const temperature = period.temperatureUnit === 'C' ? Math.round(period.temperature * 9 / 5 + 32) : period.temperature;
      const date = period.startTime.slice(0, 10);
      if (period.isDaytime) {
        highs[date] = temperature;
        if ((period.probabilityOfPrecipitation?.value || 0) >= 20) rain[date] = period.probabilityOfPrecipitation.value;
      } else lows[date] = temperature;
    });
    let extended = false;
    try {
      const extendedResponse = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&forecast_days=16&timezone=auto`);
      if (!extendedResponse.ok) throw new Error('Extended forecast unavailable');
      const extendedForecast = await extendedResponse.json();
      extendedForecast.daily.time.forEach((date, index) => {
        const temperature = extendedForecast.daily.temperature_2m_max[index];
        const low = extendedForecast.daily.temperature_2m_min[index];
        const precipitation = extendedForecast.daily.precipitation_probability_max[index];
        if (typeof temperature === 'number' && typeof highs[date] !== 'number') highs[date] = Math.round(temperature);
        if (typeof low === 'number' && typeof lows[date] !== 'number') lows[date] = Math.round(low);
        if (typeof precipitation === 'number' && precipitation >= 20 && !rain[date]) rain[date] = precipitation;
      });
      extended = true;
    } catch {
      // NOAA data remains available when the extended forecast cannot be loaded.
    }
    const locationName = `${place['place name']}, ${place['state abbreviation']}`;
    state.weather = { zip: normalizedZip, highs, lows, rain, temperatureMode: state.weather.temperatureMode, location: locationName, status: `${extended ? 'NOAA + Open-Meteo 16-day' : 'NOAA'} forecast for ${locationName}` };
    render();
    persist();
  } catch (error) {
    state.weather = { ...state.weather, highs: {}, lows: {}, rain: {}, status: error.message || 'Unable to load NOAA forecast.' };
    render();
    persist();
  }
}

function renderControls() {
  document.querySelector('#start-date').value = dateKey(state.startDate);
  document.querySelector('#weeks-label').textContent = `${state.weeks} weeks`;
  document.querySelector('#presets').innerHTML = [4, 6, 8, 12].map(weeks => `<button class="preset ${state.weeks === weeks ? 'active' : ''}" data-weeks="${weeks}">${weeks === 8 ? '8w (2mo)' : `${weeks}w`}</button>`).join('');
  document.querySelector('#presets').querySelectorAll('button').forEach(button => button.onclick = () => setWeeks(Number(button.dataset.weeks)));
  document.querySelector('#task-mode').classList.toggle('active', state.mode === 'task');
  document.querySelector('#context-mode').classList.toggle('active', state.mode === 'context');
  document.querySelector('#swatches').innerHTML = HUES.map(hue => `<button type="button" class="swatch ${state.draftHue === hue ? 'selected' : ''}" style="background:${color(hue)}" aria-label="Select color" data-hue="${hue}"></button>`).join('');
  document.querySelectorAll('.swatch').forEach(button => button.onclick = () => { state.draftHue = Number(button.dataset.hue); renderControls(); });
  const list = document.querySelector('#context-list');
  list.innerHTML = state.contexts.map(item => `<span class="context-item"><button class="pill-button ${state.active === item.id ? 'active' : ''}" style="--dot:${color(item.hue, .62)};--soft:${color(item.hue, .93, .045)}" data-tool="${item.id}"><span>${item.emoji}</span><span class="dot"></span>${escapeHtml(item.title)}</button><button class="remove-button" title="Remove ${escapeHtml(item.title)}" data-remove="${item.id}">×</button></span>`).join('');
  list.querySelectorAll('[data-tool]').forEach(button => button.onclick = () => { state.active = state.active === button.dataset.tool ? null : button.dataset.tool; state.mode = 'context'; renderControls(); });
  list.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => { const id = button.dataset.remove; state.contexts = state.contexts.filter(item => item.id !== id); Object.keys(state.painted).forEach(key => { if (state.painted[key] === id) delete state.painted[key]; }); if (state.active === id) state.active = null; render(); persist(); });
  const eraser = document.querySelector('#eraser'); eraser.classList.toggle('active', state.active === 'eraser'); eraser.onclick = () => { state.active = state.active === 'eraser' ? null : 'eraser'; state.mode = 'context'; renderControls(); };
}

function renderCalendar() {
  const calendar = document.querySelector('#calendar');
  let html = WEEKDAYS.map(day => `<div class="weekday">${day}</div>`).join('');
  const today = dateKey(new Date());
  for (let index = 0; index < state.weeks * 7; index++) {
    const date = new Date(state.startDate); date.setDate(date.getDate() + index);
    const key = dateKey(date); const item = getContext(state.painted[key]);
    const previousDate = new Date(date); previousDate.setDate(previousDate.getDate() - 1);
    const isContextStart = Boolean(item && state.painted[dateKey(previousDate)] !== item.id);
    const isSelected = dragStart !== null && index >= Math.min(dragStart, dragEnd) && index <= Math.max(dragStart, dragEnd);
    const label = (date.getDate() === 1 || index === 0) ? MONTHS[date.getMonth()] : '';
    const marker = isContextStart ? `<span class="context-band ${item.title.length > 14 ? 'wide' : ''}" style="--band-color:${color(item.hue, .62)}"><span>${contextLabel(item.title)}</span></span><span class="context-emoji">${item.emoji}</span>` : '';
    const temperature = state.weather[state.weather.temperatureMode === 'low' ? 'lows' : 'highs'][key];
    const precipitation = state.weather.rain[key];
    const weatherStyle = typeof temperature === 'number' ? `--temp-color:${temperatureColor(temperature)}` : '';
    const weatherTitle = typeof temperature === 'number' ? ` title="Forecast ${state.weather.temperatureMode}: ${temperature} F"` : '';
    const rainEmoji = precipitation ? `<span class="weather-rain" title="${precipitation}% chance of precipitation">🌧️</span>` : '';
    const tasks = tasksForDate(key);
    const visibleTasks = tasks.slice(0, 5);
    const taskMarkers = tasks.length ? `<div class="task-markers">${visibleTasks.map(task => `<button class="task-marker ${task.status === 'done' ? 'done' : ''}" data-task-id="${escapeHtml(task.id)}" style="--task-color:${taskColor(task)}" title="${escapeHtml(task.title)}">${taskIdLabel(task)}</button>`).join('')}${tasks.length > visibleTasks.length ? `<button class="task-overflow" data-date="${key}" title="View all ${tasks.length} tasks">+${tasks.length - visibleTasks.length}</button>` : ''}</div>` : '';
    html += `<div class="day ${item ? 'contextual' : ''} ${isSelected ? 'selected' : ''} ${typeof temperature === 'number' ? 'has-temperature' : ''}" data-index="${index}" data-date="${key}" style="--day-color:${item ? color(item.hue, .93, .045) : '#fff'};${weatherStyle}"${weatherTitle}>${marker}<div class="day-top"><span class="month-label">${label}</span><span class="date-weather">${rainEmoji}<span class="day-number ${key === today ? 'today' : ''}">${date.getDate()}</span></span></div>${taskMarkers}</div>`;
  }
  calendar.innerHTML = html;
  const startPaint = (event, pointerId) => {
    const day = event.target.closest('.day');
    if (!day || state.mode !== 'context' || !state.active) return;
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
  calendar.querySelectorAll('.task-marker').forEach(marker => marker.onclick = event => { event.stopPropagation(); openTask(marker.dataset.taskId); });
  calendar.querySelectorAll('.task-overflow').forEach(button => button.onclick = event => { event.stopPropagation(); openDate(button.dataset.date); });
  calendar.querySelectorAll('.day').forEach(day => day.onclick = event => {
    if ((state.mode === 'context' && state.active) || event.target.closest('.task-marker, .task-overflow')) return;
    openDate(day.dataset.date);
  });
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
    day.classList.remove('contextual');
    day.style.setProperty('--day-color', '#fff');
    day.querySelector('.context-band')?.remove();
    day.querySelector('.context-emoji')?.remove();
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
  const context = getContext(state.active);
  for (let index = Math.min(dragStart, dragEnd); index <= Math.max(dragStart, dragEnd); index++) { const key = cellKey(index); if (state.active === 'eraser') eraseCell(index); else state.painted[key] = state.active; }
  const firstKey = cellKey(Math.min(dragStart, dragEnd));
  for (let index = Math.min(dragStart, dragEnd); index <= Math.max(dragStart, dragEnd); index++) delete state.emojis[cellKey(index)];
  if (context) state.emojis[firstKey] = context.emoji;
  dragging = false; dragStart = dragEnd = dragPointerId = null; render(); persist();
}
function cancelPaint(event) {
  if (event.pointerId !== dragPointerId) return;
  dragging = false;
  dragStart = dragEnd = dragPointerId = null;
  renderCalendar();
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function formatPanelDate(value) { return parseDate(value).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
function nextPriority(date) { return Math.max(-1, ...tasksForDate(date).map(task => task.priorityOrder)) + 1; }
function newTaskId() { return `T${String(Date.now()).slice(-6)}`; }
function reorderTasks(date, movedId, targetId) {
  const ordered = tasksForDate(date);
  const from = ordered.findIndex(task => task.id === movedId);
  const to = ordered.findIndex(task => task.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  const [moved] = ordered.splice(from, 1);
  ordered.splice(from < to ? to - 1 : to, 0, moved);
  ordered.forEach((task, index) => { task.priorityOrder = index; });
  renderCalendar();
  renderTaskPanel();
  persist();
}
function openDate(date) { state.selectedDate = date; state.selectedTaskId = null; renderTaskPanel(); persist(); }
function openTask(id) { const task = state.tasks.find(item => item.id === id); if (!task) return; state.selectedDate = task.date; state.selectedTaskId = id; renderTaskPanel(); persist(); }
function closeTaskPanel() { state.selectedDate = null; state.selectedTaskId = null; renderTaskPanel(); persist(); }
function renderTaskPanel() {
  const panel = document.querySelector('#task-panel');
  const content = document.querySelector('#task-panel-content');
  const scrim = document.querySelector('#task-panel-scrim');
  const isOpen = Boolean(state.selectedDate);
  panel.classList.toggle('open', isOpen);
  panel.setAttribute('aria-hidden', String(!isOpen));
  scrim.hidden = !isOpen;
  if (!isOpen) { content.innerHTML = ''; return; }
  const task = state.tasks.find(item => item.id === state.selectedTaskId);
  if (task) {
    content.innerHTML = `<div class="panel-heading"><button class="back-button" id="back-to-date" aria-label="Back to date tasks">‹</button><p class="section-label">Task details</p><button class="close-panel" id="close-task-panel" aria-label="Close task panel">×</button></div><form id="task-form" class="task-form"><label>Title<input name="title" required value="${escapeHtml(task.title)}" /></label><label>Description<textarea name="description" rows="5">${escapeHtml(task.description)}</textarea></label><label>Date<input name="date" type="date" required value="${escapeHtml(task.date)}" /></label><label>Project<input name="project" value="${escapeHtml(task.project)}" placeholder="e.g. Home" /></label><label>Labels<input name="labels" value="${escapeHtml(task.labels.join(', '))}" placeholder="Comma separated" /></label><label>Priority order<input name="priorityOrder" type="number" step="1" value="${task.priorityOrder}" /></label><div class="task-form-actions"><button class="delete-task" type="button" id="delete-task">Delete</button><button class="status-task ${task.status === 'done' ? 'done' : ''}" type="button" id="toggle-task-status">${task.status === 'done' ? 'Re-open' : 'Complete'}</button><button class="add-button" type="submit">Save task</button></div></form>`;
    document.querySelector('#back-to-date').onclick = () => openDate(task.date);
    document.querySelector('#delete-task').onclick = () => { state.tasks = state.tasks.filter(item => item.id !== task.id); openDate(task.date); render(); persist(); };
    document.querySelector('#toggle-task-status').onclick = () => { task.status = task.status === 'done' ? 'todo' : 'done'; state.selectedTaskId = null; render(); persist(); };
    document.querySelector('#task-form').onsubmit = event => {
      event.preventDefault(); const form = new FormData(event.currentTarget); const date = String(form.get('date') || ''); if (!date) return;
      Object.assign(task, { title: String(form.get('title')).trim(), description: String(form.get('description')).trim(), date, project: String(form.get('project')).trim(), labels: String(form.get('labels')).split(',').map(label => label.trim()).filter(Boolean), priorityOrder: Number(form.get('priorityOrder')) || 0 });
      state.selectedDate = task.date; state.selectedTaskId = null; render(); persist();
    };
  } else {
    const tasks = tasksForDate(state.selectedDate);
    content.innerHTML = `<div class="panel-heading"><div><p class="section-label">Tasks on</p><h2>${formatPanelDate(state.selectedDate)}</h2></div><button class="close-panel" id="close-task-panel" aria-label="Close task panel">×</button></div><div class="date-task-list">${tasks.length ? tasks.map(task => `<button class="task-list-item ${task.status === 'done' ? 'done' : ''}" data-task-id="${escapeHtml(task.id)}" draggable="true"><span class="task-list-dot" style="--task-color:${taskColor(task)}"></span><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.project || 'No project')} · ${escapeHtml(task.id)}</small></span></button>`).join('') : '<p class="empty-tasks">No tasks scheduled for this date.</p>'}</div><button id="new-task" class="new-task-button">Add task</button>`;
    document.querySelectorAll('.task-list-item').forEach(button => button.onclick = () => openTask(button.dataset.taskId));
    document.querySelectorAll('.task-list-item').forEach(button => {
      button.ondragstart = event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', button.dataset.taskId); button.classList.add('dragging'); };
      button.ondragend = () => document.querySelectorAll('.task-list-item').forEach(item => item.classList.remove('dragging', 'drag-over'));
      button.ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; button.classList.add('drag-over'); };
      button.ondragleave = () => button.classList.remove('drag-over');
      button.ondrop = event => { event.preventDefault(); reorderTasks(state.selectedDate, event.dataTransfer.getData('text/plain'), button.dataset.taskId); };
    });
    document.querySelector('#new-task').onclick = () => { const task = { id: newTaskId(), title: 'Untitled task', description: '', date: state.selectedDate, labels: [], project: '', priorityOrder: nextPriority(state.selectedDate), status: 'todo' }; state.tasks.push(task); openTask(task.id); render(); persist(); document.querySelector('#task-form [name="title"]')?.select(); };
  }
  document.querySelector('#close-task-panel').onclick = closeTaskPanel;
}
function render() { renderControls(); renderWeather(); renderCalendar(); renderTaskPanel(); }

document.querySelector('#previous-week').onclick = () => changeStart(-7);
document.querySelector('#next-week').onclick = () => changeStart(7);
document.querySelector('#task-mode').onclick = () => { state.mode = 'task'; renderControls(); persist(); };
document.querySelector('#context-mode').onclick = () => { state.mode = 'context'; renderControls(); persist(); };
document.querySelector('#decrease-weeks').onclick = () => setWeeks(state.weeks - 1);
document.querySelector('#increase-weeks').onclick = () => setWeeks(state.weeks + 1);
document.querySelector('#start-date').onchange = event => { if (event.target.value) { state.startDate = sundayOf(parseDate(event.target.value)); render(); persist(); } };
document.querySelector('#weather-form').onsubmit = event => { event.preventDefault(); loadWeather(document.querySelector('#weather-zip').value); };
document.querySelectorAll('[data-temperature-mode]').forEach(button => button.onclick = () => { state.weather.temperatureMode = button.dataset.temperatureMode; render(); persist(); });
document.querySelector('#new-context').onsubmit = event => { event.preventDefault(); const title = document.querySelector('#title-input').value.trim(); if (!title) return; const id = `context-${Date.now()}`; state.contexts.push({ id, title, emoji: document.querySelector('#emoji-input').value.trim() || '📌', hue: state.draftHue }); state.active = id; document.querySelector('#title-input').value = ''; state.draftHue = HUES[(HUES.indexOf(state.draftHue) + 1) % HUES.length]; render(); persist(); };
const emojiTrigger = document.querySelector('#emoji-trigger');
const emojiPicker = document.querySelector('#emoji-picker');
emojiTrigger.onclick = () => emojiPicker.classList.toggle('open');
emojiPicker.addEventListener('emoji-click', event => { document.querySelector('#emoji-input').value = event.detail.unicode; emojiTrigger.textContent = event.detail.unicode; emojiPicker.classList.remove('open'); });
document.addEventListener('click', event => { if (!event.target.closest('.emoji-picker-wrap')) emojiPicker.classList.remove('open'); });
document.addEventListener('pointermove', movePaint);
document.addEventListener('pointerup', commitPaint);
document.addEventListener('pointercancel', cancelPaint);
document.addEventListener('mouseup', () => { if (dragPointerId === 'mouse') commitPaint(); });
document.querySelector('#task-panel-scrim').onclick = closeTaskPanel;
render();
