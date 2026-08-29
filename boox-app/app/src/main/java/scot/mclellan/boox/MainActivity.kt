package scot.mclellan.boox

import android.app.DatePickerDialog
import android.os.Bundle
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import scot.mclellan.boox.databinding.ActivityMainBinding
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The planner host. Holds the current snapshot (live or offline), the selected
 * tab, and the focus date, and re-renders the content column whenever any of
 * them change. All four views are pure functions of (snapshot, focus), so this
 * class only owns navigation, the sync lifecycle, and the write actions —
 * never layout detail.
 *
 * Writes are offline-first: an action is queued and applied to the on-screen
 * copy immediately (optimistic), then a background sync flushes the queue to the
 * Hub and pulls fresh truth. A failed sync keeps the optimistic copy and the
 * pending count on screen rather than losing the edit.
 */
class MainActivity : AppCompatActivity() {

    private enum class Tab { DAY, WEEK, MONTH, TASKS }

    private lateinit var binding: ActivityMainBinding
    private lateinit var repo: SyncRepository

    private var snapshot: SyncRepository.Snapshot? = null
    private var tab = Tab.DAY
    private var focus: LocalDate = LocalDate.now()
    private var navUsed = false

    private val UK = Locale.UK
    private val dayFmt = DateTimeFormatter.ofPattern("EEE d MMM yyyy", UK)
    private val dMon = DateTimeFormatter.ofPattern("d MMM", UK)
    private val monthFmt = DateTimeFormatter.ofPattern("MMMM yyyy", UK)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = SyncRepository(this)

        binding.btnSync.setOnClickListener { sync() }
        binding.btnNew.setOnClickListener { showNewTaskDialog() }
        binding.btnPlan.setOnClickListener { showPlanMenu() }
        binding.tabDay.setOnClickListener { setTab(Tab.DAY) }
        binding.tabWeek.setOnClickListener { setTab(Tab.WEEK) }
        binding.tabMonth.setOnClickListener { setTab(Tab.MONTH) }
        binding.tabTasks.setOnClickListener { setTab(Tab.TASKS) }
        binding.btnPrev.setOnClickListener { shiftFocus(-1) }
        binding.btnNext.setOnClickListener { shiftFocus(1) }
        binding.btnToday.setOnClickListener { focus = todayLocal(); render() }

