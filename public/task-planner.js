'use strict';

(() => {
  const data = window.__PLANNER__ || {};
  const toast = document.getElementById('planner-toast');
  let dragPayload = null;
  let dragSourceElement = null;

  function showMessage(message, error = false) {
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.classList.add('show');
    window.clearTimeout(showMessage.timer);
    showMessage.timer = window.setTimeout(() => toast.classList.remove('show'), error ? 7000 : 4500);
  }

  async function postJson(url, body = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  }

  function timeFromMinutes(value) {
    const minutes = Math.max(0, Math.min(1439, Math.round(value)));
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function minuteOfDay(timeStr) {
    const [h, m] = String(timeStr || '00:00').split(':').map(Number);
    return h * 60 + m;
  }

  function preferencesFromForm() {
    return {
      workStart: document.getElementById('planner-work-start').value,
      workEnd: document.getElementById('planner-work-end').value,
      eveningStart: document.getElementById('planner-evening-start').value,
      eveningEnd: document.getElementById('planner-evening-end').value,
      weekendStart: document.getElementById('planner-weekend-start').value,
      weekendEnd: document.getElementById('planner-weekend-end').value,
    };
  }

  function getPlannerPrefs() {
    return {
      workStart: minuteOfDay(document.getElementById('planner-work-start')?.value),
      workEnd: minuteOfDay(document.getElementById('planner-work-end')?.value),
      eveningStart: minuteOfDay(document.getElementById('planner-evening-start')?.value),
      eveningEnd: minuteOfDay(document.getElementById('planner-evening-end')?.value),
      weekendStart: minuteOfDay(document.getElementById('planner-weekend-start')?.value),
      weekendEnd: minuteOfDay(document.getElementById('planner-weekend-end')?.value),
    };
  }

  function isValidDropTime(lane, minute, dateStr, duration) {
    const prefs = getPlannerPrefs();
    const endMinute = minute + duration;
    const weekday = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;
    if (lane === 'personal') {
      const window = isWeekend ? [prefs.weekendStart, prefs.weekendEnd] : [prefs.eveningStart, prefs.eveningEnd];
      return minute >= window[0] && endMinute <= window[1];
    }
    if (isWeekend) return false;
    return minute >= prefs.workStart && endMinute <= prefs.workEnd;
  }

  async function saveHours() {
    return postJson('/api/planner/preferences', preferencesFromForm());
  }

  function startDrag(element, event) {
    const lane = element.classList.contains('planner-task-personal') ? 'personal' : 'work';
    dragPayload = {
      taskId: element.dataset.taskId,
      durationMinutes: Number(element.dataset.duration || 30),
      lane,
    };
    dragSourceElement = element;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/json', JSON.stringify(dragPayload));
    event.dataTransfer.setData('text/plain', dragPayload.taskId);
    element.classList.add('dragging');
    document.body.classList.add('planner-is-dragging');
  }

  document.querySelectorAll('[draggable="true"][data-task-id]').forEach(element => {
    element.addEventListener('dragstart', event => startDrag(element, event));
    element.addEventListener('dragend', () => {
      if (dragSourceElement) dragSourceElement.classList.remove('dragging');
      document.body.classList.remove('planner-is-dragging');
      document.querySelectorAll('.planner-day-body.drag-over').forEach(day => day.classList.remove('drag-over'));
      document.querySelectorAll('.planner-day-body.drag-invalid').forEach(day => day.classList.remove('drag-invalid'));
      dragPayload = null;
      dragSourceElement = null;
    });
  });

  document.querySelectorAll('.planner-day-body').forEach(day => {
    day.addEventListener('dragover', event => {
      if (!dragPayload) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = day.getBoundingClientRect();
      const viewStart = Number(day.dataset.viewStart);
      const viewEnd = Number(day.dataset.viewEnd);
      const duration = Math.max(15, dragPayload.durationMinutes || 30);
      const rawMinute = viewStart + ((event.clientY - rect.top) / rect.height) * (viewEnd - viewStart);
      const minute = Math.max(viewStart, Math.min(viewEnd - duration, Math.round(rawMinute / 15) * 15));
      const valid = isValidDropTime(dragPayload.lane, minute, day.dataset.date, duration);
      day.classList.toggle('drag-over', valid);
      day.classList.toggle('drag-invalid', !valid);
      event.dataTransfer.dropEffect = valid ? 'move' : 'none';
    });
    day.addEventListener('dragleave', event => {
      if (!day.contains(event.relatedTarget)) {
        day.classList.remove('drag-over');
        day.classList.remove('drag-invalid');
      }
    });
    day.addEventListener('drop', async event => {
      event.preventDefault();
      day.classList.remove('drag-over');
      day.classList.remove('drag-invalid');
      let payload = dragPayload;
      if (!payload) {
        try { payload = JSON.parse(event.dataTransfer.getData('application/json')); } catch (_) {}
      }
      if (!payload?.taskId) return;
      const rect = day.getBoundingClientRect();
      const viewStart = Number(day.dataset.viewStart);
      const viewEnd = Number(day.dataset.viewEnd);
      const duration = Math.max(15, Number(payload.durationMinutes || 30));
      const rawMinute = viewStart + ((event.clientY - rect.top) / rect.height) * (viewEnd - viewStart);
      const minute = Math.max(viewStart, Math.min(viewEnd - duration, Math.round(rawMinute / 15) * 15));
      if (!isValidDropTime(payload.lane, minute, day.dataset.date, duration)) {
        const label = payload.lane === 'personal' ? 'Personal' : 'Work';
        const isWeekend = new Date(`${day.dataset.date}T12:00:00Z`).getUTCDay() % 6 === 0;
        const windowLabel = payload.lane === 'personal'
          ? (isWeekend ? 'weekend hours' : 'evening hours')
          : 'work hours';
        showMessage(`${label} tasks can only be placed in ${windowLabel}`, true);
        return;
      }
      const startAt = `${day.dataset.date}T${timeFromMinutes(minute)}`;
      showMessage(`Moving to ${timeFromMinutes(minute)}…`);
      try {
        await postJson(`/api/planner/tasks/${encodeURIComponent(payload.taskId)}/schedule`, {
          startAt,
          durationMinutes: duration,
        });
        window.location.reload();
      } catch (error) {
        showMessage(error.message, true);
      }
    });
  });

  document.querySelectorAll('[data-unschedule]').forEach(button => {
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      const taskId = button.dataset.unschedule;
      if (!window.confirm('Remove this task block from Google Calendar? The task will stay in Google Tasks.')) return;
      button.disabled = true;
      showMessage('Removing calendar block…');
      try {
        await postJson(`/api/planner/tasks/${encodeURIComponent(taskId)}/unschedule`);
        window.location.reload();
      } catch (error) {
        button.disabled = false;
        showMessage(error.message, true);
      }
    });
  });

  const autoButton = document.getElementById('planner-auto');
  const saveHoursButton = document.getElementById('planner-save-hours');
  saveHoursButton?.addEventListener('click', async () => {
    saveHoursButton.disabled = true;
    saveHoursButton.textContent = 'Saving…';
    try {
      await saveHours();
      showMessage('Planning hours saved.');
      window.setTimeout(() => window.location.reload(), 650);
    } catch (error) {
      saveHoursButton.disabled = false;
      saveHoursButton.textContent = 'Save hours';
      showMessage(error.message, true);
    }
  });

  autoButton?.addEventListener('click', async () => {
    const count = Number(data.unscheduledTasks?.length || 0);
    if (!count) return;
    if (!window.confirm(`Place up to ${count} selected task${count === 1 ? '' : 's'} into its allowed calendar time this week?`)) return;
    autoButton.disabled = true;
    autoButton.textContent = 'Planning…';
    try {
      // Auto-plan always uses the values on screen and persists them as the
      // user's defaults before creating any Calendar effects.
      await saveHours();
      const result = await postJson('/api/planner/auto-plan', {
        startDate: data.startDate,
        endDate: data.endDate,
      });
      const message = `${result.scheduled.length} scheduled`
        + (result.lateCount ? ` · ${result.lateCount} late` : '')
        + (result.unplaced.length ? ` · ${result.unplaced.length} had no free slot` : '')
        + (result.failed.length ? ` · ${result.failed.length} failed` : '');
      showMessage(message, Boolean(result.failed.length));
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      autoButton.disabled = false;
      autoButton.textContent = 'Auto-plan selected tasks';
      showMessage(error.message, true);
    }
  });

  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Dublin' }).format(new Date());
  document.querySelectorAll(`[data-date="${today}"]`).forEach(element => element.classList.add('is-today'));
})();
