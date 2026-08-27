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
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

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

@Database(entities = [SyncCache::class, OutboxOp::class], version = 3, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun syncDao(): SyncDao
    abstract fun outboxDao(): OutboxDao

    companion object {
        @Volatile
        private var instance: AppDatabase? = null

        // v1 → v2 adds the write outbox. A destructive migration would drop
        // queued-but-unsynced edits, so this creates the table in place.
        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS outbox_ops (" +
                        "id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                        "type TEXT NOT NULL, taskId TEXT, localId TEXT, title TEXT, " +
                        "lane TEXT, due TEXT, createdAt INTEGER NOT NULL, " +
                        "attempts INTEGER NOT NULL, lastError TEXT)",
                )
            }
        }

        // v2 → v3 adds the handwritten-note upload columns to the outbox.
        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE outbox_ops ADD COLUMN filePath TEXT")
                db.execSQL("ALTER TABLE outbox_ops ADD COLUMN linkedDate TEXT")
                db.execSQL("ALTER TABLE outbox_ops ADD COLUMN linkedEventId TEXT")
                db.execSQL("ALTER TABLE outbox_ops ADD COLUMN pageRef TEXT")
            }
        }

        fun get(context: Context): AppDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                AppDatabase::class.java,
                "hub-planner.db",
            ).addMigrations(MIGRATION_1_2, MIGRATION_2_3).build().also { instance = it }
        }
    }
}