        lifecycleScope.launch {
            snapshot = repo.effective()
            snapshot?.let { focus = todayLocal() }
            styleTabs()
            render()
            // The first sync is driven by onResume, which fires right after onCreate.
        }
    }

    private fun setTab(t: Tab) {
        tab = t
        styleTabs()
        render()
    }

    private fun shiftFocus(dir: Int) {
        focus = when (tab) {
            Tab.DAY -> focus.plusDays(dir.toLong())
            Tab.WEEK -> focus.plusWeeks(dir.toLong())
            Tab.MONTH -> focus.plusMonths(dir.toLong())
            Tab.TASKS -> focus
        }
        render()
    }

    private fun todayLocal(): LocalDate =
        snapshot?.data?.today?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: LocalDate.now()

    /** Re-read the cached copy with pending edits applied, then redraw. */
    private suspend fun reload() {
        snapshot = repo.effective()
        render()
    }

    private fun sync() {
        binding.btnSync.isEnabled = false
        binding.tvSynced.text = "syncing…"
        lifecycleScope.launch {
            try {
                repo.flush()      // may throw on offline; leaves the queue intact
                repo.refresh()    // authoritative pull, only after the flush
                if (tab == Tab.DAY && !navUsed) focus = todayLocal()
            } catch (_: Exception) {
                // Offline or a transient failure: keep the optimistic copy on screen.
            } finally {
                reload()
                binding.btnSync.isEnabled = true
            }
        }
    }

    private fun render() {
        val snap = snapshot
        binding.navBar.visibility = if (tab == Tab.TASKS) View.GONE else View.VISIBLE
        binding.tvPeriod.text = periodLabel()
        binding.tvSynced.text = snap?.let { syncedLabel(it) } ?: "no local copy"

        val content = binding.content
        content.removeAllViews()

        if (snap == null) {
            content.addView(text("No local copy yet. Tap Sync now.", 16f, color = MUTED))
            return
        }
        val data = snap.data
        when (tab) {
            Tab.DAY -> PlannerViews.renderDay(
                this, content, data, focus,
                onTask = { showTaskActions(it) },
                onNewNote = { date, eventId, label -> openNote(date, eventId, label) },
            )
            Tab.WEEK -> PlannerViews.renderWeek(this, content, data, focus) { openDay(it) }
            Tab.MONTH -> PlannerViews.renderMonth(this, content, data, focus) { openDay(it) }
            Tab.TASKS -> PlannerViews.renderTasks(this, content, data) { showTaskActions(it) }
        }
    }

    private fun openDay(d: LocalDate) {
        focus = d
        navUsed = true
        setTab(Tab.DAY)
    }

    private fun openNote(linkedDate: String, eventId: String?, label: String?) {
        // The device's native Notes app owns the real pen experience, so notes
        // live there and return to the hub through the existing Boox → Drive
        // ingest loop; the note's name is its provenance. NativeNotes reopens
        // today's note if it already exists rather than making a second one.
        // Day note → "Planner 2026-08-27"; meeting note → "<meeting title> 2026-08-27".
        val noteTitle = if (eventId != null) {
            (label ?: "").replace("Note · ", "").ifBlank { "Meeting" } + " " + linkedDate
        } else {
            "Planner $linkedDate"
        }
        if (NativeNotes.openOrCreate(this, noteTitle)) return

        // Native app unavailable: fall back to in-app capture, which uploads
        // with day/event provenance through /api/boox/notes.
        startActivity(
            android.content.Intent(this, NoteActivity::class.java).apply {
                putExtra(NoteActivity.EXTRA_LINKED_DATE, linkedDate)
                putExtra(NoteActivity.EXTRA_LINKED_EVENT_ID, eventId)
                putExtra(NoteActivity.EXTRA_PAGE_REF, if (eventId != null) "event" else "day")
                putExtra(NoteActivity.EXTRA_TITLE, label)
            },
        )
    }

    override fun onResume() {
        super.onResume()
        // Fires on first show and when returning from NoteActivity (a saved note
        // queued an upload). Sync flushes the queue and pulls fresh truth.
        if (::repo.isInitialized) sync()
    }

    // ── Write actions ──────────────────────────────────────────────────────
    private fun showTaskActions(task: Task) {
        // Quick actions stay in-app and work offline; anything deeper opens the
        // task's real Hub page in the browser, which is the only surface that can
        // safely edit lane/effort/start/dependency (they live as tags inside the
        // task notes and would be easy to clobber by hand elsewhere).
        val canOpenInHub = !task.id.startsWith("local:")
        val labels = if (canOpenInHub) {
            arrayOf("Mark done", "Set due date…", "Open in Hub")
        } else {
            arrayOf("Mark done", "Set due date…")
        }
        AlertDialog.Builder(this)
            .setTitle(task.title.ifBlank { "Task" })
            .setItems(labels) { _, which ->
                when (which) {
                    0 -> queue { repo.enqueueComplete(task) }
                    1 -> pickDate(task.dueForDisplay) { iso -> queue { repo.enqueueReschedule(task, iso) } }
                    2 -> openTaskInHub(task)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /** Open this task's page on the Hub website in the device browser. The
     *  browser holds its own login session; the app's bearer is not shared with
     *  it, so the first visit needs a one-time sign-in. */
    private fun openTaskInHub(task: Task) {
        val url = "${BuildConfig.HUB_BASE_URL}/crm/tasks/${task.id}"
        val intent = android.content.Intent(
            android.content.Intent.ACTION_VIEW,
            android.net.Uri.parse(url),
        )
        if (runCatching { startActivity(intent); true }.getOrDefault(false)) return
        android.widget.Toast.makeText(this, "No browser available", android.widget.Toast.LENGTH_SHORT).show()
    }

    /**
     * Planner placement, matching the Hub's own two explicit actions. Both are
     * server-side over the live calendar and deliberately never queued offline:
     * Auto-plan places tasks that have no block yet, Reshuffle only rescues
     * blocks whose slot has already passed (it never drags future work earlier).
     */
    private fun showPlanMenu() {
        val labels = arrayOf("Auto-plan unscheduled", "Reshuffle overdue blocks")
        AlertDialog.Builder(this)
            .setTitle("Plan")
            .setItems(labels) { _, which ->
                if (which == 0) runPlannerAction("Auto-plan") { repo.autoPlan() }
                else runPlannerAction("Reshuffle") { repo.reshuffle() }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun runPlannerAction(name: String, action: suspend () -> Unit) {
        binding.btnPlan.isEnabled = false
        binding.tvSynced.text = "$name…"
        lifecycleScope.launch {
            val failure = runCatching { action() }.exceptionOrNull()
            if (failure != null) {
                android.widget.Toast.makeText(
                    this@MainActivity,
                    "$name failed — needs a connection",
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
            }
            binding.btnPlan.isEnabled = true
            sync() // pull the new placements (or restore the label on failure)
        }
    }

    private fun showNewTaskDialog() {
        val ctx = this
        val pad = dp(16)
        var chosenDue: String? = null
        var chosenStart: String? = null

        val titleField = EditText(ctx).apply { hint = "Task title" }
        val notesField = EditText(ctx).apply { hint = "Notes (optional)" }

        // Lane, priority and effort mirror the Hub's own new-task form: they are
        // written as the Google-visible notes tags the planner reads, via
        // /api/tasks. Radio rows rather than spinners — far easier to hit with a
        // pen on e-ink, and every option stays visible without a popup redraw.
        val lanes = RadioGroup(ctx).apply {
            orientation = RadioGroup.HORIZONTAL
            addView(RadioButton(ctx).apply { id = 1; text = "Inbox"; isChecked = true })
            addView(RadioButton(ctx).apply { id = 2; text = "Work" })
            addView(RadioButton(ctx).apply { id = 3; text = "Personal" })
        }
        val priorities = RadioGroup(ctx).apply {
            orientation = RadioGroup.HORIZONTAL
            addView(RadioButton(ctx).apply { id = 10; text = "None"; isChecked = true })
            addView(RadioButton(ctx).apply { id = 11; text = "Low" })
            addView(RadioButton(ctx).apply { id = 12; text = "Med" })
            addView(RadioButton(ctx).apply { id = 13; text = "High" })
        }
        val efforts = RadioGroup(ctx).apply {
            orientation = RadioGroup.HORIZONTAL
            addView(RadioButton(ctx).apply { id = 15; text = "15m" })
            addView(RadioButton(ctx).apply { id = 30; text = "30m"; isChecked = true })
            addView(RadioButton(ctx).apply { id = 60; text = "1h" })
            addView(RadioButton(ctx).apply { id = 120; text = "2h" })
        }

        val dueBtn = TextView(ctx).apply {
            text = "Due date: none"
            setTextColor(INK)
            setPadding(0, dp(10), 0, dp(10))
            setOnClickListener { pickDate(null) { iso -> chosenDue = iso; text = "Due date: $iso" } }
        }
        val startBtn = TextView(ctx).apply {
            text = "Start date: none"
            setTextColor(INK)
            setPadding(0, dp(2), 0, dp(10))
            setOnClickListener { pickDate(null) { iso -> chosenStart = iso; text = "Start date: $iso" } }
        }

        val body = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
            addView(titleField)
            addView(notesField)
            addView(text("Lane", 13f, color = MUTED).apply { setPadding(0, dp(12), 0, dp(4)) })
            addView(lanes)
            addView(text("Priority", 13f, color = MUTED).apply { setPadding(0, dp(10), 0, dp(4)) })
            addView(priorities)
            addView(text("Effort", 13f, color = MUTED).apply { setPadding(0, dp(10), 0, dp(4)) })
            addView(efforts)
            addView(dueBtn)
            addView(startBtn)
        }

        AlertDialog.Builder(ctx)
            .setTitle("New task")
            .setView(android.widget.ScrollView(ctx).apply { addView(body) })
            .setPositiveButton("Create") { _, _ ->
                val title = titleField.text.toString().trim()
                if (title.isEmpty()) return@setPositiveButton
                val lane = when (lanes.checkedRadioButtonId) {
                    2 -> "work"; 3 -> "personal"; else -> null
                }
                val priority = when (priorities.checkedRadioButtonId) {
                    11 -> "low"; 12 -> "medium"; 13 -> "high"; else -> null
                }
                val effort = efforts.checkedRadioButtonId.takeIf { it > 0 }
                queue {
                    repo.enqueueCreate(
                        title = title, lane = lane, due = chosenDue,
                        priority = priority, effortMinutes = effort,
                        start = chosenStart,
                        noteText = notesField.text.toString().trim().ifBlank { null },
                    )
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /** Run a queue write, redraw optimistically, then attempt a background sync. */
    private fun queue(op: suspend () -> Unit) {
        lifecycleScope.launch {
            op()
            reload()
            sync()
        }
    }

    private fun pickDate(currentIso: String?, onPicked: (String) -> Unit) {
        val base = runCatching { LocalDate.parse(currentIso) }.getOrNull() ?: todayLocal()
        DatePickerDialog(
            this,
            { _, y, m, d -> onPicked(LocalDate.of(y, m + 1, d).toString()) },
            base.year, base.monthValue - 1, base.dayOfMonth,
        ).show()
    }

    // ── Chrome ─────────────────────────────────────────────────────────────
    private fun periodLabel(): String = when (tab) {
        Tab.DAY -> focus.format(dayFmt)
        Tab.WEEK -> {
            val mon = focus.with(java.time.DayOfWeek.MONDAY)
            "${mon.format(dMon)} – ${mon.plusDays(6).format(dMon)}"
        }
        Tab.MONTH -> focus.format(monthFmt)
        Tab.TASKS -> ""
    }

    private fun syncedLabel(s: SyncRepository.Snapshot): String {
        val fmt = DateTimeFormatter.ofPattern("d MMM HH:mm", UK)
            .withZone(java.time.ZoneId.systemDefault())
        val stamp = "synced ${fmt.format(java.time.Instant.ofEpochMilli(s.syncedAt))}"
        return if (s.pending > 0) "$stamp · ${s.pending} pending" else stamp
    }

    private fun styleTabs() {
        val tabs = mapOf(
            Tab.DAY to binding.tabDay, Tab.WEEK to binding.tabWeek,
            Tab.MONTH to binding.tabMonth, Tab.TASKS to binding.tabTasks,
        )
        tabs.forEach { (t, view) ->
            val active = t == tab
            view.setBackgroundColor(if (active) FILL_DARK else android.graphics.Color.WHITE)
            (view as TextView).setTypeface(
                view.typeface,
                if (active) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL,
            )
        }
        if (tab != Tab.DAY) navUsed = true
    }
}
