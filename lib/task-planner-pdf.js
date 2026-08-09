'use strict';

const PDFDocument = require('pdfkit');

function dayEvents(snapshot, date) {
  return (snapshot.events || [])
    .filter(event => (event.allDay && event.date <= date && event.endDate > date)
      || (!event.allDay && event.date === date))
    .sort((a, b) => Number(b.allDay) - Number(a.allDay)
      || String(a.time || '').localeCompare(String(b.time || ''))
      || String(a.title || '').localeCompare(String(b.title || '')));
}

function splitDayEvents(snapshot, date) {
  const events = dayEvents(snapshot, date);
  return {
    calendarEvents: events.filter(event => !event.isTask),
    tasks: events.filter(event => event.isTask),
  };
}

function formatDay(date) {
  return new Intl.DateTimeFormat('en-IE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

function eventTime(event) {
  if (event.allDay) return 'All day';
  return event.endTime ? `${event.time} - ${event.endTime}` : event.time;
}

function wrapHeight(doc, text, width, lineGap = 2) {
  return doc.heightOfString(text, { width, lineGap });
}

function drawSectionHeading(doc, text, x, y, width) {
  doc.fillColor('#5653e8').font('Helvetica-Bold').fontSize(8).text(text.toUpperCase(), x, y, {
    width, characterSpacing: 1.1,
  });
}

function scheduleEventHeight(doc, event, width) {
  const task = Boolean(event.isTask);
  const timeWidth = 64;
  const contentWidth = width - timeWidth - 18;
  doc.font('Helvetica-Bold').fontSize(9.2);
  const titleHeight = wrapHeight(doc, String(event.title || '(untitled)'), contentWidth, 1.5);
  const meta = task ? `${event.task?.planner_lane === 'personal' ? 'Personal task' : 'Work task'}${event.isLate ? ' - LATE' : ''}` : (event.location || 'Calendar event');
  doc.font('Helvetica').fontSize(7.8);
  const metaHeight = wrapHeight(doc, meta, contentWidth, 1.2);
  return Math.max(34, Math.ceil(12 + titleHeight + metaHeight));
}

function drawScheduleEvent(doc, event, x, y, width) {
  const task = Boolean(event.isTask);
  const late = task && event.isLate;
  const border = late ? '#b42318' : task ? '#5653e8' : '#c7c8d1';
  const fill = late ? '#fff1f0' : task ? '#f1f0ff' : '#f7f7fa';
  const timeWidth = 64;
  const contentX = x + timeWidth + 10;
  const contentWidth = width - timeWidth - 18;
  const titleHeight = wrapHeight(doc.font('Helvetica-Bold').fontSize(9.2), String(event.title || '(untitled)'), contentWidth, 1.5);
  const meta = task ? `${event.task?.planner_lane === 'personal' ? 'Personal task' : 'Work task'}${late ? ' - LATE' : ''}` : (event.location || 'Calendar event');
  const height = scheduleEventHeight(doc, event, width);

  doc.roundedRect(x, y, width, height, 5).fillAndStroke(fill, border);
  doc.fillColor(late ? '#b42318' : '#4c4963').font('Helvetica-Bold').fontSize(8.2)
    .text(eventTime(event), x + 8, y + 9, { width: timeWidth - 12 });
  doc.fillColor('#211e31').font('Helvetica-Bold').fontSize(9.2)
    .text(String(event.title || '(untitled)'), contentX, y + 7, { width: contentWidth, lineGap: 1.5 });
  doc.fillColor(late ? '#b42318' : '#706d80').font('Helvetica').fontSize(7.8)
    .text(meta, contentX, y + 9 + titleHeight, { width: contentWidth, lineGap: 1.2 });
  return height;
}

function taskHeight(doc, event, width) {
  const textWidth = width - 23;
  doc.font('Helvetica-Bold').fontSize(9.3);
  const titleHeight = wrapHeight(doc, String(event.title || '(untitled)'), textWidth, 1.5);
  return Math.max(30, Math.ceil(10 + titleHeight + 10)) + 9;
}

function drawTask(doc, event, x, y, width) {
  const late = Boolean(event.isLate);
  const textX = x + 23;
  const textWidth = width - 23;
  const titleHeight = wrapHeight(doc.font('Helvetica-Bold').fontSize(9.3), String(event.title || '(untitled)'), textWidth, 1.5);
  const meta = `${eventTime(event)}${late ? ' - LATE' : ''}`;
  const height = taskHeight(doc, event, width) - 9;
  doc.roundedRect(x, y + 1, 13, 13, 2).lineWidth(1).strokeColor(late ? '#b42318' : '#5653e8').stroke();
  doc.fillColor('#211e31').font('Helvetica-Bold').fontSize(9.3)
    .text(String(event.title || '(untitled)'), textX, y, { width: textWidth, lineGap: 1.5 });
  doc.fillColor(late ? '#b42318' : '#706d80').font('Helvetica').fontSize(7.8)
    .text(meta, textX, y + titleHeight + 2, { width: textWidth });
  doc.moveTo(x, y + height + 4).lineTo(x + width, y + height + 4).lineWidth(.5).strokeColor('#e5e4eb').stroke();
  return height + 9;
}

function createPlannerDayPdf(snapshot, date) {
  const { calendarEvents, tasks } = splitDayEvents(snapshot, date);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', layout: 'landscape', margin: 42, compress: false,
      info: { Title: `Today - ${formatDay(date)}`, Author: 'McLellan Hub' },
    });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const margin = 42;
    const gap = 28;
    const scheduleWidth = 480;
    const tasksX = margin + scheduleWidth + gap;
    const tasksWidth = pageWidth - tasksX - margin;
    const bottom = pageHeight - margin;

    let eventIndex = 0;
    let taskIndex = 0;
    let page = 0;
    do {
      if (page) doc.addPage();
      doc.fillColor('#211e31').font('Helvetica-Bold').fontSize(25).text(page ? 'Today (continued)' : 'Today', margin, margin);
      doc.fillColor('#5653e8').font('Helvetica').fontSize(11).text(formatDay(date), margin, margin + 32);
      doc.fillColor('#706d80').font('Helvetica').fontSize(8.5)
        .text('McLellan Hub - calendar and planned tasks', margin, margin + 50);
      doc.moveTo(margin, margin + 69).lineTo(pageWidth - margin, margin + 69).lineWidth(1).strokeColor('#e5e4eb').stroke();

      let scheduleY = margin + 84;
      let taskY = margin + 84;
      drawSectionHeading(doc, 'Calendar', margin, scheduleY, scheduleWidth);
      drawSectionHeading(doc, 'Tasks scheduled today', tasksX, taskY, tasksWidth);
      scheduleY += 18;
      taskY += 18;
      if (!calendarEvents.length) doc.fillColor('#706d80').font('Helvetica').fontSize(10).text('No appointments today.', margin, scheduleY);
      if (!tasks.length) doc.fillColor('#706d80').font('Helvetica').fontSize(10).text('No planner tasks scheduled today.', tasksX, taskY, { width: tasksWidth });

      while (eventIndex < calendarEvents.length) {
        const height = scheduleEventHeight(doc, calendarEvents[eventIndex], scheduleWidth) + 7;
        if (scheduleY + height > bottom - 28 && scheduleY > margin + 102) break;
        drawScheduleEvent(doc, calendarEvents[eventIndex], margin, scheduleY, scheduleWidth);
        scheduleY += height;
        eventIndex += 1;
      }
      while (taskIndex < tasks.length) {
        const height = taskHeight(doc, tasks[taskIndex], tasksWidth);
        if (taskY + height > bottom - 28 && taskY > margin + 102) break;
        taskY += drawTask(doc, tasks[taskIndex], tasksX, taskY, tasksWidth);
        taskIndex += 1;
      }
      doc.fillColor('#9996a7').font('Helvetica').fontSize(7.5)
        .text(`Late tasks are marked in red.  Page ${page + 1}`, margin, bottom - 14, { width: pageWidth - margin * 2, align: 'right' });
      page += 1;
    } while (eventIndex < calendarEvents.length || taskIndex < tasks.length || !page);
    doc.end();
  });
}

module.exports = { createPlannerDayPdf, dayEvents, splitDayEvents };
