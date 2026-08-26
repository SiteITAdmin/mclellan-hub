package scot.mclellan.boox

import android.content.Context
import kotlinx.serialization.json.Json
import scot.mclellan.boox.store.AppDatabase
import scot.mclellan.boox.store.SyncCache

/**
 * Local-first: reads always resolve against the cached payload, so the planner
 * is usable with no WiFi. `refresh()` pulls a fresh payload, stores it verbatim,
 * and returns the parsed result; if the network fails, the caller falls back to
 * `cached()` and the last good copy stays on screen.
 */
class SyncRepository(context: Context) {
    private val dao = AppDatabase.get(context).syncDao()
    private val json = Json { ignoreUnknownKeys = true }

    data class Snapshot(val data: SyncResponse, val syncedAt: Long)

    suspend fun cached(): Snapshot? {
        val row = dao.latest() ?: return null
        return runCatching { json.decodeFromString<SyncResponse>(row.json) }
            .getOrNull()
            ?.let { Snapshot(it, row.syncedAt) }
    }

    suspend fun refresh(days: Int = 90): Snapshot {
        val raw = HubApi.syncRaw(days)
        val parsed = json.decodeFromString<SyncResponse>(raw)
        val syncedAt = System.currentTimeMillis()
        dao.save(SyncCache(json = raw, syncedAt = syncedAt))
        return Snapshot(parsed, syncedAt)
    }
}
