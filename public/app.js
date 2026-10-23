const $ = id => document.getElementById(id);
const store = {
  get: (k, d = '') => { try { return sessionStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
  remove: k => { try { sessionStorage.removeItem(k); } catch {} }
};
let backendUrl = store.get('jarvis.backend', location.origin).replace(/\/+$/, '');
let voiceReplies = store.get('jarvis.voiceReplies', 'true') === 'true';
let recognition = null;
let handsFree = false;
let pushToTalkActive = false;
let wakeWordArmed = false;
let speaking = false;
let busy = false;
let restartRequested = false;
let voiceRestartAttempts = 0;
let messages = [];

$('backend-url').value = backendUrl;

function logActivity(text) {
  const p = document.createElement('p');
  p.textContent = new Date().toLocaleTimeString() + '  ' + text;
  $('activity-log').prepend(p);
  while ($('activity-log').children.length > 8) $('activity-log').lastElementChild.remove();
}
function setNotice(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
}
async function api(path, options = {}) {
  const { timeoutMs = 8000, ...fetchOptions } = options;
  const headers = { ...(fetchOptions.headers || {}) };
  if (fetchOptions.body) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(backendUrl + path, { ...fetchOptions, headers, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'Request failed (' + response.status + ')');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Error('Backend request timed out after ' + Math.round(timeoutMs / 1000) + ' seconds. Check the connection and try again.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
async function diagnostics() {
  try {
    const d = await api('/api/status');
    $('endpoint-status').textContent = 'ONLINE';
    $('config-status').textContent = d.aiConfigured ? 'CONFIGURED' : 'NO API KEY';
    $('ai-status').textContent = d.aiConfigured ? 'CONFIGURED' : 'NEEDS KEY';
    $('cloud-dot').classList.toggle('dot-off', !d.aiConfigured);
    $('connection-label').textContent = d.aiConfigured ? 'CLOUD CONFIGURED' : 'API KEY NEEDED';
    logActivity('Backend checked: ' + (d.aiConfigured ? 'Gemini configured' : 'Gemini key missing'));
  } catch (e) {
    $('endpoint-status').textContent = 'OFFLINE';
    $('config-status').textContent = 'UNKNOWN';
    $('ai-status').textContent = 'OFFLINE';
    $('cloud-dot').classList.add('dot-off');
    $('connection-label').textContent = 'BACKEND OFFLINE';
    setNotice(e.message, true);
    logActivity('Backend check failed: ' + e.message);
  }
  const supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  $('speech-api-status').textContent = supported ? 'AVAILABLE' : 'UNSUPPORTED';
  $('voice-status').textContent = supported ? 'AVAILABLE' : 'UNSUPPORTED';
  $('voice-dot').classList.toggle('dot-off', !supported);
  $('ptt-button').disabled = !supported;
  $('handsfree-button').disabled = !supported;
}
function addMessage(role, content) {
  const el = document.createElement('div');
  el.className = 'message ' + role;
  const tag = document.createElement('span');
  tag.className = 'message-tag';
  tag.textContent = role === 'assistant' ? 'J.A.R.V.I.S.' : 'YOU';
  const p = document.createElement('p');
  p.textContent = content;
  el.append(tag, p);
  $('chat-log').append(el);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
}
function speak(text) {
  if (!('speechSynthesis' in window) || !voiceReplies) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.02;
  utterance.pitch = 0.95;
  utterance.onstart = () => {
    speaking = true;
    if (handsFree && recognition) {
      restartRequested = true;
      try { recognition.stop(); } catch {}
    }
  };
  utterance.onend = utterance.onerror = () => {
    speaking = false;
    if (handsFree && restartRequested) {
      restartRequested = false;
      startRecognition();
    }
  };
  speechSynthesis.speak(utterance);
}
const LOCAL_TASKS_KEY = 'jarvis.localTasks';
const taskStore = {
  get(key, fallback = null) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch {} }
};
let localTasks = [];
try {
  const saved = taskStore.get(LOCAL_TASKS_KEY);
  // One-time migration from the earlier tab-session-only task store.
  const legacy = saved === null ? store.get(LOCAL_TASKS_KEY, '[]') : '[]';
  const parsed = JSON.parse(saved === null ? legacy : saved);
  if (Array.isArray(parsed)) localTasks = parsed.filter(task =>
    task && typeof task.id === 'string' && ['timer', 'reminder'].includes(task.kind) &&
    typeof task.label === 'string' && Number.isFinite(task.endAt)
  ).slice(0, 50);
  if (saved === null && localTasks.length) taskStore.set(LOCAL_TASKS_KEY, JSON.stringify(localTasks));
} catch { localTasks = []; }

function saveLocalTasks() {
  if (!taskStore.set(LOCAL_TASKS_KEY, JSON.stringify(localTasks))) {
    setNotice('Could not save timers in this browser. Check storage settings.', true);
  }
}
function formatDuration(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h ? h + 'h' : '', m ? m + 'm' : '', s || (!h && !m) ? s + 's' : ''].filter(Boolean).join(' ');
}
function requestTaskNotifications() {
  if (!('Notification' in window)) {
    setNotice('This browser does not support desktop notifications. Keep J.A.R.V.I.S. open for on-screen and voice alerts.', true);
    return;
  }
  if (Notification.permission === 'granted') {
    setNotice('Desktop notifications are already enabled.');
    return;
  }
  if (Notification.permission === 'denied') {
    setNotice('Notifications are blocked by the browser. Allow them in this site’s settings.', true);
    return;
  }
  Notification.requestPermission().then(permission => {
    setNotice(permission === 'granted'
      ? 'Desktop notifications enabled.'
      : 'Notification permission was not granted. On-screen and voice alerts still work while this page is open.',
      permission !== 'granted');
    renderLocalTasks();
  }).catch(() => setNotice('Could not request notification permission in this browser.', true));
}
function renderLocalTasks() {
  const list = $('task-list');
  const notificationButton = $('task-notifications');
  const now = Date.now();
  if (notificationButton && 'Notification' in window) {
    notificationButton.textContent = Notification.permission === 'granted' ? 'NOTIFICATIONS ON' : 'ENABLE NOTIFICATIONS';
    notificationButton.disabled = Notification.permission === 'granted';
  }
  if (list) {
    list.replaceChildren();
    const sorted = [...localTasks].sort((a, b) => a.endAt - b.endAt);
    if (!sorted.length) {
      const empty = document.createElement('p');
      empty.className = 'task-empty';
      empty.textContent = 'No active timers. Try “set a timer for 5 minutes” or “remind me in 10 minutes to check the laundry”.';
      list.append(empty);
    }
    for (const task of sorted) {
      const item = document.createElement('div');
      item.className = 'task-item';
      const details = document.createElement('div');
      details.className = 'task-details';
      const title = document.createElement('strong');
      title.textContent = (task.kind === 'reminder' ? 'REMINDER' : 'TIMER') + ' · ' + task.label;
      const remaining = document.createElement('small');
      remaining.textContent = task.endAt <= now ? 'DUE — alerting now' : formatDuration(task.endAt - now) + ' remaining';
      details.append(title, remaining);
      if (Number.isFinite(task.repeatMs) && task.repeatMs >= 1000) {
        const repeat = document.createElement('small');
        repeat.textContent = 'REPEATS EVERY ' + formatDuration(task.repeatMs);
        details.append(repeat);
      }
      const actions = document.createElement('div');
      actions.className = 'task-actions';
      const snooze = document.createElement('button');
      snooze.type = 'button';
      snooze.className = 'task-snooze';
      snooze.dataset.taskAction = 'snooze';
      snooze.dataset.taskId = task.id;
      snooze.textContent = 'SNOOZE 5M';
      snooze.setAttribute('aria-label', 'Snooze ' + task.kind + ': ' + task.label + ' for five minutes');
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'task-cancel';
      cancel.dataset.taskAction = 'cancel';
      cancel.dataset.taskId = task.id;
      cancel.textContent = 'CANCEL';
      cancel.setAttribute('aria-label', 'Cancel ' + task.kind + ': ' + task.label);
      actions.append(snooze, cancel);
      item.append(details, actions);
      list.append(item);
    }
  }
  const timerLabel = $('timer-status');
  if (timerLabel) timerLabel.textContent = localTasks.length
    ? localTasks.length + ' active local task' + (localTasks.length === 1 ? '' : 's')
    : 'No active timers';
}
function notifyTask(task) {
  const message = (task.kind === 'reminder' ? 'Reminder: ' : 'Timer finished: ') + task.label;
  logActivity(message);
  setNotice(message);
  speak(message);
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('J.A.R.V.I.S. Mark II', { body: message, tag: 'jarvis-task-' + task.id }); } catch {}
  }
}
function localTaskTick() {
  const now = Date.now();
  const due = localTasks.filter(task => task.endAt <= now);
  if (due.length) {
    const dueIds = new Set(due.map(task => task.id));
    localTasks = localTasks.filter(task => !dueIds.has(task.id) || (Number.isFinite(task.repeatMs) && task.repeatMs >= 1000));
    for (const task of due) {
      if (Number.isFinite(task.repeatMs) && task.repeatMs >= 1000) {
        // Skip missed intervals in O(1) time so long-suspended tabs cannot trigger a huge loop.
        const missedIntervals = Math.floor((now - task.endAt) / task.repeatMs) + 1;
        task.endAt += missedIntervals * task.repeatMs;
      }
      notifyTask(task);
    }
    saveLocalTasks();
  }
  renderLocalTasks();
}
$('task-notifications')?.addEventListener('click', requestTaskNotifications);
$('task-list')?.addEventListener('click', event => {
  const button = event.target.closest('button[data-task-id][data-task-action]');
  if (!button) return;
  const task = localTasks.find(item => item.id === button.dataset.taskId);
  if (!task) return;
  if (button.dataset.taskAction === 'snooze') {
    task.endAt = Date.now() + 5 * 60 * 1000;
    saveLocalTasks();
    renderLocalTasks();
    const message = 'Snoozed ' + task.kind + ': ' + task.label + ' for five minutes.';
    setNotice(message);
    logActivity(message);
    return;
  }
  if (button.dataset.taskAction !== 'cancel') return;
  localTasks = localTasks.filter(item => item.id !== task.id);
  saveLocalTasks();
  renderLocalTasks();
  const message = 'Cancelled ' + task.kind + ': ' + task.label + '.';
  setNotice(message);
  logActivity(message);
});

const weatherDescriptions = {
  0: 'Clear sky', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle',
  55: 'Heavy drizzle', 56: 'Light freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Light freezing rain',
  67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow grains', 80: 'Light rain showers', 81: 'Rain showers',
  82: 'Heavy rain showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with small hail', 99: 'Thunderstorm with heavy hail'
};
function weatherDescription(code) {
  return weatherDescriptions[Number(code)] || 'Conditions unavailable';
}
function isWeatherRequest(text) {
  return /\b(weather|forecast|temperature|is it raining|will it rain|rain today|snow today)\b/i.test(text);
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('The weather service took too long to respond. Check your connection and try again.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
async function geocodeWeatherLocation(name) {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search = new URLSearchParams({ name, count: '1', language: 'en', format: 'json' });
  const response = await fetchWithTimeout(url, {}, 10000);
  if (!response.ok) throw new Error('The location search service is unavailable.');
  const data = await response.json();
  if (!data.results?.length) throw new Error('I could not find that location. Try a city and state, such as Mineola, New York.');
  return data.results[0];
}
function getBrowserCoordinates() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser does not support location access.'));
    navigator.geolocation.getCurrentPosition(
      position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, name: 'Your current location' }),
      error => reject(new Error(error.code === 1 ? 'Location permission was denied.' : 'Your current location could not be determined.')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  });
}
let weatherRequestId = 0;
async function fetchWeather(locationQuery = '') {
  const requestId = ++weatherRequestId;
  let place;
  if (locationQuery.trim()) {
    place = await geocodeWeatherLocation(locationQuery.trim());
  } else {
    try {
      place = await getBrowserCoordinates();
    } catch (error) {
      const savedLocation = $('weather-location')?.value.trim();
      if (!savedLocation) throw new Error(error.message + ' Enter a city in the Weather panel and try again.');
      place = await geocodeWeatherLocation(savedLocation);
    }
  }
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: 'auto',
    forecast_days: '1'
  });
  const response = await fetchWithTimeout('https://api.open-meteo.com/v1/forecast?' + params.toString(), {}, 12000);
  if (!response.ok) throw new Error('The weather service did not respond successfully. Try again shortly.');
  const data = await response.json();
  if (!data.current || !data.daily) throw new Error('The weather service returned incomplete data.');
  const locationName = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
  const current = data.current;
  const daily = data.daily;
  const result = 'Weather for ' + locationName + ': ' + weatherDescription(current.weather_code) +
    ', ' + Math.round(current.temperature_2m) + '°F, feels like ' + Math.round(current.apparent_temperature) + '°F. ' +
    'Today: high ' + Math.round(daily.temperature_2m_max[0]) + '°F, low ' + Math.round(daily.temperature_2m_min[0]) + '°F' +
    (daily.precipitation_probability_max?.[0] != null ? ', precipitation chance up to ' + daily.precipitation_probability_max[0] + '%' : '') +
    '. Wind ' + Math.round(current.wind_speed_10m) + ' mph; humidity ' + Math.round(current.relative_humidity_2m) + '%.';
  if (requestId !== weatherRequestId) return null;
  const output = $('weather-output');
  if (output) output.textContent = result;
  const status = $('weather-status');
  if (status) status.textContent = 'UPDATED ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  logActivity('Weather updated for ' + (place.name || 'current location') + '.');
  return result;
}
async function refreshWeather() {
  const button = $('weather-refresh');
  if (button) button.disabled = true;
  const output = $('weather-output');
  if (output) output.textContent = 'Fetching local weather…';
  try {
    const result = await fetchWeather($('weather-location')?.value.trim() || '');
    if (result === null) return; // A newer weather request has taken over.
    setNotice('Weather updated.');
    if (output) output.textContent = result;
  } catch (error) {
    if (output) output.textContent = error.message;
    setNotice(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function localTaskIntent(text) {
  const q = text.toLowerCase().replace(/[’']/g, '').trim();
  const asksTime = /\b(what time is it|current time|tell me the time|time right now|local time)\b/.test(q);
  const asksDate = /\b(what(?:s| is) todays date|current date|what day is it|todays date|date today)\b/.test(q);
  if (asksTime || asksDate) {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    const date = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    if (asksTime && asksDate) return 'It is ' + time + ' on ' + date + '.';
    if (asksDate) return 'Today is ' + date + '.';
    return 'The current time on this device is ' + time + '.';
  }

  if (/\b(list|show|check) (my )?(timers|reminders|active timers|active reminders)\b/.test(q) || /\bhow many (timers|reminders)\b/.test(q)) {
    if (!localTasks.length) return 'You have no active timers or reminders.';
    return 'You have ' + localTasks.length + ' active local task' + (localTasks.length === 1 ? ': ' : 's: ') +
      localTasks.map(task => task.kind + ' “' + task.label + '” in ' + formatDuration(task.endAt - Date.now())).join('; ') + '.';
  }
  if (/\b(cancel|clear|stop) (all )?(my )?(timers|reminders|timer|reminder)\b/.test(q)) {
    const count = localTasks.length;
    localTasks = [];
    saveLocalTasks();
    return count ? 'Cancelled ' + count + ' active timer or reminder' + (count === 1 ? '' : 's') + '.' : 'There are no active timers or reminders to cancel.';
  }

  const durationPattern = '(\\d+(?:\\.\\d+)?)\\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|m|s)\\b';
  const recurringMatch = q.match(new RegExp('\\bremind me every\\s+' + durationPattern + '(?:\\s+to\\s+(.+))?'));
  const reminderMatch = q.match(new RegExp('\\bremind me in\\s+' + durationPattern + '(?:\\s+to\\s+(.+))?'));
  const timerMatch = q.match(new RegExp('\\b(?:set|start|create) (?:a )?timer (?:for\\s+)?' + durationPattern));
  const match = recurringMatch || reminderMatch || timerMatch;
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const multiplier = /^h|hour|hr/.test(unit) ? 3600000 : /^m|min/.test(unit) ? 60000 : 1000;
    const durationMs = amount * multiplier;
    if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 7 * 24 * 3600000) {
      return 'Choose a duration between 1 second and 7 days.';
    }
    const isReminder = !!(recurringMatch || reminderMatch);
    const isRecurring = !!recurringMatch;
    const label = isReminder ? ((match[3] || '').trim() || 'your reminder') : 'your timer';
    const task = {
      id: String(Date.now()) + Math.random().toString(36).slice(2, 7),
      kind: isReminder ? 'reminder' : 'timer',
      label,
      endAt: Date.now() + durationMs,
      ...(isRecurring ? { repeatMs: durationMs } : {})
    };
    if (localTasks.length >= 50) return 'You have reached the limit of 50 active timers and reminders. Cancel one before adding another.';
    localTasks.push(task);
    saveLocalTasks();
    renderLocalTasks();
    if (isRecurring) {
      return 'Recurring reminder set every ' + formatDuration(durationMs) +
        (match[3] ? ' to ' + label : '.') + ' I’ll alert you while this page is open; cancel it from the dashboard to stop repeats.';
    }
    return (isReminder ? 'Reminder set' : 'Timer started') + ' for ' + formatDuration(durationMs) +
      (isReminder && match[3] ? ': ' + label : '.') + ' I’ll alert you while this page is open; saved tasks remain listed if you return later.';
  }
  return null;
}
async function sendChat(content) {
  const text = String(content || '').trim();
  if (!text || busy) {
    if (busy && text) setNotice('I’m still processing the previous request. Please try again in a moment.');
    return;
  }
  if (isWeatherRequest(text)) {
    busy = true;
    $('chat-state').textContent = 'LOCAL WEATHER';
    $('message-input').disabled = true;
    addMessage('user', text);
    messages.push({ role: 'user', content: text });
    try {
      const locationMatch = text.match(/\b(?:weather|forecast|temperature)\s+(?:in|for)\s+([^?!.]+)(?:[?!.]|$)/i);
      const locationQuery = locationMatch?.[1]?.trim() || '';
      const weatherReply = await fetchWeather(locationQuery);
      messages.push({ role: 'assistant', content: weatherReply });
      addMessage('assistant', weatherReply);
      setNotice('Weather retrieved directly from the weather service.');
      speak(weatherReply);
    } catch (error) {
      // Do not retain a failed user-only turn in Gemini history.
      if (messages.at(-1)?.role === 'user' && messages.at(-1)?.content === text) messages.pop();
      addMessage('assistant', 'I could not retrieve the weather. ' + error.message);
      setNotice(error.message, true);
      logActivity('Weather lookup failed: ' + error.message);
    } finally {
      busy = false;
      $('chat-state').textContent = 'STANDBY';
      $('message-input').disabled = false;
      if (!pushToTalkActive) $('message-input').focus();
    }
    return;
  }
  const localReply = localTaskIntent(text);
  if (localReply) {
    busy = true;
    $('chat-state').textContent = 'LOCAL';
    addMessage('user', text);
    messages.push({ role: 'user', content: text });
    messages.push({ role: 'assistant', content: localReply });
    addMessage('assistant', localReply);
    setNotice('Handled locally by your browser. No Gemini request needed.');
    logActivity('Local tool handled request in browser.');
    speak(localReply);
    busy = false;
    $('chat-state').textContent = 'STANDBY';
    $('message-input').disabled = false;
    if (!pushToTalkActive) $('message-input').focus();
    return;
  }
  busy = true;
  const requestStartedAt = performance.now();
  $('chat-state').textContent = 'PROCESSING';
  setNotice('Sending request to J.A.R.V.I.S.…');
  $('message-input').disabled = true;
  addMessage('user', text);
  messages.push({ role: 'user', content: text });
  try {
    const d = await api('/api/chat', { method: 'POST', timeoutMs: 22000, body: JSON.stringify({ messages: messages.slice(-8) }) });
    if (typeof d.reply !== 'string' || !d.reply.trim()) throw Error('The assistant returned an empty response.');
    messages.push({ role: 'assistant', content: d.reply });
    addMessage('assistant', d.reply);
    const roundTripMs = Math.round(performance.now() - requestStartedAt);
    logActivity('AI response in ' + roundTripMs + ' ms' + (Number.isFinite(d.elapsedMs) ? ' (provider ' + d.elapsedMs + ' ms)' : ''));
    setNotice('Response in ' + (roundTripMs / 1000).toFixed(1) + 's' + (Number.isFinite(d.elapsedMs) ? ' · AI took ' + (d.elapsedMs / 1000).toFixed(1) + 's' : '') + '.');
    speak(d.reply);
  } catch (e) {
    // Remove the unanswered turn so the next Gemini request starts with valid chat history.
    if (messages.at(-1)?.role === 'user' && messages.at(-1)?.content === text) messages.pop();
    addMessage('assistant', 'I could not complete that request. ' + e.message);
    setNotice(e.message, true);
    logActivity('Chat failed after ' + Math.round(performance.now() - requestStartedAt) + ' ms: ' + e.message);
  } finally {
    busy = false;
    $('chat-state').textContent = 'STANDBY';
    $('message-input').disabled = false;
    if (!pushToTalkActive) $('message-input').focus();
  }
}
$('chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const value = $('message-input').value;
  $('message-input').value = '';
  sendChat(value);
});
$('message-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('chat-form').requestSubmit();
  }
});
$('settings-button').addEventListener('click', () => {
  $('settings-panel').hidden = !$('settings-panel').hidden;
  $('settings-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('save-settings').addEventListener('click', async () => {
  const rawUrl = $('backend-url').value.trim();
  let parsed;
  try { parsed = new URL(rawUrl); } catch {
    return setNotice('Enter a valid backend origin, such as https://your-service.onrender.com.', true);
  }
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!['http:', 'https:'].includes(parsed.protocol) ||
      (parsed.protocol !== 'https:' && !localHost) ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return setNotice('Use a backend origin only (no path, query, or credentials). HTTPS is required except for localhost development.', true);
  }
  backendUrl = parsed.origin;
  store.set('jarvis.backend', backendUrl);
  $('backend-url').value = backendUrl;
  setNotice('Settings saved. Testing connection…');
  await diagnostics();
});
$('clear-settings').addEventListener('click', () => {
  store.remove('jarvis.backend');
  backendUrl = location.origin;
  $('backend-url').value = backendUrl;
  diagnostics();
});
$('refresh-status').addEventListener('click', diagnostics);
$('weather-refresh').addEventListener('click', refreshWeather);

