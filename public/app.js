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
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(backendUrl + path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || 'Request failed (' + response.status + ')');
  return data;
}
async function diagnostics() {
  try {
    const d = await api('/api/status');
    $('endpoint-status').textContent = 'ONLINE';
    $('config-status').textContent = d.aiConfigured ? 'CONFIGURED' : 'NO API KEY';
    $('ai-status').textContent = d.aiConfigured ? 'READY' : 'NEEDS KEY';
    $('cloud-dot').classList.toggle('dot-off', !d.aiConfigured);
    $('connection-label').textContent = d.aiConfigured ? 'CLOUD LINK READY' : 'API KEY NEEDED';
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
let localTasks = [];
try { localTasks = JSON.parse(store.get(LOCAL_TASKS_KEY, '[]')); } catch { localTasks = []; }
if (!Array.isArray(localTasks)) localTasks = [];

function saveLocalTasks() {
  store.set(LOCAL_TASKS_KEY, JSON.stringify(localTasks));
}
function formatDuration(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h ? h + 'h' : '', m ? m + 'm' : '', s || (!h && !m) ? s + 's' : ''].filter(Boolean).join(' ');
}
function notifyTask(task) {
  const message = (task.kind === 'reminder' ? 'Reminder: ' : 'Timer finished: ') + task.label;
  logActivity(message);
  setNotice(message);
  speak(message);
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('J.A.R.V.I.S. Mark II', { body: message }); } catch {}
  }
}
function localTaskTick() {
  const now = Date.now();
  const due = localTasks.filter(task => task.endAt <= now);
  if (due.length) {
    const dueIds = new Set(due.map(task => task.id));
    localTasks = localTasks.filter(task => !dueIds.has(task.id));
    saveLocalTasks();
    due.forEach(notifyTask);
  }
  const timers = localTasks.length;
  const timerLabel = $('timer-status');
  if (timerLabel) timerLabel.textContent = timers ? timers + ' active local task' + (timers === 1 ? '' : 's') : 'Browser-local timers';
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
  const reminderMatch = q.match(new RegExp('\\bremind me in\\s+' + durationPattern + '(?:\\s+to\\s+(.+))?'));
  const timerMatch = q.match(new RegExp('\\b(?:set|start|create) (?:a )?timer (?:for\\s+)?' + durationPattern));
  const match = reminderMatch || timerMatch;
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const multiplier = /^h|hour|hr/.test(unit) ? 3600000 : /^m|min/.test(unit) ? 60000 : 1000;
    const durationMs = amount * multiplier;
    if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 7 * 24 * 3600000) {
      return 'Choose a duration between 1 second and 7 days.';
    }
    const isReminder = !!reminderMatch;
    const label = isReminder ? ((match[3] || '').trim() || 'your reminder') : 'your timer';
    const task = { id: String(Date.now()) + Math.random().toString(36).slice(2, 7), kind: isReminder ? 'reminder' : 'timer', label, endAt: Date.now() + durationMs };
    localTasks.push(task);
    saveLocalTasks();
    return (isReminder ? 'Reminder set' : 'Timer started') + ' for ' + formatDuration(durationMs) +
      (isReminder && match[3] ? ': ' + label : '.') + ' I’ll notify you while this page remains open.';
  }
  return null;
}
async function sendChat(content) {
  const text = String(content || '').trim();
  if (!text || busy) {
    if (busy && text) setNotice('I’m still processing the previous request. Please try again in a moment.');
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
    const d = await api('/api/chat', { method: 'POST', body: JSON.stringify({ messages: messages.slice(-8) }) });
    if (typeof d.reply !== 'string' || !d.reply.trim()) throw Error('The assistant returned an empty response.');
    messages.push({ role: 'assistant', content: d.reply });
    addMessage('assistant', d.reply);
    const roundTripMs = Math.round(performance.now() - requestStartedAt);
    logActivity('AI response in ' + roundTripMs + ' ms' + (Number.isFinite(d.elapsedMs) ? ' (provider ' + d.elapsedMs + ' ms)' : ''));
    setNotice('Response in ' + (roundTripMs / 1000).toFixed(1) + 's' + (Number.isFinite(d.elapsedMs) ? ' · AI took ' + (d.elapsedMs / 1000).toFixed(1) + 's' : '') + '.');
    speak(d.reply);
  } catch (e) {
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
  const url = $('backend-url').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) return setNotice('Enter a valid backend URL starting with http:// or https://.', true);
  backendUrl = url;
  store.set('jarvis.backend', backendUrl);
  setNotice('Settings saved. Testing connection…');
  await diagnostics();
});
$('clear-settings').addEventListener('click', () => {
  store.remove('jarvis.backend');
  backendUrl = location.origin;
  accessToken = '';
  $('backend-url').value = backendUrl;
  diagnostics();
});
$('refresh-status').addEventListener('click', diagnostics);

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
      if (latestFinal) handleHandsFreePhrase(latestFinal);
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
      // Chrome can end a recognition session even in continuous mode. Restart safely.
      window.setTimeout(() => {
        if (handsFree && !speaking) startRecognition();
      }, 350);
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
