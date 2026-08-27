package scot.mclellan.boox

import android.os.Bundle
import android.view.View
import android.widget.TextView
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
 * class only owns navigation and the sync lifecycle — never layout detail.
 *
 * Offline-first: on launch it draws the last cached copy immediately (usable
 * with no WiFi), then attempts a silent refresh. A failed sync keeps the cached
 * copy on screen and says so, rather than blanking the planner.
 */
class MainActivity : AppCompatActivity() {

    private enum class Tab { DAY, WEEK, MONTH, TASKS }

    private lateinit var binding: ActivityMainBinding
    private lateinit var repo: SyncRepository

    private var snapshot: SyncRepository.Snapshot? = null
    private var tab = Tab.DAY
    private var focus: LocalDate = LocalDate.now()

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
        binding.tabDay.setOnClickListener { setTab(Tab.DAY) }
        binding.tabWeek.setOnClickListener { setTab(Tab.WEEK) }
        binding.tabMonth.setOnClickListener { setTab(Tab.MONTH) }
        binding.tabTasks.setOnClickListener { setTab(Tab.TASKS) }
        binding.btnPrev.setOnClickListener { shiftFocus(-1) }
        binding.btnNext.setOnClickListener { shiftFocus(1) }
        binding.btnToday.setOnClickListener { focus = todayLocal(); render() }

        lifecycleScope.launch {
            snapshot = repo.cached()
            snapshot?.let { focus = todayLocal() }
            styleTabs()
            render()
            sync() // silent refresh; keeps cached copy if it fails
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

    private fun sync() {
        binding.btnSync.isEnabled = false
        binding.tvSynced.text = "syncing…"
        lifecycleScope.launch {
            try {
                snapshot = repo.refresh()
                if (tab == Tab.DAY && !navUsed) focus = todayLocal()
                render()
            } catch (e: Exception) {
                val fallback = repo.cached()
                snapshot = fallback ?: snapshot
                binding.tvSynced.text = if (fallback != null) "offline · sync failed" else "sync failed"
                render()
            } finally {
                binding.btnSync.isEnabled = true
            }
        }
    }

    // Once the user has navigated, a background sync must not yank them back to today.
    private var navUsed = false

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
            Tab.DAY -> PlannerViews.renderDay(this, content, data, focus)
            Tab.WEEK -> PlannerViews.renderWeek(this, content, data, focus) { openDay(it) }
            Tab.MONTH -> PlannerViews.renderMonth(this, content, data, focus) { openDay(it) }
            Tab.TASKS -> PlannerViews.renderTasks(this, content, data)
        }
    }

    private fun openDay(d: LocalDate) {
        focus = d
        navUsed = true
        setTab(Tab.DAY)
    }

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
        return "synced ${fmt.format(java.time.Instant.ofEpochMilli(s.syncedAt))}"
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
        // Navigating away from a background-sync-follows-today state.
        if (tab != Tab.DAY) navUsed = true
    }
}
