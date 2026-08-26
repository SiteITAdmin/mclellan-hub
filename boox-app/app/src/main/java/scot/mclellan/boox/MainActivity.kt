package scot.mclellan.boox

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import scot.mclellan.boox.databinding.ActivityMainBinding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Phase 1 surface: prove the offline loop end to end. On launch it shows the
 * last cached sync (works with no WiFi); "Sync now" pulls a fresh payload,
 * caches it, and redraws. The read views (day/week/month) and the two-way task
 * actions replace this text dump in Phases 1b/2 — this exists to verify the
 * pipeline, not to be the final UI.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var repo: SyncRepository

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        repo = SyncRepository(this)

        binding.syncButton.setOnClickListener { sync() }

        lifecycleScope.launch {
            val cached = repo.cached()
            if (cached != null) {
                render(cached, fromCache = true)
            } else {
                binding.status.text = "No local copy yet. Tap Sync now."
            }
        }
    }

    private fun sync() {
        binding.syncButton.isEnabled = false
        binding.status.text = "Syncing…"
        lifecycleScope.launch {
            try {
                render(repo.refresh(), fromCache = false)
            } catch (e: Exception) {
                val fallback = repo.cached()
                binding.status.text = buildString {
                    append("Sync failed: ${e.message}")
                    if (fallback != null) append("\nShowing last local copy.")
                }
                fallback?.let { render(it, fromCache = true) }
            } finally {
                binding.syncButton.isEnabled = true
            }
        }
    }

    private fun render(snapshot: SyncRepository.Snapshot, fromCache: Boolean) {
        val data = snapshot.data
        val open = data.tasks.count { it.isOpen && it.assignee == null }
        val when0 = SimpleDateFormat("d MMM HH:mm", Locale.UK).format(Date(snapshot.syncedAt))
        binding.status.text = buildString {
            append(if (fromCache) "Offline copy · " else "Synced · ")
            append("last sync $when0")
        }

        val inbox = data.planner.unscheduledTasks
        binding.content.text = buildString {
            append("Today: ${data.today}\n")
            append("Window: ${data.planner.startDate} → ${data.planner.endDate} (${data.planner.days.size} days)\n")
            append("Open tasks (mine): $open\n")
            append("Unplanned inbox: ${inbox.size}\n")
            append("Handwritten notes held by hub: ${data.notes.size}\n\n")
            append("── Inbox ──\n")
            if (inbox.isEmpty()) {
                append("(nothing unplanned)\n")
            } else {
                inbox.take(40).forEach { task ->
                    val due = task.due?.take(10)?.let { " · due $it" } ?: ""
                    append("• ${task.title}$due\n")
                }
            }
        }
    }
}
