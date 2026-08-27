package scot.mclellan.boox

import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/**
 * The read views. Every one is a pure function of the synced snapshot and the
 * focus date, so the same code renders live or fully offline from the cached
 * copy. Rendering is programmatic (see Ui) because the planner is data-driven.
 *
 * The appointment/task-block distinction matters everywhere: a scheduled task
 * appears in `events` as a block (isTaskBlock) AND in `tasks` as the task. We
 * show the block on the day it occupies and mark it "task", and in the Tasks
 * view we label that task "scheduled" rather than listing it as inbox, so one
 * commitment never looks like two.
 */
object PlannerViews {

    private val UK = Locale.UK
    private val dayHeaderFmt = DateTimeFormatter.ofPattern("d MMMM yyyy", UK)

    fun iso(d: LocalDate): String = d.toString()

    private fun eventsOn(data: SyncResponse, date: LocalDate): List<Event> {
        val d = iso(date)
        return data.planner.events
            .filter { it.date <= d && (it.endDate.ifBlank { it.date }) >= d }
            .sortedWith(compareBy({ if (it.allDay) 0 else 1 }, { it.time ?: "99:99" }))
    }

    private fun scheduledTaskIds(data: SyncResponse): Set<String> =
        data.planner.events.filter { it.isTaskBlock }.mapNotNull { it.taskId?.ifBlank { null } }.toSet()

    private fun timeLabel(e: Event): String = when {
        e.allDay -> "all day"
        !e.time.isNullOrBlank() && !e.endTime.isNullOrBlank() -> "${e.time}\n${e.endTime}"
        !e.time.isNullOrBlank() -> e.time!!
        else -> "—"
    }

    // ── Day ────────────────────────────────────────────────────────────────
    fun renderDay(
        ctx: Context, into: LinearLayout, data: SyncResponse, focus: LocalDate,
        onTask: (Task) -> Unit = {},
        onNewNote: (linkedDate: String, eventId: String?, label: String?) -> Unit = { _, _, _ -> },
    ) {
        val iso = iso(focus)
        val weekday = focus.dayOfWeek.getDisplayName(TextStyle.FULL, UK)
        into.addView(ctx.text(weekday, 26f, bold = true))
        into.addView(ctx.text(focus.format(dayHeaderFmt), 15f, color = MUTED))
        into.addView(noteButton(ctx, "＋ Note for this day") {
            onNewNote(iso, null, "Note · ${focus.format(dayHeaderFmt)}")
        })
        into.addView(ctx.rule(marginV = 10))

        val items = eventsOn(data, focus)
        val taskById = data.tasks.associateBy { it.id }
        if (items.isEmpty()) {
            into.addView(ctx.text("No appointments or scheduled tasks.", 16f, color = MUTED).also {
                it.setPadding(0, ctx.dp(12), 0, 0)
            })
        } else {
            items.forEach { e ->
                val card = dayEventCard(ctx, e)
                if (e.isTaskBlock) {
                    // A scheduled task block is actionable — tap it to act on the task.
                    taskById[e.taskId]?.let { t -> card.setOnClickListener { onTask(t) } }
                } else {
                    // A real appointment — tap it to take a linked handwritten note.
                    card.setOnClickListener { onNewNote(e.date, e.id, "Note · ${e.title}") }
                }
                into.addView(card)
            }
        }

        // Tasks genuinely due today that aren't placed on the calendar yet.
        val scheduled = scheduledTaskIds(data)
        val dueUnscheduled = data.tasks.filter {
            it.isOpen && it.isMine && it.dueForDisplay == iso && it.id !in scheduled
        }
        if (dueUnscheduled.isNotEmpty()) {
            into.addView(ctx.sectionHeader("Due today · unscheduled", dueUnscheduled.size))
            dueUnscheduled.forEach { into.addView(taskCard(ctx, it, onClick = { onTask(it) })) }
        }
    }

