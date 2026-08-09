'use strict';

(() => {
  const data = window.__PLANNER__ || {};
  const toast = document.getElementById('planner-toast');
  let dragPayload = null;
  let dragSourceElement = null;

  // ── Resize state ────────────────────────────────────────────────────────
  let resizeState = null;
  // ── Touch drag state ────────────────────────────────────────────────────
  let touchDrag = null; // { taskId, duration, lane, ghostEl, startX, startY, moved, sourceEl }

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

  function getMinuteScale() {
    const grid = document.querySelector('.planner-calendar');
    if (!grid) return 1.5;
    return parseFloat(getComputedStyle(grid).getPropertyValue('--planner-view-height')) /
      (Number(document.querySelector('.planner-day-body')?.dataset.viewEnd || 1080) -
       Number(document.querySelector('.planner-day-body')?.dataset.viewStart || 360));
  }

  async function saveHours() {
    return postJson('/api/planner/preferences', preferencesFromForm());
  }

  // ── Drag to move (desktop) ──────────────────────────────────────────────

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
    element.addEventListener('dragstart', event => {
      if (event.target.closest('.planner-resize-handle, .planner-unschedule')) return;
      startDrag(element, event);
    });
    element.addEventListener('dragend', () => {
      if (dragSourceElement) dragSourceElement.classList.remove('dragging');
      document.body.classList.remove('planner-is-dragging');
      document.querySelectorAll('.planner-day-body.drag-over, .planner-day-body.drag-invalid').forEach(day => {
        day.classList.remove('drag-over', 'drag-invalid');
      });
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
      if (!day.contains(event.relatedTarget)) day.classList.remove('drag-over', 'drag-invalid');
    });
    day.addEventListener('drop', async event => {
      event.preventDefault();
      day.classList.remove('drag-over', 'drag-invalid');
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

  // ── Touch drag to move (mobile) ─────────────────────────────────────────

  function getDayColumnUnder(touch) {
    const els = document.elementsFromPoint(touch.clientX, touch.clientY);
    return els.find(el => el.classList?.contains('planner-day-body')) || null;
  }

  document.querySelectorAll('[draggable="true"][data-task-id]').forEach(element => {
    element.addEventListener('touchstart', event => {
      if (event.target.closest('.planner-resize-handle, .planner-unschedule')) return;
      event.preventDefault();
      const touch = event.touches[0];
      const lane = element.classList.contains('planner-task-personal') ? 'personal' : 'work';
      touchDrag = {
        taskId: element.dataset.taskId,
        duration: Number(element.dataset.duration || 30),
        lane,
        sourceEl: element,
        ghostEl: null,
        startX: touch.clientX,
        startY: touch.clientY,
        moved: false,
      };
    }, { passive: false });

    element.addEventListener('touchmove', event => {
      if (!touchDrag || touchDrag.taskId !== element.dataset.taskId) return;
      const touch = event.touches[0];
      const dx = touch.clientX - touchDrag.startX;
      const dy = touch.clientY - touchDrag.startY;
      if (!touchDrag.moved && Math.abs(dx) + Math.abs(dy) < 12) return;
      event.preventDefault();
      if (!touchDrag.moved) {
        touchDrag.moved = true;
        touchDrag.sourceEl.style.opacity = '.35';
        const ghost = touchDrag.sourceEl.cloneNode(true);
        ghost.classList.add('planner-touch-ghost');
        ghost.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;width:' +
          touchDrag.sourceEl.offsetWidth + 'px;opacity:.88;transform:scale(1.04);' +
          'box-shadow:0 8px 24px rgba(0,0,0,.25);';
        document.body.appendChild(ghost);
        touchDrag.ghostEl = ghost;
        document.body.classList.add('planner-is-dragging');
      }
      if (touchDrag.ghostEl) {
        touchDrag.ghostEl.style.left = (touch.clientX - touchDrag.sourceEl.offsetWidth / 2) + 'px';
        touchDrag.ghostEl.style.top = (touch.clientY - 16) + 'px';
      }
      document.querySelectorAll('.planner-day-body.drag-over, .planner-day-body.drag-invalid').forEach(d => d.classList.remove('drag-over', 'drag-invalid'));
      const day = getDayColumnUnder(touch);
      if (day) {
        const rect = day.getBoundingClientRect();
        const viewStart = Number(day.dataset.viewStart);
        const viewEnd = Number(day.dataset.viewEnd);
        const rawMinute = viewStart + ((touch.clientY - rect.top) / rect.height) * (viewEnd - viewStart);
        const minute = Math.max(viewStart, Math.min(viewEnd - touchDrag.duration, Math.round(rawMinute / 15) * 15));
        const valid = isValidDropTime(touchDrag.lane, minute, day.dataset.date, touchDrag.duration);
        day.classList.add(valid ? 'drag-over' : 'drag-invalid');
      }
    }, { passive: false });

    element.addEventListener('touchend', async event => {
      if (!touchDrag || touchDrag.taskId !== element.dataset.taskId) return;
      const td = touchDrag;
      touchDrag = null;
      document.body.classList.remove('planner-is-dragging');
      if (td.ghostEl) td.ghostEl.remove();
      td.sourceEl.style.opacity = '';
      document.querySelectorAll('.planner-day-body.drag-over, .planner-day-body.drag-invalid').forEach(d => d.classList.remove('drag-over', 'drag-invalid'));
      if (!td.moved) return;
      const touch = event.changedTouches[0];
      const day = getDayColumnUnder(touch);
      if (!day) return;
      const rect = day.getBoundingClientRect();
      const viewStart = Number(day.dataset.viewStart);
      const viewEnd = Number(day.dataset.viewEnd);
      const rawMinute = viewStart + ((touch.clientY - rect.top) / rect.height) * (viewEnd - viewStart);
      const minute = Math.max(viewStart, Math.min(viewEnd - td.duration, Math.round(rawMinute / 15) * 15));
      if (!isValidDropTime(td.lane, minute, day.dataset.date, td.duration)) {
        const label = td.lane === 'personal' ? 'Personal' : 'Work';
        const isWeekend = new Date(`${day.dataset.date}T12:00:00Z`).getUTCDay() % 6 === 0;
        const windowLabel = td.lane === 'personal'
          ? (isWeekend ? 'weekend hours' : 'evening hours')
          : 'work hours';
        showMessage(`${label} tasks can only be placed in ${windowLabel}`, true);
        return;
      }
      const startAt = `${day.dataset.date}T${timeFromMinutes(minute)}`;
      showMessage(`Moving to ${timeFromMinutes(minute)}…`);
      try {
        await postJson(`/api/planner/tasks/${encodeURIComponent(td.taskId)}/schedule`, {
          startAt,
          durationMinutes: td.duration,
        });
        window.location.reload();
      } catch (error) {
        showMessage(error.message, true);
      }
    });
  });

  // ── Unschedule button ───────────────────────────────────────────────────

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

  // ── Resize handles (mouse) ─────────────────────────────────────────────

  document.querySelectorAll('[data-resize]').forEach(handle => {
    handle.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
      const article = handle.closest('.planner-task-event');
      if (!article) return;
      const taskId = handle.dataset.resize;
      const lane = article.classList.contains('planner-task-personal') ? 'personal' : 'work';
      const startDuration = Number(article.dataset.duration || 30);
      const minuteScale = getMinuteScale();
      resizeState = { taskId, startY: event.clientY, startDuration, element: article, minuteScale, lane };
      article.classList.add('resizing');
      document.body.classList.add('planner-is-resizing');
      document.addEventListener('mousemove', onResizeMove);
      document.addEventListener('mouseup', onResizeEnd);
    });
  });

  function onResizeMove(event) {
    if (!resizeState) return;
    const deltaPixels = event.clientY - resizeState.startY;
    const deltaMinutes = Math.round((deltaPixels / resizeState.minuteScale) / 15) * 15;
    let newDuration = resizeState.startDuration + deltaMinutes;
    newDuration = Math.max(15, Math.min(120, newDuration));
    resizeState.element.style.height = `${newDuration * resizeState.minuteScale}px`;
    resizeState.element.dataset.duration = newDuration;
    const titleEl = resizeState.element.querySelector('.planner-event-title');
    if (titleEl) {
      const baseTitle = resizeState.element.getAttribute('title')?.split(' · ')[0] || '';
      resizeState.element.title = `${baseTitle} · ${newDuration >= 60 ? (newDuration / 60) + 'h' : newDuration + 'm'}`;
    }
  }

  async function onResizeEnd(event) {
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeEnd);
    if (!resizeState) return;
    const { taskId, startDuration, element, lane } = resizeState;
    element.classList.remove('resizing');
    document.body.classList.remove('planner-is-resizing');
    const deltaPixels = event.clientY - resizeState.startY;
    const deltaMinutes = Math.round((deltaPixels / resizeState.minuteScale) / 15) * 15;
    let newDuration = startDuration + deltaMinutes;
    newDuration = Math.max(15, Math.min(120, newDuration));
    resizeState = null;
    if (newDuration === startDuration) return;
    const dateStr = element.dataset.eventDate;
    const startTime = element.dataset.eventStart;
    if (!dateStr || !startTime) {
      showMessage('Cannot resize: missing time data', true);
      return;
    }
    const startMinute = minuteOfDay(startTime);
    if (!isValidDropTime(lane, startMinute, dateStr, newDuration)) {
      const label = lane === 'personal' ? 'Personal' : 'Work';
      showMessage(`${label} task would exceed allowed time window at this duration`, true);
      element.style.height = `${startDuration * getMinuteScale()}px`;
      element.dataset.duration = startDuration;
      return;
    }
    const startAt = `${dateStr}T${startTime}`;
    showMessage(`Resizing to ${newDuration >= 60 ? (newDuration / 60) + 'h' : newDuration + 'm'}…`);
    try {
      await postJson(`/api/planner/tasks/${encodeURIComponent(taskId)}/schedule`, {
        startAt,
        durationMinutes: newDuration,
      });
      window.location.reload();
    } catch (error) {
      showMessage(error.message, true);
      element.style.height = `${startDuration * getMinuteScale()}px`;
      element.dataset.duration = startDuration;
    }
  }

  // ── Resize handles (touch) ──────────────────────────────────────────────

  document.querySelectorAll('[data-resize]').forEach(handle => {
    handle.addEventListener('touchstart', event => {
      event.preventDefault();
      event.stopPropagation();
      const article = handle.closest('.planner-task-event');
      if (!article) return;
      const touch = event.touches[0];
      const taskId = handle.dataset.resize;
      const lane = article.classList.contains('planner-task-personal') ? 'personal' : 'work';
      const startDuration = Number(article.dataset.duration || 30);
      const minuteScale = getMinuteScale();
      resizeState = { taskId, startY: touch.clientY, startDuration, element: article, minuteScale, lane };
      article.classList.add('resizing');
      document.body.classList.add('planner-is-resizing');
    }, { passive: false });

    handle.addEventListener('touchmove', event => {
      if (!resizeState) return;
      event.preventDefault();
      const touch = event.touches[0];
      const fakeEvent = { clientY: touch.clientY };
      onResizeMove(fakeEvent);
    }, { passive: false });

    handle.addEventListener('touchend', event => {
      if (!resizeState) return;
      const touch = event.changedTouches[0];
      const fakeEvent = { clientY: touch.clientY };
      onResizeEnd(fakeEvent);
    });
  });

  // ── Auto-plan & preferences ─────────────────────────────────────────────

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
