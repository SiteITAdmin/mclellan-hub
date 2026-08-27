package scot.mclellan.boox

import android.content.Context
import kotlinx.serialization.json.Json
import scot.mclellan.boox.store.AppDatabase
import scot.mclellan.boox.store.OutboxOp
import scot.mclellan.boox.store.SyncCache
import java.io.File
import java.time.Instant
import java.util.UUID

/**
 * Local-first, with an offline write queue. Reads resolve against the cached
 * payload with the pending outbox applied on top, so an edit shows instantly and
 * survives with no WiFi. `flush()` drains the queue to the Hub in order, then the
 * caller pulls a fresh payload; because the flush runs first, the authoritative
 * pull only ever replaces work the Hub has already accepted.
 */
class SyncRepository(context: Context) {
    private val db = AppDatabase.get(context)
    private val dao = db.syncDao()
    private val outbox = db.outboxDao()
    private val json = Json { ignoreUnknownKeys = true }

    data class Snapshot(val data: SyncResponse, val syncedAt: Long, val pending: Int)

    private suspend fun baseCached(): Pair<SyncResponse, Long>? {
        val row = dao.latest() ?: return null
        return runCatching { json.decodeFromString<SyncResponse>(row.json) }
            .getOrNull()?.let { it to row.syncedAt }
    }

    /** The copy the UI renders: last pull + pending edits applied optimistically. */
    suspend fun effective(): Snapshot? {
        val (base, syncedAt) = baseCached() ?: return null
        val ops = outbox.all()
        return Snapshot(applyOps(base, ops), syncedAt, ops.size)
    }

    suspend fun pendingCount(): Int = outbox.count()

    /** Pull a fresh payload and store it verbatim. Does not touch the outbox. */
    suspend fun refresh(days: Int = 90) {
        val raw = HubApi.syncRaw(days)
        json.decodeFromString<SyncResponse>(raw) // validate before we cache it
        dao.save(SyncCache(json = raw, syncedAt = System.currentTimeMillis()))
    }

    // ── Queue writers ────────────────────────────────────────────────────────
    private fun now() = System.currentTimeMillis()

    suspend fun enqueueComplete(task: Task) {
        if (task.id.startsWith("local:")) outbox.deleteByLocalId(task.id) // cancel unsynced create
        else outbox.insert(OutboxOp(type = "complete", taskId = task.id, createdAt = now()))
    }

    suspend fun enqueueReschedule(task: Task, due: String) {
        if (task.id.startsWith("local:")) outbox.updateDueByLocalId(task.id, due)
        else outbox.insert(OutboxOp(type = "update_due", taskId = task.id, due = due, createdAt = now()))
    }

    suspend fun enqueueCreate(title: String, lane: String?, due: String?) {
        outbox.insert(
            OutboxOp(
                type = "create", localId = "local:${UUID.randomUUID()}",
                title = title, lane = lane, due = due, createdAt = now(),
            ),
        )
    }

    /** Queue a handwritten page for upload. captureId is the idempotency key. */
    suspend fun enqueueNote(
        captureId: String, filePath: String, title: String?,
        linkedDate: String?, linkedEventId: String?, pageRef: String?,
    ) {
        outbox.insert(
            OutboxOp(
                type = "note", localId = captureId, title = title, createdAt = now(),
                filePath = filePath, linkedDate = linkedDate,
                linkedEventId = linkedEventId, pageRef = pageRef,
            ),
        )
    }

    // ── Flush ────────────────────────────────────────────────────────────────
    /**
     * Drain the queue to the Hub in order. A 4xx means the Hub permanently
     * rejected the op (e.g. the task is already gone) — drop it so it can't jam
     * the queue. A 5xx is transient — keep it and record the error. A plain
     * IOException is the radio being offline — stop, leaving every remaining op
     * queued for the next attempt.
     */
    suspend fun flush() {
        for (op in outbox.all()) {
            try {
                when (op.type) {
                    "complete" -> HubApi.completeTask(op.taskId!!)
                    "update_due" -> HubApi.rescheduleTask(op.taskId!!, op.due.orEmpty())
                    "create" -> HubApi.createTask(op.title.orEmpty(), op.lane, op.due)
                    "note" -> HubApi.uploadNote(
                        captureId = op.localId!!, file = File(op.filePath!!),
                        title = op.title, capturedAt = Instant.ofEpochMilli(op.createdAt).toString(),
                        linkedDate = op.linkedDate, linkedEventId = op.linkedEventId, pageRef = op.pageRef,
                    )
                }
                if (op.type == "note") op.filePath?.let { runCatching { File(it).delete() } }
                outbox.delete(op)
            } catch (e: HttpException) {
                if (e.code in 400..499) {
                    if (op.type == "note") op.filePath?.let { runCatching { File(it).delete() } }
                    outbox.delete(op)
                } else {
                    outbox.update(op.copy(attempts = op.attempts + 1, lastError = e.message))
                }
            }
            // A non-HTTP IOException (offline) propagates and aborts the flush.
        }
    }

    private fun applyOps(base: SyncResponse, ops: List<OutboxOp>): SyncResponse {
        var tasks = base.tasks
        var unsched = base.planner.unscheduledTasks
        var events = base.planner.events
        for (op in ops) when (op.type) {
            "complete" -> {
                tasks = tasks.map { if (it.id == op.taskId) it.copy(status = "completed") else it }
                unsched = unsched.filterNot { it.id == op.taskId }
                events = events.filterNot { it.taskId == op.taskId }
            }
            "update_due" -> {
                val patch = { t: Task -> if (t.id == op.taskId) t.copy(due = op.due, effectiveDue = op.due) else t }
                tasks = tasks.map(patch)
                unsched = unsched.map(patch)
            }
            "create" -> {
                val t = Task(
                    id = op.localId ?: "local:new", title = op.title.orEmpty(),
                    status = "needsAction", due = op.due, effectiveDue = op.due,
                    plannerLane = op.lane, effortMinutes = 30,
                )
                tasks = tasks + t
                unsched = unsched + t
            }
        }
        return base.copy(
            tasks = tasks,
            planner = base.planner.copy(unscheduledTasks = unsched, events = events),
        )
    }
}