    private fun noteButton(ctx: Context, label: String, onClick: () -> Unit): View {
        return ctx.text(label, 15f, bold = true).apply {
            setPadding(ctx.dp(12), ctx.dp(10), ctx.dp(12), ctx.dp(10))
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(FILL)
                cornerRadius = ctx.dp(6).toFloat()
            }
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.topMargin = ctx.dp(8)
            layoutParams = lp
            setOnClickListener { onClick() }
        }
    }

    private fun dayEventCard(ctx: Context, e: Event): LinearLayout {
        val cardV = ctx.card()
        val rowLp = LinearLayout.LayoutParams(MATCH, WRAP)
        val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; layoutParams = rowLp }

        val timeCol = ctx.text(timeLabel(e), 15f, bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(ctx.dp(64), WRAP)
        }
        val bodyCol = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, WRAP, 1f).also { it.marginStart = ctx.dp(12) }
        }
        bodyCol.addView(ctx.text(e.title.ifBlank { "(untitled)" }, 17f, bold = true))
        val meta = buildString {
            if (e.isTaskBlock) append("TASK")
            val loc = e.location?.trim().orEmpty()
            if (loc.isNotEmpty()) { if (isNotEmpty()) append("  ·  "); append(loc) }
            if (!e.isTaskBlock && loc.isEmpty()) append("appointment")
        }
        if (meta.isNotEmpty()) bodyCol.addView(ctx.text(meta, 13f, color = MUTED))
        row.addView(timeCol); row.addView(bodyCol)
        cardV.addView(row)
        return cardV
    }

    // ── Week ───────────────────────────────────────────────────────────────
    fun renderWeek(
        ctx: Context, into: LinearLayout, data: SyncResponse, focus: LocalDate,
        onOpenDay: (LocalDate) -> Unit,
    ) {
        val monday = focus.with(DayOfWeek.MONDAY)
        val today = runCatching { LocalDate.parse(data.today) }.getOrNull()
        (0..6).forEach { offset ->
            val d = monday.plusDays(offset.toLong())
            val items = eventsOn(data, d)
            val header = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, ctx.dp(14), 0, ctx.dp(4))
                isClickable = true
                setOnClickListener { onOpenDay(d) }
            }
            val isToday = d == today
            val dow = d.dayOfWeek.getDisplayName(TextStyle.SHORT, UK)
            header.addView(ctx.text(
                "$dow ${d.dayOfMonth} ${d.month.getDisplayName(TextStyle.SHORT, UK)}",
                17f, bold = true,
            ).apply { layoutParams = LinearLayout.LayoutParams(0, WRAP, 1f) })
            header.addView(ctx.text(
                if (isToday) "today · ${items.size}" else "${items.size}", 13f, color = MUTED,
            ))
            into.addView(header)
            into.addView(ctx.rule())
            if (items.isEmpty()) {
                into.addView(ctx.text("—", 15f, color = MUTED).apply {
                    setPadding(0, ctx.dp(6), 0, ctx.dp(2))
                })
            } else {
                items.forEach { e ->
                    val line = LinearLayout(ctx).apply {
                        orientation = LinearLayout.HORIZONTAL
                        setPadding(0, ctx.dp(6), 0, ctx.dp(2))
                    }
                    line.addView(ctx.text(if (e.allDay) "all day" else (e.time ?: "—"), 15f, bold = true).apply {
                        layoutParams = LinearLayout.LayoutParams(ctx.dp(64), WRAP)
                    })
                    val t = (if (e.isTaskBlock) "▹ " else "") + e.title.ifBlank { "(untitled)" }
                    line.addView(ctx.text(t, 15f).apply {
                        layoutParams = LinearLayout.LayoutParams(0, WRAP, 1f).also { it.marginStart = ctx.dp(12) }
                        maxLines = 2
                    })
                    into.addView(line)
                }
            }
        }
    }

    // ── Month ──────────────────────────────────────────────────────────────
    fun renderMonth(
        ctx: Context, into: LinearLayout, data: SyncResponse, focus: LocalDate,
        onOpenDay: (LocalDate) -> Unit,
    ) {
        val ym = YearMonth.from(focus)
        val today = runCatching { LocalDate.parse(data.today) }.getOrNull()
        val countByDate = HashMap<String, Int>()
        data.planner.events.forEach { countByDate[it.date] = (countByDate[it.date] ?: 0) + 1 }

        // Weekday header row (Mon..Sun).
        val head = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        DayOfWeek.values().forEach { dw ->
            head.addView(ctx.text(dw.getDisplayName(TextStyle.SHORT, UK), 12f, bold = true, color = MUTED).apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, WRAP, 1f)
            })
        }
        into.addView(head)

        val first = ym.atDay(1)
        val gridStart = first.with(DayOfWeek.MONDAY) // Monday on/before the 1st
        var cursor = gridStart
        // Six week rows covers every month layout.
        repeat(6) {
            val week = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(MATCH, WRAP)
            }
            repeat(7) {
                val d = cursor
                val inMonth = YearMonth.from(d) == ym
                val n = countByDate[iso(d)] ?: 0
                val cell = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                    layoutParams = LinearLayout.LayoutParams(0, ctx.dp(78), 1f).also { it.setMargins(ctx.dp(1), ctx.dp(1), ctx.dp(1), ctx.dp(1)) }
                    background = cellBorder(ctx, d == today)
                    setPadding(ctx.dp(4), ctx.dp(3), ctx.dp(4), ctx.dp(3))
                    isClickable = true
                    setOnClickListener { onOpenDay(d) }
                }
                cell.addView(ctx.text(
                    d.dayOfMonth.toString(), 14f, bold = (d == today) || inMonth,
                    color = if (inMonth) INK else MUTED,
                ))
                if (n > 0 && inMonth) {
                    cell.addView(ctx.text("$n", 12f, color = MUTED).apply {
                        gravity = Gravity.END
                        layoutParams = LinearLayout.LayoutParams(MATCH, 0, 1f).also { it.topMargin = ctx.dp(2) }
                        setGravity(Gravity.BOTTOM or Gravity.END)
                    })
                }
                week.addView(cell)
                cursor = cursor.plusDays(1)
            }
            into.addView(week)
        }
    }

    private fun cellBorder(ctx: Context, today: Boolean) =
        android.graphics.drawable.GradientDrawable().apply {
            setColor(if (today) FILL else android.graphics.Color.WHITE)
            setStroke(ctx.dp(if (today) 2 else 1), LINE)
        }

    // ── Tasks ──────────────────────────────────────────────────────────────
    fun renderTasks(
        ctx: Context, into: LinearLayout, data: SyncResponse,
        onTask: (Task) -> Unit = {},
    ) {
        val scheduled = scheduledTaskIds(data)
        val mine = data.tasks.filter { it.isOpen && it.isMine }
        val overdue = mine.filter { it.isOverdue }
        val isScheduled = { t: Task -> t.id in scheduled && !t.isOverdue }
        val scheduledList = mine.filter(isScheduled)
        val deferred = mine.filter { it.dependencyDeferred && !it.isOverdue && it.id !in scheduled }
        val inbox = mine.filter { !it.isOverdue && it.id !in scheduled && !it.dependencyDeferred }
        val assigned = data.tasks.filter { it.isOpen && !it.isMine }

        fun group(title: String, list: List<Task>, scheduledTag: Boolean = false) {
            if (list.isEmpty()) return
            into.addView(ctx.sectionHeader(title, list.size))
            list.forEach { t -> into.addView(taskCard(ctx, t, scheduledTag, onClick = { onTask(t) })) }
        }

        into.addView(ctx.text("Open tasks (mine): ${mine.size}", 15f, color = MUTED).apply {
            setPadding(0, 0, 0, ctx.dp(4))
        })
        group("Overdue", overdue)
        group("Scheduled", scheduledList, scheduledTag = true)
        group("Inbox · unplanned", inbox)
        group("Starts later", deferred)

        if (assigned.isNotEmpty()) {
            into.addView(ctx.sectionHeader("Assigned to others", assigned.size))
            assigned.forEach { into.addView(assignedCard(ctx, it)) }
        }
    }

    private fun taskCard(
        ctx: Context, t: Task, scheduledTag: Boolean = false, onClick: (() -> Unit)? = null,
    ): View {
        val cardV = ctx.card()
        cardV.addView(ctx.text(t.title.ifBlank { "(untitled)" }, 17f, bold = true))
        val bits = mutableListOf<String>()
        t.dueForDisplay?.let { bits.add((if (t.isOverdue) "! due " else "due ") + it) }
        if (scheduledTag) bits.add("scheduled")
        t.plannerLane?.takeIf { it.isNotBlank() }?.let { bits.add(it) }
        t.effortMinutes?.let { bits.add("${it}m") }
        t.projectName?.takeIf { it.isNotBlank() }?.let { bits.add(it) }
        if (t.subtaskTotal > 0) bits.add("subtasks ${t.subtaskOpen}/${t.subtaskTotal} open")
        if (t.id.startsWith("local:")) bits.add("unsynced")
        if (bits.isNotEmpty()) {
            cardV.addView(ctx.text(bits.joinToString("  ·  "), 13f, color = MUTED).apply {
                setPadding(0, ctx.dp(4), 0, 0)
            })
        }
        onClick?.let { cb -> cardV.setOnClickListener { cb() } }
        return cardV
    }

    private fun assignedCard(ctx: Context, t: Task): View {
        val cardV = ctx.card()
        cardV.addView(ctx.text(t.title.ifBlank { "(untitled)" }, 16f, bold = true))
        val who = t.assignee?.trim().orEmpty()
        val meta = buildString {
            if (who.isNotEmpty()) append("→ $who")
            t.dueForDisplay?.let { if (isNotEmpty()) append("  ·  "); append("due $it") }
        }
        if (meta.isNotEmpty()) cardV.addView(ctx.text(meta, 13f, color = MUTED).apply {
            setPadding(0, ctx.dp(4), 0, 0)
        })
        return cardV
    }
}