$('speak-toggle').classList.toggle('active', voiceReplies);
$('speak-toggle').textContent = voiceReplies ? '♫ VOICE REPLIES ON' : '♫ VOICE REPLIES OFF';
$('speak-toggle').setAttribute('aria-pressed', String(voiceReplies));
$('speak-toggle').addEventListener('click', () => {
  voiceReplies = !voiceReplies;
  store.set('jarvis.voiceReplies', String(voiceReplies));
  $('speak-toggle').classList.toggle('active', voiceReplies);
  $('speak-toggle').textContent = voiceReplies ? '♫ VOICE REPLIES ON' : '♫ VOICE REPLIES OFF';
  $('speak-toggle').setAttribute('aria-pressed', String(voiceReplies));
  if (!voiceReplies && 'speechSynthesis' in window) speechSynthesis.cancel();
});

function updateVoiceUi() {
  $('ptt-button').textContent = pushToTalkActive ? '■ STOP LISTENING' : '◉ PUSH TO TALK';
  $('ptt-button').classList.toggle('active', pushToTalkActive);
  $('ptt-button').setAttribute('aria-pressed', String(pushToTalkActive));
  $('handsfree-button').textContent = handsFree ? '⌁ DISABLE HANDS-FREE' : '⌁ ENABLE HANDS-FREE';
  $('handsfree-button').classList.toggle('active', handsFree);
  $('handsfree-button').setAttribute('aria-pressed', String(handsFree));
  $('mic-status').textContent = pushToTalkActive || handsFree ? 'LISTENING' : 'READY';
  $('mode-status').textContent = handsFree ? 'HANDS-FREE' : pushToTalkActive ? 'PUSH-TO-TALK' : 'TEXT';
}
function handleHandsFreePhrase(phrase) {
  const spoken = phrase.trim();
  if (!spoken) return;
  const wakeMatch = spoken.match(/\bjarvis\b[\s,:-]*(.*)$/i);
  if (wakeMatch) {
    const command = wakeMatch[1].trim();
    if (command) {
      wakeWordArmed = false;
      setNotice('Wake phrase detected. Sending command…');
      sendChat(command);
    } else {
      wakeWordArmed = true;
      setNotice('I’m listening. Say “Jarvis” followed by a command, or say the command now.');
    }
    return;
  }
  if (wakeWordArmed) {
    wakeWordArmed = false;
    setNotice('Command recognized. Sending…');
    sendChat(spoken);
  }
}
function makeRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const r = new SpeechRecognition();
  r.lang = 'en-US';
  r.interimResults = true;
  r.continuous = false;
  let finalTranscript = '';
  r.onstart = () => {
    $('mic-status').textContent = 'LISTENING';
    $('mode-status').textContent = handsFree ? 'HANDS-FREE' : 'PUSH-TO-TALK';
    $('voice-status').textContent = 'LISTENING';
    setNotice(handsFree ? 'Hands-free active. Say “Jarvis” and your request.' : 'Listening… speak your command, then pause.');
  };
  r.onresult = event => {
    let interim = '';
    let latestFinal = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript.trim();
      if (result.isFinal && transcript) {
        finalTranscript += (finalTranscript ? ' ' : '') + transcript;
        latestFinal += (latestFinal ? ' ' : '') + transcript;
      } else if (!result.isFinal) {
        interim += transcript;
      }
    }
    if (handsFree) {
      if (latestFinal) {
        voiceRestartAttempts = 0;
        handleHandsFreePhrase(latestFinal);
      }
    } else {
      $('message-input').value = (finalTranscript + (interim ? ' ' + interim : '')).trim();
    }
  };
  r.onerror = event => {
    const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error);
    $('mic-status').textContent = event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'PERMISSION DENIED' : 'VOICE ERROR';
    $('voice-status').textContent = fatal ? 'CHECK MIC' : 'RETRYING';
    setNotice('Speech recognition error: ' + event.error + (event.error === 'not-allowed' ? '. Allow microphone access for this site.' : ''), true);
    logActivity('Speech recognition error: ' + event.error);
    if (fatal) {
      handsFree = false;
      pushToTalkActive = false;
      wakeWordArmed = false;
      updateVoiceUi();
    }
  };
  r.onend = () => {
    if (handsFree && !speaking) {
      // Browser speech sessions can end during silence or transient network errors.
      // Back off to avoid rapid restart loops, while keeping hands-free available.
      voiceRestartAttempts = Math.min(voiceRestartAttempts + 1, 5);
      const retryDelay = Math.min(350 * (2 ** (voiceRestartAttempts - 1)), 5000);
      $('voice-status').textContent = 'RETRYING';
      window.setTimeout(() => {
        if (handsFree && !speaking) startRecognition();
      }, retryDelay);
      return;
    }
    if (pushToTalkActive) {
      pushToTalkActive = false;
      updateVoiceUi();
      const command = finalTranscript.trim();
      if (command) {
        $('message-input').value = '';
        sendChat(command);
      } else {
        setNotice('No speech detected. Press Push to Talk and try again.', true);
      }
    } else if (!handsFree) {
      updateVoiceUi();
      $('voice-status').textContent = 'AVAILABLE';
    }
  };
  r.__resetTranscript = () => { finalTranscript = ''; };
  return r;
}
function startRecognition() {
  if (!recognition || speaking) return;
  try {
    recognition.__resetTranscript?.();
    recognition.start();
  } catch (e) {
    // InvalidStateError means the browser still considers the previous session active.
    if (e.name !== 'InvalidStateError') setNotice('Could not start listening. Check microphone permission and try again.', true);
  }
}
$('ptt-button').addEventListener('click', () => {
  if (pushToTalkActive) {
    // Let onend collect and submit any final transcript before the UI resets.
    try { recognition?.stop(); } catch {}
    return;
  }
  if (handsFree) {
    handsFree = false;
    wakeWordArmed = false;
    if (recognition) recognition.continuous = false;
    try { recognition?.stop(); } catch {}
    updateVoiceUi();
    setNotice('Hands-free stopped. Press Push to Talk again to start a separate voice session.');
    return;
  }
  if (!recognition) recognition = makeRecognition();
  if (!recognition) return setNotice('Speech recognition is unsupported. Use a current version of Chrome or Edge.', true);
  recognition.continuous = false;
  pushToTalkActive = true;
  updateVoiceUi();
  startRecognition();
});
$('handsfree-button').addEventListener('click', () => {
  if (handsFree) {
    handsFree = false;
    wakeWordArmed = false;
    restartRequested = false;
    if (recognition) recognition.continuous = false;
    try { recognition?.stop(); } catch {}
    updateVoiceUi();
    setNotice('Hands-free stopped.');
    return;
  }
  if (pushToTalkActive) {
    try { recognition?.stop(); } catch {}
    setNotice('Finishing the push-to-talk recording. Enable hands-free again in a moment.');
    return;
  }
  if (!recognition) recognition = makeRecognition();
  if (!recognition) return setNotice('Speech recognition is unsupported in this browser. Try current Chrome or Edge.', true);
  handsFree = true;
  recognition.continuous = true;
  wakeWordArmed = false;
  updateVoiceUi();
  setNotice('Starting hands-free. Keep this tab open and allow microphone access.');
  startRecognition();
});

function tick() { $('clock').textContent = new Date().toLocaleTimeString(); }
tick();
window.setInterval(tick, 1000);
localTaskTick();
window.setInterval(localTaskTick, 1000);
diagnostics();
// Automatically request browser location and load local weather on dashboard startup.
// If permission is denied or unavailable, the Weather panel explains the manual-city fallback.
$('weather-status').textContent = 'LOCATING…';
refreshWeather();
