'use strict';

(() => {
  const data = window.__PLANNER__ || {};
  const toast = document.getElementById('planner-toast');

  // ── Resize state ────────────────────────────────────────────────────────
  let resizeState = null;
  // ── Pointer drag-to-move state (mouse + touch + pen, one path) ───────────
  let pointerDrag = null; // { pointerId, taskId, duration, lane, sourceEl, ghostEl, startX, startY, moved }

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

  // ── Drag to move (pointer events: mouse + touch + pen) ──────────────────
  // Native HTML5 drag-and-drop breaks inside the overflow:auto calendar scroller
  // and is unimplemented on most mobile browsers. Pointer Events give one code
  // path for every input and route all move/up back to the captured element, so
  // hit-testing the target column with elementsFromPoint stays reliable.

  const DRAG_THRESHOLD = 5;
  // Dropped blocks snap to the half hour (:00/:30). A finer 15-min grid made it
  // too easy to land on :15/:45 by accident — Douglas wants clean start times.
  const DROP_SNAP_MINUTES = 30;

  function dayColumnUnder(x, y) {
    return document.elementsFromPoint(x, y).find(el => el.classList?.contains('planner-day-body')) || null;
  }

  function snappedMinute(day, clientY, duration) {
    const rect = day.getBoundingClientRect();
    const viewStart = Number(day.dataset.viewStart);
    const viewEnd = Number(day.dataset.viewEnd);
    const rawMinute = viewStart + ((clientY - rect.top) / rect.height) * (viewEnd - viewStart);
    return Math.max(viewStart, Math.min(viewEnd - duration, Math.round(rawMinute / DROP_SNAP_MINUTES) * DROP_SNAP_MINUTES));
  }

  function clearDropHints() {
    document.querySelectorAll('.planner-day-body.drag-over, .planner-day-body.drag-invalid')
      .forEach(d => d.classList.remove('drag-over', 'drag-invalid'));
  }

  // A dependency floor ("only after the linked meeting"); same local format both
  // sides, so a lexical compare is a chronological one.
  function beforeFloor(dateStr, minute, notBefore) {
    if (!notBefore) return false;
    return `${dateStr}T${timeFromMinutes(minute)}` < notBefore;
  }

  function endPointerDrag() {
    const drag = pointerDrag;
    pointerDrag = null;
    document.body.classList.remove('planner-is-dragging');
    clearDropHints();
    if (!drag) return null;
    if (drag.ghostEl) drag.ghostEl.remove();
    drag.sourceEl.style.opacity = '';
    drag.sourceEl.classList.remove('planner-dragging');
    try { drag.sourceEl.releasePointerCapture(drag.pointerId); } catch (_) {}
    return drag;
  }

  document.querySelectorAll('[data-task-id]').forEach(element => {
    if (!element.dataset.taskId) return;

    element.addEventListener('pointerdown', event => {
      if (event.button && event.button !== 0) return;
      if (event.target.closest('.planner-resize-handle, .planner-unschedule, a')) return;
      pointerDrag = {
        pointerId: event.pointerId,
        taskId: element.dataset.taskId,
        duration: Math.max(15, Number(element.dataset.duration || 30)),
        lane: element.dataset.lane === 'personal' ? 'personal' : 'work',
        notBefore: element.dataset.notBefore || null,
        sourceEl: element,
        ghostEl: null,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      element.setPointerCapture(event.pointerId);
    });

    element.addEventListener('pointermove', event => {
      if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
      const dx = event.clientX - pointerDrag.startX;
      const dy = event.clientY - pointerDrag.startY;
      if (!pointerDrag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      event.preventDefault();
      if (!pointerDrag.moved) {
        pointerDrag.moved = true;
        pointerDrag.sourceEl.style.opacity = '.35';
        pointerDrag.sourceEl.classList.add('planner-dragging');
        const ghost = pointerDrag.sourceEl.cloneNode(true);
        ghost.classList.add('planner-touch-ghost');
        ghost.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;margin:0;width:' +
          pointerDrag.sourceEl.offsetWidth + 'px;opacity:.9;transform:scale(1.03);' +
          'box-shadow:0 8px 24px rgba(0,0,0,.25);';
        document.body.appendChild(ghost);
        pointerDrag.ghostEl = ghost;
        document.body.classList.add('planner-is-dragging');
      }
      pointerDrag.ghostEl.style.left = (event.clientX - pointerDrag.sourceEl.offsetWidth / 2) + 'px';
      pointerDrag.ghostEl.style.top = (event.clientY - 16) + 'px';
      clearDropHints();
      const day = dayColumnUnder(event.clientX, event.clientY);
      if (day) {
        const minute = snappedMinute(day, event.clientY, pointerDrag.duration);
        const valid = isValidDropTime(pointerDrag.lane, minute, day.dataset.date, pointerDrag.duration)
          && !beforeFloor(day.dataset.date, minute, pointerDrag.notBefore);
        day.classList.add(valid ? 'drag-over' : 'drag-invalid');
      }
    });

    const finish = async event => {
      if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
      const wasMoved = pointerDrag.moved;
      const { taskId, duration, lane, notBefore } = pointerDrag;
      const day = wasMoved ? dayColumnUnder(event.clientX, event.clientY) : null;
      endPointerDrag();
      if (!wasMoved) {
        // A tap (no drag) on a task block opens it in the task page.
        if (taskId) window.location.href = '/crm/tasks/' + encodeURIComponent(taskId);
        return;
      }
      if (!day) return;
      const minute = snappedMinute(day, event.clientY, duration);
      if (beforeFloor(day.dataset.date, minute, notBefore)) {
        showMessage('This task can only start after the meeting it depends on', true);
        return;
      }
      if (!isValidDropTime(lane, minute, day.dataset.date, duration)) {
        const label = lane === 'personal' ? 'Personal' : 'Work';
        const isWeekend = new Date(`${day.dataset.date}T12:00:00Z`).getUTCDay() % 6 === 0;
        const windowLabel = lane === 'personal' ? (isWeekend ? 'weekend hours' : 'evening hours') : 'work hours';
        showMessage(`${label} tasks can only be placed in ${windowLabel}`, true);
        return;
      }
      const startAt = `${day.dataset.date}T${timeFromMinutes(minute)}`;
      showMessage(`Moving to ${timeFromMinutes(minute)}…`);
      try {
        await postJson(`/api/planner/tasks/${encodeURIComponent(taskId)}/schedule`, { startAt, durationMinutes: duration });
        window.location.reload();
      } catch (error) {
        showMessage(error.message, true);
      }
    };

    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', () => { endPointerDrag(); });
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
  const reshuffleButton = document.getElementById('planner-reshuffle');
  const saveHoursButton = document.getElementById('planner-save-hours');

  reshuffleButton?.addEventListener('click', async () => {
    if (!window.confirm('Clear finished task blocks and pull remaining tasks earlier into any free time this week?')) return;
    const original = reshuffleButton.textContent;
    reshuffleButton.disabled = true;
    reshuffleButton.textContent = 'Reshuffling…';
    try {
      const result = await postJson('/api/planner/reshuffle', {
        startDate: data.startDate,
        endDate: data.endDate,
      });
      const parts = [];
      if (result.removedCompleted?.length) parts.push(`${result.removedCompleted.length} finished cleared`);
      parts.push(`${result.moved.length} pulled earlier`);
      if (result.lateCount) parts.push(`${result.lateCount} still late`);
      if (result.failed?.length) parts.push(`${result.failed.length} failed`);
      showMessage(parts.join(' · '), Boolean(result.failed?.length));
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      reshuffleButton.disabled = false;
      reshuffleButton.textContent = original;
      showMessage(error.message, true);
    }
  });
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
