package scot.mclellan.boox.store

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Update

/**
 * The offline write queue. Every change the user makes on the tablet —
 * completing, rescheduling, or creating a task — is appended here first and
 * applied optimistically to the on-screen copy, so the planner is fully usable
 * with no WiFi. On the next sync the queue is flushed to the Hub's real task
 * endpoints in order (flush before pull, so the fresh snapshot can't clobber a
 * pending edit), and each op is removed only once the Hub has accepted it.
 *
 * There is no second task writer: a flush POSTs to the same /api/tasks routes
 * the web UI uses, which run through createTask/updateTask and the effect gate.
 * This table is a client-side queue, never a source of task truth.
 */
@Entity(tableName = "outbox_ops")
data class OutboxOp(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val type: String,            // complete | update_due | create | note
    val taskId: String? = null,  // server task id for complete/update_due
    val localId: String? = null, // optimistic id for a create (local:<uuid>)
    val title: String? = null,
    val lane: String? = null,    // work | personal | null
    val due: String? = null,     // YYYY-MM-DD
    val createdAt: Long,
    val attempts: Int = 0,
    val lastError: String? = null,
    // Handwritten-note upload (type = note). The raw ink is a PNG on disk; the
    // provenance ties the page to a planner day/event so the hub can file it.
    // captureId (idempotency key) is carried in localId. Recognition is never
    // done here — the hub OCRs the raw page.
    val filePath: String? = null,
    val linkedDate: String? = null,
    val linkedEventId: String? = null,
    val pageRef: String? = null,
)

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox_ops ORDER BY id ASC")
    suspend fun all(): List<OutboxOp>

    @Query("SELECT COUNT(*) FROM outbox_ops")
    suspend fun count(): Int

    @Insert
    suspend fun insert(op: OutboxOp): Long

    @Update
    suspend fun update(op: OutboxOp)

    @Delete
    suspend fun delete(op: OutboxOp)

    // Completing or rescheduling a task that only exists in the queue (its create
    // hasn't synced yet) reconciles the pending create in place — never a
    // server call against a local id that doesn't exist yet.
    @Query("DELETE FROM outbox_ops WHERE localId = :lid")
    suspend fun deleteByLocalId(lid: String)

    @Query("UPDATE outbox_ops SET due = :due WHERE localId = :lid")
    suspend fun updateDueByLocalId(lid: String, due: String?)
}
