package scot.mclellan.boox.store

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import android.content.Context
import androidx.room.Room

/**
 * The offline store. Phase 1 keeps the entire last sync payload as one raw-JSON
 * row rather than modelling every planner field in Room: it makes the app fully
 * readable with no WiFi from day one, and preserves fields the Kotlin model
 * doesn't decode. Phase 2 adds per-task rows plus a write outbox on top of this,
 * when the app starts changing tasks offline.
 */
@Entity(tableName = "sync_cache")
data class SyncCache(
    @PrimaryKey val id: Int = 1,
    val json: String,
    val syncedAt: Long,
)

@Dao
interface SyncDao {
    @Query("SELECT * FROM sync_cache WHERE id = 1")
    suspend fun latest(): SyncCache?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun save(cache: SyncCache)
}

@Database(entities = [SyncCache::class], version = 1, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun syncDao(): SyncDao

    companion object {
        @Volatile
        private var instance: AppDatabase? = null

        fun get(context: Context): AppDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                AppDatabase::class.java,
                "hub-planner.db",
            ).build().also { instance = it }
        }
    }
}
