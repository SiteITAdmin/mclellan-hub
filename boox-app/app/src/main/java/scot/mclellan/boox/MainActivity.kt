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
        // Prefer the device's native Notes app (full raw-pen feel, eraser, pen
        // button); pages return to the hub through the existing Boox → Drive
        // ingest loop. ScribbleActivity parses OPEN_NOTE_BEAN (fastjson2 →
        // OpenNoteBean) and with create=true opens its Create Note screen with
        // the title prefilled — that name is the note's provenance in Drive.
        // The in-app capture stays as the fallback if the native app is missing
        // — it uploads with provenance through /api/boox/notes.
        // Day note → "Planner 2026-08-27"; meeting note → "<meeting title> 2026-08-27".
        val noteTitle = if (eventId != null) {
            (label ?: "").replace("Note · ", "").ifBlank { "Meeting" } + " " + linkedDate
        } else {
            "Planner $linkedDate"
        }
        val bean = org.json.JSONObject()
            .put("title", noteTitle)
            .put("create", true)
            .toString()
        val native = android.content.Intent().setClassName(
            "com.onyx.android.note",
            "com.onyx.android.note.note.ui.ScribbleActivity",
        ).putExtra("OPEN_NOTE_BEAN", bean)
        try {
            startActivity(native)
        } catch (_: Exception) {
            val intent = android.content.Intent(this, NoteActivity::class.java).apply {
                putExtra(NoteActivity.EXTRA_LINKED_DATE, linkedDate)
                putExtra(NoteActivity.EXTRA_LINKED_EVENT_ID, eventId)
                putExtra(NoteActivity.EXTRA_PAGE_REF, if (eventId != null) "event" else "day")
                putExtra(NoteActivity.EXTRA_TITLE, label)
            }
            startActivity(intent)
        }
    }

    override fun onResume() {
        super.onResume()
        // Fires on first show and when returning from NoteActivity (a saved note
        // queued an upload). Sync flushes the queue and pulls fresh truth.
        if (::repo.isInitialized) sync()
    }

    // ── Write actions ──────────────────────────────────────────────────────
    private fun showTaskActions(task: Task) {
        val labels = arrayOf("Mark done", "Set due date…")
        AlertDialog.Builder(this)
            .setTitle(task.title.ifBlank { "Task" })
            .setItems(labels) { _, which ->
                when (which) {
                    0 -> queue { repo.enqueueComplete(task) }
                    1 -> pickDate(task.dueForDisplay) { iso -> queue { repo.enqueueReschedule(task, iso) } }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showNewTaskDialog() {
        val ctx = this
        val pad = dp(16)
        var chosenDue: String? = null

        val titleField = EditText(ctx).apply { hint = "Task title" }
        val lanes = RadioGroup(ctx).apply {
            orientation = RadioGroup.HORIZONTAL
            addView(RadioButton(ctx).apply { id = 1; text = "Inbox"; isChecked = true })
            addView(RadioButton(ctx).apply { id = 2; text = "Work" })
            addView(RadioButton(ctx).apply { id = 3; text = "Personal" })
        }
        val dueBtn = TextView(ctx).apply {
            text = "Due date: none"
            setTextColor(INK)
            setPadding(0, dp(8), 0, dp(8))
            setOnClickListener {
                pickDate(null) { iso -> chosenDue = iso; text = "Due date: $iso" }
            }
        }
        val body = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
            addView(titleField)
            addView(text("Lane", 13f, color = MUTED).apply { setPadding(0, dp(12), 0, dp(4)) })
            addView(lanes)
            addView(dueBtn)
        }

        AlertDialog.Builder(ctx)
            .setTitle("New task")
            .setView(body)
            .setPositiveButton("Create") { _, _ ->
                val title = titleField.text.toString().trim()
                if (title.isEmpty()) return@setPositiveButton
                val lane = when (lanes.checkedRadioButtonId) {
                    2 -> "work"; 3 -> "personal"; else -> null
                }
                queue { repo.enqueueCreate(title, lane, chosenDue) }
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
